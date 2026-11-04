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
  /** Browser launches it took; more than 1 means Chrome quit on its own first. */
  attempts: number;
  png: string; // base64
}

/** How a browser went away: an exit code, a signal, or neither when only the connection dropped. */
export interface BrowserExit {
  code: number | null;
  signal: string | null;
}

/** The browser surface render_view uses, so tests can stand one in. */
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  /**
   * Settles once the browser is gone, whether it quit on its own or was closed.
   * Never rejects. A desktop Chrome can quit by itself mid-render, and without
   * this a wait on its detached page just polls until the timeout.
   */
  exited: Promise<BrowserExit>;
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

/**
 * chrome-headless-shell is the old headless Chrome as its own binary, and
 * puppeteer drives it in its 'shell' mode rather than as `--headless=new`.
 */
export function isHeadlessShell(executablePath: string): boolean {
  return path.basename(executablePath).replace(/\.exe$/i, '') === 'chrome-headless-shell';
}

/** How long a dropped connection waits for the process's exit code. */
const EXIT_CODE_WAIT_MS = 1000;

/** puppeteer-core, loaded on first use so the server starts without it. */
export const puppeteerLauncher: Launcher = async ({ executablePath, args, width, height, timeoutMs }) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath,
    headless: isHeadlessShell(executablePath) ? 'shell' : true,
    args,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    timeout: timeoutMs,
  });
  const proc = browser.process();
  const exited = new Promise<BrowserExit>((resolve) => {
    const report = () => resolve({ code: proc?.exitCode ?? null, signal: proc?.signalCode ?? null });
    proc?.once('exit', report);
    // The connection usually drops a moment before the process is reaped; give
    // the exit code a chance to arrive so the error can say what it was.
    browser.once('disconnected', () => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return report();
      setTimeout(report, EXIT_CODE_WAIT_MS).unref();
    });
  });
  return {
    newPage: async () => (await browser.newPage()) as unknown as PageLike,
    close: () => browser.close(),
    exited,
  };
};

/** Chrome went away during an attempt; the only failure render_view retries. */
class BrowserDied extends Error {
  constructor(
    readonly exit: BrowserExit,
    /** Seconds from starting to load the page, or null if it died before that. */
    readonly afterOpen: number | null,
  ) {
    super('browser died');
  }

  describe(): string {
    const how =
      this.exit.code !== null
        ? `exited (code ${this.exit.code})`
        : this.exit.signal
          ? `was killed (${this.exit.signal})`
          : 'disconnected';
    const when = this.afterOpen === null ? 'before the page opened' : `${this.afterOpen.toFixed(1)} s after opening the page`;
    return `${how} ${when}`;
  }
}

/** `p`'s value if it settles within `ms`, else null. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

export interface RenderTuning {
  /** Browser launches before giving up on a Chrome that keeps quitting. */
  attempts?: number;
  /** After a page error, how long to wait to see whether the browser is going away. */
  deathGraceMs?: number;
}

interface Shot {
  png: string;
  appliedView: string | null;
}

export async function renderView(
  cfg: Config,
  reader: SiteReader,
  args: RenderArgs,
  launch: Launcher = puppeteerLauncher,
  { attempts = 3, deathGraceMs = 1500 }: RenderTuning = {},
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

  const chromePath = cfg.chromePath;
  if (!chromePath) {
    throw new RenderError(
      'No Chrome or Chromium was found to render with. Set THREED_CHROME_PATH (config key ' +
        'chromePath) to the browser binary; render_view drives it headlessly and downloads nothing.',
    );
  }
  if (!fs.existsSync(chromePath)) {
    throw new RenderError(`chromePath ${chromePath} does not exist. Fix THREED_CHROME_PATH (config key chromePath).`);
  }

  const timeoutMs = Math.round(cfg.renderTimeoutSeconds * 1000);
  const renderedUrl = renderUrl(reader.siteUrl, args.project, rev, view, bare);

  /**
   * One launch, start to screenshot. Every step races the browser's exit, so a
   * Chrome that quits ends the attempt at once; an error that arrives just
   * before the exit does ("frame got detached", "Target closed") is given a
   * moment to turn out to be one.
   */
  const renderOnce = async (): Promise<Shot> => {
    const browser = await launch({ executablePath: chromePath, args: CHROME_ARGS, width, height, timeoutMs });
    let opened: number | null = null;
    const died = (exit: BrowserExit) =>
      new BrowserDied(exit, opened === null ? null : (Date.now() - opened) / 1000);
    const death = browser.exited.then((exit) => {
      throw died(exit);
    });
    death.catch(() => undefined);
    const alive = <T>(step: Promise<T>): Promise<T> => Promise.race([step, death]);
    const diedSoon = async (): Promise<BrowserDied | null> => {
      const exit = await within(browser.exited, deathGraceMs);
      return exit ? died(exit) : null;
    };

    try {
      const page = await alive(browser.newPage());
      opened = Date.now();
      await alive(page.goto(renderedUrl, { waitUntil: 'load', timeout: timeoutMs }));
      try {
        await alive(
          page.waitForFunction(
            () => ['ready', 'error'].includes(document.documentElement.dataset.viewerState ?? ''),
            { polling: 100, timeout: timeoutMs },
          ),
        );
      } catch (err) {
        if (err instanceof BrowserDied) throw err;
        const dead = await diedSoon();
        if (dead) throw dead;
        throw new RenderError(
          `The viewer did not finish loading ${renderedUrl} within ${cfg.renderTimeoutSeconds}s ` +
            '(THREED_RENDER_TIMEOUT_SECONDS), and Chrome is still running. A large model may need ' +
            'longer; a viewer older than render_view never reports ready at all.',
        );
      }
      const state = await alive(
        page.evaluate(() => ({
          state: document.documentElement.dataset.viewerState ?? '',
          view: document.documentElement.dataset.viewerView ?? null,
          title: document.getElementById('errorTitle')?.textContent ?? '',
          text: document.getElementById('errorText')?.textContent ?? '',
        })),
      );
      if (state.state === 'error') {
        throw new RenderError(`The viewer could not show ${renderedUrl}: ${state.title}. ${state.text}`.trim());
      }
      const canvas = await alive(page.$('#canvas'));
      if (!canvas) throw new RenderError(`${renderedUrl} has no #canvas to capture.`);
      const shot = await alive(canvas.screenshot({ type: 'png', encoding: 'base64' }));
      return { png: typeof shot === 'string' ? shot : Buffer.from(shot).toString('base64'), appliedView: state.view };
    } catch (err) {
      // A RenderError is the viewer's own answer from a live browser: not retried.
      if (err instanceof BrowserDied || err instanceof RenderError) throw err;
      throw (await diedSoon()) ?? err;
    } finally {
      await browser.close().catch(() => undefined);
    }
  };

  const deaths: BrowserDied[] = [];
  let shot: Shot | null = null;
  while (!shot && deaths.length < Math.max(1, attempts)) {
    try {
      shot = await renderOnce();
    } catch (err) {
      if (!(err instanceof BrowserDied)) throw err;
      deaths.push(err);
    }
  }
  if (!shot) {
    const n = deaths.length;
    throw new RenderError(
      `Chrome quit on its own ${n === 1 ? 'on the only attempt' : `on all ${n} attempts`} to render ` +
        `${renderedUrl} (${deaths.map((d) => d.describe()).join('; ')}). That is the browser at ` +
        `${chromePath}, not the model. A managed or desktop Chrome can do this even headless. ` +
        'Point THREED_CHROME_PATH at a chrome-headless-shell instead: ' +
        '`npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer` ' +
        'prints its path.',
    );
  }

  const { png, appliedView } = shot;
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
    appliedView,
    width,
    height,
    bytes: Buffer.from(png, 'base64').length,
    out,
    attempts: deaths.length + 1,
    png,
  };
}
