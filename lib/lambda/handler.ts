/**
 * Multi-action Lambda for the 3D model host.
 *
 * One function serves two invocation paths, dispatched by event shape:
 *
 *  - HTTP API -> router, with three auth models enforced upstream by API
 *    Gateway and mirrored here:
 *      publish                        AWS_IAM (SigV4) — automation
 *      list / edit / delete / feedback Cognito JWT + email allowlist re-check
 *      comment                        public (throttled route + caps below)
 *  - S3 `OBJECT_CREATED` (staging bucket, prefix `uploads/`) -> processor:
 *    validate the GLB, copy it to its immutable revision path, flip the
 *    revision to `ready`, regenerate the project manifest, and always write
 *    `status/<slug>/<rev>.json` for the publishing CLI to poll.
 *
 * Storage layout (all JSON read-modify-writes use S3 conditional writes for
 * optimistic concurrency, so correctness needs no reserved concurrency):
 *
 *   metadata bucket   metadata.json                  private index (source of truth)
 *   assets bucket     <slug>/<rev>/model.glb         immutable model
 *                     projects/<slug>.json           public manifest (viewer)
 *                     comments/<slug>/<rev>.json     public feedback thread
 *                     status/<slug>/<rev>.json       publish progress
 *
 * The pure helpers carry the interesting logic and are exported for unit tests
 * without any AWS mocking.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const UPLOAD_PREFIX = 'uploads/';
export const PROJECTS_PREFIX = 'projects/';
export const COMMENTS_PREFIX = 'comments/';
export const STATUS_PREFIX = 'status/';

export const MODEL_FILENAME = 'model.glb';

/**
 * Slugs are the first path segment of every share URL, so they must not collide
 * with a CloudFront behavior or a top-level key prefix.
 */
export const RESERVED_SLUGS = [
  'admin',
  'api',
  'app',
  'comments',
  'favicon.ico',
  'feedback',
  'index.html',
  'login',
  'logout',
  'projects',
  'publish',
  'robots.txt',
  'status',
  'upload',
  'viewer',
];

/** Lowercase, hyphen-separated, 1–64 chars, no leading/trailing hyphen. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Ceiling on the uploaded model. A presigned PUT has no size limit of its own,
 * so the processor re-checks the object size from the S3 event. iOS Safari is
 * the real constraint at view time — a model near this cap will struggle there.
 */
export const MAX_MODEL_BYTES = 100 * 1024 * 1024; // 100 MB

export const MAX_TITLE_LEN = 120;
export const MAX_NOTES_LEN = 2000;
export const MAX_COMMENT_NAME_LEN = 60;
export const MAX_COMMENT_TEXT_LEN = 4000;
/** Per-revision thread cap; the endpoint is public, so it needs a ceiling. */
export const MAX_COMMENTS_PER_REVISION = 200;
/** Cap on the admin feedback roll-up. */
export const MAX_FEEDBACK_ITEMS = 200;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const LIVE_CACHE = 'public, max-age=5';
const NO_CACHE = 'no-cache';

// ---------------------------------------------------------------------------
// Lazily-constructed AWS clients (region from the Lambda runtime env)
// ---------------------------------------------------------------------------

let _s3: S3Client | undefined;
let _cf: CloudFrontClient | undefined;
const s3 = (): S3Client => (_s3 ??= new S3Client({}));
const cloudfront = (): CloudFrontClient => (_cf ??= new CloudFrontClient({}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RevisionStatus = 'processing' | 'ready' | 'error';

export interface RevisionEntry {
  rev: number;
  status: RevisionStatus;
  notes: string | null;
  filename: string | null;
  reservedAt: string;
  publishedAt?: string;
  bytes?: number;
  commentCount?: number;
  error?: string;
}

export interface ProjectEntry {
  slug: string;
  title: string | null;
  createdAt: string;
  /** Monotonic; a deleted revision number is burned, never reused. */
  nextRev: number;
  latest: number | null;
  revisions: Record<string, RevisionEntry>;
}

export interface Metadata {
  projects: Record<string, ProjectEntry>;
}

export interface Comment {
  name: string;
  text: string;
  at: string;
}

/** Public, per-project manifest the viewer reads. */
export interface Manifest {
  slug: string;
  title: string | null;
  latest: number | null;
  revisions: Array<{
    rev: number;
    publishedAt: string | null;
    notes: string | null;
    bytes: number | null;
    commentCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Thrown by the validators below for anything the caller can fix. The router
 * answers these with a 400 and the message verbatim; every other failure is a
 * 500 with the detail kept in the log, so an internal misconfiguration is never
 * reported as the caller's mistake.
 */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug);
}

/**
 * Normalize and validate a project slug. Throws a message meant for the caller.
 */
export function normalizeSlug(input: unknown): string {
  const slug = String(input ?? '').trim().toLowerCase();
  if (!slug) throw new BadRequest('project is required');
  if (!SLUG_RE.test(slug)) {
    throw new BadRequest(
      'project must be 1–64 chars of lowercase letters, digits and hyphens ' +
        '(no leading or trailing hyphen)',
    );
  }
  if (isReservedSlug(slug)) throw new BadRequest(`project "${slug}" is reserved`);
  return slug;
}

/** Parse a revision number: a positive integer, however it arrived. */
export function parseRevision(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(String(input ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 1e9) {
    throw new BadRequest('revision must be a positive integer');
  }
  return n;
}

/**
 * Detect a binary glTF container: magic "glTF" plus a little-endian version 2.
 * A `.gltf` JSON file or a zip fails here by design — the viewer loads a single
 * self-contained .glb.
 */
export function looksLikeGlb(head: Uint8Array): boolean {
  if (!head || head.length < 12) return false;
  if (head[0] !== 0x67 || head[1] !== 0x6c || head[2] !== 0x54 || head[3] !== 0x46) {
    return false; // 'glTF'
  }
  const version = head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24);
  return version === 2;
}

/**
 * Collapse anything that would confuse a JSON blob or a text renderer: strip
 * control characters (keeping newline and tab), normalize newlines, trim, cap.
 */
export function sanitizeText(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // Strip control characters other than newline and tab, plus DEL.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, maxLen);
}

/** Optional free-text field: empty string becomes null. */
export function optionalText(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  const text = sanitizeText(value, maxLen);
  return text.length ? text : null;
}

/** Keep only a basename, for display in the admin UI. */
export function sanitizeFilename(name: unknown): string {
  const base = String(name ?? 'model.glb').split(/[\\/]/).pop() ?? 'model.glb';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length ? cleaned.slice(0, 120) : 'model.glb';
}

export function emptyMetadata(): Metadata {
  return { projects: {} };
}

export function newProject(slug: string, now: string): ProjectEntry {
  return { slug, title: null, createdAt: now, nextRev: 1, latest: null, revisions: {} };
}

/** Highest revision that finished processing, or null when none has. */
export function computeLatest(project: ProjectEntry): number | null {
  let latest: number | null = null;
  for (const entry of Object.values(project.revisions)) {
    if (entry.status === 'ready' && (latest === null || entry.rev > latest)) {
      latest = entry.rev;
    }
  }
  return latest;
}

/**
 * Reserve the next revision number for a project, creating the project on first
 * publish. Mutates `meta` in place and returns the reserved revision.
 *
 * Numbers are handed out monotonically from `nextRev` and never reused, even if
 * the revision later fails or is deleted: share links and the immutable model
 * cache both key off the number, so recycling one would resurrect stale content.
 */
export function reserveRevision(
  meta: Metadata,
  slug: string,
  opts: { title?: string | null; notes?: string | null; filename?: string | null; now: string },
): number {
  const project = (meta.projects[slug] ??= newProject(slug, opts.now));
  if (opts.title) project.title = opts.title;
  const rev = project.nextRev;
  project.nextRev = rev + 1;
  project.revisions[String(rev)] = {
    rev,
    status: 'processing',
    notes: opts.notes ?? null,
    filename: opts.filename ?? null,
    reservedAt: opts.now,
  };
  return rev;
}

/** Project the private index down to what the viewer is allowed to see. */
export function buildManifest(project: ProjectEntry): Manifest {
  const revisions = Object.values(project.revisions)
    .filter((r) => r.status === 'ready')
    .sort((a, b) => a.rev - b.rev)
    .map((r) => ({
      rev: r.rev,
      publishedAt: r.publishedAt ?? null,
      notes: r.notes ?? null,
      bytes: r.bytes ?? null,
      commentCount: r.commentCount ?? 0,
    }));
  return {
    slug: project.slug,
    title: project.title,
    latest: computeLatest(project),
    revisions,
  };
}

export function modelKey(slug: string, rev: number): string {
  return `${slug}/${rev}/${MODEL_FILENAME}`;
}
export function uploadKey(slug: string, rev: number): string {
  return `${UPLOAD_PREFIX}${slug}/${rev}/${MODEL_FILENAME}`;
}
export function manifestKey(slug: string): string {
  return `${PROJECTS_PREFIX}${slug}.json`;
}
export function commentsKey(slug: string, rev: number): string {
  return `${COMMENTS_PREFIX}${slug}/${rev}.json`;
}
export function statusKey(slug: string, rev: number): string {
  return `${STATUS_PREFIX}${slug}/${rev}.json`;
}

/** Pull the slug and revision back out of an upload key; null when malformed. */
export function parseUploadKey(key: string): { slug: string; rev: number } | null {
  const decoded = decodeURIComponent(String(key).replace(/\+/g, ' '));
  if (!decoded.startsWith(UPLOAD_PREFIX)) return null;
  const parts = decoded.slice(UPLOAD_PREFIX.length).split('/');
  if (parts.length < 2) return null;
  const [slug, rev] = parts;
  if (!SLUG_RE.test(slug) || isReservedSlug(slug)) return null;
  if (!/^[0-9]+$/.test(rev)) return null;
  const n = Number(rev);
  if (!Number.isInteger(n) || n < 1) return null;
  return { slug, rev: n };
}

/** Validate and clean an incoming comment. Throws a caller-facing message. */
export function validateComment(body: any): { name: string; text: string } {
  const text = sanitizeText(body?.text ?? body?.comment, MAX_COMMENT_TEXT_LEN);
  if (!text) throw new BadRequest('comment text is required');
  const name = sanitizeText(body?.name, MAX_COMMENT_NAME_LEN) || 'Anonymous';
  return { name, text };
}

export function isPreconditionError(err: any): boolean {
  const code = err?.name ?? err?.Code;
  const status = err?.$metadata?.httpStatusCode;
  return (
    code === 'PreconditionFailed' ||
    code === 'ConditionalRequestConflict' ||
    status === 412 ||
    status === 409
  );
}

export function isNotFoundError(err: any): boolean {
  const code = err?.name ?? err?.Code;
  return (
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'AccessDenied' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

// ---------------------------------------------------------------------------
// Env / S3 plumbing
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function allowlist(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function siteUrl(): string {
  return (process.env.SITE_URL ?? '').replace(/\/+$/, '');
}

export function shareUrl(slug: string, rev: number): string {
  return `${siteUrl()}/${slug}/${rev}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJsonWithEtag<T>(
  bucket: string,
  key: string,
): Promise<{ value: T | null; etag: string | null }> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return {
      value: JSON.parse(Buffer.from(bytes).toString('utf-8')) as T,
      etag: res.ETag ?? null,
    };
  } catch (err: any) {
    if (isNotFoundError(err)) return { value: null, etag: null };
    throw err;
  }
}

async function readJson<T>(bucket: string, key: string): Promise<T | null> {
  return (await readJsonWithEtag<T>(bucket, key)).value;
}

async function writeJson(
  bucket: string,
  key: string,
  obj: unknown,
  cacheControl: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(obj),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: cacheControl,
    }),
  );
}

/**
 * Atomically read-modify-write a JSON object using S3 conditional writes
 * (optimistic concurrency): the write is guarded by `IfMatch` on the ETag that
 * was read, or `IfNoneMatch: *` when creating, and the whole cycle retries when
 * a concurrent writer wins the race.
 *
 * Used for metadata.json and for comment threads, both of which take concurrent
 * writers (a publish while a reviewer comments, two reviewers at once).
 */
async function mutateJson<T>(
  bucket: string,
  key: string,
  cacheControl: string,
  initial: () => T,
  mutate: (current: T) => T | void,
): Promise<T> {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { value, etag } = await readJsonWithEtag<T>(bucket, key);
    const current = value ?? initial();
    const next = (mutate(current) ?? current) as T;
    try {
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(next),
          ContentType: 'application/json; charset=utf-8',
          CacheControl: cacheControl,
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      );
      return next;
    } catch (err) {
      if (isPreconditionError(err) && attempt < maxAttempts - 1) {
        await sleep(50 * 2 ** attempt + Math.floor(Math.random() * 50));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not update object after repeated conflicts.');
}

const mutateMetadata = (mutate: (meta: Metadata) => Metadata | void): Promise<Metadata> =>
  mutateJson<Metadata>(
    env('METADATA_BUCKET'),
    env('METADATA_KEY'),
    NO_CACHE,
    emptyMetadata,
    (meta) => {
      // Tolerate a pre-existing file written before `projects` existed.
      meta.projects ??= {};
      return mutate(meta) ?? undefined;
    },
  );

async function readMetadata(): Promise<Metadata> {
  const meta = await readJson<Metadata>(env('METADATA_BUCKET'), env('METADATA_KEY'));
  if (!meta) return emptyMetadata();
  meta.projects ??= {};
  return meta;
}

/** Regenerate the public manifest from the private index. */
async function writeManifest(project: ProjectEntry): Promise<void> {
  await writeJson(
    env('ASSETS_BUCKET'),
    manifestKey(project.slug),
    buildManifest(project),
    LIVE_CACHE,
  );
}

async function deleteByPrefix(bucket: string, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const listed = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) {
      await s3().send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
      );
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
}

async function deleteQuietly(bucket: string, key: string): Promise<void> {
  await s3()
    .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    .catch(() => undefined);
}

/**
 * Drop edge caches for a project. Only needed on delete: revision content is
 * immutable and every other object has a 5–60s TTL.
 */
async function invalidateProject(slug: string): Promise<void> {
  const distId = process.env.DISTRIBUTION_ID;
  if (!distId) return;
  const paths = [`/${slug}/*`, `/${manifestKey(slug)}`];
  await cloudfront()
    .send(
      new CreateInvalidationCommand({
        DistributionId: distId,
        InvalidationBatch: {
          CallerReference: `del-${slug}-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    )
    .catch((e) => console.error('CloudFront invalidation failed', e));
}

// ---------------------------------------------------------------------------
// Processor (S3 event)
// ---------------------------------------------------------------------------

/** First 12 bytes of an object — enough for the GLB header. */
async function readHeader(bucket: string, key: string): Promise<Uint8Array> {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-11' }),
  );
  return res.Body!.transformToByteArray();
}

async function handleS3Event(event: any): Promise<void> {
  const staging = env('STAGING_BUCKET');
  const assets = env('ASSETS_BUCKET');

  for (const record of event.Records ?? []) {
    const rawKey: string = record?.s3?.object?.key ?? '';
    const parsed = parseUploadKey(rawKey);
    if (!parsed) {
      console.error('Ignoring upload with an unrecognized key', rawKey);
      continue;
    }
    const { slug, rev } = parsed;
    const decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));

    try {
      // Reject an oversized object from the event metadata, before touching it.
      const bytes: number = record.s3.object.size ?? 0;
      if (bytes > MAX_MODEL_BYTES) {
        throw new Error(
          `Model is too large (${Math.round(bytes / 1048576)} MB); the limit is ` +
            `${MAX_MODEL_BYTES / 1048576} MB.`,
        );
      }
      if (bytes === 0) throw new Error('Uploaded file is empty.');

      const header = await readHeader(staging, decodedKey);
      if (!looksLikeGlb(header)) {
        throw new Error(
          'Not a binary glTF file. Export a .glb (glTF 2.0 binary) — .gltf, .stl ' +
            'and .step files are not supported.',
        );
      }

      // Copy rather than round-trip the bytes through this function.
      await s3().send(
        new CopyObjectCommand({
          Bucket: assets,
          Key: modelKey(slug, rev),
          CopySource: encodeURI(`${staging}/${decodedKey}`),
          ContentType: 'model/gltf-binary',
          CacheControl: IMMUTABLE_CACHE,
          MetadataDirective: 'REPLACE',
        }),
      );

      // Flip the revision to ready and recompute the project's latest pointer.
      let project: ProjectEntry | undefined;
      await mutateMetadata((meta) => {
        const proj = meta.projects[slug];
        if (!proj) throw new Error(`Unknown project "${slug}" — publish was not reserved.`);
        const entry = proj.revisions[String(rev)];
        if (!entry) throw new Error(`Revision ${rev} of "${slug}" was not reserved.`);
        entry.status = 'ready';
        entry.publishedAt = new Date().toISOString();
        entry.bytes = bytes;
        entry.commentCount ??= 0;
        proj.latest = computeLatest(proj);
        project = proj;
      });

      // The viewer needs the manifest before the URL is usable, so publish it
      // before the status flips to ready.
      if (project) await writeManifest(project);

      // Pre-create the thread so the viewer's fetch is a cache hit, not a 404.
      const existing = await readJson<{ comments: Comment[] }>(
        assets,
        commentsKey(slug, rev),
      );
      if (!existing) {
        await writeJson(assets, commentsKey(slug, rev), { comments: [] }, LIVE_CACHE);
      }

      await writeJson(
        assets,
        statusKey(slug, rev),
        { status: 'ready', project: slug, revision: rev, url: shareUrl(slug, rev) },
        NO_CACHE,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Publish processing failed', slug, rev, message);
      await mutateMetadata((meta) => {
        const entry = meta.projects[slug]?.revisions[String(rev)];
        if (entry) {
          entry.status = 'error';
          entry.error = message;
        }
      }).catch((e) => console.error('Could not record the failure in metadata', e));
      await writeJson(
        assets,
        statusKey(slug, rev),
        { status: 'error', project: slug, revision: rev, error: message },
        NO_CACHE,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Router (HTTP API)
// ---------------------------------------------------------------------------

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(event: any): any {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function callerEmail(event: any): string {
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  return String(claims.email ?? '').trim().toLowerCase();
}

export function actionFromPath(event: any): string {
  const path: string = event?.requestContext?.http?.path ?? event?.rawPath ?? '';
  const seg = path.split('/').filter(Boolean).pop() ?? '';
  return seg.toLowerCase();
}

/**
 * Reserve a revision and hand back a presigned PUT plus the final share URL.
 *
 * Authorized by API Gateway's IAM authorizer: the caller signs with AWS
 * credentials, which is what lets a scripted workflow publish without an OAuth
 * dance. The URL is returned before the upload happens, so the caller can print
 * it immediately and poll `status/<slug>/<rev>.json` for readiness.
 *
 * ContentType is deliberately left out of the signed request so a plain
 * `curl -T` (which sends application/octet-stream) still matches the signature;
 * the processor sets the real Content-Type when it copies the object.
 */
async function actionPublish(event: any) {
  // Validate before reading any configuration, so a bad request is answered as
  // a bad request rather than as whatever the environment happens to be missing.
  const body = parseBody(event);
  const slug = normalizeSlug(body.project ?? body.slug);
  const title = optionalText(body.title, MAX_TITLE_LEN);
  const notes = optionalText(body.notes ?? body.revisionNotes, MAX_NOTES_LEN);
  const filename = sanitizeFilename(body.filename);
  const now = new Date().toISOString();

  const staging = env('STAGING_BUCKET');
  const assets = env('ASSETS_BUCKET');

  let rev = 0;
  await mutateMetadata((meta) => {
    rev = reserveRevision(meta, slug, { title, notes, filename, now });
  });

  await writeJson(
    assets,
    statusKey(slug, rev),
    { status: 'processing', project: slug, revision: rev },
    NO_CACHE,
  );

  const key = uploadKey(slug, rev);
  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: staging, Key: key }),
    { expiresIn: 900 },
  );

  return json(200, {
    project: slug,
    revision: rev,
    url: shareUrl(slug, rev),
    statusUrl: `${siteUrl()}/${statusKey(slug, rev)}`,
    uploadUrl,
    key,
    expiresIn: 900,
  });
}

/** Public comment submission. */
async function actionComment(event: any) {
  const body = parseBody(event);
  const slug = normalizeSlug(body.project ?? body.slug);
  const rev = parseRevision(body.revision ?? body.rev);
  const { name, text } = validateComment(body);

  const assets = env('ASSETS_BUCKET');

  // Only a published revision accepts feedback — this also stops the endpoint
  // from being used to create arbitrary objects.
  const meta = await readMetadata();
  const entry = meta.projects[slug]?.revisions[String(rev)];
  if (!entry || entry.status !== 'ready') {
    return json(404, { error: 'No such revision' });
  }

  let full = false;
  const thread = await mutateJson<{ comments: Comment[] }>(
    assets,
    commentsKey(slug, rev),
    LIVE_CACHE,
    () => ({ comments: [] }),
    (current) => {
      current.comments ??= [];
      if (current.comments.length >= MAX_COMMENTS_PER_REVISION) {
        full = true;
        return;
      }
      current.comments.push({ name, text, at: new Date().toISOString() });
    },
  );

  if (full) {
    return json(409, {
      error: `This revision already has the maximum of ${MAX_COMMENTS_PER_REVISION} comments.`,
    });
  }

  // Keep the count in the index (the admin roll-up reads it to know which
  // threads to fetch) and in the manifest (the viewer shows it in the nav).
  let project: ProjectEntry | undefined;
  await mutateMetadata((m) => {
    const e = m.projects[slug]?.revisions[String(rev)];
    if (e) e.commentCount = thread.comments.length;
    project = m.projects[slug];
  }).catch((e) => console.error('Could not update the comment count', e));
  if (project) {
    await writeManifest(project).catch((e) =>
      console.error('Could not refresh the manifest', e),
    );
  }

  // Return the thread so the poster sees their comment without waiting on the
  // CDN copy to expire.
  return json(200, { comments: thread.comments });
}

async function actionList() {
  const meta = await readMetadata();
  const projects = Object.values(meta.projects)
    .map((p) => ({
      slug: p.slug,
      title: p.title,
      createdAt: p.createdAt,
      latest: computeLatest(p),
      revisions: Object.values(p.revisions).sort((a, b) => b.rev - a.rev),
    }))
    .sort((a, b) => {
      const aAt = a.revisions[0]?.publishedAt ?? a.createdAt;
      const bAt = b.revisions[0]?.publishedAt ?? b.createdAt;
      return bAt.localeCompare(aAt);
    });
  return json(200, { projects, siteUrl: siteUrl() });
}

async function actionEdit(event: any) {
  const body = parseBody(event);
  const slug = normalizeSlug(body.project ?? body.slug);
  const hasRevision = body.revision !== undefined && body.revision !== null;
  const rev = hasRevision ? parseRevision(body.revision) : null;

  let notFound = false;
  let project: ProjectEntry | undefined;
  await mutateMetadata((meta) => {
    const proj = meta.projects[slug];
    if (!proj) {
      notFound = true;
      return;
    }
    if ('title' in body) proj.title = optionalText(body.title, MAX_TITLE_LEN);
    if (rev !== null) {
      const entry = proj.revisions[String(rev)];
      if (!entry) {
        notFound = true;
        return;
      }
      if ('notes' in body) entry.notes = optionalText(body.notes, MAX_NOTES_LEN);
    }
    project = proj;
  });

  if (notFound || !project) return json(404, { error: 'No such project or revision' });
  await writeManifest(project);
  return json(200, { project: buildManifest(project) });
}

/**
 * Delete a single revision, or the whole project when `revision` is omitted.
 *
 * A deleted revision number is not returned to the pool: `nextRev` only ever
 * moves forward, so a future publish can never land on a path that a browser or
 * the CDN still has cached under the old immutable Cache-Control.
 */
async function actionDelete(event: any) {
  const assets = env('ASSETS_BUCKET');
  const body = parseBody(event);
  const slug = normalizeSlug(body.project ?? body.slug);
  const hasRevision = body.revision !== undefined && body.revision !== null;
  const rev = hasRevision ? parseRevision(body.revision) : null;

  const meta = await readMetadata();
  const project = meta.projects[slug];
  if (!project) return json(404, { error: 'No such project' });
  if (rev !== null && !project.revisions[String(rev)]) {
    return json(404, { error: 'No such revision' });
  }

  if (rev === null) {
    await deleteByPrefix(assets, `${slug}/`);
    await deleteByPrefix(assets, `${COMMENTS_PREFIX}${slug}/`);
    await deleteByPrefix(assets, `${STATUS_PREFIX}${slug}/`);
    await deleteQuietly(assets, manifestKey(slug));
    await mutateMetadata((m) => {
      delete m.projects[slug];
    });
    await invalidateProject(slug);
    return json(200, { deleted: { project: slug } });
  }

  await deleteByPrefix(assets, `${slug}/${rev}/`);
  await deleteQuietly(assets, commentsKey(slug, rev));
  await deleteQuietly(assets, statusKey(slug, rev));

  let updated: ProjectEntry | undefined;
  await mutateMetadata((m) => {
    const proj = m.projects[slug];
    if (!proj) return;
    delete proj.revisions[String(rev)];
    proj.latest = computeLatest(proj);
    updated = proj;
  });
  if (updated) await writeManifest(updated);
  await invalidateProject(slug);
  return json(200, { deleted: { project: slug, revision: rev } });
}

/** Admin roll-up: recent comments across every project. */
async function actionFeedback() {
  const assets = env('ASSETS_BUCKET');
  const meta = await readMetadata();

  const targets: Array<{ slug: string; rev: number; title: string | null }> = [];
  for (const project of Object.values(meta.projects)) {
    for (const entry of Object.values(project.revisions)) {
      if ((entry.commentCount ?? 0) > 0) {
        targets.push({ slug: project.slug, rev: entry.rev, title: project.title });
      }
    }
  }

  const items: Array<Comment & { project: string; title: string | null; revision: number; url: string }> = [];
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const t = targets[i];
      const thread = await readJson<{ comments: Comment[] }>(
        assets,
        commentsKey(t.slug, t.rev),
      ).catch(() => null);
      for (const c of thread?.comments ?? []) {
        items.push({
          ...c,
          project: t.slug,
          title: t.title,
          revision: t.rev,
          url: shareUrl(t.slug, t.rev),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker),
  );

  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return json(200, { items: items.slice(0, MAX_FEEDBACK_ITEMS) });
}

const ADMIN_ACTIONS = new Set(['list', 'edit', 'delete', 'feedback']);

async function handleHttp(event: any) {
  const action = actionFromPath(event);

  // Admin actions re-check the Cognito email against the allowlist behind the
  // JWT authorizer. `publish` is authorized by SigV4 and `comment` is public,
  // so neither carries an email to check.
  if (ADMIN_ACTIONS.has(action) && !allowlist().includes(callerEmail(event))) {
    return json(403, { error: 'Not authorized' });
  }

  try {
    switch (action) {
      case 'publish':
        return await actionPublish(event);
      case 'comment':
        return await actionComment(event);
      case 'list':
        return await actionList();
      case 'edit':
        return await actionEdit(event);
      case 'delete':
        return await actionDelete(event);
      case 'feedback':
        return await actionFeedback();
      default:
        return json(404, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    if (err instanceof BadRequest) {
      console.warn('Rejected request', action, err.message);
      return json(400, { error: err.message });
    }
    // Anything else is ours, not the caller's: log the detail, return a generic
    // message so an internal failure never leaks configuration into a response.
    console.error('Action failed', action, err);
    return json(500, { error: 'Something went wrong handling that request.' });
  }
}

// ---------------------------------------------------------------------------
// Entry point — dispatch by event shape
// ---------------------------------------------------------------------------

export const handler = async (event: any): Promise<any> => {
  if (event && Array.isArray(event.Records) && event.Records[0]?.s3) {
    await handleS3Event(event);
    return;
  }
  return handleHttp(event);
};
