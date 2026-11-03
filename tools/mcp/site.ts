/**
 * Reads of the published site, over plain HTTPS.
 *
 * Everything the viewer reads is public through CloudFront — the per-project
 * manifest, the comment threads, and the publish status objects — so the whole
 * read side of this server needs no credentials and no new API routes. That is
 * also its limit: there is no public index of projects, so these functions all
 * start from a slug you already know. Listing every project, editing notes and
 * deleting a revision stay behind the Cognito-authorized /admin routes, which a
 * headless server cannot reach.
 *
 * Freshness: /projects/*, /comments/* and /status/* are served with a 5-second
 * (max 10) TTL, and CloudFront does not honour a viewer's `cache-control` request
 * header, so a read straight after a write can legitimately show the old value
 * for a few seconds. The header is sent anyway (it costs nothing and helps if the
 * cache policy ever changes), and the publish poller's deadline absorbs it.
 *
 * One trap worth knowing: a 403 from the private bucket is mapped to a 404 and
 * *cached for 30 seconds*. So never probe a status URL before the object exists —
 * poll only after `POST /publish` has returned, which is when it has been written.
 */
import {
  type Comment,
  commentsKey,
  type Manifest,
  manifestKey,
  modelKey,
  type RevisionStatus,
  type SourceProvenance,
  statusKey,
} from '../../lib/lambda/handler';

import type { Config } from './config';
import { errorDetail, type FetchLike, type HttpResult, nodeFetch, parseJson, request } from './http';
import { formatViewFragment, splitViewTokens, type View } from './viewref';

/** Caller-fixable problem with a site read: no site URL, or a bad response. */
export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteError';
  }
}

export interface SiteReader {
  siteUrl: string;
  timeoutMs: number;
  fetch: FetchLike;
}

const NO_SITE_URL =
  'No site URL. Deploy with `npx cdk deploy --outputs-file cdk-outputs.json`, or set ' +
  'THREED_SITE_URL (the deployed value is the SiteUrl stack output).';

/**
 * `siteUrl` overrides the configured one, which is how a publish verifies itself
 * on a deployment whose SiteUrl was never written into the config: the API's own
 * response carries the share URL, so its origin is authoritative.
 */
export function siteReader(
  cfg: Config,
  fetchImpl: FetchLike = nodeFetch,
  siteUrl?: string | null,
): SiteReader {
  const effective = siteUrl ?? cfg.siteUrl;
  if (!effective) throw new SiteError(NO_SITE_URL);
  return {
    siteUrl: effective.replace(/\/+$/, ''),
    timeoutMs: Math.round(cfg.httpTimeoutSeconds * 1000),
    fetch: fetchImpl,
  };
}

/** The publish status object the API writes and the publisher polls. */
export interface StatusObject {
  status: RevisionStatus;
  project: string;
  revision: number;
  url?: string;
  error?: string;
  /**
   * Where the revision was built from. Written by the processor when it flips a
   * revision to ready, so it is absent while a publish is still processing and on
   * one that failed — the manifest is the other place to read it.
   */
  source?: SourceProvenance;
}

async function getJson<T>(reader: SiteReader, path: string, what: string): Promise<T | null> {
  const url = `${reader.siteUrl}/${path}`;
  const result = await request(
    reader.fetch,
    url,
    { method: 'GET', headers: { 'cache-control': 'no-cache' } },
    reader.timeoutMs,
  );
  if (result.status === 404 || result.status === 403) return null;
  if (result.status !== 200) {
    throw new SiteError(`Could not read ${what} (${url}): ${errorDetail(result)}`);
  }
  const parsed = parseJson<T>(result.body);
  if (!parsed) throw new SiteError(`${url} did not return JSON, which means it is not ${what}.`);
  return parsed;
}

/** The public manifest, or null when the project has nothing published. */
export const fetchManifest = (reader: SiteReader, slug: string): Promise<Manifest | null> =>
  getJson<Manifest>(reader, manifestKey(slug), `the manifest for "${slug}"`);

/** A revision's feedback thread, or null when the revision does not exist. */
export async function fetchComments(
  reader: SiteReader,
  slug: string,
  rev: number,
): Promise<Comment[] | null> {
  const thread = await getJson<{ comments?: Comment[] }>(
    reader,
    commentsKey(slug, rev),
    `the comments on ${slug} revision ${rev}`,
  );
  return thread ? (thread.comments ?? []) : null;
}

/** A revision's publish status, or null when nothing was ever reserved for it. */
export const fetchStatus = (
  reader: SiteReader,
  slug: string,
  rev: number,
): Promise<StatusObject | null> =>
  getJson<StatusObject>(reader, statusKey(slug, rev), `the status of ${slug} revision ${rev}`);

export const shareUrlFor = (siteUrl: string, slug: string, rev: number): string =>
  `${siteUrl}/${slug}/${rev}`;
export const modelUrlFor = (siteUrl: string, slug: string, rev: number): string =>
  `${siteUrl}/${modelKey(slug, rev)}`;

/** What a status object means for the caller who was waiting on it. */
export function describeStatus(status: StatusObject, siteUrl: string): string {
  switch (status.status) {
    case 'ready': {
      const built = status.source?.commit
        ? `, built from ${status.source.commit.slice(0, 12)}` +
          `${status.source.dirty ? ' with uncommitted changes' : ''}`
        : '';
      return (
        `Revision ${status.revision} is published${built}: ` +
        `${status.url ?? shareUrlFor(siteUrl, status.project, status.revision)}`
      );
    }
    case 'error':
      return (
        `Revision ${status.revision} failed to process: ${status.error ?? 'no reason recorded'}. ` +
        'Publish again with revision set to this number to retry it without spending a new one.'
      );
    default:
      return (
        `Revision ${status.revision} is still processing. It was reserved, so the number is ` +
        'spent either way; check again in a few seconds.'
      );
  }
}

// --- revision list -----------------------------------------------------------

export interface RevisionSummary {
  rev: number;
  url: string;
  publishedAt: string | null;
  notes: string | null;
  bytes: number | null;
  commentCount: number;
  isLatest: boolean;
  /** Where it was built from, when the revision recorded it. */
  source: SourceProvenance | null;
}

export interface ProjectReport {
  project: string;
  title: string | null;
  latest: number | null;
  latestUrl: string | null;
  /** The bare project URL, which always resolves to the latest revision. */
  projectUrl: string;
  revisions: RevisionSummary[];
}

export function projectReport(manifest: Manifest, siteUrl: string): ProjectReport {
  return {
    project: manifest.slug,
    title: manifest.title,
    latest: manifest.latest,
    latestUrl: manifest.latest === null ? null : shareUrlFor(siteUrl, manifest.slug, manifest.latest),
    projectUrl: `${siteUrl}/${manifest.slug}`,
    revisions: manifest.revisions.map((r) => ({
      rev: r.rev,
      url: shareUrlFor(siteUrl, manifest.slug, r.rev),
      publishedAt: r.publishedAt,
      notes: r.notes,
      bytes: r.bytes,
      commentCount: r.commentCount,
      isLatest: r.rev === manifest.latest,
      source: r.source ?? null,
    })),
  };
}

// --- feedback ----------------------------------------------------------------

export interface FeedbackItem extends Comment {
  project: string;
  revision: number;
  url: string;
  /** The comment's `@view(...)` references, parsed, in the order they appear. */
  views: View[];
  /** The same views as share links that open on them: `<url>#view(...)`. */
  viewUrls: string[];
}

/** The view references in a comment, and a deep link for each. */
export function commentViews(text: string, url: string): { views: View[]; viewUrls: string[] } {
  const views = splitViewTokens(text ?? '').flatMap((segment) => ('view' in segment ? [segment.view] : []));
  return { views, viewUrls: views.map((view) => `${url}#${formatViewFragment(view)}`) };
}

/**
 * Feedback for one revision, or across every revision of the project.
 *
 * The roll-up only fetches threads the manifest says have comments, the way the
 * admin API's own roll-up does, so an eight-revision project is one manifest read
 * plus however many threads actually have something in them.
 */
export async function fetchFeedback(
  reader: SiteReader,
  slug: string,
  revision?: number | null,
): Promise<{ items: FeedbackItem[]; revisionsRead: number[]; manifest: Manifest | null }> {
  const manifest = await fetchManifest(reader, slug);

  const wanted =
    revision !== undefined && revision !== null
      ? [revision]
      : (manifest?.revisions ?? []).filter((r) => r.commentCount > 0).map((r) => r.rev);

  const items: FeedbackItem[] = [];
  const revisionsRead: number[] = [];
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= wanted.length) return;
      const rev = wanted[i];
      const comments = await fetchComments(reader, slug, rev);
      if (comments === null) continue;
      revisionsRead.push(rev);
      for (const comment of comments) {
        const url = shareUrlFor(reader.siteUrl, slug, rev);
        items.push({ ...comment, project: slug, revision: rev, url, ...commentViews(comment.text, url) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));

  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  revisionsRead.sort((a, b) => a - b);
  return { items, revisionsRead, manifest };
}

// --- verification ------------------------------------------------------------

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  project: string;
  revision: number;
  url: string;
  modelUrl: string;
  ok: boolean;
  checks: VerifyCheck[];
}

/**
 * Prove that a revision actually serves, which a `ready` status object does not.
 *
 * The status object is written by the processor from inside AWS; it says the model
 * was copied into place, not that a reviewer opening the link will get it. Between
 * the two sit the distribution, its origin access control, the certificate and
 * DNS — and the failure mode that matters is a URL you have already sent out.
 *
 * `expectedBytes` catches the subtler version: a 200 that serves the wrong file.
 */
export async function verifyRevision(
  reader: SiteReader,
  slug: string,
  rev: number,
  expectedBytes?: number | null,
): Promise<VerifyReport> {
  const url = shareUrlFor(reader.siteUrl, slug, rev);
  const modelUrl = modelUrlFor(reader.siteUrl, slug, rev);
  const checks: VerifyCheck[] = [];

  const page = await request(reader.fetch, url, { method: 'GET' }, reader.timeoutMs);
  checks.push({
    name: 'share page',
    ok: page.status === 200,
    detail:
      page.status === 200
        ? `${url} → 200`
        : `${url} → ${describeFailure(page)}${page.status === 404 ? ' (an unknown project or revision serves the 404 page)' : ''}`,
  });

  const model = await request(reader.fetch, modelUrl, { method: 'HEAD' }, reader.timeoutMs);
  const contentType = model.headers.get('content-type');
  const cacheControl = model.headers.get('cache-control');
  const length = Number(model.headers.get('content-length') ?? NaN);

  checks.push({
    name: 'model',
    ok: model.status === 200,
    detail: model.status === 200 ? `${modelUrl} → 200` : `${modelUrl} → ${describeFailure(model)}`,
  });

  if (model.status === 200) {
    checks.push({
      name: 'content-type',
      ok: contentType === 'model/gltf-binary',
      detail:
        contentType === 'model/gltf-binary'
          ? 'model/gltf-binary'
          : `${contentType ?? 'absent'} — the processor sets model/gltf-binary when it copies the object, so this suggests the file arrived some other way`,
    });
    checks.push({
      name: 'cache-control',
      ok: Boolean(cacheControl?.includes('immutable')),
      detail: cacheControl ?? 'absent — revision models are meant to be immutable for a year',
    });
    if (expectedBytes !== undefined && expectedBytes !== null) {
      checks.push({
        name: 'size',
        ok: length === expectedBytes,
        detail: Number.isNaN(length)
          ? 'no content-length header'
          : `${length} bytes served, ${expectedBytes} expected`,
      });
    }
  }

  return { project: slug, revision: rev, url, modelUrl, ok: checks.every((c) => c.ok), checks };
}

const describeFailure = (result: HttpResult): string =>
  result.networkError ? result.networkError : `HTTP ${result.status}: ${errorDetail(result)}`;
