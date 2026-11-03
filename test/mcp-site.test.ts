/**
 * Reading the published site.
 *
 * These are the tools that close the loop — what revisions exist, did the publish
 * land, what did reviewers say, does the URL actually serve — and they all read the
 * same public objects the viewer reads. So what needs pinning is the interpretation
 * rather than the transport: that "no manifest" means "nothing published" instead of
 * an error, that a private-bucket 403 is the same answer as a 404, that the roll-up
 * only fetches threads the manifest says have something in them, and that
 * verification checks what a reviewer would actually receive.
 */
import * as path from 'path';

import { type Config, loadConfig } from '../tools/mcp/config';
import type { FetchLike, FetchResponseLike, RequestInitLike } from '../tools/mcp/http';
import {
  describeStatus,
  fetchComments,
  fetchFeedback,
  fetchManifest,
  fetchStatus,
  projectReport,
  siteReader,
  SiteError,
  verifyRevision,
} from '../tools/mcp/site';

const repoRoot = path.join(__dirname, '..');

const base = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({ env: { PATH: '' }, repoRoot }).values,
  siteUrl: 'https://3d.example',
  ...overrides,
});

interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A fetch stub keyed by URL path, recording what was asked for. */
function harness(replies: Record<string, Reply>, fallback: Reply = { status: 404 }) {
  const asked: string[] = [];
  const fetchImpl: FetchLike = async (url: string, init: RequestInitLike = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    asked.push(key);
    const reply = replies[key] ?? replies[new URL(url).pathname] ?? fallback;
    return {
      status: reply.status,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
      text: async () => reply.body ?? '',
    } satisfies FetchResponseLike;
  };
  return { asked, reader: siteReader(base(), fetchImpl) };
}

const json = (value: unknown): Reply => ({ status: 200, body: JSON.stringify(value) });

const MANIFEST = {
  slug: 'towel-clip',
  title: 'Towel clip',
  latest: 4,
  revisions: [
    { rev: 1, publishedAt: '2026-08-01T10:00:00.000Z', notes: 'first cut', bytes: 1024, commentCount: 0 },
    { rev: 3, publishedAt: '2026-08-20T10:00:00.000Z', notes: null, bytes: 2048, commentCount: 2 },
    { rev: 4, publishedAt: '2026-08-27T10:00:00.000Z', notes: 'wider hook', bytes: 4096, commentCount: 1 },
  ],
};

describe('siteReader', () => {
  it('says what to deploy or set when there is no site URL', () => {
    expect(() => siteReader(base({ siteUrl: null }))).toThrow(SiteError);
    expect(() => siteReader(base({ siteUrl: null }))).toThrow(/THREED_SITE_URL/);
  });

  // A publish verifies itself against the URL the API returned, which is
  // authoritative even when nothing local knows the site URL.
  it('takes an override, trailing slash and all', () => {
    expect(siteReader(base({ siteUrl: null }), undefined, 'https://other.example/').siteUrl).toBe(
      'https://other.example',
    );
  });
});

describe('fetchManifest', () => {
  it('reads the manifest the viewer reads', async () => {
    const { reader, asked } = harness({ 'GET /projects/towel-clip.json': json(MANIFEST) });
    await expect(fetchManifest(reader, 'towel-clip')).resolves.toEqual(MANIFEST);
    expect(asked).toEqual(['GET /projects/towel-clip.json']);
  });

  // Behind origin access control a missing key comes back as 403, and CloudFront
  // maps it to 404 — both mean the same thing, and neither is an error worth
  // raising: the project may simply have nothing published yet.
  it.each([404, 403])('answers null for %s rather than throwing', async (status) => {
    const { reader } = harness({ 'GET /projects/towel-clip.json': { status } });
    await expect(fetchManifest(reader, 'towel-clip')).resolves.toBeNull();
  });

  it('complains about a body that is not JSON, or a server that failed', async () => {
    const html = harness({ 'GET /projects/towel-clip.json': { status: 200, body: '<html>404</html>' } });
    await expect(fetchManifest(html.reader, 'towel-clip')).rejects.toThrow(/did not return JSON/);

    const broken = harness({ 'GET /projects/towel-clip.json': { status: 500, body: 'oops' } });
    await expect(fetchManifest(broken.reader, 'towel-clip')).rejects.toThrow(SiteError);
  });
});

describe('fetchComments', () => {
  it('returns the thread, and an empty list for a revision with none', async () => {
    const { reader } = harness({
      'GET /comments/towel-clip/4.json': json({ comments: [{ name: 'Sam', text: 'hi', at: 'x' }] }),
      'GET /comments/towel-clip/3.json': json({}),
    });
    await expect(fetchComments(reader, 'towel-clip', 4)).resolves.toHaveLength(1);
    await expect(fetchComments(reader, 'towel-clip', 3)).resolves.toEqual([]);
  });

  it('distinguishes "no such revision" from "no comments"', async () => {
    const { reader } = harness({});
    await expect(fetchComments(reader, 'towel-clip', 9)).resolves.toBeNull();
  });
});

describe('publish status', () => {
  it('reports a revision that is ready, with its URL', async () => {
    const { reader } = harness({
      'GET /status/towel-clip/4.json': json({
        status: 'ready',
        project: 'towel-clip',
        revision: 4,
        url: 'https://3d.example/towel-clip/4',
      }),
    });
    const status = await fetchStatus(reader, 'towel-clip', 4);
    expect(describeStatus(status!, 'https://3d.example')).toContain('https://3d.example/towel-clip/4');
  });

  // The number is spent either way, so both of these have to say what to do next
  // rather than only what went wrong.
  it('points a failed revision at the retry that reuses its number', async () => {
    const status = { status: 'error' as const, project: 'towel-clip', revision: 4, error: 'Not a binary glTF file.' };
    const described = describeStatus(status, 'https://3d.example');
    expect(described).toContain('Not a binary glTF file.');
    expect(described).toMatch(/revision set to this number/);
  });

  it('says a processing revision has already spent its number', async () => {
    const described = describeStatus(
      { status: 'processing', project: 'towel-clip', revision: 4 },
      'https://3d.example',
    );
    expect(described).toMatch(/still processing/);
    expect(described).toMatch(/spent either way/);
  });

  it('answers null when nothing was ever reserved for that number', async () => {
    const { reader } = harness({});
    await expect(fetchStatus(reader, 'towel-clip', 99)).resolves.toBeNull();
  });
});

describe('projectReport', () => {
  it('turns the manifest into share URLs, marking the latest', () => {
    const report = projectReport(MANIFEST, 'https://3d.example');
    expect(report.latestUrl).toBe('https://3d.example/towel-clip/4');
    expect(report.projectUrl).toBe('https://3d.example/towel-clip/');
    expect(report.revisions.map((r) => [r.rev, r.url, r.isLatest])).toEqual([
      [1, 'https://3d.example/towel-clip/1', false],
      [3, 'https://3d.example/towel-clip/3', false],
      [4, 'https://3d.example/towel-clip/4', true],
    ]);
  });

  it('has no latest URL for a project whose publishes all failed', () => {
    const report = projectReport({ ...MANIFEST, latest: null, revisions: [] }, 'https://3d.example');
    expect(report.latestUrl).toBeNull();
    expect(report.revisions).toEqual([]);
  });
});

describe('fetchFeedback', () => {
  const withThreads = () =>
    harness({
      'GET /projects/towel-clip.json': json(MANIFEST),
      'GET /comments/towel-clip/3.json': json({
        comments: [
          { name: 'Sam', text: 'the clip fouls the rail', at: '2026-08-21T09:00:00.000Z' },
          { name: 'Anonymous', text: 'agreed', at: '2026-08-22T09:00:00.000Z' },
        ],
      }),
      'GET /comments/towel-clip/4.json': json({
        comments: [{ name: 'Jo', text: 'better', at: '2026-08-28T09:00:00.000Z' }],
      }),
    });

  it('rolls up every revision that has comments, newest first', async () => {
    const { reader, asked } = withThreads();
    const { items, revisionsRead } = await fetchFeedback(reader, 'towel-clip');

    expect(items.map((i) => i.text)).toEqual(['better', 'agreed', 'the clip fouls the rail']);
    expect(items[0]).toMatchObject({ revision: 4, url: 'https://3d.example/towel-clip/4' });
    expect(revisionsRead).toEqual([3, 4]);
    // Revision 1 has commentCount 0, so its thread is never fetched.
    expect(asked).not.toContain('GET /comments/towel-clip/1.json');
  });

  it('reads one revision when asked, without needing it in the manifest', async () => {
    const { reader } = withThreads();
    const { items } = await fetchFeedback(reader, 'towel-clip', 3);
    expect(items.map((i) => i.revision)).toEqual([3, 3]);
  });

  it('is empty, not broken, for a project with nothing published', async () => {
    const { reader } = harness({});
    const { items, manifest } = await fetchFeedback(reader, 'towel-clip');
    expect(items).toEqual([]);
    expect(manifest).toBeNull();
  });

  it('parses view references into views and deep links, in order', async () => {
    const { reader } = harness({
      'GET /projects/towel-clip.json': json(MANIFEST),
      'GET /comments/towel-clip/3.json': json({
        comments: [
          {
            name: 'Sam',
            text: 'thin here @view(az=-35,el=22,zoom=1.6) and here @view(az=90,el=0,zoom=2,parts=10), not @view(az=1)',
            at: '2026-08-21T09:00:00.000Z',
          },
          { name: 'Jo', text: 'no references', at: '2026-08-22T09:00:00.000Z' },
        ],
      }),
    });
    const { items } = await fetchFeedback(reader, 'towel-clip', 3);
    const [plain, pointed] = items;
    expect(plain.views).toEqual([]);
    expect(plain.viewUrls).toEqual([]);
    expect(pointed.views).toHaveLength(2);
    expect(pointed.views[1]).toMatchObject({ az: 90, el: 0, zoom: 2, parts: '10' });
    expect(pointed.viewUrls).toEqual([
      'https://3d.example/towel-clip/3#view(az=-35,el=22,zoom=1.6)',
      'https://3d.example/towel-clip/3#view(az=90,el=0,zoom=2,parts=10)',
    ]);
  });
});

describe('verifyRevision', () => {
  const model = (extra: Record<string, string> = {}): Reply => ({
    status: 200,
    headers: {
      'content-type': 'model/gltf-binary',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': '4096',
      ...extra,
    },
  });

  const good = {
    'GET /towel-clip/4': { status: 200, body: '<html>viewer</html>' },
    'HEAD /towel-clip/4/model.glb': model(),
  };

  it('passes when the page and the model both serve as expected', async () => {
    const { reader, asked } = harness(good);
    const report = await verifyRevision(reader, 'towel-clip', 4, 4096);
    expect(report.ok).toBe(true);
    expect(asked).toEqual(['GET /towel-clip/4', 'HEAD /towel-clip/4/model.glb']);
    expect(report.modelUrl).toBe('https://3d.example/towel-clip/4/model.glb');
  });

  it('explains a 404 as an unknown project or revision', async () => {
    const { reader } = harness({ ...good, 'GET /towel-clip/4': { status: 404 } });
    const report = await verifyRevision(reader, 'towel-clip', 4);
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toMatch(/unknown project or revision/);
  });

  // The processor sets model/gltf-binary when it copies the object, so anything
  // else means the file arrived by some other route.
  it('catches a model served with the wrong content type', async () => {
    const { reader } = harness({
      ...good,
      'HEAD /towel-clip/4/model.glb': model({ 'content-type': 'application/octet-stream' }),
    });
    const report = await verifyRevision(reader, 'towel-clip', 4);
    expect(report.checks.find((c) => c.name === 'content-type')).toMatchObject({ ok: false });
  });

  it('catches a model that is not cached as immutable', async () => {
    const { reader } = harness({
      ...good,
      'HEAD /towel-clip/4/model.glb': model({ 'cache-control': 'public, max-age=60' }),
    });
    const report = await verifyRevision(reader, 'towel-clip', 4);
    expect(report.checks.find((c) => c.name === 'cache-control')).toMatchObject({ ok: false });
  });

  it('catches a 200 that serves the wrong bytes', async () => {
    const { reader } = harness(good);
    const report = await verifyRevision(reader, 'towel-clip', 4, 99);
    expect(report.checks.find((c) => c.name === 'size')).toMatchObject({ ok: false });
    expect(report.ok).toBe(false);
  });

  it('skips the model checks entirely when the model itself is missing', async () => {
    const { reader } = harness({ ...good, 'HEAD /towel-clip/4/model.glb': { status: 403 } });
    const report = await verifyRevision(reader, 'towel-clip', 4, 4096);
    expect(report.checks.map((c) => c.name)).toEqual(['share page', 'model']);
    expect(report.ok).toBe(false);
  });
});
