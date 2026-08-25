/**
 * Tests for the default-behavior CloudFront viewer-request function.
 *
 * The source is plain ES5 for the CloudFront Functions runtime and has no module
 * exports, so it is read and evaluated here the same way the runtime loads it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function load(file: string) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'cloudfront-functions', file),
    'utf-8',
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${src}; return handler;`)() as (event: any) => Result;
}

type Result = {
  uri?: string;
  statusCode?: number;
  headers?: Record<string, { value: string }>;
};

const cleanUrl = load('clean-url.js');
const adminRewrite = load('admin-rewrite.js');

const req = (uri: string) => cleanUrl({ request: { uri, querystring: {} } });
const VIEWER = '/viewer/index.html';

describe('clean-url viewer-request function', () => {
  it('sends the site root to the admin login page', () => {
    const res = req('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location.value).toBe('/login');
  });

  describe('share URLs resolve to the single viewer SPA', () => {
    // The viewer reads the project and revision back out of location.pathname,
    // which is why the rewrite is internal: the address bar keeps the URL that
    // was actually shared.
    it.each([
      ['/towel-clip', 'project only'],
      ['/towel-clip/', 'project with a trailing slash'],
      ['/towel-clip/3', 'project and revision'],
      ['/towel-clip/3/', 'revision with a trailing slash'],
      ['/a', 'single-character slug'],
      ['/towel-clip/1234567', 'many-digit revision'],
    ])('%s (%s)', (uri) => {
      expect(req(uri).uri).toBe(VIEWER);
    });

    it('lowercases a slug that picked up capitalization', () => {
      // Rewritten to the viewer, and the viewer lowercases again from the path;
      // what matters here is that no redirect or 404 happens.
      expect(req('/Towel-Clip/3').uri).toBe(VIEWER);
    });
  });

  describe('real objects pass through', () => {
    it('leaves a model request alone', () => {
      // In production the *.glb behavior serves this and the function never
      // runs, but it must not be mangled if it does reach here.
      expect(req('/towel-clip/3/model.glb').uri).toBe('/towel-clip/3/model.glb');
    });

    it('lowercases the slug on an asset path', () => {
      expect(req('/Towel-Clip/3/model.glb').uri).toBe('/towel-clip/3/model.glb');
    });

    it('leaves a root-level file alone', () => {
      expect(req('/favicon.ico').uri).toBe('/favicon.ico');
    });
  });

  describe('anything else falls through to the origin', () => {
    // A non-numeric second segment is not a revision, so it must not silently
    // render the viewer for a URL that means nothing.
    it.each(['/towel-clip/latest', '/towel-clip/3/extra', '/a/b/c/d'])('%s', (uri) => {
      expect(req(uri).uri).not.toBe(VIEWER);
    });
  });
});

describe('admin-rewrite viewer-request function', () => {
  const rewrite = (uri: string) => adminRewrite({ request: { uri, querystring: {} } });

  it('maps /admin to the admin page', () => {
    expect(rewrite('/admin').uri).toBe('/app/admin.html');
  });

  it('tolerates a trailing slash', () => {
    expect(rewrite('/admin/').uri).toBe('/app/admin.html');
  });

  it('maps /login and anything unexpected to the login page', () => {
    expect(rewrite('/login').uri).toBe('/app/login.html');
    expect(rewrite('/whatever').uri).toBe('/app/login.html');
  });
});
