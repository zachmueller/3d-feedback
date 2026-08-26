#!/usr/bin/env node
/**
 * Write a small three-part .glb for smoke-testing the viewer and the publish path.
 *
 *   node scripts/make-sample-glb.js [out.glb]
 *
 * The nodes are named, because those names are what the viewer's parts panel
 * lists — a single-mesh file would not exercise it. One of them is `ref_Wall Panel`,
 * which exercises the reference-geometry convention: the viewer lists it as
 * "Wall Panel (reference)" with its checkbox off. Geometry is deliberately
 * hand-built (no exporter dependency) and sized in millimetres, matching what
 * FreeCAD produces, so the camera-framing code gets a realistic scale.
 */
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || path.join(require('os').tmpdir(), 'sample.glb');

// --- geometry: a unit cube, indexed ----------------------------------------
const positions = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // back face
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // front face
]);
const indices = new Uint16Array([
  0, 1, 2, 0, 2, 3, // back
  4, 6, 5, 4, 7, 6, // front
  0, 4, 5, 0, 5, 1, // bottom
  3, 2, 6, 3, 6, 7, // top
  0, 3, 7, 0, 7, 4, // left
  1, 5, 6, 1, 6, 2, // right
]);

const positionBytes = Buffer.from(positions.buffer);
const indexBytes = Buffer.from(indices.buffer);
const pad4 = (n) => (4 - (n % 4)) % 4;
const indexOffset = positionBytes.length; // both are already 4-byte aligned
const binary = Buffer.concat([
  positionBytes,
  indexBytes,
  Buffer.alloc(pad4(positionBytes.length + indexBytes.length)),
]);

// --- glTF JSON -------------------------------------------------------------
// The nodes share one mesh geometry but use different materials and transforms,
// which is the shape a small FreeCAD assembly arrives in.
const gltf = {
  asset: { version: '2.0', generator: '3d-feedback make-sample-glb' },
  scene: 0,
  scenes: [{ nodes: [0, 1, 2] }],
  nodes: [
    // 30 mm base plate.
    { name: 'Base Plate', mesh: 0, scale: [30, 4, 30] },
    // 24 mm arm standing on it, offset so the two are distinguishable.
    { name: 'Clip Arm', mesh: 1, translation: [4, 4, 4], scale: [6, 24, 6] },
    // Not a printed part: the wall the clip screws into. The `ref_` prefix is what
    // tells the viewer to list it as context and start it hidden.
    { name: 'ref_Wall Panel', mesh: 2, translation: [-5, 0, -3], scale: [40, 60, 2] },
  ],
  meshes: [
    { name: 'Base Plate', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { name: 'Clip Arm', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] },
    { name: 'ref_Wall Panel', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 2 }] },
  ],
  materials: [
    {
      name: 'Steel',
      pbrMetallicRoughness: { baseColorFactor: [0.75, 0.76, 0.78, 1], metallicFactor: 0.9, roughnessFactor: 0.35 },
    },
    {
      name: 'Plastic',
      pbrMetallicRoughness: { baseColorFactor: [0.15, 0.42, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.6 },
    },
    {
      name: 'Reference',
      pbrMetallicRoughness: { baseColorFactor: [0.82, 0.83, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.85 },
    },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126, // FLOAT
      count: positions.length / 3,
      type: 'VEC3',
      // Required for POSITION, and the viewer's bounding-box framing reads it.
      min: [0, 0, 0],
      max: [1, 1, 1],
    },
    { bufferView: 1, componentType: 5123 /* UNSIGNED_SHORT */, count: indices.length, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
    { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes.length, target: 34963 },
  ],
  buffers: [{ byteLength: binary.length }],
};

// --- container -------------------------------------------------------------
const jsonBuffer = Buffer.from(JSON.stringify(gltf), 'utf-8');
// Chunks are 4-byte aligned: JSON pads with spaces, BIN pads with zeros.
const jsonPadded = Buffer.concat([jsonBuffer, Buffer.alloc(pad4(jsonBuffer.length), 0x20)]);

const chunk = (data, type) => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, data]);
};
// 'BIN\0' — the trailing NUL is part of the chunk type.
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binary.length, 0);
binHeader.write('BIN\0', 4, 4, 'ascii');

const body = Buffer.concat([chunk(jsonPadded, 'JSON'), binHeader, binary]);
const header = Buffer.alloc(12);
header.write('glTF', 0, 4, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + body.length, 8);

fs.writeFileSync(out, Buffer.concat([header, body]));
console.log(
  `wrote ${out} (${fs.statSync(out).size} bytes, ${gltf.nodes.length} named parts, ` +
    `one of them reference geometry)`,
);
