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
  normalizeContentHash,
  normalizeSource,
  SOURCE_SCHEMA,
  MAX_SOURCE_BUILD_LEN,
  MAX_SOURCE_RECREATE_LEN,
  MAX_SOURCE_REPO_LEN,
  findDuplicateRevision,
  revisionForResume,
  buildManifest,
  parsePage,
  pageOfProjects,
  feedbackTargets,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
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

/** Two distinct sha256 digests, as a publisher would declare them. */
const HASH_A = 'a'.repeat(64);
const HASH_B = `${'b'.repeat(63)}9`;

/** A sha1 commit and tree, as git writes them. */
const COMMIT = `${'a'.repeat(39)}1`;
const TREE = `${'b'.repeat(39)}2`;

/** The provenance a producer declares, before validation. */
const SOURCE = {
  schema: '3d-feedback/source@1',
  repo: '3d-models',
  commit: COMMIT,
  path: 'models/cloth-basket-small',
  build: 'make cloth-basket-small',
};

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

  it('records the content hash it was given', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW, contentHash: HASH_A });
    expect(meta.projects['towel-clip'].revisions['1'].contentHash).toBe(HASH_A);
  });

  it('records the source provenance it was given', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW, source: normalizeSource(SOURCE) });
    expect(meta.projects['towel-clip'].revisions['1'].source).toEqual({
      schema: SOURCE_SCHEMA,
      repo: '3d-models',
      commit: COMMIT,
      path: 'models/cloth-basket-small',
      build: 'make cloth-basket-small',
    });
  });

  it('leaves the source null when none is given', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW });
    expect(meta.projects['towel-clip'].revisions['1'].source).toBeNull();
  });
});

// --- source provenance -------------------------------------------------------

describe('normalizeSource', () => {
  it('treats absent as "not declared"', () => {
    expect(normalizeSource(undefined)).toBeNull();
    expect(normalizeSource(null)).toBeNull();
  });

  // A schema and nothing else describes nothing; recording it would put an empty
  // object into every manifest for no reader's benefit.
  it('treats a record with no field that has a value as "not declared"', () => {
    expect(normalizeSource({})).toBeNull();
    expect(normalizeSource({ schema: SOURCE_SCHEMA })).toBeNull();
    expect(normalizeSource({ schema: SOURCE_SCHEMA, repo: '   ', commit: '' })).toBeNull();
  });

  it('keeps the fields the contract defines and stamps the schema', () => {
    expect(normalizeSource({ repo: '3d-models', ref: 'main' })).toEqual({
      schema: SOURCE_SCHEMA,
      repo: '3d-models',
      ref: 'main',
    });
  });

  // Forward compatibility: a producer sending a field this deployment predates must
  // not have its whole record rejected.
  it('drops keys the contract does not define', () => {
    const source = normalizeSource({ repo: '3d-models', builtAt: 'now', nonsense: 1 });
    expect(source).toEqual({ schema: SOURCE_SCHEMA, repo: '3d-models' });
  });

  it('accepts a sha1 or a sha256 git oid, however cased', () => {
    expect(normalizeSource({ commit: COMMIT.toUpperCase() })?.commit).toBe(COMMIT);
    expect(normalizeSource({ commit: 'c'.repeat(64) })?.commit).toBe('c'.repeat(64));
    expect(normalizeSource({ tree: TREE })?.tree).toBe(TREE);
  });

  it.each([
    ['deadbeef', 'too short'],
    [`${COMMIT}00`, 'neither length'],
    [COMMIT.replace('a', 'z'), 'not hex'],
  ])('rejects commit %s (%s)', (commit) => {
    expect(() => normalizeSource({ commit })).toThrow(/source\.commit must be a git object id/);
  });

  it('names the field it rejected, so tree and commit are distinguishable', () => {
    expect(() => normalizeSource({ tree: 'nope' })).toThrow(/source\.tree/);
  });

  it('records dirty only when it is true', () => {
    expect(normalizeSource({ repo: 'r', dirty: true })?.dirty).toBe(true);
    expect(normalizeSource({ repo: 'r', dirty: 'true' })?.dirty).toBe(true);
    expect(normalizeSource({ repo: 'r', dirty: false })).not.toHaveProperty('dirty');
    expect(normalizeSource({ repo: 'r' })).not.toHaveProperty('dirty');
  });

  it('caps every string at its own limit', () => {
    const source = normalizeSource({
      repo: 'r'.repeat(MAX_SOURCE_REPO_LEN + 50),
      build: 'b'.repeat(MAX_SOURCE_BUILD_LEN + 50),
      recreate: 'x'.repeat(MAX_SOURCE_RECREATE_LEN + 500),
    });
    expect(source?.repo).toHaveLength(MAX_SOURCE_REPO_LEN);
    expect(source?.build).toHaveLength(MAX_SOURCE_BUILD_LEN);
    expect(source?.recreate).toHaveLength(MAX_SOURCE_RECREATE_LEN);
  });

  // It lands on a public page, so it goes through the same sanitizer as a comment.
  it('strips control characters and normalizes newlines', () => {
    const source = normalizeSource({ recreate: 'git clone x\r\nmake y ' });
    expect(source?.recreate).toBe('git clone x\nmake y');
  });

  it('rejects a schema it does not understand', () => {
    expect(() => normalizeSource({ schema: '3d-feedback/source@2', repo: 'r' })).toThrow(
      /source\.schema must be/,
    );
  });

  // On the wire the schema is optional — a human passing --source-commit is not
  // going to type one — and gets stamped with the current version.
  it('accepts a record with no schema and stamps the current one', () => {
    expect(normalizeSource({ repo: '3d-models' })?.schema).toBe(SOURCE_SCHEMA);
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['../../secrets', 'escapes the repo'],
    ['models/../../etc', 'escapes mid-path'],
    ['models\\win', 'backslash'],
  ])('rejects path %s (%s)', (path) => {
    expect(() => normalizeSource({ path })).toThrow(/repository-relative POSIX path/);
  });

  it('accepts an ordinary repo-relative path', () => {
    expect(normalizeSource({ path: 'models/cloth-basket-small' })?.path).toBe(
      'models/cloth-basket-small',
    );
  });

  it.each([
    'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/3d-models',
    'http://git.internal/3d-models.git',
    'ssh://git-codecommit.us-east-1.amazonaws.com/v1/repos/3d-models',
    'git://example.com/3d-models.git',
    'codecommit::us-east-1://3d-models',
    'git@github.com:zach/3d-models.git',
  ])('accepts clone URL %s', (cloneUrl) => {
    expect(normalizeSource({ cloneUrl })?.cloneUrl).toBe(cloneUrl);
  });

  // The viewer renders this as text and never as an href; the allowlist is what
  // keeps that true by construction rather than by everyone downstream remembering.
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>',
    'file:///etc/passwd',
    'not a url at all',
    // A valid scheme is not enough: sanitizeText trims the ends but keeps the middle.
    'https://example.com/a repo.git',
  ])('rejects clone URL %s', (cloneUrl) => {
    expect(() => normalizeSource({ cloneUrl })).toThrow(/source\.cloneUrl must be a clone URL/);
  });

  it('rejects a non-object', () => {
    for (const input of ['a string', 42, ['an', 'array']]) {
      expect(() => normalizeSource(input)).toThrow(/source must be an object/);
    }
  });
});

// --- retry safety -----------------------------------------------------------

describe('normalizeContentHash', () => {
  it('accepts a sha256 digest, however it is cased or padded', () => {
    expect(normalizeContentHash(HASH_A)).toBe(HASH_A);
    expect(normalizeContentHash(`  ${HASH_A.toUpperCase()}  `)).toBe(HASH_A);
  });

  it('treats absent and empty as "not declared"', () => {
    for (const input of [undefined, null, '', '   ']) {
      expect(normalizeContentHash(input)).toBeNull();
    }
  });

  it.each([
    ['deadbeef', 'too short'],
    [`${HASH_A}00`, 'too long'],
    [HASH_A.replace('a', 'z'), 'not hex'],
    ['sha256:' + HASH_A, 'prefixed'],
  ])('rejects %s (%s)', (input) => {
    expect(() => normalizeContentHash(input)).toThrow(/64 hexadecimal/);
  });
});

describe('findDuplicateRevision', () => {
  /** Two ready revisions, the older one carrying HASH_A and the newer HASH_B. */
  const twoHashed = () => {
    const meta = projectWith(2);
    const project = meta.projects['towel-clip'];
    project.revisions['1'].contentHash = HASH_A;
    project.revisions['2'].contentHash = HASH_B;
    return project;
  };

  it('matches the latest ready revision — the retry case', () => {
    expect(findDuplicateRevision(twoHashed(), HASH_B)?.rev).toBe(2);
  });

  // Re-publishing the geometry of an older revision is a deliberate revert, and
  // it deserves its own number rather than silently resolving to the old one.
  it('ignores a match on an earlier revision', () => {
    expect(findDuplicateRevision(twoHashed(), HASH_A)).toBeNull();
  });

  it('never matches without a hash on either side', () => {
    expect(findDuplicateRevision(twoHashed(), null)).toBeNull();
    expect(findDuplicateRevision(projectWith(1).projects['towel-clip'], HASH_A)).toBeNull();
  });

  // The latest *ready* revision, not the newest entry: a publish that is still
  // processing or that failed must not shadow the revision people can see.
  it('looks past a revision that is processing or failed', () => {
    const meta = projectWith(1);
    const project = meta.projects['towel-clip'];
    project.revisions['1'].contentHash = HASH_A;
    const rev = reserveRevision(meta, 'towel-clip', { now: NOW, contentHash: HASH_B });
    project.revisions[String(rev)].status = 'error';
    expect(findDuplicateRevision(project, HASH_A)?.rev).toBe(1);
    expect(findDuplicateRevision(project, HASH_B)).toBeNull();
  });

  it('finds nothing in a project with no ready revision at all', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW, contentHash: HASH_A });
    expect(findDuplicateRevision(meta.projects['towel-clip'], HASH_A)).toBeNull();
  });

  /**
   * The dedupe keys on the content hash alone, and declaring a different source
   * does not change that — so the same bytes with a new commit resolve to the
   * revision that already holds them and the new provenance is dropped, exactly as
   * a new title or new notes would be.
   *
   * This is pinned rather than fixed because it is the reason provenance travels
   * *inside* the .glb: extras are part of the bytes, so a rebuild from a different
   * commit is a different hash and never reaches this path at all. Only an explicit
   * `source` override can, and --force is the way out of it.
   */
  it('still matches on the hash alone when the declared source differs', () => {
    const meta = projectWith(1);
    const project = meta.projects['towel-clip'];
    project.revisions['1'].contentHash = HASH_A;
    project.revisions['1'].source = normalizeSource({ ...SOURCE, commit: COMMIT });
    // A publish of identical bytes that claims a different commit.
    expect(findDuplicateRevision(project, HASH_A)?.rev).toBe(1);
    expect(findDuplicateRevision(project, HASH_A)?.source?.commit).toBe(COMMIT);
  });
});

describe('revisionForResume', () => {
  it('accepts a revision that is still processing', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW });
    const check = revisionForResume(meta.projects['towel-clip'], 1);
    expect(check.ok && check.entry.rev).toBe(1);
  });

  it('accepts a revision whose processing failed', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW });
    meta.projects['towel-clip'].revisions['1'].status = 'error';
    expect(revisionForResume(meta.projects['towel-clip'], 1).ok).toBe(true);
  });

  it('404s on a number that was never reserved', () => {
    const check = revisionForResume(projectWith(1).projects['towel-clip'], 9);
    expect(check).toEqual({ ok: false, status: 404, error: expect.stringMatching(/never reserved/) });
  });

  // The model is served with a one-year immutable Cache-Control, so replacing
  // the bytes under a shared URL would leave the CDN serving the old ones.
  it('409s on a revision that is already published', () => {
    const check = revisionForResume(projectWith(1).projects['towel-clip'], 1);
    expect(check).toEqual({
      ok: false,
      status: 409,
      error: expect.stringMatching(/already published/),
    });
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

  // Every revision published before provenance existed carries none, and this
  // manifest is fetched on every share-page load — so the absent case has to produce
  // exactly the object it did before, not one with `source: null` bolted on. The
  // assertion above ("nothing more") is the other half of this.
  it('emits no source key at all for a revision that recorded none', () => {
    const meta = projectWith(1);
    const [revision] = buildManifest(meta.projects['towel-clip']).revisions;
    expect(revision).not.toHaveProperty('source');
  });

  it('carries the source provenance through to the viewer when there is one', () => {
    const meta = projectWith(1);
    meta.projects['towel-clip'].revisions['1'].source = normalizeSource(SOURCE);
    const [revision] = buildManifest(meta.projects['towel-clip']).revisions;
    expect(revision.source).toEqual({
      schema: SOURCE_SCHEMA,
      repo: '3d-models',
      commit: COMMIT,
      path: 'models/cloth-basket-small',
      build: 'make cloth-basket-small',
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

  // Proves normalizeSource runs inside the publish path, before any S3 access — so
  // a malformed provenance record is the caller's 400 rather than an internal 500.
  it('answers a malformed source with a 400 naming the field', async () => {
    const res = await handler({
      requestContext: { http: { path: '/publish' } },
      body: JSON.stringify({ project: 'towel-clip', source: { commit: 'not-a-commit' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/source\.commit must be a git object id/);
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

// --- paging -----------------------------------------------------------------

/**
 * `count` projects, each with `revisions` ready revisions, published a minute
 * further into the past for each project — so the expected newest-first order is
 * project-0, project-1, ... and the assertions below can name it.
 */
function projectsPublishedInOrder(count: number, revisions = 1): Metadata {
  const meta = emptyMetadata();
  for (let p = 0; p < count; p++) {
    const slug = `project-${p}`;
    for (let r = 0; r < revisions; r++) {
      const rev = reserveRevision(meta, slug, { now: NOW });
      const entry = meta.projects[slug].revisions[String(rev)];
      entry.status = 'ready';
      entry.publishedAt = new Date(Date.parse(NOW) - p * 60_000 + r * 1_000).toISOString();
    }
  }
  return meta;
}

describe('parsePage', () => {
  it('falls back to the defaults when the caller says nothing', () => {
    expect(parsePage({}, { limit: DEFAULT_LIST_LIMIT, max: MAX_LIST_LIMIT })).toEqual({
      limit: DEFAULT_LIST_LIMIT,
      offset: 0,
    });
  });

  it('takes an explicit window', () => {
    expect(parsePage({ limit: 5, offset: 40 }, { limit: 20, max: 100 })).toEqual({
      limit: 5,
      offset: 40,
    });
  });

  // A caller asking for more than the ceiling gets the ceiling: that is the
  // useful answer, and it is what stops a client from opting out of paging.
  it('clamps a limit above the ceiling instead of refusing it', () => {
    expect(parsePage({ limit: 10_000 }, { limit: 20, max: 100 }).limit).toBe(100);
  });

  it('never returns a zero-sized page', () => {
    expect(parsePage({ limit: 0 }, { limit: 20, max: 100 }).limit).toBe(1);
  });

  // A value that is not a count at all is a mistake in the caller, not a request
  // to be clamped — same treatment parseRevision gives one.
  it.each<[Record<string, unknown>, string]>([
    [{ limit: -1 }, 'negative limit'],
    [{ limit: 1.5 }, 'fractional limit'],
    [{ limit: 'twenty' }, 'non-numeric limit'],
    [{ offset: -1 }, 'negative offset'],
    [{ offset: '20; DROP' }, 'non-numeric offset'],
  ])('rejects %o (%s)', (body) => {
    expect(() => parsePage(body, { limit: 20, max: 100 })).toThrow(
      /must be a non-negative integer/,
    );
  });
});

describe('pageOfProjects', () => {
  const page = (meta: Metadata, opts: Partial<Parameters<typeof pageOfProjects>[1]> = {}) =>
    pageOfProjects(meta, { limit: 20, offset: 0, revisionLimit: 10, ...opts });

  it('reports the full total alongside a partial page', () => {
    const { projects, total } = page(projectsPublishedInOrder(25), { limit: 10 });
    expect(projects).toHaveLength(10);
    expect(total).toBe(25);
  });

  it('orders projects by most recent publish, newest first', () => {
    const { projects } = page(projectsPublishedInOrder(3));
    expect(projects.map((p) => p.slug)).toEqual(['project-0', 'project-1', 'project-2']);
  });

  it('walks the whole set without repeating or skipping a project', () => {
    const meta = projectsPublishedInOrder(25);
    const seen = [
      ...page(meta, { limit: 10, offset: 0 }).projects,
      ...page(meta, { limit: 10, offset: 10 }).projects,
      ...page(meta, { limit: 10, offset: 20 }).projects,
    ].map((p) => p.slug);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('returns nothing for an offset past the end, without throwing', () => {
    const { projects, total } = page(projectsPublishedInOrder(3), { offset: 99 });
    expect(projects).toEqual([]);
    expect(total).toBe(3);
  });

  // The reason revisionCount exists: the page carries a window, and the UI has to
  // be able to say so rather than implying the project has only these few.
  it('caps revisions per project but still reports how many there are', () => {
    const { projects } = page(projectsPublishedInOrder(1, 47), { revisionLimit: 10 });
    expect(projects[0].revisions).toHaveLength(10);
    expect(projects[0].revisionCount).toBe(47);
  });

  it('gives the newest revisions first, so a window keeps the useful end', () => {
    const { projects } = page(projectsPublishedInOrder(1, 47), { revisionLimit: 3 });
    expect(projects[0].revisions.map((r) => r.rev)).toEqual([47, 46, 45]);
  });

  it('projects a project that has never published without crashing on latest', () => {
    const meta = emptyMetadata();
    reserveRevision(meta, 'towel-clip', { now: NOW }); // still processing
    const { projects } = page(meta);
    expect(projects[0].latest).toBeNull();
    expect(projects[0].revisionCount).toBe(1);
  });

  it('handles an index with no projects at all', () => {
    expect(page(emptyMetadata())).toEqual({ projects: [], total: 0 });
  });
});

describe('feedbackTargets', () => {
  /** Give a revision `n` comments, as actionComment would. */
  function withComments(meta: Metadata, slug: string, rev: number, n: number) {
    meta.projects[slug].revisions[String(rev)].commentCount = n;
    return meta;
  }

  it('lists only revisions that actually have comments', () => {
    const meta = projectsPublishedInOrder(1, 3);
    withComments(meta, 'project-0', 2, 5);
    expect(feedbackTargets(meta)).toHaveLength(1);
    expect(feedbackTargets(meta)[0]).toMatchObject({ slug: 'project-0', rev: 2 });
  });

  it('is empty when nothing has been commented on', () => {
    expect(feedbackTargets(projectsPublishedInOrder(3, 2))).toEqual([]);
  });

  // The ordering is the whole point: it lets the roll-up slice a page *before*
  // reading any thread, instead of reading every thread to find the recent ones.
  it('orders newest revision first', () => {
    const meta = projectsPublishedInOrder(3, 1);
    for (const p of ['project-0', 'project-1', 'project-2']) withComments(meta, p, 1, 1);
    expect(feedbackTargets(meta).map((t) => t.slug)).toEqual([
      'project-0',
      'project-1',
      'project-2',
    ]);
  });

  // Two revisions of one project can share a publishedAt to the millisecond, and
  // a page boundary that wobbled between requests would duplicate or drop a thread.
  it('breaks a publishedAt tie deterministically, by revision', () => {
    const meta = projectsPublishedInOrder(1, 3);
    for (const rev of [1, 2, 3]) {
      meta.projects['project-0'].revisions[String(rev)].publishedAt = NOW;
      withComments(meta, 'project-0', rev, 1);
    }
    expect(feedbackTargets(meta).map((t) => t.rev)).toEqual([3, 2, 1]);
  });

  it('falls back to reservedAt for a revision that never finished publishing', () => {
    const meta = projectsPublishedInOrder(1, 1);
    const entry = meta.projects['project-0'].revisions['1'];
    delete entry.publishedAt;
    entry.commentCount = 2;
    expect(feedbackTargets(meta)[0].at).toBe(entry.reservedAt);
  });
});
