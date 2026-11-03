/**
 * render_view: what a reviewer saw, as an image an agent can look at.
 *
 * A comment's `@view(...)` reference pins a camera; this loads the real share
 * page at that view and screenshots the canvas. It drives a local Chrome or
 * Chromium headlessly through puppeteer-core — which never downloads a browser —
 * rather than re-implementing the viewer server-side, so the picture is exactly
 * what the viewer draws: same lighting, same parts panel defaults, same framing.
 *
 * The page is opened with `?bare=1`, which hides every piece of chrome, and the
 * view in its fragment. The viewer reports its progress on
 * `document.documentElement.dataset.viewerState` ('loading' → 'ready' or
 * 'error'), and `ready` is only set once the model is framed, the fragment
 * applied and a frame drawn, so the screenshot never catches a half-loaded page.
 * `dataset.viewerView` then says which view the viewer actually applied.
 */
import * as fs from 'fs';
import * as path from 'path';

import { BadRequest } from '../../lib/lambda/handler';
import { type Config, resolveUserPath } from './config';
import { fetchManifest, type SiteReader } from './site';
import { formatViewFragment, parseView, type View } from './viewref';

/**
 * The page-side callbacks below run in the browser, not in Node, and this project
 * has no DOM types; declaring only what they touch keeps that boundary visible.
 */
declare const document: {
  documentElement: { dataset: Record<string, string | undefined> };
  getElementById(id: string): { textContent: string | null } | null;
};

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

/**
 * Launch flags. Chrome's default GPU path is used on purpose: on macOS it is
 * hardware WebGL through Metal, and forcing SwiftShader there crashed the browser
 * in testing. `--enable-unsafe-swiftshader` only permits the software fallback,
 * for a machine with no GPU at all (a Linux box, a VM), where Chrome would
 * otherwise refuse WebGL. puppeteer adds its own isolation flags and a throwaway
 * profile on top of these.
 */
export const CHROME_ARGS = [
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
];

export const DEFAULT_SIZE = { width: 1200, height: 800 };
const MIN_SIDE = 64;
const MAX_SIDE = 3000;

export interface ViewInput {
  az: number;
  el: number;
  zoom?: number;
  roll?: number;
  pan?: [number, number, number];
  parts?: string;
}

/**
 * A view from either form the tool accepts: the text of a reference (with or
 * without its `@`, or as a URL fragment), or the numbers as an object. Both go
 * through the same validation, so an object cannot smuggle in what a token could
 * not say.
 */
export function resolveViewInput(input: string | ViewInput): View {
  if (typeof input === 'string') {
    const text = input.trim().replace(/^.*#/, ''); // tolerate a whole share URL
    const view = parseView(text);
    if (!view) {
      throw new BadRequest(
        `"${input}" is not a view reference. Expected @view(az=<deg>,el=<deg>,zoom=<x>) with ` +
          'optional roll=<deg>, pan=<x>,<y>,<z> and parts=<0|1 digits>, e.g. @view(az=-35,el=22,zoom=1.6).',
      );
    }
    return view;
  }
  const view = parseView(
    formatViewFragment({
      az: input.az,
      el: input.el,
      zoom: input.zoom ?? 1,
      roll: input.roll ?? 0,
      pan: input.pan ? { x: input.pan[0], y: input.pan[1], z: input.pan[2] } : { x: 0, y: 0, z: 0 },
      parts: input.parts ?? null,
    }),
  );
  if (!view) {
    throw new BadRequest(
      'view is out of range: az and roll must be within ±180, el within ±90, zoom between ' +
        '0.001 and 1000, and parts only 0s and 1s.',
    );
  }
  return view;
}

/** Whole pixels, kept to a size a browser will actually allocate. */
export function clampSize(width?: number, height?: number): { width: number; height: number } {
  const side = (n: number | undefined, def: number) =>
    Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(Number.isFinite(n) ? (n as number) : def)));
  return { width: side(width, DEFAULT_SIZE.width), height: side(height, DEFAULT_SIZE.height) };
}

/** The share URL that opens on a view; `bare` hides the viewer's chrome. */
export function renderUrl(siteUrl: string, slug: string, rev: number, view: View, bare: boolean): string {
  return `${siteUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}/${rev}${bare ? '?bare=1' : ''}#${formatViewFragment(view)}`;
}

export interface RenderArgs {
  project: string;
  revision?: number | null;
  view: string | ViewInput;
  width?: number;
  height?: number;
  bare?: boolean;
  out?: string | null;
}

export interface RenderResult {
  project: string;
  revision: number;
  /** The share link a person would open — with chrome, at this view. */
  url: string;
  /** What was actually loaded for the screenshot. */
  renderedUrl: string;
  view: View;
  /** The view the viewer reported applying, as a fragment. */
  appliedView: string | null;
  width: number;
  height: number;
  bytes: number;
  out: string | null;
  png: string; // base64
}

/** The browser surface render_view uses, so tests can stand one in. */
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface PageLike {
  goto(url: string, opts: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  waitForFunction(fn: () => boolean, opts: { polling: number; timeout: number }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  $(selector: string): Promise<{ screenshot(opts: { type: 'png'; encoding: 'base64' }): Promise<string | Buffer> } | null>;
}
export type Launcher = (opts: {
  executablePath: string;
  args: string[];
  width: number;
  height: number;
  timeoutMs: number;
}) => Promise<BrowserLike>;

/** puppeteer-core, loaded on first use so the server starts without it. */
export const puppeteerLauncher: Launcher = async ({ executablePath, args, width, height, timeoutMs }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    timeout: timeoutMs,
  });
  return browser as unknown as BrowserLike;
};

export async function renderView(
  cfg: Config,
  reader: SiteReader,
  args: RenderArgs,
  launch: Launcher = puppeteerLauncher,
): Promise<RenderResult> {
  const view = resolveViewInput(args.view);
  const { width, height } = clampSize(args.width, args.height);
  const bare = args.bare ?? true;
  const out = args.out ? resolveUserPath(args.out, cfg, { extensions: ['.png'], label: 'out' }) : null;

  const manifest = await fetchManifest(reader, args.project);
  if (!manifest || !manifest.revisions.length) {
    throw new BadRequest(`Nothing published under "${args.project}", so there is nothing to render.`);
  }
  const rev = args.revision ?? manifest.latest ?? manifest.revisions[manifest.revisions.length - 1].rev;
  if (!manifest.revisions.some((r) => r.rev === rev)) {
    throw new BadRequest(
      `${args.project} has no published revision ${rev}. Published: ${manifest.revisions.map((r) => r.rev).join(', ')}.`,
    );
  }

  if (!cfg.chromePath) {
    throw new RenderError(
      'No Chrome or Chromium was found to render with. Set THREED_CHROME_PATH (config key ' +
        'chromePath) to the browser binary; render_view drives it headlessly and downloads nothing.',
    );
  }
  if (!fs.existsSync(cfg.chromePath)) {
    throw new RenderError(`chromePath ${cfg.chromePath} does not exist. Fix THREED_CHROME_PATH (config key chromePath).`);
  }

  const timeoutMs = Math.round(cfg.renderTimeoutSeconds * 1000);
  const renderedUrl = renderUrl(reader.siteUrl, args.project, rev, view, bare);
  const browser = await launch({ executablePath: cfg.chromePath, args: CHROME_ARGS, width, height, timeoutMs });
  try {
    const page = await browser.newPage();
    await page.goto(renderedUrl, { waitUntil: 'load', timeout: timeoutMs });
    try {
      await page.waitForFunction(
        () => ['ready', 'error'].includes(document.documentElement.dataset.viewerState ?? ''),
        { polling: 100, timeout: timeoutMs },
      );
    } catch {
      throw new RenderError(
        `The viewer did not finish loading ${renderedUrl} within ${cfg.renderTimeoutSeconds}s ` +
          '(THREED_RENDER_TIMEOUT_SECONDS). A large model may need longer; a viewer older than ' +
          'render_view never reports ready at all.',
      );
    }
    const state = await page.evaluate(() => ({
      state: document.documentElement.dataset.viewerState ?? '',
      view: document.documentElement.dataset.viewerView ?? null,
      title: document.getElementById('errorTitle')?.textContent ?? '',
      text: document.getElementById('errorText')?.textContent ?? '',
    }));
    if (state.state === 'error') {
      throw new RenderError(`The viewer could not show ${renderedUrl}: ${state.title}. ${state.text}`.trim());
    }
    const canvas = await page.$('#canvas');
    if (!canvas) throw new RenderError(`${renderedUrl} has no #canvas to capture.`);
    const shot = await canvas.screenshot({ type: 'png', encoding: 'base64' });
    const png = typeof shot === 'string' ? shot : Buffer.from(shot).toString('base64');

    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(png, 'base64'));
    }
    return {
      project: args.project,
      revision: rev,
      url: renderUrl(reader.siteUrl, args.project, rev, view, false),
      renderedUrl,
      view,
      appliedView: state.view,
      width,
      height,
      bytes: Buffer.from(png, 'base64').length,
      out,
      png,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
