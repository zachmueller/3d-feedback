/**
 * Read a .glb locally and predict what the viewer will make of it.
 *
 * Two things this catches before a publish rather than after: a file the
 * processor will reject (the Lambda checks the same magic bytes and the same
 * size cap), and a parts panel that will not look the way the modeller expects —
 * a missing `ref_` prefix, a body that was left visible, an assembly that
 * collapsed to a single component.
 *
 * The parts prediction deliberately mirrors viewer-app/viewer.js:
 * `componentNodes()` (which nodes get a checkbox), `nameResolver()` (which name
 * they get) and `REFERENCE_PREFIX` (which start switched off). If that code
 * changes, this has to change with it — test/mcp-glb.test.ts pins the pair
 * against the shared sample model.
 */
import * as fs from 'fs';

// The magic-byte check the processor applies to every upload, so "would this be
// accepted?" is answered by the same predicate on both sides.
import { looksLikeGlb } from '../../lib/lambda/handler';

import type { Config } from './config';

/** A .glb that cannot be parsed at all. */
export class GlbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlbError';
  }
}

const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** viewer.js: `const REFERENCE_PREFIX = /^ref[\s_-]+/i` */
const REFERENCE_PREFIX = /^ref[\s_-]+/i;

export interface ParsedGlb {
  version: number;
  declaredLength: number;
  jsonLength: number;
  binLength: number;
  json: any;
}

export interface GlbPart {
  /** The name as written in the file — the FreeCAD object's Label. */
  name: string;
  /** What the viewer's checkbox will read. */
  displayName: string;
  /** Matched the `ref_` convention, so it is context rather than a printed part. */
  reference: boolean;
  /** Reference parts start hidden; everything else starts visible. */
  checkedByDefault: boolean;
  triangles: number;
}

export interface GlbReport {
  path: string;
  bytes: number;
  gltfVersion: number;
  generator: string | null;
  nodeCount: number;
  meshCount: number;
  materialCount: number;
  triangles: number;
  /** False when the viewer will hide the panel entirely (fewer than 2 parts). */
  partsPanelShown: boolean;
  parts: GlbPart[];
  warnings: string[];
  /** Would the deployed processor accept this file? */
  publishable: boolean;
}

/**
 * Split a GLB container into its header and chunks.
 *
 * Layout (glTF 2.0 binary): a 12-byte header — magic, version, total length —
 * then length-prefixed chunks, the first of which must be the JSON scene.
 */
export function parseGlbContainer(buf: Buffer): ParsedGlb {
  if (buf.length < 12 || !looksLikeGlb(buf.subarray(0, 12))) {
    throw new GlbError(
      'Not a binary glTF file. The viewer and the publish processor accept .glb ' +
        '(glTF 2.0 binary) only — .gltf, .stl and .step are rejected server-side.',
    );
  }

  const version = buf.readUInt32LE(4);
  const declaredLength = buf.readUInt32LE(8);

  let offset = 12;
  let json: any;
  let jsonLength = 0;
  let binLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > buf.length) {
      throw new GlbError(
        `Truncated .glb: a chunk claims ${chunkLength} bytes but only ` +
          `${buf.length - start} remain. The upload was probably cut short.`,
      );
    }
    if (chunkType === CHUNK_JSON && json === undefined) {
      jsonLength = chunkLength;
      const text = buf.subarray(start, end).toString('utf-8');
      try {
        json = JSON.parse(text);
      } catch (err: any) {
        throw new GlbError(`The .glb's JSON chunk is not valid JSON: ${err?.message ?? err}`);
      }
    } else if (chunkType === CHUNK_BIN) {
      binLength += chunkLength;
    }
    offset = end;
  }

  if (json === undefined) throw new GlbError('The .glb has no JSON chunk.');
  return { version, declaredLength, jsonLength, binLength, json };
}

// --- the viewer's parts-panel logic, applied to the glTF JSON ----------------

interface TreeNode {
  label: string;
  /** True for the objects three.js would create as a Mesh (not a Group). */
  isMesh: boolean;
  triangles: number;
  children: TreeNode[];
}

/** Triangles a primitive contributes. Mode defaults to 4 (TRIANGLES). */
function primitiveTriangles(json: any, primitive: any): number {
  const mode = primitive?.mode ?? 4;
  const accessorCount = (index: unknown): number => {
    const accessor = typeof index === 'number' ? json.accessors?.[index] : undefined;
    return typeof accessor?.count === 'number' ? accessor.count : 0;
  };
  const count =
    primitive?.indices !== undefined
      ? accessorCount(primitive.indices)
      : accessorCount(primitive?.attributes?.POSITION);
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0; // points and lines carry no faces
}

/**
 * Model the object graph GLTFLoader would build.
 *
 * The one place it differs from the glTF node graph: a mesh with several
 * primitives (which is how OCCT writes per-face colours) becomes a *Group* of
 * primitive meshes, so it contributes children the JSON does not list. The
 * viewer's `componentNodes()` counts children, so that difference can change
 * which nodes get a checkbox — hence modelling it rather than walking the JSON
 * naively.
 */
function buildNode(json: any, index: number, seen: Set<number>): TreeNode {
  const def = json.nodes?.[index] ?? {};
  const mesh = typeof def.mesh === 'number' ? json.meshes?.[def.mesh] : undefined;
  const primitives: any[] = mesh?.primitives ?? [];
  const multiPrimitive = primitives.length > 1;

  // nameResolver(): the node's name wins, then the mesh's.
  const label = String(def.name || mesh?.name || '');

  const primitiveChildren: TreeNode[] = multiPrimitive
    ? primitives.map((primitive) => ({
        label: String(mesh?.name || ''),
        isMesh: true,
        triangles: primitiveTriangles(json, primitive),
        children: [],
      }))
    : [];

  const childIndexes: number[] = Array.isArray(def.children) ? def.children : [];
  const nodeChildren = childIndexes
    // A malformed file could cycle; a node reached twice is dropped rather than
    // recursed into forever.
    .filter((child) => typeof child === 'number' && !seen.has(child))
    .map((child) => {
      seen.add(child);
      return buildNode(json, child, seen);
    });

  return {
    label,
    isMesh: !multiPrimitive && primitives.length > 0,
    triangles: multiPrimitive ? 0 : primitives.reduce((n, p) => n + primitiveTriangles(json, p), 0),
    children: [...primitiveChildren, ...nodeChildren],
  };
}

function buildSceneTree(json: any): TreeNode {
  const scene = json.scenes?.[typeof json.scene === 'number' ? json.scene : 0] ?? json.scenes?.[0];
  const roots: number[] = Array.isArray(scene?.nodes) ? scene.nodes : [];
  const seen = new Set<number>(roots);
  return {
    label: '',
    isMesh: false,
    triangles: 0,
    children: roots.map((index) => buildNode(json, index, seen)),
  };
}

const containsMesh = (node: TreeNode): boolean =>
  node.isMesh || node.children.some(containsMesh);

function collectMeshes(node: TreeNode, into: TreeNode[] = []): TreeNode[] {
  if (node.isMesh) into.push(node);
  for (const child of node.children) collectMeshes(child, into);
  return into;
}

function subtreeTriangles(node: TreeNode): number {
  return node.triangles + node.children.reduce((n, child) => n + subtreeTriangles(child), 0);
}

/** viewer.js `componentNodes()`, verbatim in structure. */
function componentNodes(root: TreeNode): TreeNode[] {
  let node = root;
  while (node.children.length === 1 && containsMesh(node.children[0])) {
    node = node.children[0];
  }
  const branches = node.children.filter(containsMesh);
  if (branches.length > 1) return branches;

  const meshes = collectMeshes(root);
  if (meshes.length > 1) return meshes;
  return branches.length ? branches : meshes;
}

/** The parts list the viewer will render, in order, with its default visibility. */
export function predictParts(json: any): GlbPart[] {
  return componentNodes(buildSceneTree(json)).map((node, i) => {
    const raw = node.label || `Part ${i + 1}`;
    const reference = REFERENCE_PREFIX.test(raw);
    return {
      name: raw,
      displayName: reference ? `${raw.replace(REFERENCE_PREFIX, '')} (reference)` : raw,
      reference,
      checkedByDefault: !reference,
      triangles: subtreeTriangles(node),
    };
  });
}

/** Read and report on a .glb. Throws GlbError for a file that cannot be parsed. */
export function inspectGlb(file: string, cfg: Config): GlbReport {
  const bytes = fs.statSync(file).size;
  if (bytes === 0) throw new GlbError(`${file} is empty.`);
  const buf = fs.readFileSync(file);
  const parsed = parseGlbContainer(buf);
  const json = parsed.json;

  const parts = predictParts(json);
  const warnings: string[] = [];

  if (parsed.version !== 2) {
    warnings.push(`glTF version is ${parsed.version}; the viewer expects 2.`);
  }
  if (parsed.declaredLength !== bytes) {
    warnings.push(
      `the header declares ${parsed.declaredLength} bytes but the file is ${bytes} — ` +
        'it may be truncated or have trailing junk.',
    );
  }

  const overCap = bytes > cfg.maxModelBytes;
  if (overCap) {
    warnings.push(
      `${formatBytes(bytes)} exceeds the ${formatBytes(cfg.maxModelBytes)} server-side cap — the processor ` +
        'will reject this upload. Loosen the tessellation or split the assembly.',
    );
  } else if (bytes > cfg.warnModelBytes) {
    warnings.push(
      `${formatBytes(bytes)} is above the ${formatBytes(cfg.warnModelBytes)} advisory threshold. iOS Safari ` +
        'kills the tab rather than degrading when GPU memory runs out, so a reviewer on a ' +
        'phone may not see this at all.',
    );
  }

  if (parts.length < 2) {
    warnings.push(
      'only one component, so the viewer hides the parts panel. If this is an assembly, ' +
        'the bodies are probably nested inside one container — export the top-level parts.',
    );
  }
  if (parts.length > 1 && parts.every((part) => part.reference)) {
    warnings.push(
      'every part is `ref_` reference geometry, so the viewer opens with nothing visible.',
    );
  }
  const duplicates = [...new Set(parts.map((p) => p.name).filter((name, i, all) => all.indexOf(name) !== i))];
  if (duplicates.length) {
    warnings.push(
      `the panel will show repeated checkbox names (${duplicates.join(', ')}) — that is a ` +
        'single mesh split into several primitives, which happens with per-face colours.',
    );
  }
  const materialCount = Array.isArray(json.materials) ? json.materials.length : 0;
  if (materialCount <= 1) {
    warnings.push(
      `${materialCount} material(s): the file carries no per-face colours. A headless ` +
        '(`freecadcmd`) export always looks like this — use the GUI path to keep them.',
    );
  }

  return {
    path: file,
    bytes,
    gltfVersion: parsed.version,
    generator: typeof json.asset?.generator === 'string' ? json.asset.generator : null,
    nodeCount: Array.isArray(json.nodes) ? json.nodes.length : 0,
    meshCount: Array.isArray(json.meshes) ? json.meshes.length : 0,
    materialCount,
    triangles: parts.reduce((n, part) => n + part.triangles, 0),
    partsPanelShown: parts.length >= 2,
    parts,
    warnings,
    publishable: !overCap,
  };
}

/** Sizes for a human: a 9 KB export reported as "0.0 MB" reads like a failure. */
export const formatBytes = (bytes: number): string =>
  bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
