#!/usr/bin/env node
/**
 * Local preview server for the viewer and admin apps.
 *
 *   npm run dev            # http://localhost:8080/sample/1
 *
 * It stands in for CloudFront + S3 + the API so the front end can be worked on
 * without a deploy:
 *
 *  - URL routing runs the REAL lib/cloudfront-functions/*.js through the same
 *    contract CloudFront uses, so a routing change is exercised here first.
 *  - /projects, /comments and /status are served from an in-memory fixture
 *    seeded with a two-part sample model (scripts/make-sample-glb.js).
 *  - POST /comment appends to the in-memory thread, like the real handler.
 *
 * The admin app is served too, but its Cognito sign-in cannot work locally.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);

// --- load the real CloudFront functions -------------------------------------
function loadFunction(file) {
  const src = fs.readFileSync(path.join(root, 'lib', 'cloudfront-functions', file), 'utf-8');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return handler;`)();
}
const cleanUrl = loadFunction('clean-url.js');
const adminRewrite = loadFunction('admin-rewrite.js');

// --- fixture data ------------------------------------------------------------
const samplePath = path.join(require('os').tmpdir(), '3d-feedback-sample.glb');
if (!fs.existsSync(samplePath)) {
  execFileSync(process.execPath, [path.join(__dirname, 'make-sample-glb.js'), samplePath], {
    stdio: 'inherit',
  });
}

const publishedAt = new Date('2026-08-20T10:00:00Z').toISOString();
const fixtures = {
  manifests: {
    sample: {
      slug: 'sample',
      title: 'Sample bracket',
      latest: 2,
      revisions: [
        {
          rev: 1,
          publishedAt,
          notes: 'First pass — plate is 30 mm square.',
          bytes: fs.statSync(samplePath).size,
          commentCount: 1,
        },
        {
          rev: 2,
          publishedAt: new Date('2026-08-24T09:30:00Z').toISOString(),
          notes: 'Taller arm so the towel does not slip off.',
          bytes: fs.statSync(samplePath).size,
          commentCount: 0,
        },
      ],
    },
  },
  comments: {
    'sample/1': {
      comments: [
        { name: 'Brian', text: 'Arm feels short — can it be taller?', at: publishedAt },
      ],
    },
    'sample/2': { comments: [] },
  },
};

// --- static file helpers -----------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    fs.createReadStream(path.join(root, 'viewer-app', '404.html')).pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

/** Map a rewritten URI to a file, mirroring the assets-bucket key layout. */
function resolveKey(uri) {
  if (uri.startsWith('/viewer/')) return path.join(root, 'viewer-app', uri.slice('/viewer/'.length));
  if (uri.startsWith('/app/')) return path.join(root, 'admin-app', uri.slice('/app/'.length));
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const uri = decodeURIComponent(url.pathname);

  // The one API route the viewer calls.
  if (req.method === 'POST' && uri === '/comment') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      /* fall through to validation below */
    }
    const key = `${body.project}/${body.revision}`;
    const thread = fixtures.comments[key];
    if (!thread) return sendJson(res, 404, { error: 'No such revision' });
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'comment text is required' });
    thread.comments.push({
      name: String(body.name || '').trim() || 'Anonymous',
      text,
      at: new Date().toISOString(),
    });
    return sendJson(res, 200, { comments: thread.comments });
  }

  // Config objects the CDK synthesizes at deploy time.
  if (uri === '/viewer/config.json') {
    return sendJson(res, 200, { apiUrl: '', siteUrl: `http://localhost:${PORT}` });
  }
  if (uri === '/app/config.json') {
    return sendJson(res, 200, {
      userPoolId: 'local',
      userPoolClientId: 'local',
      hostedUiDomain: 'localhost',
      apiUrl: '',
      cloudFrontDomain: `localhost:${PORT}`,
      shareDomain: `localhost:${PORT}`,
    });
  }

  // Fixture data: manifests, comment threads, publish status.
  let match = uri.match(/^\/projects\/([^/]+)\.json$/);
  if (match) {
    const manifest = fixtures.manifests[match[1]];
    return manifest ? sendJson(res, 200, manifest) : sendJson(res, 404, { error: 'not found' });
  }
  match = uri.match(/^\/comments\/([^/]+)\/([0-9]+)\.json$/);
  if (match) {
    const thread = fixtures.comments[`${match[1]}/${match[2]}`];
    return thread ? sendJson(res, 200, thread) : sendJson(res, 404, { error: 'not found' });
  }
  match = uri.match(/^\/status\/([^/]+)\/([0-9]+)\.json$/);
  if (match) return sendJson(res, 200, { status: 'ready' });

  // The model itself.
  if (/^\/[^/]+\/[0-9]+\/model\.glb$/.test(uri)) return sendFile(res, samplePath);

  // Everything else goes through the real edge functions.
  const isAdminPath = uri === '/login' || uri === '/admin' || uri === '/login/' || uri === '/admin/';
  const fn = isAdminPath ? adminRewrite : cleanUrl;
  const request = { uri, querystring: {} };
  const result = fn({ request });

  if (result.statusCode) {
    res.writeHead(result.statusCode, { location: result.headers.location.value });
    return res.end();
  }

  const filePath = resolveKey(result.uri);
  if (!filePath) {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    return fs.createReadStream(path.join(root, 'viewer-app', '404.html')).pipe(res);
  }
  return sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`3d-feedback dev server on http://localhost:${PORT}`);
  console.log(`  viewer: http://localhost:${PORT}/sample/1  (and /sample, /sample/2)`);
  console.log(`  admin:  http://localhost:${PORT}/admin     (sign-in will not work locally)`);
});
