/**
 * Configuration resolution for the MCP server.
 *
 * The precedence chain is the whole point of tools/mcp/config.ts — a setting that
 * silently loses to another layer is the kind of bug that gets debugged against
 * the wrong AWS account — so each layer is pinned here, along with the guardrails
 * (`allowedPaths`, `allowPublish`, `enabledTools`) a harness is handed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  accountFromArn,
  activeTools,
  ConfigError,
  findChrome,
  isInside,
  loadConfig,
  PathError,
  readOutput,
  resolveUserPath,
  TOOL_NAMES,
} from '../tools/mcp/config';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threed-mcp-config-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A repo-root stand-in: nothing exists in it unless a test writes it. */
const load = (env: Record<string, string | undefined> = {}) =>
  loadConfig({ env: { PATH: '', ...env }, repoRoot: dir });

const writeConfig = (contents: unknown): string => {
  const file = path.join(dir, 'mcp-config.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
};

describe('defaults', () => {
  it('hangs the script and outputs paths off the repo root', () => {
    const { values, sources } = load();
    expect(values.exportScript).toBe(path.join(dir, 'tools', 'freecad_export_glb.py'));
    expect(values.outputsFile).toBe(path.join(dir, 'cdk-outputs.json'));
    expect(sources.exportScript).toBe('default');
  });

  it('verifies after publishing, with a per-request deadline', () => {
    const { values } = load();
    expect(values.verifyAfterPublish).toBe(true);
    expect(values.httpTimeoutSeconds).toBe(30);
  });

  it('defaults the region to us-east-1 and reports no endpoints', () => {
    const { values } = load();
    expect(values.awsRegion).toBe('us-east-1');
    expect(values.apiUrl).toBeNull();
    expect(values.siteUrl).toBeNull();
  });

  it('takes the model cap from the Lambda rather than a local copy', () => {
    // Kept identical on purpose: a friendlier local limit would reject files the
    // deployment accepts, or worse, accept files it rejects.
    expect(load().values.maxModelBytes).toBe(100 * 1024 * 1024);
  });

  it('falls back to the ambient AWS_PROFILE', () => {
    const { values, sources } = load({ AWS_PROFILE: 'ambient' });
    expect(values.awsProfile).toBe('ambient');
    expect(sources.awsProfile).toBe('default');
  });
});

describe('render_view settings', () => {
  it('gives the render its own, longer deadline', () => {
    expect(load().values.renderTimeoutSeconds).toBe(60);
    expect(load({ THREED_RENDER_TIMEOUT_SECONDS: '90' }).values.renderTimeoutSeconds).toBe(90);
    expect(() => load({ THREED_RENDER_TIMEOUT_SECONDS: 'soon' })).toThrow(ConfigError);
  });

  it('takes THREED_CHROME_PATH over the config file, and reports where it came from', () => {
    const file = writeConfig({ chromePath: '/opt/from-file/chrome' });
    const fromFile = load({ THREED_CONFIG: file });
    expect(fromFile.values.chromePath).toBe('/opt/from-file/chrome');
    expect(fromFile.sources.chromePath).toBe('file');
    const fromEnv = load({ THREED_CONFIG: file, THREED_CHROME_PATH: '/opt/from-env/chrome' });
    expect(fromEnv.values.chromePath).toBe('/opt/from-env/chrome');
    expect(fromEnv.sources.chromePath).toBe('env');
  });

  it('looks on PATH first, then the usual install locations, and settles for null', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'chromium'), '', { mode: 0o755 });
    expect(findChrome({ PATH: bin }, () => false)).toBe(path.join(bin, 'chromium'));
    expect(findChrome({ PATH: '' }, (f) => f === '/usr/bin/chromium')).toBe('/usr/bin/chromium');
    expect(findChrome({ PATH: '' }, () => false)).toBeNull();
  });
});

describe('precedence', () => {
  it('reads the endpoints out of a CDK outputs file, whatever the stack is called', () => {
    fs.writeFileSync(
      path.join(dir, 'cdk-outputs.json'),
      JSON.stringify({ SomeStackName: { ApiUrl: 'https://api.example/', SiteUrl: 'https://site.example' } }),
    );
    const { values, sources } = load();
    expect(values.apiUrl).toBe('https://api.example'); // trailing slash trimmed
    expect(values.siteUrl).toBe('https://site.example');
    expect(sources.apiUrl).toBe('outputs');
  });

  it('lets the config file beat the outputs file', () => {
    fs.writeFileSync(
      path.join(dir, 'cdk-outputs.json'),
      JSON.stringify({ Stack: { ApiUrl: 'https://from-outputs' } }),
    );
    const { values, sources } = load({ THREED_CONFIG: writeConfig({ apiUrl: 'https://from-file' }) });
    expect(values.apiUrl).toBe('https://from-file');
    expect(sources.apiUrl).toBe('file');
  });

  it('lets the environment beat the config file', () => {
    const { values, sources } = load({
      THREED_CONFIG: writeConfig({ apiUrl: 'https://from-file', awsProfile: 'from-file' }),
      THREED_API_URL: 'https://from-env',
    });
    expect(values.apiUrl).toBe('https://from-env');
    expect(sources.apiUrl).toBe('env');
    // The key the environment did not set still comes from the file.
    expect(values.awsProfile).toBe('from-file');
    expect(sources.awsProfile).toBe('file');
  });

  it('treats an empty environment variable as unset', () => {
    const { values, sources } = load({
      THREED_CONFIG: writeConfig({ awsProfile: 'from-file' }),
      THREED_AWS_PROFILE: '',
    });
    expect(values.awsProfile).toBe('from-file');
    expect(sources.awsProfile).toBe('file');
  });

  it('ignores a null in the config file so the lower layers still apply', () => {
    const { values, sources } = load({ THREED_CONFIG: writeConfig({ apiUrl: null }) });
    expect(values.apiUrl).toBeNull();
    expect(sources.apiUrl).toBe('default');
  });
});

describe('rejecting bad configuration', () => {
  it('names an unknown config-file key instead of ignoring it', () => {
    expect(() => load({ THREED_CONFIG: writeConfig({ awsProfle: 'typo' }) })).toThrow(ConfigError);
    expect(() => load({ THREED_CONFIG: writeConfig({ awsProfle: 'typo' }) })).toThrow(/awsProfle/);
  });

  // A setting that was real last week deserves better than being listed among
  // typos: the message has to say what replaced it.
  it('explains a setting that no longer exists, in the file and in the env', () => {
    expect(() => load({ THREED_CONFIG: writeConfig({ publishScript: '/old/publish.sh' }) })).toThrow(
      /publishScript is no longer a setting.*publish\.sh/s,
    );
    expect(() => load({ THREED_PUBLISH_SCRIPT: '/old/publish.sh' })).toThrow(
      /THREED_PUBLISH_SCRIPT is no longer a setting/,
    );
  });

  it('accepts _-prefixed comment keys', () => {
    expect(() =>
      load({ THREED_CONFIG: writeConfig({ _readme: 'notes', _readme_aws: ['a'], awsProfile: 'p' }) }),
    ).not.toThrow();
  });

  it('rejects a number that is not one, and one that is out of range', () => {
    expect(() => load({ THREED_PUBLISH_TIMEOUT_SECONDS: 'soon' })).toThrow(/must be a number/);
    expect(() => load({ THREED_PUBLISH_TIMEOUT_SECONDS: '0' })).toThrow(/at least 1/);
  });

  it('rejects a non-boolean flag', () => {
    expect(() => load({ THREED_ALLOW_PUBLISH: 'maybe' })).toThrow(/must be a boolean/);
  });

  it('rejects an unknown tool name', () => {
    expect(() => load({ THREED_ENABLED_TOOLS: 'inspect_glb,delete_everything' })).toThrow(
      /unknown tool\(s\) delete_everything/,
    );
  });

  it('complains when THREED_CONFIG points at nothing', () => {
    expect(() => load({ THREED_CONFIG: path.join(dir, 'absent.json') })).toThrow(/does not exist/);
  });

  it('complains about a config file that is not JSON', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{not json');
    expect(() => load({ THREED_CONFIG: file })).toThrow(/not valid JSON/);
  });

  it('survives an unreadable outputs file rather than refusing to start', () => {
    // A half-written cdk-outputs.json must not stop an export from working; the
    // problem is reported by check_setup instead of thrown at startup.
    fs.writeFileSync(path.join(dir, 'cdk-outputs.json'), '{');
    const loaded = load();
    expect(loaded.values.apiUrl).toBeNull();
    expect(loaded.outputsFile).toBeNull();
    expect(loaded.outputsProblem).toMatch(/not valid JSON/);
  });
});

describe('readOutput', () => {
  const outputs = { Stack: { ApiUrl: 'https://a' }, Other: { Nested: { SiteUrl: 'https://b' } } };

  it('finds a key one level down, like publish.sh does', () => {
    expect(readOutput(outputs, 'ApiUrl')).toBe('https://a');
  });

  it('finds a key nested deeper', () => {
    expect(readOutput(outputs, 'SiteUrl')).toBe('https://b');
  });

  it('returns null for a missing key or a non-object', () => {
    expect(readOutput(outputs, 'Nope')).toBeNull();
    expect(readOutput(undefined, 'ApiUrl')).toBeNull();
  });
});

describe('the deployment account', () => {
  it('is recovered from the PublishRouteArn output, so a wrong profile is catchable', () => {
    // Valid credentials for the wrong account otherwise surface only as an opaque
    // 403 from execute-api's IAM authorizer. An ambient AWS_PROFILE in the shell
    // is the usual way to end up there.
    fs.writeFileSync(
      path.join(dir, 'cdk-outputs.json'),
      JSON.stringify({
        Stack: {
          PublishRouteArn: 'arn:aws:execute-api:us-east-1:050752618305:k3rem8bbp7/*/POST/publish',
        },
      }),
    );
    expect(load().deploymentAccount).toBe('050752618305');
  });

  it('is null when the outputs file has no such output', () => {
    expect(load().deploymentAccount).toBeNull();
  });

  it('parses an account only out of a well-formed ARN', () => {
    expect(accountFromArn('arn:aws:s3:us-east-1:123456789012:thing')).toBe('123456789012');
    expect(accountFromArn('arn:aws:s3:::bucket')).toBeNull();
    expect(accountFromArn('not-an-arn')).toBeNull();
    expect(accountFromArn(null)).toBeNull();
  });
});

describe('the tool surface', () => {
  it('registers everything by default', () => {
    expect(activeTools(load().values).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('drops the publishing tools when allowPublish is off', () => {
    const tools = activeTools(load({ THREED_ALLOW_PUBLISH: 'false' }).values);
    expect(tools).not.toContain('publish_model');
    expect(tools).not.toContain('convert_and_publish');
    expect(tools).toContain('inspect_glb');
    // The read tools write nothing, so a read-only harness keeps them.
    expect(tools).toEqual(
      expect.arrayContaining(['list_revisions', 'get_publish_status', 'get_feedback', 'verify_revision', 'render_view']),
    );
  });

  it('narrows to enabledTools, and still honours allowPublish', () => {
    expect(activeTools(load({ THREED_ENABLED_TOOLS: 'inspect_glb, check_setup' }).values)).toEqual([
      'inspect_glb',
      'check_setup',
    ]);
    expect(
      activeTools(load({ THREED_ENABLED_TOOLS: 'inspect_glb,publish_model', THREED_ALLOW_PUBLISH: '0' }).values),
    ).toEqual(['inspect_glb']);
  });
});

describe('resolveUserPath', () => {
  it('resolves a relative path and enforces the extension', () => {
    const cfg = load().values;
    expect(resolveUserPath('model.glb', cfg, { extensions: ['.glb'] })).toBe(
      path.resolve('model.glb'),
    );
    expect(() => resolveUserPath('model.stl', cfg, { extensions: ['.glb'], label: 'glb' })).toThrow(
      /glb must end in \.glb/,
    );
  });

  it('accepts either case of .FCStd', () => {
    const cfg = load().values;
    expect(() => resolveUserPath('/tmp/A.FCStd', cfg, { extensions: ['.fcstd'] })).not.toThrow();
    expect(() => resolveUserPath('/tmp/a.fcstd', cfg, { extensions: ['.fcstd'] })).not.toThrow();
  });

  it('expands a leading ~, since no shell will', () => {
    const cfg = load().values;
    expect(resolveUserPath('~/parts/a.glb', cfg)).toBe(path.join(os.homedir(), 'parts', 'a.glb'));
  });

  it('confines paths to allowedPaths when it is set', () => {
    const cfg = load({ THREED_ALLOWED_PATHS: `${dir}${path.delimiter}/nowhere` }).values;
    expect(resolveUserPath(path.join(dir, 'sub', 'a.glb'), cfg)).toBe(path.join(dir, 'sub', 'a.glb'));
    expect(() => resolveUserPath('/etc/passwd.glb', cfg)).toThrow(PathError);
    expect(() => resolveUserPath('/etc/passwd.glb', cfg)).toThrow(/outside the configured allowedPaths/);
  });

  it('cannot be escaped with ..', () => {
    const cfg = load({ THREED_ALLOWED_PATHS: path.join(dir, 'models') }).values;
    expect(() => resolveUserPath(path.join(dir, 'models', '..', 'secret.glb'), cfg)).toThrow(PathError);
  });

  it('rejects an empty path', () => {
    expect(() => resolveUserPath('   ', load().values, { label: 'glb' })).toThrow(/glb is required/);
  });
});

describe('isInside', () => {
  it('respects path boundaries', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });
});
