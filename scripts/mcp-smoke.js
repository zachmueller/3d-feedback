#!/usr/bin/env node
/**
 * End-to-end smoke test for the MCP server, over real stdio.
 *
 *   npm run mcp:smoke [-- --verbose]
 *
 * It spawns the server exactly the way `npm run mcp` does, speaks JSON-RPC by
 * hand (no MCP client library, so nothing is being tested through the same code
 * that implements it), and checks the three things a harness depends on:
 *
 *  1. the handshake completes and the expected tools are advertised;
 *  2. check_setup answers, and says whether publishing is actually wired up;
 *  3. inspect_glb reports the sample model's parts panel correctly — three parts
 *     with `ref_Wall Panel` switched off, matching what the viewer would render;
 *  4. list_revisions reaches the deployed site and reports an absent project as
 *     "nothing published" rather than as an error;
 *  5. stdout carried nothing but JSON-RPC. A stray console.log anywhere in the
 *     server or its dependencies would corrupt the protocol, and this is the only
 *     place that would notice.
 *
 * THREED_DRY_RUN is forced on: nothing here should ever reserve a revision.
 */
const { execFileSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const verbose = process.argv.includes('--verbose');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

// --- the sample model, rebuilt so a stale one cannot pass -------------------
const samplePath = path.join(os.tmpdir(), '3d-feedback-mcp-smoke.glb');
execFileSync(process.execPath, [path.join(root, 'scripts', 'make-sample-glb.js'), samplePath], {
  stdio: verbose ? 'inherit' : 'ignore',
});

// --- spawn the server -------------------------------------------------------
const child = spawn(
  path.join(root, 'node_modules', '.bin', 'ts-node'),
  ['--prefer-ts-exts', '--project', 'tools/mcp/tsconfig.json', 'tools/mcp/server.ts'],
  {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, THREED_DRY_RUN: '1' },
  },
);

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  if (verbose) process.stderr.write(chunk);
});

/** Newline-delimited JSON, which is what the stdio transport speaks. */
const pending = new Map();
const nonJsonStdout = [];
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      nonJsonStdout.push(line);
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 90_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const textOf = (response) =>
  (response.result?.content ?? []).map((part) => part.text ?? '').join('\n');

(async () => {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0' },
  });
  check('initialize', Boolean(init.result?.serverInfo?.name), JSON.stringify(init.error ?? {}));
  check(
    'server identifies itself',
    init.result?.serverInfo?.name === 'threed-host',
    init.result?.serverInfo?.name,
  );
  check(
    'instructions mention the revision rule',
    /never reused/.test(init.result?.instructions ?? ''),
    'instructions missing',
  );
  notify('notifications/initialized', {});

  const listed = await request('tools/list', {});
  const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = [
    'check_setup',
    'convert_and_publish',
    'export_glb',
    'get_feedback',
    'get_publish_status',
    'gui_export_instructions',
    'inspect_glb',
    'list_revisions',
    'publish_model',
    'verify_revision',
  ];
  check(
    `tools/list returns all ${expected.length} tools`,
    names.join(',') === expected.join(','),
    names.join(','),
  );

  const setup = await request('tools/call', { name: 'check_setup', arguments: {} });
  const setupText = textOf(setup);
  check('check_setup answers', !setup.result?.isError, setupText.slice(0, 400));
  check('check_setup reports export readiness', /Headless export: /.test(setupText));
  check('check_setup reports publish readiness', /Publishing: /.test(setupText));
  if (verbose) console.log(`\n${setupText}\n`);
  else {
    for (const line of setupText.split('\n')) {
      if (/^(Headless export|Publishing|FAIL|Tools registered)/.test(line)) console.log(`      ${line}`);
    }
  }

  const inspect = await request('tools/call', {
    name: 'inspect_glb',
    arguments: { glb: samplePath },
  });
  const inspectText = textOf(inspect);
  check('inspect_glb answers', !inspect.result?.isError, inspectText.slice(0, 400));
  check('inspect_glb finds three parts', /3 checkboxes/.test(inspectText), inspectText.slice(0, 200));
  check(
    'inspect_glb marks the reference part and switches it off',
    /\[ \] Wall Panel \(reference\)/.test(inspectText),
    inspectText.slice(0, 400),
  );
  check(
    'inspect_glb leaves printed parts switched on',
    /\[x\] Base Plate/.test(inspectText) && /\[x\] Clip Arm/.test(inspectText),
  );
  if (verbose) console.log(`\n${inspectText}\n`);

  const bad = await request('tools/call', {
    name: 'inspect_glb',
    arguments: { glb: path.join(root, 'package.json') },
  });
  check(
    'a non-.glb argument is rejected as a tool error',
    bad.result?.isError === true && /must end in \.glb/.test(textOf(bad)),
    textOf(bad).slice(0, 200),
  );

  // One real read against the deployment: a project that cannot exist (the slug is
  // valid, so this exercises the request rather than the validator). It reserves
  // nothing and uploads nothing, and it is the only check here that needs network.
  const missing = await request('tools/call', {
    name: 'list_revisions',
    arguments: { project: 'smoke-test-no-such-project' },
  });
  const missingText = textOf(missing);
  check(
    'list_revisions reads the site and reports an absent project',
    !missing.result?.isError && /Nothing published under/.test(missingText),
    missingText.slice(0, 300),
  );

  check(
    'stdout carried only JSON-RPC',
    nonJsonStdout.length === 0,
    nonJsonStdout.slice(0, 3).join(' | '),
  );

  child.stdin.end();
  child.kill();

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
    if (!verbose && stderr.trim()) console.log(`\nserver stderr:\n${stderr.trim()}`);
    process.exit(1);
  }
  console.log('all checks passed');
})().catch((err) => {
  console.error(`smoke test error: ${err.message}`);
  if (stderr.trim()) console.error(`\nserver stderr:\n${stderr.trim()}`);
  child.kill();
  process.exit(1);
});
