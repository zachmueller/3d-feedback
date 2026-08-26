/**
 * Reading FreeCAD's headless output, and the arguments it is given.
 *
 * A headless export exits 0 while printing an `Exception while processing file:`
 * (FreeCAD opens the *output* path as a document) and, on a machine with no
 * SpaceMouse, an alarming `Error: Failed to open library …3DconnexionNavlib`.
 * Neither means anything went wrong, and a harness that reports them as failures
 * sends its user chasing nothing. The fixtures below are real output, captured
 * from FreeCAD 1.1.3 exporting a three-body document, so the filter is pinned to
 * what FreeCAD actually emits rather than to what it is documented to emit.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../tools/mcp/config';
import { defaultOutPath, exportArgs, exportGlb, guiExportSnippet, parseExportOutput } from '../tools/mcp/freecad';

const cfg = loadConfig({ env: { PATH: '' }, repoRoot: '/repo' }).values;

// Verbatim from `freecadcmd tools/freecad_export_glb.py -- out.glb --fcstd part.FCStd`.
const REAL_STDOUT = [
  'tessellation: triangulated 3 shape(s) at 0.5% of size (console mode: plain Import, so no per-face colours)',
  'exported 3 object(s) to /tmp/out.glb (8.7 KB)',
  '  - Base Plate',
  '  - Clip Arm',
  '  - ref_Wall Panel',
  'FreeCAD 1.1.3, Libs: 1.1.3R20260725 (Git shallow)',
  '(C) 2001-2026 FreeCAD contributors',
  'FreeCAD is free and open-source software licensed under the terms of LGPL2+ license.',
  '',
  'Importing project files......',
  '\t\t\t\t\t\t(33 %)\t\r\t\t\t\t\t\t(66 %)\t\r\t\t\t\t\t\t(100 %)\t\r\t\t\t\t\t\t\t\t\rPostprocessing......',
  '\t\t\t\t\t\t(100 %)',
].join('\n');

const REAL_STDERR = [
  'Error: Failed to open library "/Library/Frameworks/3DconnexionNavlib.framework/3DconnexionNavlib"! ' +
    'Error: dlopen(/Library/Frameworks/3DconnexionNavlib.framework/3DconnexionNavlib, 0x0005): tried: ' +
    "'/Library/Frameworks/3DconnexionNavlib.framework/3DconnexionNavlib' (no such file)!",
  'Exception while processing file: /tmp/out.glb [Cannot load Gui module in console application.]',
].join('\n');

describe('parseExportOutput, on real FreeCAD output', () => {
  const parsed = parseExportOutput(REAL_STDOUT, REAL_STDERR);

  it('recovers the exported object labels, which become the part names', () => {
    expect(parsed.labels).toEqual(['Base Plate', 'Clip Arm', 'ref_Wall Panel']);
    expect(parsed.exportedCount).toBe(3);
  });

  it('keeps the tessellation report, since a silent no-op is the bug it exists for', () => {
    expect(parsed.tessellation).toHaveLength(1);
    expect(parsed.tessellation[0]).toMatch(/triangulated 3 shape\(s\) at 0.5%/);
  });

  it('reports no warnings for an export that worked', () => {
    expect(parsed.warnings).toEqual([]);
    expect(parsed.other).toEqual([]);
  });

  it('classifies the harmless "Exception while processing file" as noise', () => {
    expect(parsed.noise.join('\n')).toMatch(/Exception while processing file/);
  });

  it('classifies the 3Dconnexion driver error as noise', () => {
    expect(parsed.noise.join('\n')).toMatch(/3DconnexionNavlib/);
  });

  it('swallows the banner and the progress bar, and keeps the version', () => {
    expect(parsed.freecadVersion).toBe('1.1.3');
    expect(parsed.noise.some((line) => line.startsWith('(C) 2001'))).toBe(true);
    expect(parsed.noise.some((line) => /\(100 %\)/.test(line))).toBe(true);
  });
});

describe('parseExportOutput, on output that does mean something', () => {
  it("surfaces the exporter's own warnings", () => {
    const parsed = parseExportOutput(
      'warning: no object exposes AngularDeflection, so 5 was NOT applied\n' +
        'warning: angular_deflection=0.5 looks like radians\n',
    );
    expect(parsed.warnings).toEqual([
      'no object exposes AngularDeflection, so 5 was NOT applied',
      'angular_deflection=0.5 looks like radians',
    ]);
  });

  it('treats unrecognised stderr as a warning, not as noise', () => {
    const parsed = parseExportOutput('', 'Traceback (most recent call last):\n  RuntimeError: boom');
    expect(parsed.warnings.join(' ')).toMatch(/RuntimeError: boom/);
    expect(parsed.noise).toEqual([]);
  });

  it('keeps unrecognised stdout separate, for a failure report', () => {
    const parsed = parseExportOutput('something unexpected happened');
    expect(parsed.other).toEqual(['something unexpected happened']);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('exportArgs', () => {
  const req = { fcstd: '/models/part.FCStd' };

  it('passes the script, the -- separator, then the output and the document', () => {
    expect(exportArgs(cfg, req, '/tmp/out.glb')).toEqual([
      path.join('/repo', 'tools', 'freecad_export_glb.py'),
      '--',
      '/tmp/out.glb',
      '--fcstd',
      '/models/part.FCStd',
    ]);
  });

  it('adds the deflection flags only when a value exists', () => {
    expect(exportArgs(cfg, { ...req, linearDeflection: 0.05 }, '/tmp/o.glb')).toContain(
      '--linear-deflection',
    );
    expect(exportArgs(cfg, { ...req, angularDeflection: 10 }, '/tmp/o.glb')).toEqual(
      expect.arrayContaining(['--angular-deflection', '10']),
    );
  });

  it('applies the configured defaults when the call omits them', () => {
    const withDefaults = { ...cfg, defaultLinearDeflection: 0.1, defaultAngularDeflection: 15 };
    expect(exportArgs(withDefaults, req, '/tmp/o.glb')).toEqual(
      expect.arrayContaining(['--linear-deflection', '0.1', '--angular-deflection', '15']),
    );
  });

  it('lets a per-call value beat the configured default', () => {
    const withDefaults = { ...cfg, defaultLinearDeflection: 0.1 };
    expect(exportArgs(withDefaults, { ...req, linearDeflection: 0.02 }, '/tmp/o.glb')).toEqual(
      expect.arrayContaining(['--linear-deflection', '0.02']),
    );
  });
});

describe('defaultOutPath', () => {
  it('names the .glb after the document, inside the work directory', () => {
    expect(defaultOutPath(cfg, '/models/Towel Clip.FCStd')).toBe(
      path.join(os.tmpdir(), '3d-feedback', 'Towel Clip.glb'),
    );
  });

  it('strips the extension case-insensitively', () => {
    expect(path.basename(defaultOutPath(cfg, '/models/part.fcstd'))).toBe('part.glb');
  });
});

describe('guiExportSnippet', () => {
  const snippet = guiExportSnippet({ ...cfg, workDir: '/work' }, { linearDeflection: 0.05 });

  it('execs the exporter by absolute path, so FreeCAD needs nothing on sys.path', () => {
    expect(snippet.snippet).toContain(
      `exec(open('${path.join('/repo', 'tools', 'freecad_export_glb.py')}').read())`,
    );
  });

  it('passes the deflection as a keyword argument', () => {
    expect(snippet.snippet).toContain("export_glb('/work/export.glb', linear_deflection=0.05)");
  });

  it('omits the keyword entirely when unset, leaving FreeCAD its own default', () => {
    const plain = guiExportSnippet({ ...cfg, workDir: '/work' });
    expect(plain.snippet).toContain("export_glb('/work/export.glb')");
  });

  it('tells the caller what to do next, and why this path exists', () => {
    expect(snippet.notes.join(' ')).toMatch(/ACTIVE document/);
    expect(snippet.notes.join(' ')).toMatch(/per-face colours/);
    expect(snippet.notes.join(' ')).toMatch(/publish_model with glb=\/work\/export\.glb/);
  });
});

describe('exportGlb refuses clearly', () => {
  // An empty stand-in: none of these cases get as far as running FreeCAD.
  let fcstd: string;

  beforeAll(() => {
    fcstd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'threed-mcp-fc-')), 'part.FCStd');
    fs.writeFileSync(fcstd, '');
  });

  it('rejects a document that is not a .FCStd before looking at the environment', async () => {
    // Argument first, configuration second — see the comment in exportGlb.
    await expect(exportGlb({ ...cfg, freecadcmd: null }, { fcstd: '/models/a.step' })).rejects.toThrow(
      /must end in \.fcstd/i,
    );
  });

  it('rejects a missing document', async () => {
    await expect(exportGlb(cfg, { fcstd: '/models/absent.FCStd' })).rejects.toThrow(/No such document/);
  });

  it('explains that freecadcmd is not on PATH by design', async () => {
    await expect(exportGlb({ ...cfg, freecadcmd: null }, { fcstd })).rejects.toThrow(
      /not on PATH in a default install/,
    );
  });

  it('names the exporter when it is missing', async () => {
    await expect(exportGlb({ ...cfg, freecadcmd: '/bin/true' }, { fcstd })).rejects.toThrow(
      /The exporter is missing/,
    );
  });

  it('reports a FreeCAD run that produced no file, with the command it ran', async () => {
    // /bin/true stands in for a FreeCAD that exits 0 without exporting — the exact
    // failure mode the exit code cannot detect.
    await expect(
      exportGlb({ ...cfg, freecadcmd: '/bin/true', exportScript: __filename }, { fcstd }),
    ).rejects.toThrow(/wrote no \.glb/);
  });
});
