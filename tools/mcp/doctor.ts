/**
 * The `check_setup` probes.
 *
 * A harness that cannot publish should be told *which* link in the chain is
 * broken and what fixes it, because the alternative is a tool call that fails
 * halfway through an export with a message about signatures. Everything here is
 * read-only and cheap: no revision is reserved and nothing is uploaded.
 *
 * The list is short now. Publishing used to need bash, the AWS CLI, jq and a curl
 * with --aws-sigv4, and each of those was a probe; it signs and uploads in this
 * process instead, so what is left to check is FreeCAD (for the export), the
 * credentials, and the two endpoints.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

import { callerIdentity, CredentialError, credentialFix, whoIsSigning } from './aws';
import { type ConfigSource, type Config, type LoadedConfig, type ToolName } from './config';
import { errorDetail, nodeFetch, request } from './http';
import { isHeadlessShell } from './render';

const execFileAsync = promisify(execFile);

export interface Probe {
  name: string;
  /** true = fine, false = broken, null = not applicable / not checked. */
  ok: boolean | null;
  detail: string;
  fix?: string;
}

export interface SetupReport {
  configFile: string | null;
  outputsFile: string | null;
  registeredTools: ToolName[];
  config: Record<string, { value: unknown; source: ConfigSource }>;
  probes: Probe[];
  canExportHeadless: boolean;
  canPublish: boolean;
  notes: string[];
}

/** Run a command purely to see whether it works; never throws. */
async function tryRun(
  file: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ ok: boolean; out: string }> {
  try {
    const res = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    });
    return { ok: true, out: `${res.stdout}${res.stderr}`.trim() };
  } catch (err: any) {
    const out = `${String(err?.stdout ?? '')}${String(err?.stderr ?? '')}`.trim();
    return { ok: false, out: out || String(err?.message ?? err) };
  }
}

const firstLine = (text: string): string => text.split('\n').find((l) => l.trim()) ?? '';

async function probeFreecad(cfg: Config): Promise<Probe> {
  if (!cfg.freecadcmd) {
    return {
      name: 'freecadcmd',
      ok: false,
      detail: 'not found on PATH or in /Applications/FreeCAD.app',
      fix: 'Install FreeCAD, or set THREED_FREECADCMD to its console binary. A default macOS install does not put freecadcmd on PATH.',
    };
  }
  if (!fs.existsSync(cfg.freecadcmd)) {
    return {
      name: 'freecadcmd',
      ok: false,
      detail: `${cfg.freecadcmd} does not exist`,
      fix: 'Point THREED_FREECADCMD at the real binary.',
    };
  }
  const run = await tryRun(cfg.freecadcmd, ['--version']);
  return {
    name: 'freecadcmd',
    ok: run.ok,
    detail: `${cfg.freecadcmd} — ${firstLine(run.out)}`,
    fix: run.ok ? undefined : 'The binary exists but would not run.',
  };
}

function probeFile(name: string, file: string, envVar: string): Probe {
  const exists = fs.existsSync(file);
  return {
    name,
    ok: exists,
    detail: exists ? file : `${file} is missing`,
    fix: exists ? undefined : `Set ${envVar}, or run the server from a full checkout of the repo.`,
  };
}

/**
 * Whether render_view has a browser to drive. Existence only: running even
 * `--version` starts the binary, and a check is not worth a browser launch.
 * Not-found is `null`, not a failure, because nothing else depends on it.
 */
const INSTALL_HEADLESS_SHELL = 'npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer';

function probeChrome(cfg: Config): Probe {
  if (cfg.chromePath && fs.existsSync(cfg.chromePath)) {
    if (isHeadlessShell(cfg.chromePath)) {
      return { name: 'chrome', ok: true, detail: `${cfg.chromePath} (chrome-headless-shell, for render_view)` };
    }
    return {
      name: 'chrome',
      ok: true,
      detail:
        `${cfg.chromePath} (for render_view). A desktop or managed Chrome can quit on its own ` +
        `mid-render; \`${INSTALL_HEADLESS_SHELL}\` installs a headless shell render_view will prefer.`,
    };
  }
  return {
    name: 'chrome',
    ok: cfg.chromePath ? false : null,
    detail: cfg.chromePath
      ? `${cfg.chromePath} is missing`
      : 'no Chrome or Chromium found — render_view will refuse to run',
    fix:
      'Set THREED_CHROME_PATH (config key chromePath) to a Chrome or Chromium binary, or install ' +
      `a chrome-headless-shell, which is found automatically: ${INSTALL_HEADLESS_SHELL}`,
  };
}

function probeWorkDir(cfg: Config): Probe {
  try {
    fs.mkdirSync(cfg.workDir, { recursive: true });
    fs.accessSync(cfg.workDir, fs.constants.W_OK);
    return { name: 'workDir', ok: true, detail: `${cfg.workDir} is writable` };
  } catch (err: any) {
    return {
      name: 'workDir',
      ok: false,
      detail: `${cfg.workDir}: ${err?.message ?? err}`,
      fix: 'Set THREED_WORK_DIR to a directory this process can write to.',
    };
  }
}

/**
 * Who the configured profile is, resolved through the same SDK chain that signs a
 * publish — so this probe fails exactly when publishing would.
 *
 * The failure worth catching is credentials that are live but for the wrong
 * account: publishing then gets an opaque 403 from execute-api's IAM authorizer,
 * which says nothing about profiles. The expected account comes from the
 * PublishRouteArn output.
 */
async function probeIdentity(cfg: Config, deploymentAccount: string | null): Promise<Probe> {
  const who = whoIsSigning(cfg.awsProfile);
  try {
    const identity = await callerIdentity(cfg.awsProfile, cfg.awsRegion);
    if (deploymentAccount && identity.account !== deploymentAccount) {
      return {
        name: 'aws credentials',
        ok: false,
        detail: `${who} → ${identity.arn} (account ${identity.account}), but the deployment is in account ${deploymentAccount}`,
        fix: 'Set THREED_AWS_PROFILE to a profile in the deployment account. An ambient AWS_PROFILE from the shell is the usual cause.',
      };
    }
    return {
      name: 'aws credentials',
      ok: true,
      detail: `${who} → ${identity.arn} (account ${identity.account})`,
    };
  } catch (err) {
    return {
      name: 'aws credentials',
      ok: false,
      detail: err instanceof CredentialError ? err.reason : `${who}: ${String(err)}`,
      fix: err instanceof CredentialError ? err.fix : credentialFix(err, cfg.awsProfile),
    };
  }
}

/**
 * Does the site answer at all? The read tools and the post-publish verification
 * both go through the distribution rather than the API, so a broken certificate or
 * a DNS record that never landed shows up here instead of inside a publish.
 */
async function probeSite(cfg: Config): Promise<Probe> {
  if (!cfg.siteUrl) return { name: 'site', ok: null, detail: 'skipped — no site URL resolved' };
  const result = await request(
    nodeFetch,
    cfg.siteUrl,
    { method: 'GET' },
    Math.round(cfg.httpTimeoutSeconds * 1000),
  );
  const ok = result.status >= 200 && result.status < 400;
  return {
    name: 'site',
    ok,
    detail: ok
      ? `${cfg.siteUrl} → ${result.status}`
      : `${cfg.siteUrl} → ${result.networkError ?? `HTTP ${result.status}: ${errorDetail(result)}`}`,
    fix: ok
      ? undefined
      : 'Check the distribution, its certificate and the A/AAAA records in the parent zone (tools/parent-dns.sh --dry-run compares them).',
  };
}

function probeEndpoint(name: string, value: string | null, source: ConfigSource): Probe {
  return {
    name,
    ok: Boolean(value),
    detail: value ? `${value} (from ${source})` : 'not resolved',
    fix: value
      ? undefined
      : 'Deploy with `npx cdk deploy --outputs-file cdk-outputs.json`, or set the matching THREED_* variable.',
  };
}

export async function checkSetup(
  loaded: LoadedConfig,
  registeredTools: ToolName[],
): Promise<SetupReport> {
  const cfg = loaded.values;

  const probes: Probe[] = [];
  probes.push(await probeFreecad(cfg));
  probes.push(probeFile('exporter', cfg.exportScript, 'THREED_EXPORT_SCRIPT'));
  probes.push(probeWorkDir(cfg));
  probes.push(await probeIdentity(cfg, loaded.deploymentAccount));
  probes.push(probeEndpoint('apiUrl', cfg.apiUrl, loaded.sources.apiUrl));
  probes.push(probeEndpoint('siteUrl', cfg.siteUrl, loaded.sources.siteUrl));
  probes.push(await probeSite(cfg));
  probes.push(probeChrome(cfg));
  if (loaded.outputsProblem) {
    // Tolerated at load time so the export tools still work, but never silent.
    probes.push({
      name: 'cdk-outputs.json',
      ok: false,
      detail: loaded.outputsProblem,
      fix: 'Re-deploy with `--outputs-file cdk-outputs.json`, or set THREED_API_URL and THREED_SITE_URL directly.',
    });
  }

  const passed = (name: string): boolean => probes.some((p) => p.name === name && p.ok === true);

  const config: SetupReport['config'] = {};
  for (const [key, value] of Object.entries(cfg)) {
    config[key] = { value, source: loaded.sources[key as keyof Config] };
  }

  const notes: string[] = [
    'No credentials are held by this server: only a profile *name* is configured, and the ' +
      'AWS SDK resolves it the way the CLI does (env, config files, assumed roles, SSO cache).',
  ];
  if (cfg.dryRun) notes.push('dryRun is on: publishing tools will report the command and stop.');
  if (!cfg.allowPublish) notes.push('allowPublish is off: the publishing tools are not registered.');
  if (cfg.enabledTools.length) notes.push(`enabledTools narrows the surface to: ${cfg.enabledTools.join(', ')}`);
  if (cfg.allowedPaths.length) notes.push(`File arguments are restricted to: ${cfg.allowedPaths.join(', ')}`);
  if (!loaded.configFile) notes.push('No config file was read; everything came from env, outputs or defaults.');

  return {
    configFile: loaded.configFile,
    outputsFile: loaded.outputsFile,
    registeredTools,
    config,
    probes,
    canExportHeadless: passed('freecadcmd') && passed('exporter') && passed('workDir'),
    // Credentials and an endpoint, and that is the whole list — no binaries.
    canPublish: passed('aws credentials') && passed('apiUrl'),
    notes,
  };
}
