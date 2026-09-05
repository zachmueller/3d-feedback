/**
 * The publish protocol, in this process: reserve → upload → wait → verify.
 *
 * This used to shell out to tools/publish.sh, which needed bash, the AWS CLI, jq
 * and a curl new enough for --aws-sigv4. Four binaries had to be present for the
 * last step of an export to work, and when one wasn't, the failure arrived as
 * scraped stderr with the share URL recovered from stdout by regex. The script is
 * now a wrapper around this file (see cli.ts), so there is still one implementation
 * — it just lives where the errors are objects.
 *
 * What the protocol needs a client to know, none of which is guessable:
 *
 *  - `POST /publish` reserves a revision number *before* the upload, and numbers
 *    are never reused. A client that retries blindly spends them. So every publish
 *    declares a sha256 of its bytes: if it matches the latest revision the API
 *    hands that one back instead of reserving anything (`deduped`), and a publish
 *    that died after reserving can be finished with `revision: N` (`resumed`)
 *    rather than leaving a gap.
 *  - The share URL is known before the model exists, so it is returned early and
 *    readiness is polled from `status/<slug>/<rev>.json`.
 *  - A `ready` status means the processor copied the model, not that a reviewer
 *    can load it; verification (site.ts) is what answers that.
 *  - A revision can record where it was built from, and that provenance travels
 *    *inside* the .glb (`asset.extras.source`) rather than as an argument, so it is
 *    lifted out of the same buffer that gets hashed. That is not a stylistic
 *    choice: it makes the record a function of the bytes, which is what stops the
 *    content-hash dedupe from collapsing two builds of the same geometry from
 *    different commits into one revision. See resolveSource.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Text caps and sanitising come from the Lambda that will receive this request, so
// a bad argument is rejected here with the message the API would have used.
import {
  BadRequest,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
  normalizeSource,
  optionalText,
  type SourceProvenance,
} from '../../lib/lambda/handler';

import { signHeaders } from './aws';
import { type Config, PathError, resolveProject, resolveUserPath } from './config';
import { parseGlbContainer, readSourceFromGlb } from './glb';
import { errorDetail, type FetchLike, type HttpResult, nodeFetch, parseJson, request } from './http';
import { siteReader, type StatusObject, verifyRevision, type VerifyReport } from './site';

// --- shape -------------------------------------------------------------------

export type PublishStage = 'reserve' | 'upload' | 'process' | 'verify';

export interface PublishRequest {
  glb: string;
  project?: string;
  title?: string;
  notes?: string;
  timeoutSeconds?: number;
  /** Finish a revision that was already reserved, instead of taking a new number. */
  revision?: number;
  /** Publish even if these exact bytes are already the latest revision. */
  force?: boolean;
  /** Overrides the configured verifyAfterPublish. */
  verify?: boolean;
  /**
   * Where the model was built from. Normally omitted: it is read out of the .glb's
   * own `asset.extras.source`, which is the whole point of putting it there. Passing
   * it overrides the file — see the caveat in publishModel.
   */
  source?: SourceProvenance | Record<string, unknown>;
}

export interface PublishResult {
  project: string;
  /** null only for a dry run, which reserves nothing. */
  revision: number | null;
  url: string;
  bytes: number;
  contentHash: string;
  /** The provenance that was recorded, from the file or from the override. */
  source: SourceProvenance | null;
  /** The API recognised these bytes: no revision was spent and nothing uploaded. */
  deduped: boolean;
  /** This call finished an already-reserved revision. */
  resumed: boolean;
  dryRun: boolean;
  /** What each stage did, retries included. */
  log: string[];
  verification: VerifyReport | null;
  /** For a dry run: the request that would have been signed and sent. */
  plannedRequest?: { url: string; body: Record<string, unknown> };
}

/**
 * A publish that failed, and what can be done about it.
 *
 * `reservedRevision` is the part that matters: once a number is reserved it is
 * spent whatever happens next, so the difference between "retry this revision"
 * and "publish again" is the difference between a gap in the numbering and none.
 */
export class PublishError extends Error {
  readonly stage: PublishStage;
  readonly status: number | null;
  readonly project: string;
  readonly reservedRevision: number | null;

  constructor(opts: {
    stage: PublishStage;
    detail: string;
    project: string;
    glb: string;
    status?: number | null;
    reservedRevision?: number | null;
    /** How to say "retry this revision" in the caller's own interface. */
    hint?: string[];
  }) {
    const lines = [`Publishing failed at the ${opts.stage} stage: ${opts.detail}`];
    if (opts.reservedRevision !== null && opts.reservedRevision !== undefined) {
      lines.push(
        '',
        `Revision ${opts.reservedRevision} of "${opts.project}" is reserved but unfinished. ` +
          'Retry it without spending another number:',
        ...(opts.hint ?? []),
      );
    }
    super(lines.join('\n'));
    this.name = 'PublishError';
    this.stage = opts.stage;
    this.status = opts.status ?? null;
    this.project = opts.project;
    this.reservedRevision = opts.reservedRevision ?? null;
  }
}

/** Injected so the retry, polling and recovery rules are testable offline. */
export interface PublishDeps {
  fetch: FetchLike;
  sign: typeof signHeaders;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /**
   * How to phrase "retry this revision" for whoever is reading the error. The MCP
   * server's caller makes tool calls; the CLI's runs a shell command. Advice in the
   * wrong dialect is advice that gets ignored, and ignoring it costs a revision.
   */
  resumeHint: (opts: { glb: string; project: string; revision: number }) => string[];
}

const defaultDeps: PublishDeps = {
  fetch: nodeFetch,
  sign: signHeaders,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  resumeHint: ({ glb, project, revision }) => [
    `  publish_model({ glb: "${glb}", project: "${project}", revision: ${revision} })`,
    `Or check on it first: get_publish_status({ project: "${project}", revision: ${revision} })`,
  ],
};

/** How often the status object is polled. The API writes it before responding. */
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 3;

// --- pure rules --------------------------------------------------------------

/**
 * Whether a failed request is worth repeating. `status: 0` is "no response at
 * all" from http.ts — a timeout, a reset, a DNS failure — which is the most
 * retryable thing there is. A 4xx other than 429 is the caller's fault and will
 * fail again identically; retrying it only delays the message.
 */
export function shouldRetry(status: number, attempt: number, maxAttempts = MAX_ATTEMPTS): boolean {
  if (attempt >= maxAttempts) return false;
  return status === 0 || status === 429 || status >= 500;
}

/** 250ms, 500ms, 1s… capped, deterministic — one publish is not a thundering herd. */
export const backoffMs = (attempt: number): number => Math.min(4000, 250 * 2 ** (attempt - 1));

/**
 * A presigned PUT that outlived its 15 minutes. Recoverable without spending a
 * revision: ask for a fresh URL for the same reserved number. Worth detecting
 * separately because S3 reports it as a plain 403, which otherwise reads as a
 * permissions problem.
 */
export function isExpiredUpload(result: HttpResult): boolean {
  return result.status === 403 && /expired/i.test(result.body);
}

/** The body of POST /publish. */
export function publishBody(
  req: PublishRequest,
  project: string,
  filename: string,
  contentHash: string,
  source: SourceProvenance | null = null,
): Record<string, unknown> {
  const title = optionalText(req.title, MAX_TITLE_LEN);
  const notes = optionalText(req.notes, MAX_NOTES_LEN);
  return {
    project,
    filename,
    contentHash,
    ...(title ? { title } : {}),
    ...(notes ? { notes } : {}),
    ...(source ? { source } : {}),
    ...(req.force ? { force: true } : {}),
    ...(req.revision === undefined ? {} : { revision: req.revision }),
  };
}

/**
 * Which provenance to declare: the caller's override, else the file's own extras.
 *
 * The override exists for the cases the file cannot cover — a FreeCAD export, whose
 * writer is FreeCAD's and carries no extras of ours, or a correction. It comes with
 * one wrinkle worth saying out loud rather than discovering: the API dedupes on the
 * content hash alone, so republishing *identical bytes* with a different declared
 * source returns the revision that already holds them and the override is dropped,
 * exactly as a new title or new notes would be. Provenance read from inside the file
 * never hits that, because different provenance is different bytes.
 */
export function resolveSource(
  req: PublishRequest,
  fromFile: SourceProvenance | null,
  log: string[],
): SourceProvenance | null {
  const override = normalizeSource(req.source);
  if (!override) return fromFile;

  if (fromFile && JSON.stringify(fromFile) !== JSON.stringify(override)) {
    log.push(
      'the source argument overrides the provenance inside the .glb; note that republishing ' +
        'these exact bytes later would dedupe and drop the override, because the API compares ' +
        'content hashes',
    );
  } else if (!fromFile) {
    log.push('recording the source given as an argument; the .glb itself carries none');
  }
  return override;
}

/** What POST /publish answers with. */
interface ReserveResponse {
  project: string;
  revision: number;
  url: string;
  statusUrl?: string;
  uploadUrl?: string;
  key?: string;
  deduped?: boolean;
  resumed?: boolean;
  message?: string;
}

// --- stages ------------------------------------------------------------------

async function reserve(
  cfg: Config,
  deps: PublishDeps,
  req: PublishRequest,
  body: Record<string, unknown>,
  log: string[],
): Promise<ReserveResponse> {
  const url = `${cfg.apiUrl}/publish`;
  const payload = JSON.stringify(body);
  const timeoutMs = Math.round(cfg.httpTimeoutSeconds * 1000);
  const project = String(body.project);

  for (let attempt = 1; ; attempt++) {
    const headers = await deps.sign({
      method: 'POST',
      url,
      body: payload,
      region: cfg.awsRegion,
      profile: cfg.awsProfile,
      headers: { 'content-type': 'application/json' },
    });
    const result = await request(deps.fetch, url, { method: 'POST', headers, body: payload }, timeoutMs);

    if (result.status === 200) {
      const parsed = parseJson<ReserveResponse>(result.body);
      if (!parsed || typeof parsed.revision !== 'number') {
        throw new PublishError({
          stage: 'reserve',
          detail: `the API answered 200 with something that is not a publish response: ${result.body.slice(0, 300)}`,
          project,
          glb: req.glb,
        });
      }
      return parsed;
    }

    if (shouldRetry(result.status, attempt)) {
      const wait = backoffMs(attempt);
      log.push(
        `reserve attempt ${attempt} failed (${describe(result)}); retrying in ${wait}ms`,
      );
      await deps.sleep(wait);
      continue;
    }

    throw new PublishError({
      stage: 'reserve',
      status: result.status || null,
      detail:
        result.status === 403
          ? `${describe(result)} — the IAM authorizer rejected the signature. Run check_setup: ` +
            'live credentials for the wrong account look exactly like this.'
          : describe(result),
      project,
      glb: req.glb,
    });
  }
}

async function upload(
  cfg: Config,
  deps: PublishDeps,
  bytes: Buffer,
  uploadUrl: string,
  log: string[],
  refresh: () => Promise<string>,
): Promise<void> {
  // Long enough for the bytes themselves: a 100 MB model on a slow uplink would
  // blow the per-request timeout that the JSON calls use.
  const timeoutMs = Math.max(Math.round(cfg.publishTimeoutSeconds * 1000), 60_000);
  let url = uploadUrl;
  let refreshed = false;

  for (let attempt = 1; ; attempt++) {
    const result = await request(
      deps.fetch,
      url,
      { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } },
      timeoutMs,
    );
    if (result.status === 200) return;

    // An expired URL is not a retry of the same request; it needs a new one.
    if (isExpiredUpload(result) && !refreshed) {
      log.push('the presigned upload URL had expired; asking for a fresh one');
      url = await refresh();
      refreshed = true;
      continue;
    }

    if (shouldRetry(result.status, attempt)) {
      const wait = backoffMs(attempt);
      log.push(`upload attempt ${attempt} failed (${describe(result)}); retrying in ${wait}ms`);
      await deps.sleep(wait);
      continue;
    }
    throw new UploadFailed(describe(result), result.status || null);
  }
}

/** Internal: carries the reason up to where the reserved revision is known. */
class UploadFailed extends Error {
  constructor(
    readonly detail: string,
    readonly status: number | null,
  ) {
    super(detail);
  }
}

/**
 * Wait for the processor.
 *
 * Anything other than a readable, parseable status object is treated as "not yet"
 * until the deadline: the object is written before POST /publish answers, but it is
 * read back through a CDN with a 5-second TTL, so a moment of 404 or a stale body
 * proves nothing. Only an explicit `error` status ends the wait early.
 */
async function waitForProcessing(
  deps: PublishDeps,
  statusUrl: string,
  timeoutSeconds: number,
  httpTimeoutMs: number,
  log: string[],
): Promise<StatusObject> {
  const deadline = deps.now() + timeoutSeconds * 1000;
  let polls = 0;
  let lastProblem = 'it never reported a status';

  for (;;) {
    await deps.sleep(POLL_INTERVAL_MS);
    polls++;
    const result = await request(
      deps.fetch,
      statusUrl,
      { method: 'GET', headers: { 'cache-control': 'no-cache' } },
      httpTimeoutMs,
    );
    const status = result.status === 200 ? parseJson<StatusObject>(result.body) : null;

    if (status?.status === 'ready') {
      log.push(`processed after ${polls} poll${polls === 1 ? '' : 's'}`);
      return status;
    }
    if (status?.status === 'error') {
      throw new ProcessingFailed(status.error ?? 'the processor did not say why');
    }
    if (!status) lastProblem = `the status object was not readable (${describe(result)})`;
    else lastProblem = `it was still ${status.status}`;

    if (deps.now() >= deadline) {
      throw new ProcessingFailed(
        `gave up after ${timeoutSeconds}s — ${lastProblem}. The upload succeeded, so this is a ` +
          'wait that ran out, not necessarily a failed publish.',
      );
    }
  }
}

/** Internal, like UploadFailed: the reason, carried up to the reserved revision. */
class ProcessingFailed extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

const describe = (result: HttpResult): string =>
  result.networkError ? result.networkError : `HTTP ${result.status}: ${errorDetail(result)}`;

// --- the whole path ----------------------------------------------------------

export async function publishModel(
  cfg: Config,
  req: PublishRequest,
  overrides: Partial<PublishDeps> = {},
): Promise<PublishResult> {
  const deps = { ...defaultDeps, ...overrides };
  const log: string[] = [];

  const glb = resolveUserPath(req.glb, cfg, { extensions: ['.glb'], label: 'glb' });
  if (!fs.existsSync(glb)) throw new PathError(`No such file: ${glb}`);
  const project = resolveProject(cfg, req.project);

  if (!cfg.apiUrl) {
    throw new BadRequest(
      'No API URL. Deploy with `--outputs-file cdk-outputs.json`, or set THREED_API_URL ' +
        '(the deployed value is the ApiUrl stack output).',
    );
  }

  // Read once and hash what will actually be uploaded — a second read could hash
  // a file that changed in between, and the hash is what makes a retry safe.
  const bytes = fs.readFileSync(glb);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const filename = path.basename(glb);

  // Provenance comes out of the same buffer that was just hashed, so what is
  // declared and what is uploaded are the same bytes by construction. Done here
  // rather than in the MCP server's inspection step because cli.ts inspects nothing.
  //
  // A container that will not parse is *not* an error here: validating the file is
  // inspect_glb's job on this side and the processor's on the other, and failing a
  // publish in this function over it would move that check somewhere it does not
  // belong — and would refuse files this client has always been willing to send.
  // An unreadable container simply carries no provenance.
  const fromFile = readSourceFromGlb(tryParseGlb(bytes));
  if (fromFile.error) {
    // Refusing costs nothing; publishing anyway spends a revision number that can
    // never be reused on a model whose provenance was silently thrown away.
    throw new BadRequest(
      `Refusing to publish: ${fromFile.error} Fix the exporter, or pass source explicitly to ` +
        'override what the file says.',
    );
  }
  for (const warning of fromFile.warnings) log.push(warning);
  const source = resolveSource(req, fromFile.source, log);

  const body = publishBody(req, project, filename, contentHash, source);

  if (cfg.dryRun) {
    return {
      project,
      revision: null,
      url: '',
      bytes: bytes.length,
      contentHash,
      source,
      deduped: false,
      resumed: false,
      dryRun: true,
      log: [...log, 'dry run: nothing was reserved, uploaded or published'],
      verification: null,
      plannedRequest: { url: `${cfg.apiUrl}/publish`, body },
    };
  }

  const reserved = await reserve(cfg, deps, req, body, log);

  // A deployment that predates resume support ignores `revision` and reserves a
  // new number instead. Say so, rather than let the caller believe a gap was avoided.
  if (req.revision !== undefined && reserved.revision !== req.revision) {
    throw new PublishError({
      stage: 'reserve',
      detail:
        `asked to finish revision ${req.revision} but the API reserved ${reserved.revision} instead. ` +
        'The deployment predates resume support — deploy the current handler ' +
        '(`npx cdk deploy --outputs-file cdk-outputs.json`).',
      project,
      glb,
      reservedRevision: reserved.revision,
    });
  }

  const deduped = reserved.deduped === true || !reserved.uploadUrl;
  const resumed = reserved.resumed === true;
  const revision = reserved.revision;
  const statusUrl = reserved.statusUrl ?? `${cfg.siteUrl ?? ''}/status/${project}/${revision}.json`;

  if (deduped) {
    // What the client did, not what the API said — the caller-facing wording of
    // "nothing was published" belongs to the summary, and saying it twice reads
    // like two different things happened.
    log.push('the API recognised the content hash: nothing uploaded, no number reserved');
  } else {
    if (resumed) log.push(`finishing already-reserved revision ${revision}`);
    try {
      await upload(cfg, deps, bytes, reserved.uploadUrl!, log, async () => {
        const again = await reserve(cfg, deps, req, { ...body, revision }, log);
        if (!again.uploadUrl) {
          throw new Error('the API did not return a new upload URL');
        }
        return again.uploadUrl;
      });
    } catch (err) {
      throw new PublishError({
        stage: 'upload',
        detail: err instanceof UploadFailed ? err.detail : err instanceof Error ? err.message : String(err),
        status: err instanceof UploadFailed ? err.status : null,
        project,
        glb,
        reservedRevision: revision,
        hint: deps.resumeHint({ glb, project, revision }),
      });
    }

    try {
      await waitForProcessing(
        deps,
        statusUrl,
        Math.round(req.timeoutSeconds ?? cfg.publishTimeoutSeconds),
        Math.round(cfg.httpTimeoutSeconds * 1000),
        log,
      );
    } catch (err) {
      throw new PublishError({
        stage: 'process',
        detail: err instanceof ProcessingFailed ? err.detail : err instanceof Error ? err.message : String(err),
        project,
        glb,
        reservedRevision: revision,
        hint: deps.resumeHint({ glb, project, revision }),
      });
    }
  }

  // Verification is a report, not a gate: the revision exists either way, and a
  // publish that is reported as failed because a CDN check flaked would send the
  // caller looking in the wrong place.
  let verification: VerifyReport | null = null;
  if (req.verify ?? cfg.verifyAfterPublish) {
    try {
      const reader = siteReader(cfg, deps.fetch, siteUrlFrom(cfg, reserved.url));
      // The size is checkable even for a dedupe: matching hashes mean the revision
      // already there holds exactly these bytes.
      verification = await verifyRevision(reader, project, revision, bytes.length);
      if (!verification.ok) {
        log.push('published, but verification found a problem — see the checks');
      }
    } catch (err) {
      log.push(`could not verify the published revision: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    project,
    revision,
    url: reserved.url,
    bytes: bytes.length,
    contentHash,
    // On a dedupe this is what was *offered*, not necessarily what the revision
    // records — the API applies neither notes nor source to bytes it already has.
    source,
    deduped,
    resumed,
    dryRun: false,
    log,
    verification,
  };
}

/** The glTF JSON, or an empty object when the container cannot be read at all. */
function tryParseGlb(bytes: Buffer): unknown {
  try {
    return parseGlbContainer(bytes).json;
  } catch {
    return {};
  }
}

/** The configured site URL, else the origin of the share URL the API returned. */
function siteUrlFrom(cfg: Config, shareUrl: string): string | null {
  if (cfg.siteUrl) return cfg.siteUrl;
  try {
    return new URL(shareUrl).origin;
  } catch {
    return null;
  }
}
