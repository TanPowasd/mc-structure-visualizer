import * as THREE from 'three';
import {
  type BlockFaceName,
  type BlockStateEntry,
  type StructureRegion,
  isAirBlock,
  posKey,
  voxelIndex
} from '@mcvis/core';
import {
  type CompiledBlockModel,
  type CompiledBoxElement,
  type UniversalModelCompiler
} from '@mcvis/mod-loader';
import type { AtlasUvRect, DynamicTextureAtlas } from './texture-atlas.js';

export type SliceAxis = 'y' | 'x' | 'z';
export type SliceMode = 'all' | 'single' | 'below' | 'range';

export interface SliceConfig {
  axis: SliceAxis;
  mode: SliceMode;
  layer: number;
  maxLayer: number;
  /** Renders layer - 1 as a translucent guide when mode === 'single' */
  ghostBelowLayer: boolean;
}

export interface MeshedStructureBuffers {
  solidCutout: THREE.BufferGeometry;
  translucent: THREE.BufferGeometry;
  ghost: THREE.BufferGeometry;
  triangleCount: number;
}

interface GeometryAccumulator {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

function createAcc(): GeometryAccumulator {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

function accToGeometry(acc: GeometryAccumulator): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(acc.positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(acc.normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uvs, 2));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(acc.colors, 3));
  geom.setIndex(acc.indices);
  geom.computeBoundingSphere();
  return geom;
}

const FACE_NORMALS: Record<BlockFaceName, [number, number, number]> = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0]
};

// Authentic Minecraft baked directional face brightness multipliers!
const FACE_SHADE: Record<BlockFaceName, number> = {
  up: 1.0,
  north: 0.8,
  south: 0.8,
  east: 0.6,
  west: 0.6,
  down: 0.5
};

/**
 * Scans the region palette + dynamic BlockEntities to collect all texture references
 * needed by the DynamicTextureAtlas before meshing.
 */
export function collectRequiredTextures(
  region: StructureRegion,
  compiler: UniversalModelCompiler
): Set<string> {
  const refs = new Set<string>();
  const collectFromModel = (m: CompiledBlockModel) => {
    for (const b of m.boxes) {
      for (const f of Object.values(b.faces)) {
        if (f?.textureRef) refs.add(f.textureRef);
      }
    }
    if (m.objTriangles) {
      for (const t of m.objTriangles) {
        if (t.textureRef) refs.add(t.textureRef);
      }
    }
  };

  for (const st of region.palette) {
    if (!isAirBlock(st.name)) {
      collectFromModel(compiler.compileBlockState(st));
    }
  }
  for (const [, be] of region.blockEntities) {
    const idx = voxelIndex(be.pos.x, be.pos.y, be.pos.z, region.size);
    const st = region.palette[region.blocks[idx] ?? 0];
    if (st && !isAirBlock(st.name)) {
      collectFromModel(compiler.compileBlockState(st, be));
    }
  }
  return refs;
}

export function isCoordInActiveSlice(
  x: number,
  y: number,
  z: number,
  slice: SliceConfig
): 'active' | 'ghost' | 'hidden' {
  if (slice.mode === 'all') return 'active';
  const v = slice.axis === 'y' ? y : slice.axis === 'x' ? x : z;
  if (slice.mode === 'single') {
    if (v === slice.layer) return 'active';
    if (slice.ghostBelowLayer && v === slice.layer - 1) return 'ghost';
    return 'hidden';
  }
  if (slice.mode === 'below') {
    return v <= slice.layer ? 'active' : 'hidden';
  }
  // range
  const lo = Math.min(slice.layer, slice.maxLayer);
  const hi = Math.max(slice.layer, slice.maxLayer);
  return v >= lo && v <= hi ? 'active' : 'hidden';
}

export function buildRegionMeshes(
  region: StructureRegion,
  compiler: UniversalModelCompiler,
  atlas: DynamicTextureAtlas,
  slice: SliceConfig
): MeshedStructureBuffers {
  const solidAcc = createAcc();
  const transAcc = createAcc();
  const ghostAcc = createAcc();

  const paletteModels = region.palette.map((st) => compiler.compileBlockState(st));
  const sx = region.size.x;
  const sy = region.size.y;
  const sz = region.size.z;

  const isNeighborOpaque = (nx: number, ny: number, nz: number, selfVisibility: 'active' | 'ghost'): boolean => {
    if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) return false;
    const vis = isCoordInActiveSlice(nx, ny, nz, slice);
    if (vis !== selfVisibility) return false;
    const nIdx = region.blocks[voxelIndex(nx, ny, nz, region.size)]!;
    if (nIdx === 0) return false;
    return paletteModels[nIdx]?.isFullOpaqueCube ?? false;
  };

  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const vis = isCoordInActiveSlice(x, y, z, slice);
        if (vis === 'hidden') continue;

        const pIdx = region.blocks[voxelIndex(x, y, z, region.size)]!;
        if (pIdx === 0) continue;

        const st = region.palette[pIdx]!;
        const be = region.blockEntities.get(posKey(x, y, z));
        const model = be ? compiler.compileBlockState(st, be) : paletteModels[pIdx]!;

        const targetAcc =
          vis === 'ghost'
            ? ghostAcc
            : model.renderType === 'translucent'
              ? transAcc
              : solidAcc;

        const tintRgb = resolveBlockTintRgb(st, model.fallbackColorHex);

        for (const box of model.boxes) {
          emitCompiledBox(
            targetAcc,
            box,
            x,
            y,
            z,
            model.fallbackColorHex,
            tintRgb,
            atlas,
            (face) => {
              // Only cull faces on non-rotated full-boundary faces
              if (box.rotation) return false;
              const n = FACE_NORMALS[face];
              return isNeighborOpaque(x + n[0], y + n[1], z + n[2], vis);
            }
          );
        }

        if (model.objTriangles) {
          emitObjTriangles(targetAcc, model.objTriangles, x, y, z, model.fallbackColorHex, atlas);
        }
      }
    }
  }

  const totalTris =
    (solidAcc.indices.length + transAcc.indices.length + ghostAcc.indices.length) / 3;

  return {
    solidCutout: accToGeometry(solidAcc),
    translucent: accToGeometry(transAcc),
    ghost: accToGeometry(ghostAcc),
    triangleCount: totalTris
  };
}

function emitCompiledBox(
  acc: GeometryAccumulator,
  box: CompiledBoxElement,
  bx: number,
  by: number,
  bz: number,
  fallbackHex: string,
  tintRgb: [number, number, number] | null,
  atlas: DynamicTextureAtlas,
  shouldCullWorldFace: (worldFace: BlockFaceName) => boolean
): void {
  const [x0, y0, z0] = [box.from[0] / 16, box.from[1] / 16, box.from[2] / 16];
  const [x1, y1, z1] = [box.to[0] / 16, box.to[1] / 16, box.to[2] / 16];

  const faceQuads: Array<{
    name: BlockFaceName;
    verts: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
    defaultUv: [number, number, number, number];
    boundaryCheck: boolean;
  }> = [
    {
      name: 'up',
      verts: [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0]
      ],
      defaultUv: [box.from[0], box.from[2], box.to[0], box.to[2]],
      boundaryCheck: box.to[1] >= 16 && box.from[0] <= 0 && box.to[0] >= 16 && box.from[2] <= 0 && box.to[2] >= 16
    },
    {
      name: 'down',
      verts: [
        [x0, y0, z1],
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1]
      ],
      defaultUv: [box.from[0], 16 - box.to[2], box.to[0], 16 - box.from[2]],
      boundaryCheck: box.from[1] <= 0 && box.from[0] <= 0 && box.to[0] >= 16 && box.from[2] <= 0 && box.to[2] >= 16
    },
    {
      name: 'south',
      verts: [
        [x0, y1, z1],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1]
      ],
      defaultUv: [box.from[0], 16 - box.to[1], box.to[0], 16 - box.from[1]],
      boundaryCheck: box.to[2] >= 16 && box.from[0] <= 0 && box.to[0] >= 16 && box.from[1] <= 0 && box.to[1] >= 16
    },
    {
      name: 'north',
      verts: [
        [x1, y1, z0],
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0]
      ],
      defaultUv: [16 - box.to[0], 16 - box.to[1], 16 - box.from[0], 16 - box.from[1]],
      boundaryCheck: box.from[2] <= 0 && box.from[0] <= 0 && box.to[0] >= 16 && box.from[1] <= 0 && box.to[1] >= 16
    },
    {
      name: 'east',
      verts: [
        [x1, y1, z1],
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0]
      ],
      defaultUv: [16 - box.to[2], 16 - box.to[1], 16 - box.from[2], 16 - box.from[1]],
      boundaryCheck: box.to[0] >= 16 && box.from[2] <= 0 && box.to[2] >= 16 && box.from[1] <= 0 && box.to[1] >= 16
    },
    {
      name: 'west',
      verts: [
        [x0, y1, z0],
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1]
      ],
      defaultUv: [box.from[2], 16 - box.to[1], box.to[2], 16 - box.from[1]],
      boundaryCheck: box.from[0] <= 0 && box.from[2] <= 0 && box.to[2] >= 16 && box.from[1] <= 0 && box.to[1] >= 16
    }
  ];

  const fallbackRgb = hexToUnitRgb(fallbackHex);

  for (const fq of faceQuads) {
    const faceDef = box.faces[fq.name];
    if (!faceDef) continue;

    // Transform vertices by element rotation + blockstate variant rotation around block center (0.5, 0.5, 0.5)
    const transformedVerts = fq.verts.map((v) =>
      transformPointInBlock(v, box.rotation, box.variantRotationX, box.variantRotationY)
    );
    const rotNormal = rotateNormal(
      FACE_NORMALS[fq.name],
      box.rotation,
      box.variantRotationX,
      box.variantRotationY
    );

    const worldFace = snapNormalToFace(rotNormal);
    if (fq.boundaryCheck && worldFace && shouldCullWorldFace(worldFace)) {
      continue;
    }

    const shade = worldFace ? FACE_SHADE[worldFace] : 0.85;
    const atlasRect = atlas.getUv(faceDef.textureRef);
    const hasTexture = atlasRect !== undefined;
    const rect: AtlasUvRect = atlasRect ?? atlas.getWhiteUv();

    let baseR = 1,
      baseG = 1,
      baseB = 1;
    if (!hasTexture) {
      [baseR, baseG, baseB] = fallbackRgb;
    } else if (faceDef.tintIndex !== undefined && tintRgb) {
      [baseR, baseG, baseB] = tintRgb;
    }

    const cr = baseR * shade;
    const cg = baseG * shade;
    const cb = baseB * shade;

    const localUv = faceDef.uv ?? fq.defaultUv;
    const uA = rect.u0 + (localUv[0] / 16) * (rect.u1 - rect.u0);
    const uB = rect.u0 + (localUv[2] / 16) * (rect.u1 - rect.u0);
    // In MC UV coordinates, v=0 is top of texture (v1 in Three.js), v=16 is bottom (v0 in Three.js)
    const vTop = rect.v1 - (localUv[1] / 16) * (rect.v1 - rect.v0);
    const vBot = rect.v1 - (localUv[3] / 16) * (rect.v1 - rect.v0);

    let quadUvs: [[number, number], [number, number], [number, number], [number, number]] = [
      [uA, vTop],
      [uA, vBot],
      [uB, vBot],
      [uB, vTop]
    ];

    if (faceDef.rotation) {
      const steps = ((faceDef.rotation / 90) | 0) & 3;
      for (let s = 0; s < steps; s++) {
        quadUvs = [quadUvs[3]!, quadUvs[0]!, quadUvs[1]!, quadUvs[2]!];
      }
    }

    const baseVertexIndex = acc.positions.length / 3;
    for (let i = 0; i < 4; i++) {
      const tv = transformedVerts[i]!;
      acc.positions.push(bx + tv[0], by + tv[1], bz + tv[2]);
      acc.normals.push(rotNormal[0], rotNormal[1], rotNormal[2]);
      acc.uvs.push(quadUvs[i]![0], quadUvs[i]![1]);
      acc.colors.push(cr, cg, cb);
    }

    acc.indices.push(
      baseVertexIndex,
      baseVertexIndex + 1,
      baseVertexIndex + 2,
      baseVertexIndex,
      baseVertexIndex + 2,
      baseVertexIndex + 3
    );
  }
}

function emitObjTriangles(
  acc: GeometryAccumulator,
  tris: NonNullable<CompiledBlockModel['objTriangles']>,
  bx: number,
  by: number,
  bz: number,
  fallbackHex: string,
  atlas: DynamicTextureAtlas
): void {
  const fallbackRgb = hexToUnitRgb(fallbackHex);

  for (const tri of tris) {
    const atlasRect = atlas.getUv(tri.textureRef);
    const hasTex = atlasRect !== undefined;
    const rect = atlasRect ?? atlas.getWhiteUv();
    const [r, g, b] = hasTex ? [1, 1, 1] : fallbackRgb;
    const shade = 0.85;

    const baseIdx = acc.positions.length / 3;
    for (let i = 0; i < 3; i++) {
      const p = transformPointInBlock(tri.positions[i]!, undefined, tri.rotX, tri.rotY);
      const n = rotateNormal(tri.normal, undefined, tri.rotX, tri.rotY);
      const rawU = ((tri.uvs[i]![0] % 1) + 1) % 1;
      const rawV = ((tri.uvs[i]![1] % 1) + 1) % 1;
      const u = rect.u0 + rawU * (rect.u1 - rect.u0);
      const v = rect.v0 + rawV * (rect.v1 - rect.v0);

      acc.positions.push(bx + p[0], by + p[1], bz + p[2]);
      acc.normals.push(n[0], n[1], n[2]);
      acc.uvs.push(u, v);
      acc.colors.push(r * shade, g * shade, b * shade);
    }
    acc.indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
  }
}

function transformPointInBlock(
  pt: [number, number, number],
  elemRot: CompiledBoxElement['rotation'],
  rotXDeg: number,
  rotYDeg: number
): [number, number, number] {
  let [x, y, z] = pt;

  if (elemRot && elemRot.angle !== 0) {
    const ox = elemRot.origin[0] / 16;
    const oy = elemRot.origin[1] / 16;
    const oz = elemRot.origin[2] / 16;
    const rad = (elemRot.angle * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const dx = x - ox;
    const dy = y - oy;
    const dz = z - oz;
    if (elemRot.axis === 'x') {
      y = oy + dy * c - dz * s;
      z = oz + dy * s + dz * c;
    } else if (elemRot.axis === 'y') {
      x = ox + dx * c + dz * s;
      z = oz - dx * s + dz * c;
    } else {
      x = ox + dx * c - dy * s;
      y = oy + dx * s + dy * c;
    }
  }

  // Blockstate X rotation (clockwise looking east in MC convention)
  if (rotXDeg !== 0) {
    const rad = (-rotXDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const dy = y - 0.5;
    const dz = z - 0.5;
    y = 0.5 + dy * c - dz * s;
    z = 0.5 + dy * s + dz * c;
  }

  // Blockstate Y rotation (clockwise from top in MC convention)
  if (rotYDeg !== 0) {
    const rad = (-rotYDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const dx = x - 0.5;
    const dz = z - 0.5;
    x = 0.5 + dx * c + dz * s;
    z = 0.5 - dx * s + dz * c;
  }

  return [x, y, z];
}

function rotateNormal(
  norm: [number, number, number],
  elemRot: CompiledBoxElement['rotation'],
  rotXDeg: number,
  rotYDeg: number
): [number, number, number] {
  const shifted: [number, number, number] = [0.5 + norm[0], 0.5 + norm[1], 0.5 + norm[2]];
  const center = transformPointInBlock(
    [0.5, 0.5, 0.5],
    elemRot ? { ...elemRot, origin: [8, 8, 8] } : undefined,
    rotXDeg,
    rotYDeg
  );
  const out = transformPointInBlock(
    shifted,
    elemRot ? { ...elemRot, origin: [8, 8, 8] } : undefined,
    rotXDeg,
    rotYDeg
  );
  const nx = out[0] - center[0];
  const ny = out[1] - center[1];
  const nz = out[2] - center[2];
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function snapNormalToFace(n: [number, number, number]): BlockFaceName | null {
  if (n[1] > 0.92) return 'up';
  if (n[1] < -0.92) return 'down';
  if (n[2] < -0.92) return 'north';
  if (n[2] > 0.92) return 'south';
  if (n[0] > 0.92) return 'east';
  if (n[0] < -0.92) return 'west';
  return null;
}

function resolveBlockTintRgb(
  state: BlockStateEntry,
  _fallbackHex: string
): [number, number, number] | null {
  const n = state.name;
  if (n === 'minecraft:redstone_wire') {
    const p = Math.max(0, Math.min(15, parseInt(state.properties.power ?? '0', 10) || 0));
    const ratio = p / 15;
    return [0.29 + 0.71 * ratio, p === 0 ? 0 : 0.12 * ratio * ratio, 0];
  }
  if (n === 'minecraft:water' || n === 'minecraft:bubble_column') {
    return [0.25, 0.46, 0.89];
  }
  if (
    n.includes('grass') ||
    n.includes('leaves') ||
    n.includes('fern') ||
    n.includes('vine') ||
    n === 'minecraft:sugar_cane' ||
    n === 'minecraft:lily_pad'
  ) {
    return [0.47, 0.75, 0.35];
  }
  return null;
}

function hexToUnitRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const num = parseInt(clean, 16) || 0x888888;
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}
