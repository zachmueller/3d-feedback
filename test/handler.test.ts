/**
 * Unit tests for the pure logic in the Lambda handler — slug and revision
 * validation, GLB sniffing, text sanitizing, revision reservation, and manifest
 * projection. No AWS mocking; nothing here touches S3.
 */
import {
  RESERVED_SLUGS,
  MAX_COMMENT_TEXT_LEN,
  normalizeSlug,
  isReservedSlug,
  parseRevision,
  looksLikeGlb,
  sanitizeText,
  optionalText,
  sanitizeFilename,
  emptyMetadata,
  newProject,
  computeLatest,
  reserveRevision,
  buildManifest,
  parseUploadKey,
  validateComment,
  isPreconditionError,
  modelKey,
  uploadKey,
  manifestKey,
  commentsKey,
  statusKey,
  actionFromPath,
  handler,
  type Metadata,
} from '../lib/lambda/handler';

// --- helpers ----------------------------------------------------------------

const NOW = '2026-08-25T12:00:00.000Z';

function glbHeader(version = 2, magic = 'glTF'): Uint8Array {
  const bytes = new Uint8Array(12);
  for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
  bytes[4] = version & 0xff;
  bytes[5] = (version >> 8) & 0xff;
  bytes[6] = (version >> 16) & 0xff;
  bytes[7] = (version >> 24) & 0xff;
  return bytes;
}

/** A project with `count` ready revisions, numbered from 1. */
function projectWith(count: number) {
  const meta = emptyMetadata();
  for (let i = 0; i < count; i++) {
    const rev = reserveRevision(meta, 'towel-clip', { now: NOW });
    const entry = meta.projects['towel-clip'].revisions[String(rev)];
    entry.status = 'ready';
    entry.publishedAt = NOW;
  }
  meta.projects['towel-clip'].latest = computeLatest(meta.projects['towel-clip']);
  return meta;
}

// --- slugs ------------------------------------------------------------------

describe('normalizeSlug', () => {
  it.each([
    ['towel-clip', 'towel-clip'],
    ['  Towel-Clip  ', 'towel-clip'],
    ['a', 'a'],
    ['part2', 'part2'],
    ['a'.repeat(64), 'a'.repeat(64)],
  ])('accepts %s', (input, expected) => {
    expect(normalizeSlug(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['has space', 'space'],
    ['has_underscore', 'underscore'],
    ['has/slash', 'slash'],
    ['../escape', 'path traversal'],
    ['a'.repeat(65), 'too long'],
    ['emoji✨', 'non-ascii'],
  ])('rejects %s (%s)', (input) => {
    expect(() => normalizeSlug(input)).toThrow();
  });

  // A slug is the first path segment of every share URL, so one that collides
  // with a CloudFront behavior or key prefix would shadow the real route.
  it('rejects every reserved slug', () => {
    for (const reserved of RESERVED_SLUGS) {
      if (!/^[a-z0-9-]+$/.test(reserved)) continue; // e.g. favicon.ico can't be a slug anyway
      expect(isReservedSlug(reserved)).toBe(true);
      expect(() => normalizeSlug(reserved)).toThrow(/reserved/);
    }
  });

  it('covers the top-level prefixes the stack actually serves', () => {
    for (const prefix of ['app', 'viewer', 'projects', 'comments', 'status', 'login', 'admin']) {
      expect(RESERVED_SLUGS).toContain(prefix);
    }
  });
});

describe('parseRevision', () => {
  it.each([
    [1, 1],
    ['3', 3],
    [' 42 ', 42],
  ])('accepts %s', (input, expected) => {
    expect(parseRevision(input)).toBe(expected);
  });

  it.each([[0], [-1], [1.5], ['abc'], [''], [null], [undefined], [1e10]])(
    'rejects %s',
    (input) => {
      expect(() => parseRevision(input)).toThrow();
    },
  );
});

// --- GLB sniffing -----------------------------------------------------------

describe('looksLikeGlb', () => {
  it('accepts a glTF 2.0 binary header', () => {
    expect(looksLikeGlb(glbHeader(2))).toBe(true);
  });

  it.each([
    ['glTF 1.0', glbHeader(1)],
    ['a zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['a .gltf JSON file', new Uint8Array(Buffer.from('{"asset":{"ver'))],
    ['an STL header', new Uint8Array(Buffer.from('solid towelclip'))],
    ['a truncated header', glbHeader(2).slice(0, 8)],
    ['nothing', new Uint8Array()],
  ])('rejects %s', (_label, bytes) => {
    expect(looksLikeGlb(bytes)).toBe(false);
  });
});

// --- text handling ----------------------------------------------------------

describe('sanitizeText', () => {
  it('keeps ordinary text intact, including spaces', () => {
    expect(sanitizeText('raised the clip angle 5 degrees', 100)).toBe(
      'raised the clip angle 5 degrees',
    );
  });

  it('keeps newlines and tabs but drops other control characters', () => {
    expect(sanitizeText('a\nb\tc\u0000\u0007d\u007f', 100)).toBe('a\nb\tcd');
  });

  it('normalizes CRLF', () => {
    expect(sanitizeText('a\r\nb\rc', 100)).toBe('a\nb\nc');
  });

  it('trims and caps length', () => {
    expect(sanitizeText('   padded   ', 100)).toBe('padded');
    expect(sanitizeText('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });
});

describe('optionalText', () => {
  it('maps absent and empty values to null', () => {
    expect(optionalText(undefined, 10)).toBeNull();
    expect(optionalText(null, 10)).toBeNull();
    expect(optionalText('   ', 10)).toBeNull();
  });

  it('passes through real content', () => {
    expect(optionalText(' hi ', 10)).toBe('hi');
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['model.glb', 'model.glb'],
    ['/etc/passwd', 'passwd'],
    ['../../escape.glb', 'escape.glb'],
    ['C:\\models\\part.glb', 'part.glb'],
    ['weird name!.glb', 'weird_name_.glb'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });
});

describe('validateComment', () => {
  it('defaults a missing name', () => {
    expect(validateComment({ text: 'looks good' })).toEqual({
      name: 'Anonymous',
      text: 'looks good',
    });
  });

  it('accepts the `comment` field name as well as `text`', () => {
    expect(validateComment({ comment: 'from the viewer form' }).text).toBe(
      'from the viewer form',
    );
  });

  it('requires some text', () => {
    expect(() => validateComment({ text: '   ' })).toThrow(/required/);
    expect(() => validateComment({})).toThrow(/required/);
  });

  it('caps a very long comment rather than rejecting it', () => {
    const { text } = validateComment({ text: 'x'.repeat(MAX_COMMENT_TEXT_LEN + 500) });
    expect(text).toHaveLength(MAX_COMMENT_TEXT_LEN);
  });
});

// --- revisions --------------------------------------------------------------

describe('reserveRevision', () => {
  it('creates the project on first publish and starts at 1', () => {
    const meta = emptyMetadata();
    expect(reserveRevision(meta, 'towel-clip', { now: NOW })).toBe(1);
    expect(meta.projects['towel-clip'].nextRev).toBe(2);
    expect(meta.projects['towel-clip'].revisions['1'].status).toBe('processing');
  });

  it('hands out increasing numbers', () => {
    const meta = emptyMetadata();
    const revs = [1, 2, 3].map(() => reserveRevision(meta, 'towel-clip', { now: NOW }));
    expect(revs).toEqual([1, 2, 3]);
  });

  it('records the title and notes it was given', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', {
      now: NOW,
      title: 'Towel clip',
      notes: 'wider hook',
      filename: 'clip.glb',
    });
    expect(meta.projects['towel-clip'].title).toBe('Towel clip');
    expect(meta.projects['towel-clip'].revisions['1'].notes).toBe('wider hook');
    expect(meta.projects['towel-clip'].revisions['1'].filename).toBe('clip.glb');
  });

  it('leaves an existing title alone when none is supplied', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW, title: 'Towel clip' });
    reserveRevision(meta, 'towel-clip', { now: NOW });
    expect(meta.projects['towel-clip'].title).toBe('Towel clip');
  });

  // Revision numbers key both the share URL and a 1-year immutable cache entry,
  // so a reused number would serve stale geometry from the CDN.
  it('never reuses the number of a deleted revision', () => {
    const meta = projectWith(3);
    delete meta.projects['towel-clip'].revisions['3'];
    expect(reserveRevision(meta, 'towel-clip', { now: NOW })).toBe(4);
  });

  it('never reuses the number of a failed revision', () => {
    const meta = emptyMetadata();
    const rev = reserveRevision(meta, 'towel-clip', { now: NOW });
    meta.projects['towel-clip'].revisions[String(rev)].status = 'error';
    expect(reserveRevision(meta, 'towel-clip', { now: NOW })).toBe(2);
  });
});

describe('computeLatest', () => {
  it('is null before anything is published', () => {
    expect(computeLatest(newProject('towel-clip', NOW))).toBeNull();
  });

  it('ignores revisions that are still processing or failed', () => {
    const meta = projectWith(2);
    const project = meta.projects['towel-clip'];
    reserveRevision(meta, 'towel-clip', { now: NOW }); // rev 3, processing
    const rev4 = reserveRevision(meta, 'towel-clip', { now: NOW });
    project.revisions[String(rev4)].status = 'error';
    expect(computeLatest(project)).toBe(2);
  });

  it('falls back to an earlier revision when the newest one is deleted', () => {
    const meta = projectWith(3);
    delete meta.projects['towel-clip'].revisions['3'];
    expect(computeLatest(meta.projects['towel-clip'])).toBe(2);
  });
});

describe('buildManifest', () => {
  it('exposes only ready revisions, in ascending order', () => {
    const meta = projectWith(2);
    reserveRevision(meta, 'towel-clip', { now: NOW }); // rev 3 still processing
    const manifest = buildManifest(meta.projects['towel-clip']);
    expect(manifest.revisions.map((r) => r.rev)).toEqual([1, 2]);
    expect(manifest.latest).toBe(2);
  });

  it('carries what the viewer renders and nothing more', () => {
    const meta = projectWith(1);
    const entry = meta.projects['towel-clip'].revisions['1'];
    entry.notes = 'wider hook';
    entry.bytes = 2048;
    entry.commentCount = 2;
    entry.error = 'should not be published';
    entry.filename = 'private-name.glb';

    const [revision] = buildManifest(meta.projects['towel-clip']).revisions;
    expect(revision).toEqual({
      rev: 1,
      publishedAt: NOW,
      notes: 'wider hook',
      bytes: 2048,
      commentCount: 2,
    });
  });

  it('is empty but valid for a project whose only publish failed', () => {
    const meta = emptyMetadata();
    const rev = reserveRevision(meta, 'towel-clip', { now: NOW });
    meta.projects['towel-clip'].revisions[String(rev)].status = 'error';
    const manifest = buildManifest(meta.projects['towel-clip']);
    expect(manifest.revisions).toEqual([]);
    expect(manifest.latest).toBeNull();
  });
});

// --- keys -------------------------------------------------------------------

describe('object keys', () => {
  it('are built consistently', () => {
    expect(modelKey('towel-clip', 3)).toBe('towel-clip/3/model.glb');
    expect(uploadKey('towel-clip', 3)).toBe('uploads/towel-clip/3/model.glb');
    expect(manifestKey('towel-clip')).toBe('projects/towel-clip.json');
    expect(commentsKey('towel-clip', 3)).toBe('comments/towel-clip/3.json');
    expect(statusKey('towel-clip', 3)).toBe('status/towel-clip/3.json');
  });
});

describe('parseUploadKey', () => {
  it('round-trips the key the publish action signs', () => {
    expect(parseUploadKey(uploadKey('towel-clip', 7))).toEqual({
      slug: 'towel-clip',
      rev: 7,
    });
  });

  it('handles the form-encoded key S3 puts in an event', () => {
    expect(parseUploadKey('uploads/towel-clip/7/model.glb')).toEqual({
      slug: 'towel-clip',
      rev: 7,
    });
  });

  // The processor writes to <slug>/<rev>/ in the assets bucket, so a key that
  // decodes to anything unexpected must not be trusted with a path.
  it.each([
    ['not-uploads/towel-clip/1/model.glb', 'wrong prefix'],
    ['uploads/towel-clip/model.glb', 'no revision'],
    ['uploads/towel-clip/abc/model.glb', 'non-numeric revision'],
    ['uploads/towel-clip/0/model.glb', 'zero revision'],
    ['uploads/..%2F..%2Fetc/1/model.glb', 'traversal in the slug'],
    ['uploads/admin/1/model.glb', 'reserved slug'],
    ['uploads//1/model.glb', 'empty slug'],
  ])('rejects %s (%s)', (key) => {
    expect(parseUploadKey(key)).toBeNull();
  });
});

// --- misc -------------------------------------------------------------------

describe('actionFromPath', () => {
  it('reads the action off an HTTP API event', () => {
    expect(actionFromPath({ requestContext: { http: { path: '/publish' } } })).toBe('publish');
    expect(actionFromPath({ rawPath: '/comment' })).toBe('comment');
    expect(actionFromPath({})).toBe('');
  });
});

describe('isPreconditionError', () => {
  it('recognizes the conditional-write conflicts worth retrying', () => {
    expect(isPreconditionError({ name: 'PreconditionFailed' })).toBe(true);
    expect(isPreconditionError({ name: 'ConditionalRequestConflict' })).toBe(true);
    expect(isPreconditionError({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    expect(isPreconditionError({ $metadata: { httpStatusCode: 409 } })).toBe(true);
  });

  it('does not swallow other failures', () => {
    expect(isPreconditionError({ name: 'AccessDenied' })).toBe(false);
    expect(isPreconditionError({ $metadata: { httpStatusCode: 500 } })).toBe(false);
  });
});

describe('request authorization', () => {
  // The allowlist check runs before any S3 access, so these paths need no AWS
  // mocking. `publish` is authorized by SigV4 and `comment` is public, so
  // neither is expected to carry an email — only the admin actions are gated.
  const event = (path: string, email?: string) => ({
    requestContext: {
      http: { path },
      ...(email ? { authorizer: { jwt: { claims: { email } } } } : {}),
    },
    body: '{}',
  });

  const original = process.env.ALLOWED_EMAILS;
  beforeAll(() => {
    process.env.ALLOWED_EMAILS = 'me@example.com';
  });
  afterAll(() => {
    process.env.ALLOWED_EMAILS = original;
  });

  it.each(['list', 'edit', 'delete', 'feedback'])(
    'rejects %s from an email that is not on the allowlist',
    async (action) => {
      const res = await handler(event(`/${action}`, 'stranger@example.com'));
      expect(res.statusCode).toBe(403);
    },
  );

  it('rejects an admin action with no identity at all', async () => {
    expect((await handler(event('/list'))).statusCode).toBe(403);
  });

  it('matches the allowlist case-insensitively', async () => {
    // Not 403: it gets past the gate and fails later on missing env/S3.
    const res = await handler(event('/list', 'ME@Example.com'));
    expect(res.statusCode).not.toBe(403);
  });

  it('does not demand an email for publish or comment', async () => {
    for (const action of ['publish', 'comment']) {
      const res = await handler(event(`/${action}`));
      expect(res.statusCode).not.toBe(403);
    }
  });

  it('404s an unknown action', async () => {
    const res = await handler(event('/nonsense', 'me@example.com'));
    expect(res.statusCode).toBe(404);
  });

  it('answers a bad publish payload with a 400, not a 500', async () => {
    // `project` is missing, so validation rejects it before any S3 call.
    const res = await handler({
      requestContext: { http: { path: '/publish' } },
      body: JSON.stringify({ title: 'no project given' }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/project is required/);
  });

  it('answers a reserved project name with a 400', async () => {
    const res = await handler({
      requestContext: { http: { path: '/publish' } },
      body: JSON.stringify({ project: 'admin' }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/reserved/);
  });

  it('keeps internal failures generic instead of leaking configuration', async () => {
    // A valid request that then fails inside: with no bucket env vars present,
    // this is the shape of any internal misconfiguration.
    const res = await handler({
      requestContext: { http: { path: '/publish' } },
      body: JSON.stringify({ project: 'towel-clip' }),
    });
    expect(res.statusCode).toBe(500);
    const { error } = JSON.parse(res.body);
    expect(error).toBe('Something went wrong handling that request.');
    expect(error).not.toMatch(/BUCKET|env var/i);
  });
});

describe('metadata shape', () => {
  it('starts empty and stays JSON-round-trippable', () => {
    const meta: Metadata = projectWith(2);
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});
