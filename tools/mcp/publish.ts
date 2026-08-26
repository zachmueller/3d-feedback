/**
 * Publish a .glb by shelling out to tools/publish.sh.
 *
 * Not reimplemented here on purpose. That script already reserves the revision
 * with a SigV4-signed `POST /publish`, resolves credentials through
 * `aws configure export-credentials` (so SSO and assumed roles work), uploads to
 * the presigned PUT, polls `status/<project>/<rev>.json`, and prints the share URL
 * as the only thing on stdout — it was written as an automation entry point, and
 * a second implementation would be a second thing to keep correct.
 *
 * Everything it needs is passed explicitly (`--profile`, `--region`, `--api-url`,
 * `--site-url`, `--timeout`) rather than inherited from the environment, because
 * an MCP server is spawned by a harness whose environment nobody is looking at.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

// Slug rules, text sanitising and field caps come from the Lambda that will
// receive this request, so a bad argument is rejected here with the same message
// the API would have used.
import {
  BadRequest,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
  normalizeSlug,
  optionalText,
} from '../../lib/lambda/handler';

import { type Config, PathError, resolveUserPath } from './config';

const execFileAsync = promisify(execFile);

export interface PublishRequest {
  glb: string;
  project?: string;
  title?: string;
  notes?: string;
  timeoutSeconds?: number;
}

export interface PublishResult {
  project: string;
  revision: number | null;
  url: string;
  bytes: number;
  /** The command that ran (or would run, when dryRun is set). */
  command: string;
  dryRun: boolean;
  /** publish.sh's progress output, for the record. */
  log: string;
}

/** Pull the revision back out of a share URL: https://host/<slug>/<rev> */
export function parseShareUrl(url: string): { project: string; revision: number } | null {
  const match = /^https?:\/\/[^/]+\/([a-z0-9][a-z0-9-]*)\/(\d+)\/?$/.exec(url.trim());
  return match ? { project: match[1], revision: Number(match[2]) } : null;
}

const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_./:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/** The publish.sh argument list, assembled from config plus the request. */
export function publishArgs(cfg: Config, req: PublishRequest, glb: string, project: string): string[] {
  const args = [cfg.publishScript, glb, '--project', project];

  const title = optionalText(req.title, MAX_TITLE_LEN);
  if (title) args.push('--title', title);
  const notes = optionalText(req.notes, MAX_NOTES_LEN);
  if (notes) args.push('--notes', notes);

  if (cfg.awsProfile) args.push('--profile', cfg.awsProfile);
  args.push('--region', cfg.awsRegion);
  if (cfg.apiUrl) args.push('--api-url', cfg.apiUrl);
  if (cfg.siteUrl) args.push('--site-url', cfg.siteUrl);
  args.push('--timeout', String(Math.round(req.timeoutSeconds ?? cfg.publishTimeoutSeconds)));
  return args;
}

/**
 * Reserve a revision, upload, and wait for the processor.
 *
 * `dryRun` stops after assembling the command, which is how a harness can
 * exercise the whole path — including the export and the local checks — without
 * creating a revision. Revision numbers are never reused, so a throwaway publish
 * burns one permanently.
 */
export async function publishModel(cfg: Config, req: PublishRequest): Promise<PublishResult> {
  const glb = resolveUserPath(req.glb, cfg, { extensions: ['.glb'], label: 'glb' });
  if (!fs.existsSync(glb)) throw new PathError(`No such file: ${glb}`);

  const wanted = req.project ?? cfg.defaultProject ?? '';
  if (!String(wanted).trim()) {
    throw new BadRequest(
      'project is required (or set THREED_DEFAULT_PROJECT / defaultProject in the config file)',
    );
  }
  const project = normalizeSlug(wanted);

  if (!fs.existsSync(cfg.publishScript)) {
    throw new Error(`publish.sh is missing: ${cfg.publishScript} (set THREED_PUBLISH_SCRIPT)`);
  }
  if (!cfg.apiUrl) {
    throw new Error(
      'No API URL. Deploy with `--outputs-file cdk-outputs.json`, or set THREED_API_URL ' +
        '(the deployed value is the ApiUrl stack output).',
    );
  }

  const bytes = fs.statSync(glb).size;
  const args = publishArgs(cfg, req, glb, project);
  // publish.sh needs bash: `set -o pipefail` and arrays are not POSIX sh. Running
  // it through bash also means it does not have to be executable.
  const command = ['bash', ...args].map(shellQuote).join(' ');

  if (cfg.dryRun) {
    return { project, revision: null, url: '', bytes, command, dryRun: true, log: 'dry run: nothing was published' };
  }

  const timeoutSeconds = Math.round(req.timeoutSeconds ?? cfg.publishTimeoutSeconds);
  let stdout = '';
  let stderr = '';
  try {
    // Give the script 30s past its own polling deadline, so its "timed out
    // waiting for processing" message wins over a blunt kill.
    const res = await execFileAsync('bash', args, {
      timeout: (timeoutSeconds + 30) * 1000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf-8',
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err: any) {
    stdout = String(err?.stdout ?? '');
    stderr = String(err?.stderr ?? '');
    const detail = stderr.trim() || stdout.trim() || String(err?.message ?? err);
    const statusHint = statusUrlFor(cfg, project, stderr);
    throw new Error(
      `Publishing failed.\n\n${detail}\n\nCommand: ${command}` +
        (statusHint ? `\n\nCheck the revision's own status with:\n  curl -s ${statusHint}` : ''),
    );
  }

  const url = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  const parsed = parseShareUrl(url);
  if (!parsed) {
    throw new Error(
      `Publishing produced no share URL. publish.sh printed:\n${stdout.trim() || '(nothing)'}\n` +
        `${stderr.trim()}\n\nCommand: ${command}`,
    );
  }

  return {
    project: parsed.project,
    revision: parsed.revision,
    url,
    bytes,
    command,
    dryRun: false,
    log: stderr.trim(),
  };
}

/**
 * The status object publish.sh polls, for a caller that wants to check on a
 * publish whose wait timed out. The revision is only knowable from the script's
 * own progress output, since it is assigned server-side.
 */
function statusUrlFor(cfg: Config, project: string, stderr: string): string | null {
  if (!cfg.siteUrl) return null;
  const revision = /revision (\d+)/.exec(stderr)?.[1];
  return revision ? `${cfg.siteUrl}/status/${project}/${revision}.json` : null;
}
