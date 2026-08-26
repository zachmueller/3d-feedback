/**
 * The `check_setup` probes.
 *
 * A harness that cannot publish should be told *which* link in the chain is
 * broken and what fixes it, because the alternative is a tool call that fails
 * halfway through an export with a message about signatures. Everything here is
 * read-only and cheap: no revision is reserved and nothing is uploaded.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

import {
  type ConfigSource,
  type Config,
  type LoadedConfig,
  type ToolName,
  whichBinary,
} from './config';

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

function probeBinary(name: string, install: string): Probe {
  const found = whichBinary(name);
  return {
    name,
    ok: Boolean(found),
    detail: found ?? 'not on PATH',
    fix: found ? undefined : install,
  };
}

/** publish.sh signs with curl, which only grew --aws-sigv4 in 7.75. */
async function probeCurlSigv4(): Promise<Probe> {
  const run = await tryRun('curl', ['--help', 'all'], 5000);
  const supported = run.out.includes('--aws-sigv4');
  return {
    name: 'curl --aws-sigv4',
    ok: supported,
    detail: supported ? 'supported' : 'this curl cannot sign SigV4 requests',
    fix: supported ? undefined : 'Install curl >= 7.75 (macOS ships 8.x; a stripped-down build may not).',
  };
}

async function probeIdentity(cfg: Config, deploymentAccount: string | null): Promise<Probe> {
  if (!whichBinary('aws')) {
    return { name: 'aws credentials', ok: null, detail: 'skipped — no aws CLI' };
  }
  const args = ['sts', 'get-caller-identity', '--output', 'json'];
  if (cfg.awsProfile) args.push('--profile', cfg.awsProfile);
  const run = await tryRun('aws', args, 20000);
  const who = cfg.awsProfile ? `profile ${cfg.awsProfile}` : 'the default credential chain';
  if (!run.ok) {
    const expired = /token has expired|SSO session|sso-session|expired/i.test(run.out);
    return {
      name: 'aws credentials',
      ok: false,
      detail: `${who}: ${firstLine(run.out)}`,
      fix: expired
        ? `Run: aws sso login${cfg.awsProfile ? ` --profile ${cfg.awsProfile}` : ''}`
        : 'Set THREED_AWS_PROFILE to a profile with access to the deployment account.',
    };
  }
  let arn = firstLine(run.out);
  let account: string | null = null;
  try {
    const parsed = JSON.parse(run.out);
    account = String(parsed.Account);
    arn = `${parsed.Arn} (account ${account})`;
  } catch {
    /* keep the raw first line */
  }

  // Valid credentials for the wrong account is the failure worth catching here:
  // publishing would get an opaque 403 from execute-api's IAM authorizer, which
  // says nothing about profiles. The expected account comes from the
  // PublishRouteArn output.
  if (account && deploymentAccount && account !== deploymentAccount) {
    return {
      name: 'aws credentials',
      ok: false,
      detail: `${who} → ${arn}, but the deployment is in account ${deploymentAccount}`,
      fix: 'Set THREED_AWS_PROFILE to a profile in the deployment account. An ambient AWS_PROFILE from the shell is the usual cause.',
    };
  }
  return { name: 'aws credentials', ok: true, detail: `${who} → ${arn}` };
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
  probes.push(probeFile('publish.sh', cfg.publishScript, 'THREED_PUBLISH_SCRIPT'));
  probes.push(probeBinary('aws', 'Install the AWS CLI v2.'));
  probes.push(probeBinary('jq', 'brew install jq'));
  probes.push(probeBinary('bash', 'publish.sh needs bash, not sh.'));
  probes.push(await probeCurlSigv4());
  probes.push(await probeIdentity(cfg, loaded.deploymentAccount));
  probes.push(probeEndpoint('apiUrl', cfg.apiUrl, loaded.sources.apiUrl));
  probes.push(probeEndpoint('siteUrl', cfg.siteUrl, loaded.sources.siteUrl));
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
    'No credentials are held by this server: publish.sh resolves them with ' +
      '`aws configure export-credentials`, so only the profile *name* is configured here.',
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
    canPublish:
      passed('publish.sh') &&
      passed('aws') &&
      passed('jq') &&
      passed('bash') &&
      passed('curl --aws-sigv4') &&
      passed('aws credentials') &&
      passed('apiUrl'),
    notes,
  };
}
