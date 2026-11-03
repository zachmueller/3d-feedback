/**
 * render_view, without a browser.
 *
 * Launching Chrome is the one part not worth running in jest, so the launcher is
 * injected: these pin what is loaded (the bare share URL with the view in its
 * fragment), how the viewer's readiness contract is read, what fails before a
 * browser is ever started, and that the browser is closed whatever happens.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BadRequest } from '../lib/lambda/handler';
import { type Config, loadConfig } from '../tools/mcp/config';
import type { FetchLike } from '../tools/mcp/http';
import {
  CHROME_ARGS,
  clampSize,
  type Launcher,
  RenderError,
  renderUrl,
  renderView,
  resolveViewInput,
} from '../tools/mcp/render';
import { siteReader } from '../tools/mcp/site';

let dir: string;
let chrome: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threed-mcp-render-'));
  chrome = path.join(dir, 'chrome');
  fs.writeFileSync(chrome, '');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const cfg = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({ env: { PATH: '' }, repoRoot: path.join(__dirname, '..') }).values,
  siteUrl: 'https://3d.example',
  chromePath: chrome,
  ...overrides,
});

const MANIFEST = {
  slug: 'towel-clip',
  title: 'Towel clip',
  latest: 4,
  revisions: [
    { rev: 3, publishedAt: null, notes: null, bytes: 10, commentCount: 0 },
    { rev: 4, publishedAt: null, notes: null, bytes: 10, commentCount: 0 },
  ],
};

const reader = (manifest: unknown = MANIFEST) => {
  const fetchImpl: FetchLike = async (url) => ({
    status: manifest && new URL(url).pathname === '/projects/towel-clip.json' ? 200 : 404,
    headers: { get: () => null },
    text: async () => JSON.stringify(manifest),
  });
  return siteReader(cfg(), fetchImpl);
};

const PNG = Buffer.from('not really a png').toString('base64');

/** A stand-in browser whose page reports `state`, recording what it was asked. */
function fakeLauncher(state: Record<string, string | null> = { state: 'ready', view: 'view(az=-35,el=22,zoom=1.6)' }) {
  const calls = { launched: [] as unknown[], visited: [] as string[], closed: 0 };
  const launch: Launcher = async (opts) => {
    calls.launched.push(opts);
    return {
      newPage: async () => ({
        goto: async (url: string) => {
          calls.visited.push(url);
        },
        waitForFunction: async () => {
          if (state.state === 'hang') throw new Error('timeout');
        },
        evaluate: async <T>() => ({ title: 'Project not found', text: 'There is none.', ...state }) as T,
        $: async () => ({ screenshot: async () => PNG }),
      }),
      close: async () => {
        calls.closed += 1;
      },
    };
  };
  return { launch, calls };
}

describe('resolveViewInput', () => {
  it('takes a reference as written, the fragment form, or a whole share URL', () => {
    for (const text of [
      '@view(az=-35,el=22,zoom=1.6)',
      'view(az=-35,el=22,zoom=1.6)',
      'https://3d.example/towel-clip/4#view(az=-35,el=22,zoom=1.6)',
    ]) {
      expect(resolveViewInput(text)).toMatchObject({ az: -35, el: 22, zoom: 1.6 });
    }
  });

  it('takes the numbers as an object, with the token defaults', () => {
    expect(resolveViewInput({ az: 90, el: 10, pan: [1, 2, 3], parts: '01' })).toEqual({
      az: 90, el: 10, zoom: 1, roll: 0, pan: { x: 1, y: 2, z: 3 }, parts: '01',
    });
  });

  it('refuses what a token could not say, with the syntax in the message', () => {
    expect(() => resolveViewInput('@view(az=1)')).toThrow(/@view\(az=<deg>,el=<deg>,zoom=<x>\)/);
    expect(() => resolveViewInput({ az: 0, el: 120 })).toThrow(BadRequest);
  });
});

describe('clampSize and renderUrl', () => {
  it('defaults to 1200×800 and keeps sizes a browser will allocate', () => {
    expect(clampSize()).toEqual({ width: 1200, height: 800 });
    expect(clampSize(10, 99999)).toEqual({ width: 64, height: 3000 });
    expect(clampSize(640.4, 480.6)).toEqual({ width: 640, height: 481 });
  });

  it('puts bare in the query and the view in the fragment', () => {
    const view = resolveViewInput('@view(az=-35,el=22,zoom=1.6)');
    expect(renderUrl('https://3d.example/', 'towel-clip', 4, view, true)).toBe(
      'https://3d.example/towel-clip/4?bare=1#view(az=-35,el=22,zoom=1.6)',
    );
    expect(renderUrl('https://3d.example', 'towel-clip', 4, view, false)).toBe(
      'https://3d.example/towel-clip/4#view(az=-35,el=22,zoom=1.6)',
    );
  });
});

describe('renderView', () => {
  it('loads the bare share page at the view, screenshots it, saves it, and closes the browser', async () => {
    const { launch, calls } = fakeLauncher();
    const out = path.join(dir, 'shots', 'view.png');
    const result = await renderView(
      cfg(),
      reader(),
      { project: 'towel-clip', view: '@view(az=-35,el=22,zoom=1.6)', width: 800, height: 600, out },
      launch,
    );
    expect(calls.visited).toEqual(['https://3d.example/towel-clip/4?bare=1#view(az=-35,el=22,zoom=1.6)']);
    expect(calls.launched[0]).toMatchObject({ executablePath: chrome, args: CHROME_ARGS, width: 800, height: 600 });
    expect(result).toMatchObject({
      revision: 4,
      url: 'https://3d.example/towel-clip/4#view(az=-35,el=22,zoom=1.6)',
      appliedView: 'view(az=-35,el=22,zoom=1.6)',
      png: PNG,
      out,
    });
    expect(fs.readFileSync(out).toString('base64')).toBe(PNG);
    expect(calls.closed).toBe(1);
  });

  it('never forces software GL, which crashed Chrome on macOS', () => {
    expect(CHROME_ARGS.join(' ')).not.toMatch(/use-angle=swiftshader|use-gl=/);
  });

  it('refuses before launching anything when there is no browser, or no such revision', async () => {
    const { launch, calls } = fakeLauncher();
    await expect(
      renderView(cfg({ chromePath: null }), reader(), { project: 'towel-clip', view: '@view(az=0,el=0,zoom=1)' }, launch),
    ).rejects.toThrow(/THREED_CHROME_PATH/);
    await expect(
      renderView(cfg(), reader(), { project: 'towel-clip', revision: 9, view: '@view(az=0,el=0,zoom=1)' }, launch),
    ).rejects.toThrow(/no published revision 9\. Published: 3, 4/);
    await expect(
      renderView(cfg(), reader(null), { project: 'towel-clip', view: '@view(az=0,el=0,zoom=1)' }, launch),
    ).rejects.toThrow(/Nothing published/);
    expect(calls.launched).toHaveLength(0);
  });

  it('reports the viewer’s own error, and a viewer that never gets ready, and still closes', async () => {
    const failing = fakeLauncher({ state: 'error', view: null });
    await expect(
      renderView(cfg(), reader(), { project: 'towel-clip', view: '@view(az=0,el=0,zoom=1)' }, failing.launch),
    ).rejects.toThrow(new RenderError(
      'The viewer could not show https://3d.example/towel-clip/4?bare=1#view(az=0,el=0,zoom=1): Project not found. There is none.',
    ));
    expect(failing.calls.closed).toBe(1);

    const hanging = fakeLauncher({ state: 'hang' });
    await expect(
      renderView(cfg(), reader(), { project: 'towel-clip', view: '@view(az=0,el=0,zoom=1)' }, hanging.launch),
    ).rejects.toThrow(/THREED_RENDER_TIMEOUT_SECONDS/);
    expect(hanging.calls.closed).toBe(1);
  });
});
