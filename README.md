# 3d-feedback

Serverless host for sharing 3D models (`.glb`) with reviewers, at
**`3d.zach.nz`**. A project accumulates numbered revisions; each revision has its
own public URL, its own feedback thread, and prev/next links to its neighbours:

```
https://3d.zach.nz/towel-clip/3      a specific revision
https://3d.zach.nz/towel-clip        the latest revision
```

The workflow it exists for: iterate on a design in FreeCAD, publish a snapshot
from the CLI, send the link, read the comments, iterate again.

Reviewers need no account — they orbit/zoom/pan the model in the browser, toggle
individual parts of an assembly, step through earlier revisions, and leave
feedback. Publishing and administration are yours alone.

## Architecture

```
                            ┌──────────────────────────────────────────────────┐
  reviewer ────────────────▶│ CloudFront (one distribution, OAC)               │
                            │  /                    → 302 /login               │
                            │  /<proj>[/<rev>]      → viewer SPA   (60s)       │
                            │  *.glb                → model        (1yr)       │
                            │  /projects|comments|status/*         (5s)        │
                            │  /viewer/* /app/*                   (60s)       │
                            │  /login /admin        → app/*.html   (60s)       │
                            └───────────────┬──────────────────────────────────┘
                                            │ OAC (private)
                                     ┌──────▼────────┐
                                     │ assets bucket │ <proj>/<rev>/model.glb
                                     └──────▲────────┘ projects/ comments/ status/
                                            │            app/ viewer/
  you ──publish.sh──▶ HTTP API ──▶ ┌────────┴─────┐   ┌─────────────────┐
       (SigV4)        /publish     │   Lambda     │──▶│ metadata bucket │
                                   │ (handler.ts) │   └─────────────────┘
  reviewer ─────────▶ /comment ───▶└──────▲───────┘      metadata.json
       (public, throttled)                │ S3 event (prefix uploads/)
  you (Google) ─────▶ /list /edit  ┌──────┴────────┐
                      /delete      │ staging bucket│◀── presigned PUT
                      /feedback    └───────────────┘    (30-day lifecycle)
```

**Three S3 buckets**, all private:

- `assets` — served only through CloudFront. Holds `<slug>/<rev>/model.glb`, the
  public manifests, comment threads, publish status, and both SPAs.
- `staging` — presigned `PUT` target; a `uploads/` create event triggers the
  processor; 30-day lifecycle.
- `metadata` — `metadata.json`, the private index and source of truth.

**One Lambda** dispatches by event shape: HTTP API router (`publish`, `comment`,
`list`, `edit`, `delete`, `feedback`) or S3 processor. Every JSON
read-modify-write uses S3 conditional writes (`IfMatch` on the ETag, retry on
412/409), so concurrent publishes and comments are safe without reserved
concurrency or a database.

**Three auth models on one API:**

| Route | Auth | Why |
|---|---|---|
| `POST /publish` | `AWS_IAM` (SigV4) | A script with AWS credentials can publish; no OAuth dance |
| `POST /list`, `/edit`, `/delete`, `/feedback` | Cognito JWT + email allowlist | Human admin, Google sign-in, allowlist re-checked per request |
| `POST /comment` | none, throttled 5 rps | Reviewers comment without an account |

## Why one viewer SPA, not per-revision HTML

`viewer/index.html` serves every project and revision; a CloudFront function
rewrites `/<proj>` and `/<proj>/<rev>` to it, and the viewer reads the project
and revision back out of `location.pathname`. Generating an HTML page per
revision would freeze old revisions on old viewer code — a rendering fix would
never reach the links already sent out.

The consequence to remember: **CloudFront picks a cache behavior from the
incoming URI, before the function rewrites it.** So `/<proj>/<rev>` is served by
the *default* behavior, which is why the default behavior has a 60-second TTL and
the only 1-year cache is the separate `*.glb` behavior. `test/stack.test.ts`
asserts this, because getting it wrong caches every share URL for a year.

## Revision numbering

Numbers come from `nextRev` and are **never reused** — not after a failed
publish, not after a delete. A recycled number would resurrect a stale model from
the 1-year immutable cache under a URL someone already has. Deleting revision 3
of 5 therefore leaves a gap, and the viewer's prev/next walks the manifest's
revision list rather than assuming `rev ± 1`.

## Publishing

```bash
tools/publish.sh model.glb --project towel-clip \
    --title "Towel clip" --notes "raised the clip angle 5°"
# … prints https://3d.zach.nz/towel-clip/4
```

`publish.sh` is a wrapper: the publish itself is
[tools/mcp/publish.ts](tools/mcp/publish.ts), which the MCP server below calls
in-process. One implementation of reserve → upload → wait → verify, rather than a
shell script and a server that have to agree — which is also why publishing needs
no `jq`, no `curl` and not even the AWS CLI. Credentials come from the AWS SDK's
provider chain (the same profiles, assumed roles and `aws sso login` cache the CLI
uses; only a profile *name* is ever configured) and the request is signed in
process.

It signs `POST /publish`, which reserves the next revision and returns a presigned
`PUT`; it uploads the file, polls `status/<proj>/<rev>.json`, checks that the
finished URL actually serves, and prints the URL as its only stdout line:

```bash
URL=$(tools/publish.sh model.glb --project towel-clip --quiet)
```

That last form is the integration point for a Notor workflow — run the script,
capture stdout.

Endpoints are read from `--api-url`/`--site-url`, then `THREED_API_URL`/
`THREED_SITE_URL`, then `cdk-outputs.json`. Deploy with
`--outputs-file cdk-outputs.json` and the flags become unnecessary.

A `.glb` that records where it was built from has that published with the revision
automatically — see [Recording where a model came from](#recording-where-a-model-came-from).
The `--source-*` flags (`--help` lists them) override what the file says, for an
export that carries nothing.

### Retrying without spending a revision

Numbers are never reused, so a retry is the one thing a publisher must not do
naïvely. Two mechanisms make it safe, and both are in `POST /publish` rather than
in the client, so every caller gets them:

- **Identical bytes are recognised.** Every publish declares a sha256 of the file.
  If it matches the *latest* ready revision, the API returns that revision and
  reserves nothing — so a retry after a lost response, or a re-run of the same
  workflow, is a no-op that prints the same URL. `--force` publishes anyway. Only
  the latest revision is compared: re-publishing the geometry of an older revision
  is a deliberate revert and deserves its own number.
- **A reserved revision can be finished.** When a publish dies after reserving —
  the upload failed, the processor rejected the file, the wait ran out —
  `--revision N` re-presigns an upload for that same number instead of taking a
  new one. The failure message names the number and the exact command. Refused
  once the revision is `ready`: its model is served with a one-year immutable
  cache, so replacing the bytes under a URL that has been shared would leave the
  CDN serving the old ones.

`contentHash` is an idempotency key, not an integrity check — the publisher hashes
the exact bytes it uploads, and TLS and S3's own checksums cover the transfer, so
nothing re-reads a 100 MB model to confirm it. It is kept in the private index
only; the public manifest still carries just what the viewer renders.

## Recording where a model came from

A revision can record the source state it was built from, so a reviewer looking at
revision 3 can answer "which commit produced this, and how do I rebuild it?". The
share page shows it under **Built from**, `list_revisions` and `get_publish_status`
report it, and `/admin` displays it.

It is entirely optional. Every revision published before this existed carries none,
a FreeCAD export carries none, and nothing fails without it.

### The contract

The producer writes this into the `.glb` itself, as `asset.extras.source`:

```json
{
  "asset": {
    "version": "2.0",
    "extras": {
      "source": {
        "schema": "3d-feedback/source@1",
        "repo": "3d-models",
        "cloneUrl": "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/3d-models",
        "commit": "7dd5ecd0f3a1…",
        "ref": "main",
        "path": "models/cloth-basket-small",
        "build": "make cloth-basket-small",
        "recreate": "git clone <url> && cd 3d-models && git checkout 7dd5ecd && make cloth-basket-small"
      }
    }
  }
}
```

| Field | Type | Cap | | Meaning |
|---|---|---|---|---|
| `schema` | string | — | **required** | `"3d-feedback/source@1"`. In a `.glb` this is the discriminator, not decoration — see below. |
| `repo` | string | 100 | recommended | Repository identity as a short name (`3d-models`), not a URL. |
| `cloneUrl` | string | 400 | optional | Where to get it. Must be `https://`, `http://`, `ssh://`, `git://`, `codecommit::` or `user@host:path`. Omit when there is no URL a reader could use — a wrong one is worse than none. |
| `commit` | string | — | recommended | The exact commit: 40 (sha1) or 64 (sha256) lowercase hex. |
| `ref` | string | 200 | optional | Branch or tag built from. Not a substitute for `commit`; refs move. |
| `dirty` | boolean | — | optional | `true` when the working tree had uncommitted changes. Omit it otherwise — `false` is recorded as absent. |
| `tree` | string | — | **required when `dirty`** | git tree oid of what was actually built, as hex. |
| `path` | string | 200 | recommended | The model's directory in the repo. Repo-relative POSIX: no leading `/`, no `..`, no backslash. |
| `build` | string | 200 | recommended | The command that rebuilds it. Displayed, never executed. |
| `recreate` | string | 600 | recommended | One human-readable line telling a reviewer how to recreate this. **Worth more than the rest put together** — it is what actually gets read. Newlines allowed. |

Unknown keys are **dropped, not rejected**, so a producer can send a field this
deployment predates; `inspect_glb` names them, so a `commmit` typo is visible rather
than silent. A malformed value *is* rejected — a commit id that is not one, a path
that escapes the repository, a clone URL nobody could clone from — because it would
otherwise be rendered as though it were a fact. Every string is sanitized and capped
through the same `optionalText` a comment goes through: this lands in the public
manifest and on a public page, so it is treated as untrusted input.

Uncommitted work is a **flag plus a hash, never a diff**. The manifest is public and
a patch has no upper bound. Compute `tree` against a scratch index so the real one is
untouched:

```sh
export GIT_INDEX_FILE=$(mktemp -u); git read-tree HEAD; git add -A
TREE=$(git write-tree); unset GIT_INDEX_FILE
```

When the tree is clean, `tree` equals `git rev-parse HEAD^{tree}` and can be omitted.
`git add -A` respects `.gitignore`, so generated output stays out of it.

### The extras must be deterministic

**No build timestamp, no absolute path, no hostname, no username, no random id.**
Every value must be a function of the git state alone.

This is not tidiness. Rebuilding the same commit has to produce a byte-identical
`.glb`, because identical bytes are how a retry is recognised — the entire mechanism
in "Retrying without spending a revision" above. A timestamp in the extras makes
every rebuild a new file, so every retry burns a revision number that can never be
reused.

### Why it rides inside the file rather than as a publish argument

`POST /publish` does accept a `source` argument, and the MCP tools and CLI expose it,
but the file's own extras are the default and the argument is the override. The
reason is the dedupe:

- `findDuplicateRevision()` compares `contentHash` and nothing else, and the dedupe
  path deliberately applies neither title nor notes to a revision that already
  exists. As a **separate argument**, provenance inherits that: the same geometry
  rebuilt from a different commit dedupes to the old revision and the new commit is
  silently dropped.
- **Inside the file** the problem cannot arise. Different provenance is different
  bytes is a different hash, so a rebuild from a different commit is a genuinely new
  revision. The record also cannot drift from the model it describes, and it survives
  being downloaded.
- `inspect_glb` can then show it before anything is reserved.

The override keeps its inherited wrinkle, so the publish client says so at the moment
it is used: republishing identical bytes with a different `source` dedupes and drops
it. `--force` is the way out.

`schema` is required *in the file* for a related reason: `extras.source` is a
plausible name for another tool's data, and guessing at a foreign record would be
worse than reading none. On the wire it is optional — nobody typing
`--source-commit` is going to type a schema — and the server stamps the current
version.

### It cannot be edited after the fact

`/admin` shows provenance and does not let you change it, unlike notes and the title.
Provenance is a mechanical claim about bytes that are immutable, and its whole value
is that it cannot drift from them. A hand-typed commit id is an assertion nobody can
check against the model — worse than no provenance, because it looks authoritative.
Notes and titles stay editable because they are prose, meant to be revised. The
remedy for wrong provenance is a new revision, the same reasoning that makes a
published model immutable.

### What this is not

There is no source *download*. `3d-models` lives in CodeCommit in the same AWS
account as this deployment, and it cannot serve the reviewer: CodeCommit has no
anonymous read path at all — no public URL, no presigned object, no CloudFront
origin, every read SigV4 — and reviewers have no AWS account. Serving it would mean a
public unauthenticated route walking `GetFolder`/`GetBlob` in front of a private repo,
which would also die whenever the account moves off CodeCommit (it is closed to new
customers and in maintenance mode). A force-push or branch delete can orphan a
recorded commit too, so even the repo is not the durable store an immutable S3 object
is. So the provenance says precisely what produced the bytes and how to rebuild it,
and obtaining the repository is out of band for whoever has access. The model itself
*is* downloadable from the share page — that URL was always public.

## Exporting from FreeCAD

```python
# inside FreeCAD (this is what freecad-mcp's Python execution does)
exec(open('/Volumes/workplace/3d-feedback/tools/freecad_export_glb.py').read())
export_glb('/tmp/towel-clip.glb')
```

or headless: `freecadcmd tools/freecad_export_glb.py -- out.glb --fcstd part.FCStd`
(FreeCAD also tries to open `out.glb` as a document and prints an exception about
it — harmless).

It exports every visible top-level object that has faces, skipping things already
carried by a parent container and skipping datum/origin geometry, which is a
construction aid rather than a part. **Object labels become the node names in the
`.glb`, and those are exactly what the viewer's parts panel lists** — so renaming
a body in the model tree renames its checkbox.

Label a body `ref_Something` for geometry that is context rather than a part — the
glass panel, the cabinet door, the wall it screws to. It is still exported, but the
viewer lists it as "Something (reference)" with the checkbox off.

If curves look faceted, tighten the tessellation:
`export_glb(path, linear_deflection=0.05)`. The value is FreeCAD's
`ViewObject.Deviation` — a percentage of the object's size, default 0.5, lower is
finer — and `angular_deflection` is `ViewObject.AngularDeflection` in **degrees**
(default 28.5). Expect the file to grow: 0.5 → 0.01 was 2.2× the bytes on a
13-body assembly, which matters on a phone. The export prints the values it
actually applied, so "nothing changed" is visible rather than silent.

Console mode (`freecadcmd`) has no view provider, so it triangulates the shapes
itself at the equivalent quality and exports without per-face colours. That is
also why the MCP server below has two export tools: `export_glb` runs this
headless path unattended, while `gui_export_instructions` hands back the snippet
above for a harness that can drive an open FreeCAD and wants the colours.

`npm run test:freecad` runs [tools/freecad_selftest.py](tools/freecad_selftest.py)
against a document built in memory — nesting, origin planes, a hidden body, a
`PartDesign` datum and a `Base Plate.v2` label. It needs FreeCAD installed
(`FREECADCMD=` overrides the path) and is kept out of `npm test` for that reason.

Only `.glb` (glTF 2.0 binary) is accepted; the processor checks the magic bytes
and rejects `.gltf`, `.stl` and `.step` with a message saying so.

## MCP server

[tools/mcp/](tools/mcp/) is a stdio MCP server that hands the whole loop — FreeCAD
document → `.glb` → revision URL → the feedback that comes back — to another AI
harness, so it does not have to rediscover the parts that are not guessable: that
`freecadcmd` is not on PATH, that the exporter needs a `--` separator, that only
`.glb` is accepted, what `ref_` means, which AWS profile signs the publish, that
revision numbers are burned permanently even by a throwaway publish, or which of
the site's objects can be read without credentials.

The directory holds the publish client too, not just the server: `tools/publish.sh`
runs [cli.ts](tools/mcp/cli.ts) over the same code.

```bash
npm run mcp          # run it (stdio; a harness normally spawns this)
npm run mcp:smoke    # handshake + check_setup + inspect_glb + a site read, over real stdio
npm run mcp:check    # typecheck
```

Register it by pointing the harness at the same command:

```json
{
  "command": "npx",
  "args": ["ts-node", "--prefer-ts-exts", "--project",
           "/Volumes/workplace/3d-feedback/tools/mcp/tsconfig.json",
           "/Volumes/workplace/3d-feedback/tools/mcp/server.ts"],
  "env": {
    "THREED_AWS_PROFILE": "random",
    "THREED_DEFAULT_PROJECT": "towel-clip"
  }
}
```

Ten tools. Six write or export; four only read, and those four need no credentials
at all — the manifests, comment threads and status objects they read are the same
public objects the viewer reads, straight off the distribution.

| Tool | Does |
|---|---|
| `check_setup` | Effective config (and which layer each value came from) plus a read-only health check: FreeCAD binary, resolved endpoints, whether the site answers, and whether the profile has live credentials **for the deployment's own account** — it compares `GetCallerIdentity` against the account in the `PublishRouteArn` output, because an ambient `AWS_PROFILE` pointing elsewhere otherwise shows up only as an opaque 403. Names the fix for each failure. |
| `export_glb` | Headless `freecadcmd` export of a **saved** `.FCStd`, then reports the parts panel it produced |
| `gui_export_instructions` | The `exec()` snippet to run in an already-open FreeCAD (freecad-mcp), which keeps per-face colours and exports the live document |
| `inspect_glb` | Local check: parts-panel prediction, `ref_` parts, triangle counts, the source provenance the file declares, would the processor accept it |
| `publish_model` | Publish an existing `.glb` as the next revision; returns the share URL. Identical bytes return the existing revision; `revision` finishes one that was already reserved |
| `convert_and_publish` | Export → inspect → publish in one call |
| `list_revisions` | What a reviewer can see: title, latest, every published revision with its notes, size, comment count, URL and the commit it was built from |
| `get_publish_status` | Whether a publish landed — `ready` with the URL and the commit, `error` with the processor's reason, or still `processing`. The tool for a publish whose wait timed out |
| `get_feedback` | The comments on one revision, or across the project, newest first |
| `verify_revision` | Fetch the share page and the model as a reviewer would: status, content type, immutable caching, and that the size served matches the manifest |

Editing, deleting and listing *every* project are deliberately absent: those routes
are Cognito-only (`/admin`), and a headless server cannot complete a Google
sign-in. Publishing works because `POST /publish` is SigV4, and the read tools work
because what they read is public — see the auth table above.

A `ready` status and a working URL are different claims, which is why
`verify_revision` exists and why publishing ends with it (`verifyAfterPublish`).
The status object is written by the processor from inside AWS; between it and a
reviewer sit the distribution, its origin access control, the certificate and DNS.
A failed check is reported loudly but does not turn a successful publish into an
error — the revision exists either way, and saying otherwise invites a second one.

The parts prediction in `inspect_glb` mirrors `viewer-app/viewer.js`, so it
answers "will the reviewer see the checkboxes I expect?" without a publish.
[test/mcp-glb.test.ts](test/mcp-glb.test.ts) pins the pair against the same sample
model the dev server uses, because two implementations of one rule drift.

### Configuration

Every knob has a `THREED_*` variable, because a harness's MCP `env` block is the
only configuration surface it offers. The long tail can go in a gitignored
`tools/mcp/config.json` instead ([config.example.json](tools/mcp/config.example.json)
lists them all). Precedence, reported per key by `check_setup`:

**per-call argument → `THREED_*` env → config file → `cdk-outputs.json` → default**

| Variable | File key | Default |
|---|---|---|
| `THREED_AWS_PROFILE` | `awsProfile` | `$AWS_PROFILE` |
| `THREED_AWS_REGION` | `awsRegion` | `$AWS_REGION`, else `us-east-1` |
| `THREED_API_URL` | `apiUrl` | `ApiUrl` from the outputs file |
| `THREED_SITE_URL` | `siteUrl` | `SiteUrl` from the outputs file |
| `THREED_OUTPUTS_FILE` | `outputsFile` | `cdk-outputs.json` |
| `THREED_CONFIG` | — | `tools/mcp/config.json` |
| `THREED_REPO_ROOT` | — | resolved from the server's own path |
| `THREED_EXPORT_SCRIPT` | `exportScript` | `tools/freecad_export_glb.py` |
| `THREED_FREECADCMD` | `freecadcmd` | PATH, then `/Applications/FreeCAD.app/…/freecadcmd` |
| `THREED_WORK_DIR` | `workDir` | `$TMPDIR/3d-feedback` |
| `THREED_DEFAULT_PROJECT` | `defaultProject` | none (then `project` is required) |
| `THREED_DEFAULT_LINEAR_DEFLECTION` | `defaultLinearDeflection` | FreeCAD's 0.5 |
| `THREED_DEFAULT_ANGULAR_DEFLECTION` | `defaultAngularDeflection` | FreeCAD's 28.5 |
| `THREED_FREECAD_TIMEOUT_SECONDS` | `freecadTimeoutSeconds` | 300 |
| `THREED_PUBLISH_TIMEOUT_SECONDS` | `publishTimeoutSeconds` | 120 (how long to wait for the processor) |
| `THREED_HTTP_TIMEOUT_SECONDS` | `httpTimeoutSeconds` | 30 (per request, not per publish) |
| `THREED_VERIFY_PUBLISH` | `verifyAfterPublish` | `true`; fetch the URL and the model after publishing |
| `THREED_MAX_MODEL_BYTES` | `maxModelBytes` | 100 MB (the Lambda's own cap) |
| `THREED_WARN_MODEL_BYTES` | `warnModelBytes` | 25 MB (advisory) |
| `THREED_ALLOWED_PATHS` | `allowedPaths` | anywhere; `:`-separated roots confine it |
| `THREED_ALLOW_PUBLISH` | `allowPublish` | `true`; `false` unregisters the publishing tools, leaving the read-only ones |
| `THREED_DRY_RUN` | `dryRun` | `false`; exports for real, reports the request it would send instead of sending it |
| `THREED_ENABLED_TOOLS` | `enabledTools` | all; a comma list narrows the surface |
| `THREED_LOG_LEVEL` | `logLevel` | `info` (stderr) |
| `THREED_LOG_FILE` | `logFile` | none |

No credentials are configured here, only a profile *name*: the AWS SDK's provider
chain resolves it the way the CLI does, including the SSO cache that
`aws sso login` writes. An unknown key or an unparseable value stops the server
with a message rather than being silently ignored, and a key that used to exist
(`publishScript`) says what replaced it instead of appearing among the typos. The
exception is `cdk-outputs.json`, which is tolerated when broken (the export tools
do not need it) and reported by `check_setup`.

Because stdout carries JSON-RPC, every child process is captured rather than
inherited and all logging goes to stderr; `npm run mcp:smoke` fails if anything
else reaches stdout.

## Local development

```bash
npm install          # also vendors three.js into viewer-app/vendor/
npm run dev          # http://localhost:8080/sample/1
```

The dev server stands in for CloudFront, S3 and the API, and it routes URLs by
executing the **real** `lib/cloudfront-functions/*.js`, so a routing change is
exercised locally before it is deployed. It serves a three-part sample model from
`scripts/make-sample-glb.js` — one part is `ref_Wall Panel`, so the
reference-geometry behaviour is visible without FreeCAD — and `POST /comment`
appends to an in-memory thread.

three.js is self-hosted rather than loaded from a CDN, so a shared link has no
third-party dependency at view time. `scripts/vendor-three.js` (run on
`postinstall`) copies the modules out of `node_modules` and flattens their
relative imports into `viewer-app/vendor/`, which is gitignored — the pinned
version comes from `package.json`.

## Commands

```bash
npm install
npm run build      # tsc
npm test           # jest: stack assertions, handler units, edge functions, MCP units
npm run test:freecad  # exporter selection rules (needs FreeCAD installed)
npm run dev        # local preview server
npm run vendor     # re-copy three.js after changing its version
npm run mcp        # the MCP server (stdio)
npm run mcp:check  # typecheck it (node16 resolution; not covered by `build`)
npm run mcp:smoke  # exercise it over real stdio
npx cdk synth
npx cdk deploy --outputs-file cdk-outputs.json
```

## Configuration (CDK context)

Set in `cdk.json`, or override in a gitignored `config.local.json`:

| Key | Meaning |
|---|---|
| `threedHost:allowedEmails` | Comma-separated admin allowlist |
| `threedHost:hostedUiPrefix` | Cognito Hosted-UI domain prefix (globally unique) |
| `threedHost:domainName` | Custom domain (`3d.zach.nz`) |
| `threedHost:domainEnabled` | `true` once the DNS records below exist in the parent zone |
| `threedHost:googleClientId` | Google OAuth client id (blank ⇒ synth without Google) |
| `threedHost:googleClientSecret` | Google OAuth client secret |

With a blank Google client id the stack skips the Google IdP, and with
`domainEnabled` false it skips the certificate, so `synth` and the tests run with
no secrets and no DNS.

## Deploying

`3d.zach.nz` is served straight from the parent `zach.nz` zone — one hosted zone
for the whole domain, no delegated zone per app. That zone lives in a separate
`domains` account, and CloudFormation cannot write records into another account's
zone (nor can ACM's automatic DNS validation), so two records are created by
`tools/parent-dns.sh` instead: the A/AAAA alias to the distribution and the ACM
validation CNAME. Both are stable, so it is a one-time run — but the certificate
cannot be issued until the validation record exists, so the domain is switched on
in a second pass.

1. **First deploy**, without the domain:
   ```bash
   npx cdk bootstrap
   npx cdk deploy --outputs-file cdk-outputs.json
   ```
   Everything works on the CloudFront domain from the outputs.
2. **Google OAuth**: create an OAuth client in the Google Cloud Console with the
   `GoogleRedirectUri` output as its authorized redirect URI. Put the id, secret
   and your allowlist in `config.local.json`, then deploy again.
3. **Custom domain**: set `"threedHost:domainEnabled": "true"` and deploy. The
   stack requests the certificate and CloudFormation then waits on DNS
   validation — while it waits, write the records into the parent zone:
   ```bash
   tools/parent-dns.sh --parent-profile domains
   ```
   Validation completes, and `3d.zach.nz` is live once the distribution finishes
   updating. (Forget this step and the deploy eventually rolls back; write the
   records and re-run — `--dry-run` first shows the change batch.)
4. **Smoke test**:
   ```bash
   npm run sample-glb -- /tmp/sample.glb
   tools/publish.sh /tmp/sample.glb --project test-part --title "Test part"
   ```
   Open the URL on a phone and a desktop, toggle the parts, leave a comment, then
   check `/admin`.

## Layout

| Path | Purpose |
|---|---|
| `bin/threed-host.ts` | CDK app entry (pins us-east-1, loads `config.local.json`) |
| `lib/threed-host-stack.ts` | The single stack — all infrastructure |
| `lib/lambda/handler.ts` | Multi-action Lambda (router + S3 processor) |
| `lib/lambda/pre-signup.ts` | Cognito allowlist trigger |
| `lib/cloudfront-functions/` | Viewer-request URL rewriting |
| `viewer-app/` | Public viewer SPA (three.js, no build step) |
| `admin-app/` | Admin SPA (Google PKCE, no build step) |
| `tools/publish.sh` | Publish a revision, print the share URL (a wrapper over `tools/mcp/cli.ts`) |
| `tools/parent-dns.sh` | The subdomain's records in the parent `zach.nz` zone |
| `tools/freecad_export_glb.py` | FreeCAD → `.glb` export |
| `tools/freecad_selftest.py` | Exporter selection rules, against a fixture document |
| `tools/mcp/` | stdio MCP server *and* the publish client both entry points share: export, inspect, publish, read back |
| `scripts/` | three.js vendoring, sample model, dev server, MCP stdio smoke test |
| `test/` | Stack assertions + handler, edge-function and MCP units |

## Known limits

- **100 MB** per model, enforced server-side. iOS Safari is the practical
  ceiling long before that — it kills the tab rather than degrading when GPU
  memory runs out, so keep exports lean (the viewer caps its pixel ratio at 2 to
  help). Draco compression is the obvious next step if models get heavy.
- One `.glb` per revision; no STEP/STL attachments, and no source archive. A revision
  can *name* the commit it was built from and how to rebuild it
  ([above](#recording-where-a-model-came-from)), but obtaining the repository is out
  of band — reviewers have no AWS account and CodeCommit has no anonymous read path.
- Provenance cannot be corrected after the fact, by anyone, deliberately; the fix is
  a new revision.
- `/comment` is public. Payload caps, a 200-comment ceiling per revision, route
  throttling and a check that the revision exists bound the damage; spam is
  cleaned up by deleting the revision or the project.
- The admin app cannot be exercised locally — Cognito sign-in needs the deployed
  Hosted UI.
- The MCP server publishes and reads, but cannot list *every* project, edit notes
  or delete anything: those routes need a Cognito JWT from a Google sign-in, which
  a headless server has no way to complete. Reading works only because the
  viewer's own objects are public, so every read starts from a slug you already
  know. Adding the rest would mean IAM-authorised variants of those routes in the
  stack.
- Reads go through a 5-second CDN cache (10s max), so a comment or a manifest can
  lag by that much; CloudFront does not honour a `cache-control: no-cache` request
  header from the viewer. Publishing accounts for it in its polling deadline.
