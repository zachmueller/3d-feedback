/**
 * GLB inspection and the parts-panel prediction.
 *
 * The prediction in tools/mcp/glb.ts is a second implementation of
 * viewer-app/viewer.js's `componentNodes()` / `nameResolver()` / `REFERENCE_PREFIX`,
 * running on the raw glTF JSON instead of a three.js scene. This file is what
 * keeps the two honest: the shared sample model (scripts/make-sample-glb.js, also
 * what the dev server serves) is asserted to produce exactly the panel the viewer
 * renders from it, and the node shapes a FreeCAD export actually arrives in —
 * wrapped in a container node, or with per-face colours split across primitives —
 * are pinned separately.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../tools/mcp/config';
import { GlbError, inspectGlb, parseGlbContainer, predictParts } from '../tools/mcp/glb';

const cfg = loadConfig({ env: { PATH: '' } }).values;

let dir: string;
let samplePath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threed-mcp-glb-'));
  samplePath = path.join(dir, 'sample.glb');
  // The same generator the dev server and the smoke test use, rebuilt rather than
  // committed so it cannot drift from the viewer's fixture.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-sample-glb.js'), samplePath], {
    stdio: 'ignore',
  });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the sample model', () => {
  it('reports the three parts the viewer shows, in file order', () => {
    const report = inspectGlb(samplePath, cfg);
    expect(report.parts.map((part) => part.displayName)).toEqual([
      'Base Plate',
      'Clip Arm',
      'Wall Panel (reference)',
    ]);
    expect(report.partsPanelShown).toBe(true);
  });

  it('starts the ref_ part hidden and the printed parts visible', () => {
    const { parts } = inspectGlb(samplePath, cfg);
    expect(parts.map((part) => part.checkedByDefault)).toEqual([true, true, false]);
    expect(parts.filter((part) => part.reference).map((part) => part.name)).toEqual(['ref_Wall Panel']);
  });

  it('counts the triangles of a 12-triangle cube per part', () => {
    const report = inspectGlb(samplePath, cfg);
    expect(report.parts.map((part) => part.triangles)).toEqual([12, 12, 12]);
    expect(report.triangles).toBe(36);
  });

  it('is publishable, and reports the file it read', () => {
    const report = inspectGlb(samplePath, cfg);
    expect(report.publishable).toBe(true);
    expect(report.gltfVersion).toBe(2);
    expect(report.generator).toMatch(/3d-feedback/);
    expect(report.bytes).toBe(fs.statSync(samplePath).size);
  });
});

describe('rejecting what the processor would reject', () => {
  it('rejects a .gltf JSON file with a message naming the accepted format', () => {
    const file = path.join(dir, 'model.gltf');
    fs.writeFileSync(file, JSON.stringify({ asset: { version: '2.0' } }));
    expect(() => inspectGlb(file, cfg)).toThrow(GlbError);
    expect(() => inspectGlb(file, cfg)).toThrow(/glTF 2.0 binary/);
  });

  it('rejects an empty file', () => {
    const file = path.join(dir, 'empty.glb');
    fs.writeFileSync(file, '');
    expect(() => inspectGlb(file, cfg)).toThrow(/is empty/);
  });

  it('detects a truncated upload rather than reporting nonsense', () => {
    const truncated = fs.readFileSync(samplePath).subarray(0, 200);
    const file = path.join(dir, 'truncated.glb');
    fs.writeFileSync(file, truncated);
    expect(() => inspectGlb(file, cfg)).toThrow(/Truncated \.glb/);
  });

  it('warns and refuses when the file is over the server-side cap', () => {
    const small = { ...cfg, maxModelBytes: 100, warnModelBytes: 50 };
    const report = inspectGlb(samplePath, small);
    expect(report.publishable).toBe(false);
    expect(report.warnings.join(' ')).toMatch(/exceeds the .* cap/);
  });

  it('warns without refusing between the advisory threshold and the cap', () => {
    const report = inspectGlb(samplePath, { ...cfg, warnModelBytes: 100 });
    expect(report.publishable).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/advisory threshold/);
  });
});

describe('parseGlbContainer', () => {
  it('reads the header and the JSON chunk', () => {
    const parsed = parseGlbContainer(fs.readFileSync(samplePath));
    expect(parsed.version).toBe(2);
    expect(parsed.declaredLength).toBe(fs.statSync(samplePath).size);
    expect(parsed.json.nodes).toHaveLength(3);
    expect(parsed.binLength).toBeGreaterThan(0);
  });
});

// --- node shapes a real FreeCAD export arrives in ---------------------------

/** A glTF JSON skeleton; only the fields the prediction reads are filled in. */
function gltf(nodes: any[], meshes: any[] = [], rootNodes?: number[]): any {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: rootNodes ?? nodes.map((_node, i) => i) }],
    nodes,
    meshes: meshes.length ? meshes : [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ count: 24 }, { count: 36 }],
  };
}

describe('predictParts, on the shapes FreeCAD produces', () => {
  it('descends past the container node an assembly is wrapped in', () => {
    // What tools/freecad_export_glb.py actually writes: one root node holding the
    // exported objects. Verified against FreeCAD 1.1.3 — a 3-body export arrives
    // as 4 nodes, and the viewer descends to the children.
    const json = gltf(
      [
        { name: 'Document', children: [1, 2, 3] },
        { name: 'Base Plate', mesh: 0 },
        { name: 'Clip Arm', mesh: 0 },
        { name: 'ref_Wall Panel', mesh: 0 },
      ],
      [],
      [0],
    );
    expect(predictParts(json).map((part) => part.displayName)).toEqual([
      'Base Plate',
      'Clip Arm',
      'Wall Panel (reference)',
    ]);
  });

  it('falls back to the meshes when a single part is exported', () => {
    const json = gltf([{ name: 'Solo', mesh: 0 }], [], [0]);
    const parts = predictParts(json);
    expect(parts).toHaveLength(1);
    expect(parts[0].displayName).toBe('Solo');
  });

  it('names a part from its mesh when the node is unnamed', () => {
    const json = gltf(
      [{ children: [1, 2] }, { mesh: 0 }, { mesh: 1 }],
      [{ name: 'From Mesh A', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
       { name: 'From Mesh B', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      [0],
    );
    expect(predictParts(json).map((part) => part.name)).toEqual(['From Mesh A', 'From Mesh B']);
  });

  it('falls back to "Part N" when nothing is named, as the viewer does', () => {
    const json = gltf([{ children: [1, 2] }, { mesh: 0 }, { mesh: 0 }], [], [0]);
    expect(predictParts(json).map((part) => part.displayName)).toEqual(['Part 1', 'Part 2']);
  });

  it('treats a multi-primitive mesh as the group of primitives three.js builds', () => {
    // Per-face colours make OCCT split one body across primitives. GLTFLoader
    // turns that into a Group of meshes, so the viewer lists one checkbox per
    // primitive — all carrying the same name.
    const json = gltf(
      [{ name: 'Coloured Body', mesh: 0 }],
      [
        {
          name: 'Coloured Body',
          primitives: [
            { attributes: { POSITION: 0 }, indices: 1, material: 0 },
            { attributes: { POSITION: 0 }, indices: 1, material: 1 },
          ],
        },
      ],
      [0],
    );
    expect(predictParts(json).map((part) => part.name)).toEqual(['Coloured Body', 'Coloured Body']);
  });

  it('matches the viewer on every spelling of the reference prefix', () => {
    const json = gltf(
      [
        { children: [1, 2, 3, 4, 5] },
        { name: 'ref_Wall', mesh: 0 },
        { name: 'REF_Wall', mesh: 0 },
        { name: 'ref Wall', mesh: 0 },
        { name: 'ref-Wall', mesh: 0 },
        { name: 'refactored', mesh: 0 },
      ],
      [],
      [0],
    );
    const parts = predictParts(json);
    expect(parts.map((part) => part.reference)).toEqual([true, true, true, true, false]);
    expect(parts.map((part) => part.displayName)).toEqual([
      'Wall (reference)',
      'Wall (reference)',
      'Wall (reference)',
      'Wall (reference)',
      'refactored',
    ]);
  });

  it('ignores a node that only carries a transform', () => {
    const json = gltf(
      [{ children: [1, 2] }, { name: 'Empty', translation: [1, 0, 0] }, { name: 'Real', mesh: 0 }],
      [],
      [0],
    );
    expect(predictParts(json).map((part) => part.name)).toEqual(['Real']);
  });

  it('does not loop forever on a cyclic node graph', () => {
    const json = gltf([{ name: 'A', children: [1] }, { name: 'B', mesh: 0, children: [0] }], [], [0]);
    expect(() => predictParts(json)).not.toThrow();
  });
});

describe('warnings a modeller should act on', () => {
  const inspect = (json: any): string[] => {
    const file = path.join(dir, `warn-${Math.abs(JSON.stringify(json).length)}.glb`);
    writeGlb(file, json);
    return inspectGlb(file, cfg).warnings;
  };

  it('says the parts panel will be hidden for a single component', () => {
    expect(inspect(gltf([{ name: 'Solo', mesh: 0 }], [], [0])).join(' ')).toMatch(
      /only one component/,
    );
  });

  it('says so when everything is reference geometry', () => {
    const json = gltf(
      [{ children: [1, 2] }, { name: 'ref_A', mesh: 0 }, { name: 'ref_B', mesh: 0 }],
      [],
      [0],
    );
    expect(inspect(json).join(' ')).toMatch(/opens with nothing visible/);
  });

  it('explains repeated checkbox names', () => {
    const json = gltf(
      [{ children: [1, 2] }, { name: 'Same', mesh: 0 }, { name: 'Same', mesh: 0 }],
      [],
      [0],
    );
    expect(inspect(json).join(' ')).toMatch(/repeated checkbox names \(Same\)/);
  });
});

/** Minimal GLB writer, so a hand-built scene can be run through inspectGlb. */
function writeGlb(file: string, json: any): void {
  const jsonChunk = Buffer.from(JSON.stringify(json), 'utf-8');
  const padded = Buffer.concat([jsonChunk, Buffer.alloc((4 - (jsonChunk.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(padded.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  fs.writeFileSync(file, Buffer.concat([header, chunkHeader, padded]));
}
