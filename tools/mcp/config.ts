/**
 * Configuration for the stdio MCP server.
 *
 * Every knob is settable from the MCP server definition's `env` block, because
 * that is the only configuration surface a harness like Claude Code, Codex or
 * Cursor gives you. The long tail can go in a JSON file instead, and the two
 * endpoint URLs fall back to the deploy outputs the way `tools/publish.sh` does.
 *
 *   per-call argument  >  THREED_* env  >  config file
 *                      >  cdk-outputs.json  >  built-in default
 *
 * Which level won for each key is recorded in `sources` and reported by the
 * `check_setup` tool, so "why is it using that profile?" is answerable without
 * reading this file.
 *
 * No credentials pass through here: publishing shells out to `tools/publish.sh`,
 * which resolves them with `aws configure export-credentials` (SSO, assumed
 * roles and all). The server only ever knows a profile *name*.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The model size cap and the slug rules are the Lambda's, not ours:
// lib/lambda/handler.ts enforces both server-side. Importing them keeps the
// client-side checks from drifting into friendlier-but-wrong ones.
import { BadRequest, MAX_MODEL_BYTES, normalizeSlug } from '../../lib/lambda/handler';

/** Server misconfiguration — refuse to start rather than run on silent defaults. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type ConfigSource = 'default' | 'outputs' | 'file' | 'env';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

/** Every tool this server can register. `enabledTools` is checked against it. */
export const TOOL_NAMES = [
  'check_setup',
  'export_glb',
  'gui_export_instructions',
  'inspect_glb',
  'publish_model',
  'convert_and_publish',
  'list_revisions',
  'get_publish_status',
  'get_feedback',
  'verify_revision',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that write to the deployment; suppressed by `allowPublish: false`. */
export const PUBLISHING_TOOLS: ToolName[] = ['publish_model', 'convert_and_publish'];

/**
 * Settings that used to exist, and why they don't. The loader refuses to start on
 * an unknown key, which is right for a typo but unhelpful for a setting that was
 * real last week — a harness whose env block still carries one deserves the
 * reason, not a list of valid keys to diff by eye.
 */
export const REMOVED_KEYS: Record<string, { envName: string; why: string }> = {
  publishScript: {
    envName: 'THREED_PUBLISH_SCRIPT',
    why: 'publishing no longer shells out to tools/publish.sh — it signs and uploads in this process, and the script is now a wrapper around the same code',
  },
};

export interface Config {
  repoRoot: string;
  awsProfile: string | null;
  awsRegion: string;
  apiUrl: string | null;
  siteUrl: string | null;
  outputsFile: string;
  exportScript: string;
  freecadcmd: string | null;
  workDir: string;
  defaultProject: string | null;
  defaultLinearDeflection: number | null;
  defaultAngularDeflection: number | null;
  freecadTimeoutSeconds: number;
  publishTimeoutSeconds: number;
  /** Deadline for one HTTP request (not for the publish as a whole). */
  httpTimeoutSeconds: number;
  /** Fetch the share URL and the model after publishing, to prove they serve. */
  verifyAfterPublish: boolean;
  maxModelBytes: number;
  warnModelBytes: number;
  /** Empty means "anywhere"; otherwise .FCStd/.glb arguments must live inside one. */
  allowedPaths: string[];
  allowPublish: boolean;
  dryRun: boolean;
  /** Empty means "all of TOOL_NAMES". */
  enabledTools: ToolName[];
  logLevel: LogLevel;
  logFile: string | null;
}

export interface LoadedConfig {
  values: Config;
  sources: Record<keyof Config, ConfigSource>;
  /** The config file that was read, or null when there wasn't one. */
  configFile: string | null;
  /** The outputs file that was read, or null when it was absent/unparseable. */
  outputsFile: string | null;
  /** Why the outputs file was unusable, when it existed but could not be read. */
  outputsProblem: string | null;
  /**
   * The AWS account the deployment lives in, recovered from the PublishRouteArn
   * output. Lets check_setup catch a profile pointed at the wrong account, which
   * otherwise surfaces only as an opaque 403 from execute-api.
   */
  deploymentAccount: string | null;
}

export interface LoadOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the repo root that the path defaults hang off; for tests. */
  repoRoot?: string;
}

// The keys a config file may set: every Config key except repoRoot, which has to
// be known before the file can be located.
const FILE_KEYS = new Set<string>(
  ([
    'awsProfile',
    'awsRegion',
    'apiUrl',
    'siteUrl',
    'outputsFile',
    'exportScript',
    'freecadcmd',
    'workDir',
    'defaultProject',
    'defaultLinearDeflection',
    'defaultAngularDeflection',
    'freecadTimeoutSeconds',
    'publishTimeoutSeconds',
    'httpTimeoutSeconds',
    'verifyAfterPublish',
    'maxModelBytes',
    'warnModelBytes',
    'allowedPaths',
    'allowPublish',
    'dryRun',
    'enabledTools',
    'logLevel',
    'logFile',
  ] satisfies Array<keyof Config>).map(String),
);

/** A `_`-prefixed key is a comment; config.example.json uses `_readme`. */
const isCommentKey = (key: string): boolean => key.startsWith('_');

/** Caller-fixable path problem; the server answers with an error result. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

function readJsonFile(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw new ConfigError(`Could not read ${file}: ${err?.message ?? err}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new ConfigError(`${file} is not valid JSON: ${err?.message ?? err}`);
  }
}

/**
 * Pull a named output out of a CDK outputs file, whatever the stack is called.
 * Mirrors the `..|objects|select(has($k))` jq expression in tools/publish.sh, so
 * both tools accept the same file.
 */
export function readOutput(outputs: unknown, key: string): string | null {
  if (!outputs || typeof outputs !== 'object') return null;
  for (const value of Object.values(outputs as Record<string, unknown>)) {
    if (value && typeof value === 'object' && key in (value as object)) {
      const found = (value as Record<string, unknown>)[key];
      if (typeof found === 'string' && found) return found;
    }
    if (value && typeof value === 'object') {
      const nested = readOutput(value, key);
      if (nested) return nested;
    }
  }
  return null;
}

/** The account id out of an ARN: arn:aws:execute-api:region:ACCOUNT:api/… */
export function accountFromArn(arn: string | null): string | null {
  return arn ? (/^arn:[^:]*:[^:]*:[^:]*:(\d{12}):/.exec(arn)?.[1] ?? null) : null;
}

/**
 * Where FreeCAD's console binary is, in the same order package.json's
 * `test:freecad` script looks: an explicit setting, then PATH, then the macOS
 * app bundle. It is deliberately not on PATH in a default install, which is the
 * single most common reason a headless export "doesn't work".
 */
const MACOS_FREECADCMD = '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd';

/** PATH lookup, done in-process: the server is spawned without a shell. */
export function whichBinary(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function findFreecadcmd(env: Record<string, string | undefined>): string | null {
  return (
    whichBinary('freecadcmd', env) ?? (fs.existsSync(MACOS_FREECADCMD) ? MACOS_FREECADCMD : null)
  );
}

// --- value parsers -----------------------------------------------------------

function parseBoolean(raw: unknown, where: string): boolean {
  if (typeof raw === 'boolean') return raw;
  const text = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(text)) return false;
  throw new ConfigError(`${where} must be a boolean (true/false), got ${JSON.stringify(raw)}`);
}

function parseNumber(raw: unknown, where: string, opts: { min?: number } = {}): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${where} must be a number, got ${JSON.stringify(raw)}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new ConfigError(`${where} must be at least ${opts.min}, got ${n}`);
  }
  return n;
}

/** A `:`-separated string (env) or an array of strings (file). */
function parseList(raw: unknown, where: string, separator: RegExp): string[] {
  if (Array.isArray(raw) && raw.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${where} must be a list of strings`);
  }
  const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(separator);
  return items.map((s) => s.trim()).filter(Boolean);
}

// --- resolution --------------------------------------------------------------

/**
 * Resolve the whole configuration. Throws ConfigError on anything a human has
 * to fix (an unknown file key, a number that isn't one), because starting with a
 * silently-ignored setting is worse than not starting.
 */
export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;

  // repoRoot first: the path defaults hang off it, including the config file's.
  const repoRoot = path.resolve(
    opts.repoRoot ?? env.THREED_REPO_ROOT ?? path.join(__dirname, '..', '..'),
  );

  const configFile = env.THREED_CONFIG
    ? path.resolve(env.THREED_CONFIG)
    : path.join(repoRoot, 'tools', 'mcp', 'config.json');
  const fileRaw = readJsonFile(configFile);
  if (fileRaw !== undefined && (typeof fileRaw !== 'object' || fileRaw === null || Array.isArray(fileRaw))) {
    throw new ConfigError(`${configFile} must contain a JSON object`);
  }
  const file = (fileRaw ?? {}) as Record<string, unknown>;
  if (env.THREED_CONFIG && fileRaw === undefined) {
    throw new ConfigError(`THREED_CONFIG points at ${configFile}, which does not exist`);
  }
  for (const [key, removed] of Object.entries(REMOVED_KEYS)) {
    if (key in file) {
      throw new ConfigError(`${configFile}: ${key} is no longer a setting — ${removed.why}. Delete it.`);
    }
    if (env[removed.envName]) {
      throw new ConfigError(
        `${removed.envName} is no longer a setting — ${removed.why}. ` +
          "Remove it from the server's env block.",
      );
    }
  }

  const unknown = Object.keys(file).filter((k) => !isCommentKey(k) && !FILE_KEYS.has(k));
  if (unknown.length) {
    throw new ConfigError(
      `${configFile} has unknown key(s): ${unknown.join(', ')}. ` +
        `Valid keys: ${[...FILE_KEYS].sort().join(', ')}`,
    );
  }

  const sources = {} as Record<keyof Config, ConfigSource>;

  /**
   * One key, resolved across the layers. `envName` is read from the process
   * environment, `key` from the config file, and `outputs` supplies the
   * deploy-outputs fallback for the two endpoint URLs.
   */
  function pick<T>(
    key: keyof Config,
    envName: string | null,
    parse: (raw: unknown, where: string) => T,
    fallbacks: { outputs?: () => unknown; def: () => T },
  ): T {
    const fromEnv = envName ? env[envName] : undefined;
    if (fromEnv !== undefined && fromEnv !== '') {
      sources[key] = 'env';
      return parse(fromEnv, envName!);
    }
    if (key in file && file[key] !== null && file[key] !== undefined) {
      sources[key] = 'file';
      return parse(file[key], `${configFile}: ${key}`);
    }
    if (fallbacks.outputs) {
      // Parsed like any other layer, so a URL with a trailing slash from the
      // deploy outputs is normalised the same way one from the env is.
      const fromOutputs = fallbacks.outputs();
      if (fromOutputs !== null && fromOutputs !== undefined) {
        sources[key] = 'outputs';
        return parse(fromOutputs, `${outputsFile}: ${key}`);
      }
    }
    sources[key] = 'default';
    return fallbacks.def();
  }

  const asString = (raw: unknown): string => String(raw).trim();
  const asPath = (raw: unknown): string => path.resolve(String(raw).trim());
  const stripSlash = (raw: unknown): string => String(raw).trim().replace(/\/+$/, '');

  sources.repoRoot = opts.repoRoot ? 'default' : env.THREED_REPO_ROOT ? 'env' : 'default';

  const outputsFile = pick('outputsFile', 'THREED_OUTPUTS_FILE', asPath, {
    def: () => path.join(repoRoot, 'cdk-outputs.json'),
  });

  // The outputs file is a convenience layer, not a source of truth: a
  // half-written one must not stop the export tools from working. publish.sh is
  // equally forgiving about it. check_setup reports the problem instead.
  let outputs: unknown;
  let outputsProblem: string | null = null;
  try {
    outputs = readJsonFile(outputsFile);
  } catch (err) {
    outputsProblem = err instanceof Error ? err.message : String(err);
  }

  const values: Config = {
    repoRoot,
    outputsFile,

    awsProfile: pick<string | null>('awsProfile', 'THREED_AWS_PROFILE', asString, {
      def: () => env.AWS_PROFILE?.trim() || null,
    }),
    awsRegion: pick('awsRegion', 'THREED_AWS_REGION', asString, {
      def: () => env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || 'us-east-1',
    }),

    // Endpoints: flag/env, then file, then the deploy outputs — the same order
    // tools/publish.sh uses, so deploying with --outputs-file is enough.
    apiUrl: pick<string | null>('apiUrl', 'THREED_API_URL', stripSlash, {
      outputs: () => readOutput(outputs, 'ApiUrl'),
      def: () => null,
    }),
    siteUrl: pick<string | null>('siteUrl', 'THREED_SITE_URL', stripSlash, {
      outputs: () => readOutput(outputs, 'SiteUrl'),
      def: () => null,
    }),

    exportScript: pick('exportScript', 'THREED_EXPORT_SCRIPT', asPath, {
      def: () => path.join(repoRoot, 'tools', 'freecad_export_glb.py'),
    }),
    freecadcmd: pick<string | null>('freecadcmd', 'THREED_FREECADCMD', asPath, {
      def: () => findFreecadcmd(env),
    }),
    workDir: pick('workDir', 'THREED_WORK_DIR', asPath, {
      def: () => path.join(os.tmpdir(), '3d-feedback'),
    }),

    defaultProject: pick<string | null>('defaultProject', 'THREED_DEFAULT_PROJECT', asString, {
      def: () => null,
    }),
    defaultLinearDeflection: pick<number | null>(
      'defaultLinearDeflection',
      'THREED_DEFAULT_LINEAR_DEFLECTION',
      (raw, where) => parseNumber(raw, where, { min: 0 }),
      { def: () => null },
    ),
    defaultAngularDeflection: pick<number | null>(
      'defaultAngularDeflection',
      'THREED_DEFAULT_ANGULAR_DEFLECTION',
      (raw, where) => parseNumber(raw, where, { min: 0 }),
      { def: () => null },
    ),

    freecadTimeoutSeconds: pick(
      'freecadTimeoutSeconds',
      'THREED_FREECAD_TIMEOUT_SECONDS',
      (raw, where) => parseNumber(raw, where, { min: 1 }),
      { def: () => 300 },
    ),
    publishTimeoutSeconds: pick(
      'publishTimeoutSeconds',
      'THREED_PUBLISH_TIMEOUT_SECONDS',
      (raw, where) => parseNumber(raw, where, { min: 1 }),
      { def: () => 120 },
    ),
    // Per request, so a stalled connection fails in seconds while the publish as
    // a whole still gets its full publishTimeoutSeconds of polling.
    httpTimeoutSeconds: pick(
      'httpTimeoutSeconds',
      'THREED_HTTP_TIMEOUT_SECONDS',
      (raw, where) => parseNumber(raw, where, { min: 1 }),
      { def: () => 30 },
    ),
    verifyAfterPublish: pick('verifyAfterPublish', 'THREED_VERIFY_PUBLISH', parseBoolean, {
      def: () => true,
    }),

    maxModelBytes: pick(
      'maxModelBytes',
      'THREED_MAX_MODEL_BYTES',
      (raw, where) => parseNumber(raw, where, { min: 1 }),
      { def: () => MAX_MODEL_BYTES },
    ),
    warnModelBytes: pick(
      'warnModelBytes',
      'THREED_WARN_MODEL_BYTES',
      (raw, where) => parseNumber(raw, where, { min: 1 }),
      // Advisory only. The README's known limit: iOS Safari kills the tab rather
      // than degrading, well below the server-side 100 MB cap.
      { def: () => 25 * 1024 * 1024 },
    ),

    allowedPaths: pick(
      'allowedPaths',
      'THREED_ALLOWED_PATHS',
      (raw, where) => parseList(raw, where, new RegExp(`[${path.delimiter}]`)).map((p) => path.resolve(p)),
      { def: () => [] },
    ),
    allowPublish: pick('allowPublish', 'THREED_ALLOW_PUBLISH', parseBoolean, { def: () => true }),
    dryRun: pick('dryRun', 'THREED_DRY_RUN', parseBoolean, { def: () => false }),

    enabledTools: pick(
      'enabledTools',
      'THREED_ENABLED_TOOLS',
      (raw, where) => {
        const names = parseList(raw, where, /[,\s]+/);
        const bad = names.filter((n) => !(TOOL_NAMES as readonly string[]).includes(n));
        if (bad.length) {
          throw new ConfigError(
            `${where}: unknown tool(s) ${bad.join(', ')}. Valid: ${TOOL_NAMES.join(', ')}`,
          );
        }
        return names as ToolName[];
      },
      { def: () => [] },
    ),

    logLevel: pick(
      'logLevel',
      'THREED_LOG_LEVEL',
      (raw, where) => {
        const level = String(raw).trim().toLowerCase() as LogLevel;
        if (!LOG_LEVELS.includes(level)) {
          throw new ConfigError(`${where} must be one of ${LOG_LEVELS.join(', ')}`);
        }
        return level;
      },
      { def: () => 'info' as LogLevel },
    ),
    logFile: pick<string | null>('logFile', 'THREED_LOG_FILE', asPath, { def: () => null }),
  };

  return {
    values,
    sources,
    configFile: fileRaw === undefined ? null : configFile,
    outputsFile: outputs === undefined ? null : outputsFile,
    outputsProblem,
    deploymentAccount: accountFromArn(readOutput(outputs, 'PublishRouteArn')),
  };
}

/** The tools that should be registered, honouring enabledTools and allowPublish. */
export function activeTools(cfg: Config): ToolName[] {
  const wanted = cfg.enabledTools.length ? cfg.enabledTools : [...TOOL_NAMES];
  return cfg.allowPublish ? wanted : wanted.filter((t) => !PUBLISHING_TOOLS.includes(t));
}

/**
 * Resolve a caller-supplied file path and check it against `allowedPaths`.
 *
 * The allowlist is opt-in: unset means the server will read any path the user
 * running it can read, which is the right default for a personal tool. Setting
 * it is how you hand the server to a harness you want to keep away from the rest
 * of the disk.
 */
export function resolveUserPath(
  input: string,
  cfg: Config,
  opts: { extensions?: string[]; label?: string } = {},
): string {
  const label = opts.label ?? 'path';
  const raw = String(input ?? '').trim();
  if (!raw) throw new PathError(`${label} is required`);

  // Expand a leading ~ by hand: the server is spawned by a harness, not a shell,
  // so nothing else will.
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const resolved = path.resolve(expanded);

  if (opts.extensions?.length) {
    const ext = path.extname(resolved).toLowerCase();
    if (!opts.extensions.map((e) => e.toLowerCase()).includes(ext)) {
      throw new PathError(
        `${label} must end in ${opts.extensions.join(' or ')}, got ${path.basename(resolved) || resolved}`,
      );
    }
  }

  if (cfg.allowedPaths.length && !cfg.allowedPaths.some((root) => isInside(resolved, root))) {
    throw new PathError(
      `${label} ${resolved} is outside the configured allowedPaths ` +
        `(${cfg.allowedPaths.join(', ')})`,
    );
  }
  return resolved;
}

/**
 * The project a call is about: its own argument, else the configured default.
 *
 * Validated with the Lambda's own `normalizeSlug`, so a slug this server accepts
 * is one the API accepts, and a reserved name is refused here with the same
 * message rather than after a round trip.
 */
export function resolveProject(cfg: Config, project?: string | null): string {
  const wanted = project ?? cfg.defaultProject ?? '';
  if (!String(wanted).trim()) {
    throw new BadRequest(
      'project is required (or set THREED_DEFAULT_PROJECT / defaultProject in the config file)',
    );
  }
  return normalizeSlug(wanted);
}

/** Prefix containment that respects path boundaries (/a/bc is not inside /a/b). */
export function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
