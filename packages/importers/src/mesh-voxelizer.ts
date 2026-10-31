import {
  type CustomBlockRegistry,
  type UniversalStructureIR,
  createEmptyStructure,
  extractModNamespaces,
  setRegionBlock
} from '@mcvis/core';
import {
  type PaletteFilterPreset,
  buildColorMatcherPalette,
  matchClosestBlockByRgb
} from './color-palette.js';

export interface VoxelizerOptions {
  targetMaxDimension?: number;
  palettePreset?: PaletteFilterPreset;
  customRegistry?: CustomBlockRegistry;
  defaultColorRgb?: [number, number, number];
}

interface RawTriangle {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  rgb: [number, number, number];
}

/**
 * Voxelizes Wavefront .obj, ASCII/Binary .stl, or Binary glTF 2.0 (.glb) 3D models
 * into a Minecraft UniversalStructureIR!
 */
export function import3dModelToStructure(
  input: Uint8Array | string,
  fileName: string,
  options?: VoxelizerOptions
): UniversalStructureIR {
  const lower = fileName.toLowerCase();
  let triangles: RawTriangle[] = [];
  const defaultRgb = options?.defaultColorRgb ?? [205, 210, 214];

  if (lower.endsWith('.obj') || typeof input === 'string') {
    const txt = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
    triangles = extractObjTriangles(txt, defaultRgb);
  } else if (lower.endsWith('.stl')) {
    triangles = extractStlTriangles(input, defaultRgb);
  } else if (lower.endsWith('.glb')) {
    triangles = extractGlbTriangles(input, defaultRgb);
  } else {
    throw new Error(`Unsupported 3D model format: ${fileName}`);
  }

  if (triangles.length === 0) {
    throw new Error(`No 3D mesh triangles found in ${fileName}`);
  }

  return voxelizeTriangles(
    triangles,
    fileName.replace(/\.(obj|stl|glb|gltf)$/i, ''),
    options
  );
}

function voxelizeTriangles(
  triangles: RawTriangle[],
  name: string,
  options?: VoxelizerOptions
): UniversalStructureIR {
  const targetMax = Math.max(4, Math.min(256, options?.targetMaxDimension ?? 48));
  const palette = buildColorMatcherPalette(
    options?.palettePreset ?? 'all_survival',
    options?.customRegistry
  );

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (const tri of triangles) {
    for (const v of [tri.a, tri.b, tri.c]) {
      if (v[0] < minX) minX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }

  const spanX = Math.max(1e-5, maxX - minX);
  const spanY = Math.max(1e-5, maxY - minY);
  const spanZ = Math.max(1e-5, maxZ - minZ);
  const maxSpan = Math.max(spanX, spanY, spanZ);
  const scale = (targetMax - 1) / maxSpan;

  const sx = Math.max(1, Math.ceil(spanX * scale) + 1);
  const sy = Math.max(1, Math.ceil(spanY * scale) + 1);
  const sz = Math.max(1, Math.ceil(spanZ * scale) + 1);

  const ir = createEmptyStructure(name || 'Voxelized 3D Model', { x: sx, y: sy, z: sz }, {
    sourceFormat: 'imported_3d'
  });
  const reg = ir.regions[0]!;
  const rgbToBlockCache = new Map<number, string>();

  const resolveBlock = (rgb: [number, number, number]) => {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    let blk = rgbToBlockCache.get(key);
    if (!blk) {
      blk = matchClosestBlockByRgb(rgb[0], rgb[1], rgb[2], palette);
      rgbToBlockCache.set(key, blk);
    }
    return blk;
  };

  // Surface barycentric sub-stepping rasterizer — fast, deterministic, zero holes!
  for (const tri of triangles) {
    const a: [number, number, number] = [
      (tri.a[0] - minX) * scale,
      (tri.a[1] - minY) * scale,
      (tri.a[2] - minZ) * scale
    ];
    const b: [number, number, number] = [
      (tri.b[0] - minX) * scale,
      (tri.b[1] - minY) * scale,
      (tri.b[2] - minZ) * scale
    ];
    const c: [number, number, number] = [
      (tri.c[0] - minX) * scale,
      (tri.c[1] - minY) * scale,
      (tri.c[2] - minZ) * scale
    ];

    const edgeAB = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const edgeAC = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const edgeBC = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    const steps = Math.max(1, Math.ceil(Math.max(edgeAB, edgeAC, edgeBC) * 2));
    const blkId = resolveBlock(tri.rgb);

    for (let u = 0; u <= steps; u++) {
      const tu = u / steps;
      const maxV = steps - u;
      for (let v = 0; v <= maxV; v++) {
        const tv = v / steps;
        const tw = 1 - tu - tv;
        const px = Math.round(a[0] * tw + b[0] * tu + c[0] * tv);
        const py = Math.round(a[1] * tw + b[1] * tu + c[1] * tv);
        const pz = Math.round(a[2] * tw + b[2] * tu + c[2] * tv);
        setRegionBlock(reg, px, py, pz, blkId);
      }
    }
  }

  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

function extractObjTriangles(
  objText: string,
  defaultRgb: [number, number, number]
): RawTriangle[] {
  const verts: Array<[number, number, number]> = [];
  const vertColors: Array<[number, number, number] | undefined> = [];
  const tris: RawTriangle[] = [];

  for (const rawLine of objText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      verts.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
      if (parts.length >= 7) {
        // Vertex colors v x y z r g b (0..1 or 0..255)
        const r = Number(parts[4]);
        const g = Number(parts[5]);
        const b = Number(parts[6]);
        const mult = r <= 1 && g <= 1 && b <= 1 ? 255 : 1;
        vertColors.push([Math.round(r * mult), Math.round(g * mult), Math.round(b * mult)]);
      } else {
        vertColors.push(undefined);
      }
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const idxList = parts.slice(1).map((tok) => {
        const vi = parseInt(tok.split('/')[0]!, 10);
        return vi < 0 ? verts.length + vi : vi - 1;
      });
      for (let i = 1; i + 1 < idxList.length; i++) {
        const i0 = idxList[0]!;
        const i1 = idxList[i]!;
        const i2 = idxList[i + 1]!;
        const a = verts[i0];
        const b = verts[i1];
        const c = verts[i2];
        if (a && b && c) {
          tris.push({
            a,
            b,
            c,
            rgb: vertColors[i0] ?? defaultRgb
          });
        }
      }
    }
  }
  return tris;
}

function extractStlTriangles(
  bytes: Uint8Array,
  defaultRgb: [number, number, number]
): RawTriangle[] {
  const headerStr = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(80, bytes.length)));
  if (headerStr.trimStart().startsWith('solid') && bytes.length < 5_000_000) {
    const fullText = new TextDecoder('utf-8').decode(bytes);
    if (fullText.includes('facet normal')) {
      const tris: RawTriangle[] = [];
      const vertexRegex = /vertex\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
      const matches = Array.from(fullText.matchAll(vertexRegex));
      for (let i = 0; i + 2 < matches.length; i += 3) {
        const m0 = matches[i]!,
          m1 = matches[i + 1]!,
          m2 = matches[i + 2]!;
        // Swap STL Z-up to MC Y-up!
        tris.push({
          a: [Number(m0[1]), Number(m0[3]), Number(m0[2])],
          b: [Number(m1[1]), Number(m1[3]), Number(m1[2])],
          c: [Number(m2[1]), Number(m2[3]), Number(m2[2])],
          rgb: defaultRgb
        });
      }
      if (tris.length > 0) return tris;
    }
  }

  // Binary STL: 80-byte header + uint32LE triCount + 50 bytes per triangle
  if (bytes.byteLength < 84) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const tris: RawTriangle[] = [];
  let offset = 84;
  for (let i = 0; i < count && offset + 50 <= bytes.byteLength; i++) {
    // skip 12-byte normal
    const ax = view.getFloat32(offset + 12, true);
    const ay = view.getFloat32(offset + 16, true);
    const az = view.getFloat32(offset + 20, true);
    const bx = view.getFloat32(offset + 24, true);
    const by = view.getFloat32(offset + 28, true);
    const bz = view.getFloat32(offset + 32, true);
    const cx = view.getFloat32(offset + 36, true);
    const cy = view.getFloat32(offset + 40, true);
    const cz = view.getFloat32(offset + 44, true);
    tris.push({
      a: [ax, az, ay],
      b: [bx, bz, by],
      c: [cx, cz, cy],
      rgb: defaultRgb
    });
    offset += 50;
  }
  return tris;
}

function extractGlbTriangles(
  bytes: Uint8Array,
  defaultRgb: [number, number, number]
): RawTriangle[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 /* 'glTF' */) {
    throw new Error('Invalid binary glTF (.glb) header');
  }
  const jsonChunkLen = view.getUint32(12, true);
  const jsonStr = new TextDecoder('utf-8').decode(bytes.subarray(20, 20 + jsonChunkLen));
  const gltf = JSON.parse(jsonStr);

  const binChunkHeaderOffset = 20 + jsonChunkLen;
  const binChunkLen = view.getUint32(binChunkHeaderOffset, true);
  const binStart = binChunkHeaderOffset + 8;
  const binBuf = bytes.subarray(binStart, binStart + binChunkLen);
  const binView = new DataView(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength);

  const tris: RawTriangle[] = [];

  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const posAccIdx = prim.attributes?.POSITION;
      if (posAccIdx === undefined) continue;
      const posAcc = gltf.accessors[posAccIdx];
      const posBv = gltf.bufferViews[posAcc.bufferView];
      const posBase = (posBv.byteOffset ?? 0) + (posAcc.byteOffset ?? 0);
      const posStride = posBv.byteStride ?? 12;

      const readVec3 = (idx: number): [number, number, number] => {
        const off = posBase + idx * posStride;
        return [
          binView.getFloat32(off, true),
          binView.getFloat32(off + 4, true),
          binView.getFloat32(off + 8, true)
        ];
      };

      // Extract material baseColorFactor if present
      let matRgb = defaultRgb;
      if (prim.material !== undefined && gltf.materials?.[prim.material]) {
        const factor = gltf.materials[prim.material].pbrMetallicRoughness?.baseColorFactor;
        if (Array.isArray(factor) && factor.length >= 3) {
          matRgb = [
            Math.round(factor[0] * 255),
            Math.round(factor[1] * 255),
            Math.round(factor[2] * 255)
          ];
        }
      }

      if (prim.indices !== undefined) {
        const idxAcc = gltf.accessors[prim.indices];
        const idxBv = gltf.bufferViews[idxAcc.bufferView];
        const idxBase = (idxBv.byteOffset ?? 0) + (idxAcc.byteOffset ?? 0);
        const readIndex = (k: number): number => {
          if (idxAcc.componentType === 5123) return binView.getUint16(idxBase + k * 2, true);
          if (idxAcc.componentType === 5125) return binView.getUint32(idxBase + k * 4, true);
          return binView.getUint8(idxBase + k);
        };
        for (let k = 0; k + 2 < idxAcc.count; k += 3) {
          tris.push({
            a: readVec3(readIndex(k)),
            b: readVec3(readIndex(k + 1)),
            c: readVec3(readIndex(k + 2)),
            rgb: matRgb
          });
        }
      } else {
        for (let k = 0; k + 2 < posAcc.count; k += 3) {
          tris.push({
            a: readVec3(k),
            b: readVec3(k + 1),
            c: readVec3(k + 2),
            rgb: matRgb
          });
        }
      }
    }
  }

  return tris;
}
