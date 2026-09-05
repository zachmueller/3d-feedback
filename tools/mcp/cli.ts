/**
 * The command-line front end to the publish client — what tools/publish.sh runs.
 *
 *   tools/publish.sh model.glb --project towel-clip \
 *       [--title "Towel clip"] [--notes "raised the clip angle 5°"] \
 *       [--profile my-aws-profile] [--api-url https://…] [--site-url https://…] \
 *       [--region us-east-1] [--timeout 120] [--revision 4] [--force] \
 *       [--no-verify] [--quiet] [--source-* …]
 *
 * The --source-* flags override the provenance the .glb carries in
 * asset.extras.source, which is read automatically and is the normal path. `--help`
 * lists them.
 *
 * The share URL is the last line on stdout and the only thing there, so a workflow
 * can capture it directly:
 *
 *   URL=$(tools/publish.sh model.glb --project towel-clip --quiet)
 *
 * Configuration comes from the same layers the MCP server uses — flags, then
 * THREED_* env, then tools/mcp/config.json, then cdk-outputs.json — with flags on
 * top, so both entry points agree about which profile signs and which API is
 * being published to.
 */
import { BadRequest } from '../../lib/lambda/handler';

import { type Config, ConfigError, loadConfig, PathError } from './config';
import { PublishError, publishModel, type PublishRequest } from './publish';
import { SiteError } from './site';

const USAGE = `Publish a .glb as the next revision of a project and print its share URL.

  tools/publish.sh model.glb --project towel-clip [options]

  --project <slug>     Project to publish to (or set THREED_DEFAULT_PROJECT)
  --title <text>       Project title shown in the viewer
  --notes <text>       What changed in this revision
  --profile <name>     AWS profile that signs the request
  --region <name>      AWS region of the API (default us-east-1)
  --api-url <url>      API endpoint (default: ApiUrl from cdk-outputs.json)
  --site-url <url>     Site URL (default: SiteUrl from cdk-outputs.json)
  --timeout <seconds>  How long to wait for processing (default 120)
  --revision <n>       Finish a revision that was already reserved but never
                       completed, instead of spending a new number
  --force              Publish even if these exact bytes are the latest revision
  --no-verify          Skip the check that the published URL actually serves
  -q, --quiet          Progress off; the URL is still printed
  -h, --help           This text

Recording where the model came from (normally unnecessary — a .glb that declares
it in asset.extras.source is read automatically, and inside the file it cannot
drift from the bytes it describes). These override the file:

  --source-repo <name>       Repository identity, e.g. 3d-models
  --source-clone-url <url>   https:// ssh:// git:// codecommit:: or user@host:path
  --source-commit <oid>      The exact commit, 40 or 64 hex characters
  --source-ref <name>        Branch or tag, e.g. main
  --source-path <path>       The model's directory in the repo, repo-relative
  --source-build <cmd>       The command that rebuilds it
  --source-recreate <text>   One line telling a reviewer how to recreate it
  --source-dirty             The working tree had uncommitted changes
  --source-tree <oid>        git tree oid of what was built (use with --source-dirty)

Publishing the same bytes twice is a no-op: the revision that already holds them
is printed instead, because revision numbers are never reused and a retry should
not spend one. Pass --force to publish them anyway. Note that a dedupe also drops
an overridden --source-*, for the same reason it drops --notes: the bytes it would
describe have not changed.`;

interface Parsed {
  request: PublishRequest;
  overrides: Partial<Config>;
  quiet: boolean;
}

/** Exported for the unit tests: argv in, request and config overrides out. */
export function parseArgs(argv: string[]): Parsed {
  const request: PublishRequest = { glb: '' };
  const overrides: Partial<Config> = {};
  let quiet = false;
  let file = '';
  // Assembled field by field, then attached only if anything was given — an empty
  // object would otherwise read as "override the file with nothing".
  const source: Record<string, unknown> = {};

  const next = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new BadRequest(`${flag} needs a value`);
    return value;
  };
  const positiveNumber = (flag: string, value: string | undefined): number => {
    const n = Number(next(flag, value));
    if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${flag} must be a positive number`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--project':
        request.project = next(arg, argv[++i]);
        break;
      case '--title':
        request.title = next(arg, argv[++i]);
        break;
      case '--notes':
        request.notes = next(arg, argv[++i]);
        break;
      case '--profile':
        overrides.awsProfile = next(arg, argv[++i]);
        break;
      case '--region':
        overrides.awsRegion = next(arg, argv[++i]);
        break;
      case '--api-url':
        overrides.apiUrl = next(arg, argv[++i]).replace(/\/+$/, '');
        break;
      case '--site-url':
        overrides.siteUrl = next(arg, argv[++i]).replace(/\/+$/, '');
        break;
      case '--timeout':
        request.timeoutSeconds = positiveNumber(arg, argv[++i]);
        break;
      case '--revision':
        request.revision = positiveNumber(arg, argv[++i]);
        break;
      case '--force':
        request.force = true;
        break;
      case '--source-repo':
        source.repo = next(arg, argv[++i]);
        break;
      case '--source-clone-url':
        source.cloneUrl = next(arg, argv[++i]);
        break;
      case '--source-commit':
        source.commit = next(arg, argv[++i]);
        break;
      case '--source-ref':
        source.ref = next(arg, argv[++i]);
        break;
      case '--source-path':
        source.path = next(arg, argv[++i]);
        break;
      case '--source-build':
        source.build = next(arg, argv[++i]);
        break;
      case '--source-recreate':
        source.recreate = next(arg, argv[++i]);
        break;
      case '--source-tree':
        source.tree = next(arg, argv[++i]);
        break;
      case '--source-dirty':
        source.dirty = true;
        break;
      case '--no-verify':
        request.verify = false;
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      default:
        if (arg.startsWith('-')) throw new BadRequest(`unknown flag ${arg}`);
        if (file) throw new BadRequest('only one file at a time');
        file = arg;
    }
  }

  if (!file) throw new BadRequest('pass the .glb file to publish');
  request.glb = file;
  // Validation lives in normalizeSource, which publishModel reaches on the way to
  // the request body, so a bad --source-commit fails with the API's own wording.
  if (Object.keys(source).length) request.source = source;
  return { request, overrides, quiet };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { request, overrides, quiet } = parseArgs(argv);
  const loaded = loadConfig();
  const cfg: Config = { ...loaded.values, ...overrides };
  // Progress goes to stderr so stdout stays capturable.
  const progress = (line: string): void => {
    if (!quiet) process.stderr.write(`${line}\n`);
  };

  progress(`publishing ${request.glb} to ${request.project ?? cfg.defaultProject ?? '(no project)'}…`);
  const result = await publishModel(cfg, request, {
    // Retry advice in this caller's own dialect: a shell command, not a tool call.
    resumeHint: ({ glb, project, revision }) => [
      `  tools/publish.sh ${glb} --project ${project} --revision ${revision}`,
      `Or look first: curl -s ${cfg.siteUrl ?? '$SITE_URL'}/status/${project}/${revision}.json`,
    ],
  });

  for (const line of result.log) progress(line);
  if (result.dryRun) {
    process.stderr.write('dry run: nothing was published (dryRun is on)\n');
    process.stderr.write(`${JSON.stringify(result.plannedRequest, null, 2)}\n`);
    return 0;
  }
  if (result.deduped) {
    progress(`revision ${result.revision} already holds these bytes; nothing was published`);
  } else {
    progress(`published ${result.project} revision ${result.revision}`);
  }
  if (result.verification && !result.verification.ok) {
    for (const check of result.verification.checks.filter((c) => !c.ok)) {
      process.stderr.write(`warning: ${check.name}: ${check.detail}\n`);
    }
  }

  process.stdout.write(`${result.url}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // These four carry messages written for whoever ran the command; anything
    // else is unexpected and keeps its stack.
    const expected =
      err instanceof BadRequest ||
      err instanceof PathError ||
      err instanceof SiteError ||
      err instanceof ConfigError ||
      err instanceof PublishError;
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!expected && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
