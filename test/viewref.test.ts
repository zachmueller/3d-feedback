/**
 * View references: the token grammar and the camera math.
 *
 * viewer-app/viewref.js (the browser) and tools/mcp/viewref.ts (the MCP server)
 * are two copies of one contract, so every case here runs through both. The
 * browser module is loaded the way scripts/serve-local.js loads the CloudFront
 * functions — its `export` keywords stripped and the source evaluated — because
 * it is a build-free ES module that jest cannot import directly.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as ts from '../tools/mcp/viewref';

type Impl = typeof ts;

function loadViewerModule(): Impl {
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'viewer-app', 'viewref.js'), 'utf-8')
    .replace(/^export\s+/gm, '');
  const names = [
    'toModel', 'toViewer', 'directionToAzEl', 'cameraToView', 'viewToCamera', 'VIEW_TOKEN_RE',
    'parseView', 'formatViewFragment', 'formatViewToken', 'splitViewTokens', 'describeView',
  ];
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return { ${names.join(', ')} };`)() as Impl;
}

const impls: Array<[string, Impl]> = [
  ['viewer-app/viewref.js', loadViewerModule()],
  ['tools/mcp/viewref.ts', ts],
];

const ORIGIN = { x: 0, y: 0, z: 0 };
const close = (a: ts.Vec3, b: ts.Vec3, eps = 1e-9) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
  expect(Math.abs(a.z - b.z)).toBeLessThan(eps);
};

describe.each(impls)('%s', (_name, v) => {
  describe('the axis mapping', () => {
    it('is the exporter’s Z-up → Y-up, (x, y, z) → (x, z, -y)', () => {
      expect(v.toViewer({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 3, z: -2 });
      expect(v.toModel(v.toViewer({ x: 1, y: 2, z: 3 }))).toEqual({ x: 1, y: 2, z: 3 });
    });
  });

  describe('directions → az/el, in model axes', () => {
    it.each([
      ['Front', { x: 0, y: -1, z: 0 }, 0, 0],
      ['Right', { x: 1, y: 0, z: 0 }, 90, 0],
      ['Back', { x: 0, y: 1, z: 0 }, 180, 0],
      ['Left', { x: -1, y: 0, z: 0 }, -90, 0],
      ['Top', { x: 0, y: 0, z: 1 }, 0, 90],
      ['Bottom', { x: 0, y: 0, z: -1 }, 0, -90],
    ])('%s', (_face, dir, az, el) => {
      const got = v.directionToAzEl(dir);
      expect(got.el).toBeCloseTo(el, 9);
      if (Math.abs(el) < 90) expect(got.az).toBeCloseTo(az, 9);
    });
  });

  describe('viewToCamera', () => {
    const frame = { center: { x: 5, y: 6, z: 7 }, homeDistance: 10 };

    it('puts Front on the scene’s +Z with Y up', () => {
      const cam = v.viewToCamera({ az: 0, el: 0, zoom: 1 }, frame);
      close(cam.position, { x: 5, y: 6, z: 17 });
      close(cam.up, { x: 0, y: 1, z: 0 });
      close(cam.target, frame.center);
    });

    it('gives Top model +Y up the screen, and Bottom model -Y', () => {
      close(v.viewToCamera({ az: 0, el: 90, zoom: 1 }, frame).up, v.toViewer({ x: 0, y: 1, z: 0 }));
      close(v.viewToCamera({ az: 0, el: -90, zoom: 1 }, frame).up, v.toViewer({ x: 0, y: -1, z: 0 }));
    });

    it('divides the framing distance by zoom and offsets the target by pan', () => {
      const cam = v.viewToCamera({ az: 90, el: 0, zoom: 2, pan: { x: 1, y: 2, z: 3 } }, frame);
      const target = { x: 6, y: 9, z: 5 }; // center + toViewer(1, 2, 3)
      close(cam.target, target);
      close(cam.position, { x: 11, y: 9, z: 5 });
    });

    it('turns the camera clockwise-positive about the view axis for roll', () => {
      // Front, rolled 90°: natural up is +Z; rotating it about v = -Y by +90°
      // gives cross(v, Z) = -X.
      const cam = v.viewToCamera({ az: 0, el: 0, zoom: 1, roll: 90 }, frame);
      close(v.toModel(cam.up), { x: -1, y: 0, z: 0 });
    });
  });

  describe('cameraToView ∘ viewToCamera', () => {
    const frame = { center: { x: -3, y: 2, z: 11 }, homeDistance: 42 };
    const cases: Array<Partial<ts.View> & Pick<ts.View, 'az' | 'el' | 'zoom'>> = [];
    for (const az of [-170, -90, -35, 0, 45, 90, 179])
      for (const el of [-80, -22, 0, 23, 80])
        for (const roll of [-120, 0, 45])
          for (const zoom of [0.5, 1, 3])
            cases.push({ az, el, roll, zoom, pan: { x: 1.5, y: -2, z: 0.25 } });

    it('is the identity across the sphere', () => {
      for (const view of cases) {
        const got = v.cameraToView({ ...v.viewToCamera(view, frame), ...frame });
        expect(Math.abs(got.az - view.az)).toBeLessThan(1e-6);
        expect(Math.abs(got.el - view.el)).toBeLessThan(1e-6);
        expect(Math.abs(got.roll - (view.roll ?? 0))).toBeLessThan(1e-6);
        expect(Math.abs(got.zoom - view.zoom)).toBeLessThan(1e-9);
        close(got.pan, view.pan!, 1e-9);
      }
    });

    it('holds at the poles, where the natural up switches to ±Y', () => {
      for (const el of [90, -90]) {
        for (const roll of [0, 30]) {
          const got = v.cameraToView({ ...v.viewToCamera({ az: 0, el, zoom: 1, roll }, frame), ...frame });
          expect(got.el).toBeCloseTo(el, 6);
          expect(got.roll).toBeCloseTo(roll, 6);
        }
      }
    });

    it('reads the viewer’s home camera as az 45, el 23, zoom 1', () => {
      const home = { x: 1, y: 0.6, z: 1 };
      const view = v.cameraToView({
        position: home,
        target: ORIGIN,
        up: { x: 0, y: 1, z: 0 },
        center: ORIGIN,
        homeDistance: Math.hypot(1, 0.6, 1),
      });
      expect(v.formatViewFragment(view)).toBe('view(az=45,el=23,zoom=1)');
    });
  });

  describe('formatting', () => {
    it.each([
      [{ az: -35.04, el: 22, zoom: 1.6049 }, 'view(az=-35,el=22,zoom=1.6)'],
      [{ az: 10, el: 0, zoom: 1.605001 }, 'view(az=10,el=0,zoom=1.61)'],
      [{ az: -0.01, el: -0.04, zoom: 1, roll: 0.04 }, 'view(az=0,el=0,zoom=1)'],
      [{ az: -180, el: 0, zoom: 1 }, 'view(az=180,el=0,zoom=1)'],
      [{ az: 0, el: 0, zoom: 1, roll: -12.34 }, 'view(az=0,el=0,zoom=1,roll=-12.3)'],
      [{ az: 0, el: 0, zoom: 1, pan: { x: 0.001, y: 0, z: -0.001 } }, 'view(az=0,el=0,zoom=1)'],
      [{ az: 0, el: 0, zoom: 1, pan: { x: 1.5, y: 0, z: -2 } }, 'view(az=0,el=0,zoom=1,pan=1.5,0,-2)'],
      [{ az: 137, el: 89.97, zoom: 1 }, 'view(az=0,el=90,zoom=1)'],
      [{ az: -12, el: -90, zoom: 1, roll: 30 }, 'view(az=0,el=-90,zoom=1,roll=30)'],
    ])('%j → %s', (view, want) => {
      expect(v.formatViewFragment(view)).toBe(want);
      expect(v.formatViewToken(view)).toBe(`@${want}`);
    });

    it('omits parts that match the default and keeps ones that do not', () => {
      const view = { az: 0, el: 0, zoom: 1, parts: '110' };
      expect(v.formatViewFragment(view, '110')).toBe('view(az=0,el=0,zoom=1)');
      expect(v.formatViewFragment(view, '111')).toBe('view(az=0,el=0,zoom=1,parts=110)');
    });

    it('describes a view for a chip', () => {
      expect(v.describeView({ az: -35, el: 22, zoom: 1.6 })).toBe('\u{1F441} az −35° · el 22° · 1.6×');
      expect(v.describeView({ az: 0, el: 0, zoom: 1, roll: 5, pan: { x: 1, y: 0, z: 0 }, parts: '01' })).toBe(
        '\u{1F441} az 0° · el 0° · 1× · roll 5° · pan · parts',
      );
    });
  });

  describe('parsing', () => {
    it.each([
      '@view(az=-35,el=22,zoom=1.6)',
      'view(az=90,el=10,zoom=1.2,parts=110)',
      'az=0,el=0,zoom=1,roll=-12.3,pan=1.5,0,-2',
      '@view(az=0,el=-90,zoom=0.25,pan=0,0,3,parts=0)',
      '@view(az=180,el=-45,zoom=0.25)',
    ])('round-trips %s', (text) => {
      const view = v.parseView(text)!;
      expect(view).not.toBeNull();
      const inner = text.replace(/^@?view\(|\)$/g, '');
      expect(v.formatViewFragment(view)).toBe(`view(${inner})`);
    });

    it('fills the optional fields with their defaults', () => {
      expect(v.parseView('@view(az=1,el=2,zoom=3)')).toEqual({
        az: 1, el: 2, zoom: 3, roll: 0, pan: { x: 0, y: 0, z: 0 }, parts: null,
      });
    });

    it.each([
      '@view(az=1)',
      '@view(az=0,el=0,zoom=0)',
      '@view(az=0,el=91,zoom=1)',
      '@view(az=181,el=0,zoom=1)',
      '@view(az=0,el=0,zoom=1,roll=200)',
      '@view(az=0,el=0,zoom=1,pan=1,2)',
      '@view(az=0,el=0,zoom=1,parts=012)',
      '@view(az=0,el=0,zoom=1,foo=1)',
      '@view(az=1,az=2,el=0,zoom=1)',
      '@view(az=1e3,el=0,zoom=1)',
      '@view(az=,el=0,zoom=1)',
      '@view(1,az=0,el=0,zoom=1)',
      '@view(az=0,el=0,zoom=1,2)',
      '@view(az=0,el=0,zoom=1',
      '',
      42,
    ])('rejects %j', (text) => {
      expect(v.parseView(text)).toBeNull();
    });
  });

  describe('splitViewTokens', () => {
    it('separates references from prose and leaves a broken one as text', () => {
      const text =
        'Arm is thin here @view(az=-35,el=22,zoom=1.6) and hide the wall @view(az=90,el=10,zoom=1.2,parts=110)' +
        ' — broken @view(az=1) stays text.';
      const segments = v.splitViewTokens(text);
      expect(segments.map((s) => ('view' in s ? 'view' : 'text'))).toEqual(['text', 'view', 'text', 'view', 'text']);
      expect(segments[4]).toEqual({ text: ' — broken @view(az=1) stays text.' });
      expect(segments[3]).toMatchObject({ raw: '@view(az=90,el=10,zoom=1.2,parts=110)', view: { parts: '110' } });
    });

    it('returns one text run for text with no references, and nothing for empty text', () => {
      expect(v.splitViewTokens('plain')).toEqual([{ text: 'plain' }]);
      expect(v.splitViewTokens('')).toEqual([]);
    });
  });
});
