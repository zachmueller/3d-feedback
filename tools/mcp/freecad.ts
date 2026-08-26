/**
 * Drive tools/freecad_export_glb.py.
 *
 * Two paths, because they are not equivalent:
 *
 *  - headless `freecadcmd`, which any harness can run unattended but has no view
 *    provider, so it exports without per-face colours and reads the *saved*
 *    document (unsaved GUI edits are invisible to it);
 *  - a snippet to `exec()` inside an already-open FreeCAD, for a harness that has
 *    freecad-mcp — colours survive and the live document is what gets exported.
 *
 * Neither the exit code nor stderr tells you whether a headless export worked.
 * FreeCAD exits 0 while printing `Exception while processing file: out.glb`
 * (it tries to open the *output* path as a document — documented in the exporter)
 * and a 3Dconnexion driver `Error:` on machines without a SpaceMouse. The
 * produced file is the only reliable signal, so that is what is checked.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { type Config, PathError, resolveUserPath } from './config';

const execFileAsync = promisify(execFile);

/** FreeCAD chatter that means nothing went wrong. Verified against 1.1.3. */
const NOISE_PATTERNS: RegExp[] = [
  // The exporter documents this one: FreeCAD opens every positional argument as
  // a document, including the .glb it is about to write.
  /^Exception while processing file:/,
  // No SpaceMouse driver installed. Printed as "Error:", which is alarming and
  // irrelevant.
  /3DconnexionNavlib/,
  // Startup banner, printed on exit in console mode.
  /^FreeCAD \d+\.\d+/,
  /^\(C\) \d{4}/,
  /^FreeCAD is free and open-source software/,
];

/** A progress bar rendered with tabs: "(33 %)…(100 %)…Postprocessing……". */
function isProgressChatter(line: string): boolean {
  return (
    line
      .replace(/\(\s*\d+\s*%\s*\)/g, '')
      .replace(/Postprocessing\.*/g, '')
      .replace(/Importing project files\.*/g, '')
      .trim() === ''
  );
}

export interface ParsedExportOutput {
  /** The object labels the exporter reported, which become the glTF node names. */
  labels: string[];
  exportedCount: number | null;
  /** `tessellation: …` lines — the exporter reports what it actually applied. */
  tessellation: string[];
  /** `warning: …` lines from the exporter, plus anything unrecognised on stderr. */
  warnings: string[];
  freecadVersion: string | null;
  /** Lines that were recognised as chatter and dropped. */
  noise: string[];
  /** Everything left over, in order — surfaced when an export fails. */
  other: string[];
}

/**
 * Split FreeCAD's output into the parts worth reporting.
 *
 * Kept pure and exported so test/mcp-freecad.test.ts can pin it against captured
 * real output without needing FreeCAD installed.
 */
export function parseExportOutput(stdout: string, stderr = ''): ParsedExportOutput {
  const result: ParsedExportOutput = {
    labels: [],
    exportedCount: null,
    tessellation: [],
    warnings: [],
    freecadVersion: null,
    noise: [],
    other: [],
  };

  const classify = (raw: string, fromStderr: boolean): void => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;

    const version = /^FreeCAD (\d+\.\d+\.\d+)/.exec(line);
    if (version) result.freecadVersion = version[1];

    if (isProgressChatter(line) || NOISE_PATTERNS.some((re) => re.test(line.trim()))) {
      result.noise.push(line.trim());
      return;
    }

    const exported = /^exported (\d+) object\(s\) to /.exec(line);
    if (exported) {
      result.exportedCount = Number(exported[1]);
      return;
    }
    const label = /^ {2}- (.+)$/.exec(line);
    if (label) {
      result.labels.push(label[1]);
      return;
    }
    if (line.startsWith('tessellation: ')) {
      result.tessellation.push(line.slice('tessellation: '.length));
      return;
    }
    if (/^warning: /i.test(line)) {
      result.warnings.push(line.replace(/^warning: /i, ''));
      return;
    }
    // Unrecognised stderr is the interesting kind: a real FreeCAD failure.
    (fromStderr ? result.warnings : result.other).push(line.trim());
  };

  for (const line of stdout.split('\n')) classify(line, false);
  for (const line of stderr.split('\n')) classify(line, true);
  return result;
}

export interface ExportRequest {
  fcstd: string;
  out?: string;
  linearDeflection?: number;
  angularDeflection?: number;
}

export interface ExportResult {
  glb: string;
  bytes: number;
  fcstd: string;
  command: string;
  durationMs: number;
  parsed: ParsedExportOutput;
}

/** Where an auto-named export goes: <workDir>/<document name>.glb */
export function defaultOutPath(cfg: Config, fcstd: string): string {
  const stem = path.basename(fcstd).replace(/\.fcstd$/i, '') || 'model';
  return path.join(cfg.workDir, `${stem}.glb`);
}

/** Quote an argument for the copy-pasteable command line we report back. */
const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_./:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

export function exportArgs(cfg: Config, req: ExportRequest, out: string): string[] {
  const args = [cfg.exportScript, '--', out, '--fcstd', req.fcstd];
  const linear = req.linearDeflection ?? cfg.defaultLinearDeflection;
  const angular = req.angularDeflection ?? cfg.defaultAngularDeflection;
  if (linear !== null && linear !== undefined) args.push('--linear-deflection', String(linear));
  if (angular !== null && angular !== undefined) args.push('--angular-deflection', String(angular));
  return args;
}

/**
 * Export a saved .FCStd to a .glb with headless FreeCAD.
 *
 * Success is "a non-empty file appeared where we asked for one" — see the module
 * comment for why the exit code cannot be trusted. Validity of the container
 * itself is left to inspectGlb, which the caller runs next.
 */
export async function exportGlb(cfg: Config, req: ExportRequest): Promise<ExportResult> {
  // Arguments before configuration, the same way lib/lambda/handler.ts's
  // actionPublish does it: a bad argument should be answered as a bad argument,
  // not as whatever the environment happens to be missing.
  const fcstd = resolveUserPath(req.fcstd, cfg, { extensions: ['.fcstd'], label: 'fcstd' });
  if (!fs.existsSync(fcstd)) throw new PathError(`No such document: ${fcstd}`);

  if (!cfg.freecadcmd) {
    throw new Error(
      'No freecadcmd found. Install FreeCAD, or set THREED_FREECADCMD to its console ' +
        'binary (on macOS: /Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd). ' +
        'It is deliberately not on PATH in a default install.',
    );
  }
  if (!fs.existsSync(cfg.exportScript)) {
    throw new Error(`The exporter is missing: ${cfg.exportScript} (set THREED_EXPORT_SCRIPT)`);
  }

  const out = req.out
    ? resolveUserPath(req.out, cfg, { extensions: ['.glb'], label: 'out' })
    : defaultOutPath(cfg, fcstd);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // A stale file from an earlier run would otherwise be reported as a success.
  fs.rmSync(out, { force: true });

  const args = exportArgs(cfg, { ...req, fcstd }, out);
  const command = [cfg.freecadcmd, ...args].map(shellQuote).join(' ');
  const started = Date.now();

  let stdout = '';
  let stderr = '';
  let failure: Error | null = null;
  try {
    const res = await execFileAsync(cfg.freecadcmd, args, {
      timeout: cfg.freecadTimeoutSeconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err: any) {
    stdout = String(err?.stdout ?? '');
    stderr = String(err?.stderr ?? '');
    failure =
      err?.killed || err?.signal
        ? new Error(
            `FreeCAD was killed after ${cfg.freecadTimeoutSeconds}s ` +
              '(raise THREED_FREECAD_TIMEOUT_SECONDS for a heavy assembly).',
          )
        : err;
  }

  const parsed = parseExportOutput(stdout, stderr);
  const durationMs = Date.now() - started;

  const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
  if (bytes === 0) {
    const detail = [
      ...parsed.warnings,
      ...parsed.other,
      failure ? failure.message : '',
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `FreeCAD wrote no .glb to ${out}.\n\n${detail || 'FreeCAD produced no diagnostics.'}\n\n` +
        `Command: ${command}\n` +
        'Common causes: the document has no visible top-level object with faces, ' +
        'or every body is nested inside a container that was itself hidden.',
    );
  }

  return { glb: out, bytes, fcstd, command, durationMs, parsed };
}

export interface GuiSnippet {
  out: string;
  snippet: string;
  notes: string[];
}

/**
 * The code to run inside an open FreeCAD — the path that keeps per-face colours.
 *
 * Written for a harness whose FreeCAD integration executes Python in the running
 * application (freecad-mcp does exactly this); the exporter is `exec`'d rather
 * than imported so it needs nothing on FreeCAD's `sys.path`.
 */
export function guiExportSnippet(
  cfg: Config,
  req: { out?: string; linearDeflection?: number; angularDeflection?: number } = {},
): GuiSnippet {
  const out = req.out
    ? resolveUserPath(req.out, cfg, { extensions: ['.glb'], label: 'out' })
    : path.join(cfg.workDir, 'export.glb');

  const linear = req.linearDeflection ?? cfg.defaultLinearDeflection;
  const angular = req.angularDeflection ?? cfg.defaultAngularDeflection;
  const kwargs = [
    `'${out}'`,
    ...(linear !== null && linear !== undefined ? [`linear_deflection=${linear}`] : []),
    ...(angular !== null && angular !== undefined ? [`angular_deflection=${angular}`] : []),
  ].join(', ');

  const snippet = [
    `exec(open('${cfg.exportScript}').read())`,
    `export_glb(${kwargs})`,
  ].join('\n');

  return {
    out,
    snippet,
    notes: [
      'Run this in the FreeCAD that already has the document open (freecad-mcp\'s Python ' +
        'execution, the Python console, or a macro). It exports the ACTIVE document.',
      'This path keeps per-face colours, because ImportGui meshes from the view provider; ' +
        'the headless export_glb tool cannot.',
      'It prints the exported object labels — those become the glTF node names and, in turn, ' +
        'the viewer\'s parts-panel checkboxes.',
      `Then publish it: publish_model with glb=${out}`,
    ],
  };
}
