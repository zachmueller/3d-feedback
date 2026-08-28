/**
 * stdio MCP server for the 3d.zach.nz model host.
 *
 *   npm run mcp        # or point a harness at it; see README, "MCP server"
 *
 * It wraps the whole loop — FreeCAD document → .glb → revision URL → the feedback
 * that comes back — so another AI harness does not have to rediscover the parts of
 * it that are not guessable: that `freecadcmd` is not on PATH, that the exporter
 * needs a `--` separator, that only `.glb` is accepted, that a `ref_` label prefix
 * marks reference geometry, which AWS profile signs the publish request, that
 * revision numbers are burned permanently even by a throwaway publish (and what to
 * do about a publish that died holding one), and that the viewer's own objects are
 * public, which is what lets the read tools work with no credentials at all.
 *
 * Everything environment-specific is configuration (tools/mcp/config.ts), so the
 * same server can be handed to several harnesses with different limits.
 *
 * PROTOCOL HYGIENE: stdout carries JSON-RPC and nothing else. Every child process
 * is captured rather than inherited, all logging goes to stderr or a log file, and
 * console.log is redirected below in case a dependency forgets.
 */
import * as fs from 'fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { BadRequest } from '../../lib/lambda/handler';
import { version as packageVersion } from '../../package.json';

import { CredentialError } from './aws';
import {
  activeTools,
  ConfigError,
  type LoadedConfig,
  loadConfig,
  PathError,
  resolveProject,
  resolveUserPath,
  type ToolName,
} from './config';
import { checkSetup, type SetupReport } from './doctor';
import { exportGlb, guiExportSnippet } from './freecad';
import { formatBytes, GlbError, type GlbReport, inspectGlb } from './glb';
import { PublishError, publishModel, type PublishResult } from './publish';
import {
  describeStatus,
  type FeedbackItem,
  fetchFeedback,
  fetchManifest,
  fetchStatus,
  type ProjectReport,
  projectReport,
  siteReader,
  SiteError,
  type StatusObject,
  type VerifyReport,
  verifyRevision,
} from './site';

// --- logging (stderr only) ---------------------------------------------------

const LEVEL_ORDER = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

function makeLogger(loaded: LoadedConfig) {
  const threshold = LEVEL_ORDER[loaded.values.logLevel];
  const logFile = loaded.values.logFile;
  return (level: keyof typeof LEVEL_ORDER, message: string, data?: unknown): void => {
    if (LEVEL_ORDER[level] > threshold) return;
    const line = `[threed-mcp] ${level}: ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`;
    process.stderr.write(`${line}\n`);
    if (logFile) {
      // Best effort: a broken log path must not take the server down.
      try {
        fs.appendFileSync(logFile, `${JSON.stringify({ level, message, data })}\n`);
      } catch {
        /* ignore */
      }
    }
  };
}

// --- tool results ------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** A readable summary followed by the same information as JSON, for the caller. */
function ok(summary: string[], data: unknown): ToolResult {
  const text = [
    ...summary.filter((line) => line !== undefined && line !== null),
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
  return { content: [{ type: 'text', text }] };
}

/**
 * Turn a thrown error into a tool error.
 *
 * BadRequest (from the Lambda's own validators), PathError, GlbError, SiteError,
 * CredentialError and PublishError are all caller-fixable and carry messages
 * written for a caller, so they pass through verbatim. Anything else is reported
 * with its message too — every throw site here writes one meant to be read — with
 * the stack kept for the log.
 */
function fail(err: unknown, log: ReturnType<typeof makeLogger>): ToolResult {
  const expected =
    err instanceof BadRequest ||
    err instanceof PathError ||
    err instanceof GlbError ||
    err instanceof SiteError ||
    err instanceof CredentialError ||
    err instanceof PublishError;
  const message = err instanceof Error ? err.message : String(err);
  log(expected ? 'info' : 'error', 'tool failed', {
    message,
    stack: expected ? undefined : (err as Error)?.stack,
  });
  return { content: [{ type: 'text', text: message }], isError: true };
}

// --- summaries ---------------------------------------------------------------

function glbSummary(report: GlbReport): string[] {
  const lines = [
    `${report.path} — ${formatBytes(report.bytes)}, ${report.triangles.toLocaleString('en-US')} triangles, ` +
      `${report.materialCount} material(s)`,
  ];
  if (report.partsPanelShown) {
    lines.push(`Parts panel (${report.parts.length} checkboxes, in order):`);
  } else {
    lines.push('Parts panel: hidden — the viewer only shows it for two or more components.');
  }
  for (const part of report.parts) {
    lines.push(
      `  ${part.checkedByDefault ? '[x]' : '[ ]'} ${part.displayName}` +
        ` — ${part.triangles.toLocaleString('en-US')} triangles`,
    );
  }
  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  return lines;
}

function publishSummary(result: PublishResult): string[] {
  if (result.dryRun) {
    return [
      'DRY RUN — nothing was reserved, uploaded or published (dryRun is on).',
      `Would send ${formatBytes(result.bytes)} to ${result.plannedRequest?.url} as:`,
      '```json',
      JSON.stringify(result.plannedRequest?.body, null, 2),
      '```',
    ];
  }

  const lines = result.deduped
    ? [
        `Nothing published — revision ${result.revision} of "${result.project}" already holds these ` +
          'exact bytes, so no revision number was spent.',
        `Its URL is ${result.url}. Pass force to publish them again as a new revision anyway.`,
      ]
    : [
        `Published ${result.project} revision ${result.revision}` +
          (result.resumed ? ' (finished the number already reserved, so there is no gap)' : '') +
          `: ${result.url}`,
        'Send that URL to a reviewer; comments land on this revision only.',
      ];

  for (const line of result.log) lines.push(`  · ${line}`);
  if (result.verification) lines.push('', ...verifySummary(result.verification));
  return lines;
}

function verifySummary(report: VerifyReport): string[] {
  const lines = [
    report.ok
      ? `Verified: ${report.url} serves, and so does its model.`
      : `VERIFICATION FAILED for ${report.url} — the revision exists, but this is what a reviewer would get:`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  return lines;
}

function projectSummary(report: ProjectReport): string[] {
  const lines = [
    `${report.project}${report.title ? ` — "${report.title}"` : ''}: ` +
      `${report.revisions.length} published revision(s)` +
      (report.latest === null
        ? ', none of them ready yet'
        : `, latest is ${report.latest} (${report.latestUrl})`),
    `The bare ${report.projectUrl} always lands on the latest.`,
  ];
  // Newest first: the interesting one is the one just published.
  for (const rev of [...report.revisions].reverse()) {
    lines.push(
      `  ${String(rev.rev).padStart(3)}${rev.isLatest ? ' *' : '  '} ` +
        `${rev.publishedAt?.slice(0, 10) ?? '(unknown date)'}  ` +
        `${rev.bytes === null ? '' : formatBytes(rev.bytes).padStart(9)}  ` +
        `${rev.commentCount} comment(s)  ${rev.url}`,
    );
    if (rev.notes) lines.push(`        ${rev.notes}`);
  }
  return lines;
}

function feedbackSummary(project: string, items: FeedbackItem[], revisions: number[]): string[] {
  if (!items.length) {
    return [
      `No feedback on ${project} yet${revisions.length ? ` (checked revision(s) ${revisions.join(', ')})` : ''}.`,
    ];
  }
  const lines = [
    `${items.length} comment(s) on ${project}, newest first, across revision(s) ${revisions.join(', ')}:`,
  ];
  for (const item of items) {
    lines.push(`  [${item.at?.slice(0, 16).replace('T', ' ')}] ${item.name} on revision ${item.revision}`);
    for (const line of item.text.split('\n')) lines.push(`      ${line}`);
  }
  return lines;
}

function statusSummary(status: StatusObject, siteUrl: string): string[] {
  return [describeStatus(status, siteUrl)];
}

function setupSummary(report: SetupReport): string[] {
  const lines = [
    `Headless export: ${report.canExportHeadless ? 'ready' : 'NOT ready'}`,
    `Publishing: ${report.canPublish ? 'ready' : 'NOT ready'}`,
    `Tools registered: ${report.registeredTools.join(', ')}`,
    '',
  ];
  for (const probe of report.probes) {
    const mark = probe.ok === null ? '-' : probe.ok ? 'ok  ' : 'FAIL';
    lines.push(`${mark} ${probe.name}: ${probe.detail}`);
    if (probe.fix) lines.push(`     fix: ${probe.fix}`);
  }
  if (report.notes.length) {
    lines.push('');
    for (const note of report.notes) lines.push(`note: ${note}`);
  }
  return lines;
}

// --- schema fragments --------------------------------------------------------

const projectField = z
  .string()
  .optional()
  .describe(
    'Project slug: 1-64 chars of lowercase letters, digits and hyphens. It is the first ' +
      'path segment of the share URL. Publishing to an existing slug adds the next revision; ' +
      'a new slug creates the project. Defaults to the configured defaultProject.',
  );

const titleField = z
  .string()
  .optional()
  .describe('Project title shown in the viewer. Applies to the whole project, not the revision.');

const notesField = z
  .string()
  .optional()
  .describe(
    'Revision notes — what changed since the last one. Shown next to the revision in the ' +
      'viewer, so write it for the reviewer ("raised the clip angle 5°").',
  );

const linearDeflectionField = z
  .number()
  .positive()
  .optional()
  .describe(
    "Tessellation fineness as FreeCAD's ViewObject.Deviation: a percentage of each object's " +
      'size, default 0.5, lower is finer. Only worth setting if curves look faceted; 0.5 → 0.01 ' +
      'was 2.2x the file size on a 13-body assembly, which matters on a phone.',
  );

const angularDeflectionField = z
  .number()
  .positive()
  .optional()
  .describe(
    'ViewObject.AngularDeflection in DEGREES (default 28.5). Ignored by a headless export, ' +
      'which has no view provider.',
  );

const outField = z
  .string()
  .optional()
  .describe('Where to write the .glb. Defaults to <workDir>/<document name>.glb.');

const revisionField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Finish a revision that was already reserved but never completed — the number a failed ' +
      'publish reported. The upload is retried against that same number instead of spending a ' +
      'new one. Refused if the revision is already published, since its model is immutable.',
  );

const forceField = z
  .boolean()
  .optional()
  .describe(
    'Publish even when these exact bytes are already the latest revision. Without it, an ' +
      'identical publish is recognised and returns the existing revision instead of spending a ' +
      'new number — which is what makes a retry safe.',
  );

const readRevisionField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Revision number. Defaults to the latest published one.');

const readProjectField = z
  .string()
  .optional()
  .describe(
    'Project slug — the first path segment of the share URL. There is no public list of ' +
      'projects, so this has to be one you know; it defaults to the configured defaultProject.',
  );

// --- registration ------------------------------------------------------------

function registerTools(
  server: McpServer,
  loaded: LoadedConfig,
  registered: ToolName[],
  log: ReturnType<typeof makeLogger>,
): void {
  const cfg = loaded.values;
  const enabled = (name: ToolName): boolean => registered.includes(name);

  if (enabled('check_setup')) {
    server.registerTool(
      'check_setup',
      {
        title: 'Check the 3d-feedback setup',
        description:
          'Report the effective configuration (and which layer each value came from) plus a ' +
          'read-only health check: FreeCAD console binary, exporter script, work directory, ' +
          'publish.sh, the aws/jq/curl dependencies, whether the configured AWS profile has ' +
          'live credentials, and the resolved API and site URLs. Call this first when anything ' +
          'fails, or before a long export. Reserves nothing and uploads nothing.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {},
      },
      async () => {
        try {
          const report = await checkSetup(loaded, registered);
          return ok(setupSummary(report), report);
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('inspect_glb')) {
    server.registerTool(
      'inspect_glb',
      {
        title: 'Inspect a .glb locally',
        description:
          'Parse a .glb and predict what the viewer will show: the parts-panel checkboxes in ' +
          'order, which start switched off because their name carries the `ref_` ' +
          'reference-geometry prefix, triangle counts per part, and whether the file would be ' +
          'accepted (glTF 2.0 binary, under the 100 MB server-side cap). Use it to confirm an ' +
          'export looks right before publishing — a revision number is never reused, so a bad ' +
          'publish cannot be undone, only deleted. Local only; no network, no AWS.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          glb: z.string().describe('Path to a .glb file.'),
        },
      },
      async ({ glb }) => {
        try {
          const report = inspectGlb(
            resolveUserPath(glb, cfg, { extensions: ['.glb'], label: 'glb' }),
            cfg,
          );
          return ok(glbSummary(report), report);
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('export_glb')) {
    server.registerTool(
      'export_glb',
      {
        title: 'Export a FreeCAD document to .glb (headless)',
        description:
          'Run headless FreeCAD (freecadcmd) over a SAVED .FCStd and write a .glb, then report ' +
          'the parts panel it will produce. Exports every visible top-level object that has ' +
          'faces, skipping datum/origin geometry and anything a parent container already ' +
          'carries; object Labels become the part names, and a `ref_` prefix marks context ' +
          'geometry (glass panel, cabinet door) which the viewer lists as "X (reference)" with ' +
          'its checkbox off. Two caveats: it reads the file on disk, so unsaved changes in an ' +
          'open FreeCAD are invisible, and console mode exports without per-face colours — ' +
          'call gui_export_instructions instead if you can drive an open FreeCAD.',
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        inputSchema: {
          fcstd: z.string().describe('Path to the saved .FCStd document.'),
          out: outField,
          linearDeflection: linearDeflectionField,
          angularDeflection: angularDeflectionField,
        },
      },
      async (args) => {
        try {
          const result = await exportGlb(cfg, args);
          const report = inspectGlb(result.glb, cfg);
          const summary = [
            `Exported ${result.parsed.labels.length || report.parts.length} object(s) from ` +
              `${result.fcstd} in ${(result.durationMs / 1000).toFixed(1)}s`,
            ...(result.parsed.tessellation.length
              ? [`Tessellation: ${result.parsed.tessellation.join('; ')}`]
              : []),
            ...(result.parsed.warnings.length
              ? ['FreeCAD warnings:', ...result.parsed.warnings.map((w) => `  ! ${w}`)]
              : []),
            '',
            ...glbSummary(report),
          ];
          return ok(summary, { export: result, inspection: report });
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('gui_export_instructions')) {
    server.registerTool(
      'gui_export_instructions',
      {
        title: 'Get the in-GUI FreeCAD export snippet',
        description:
          'Return Python to execute inside an ALREADY-OPEN FreeCAD (via freecad-mcp, the Python ' +
          'console, or a macro) that exports the active document to a .glb. Prefer this over ' +
          'export_glb when the harness can drive a running FreeCAD: it keeps per-face colours ' +
          '(ImportGui meshes from the view provider) and exports the live document rather than ' +
          'the last save. Then call publish_model with the path it reports.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          out: outField,
          linearDeflection: linearDeflectionField,
          angularDeflection: angularDeflectionField,
        },
      },
      async (args) => {
        try {
          const snippet = guiExportSnippet(cfg, args);
          return ok(
            [
              'Run this inside the FreeCAD that has the document open:',
              '',
              '```python',
              snippet.snippet,
              '```',
              '',
              ...snippet.notes.map((note) => `- ${note}`),
            ],
            snippet,
          );
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('publish_model')) {
    server.registerTool(
      'publish_model',
      {
        title: 'Publish a .glb as the next revision',
        description:
          'Publish an existing .glb as the next revision of a project and return its share URL. ' +
          'Signs POST /publish with the configured AWS profile, uploads to the presigned PUT, ' +
          'waits for the processor, then checks that the URL really serves. Checks the file ' +
          'locally first, because the processor rejects anything that is not glTF 2.0 binary or ' +
          'is over 100 MB. Revision numbers are monotonic and NEVER reused, so retries are made ' +
          'safe two ways: publishing bytes identical to the latest revision returns that revision ' +
          'instead of spending a number, and a publish that failed after reserving one can be ' +
          'finished by passing its revision. Editing and deleting revisions is not available ' +
          'here; use the /admin app.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          glb: z.string().describe('Path to the .glb to publish.'),
          project: projectField,
          title: titleField,
          notes: notesField,
          revision: revisionField,
          force: forceField,
          timeoutSeconds: z
            .number()
            .positive()
            .optional()
            .describe('How long to wait for processing. Defaults to publishTimeoutSeconds (120).'),
        },
      },
      async (args) => {
        try {
          const report = inspectGlb(
            resolveUserPath(args.glb, cfg, { extensions: ['.glb'], label: 'glb' }),
            cfg,
          );
          if (!report.publishable) {
            throw new BadRequest(
              `Refusing to publish: ${report.warnings.join(' ')} ` +
                '(the processor would reject this upload).',
            );
          }
          const result = await publishModel(cfg, args);
          return ok([...publishSummary(result), '', ...glbSummary(report)], {
            publish: result,
            inspection: report,
          });
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('convert_and_publish')) {
    server.registerTool(
      'convert_and_publish',
      {
        title: 'FreeCAD document → published revision',
        description:
          'The whole path in one call: headless-export a SAVED .FCStd to .glb, check what the ' +
          'viewer will show, and publish it as the next revision — returning the share URL. ' +
          'Same caveats as export_glb (reads the saved file; no per-face colours) and ' +
          'publish_model (revision numbers are never reused). Use export_glb + inspect_glb ' +
          'first when you want to look before committing a revision.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          fcstd: z.string().describe('Path to the saved .FCStd document.'),
          project: projectField,
          title: titleField,
          notes: notesField,
          revision: revisionField,
          force: forceField,
          out: outField,
          linearDeflection: linearDeflectionField,
          angularDeflection: angularDeflectionField,
        },
      },
      async (args) => {
        try {
          const exported = await exportGlb(cfg, args);
          const report = inspectGlb(exported.glb, cfg);
          if (!report.publishable) {
            throw new BadRequest(
              `Exported ${exported.glb} but refusing to publish it: ${report.warnings.join(' ')}`,
            );
          }
          const result = await publishModel(cfg, { ...args, glb: exported.glb });
          return ok(
            [
              ...publishSummary(result),
              '',
              `Exported from ${exported.fcstd} in ${(exported.durationMs / 1000).toFixed(1)}s`,
              ...glbSummary(report),
            ],
            { export: exported, inspection: report, publish: result },
          );
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  // --- reading the deployment ------------------------------------------------
  // All four read the public objects the viewer reads, straight off the
  // distribution: no credentials, no API call, nothing reserved. They start from
  // a slug because there is no public index of projects — listing them all is an
  // /admin route behind Cognito.

  if (enabled('list_revisions')) {
    server.registerTool(
      'list_revisions',
      {
        title: 'List a project’s published revisions',
        description:
          "Read a project's public manifest: its title, which revision is latest, and every " +
          'published revision with its notes, size, comment count and share URL. This is what a ' +
          'reviewer can see, so it also answers "did my publish actually appear?" and "what did I ' +
          'tell them changed last time?". Nothing that is still processing or that failed appears ' +
          'here — use get_publish_status for those.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { project: readProjectField },
      },
      async ({ project }) => {
        try {
          const slug = resolveProject(cfg, project);
          const reader = siteReader(cfg);
          const manifest = await fetchManifest(reader, slug);
          if (!manifest) {
            return ok(
              [
                `Nothing published under "${slug}": either the project does not exist, or no ` +
                  'revision has finished processing yet (get_publish_status can say which).',
              ],
              { project: slug, exists: false },
            );
          }
          const report = projectReport(manifest, reader.siteUrl);
          return ok(projectSummary(report), { exists: true, ...report });
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('get_publish_status')) {
    server.registerTool(
      'get_publish_status',
      {
        title: 'Check what happened to a publish',
        description:
          'Read the status object a publish writes: processing, ready (with the share URL), or ' +
          'error (with the reason the processor rejected it). This is the tool for a publish whose ' +
          'wait timed out or whose result was lost — the number was reserved either way, and this ' +
          'says whether it landed. A revision reported as error or still processing can be ' +
          'retried by passing its number as `revision` to publish_model, which reuses it instead ' +
          'of spending a new one.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { project: readProjectField, revision: readRevisionField },
      },
      async ({ project, revision }) => {
        try {
          const slug = resolveProject(cfg, project);
          const reader = siteReader(cfg);
          let rev = revision ?? null;
          if (rev === null) {
            rev = (await fetchManifest(reader, slug))?.latest ?? null;
            if (rev === null) {
              throw new BadRequest(
                `No published revision of "${slug}" to fall back on, so pass revision ` +
                  'explicitly — a failed publish reports the number it reserved.',
              );
            }
          }
          const status = await fetchStatus(reader, slug, rev);
          if (!status) {
            return ok(
              [
                `No status object for ${slug} revision ${rev}. That number was never reserved, or ` +
                  'the revision has since been deleted.',
              ],
              { project: slug, revision: rev, status: null },
            );
          }
          return ok(statusSummary(status, reader.siteUrl), status);
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('get_feedback')) {
    server.registerTool(
      'get_feedback',
      {
        title: 'Read the feedback on a project',
        description:
          "Read the reviewer comments on one revision, or across every revision of a project, " +
          'newest first. This closes the loop the host exists for: publish, send the link, read ' +
          'what came back, iterate. Comments are public and anonymous-capable, so treat the names ' +
          'as self-reported. Deleting a comment is not possible here — that means deleting the ' +
          'revision or the project from /admin.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          project: projectField,
          revision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Only this revision. Omit to roll up every revision that has comments.'),
        },
      },
      async ({ project, revision }) => {
        try {
          const slug = resolveProject(cfg, project);
          const reader = siteReader(cfg);
          const { items, revisionsRead, manifest } = await fetchFeedback(reader, slug, revision ?? null);
          if (!manifest && revision === undefined) {
            return ok([`Nothing published under "${slug}", so there is no feedback to read.`], {
              project: slug,
              exists: false,
              items: [],
            });
          }
          return ok(feedbackSummary(slug, items, revisionsRead), {
            project: slug,
            revisions: revisionsRead,
            count: items.length,
            items,
          });
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }

  if (enabled('verify_revision')) {
    server.registerTool(
      'verify_revision',
      {
        title: 'Check that a revision really serves',
        description:
          'Fetch a revision the way a reviewer would: its share page, then its model, checking ' +
          'the status, the content type, that the model is cached as immutable, and that the size ' +
          'served matches what the manifest recorded. A ready status only means the processor ' +
          'copied the file inside AWS; this is what proves the distribution, its origin access ' +
          'control, the certificate and DNS all agree — which matters most for a link already sent.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { project: readProjectField, revision: readRevisionField },
      },
      async ({ project, revision }) => {
        try {
          const slug = resolveProject(cfg, project);
          const reader = siteReader(cfg);
          const manifest = await fetchManifest(reader, slug);
          const rev = revision ?? manifest?.latest ?? null;
          if (rev === null) {
            throw new BadRequest(
              `No published revision of "${slug}" to verify. Pass revision explicitly, or check ` +
                'get_publish_status if a publish is still in flight.',
            );
          }
          const expectedBytes = manifest?.revisions.find((r) => r.rev === rev)?.bytes ?? null;
          const report = await verifyRevision(reader, slug, rev, expectedBytes);
          return ok(verifySummary(report), report);
        } catch (err) {
          return fail(err, log);
        }
      },
    );
  }
}

const INSTRUCTIONS = [
  'Publishes 3D models to the 3d.zach.nz review host and reads back what reviewers say:',
  'a project accumulates numbered revisions, each with its own public URL and feedback',
  'thread.',
  '',
  'Usual path: convert_and_publish(fcstd, project, notes) → share URL.',
  'Careful path: export_glb → inspect_glb → publish_model, when the parts panel matters.',
  'From an open FreeCAD: gui_export_instructions → run the snippet there → publish_model.',
  'Then: list_revisions to see what a reviewer sees, get_feedback to read the replies.',
  '',
  'Three things worth knowing before publishing. Revision numbers are never reused, so a',
  'throwaway publish burns one permanently — but a retry is safe: identical bytes return',
  'the revision that already holds them, and a publish that failed after reserving a',
  'number can be finished by passing that number as `revision`. If a publish times out,',
  'get_publish_status says whether it landed rather than guessing. And the FreeCAD object',
  "Labels in the document become the viewer's parts-panel checkboxes, with a `ref_` prefix",
  'marking context geometry that starts hidden.',
  '',
  'Editing notes, deleting a revision and listing every project are not available here:',
  'those routes need a Google sign-in, so they live in the /admin app.',
  '',
  'Run check_setup when anything fails: it names the broken link and its fix.',
].join('\n');

async function main(): Promise<void> {
  // A dependency's stray console.log would corrupt the JSON-RPC stream.
  console.log = (...args: unknown[]) => console.error(...args);

  const loaded = loadConfig();
  const log = makeLogger(loaded);
  const registered = activeTools(loaded.values);

  const server = new McpServer(
    { name: 'threed-host', version: packageVersion, title: '3D model host (3d.zach.nz)' },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, loaded, registered, log);

  await server.connect(new StdioServerTransport());
  log('info', 'ready', {
    tools: registered,
    profile: loaded.values.awsProfile,
    apiUrl: loaded.values.apiUrl,
    configFile: loaded.configFile,
    dryRun: loaded.values.dryRun,
  });
}

main().catch((err: unknown) => {
  const isConfig = err instanceof ConfigError;
  process.stderr.write(
    `[threed-mcp] ${isConfig ? 'configuration error' : 'failed to start'}: ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
