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

The script signs `POST /publish` with your AWS credentials (resolved through
`aws configure export-credentials`, so SSO and assumed roles work), which
reserves the next revision and returns a presigned `PUT`; it uploads the file,
polls `status/<proj>/<rev>.json`, and prints the URL as its only stdout line:

```bash
URL=$(tools/publish.sh model.glb --project towel-clip --quiet)
```

That last form is the integration point for a Notor workflow — run the script,
capture stdout.

Endpoints are read from `--api-url`/`--site-url`, then `THREED_API_URL`/
`THREED_SITE_URL`, then `cdk-outputs.json`. Deploy with
`--outputs-file cdk-outputs.json` and the flags become unnecessary.

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

[tools/mcp/](tools/mcp/) is a stdio MCP server that hands the whole path —
FreeCAD document → `.glb` → revision URL — to another AI harness, so it does not
have to rediscover the parts that are not guessable: that `freecadcmd` is not on
PATH, that the exporter needs a `--` separator, that only `.glb` is accepted, what
`ref_` means, which AWS profile signs the publish, or that revision numbers are
burned permanently even by a throwaway publish.

```bash
npm run mcp          # run it (stdio; a harness normally spawns this)
npm run mcp:smoke    # handshake + check_setup + inspect_glb over real stdio
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

Six tools:

| Tool | Does |
|---|---|
| `check_setup` | Effective config (and which layer each value came from) plus a read-only health check: FreeCAD binary, `aws`/`jq`/`curl --aws-sigv4`, resolved endpoints, and whether the profile has live credentials **for the deployment's own account** — it compares `sts get-caller-identity` against the account in the `PublishRouteArn` output, because an ambient `AWS_PROFILE` pointing elsewhere otherwise shows up only as an opaque 403. Names the fix for each failure. |
| `export_glb` | Headless `freecadcmd` export of a **saved** `.FCStd`, then reports the parts panel it produced |
| `gui_export_instructions` | The `exec()` snippet to run in an already-open FreeCAD (freecad-mcp), which keeps per-face colours and exports the live document |
| `inspect_glb` | Local check: parts-panel prediction, `ref_` parts, triangle counts, would the processor accept it |
| `publish_model` | Publish an existing `.glb` as the next revision; returns the share URL |
| `convert_and_publish` | Export → inspect → publish in one call |

Editing and deleting are deliberately absent: those routes are Cognito-only
(`/admin`), and a headless server cannot complete a Google sign-in. Publishing
works because `POST /publish` is SigV4 — see the auth table above.

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
| `THREED_PUBLISH_SCRIPT` | `publishScript` | `tools/publish.sh` |
| `THREED_EXPORT_SCRIPT` | `exportScript` | `tools/freecad_export_glb.py` |
| `THREED_FREECADCMD` | `freecadcmd` | PATH, then `/Applications/FreeCAD.app/…/freecadcmd` |
| `THREED_WORK_DIR` | `workDir` | `$TMPDIR/3d-feedback` |
| `THREED_DEFAULT_PROJECT` | `defaultProject` | none (then `project` is required) |
| `THREED_DEFAULT_LINEAR_DEFLECTION` | `defaultLinearDeflection` | FreeCAD's 0.5 |
| `THREED_DEFAULT_ANGULAR_DEFLECTION` | `defaultAngularDeflection` | FreeCAD's 28.5 |
| `THREED_FREECAD_TIMEOUT_SECONDS` | `freecadTimeoutSeconds` | 300 |
| `THREED_PUBLISH_TIMEOUT_SECONDS` | `publishTimeoutSeconds` | 120 |
| `THREED_MAX_MODEL_BYTES` | `maxModelBytes` | 100 MB (the Lambda's own cap) |
| `THREED_WARN_MODEL_BYTES` | `warnModelBytes` | 25 MB (advisory) |
| `THREED_ALLOWED_PATHS` | `allowedPaths` | anywhere; `:`-separated roots confine it |
| `THREED_ALLOW_PUBLISH` | `allowPublish` | `true`; `false` unregisters the publishing tools |
| `THREED_DRY_RUN` | `dryRun` | `false`; exports for real, reports the publish command instead of running it |
| `THREED_ENABLED_TOOLS` | `enabledTools` | all; a comma list narrows the surface |
| `THREED_LOG_LEVEL` | `logLevel` | `info` (stderr) |
| `THREED_LOG_FILE` | `logFile` | none |

No credentials are configured here, only a profile *name*: publishing shells out
to `publish.sh`, which resolves them with `aws configure export-credentials`. An
unknown key or an unparseable value stops the server with a message rather than
being silently ignored — the exception is `cdk-outputs.json`, which is tolerated
when broken (the export tools do not need it) and reported by `check_setup`.

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
| `threedHost:domainEnabled` | `true` once the DNS delegation below exists |
| `threedHost:googleClientId` | Google OAuth client id (blank ⇒ synth without Google) |
| `threedHost:googleClientSecret` | Google OAuth client secret |

With a blank Google client id the stack skips the Google IdP, and with
`domainEnabled` false it skips the zone and certificate, so `synth` and the tests
run with no secrets and no DNS.

## Deploying

The subdomain's hosted zone lives in **this** account; the parent `zach.nz` zone
lives in a separate `domains` account. Certificate validation cannot succeed
until the parent delegates, so the domain is switched on in a second pass.

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
   stack creates the zone and certificate, and CloudFormation then waits on DNS
   validation — while it waits, delegate from the parent account:
   ```bash
   tools/delegate-ns.sh --parent-profile domains
   ```
   Validation completes, the alias records are created, and `3d.zach.nz` is live.
   (Forget this step and the deploy eventually rolls back; delegate and re-run.)
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
| `tools/publish.sh` | Publish a revision, print the share URL |
| `tools/delegate-ns.sh` | One-time NS delegation into the parent zone |
| `tools/freecad_export_glb.py` | FreeCAD → `.glb` export |
| `tools/freecad_selftest.py` | Exporter selection rules, against a fixture document |
| `tools/mcp/` | stdio MCP server: export, inspect, publish, for other AI harnesses |
| `scripts/` | three.js vendoring, sample model, dev server, MCP stdio smoke test |
| `test/` | Stack assertions + handler, edge-function and MCP units |

## Known limits

- **100 MB** per model, enforced server-side. iOS Safari is the practical
  ceiling long before that — it kills the tab rather than degrading when GPU
  memory runs out, so keep exports lean (the viewer caps its pixel ratio at 2 to
  help). Draco compression is the obvious next step if models get heavy.
- One `.glb` per revision; no STEP/STL attachments yet.
- `/comment` is public. Payload caps, a 200-comment ceiling per revision, route
  throttling and a check that the revision exists bound the damage; spam is
  cleaned up by deleting the revision or the project.
- The admin app cannot be exercised locally — Cognito sign-in needs the deployed
  Hosted UI.
- The MCP server publishes but cannot list, edit, delete or read feedback: those
  routes need a Cognito JWT from a Google sign-in, which a headless server has no
  way to complete. Adding them would mean IAM-authorised variants of those routes
  in the stack.
