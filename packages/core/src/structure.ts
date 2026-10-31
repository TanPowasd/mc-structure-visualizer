import {
  AIR_BLOCK_STATE,
  DATA_VERSION_1_21_11,
  type BlockEntityData,
  type BlockStateEntry,
  type StructureFormatId,
  type StructureRegion,
  type UniversalStructureIR,
  type Vec3,
  formatBlockState,
  getNamespace,
  isAirBlock,
  normalizeNamespace,
  parseBlockStateString,
  posKey,
  voxelIndex
} from './types.js';
import type { NbtCompound } from './nbt-types.js';

export class PaletteInterner {
  private map = new Map<string, number>();
  public readonly palette: BlockStateEntry[] = [];

  constructor(initialPalette?: BlockStateEntry[]) {
    if (initialPalette && initialPalette.length > 0) {
      for (const entry of initialPalette) {
        this.intern(entry);
      }
      if (!isAirBlock(this.palette[0]!.name)) {
        // Ensure index 0 exists or air is interned cleanly
      }
    } else {
      this.intern(AIR_BLOCK_STATE);
    }
  }

  intern(state: BlockStateEntry | string): number {
    const entry =
      typeof state === 'string'
        ? parseBlockStateString(state)
        : { name: normalizeNamespace(state.name), properties: { ...state.properties } };
    const key = formatBlockState(entry);
    const existing = this.map.get(key);
    if (existing !== undefined) return existing;
    const idx = this.palette.length;
    this.palette.push(entry);
    this.map.set(key, idx);
    return idx;
  }
}

export function createEmptyRegion(name: string, size: Vec3, offset: Vec3 = { x: 0, y: 0, z: 0 }): StructureRegion {
  const sx = Math.max(1, Math.floor(size.x));
  const sy = Math.max(1, Math.floor(size.y));
  const sz = Math.max(1, Math.floor(size.z));
  return {
    name,
    offset: { ...offset },
    size: { x: sx, y: sy, z: sz },
    palette: [{ ...AIR_BLOCK_STATE }],
    blocks: new Uint32Array(sx * sy * sz),
    blockEntities: new Map(),
    entities: []
  };
}

export function createEmptyStructure(
  name: string,
  size: Vec3,
  options?: {
    mcVersion?: string;
    dataVersion?: number;
    sourceFormat?: StructureFormatId;
    author?: string;
  }
): UniversalStructureIR {
  return {
    name,
    author: options?.author ?? 'MC Structure Visualizer',
    description: '',
    sourceFormat: options?.sourceFormat ?? 'dsl',
    mcVersion: options?.mcVersion ?? '1.21.11',
    dataVersion: options?.dataVersion ?? DATA_VERSION_1_21_11,
    regions: [createEmptyRegion('Main', size)],
    requiredMods: [],
    metadata: {}
  };
}

export function getRegionBlock(region: StructureRegion, x: number, y: number, z: number): BlockStateEntry {
  if (
    x < 0 ||
    y < 0 ||
    z < 0 ||
    x >= region.size.x ||
    y >= region.size.y ||
    z >= region.size.z
  ) {
    return AIR_BLOCK_STATE;
  }
  const paletteIdx = region.blocks[voxelIndex(x, y, z, region.size)] ?? 0;
  return region.palette[paletteIdx] ?? AIR_BLOCK_STATE;
}

export function setRegionBlock(
  region: StructureRegion,
  x: number,
  y: number,
  z: number,
  state: BlockStateEntry | string,
  blockEntityNbt?: NbtCompound
): void {
  if (
    x < 0 ||
    y < 0 ||
    z < 0 ||
    x >= region.size.x ||
    y >= region.size.y ||
    z >= region.size.z
  ) {
    return;
  }
  const entry = typeof state === 'string' ? parseBlockStateString(state) : state;
  const targetKey = formatBlockState(entry);
  let idx = region.palette.findIndex((p) => formatBlockState(p) === targetKey);
  if (idx === -1) {
    idx = region.palette.length;
    region.palette.push({
      name: normalizeNamespace(entry.name),
      properties: { ...entry.properties }
    });
  }
  region.blocks[voxelIndex(x, y, z, region.size)] = idx;

  const k = posKey(x, y, z);
  if (blockEntityNbt) {
    region.blockEntities.set(k, {
      pos: { x, y, z },
      id: normalizeNamespace(entry.name),
      nbt: blockEntityNbt
    });
  } else if (isAirBlock(entry.name)) {
    region.blockEntities.delete(k);
  }
}

export function computeStructureBounds(ir: UniversalStructureIR): {
  min: Vec3;
  max: Vec3;
  size: Vec3;
} {
  if (ir.regions.length === 0) {
    return {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }
    };
  }
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (const r of ir.regions) {
    minX = Math.min(minX, r.offset.x);
    minY = Math.min(minY, r.offset.y);
    minZ = Math.min(minZ, r.offset.z);
    maxX = Math.max(maxX, r.offset.x + r.size.x);
    maxY = Math.max(maxY, r.offset.y + r.size.y);
    maxZ = Math.max(maxZ, r.offset.z + r.size.z);
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    size: {
      x: Math.max(1, maxX - minX),
      y: Math.max(1, maxY - minY),
      z: Math.max(1, maxZ - minZ)
    }
  };
}

/**
 * Merges multi-region structures (e.g. Litematica with multiple sub-regions)
 * into a single normalized region starting at (0,0,0) for single-region formats
 * (.schem, .nbt, .bp, .blueprint, Building Gadgets) or unified 3D chunk meshing.
 */
export function mergeRegionsToSingle(ir: UniversalStructureIR): StructureRegion {
  if (
    ir.regions.length === 1 &&
    ir.regions[0]!.offset.x === 0 &&
    ir.regions[0]!.offset.y === 0 &&
    ir.regions[0]!.offset.z === 0
  ) {
    return ir.regions[0]!;
  }

  const bounds = computeStructureBounds(ir);
  const interner = new PaletteInterner();
  const blocks = new Uint32Array(bounds.size.x * bounds.size.y * bounds.size.z);
  const blockEntities = new Map<string, BlockEntityData>();
  const entities = [];

  for (const r of ir.regions) {
    const paletteRemap = new Uint32Array(r.palette.length);
    for (let i = 0; i < r.palette.length; i++) {
      paletteRemap[i] = interner.intern(r.palette[i]!);
    }

    const dx = r.offset.x - bounds.min.x;
    const dy = r.offset.y - bounds.min.y;
    const dz = r.offset.z - bounds.min.z;

    for (let y = 0; y < r.size.y; y++) {
      for (let z = 0; z < r.size.z; z++) {
        for (let x = 0; x < r.size.x; x++) {
          const localIdx = voxelIndex(x, y, z, r.size);
          const srcStateIdx = r.blocks[localIdx]!;
          const mappedIdx = paletteRemap[srcStateIdx]!;
          if (mappedIdx !== 0) {
            const gx = x + dx;
            const gy = y + dy;
            const gz = z + dz;
            blocks[voxelIndex(gx, gy, gz, bounds.size)] = mappedIdx;
          }
        }
      }
    }

    for (const [, be] of r.blockEntities) {
      const gx = be.pos.x + dx;
      const gy = be.pos.y + dy;
      const gz = be.pos.z + dz;
      blockEntities.set(posKey(gx, gy, gz), {
        pos: { x: gx, y: gy, z: gz },
        id: be.id,
        nbt: be.nbt
      });
    }

    for (const ent of r.entities) {
      entities.push({
        pos: [ent.pos[0] + dx, ent.pos[1] + dy, ent.pos[2] + dz] as [number, number, number],
        blockPos: {
          x: ent.blockPos.x + dx,
          y: ent.blockPos.y + dy,
          z: ent.blockPos.z + dz
        },
        id: ent.id,
        nbt: ent.nbt
      });
    }
  }

  return {
    name: ir.name || 'Merged',
    offset: { x: 0, y: 0, z: 0 },
    size: bounds.size,
    palette: interner.palette,
    blocks,
    blockEntities,
    entities
  };
}

export function extractModNamespaces(ir: UniversalStructureIR): string[] {
  const mods = new Set<string>(ir.requiredMods || []);
  for (const r of ir.regions) {
    for (const p of r.palette) {
      const ns = getNamespace(p.name);
      if (ns !== 'minecraft') mods.add(ns);
    }
    for (const [, be] of r.blockEntities) {
      const ns = getNamespace(be.id);
      if (ns !== 'minecraft') mods.add(ns);
    }
  }
  return Array.from(mods).sort();
}

export function countStructureStats(ir: UniversalStructureIR): {
  totalVolume: number;
  nonAirBlocks: number;
  uniqueBlockStates: number;
  blockEntityCount: number;
  entityCount: number;
} {
  const bounds = computeStructureBounds(ir);
  let nonAirBlocks = 0;
  let blockEntityCount = 0;
  let entityCount = 0;
  const uniqueStates = new Set<string>();

  for (const r of ir.regions) {
    const airFlags = r.palette.map((p) => isAirBlock(p.name));
    for (let i = 0; i < r.blocks.length; i++) {
      const idx = r.blocks[i]!;
      if (!airFlags[idx]) {
        nonAirBlocks++;
        uniqueStates.add(formatBlockState(r.palette[idx]!));
      }
    }
    blockEntityCount += r.blockEntities.size;
    entityCount += r.entities.length;
  }

  return {
    totalVolume: bounds.size.x * bounds.size.y * bounds.size.z,
    nonAirBlocks,
    uniqueBlockStates: uniqueStates.size,
    blockEntityCount,
    entityCount
  };
}
