import type { NbtCompound } from './nbt-types.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type StructureFormatId =
  | 'litematic'
  | 'schem'
  | 'schematic'
  | 'nbt'
  | 'create_nbt'
  | 'building_gadgets_v2'
  | 'building_gadgets_v1'
  | 'axiom_bp'
  | 'structurize_blueprint'
  | 'f3i_command'
  | 'imported_3d'
  | 'dsl';

export interface BlockStateEntry {
  /** Full namespaced block ID, e.g. "minecraft:observer" or "create:mechanical_bearing" */
  name: string;
  /** Sorted key-value state properties, e.g. { facing: "south", powered: "false" } */
  properties: Record<string, string>;
}

export interface BlockEntityData {
  pos: Vec3;
  id: string;
  nbt: NbtCompound;
}

export interface EntityData {
  pos: [number, number, number];
  blockPos: Vec3;
  id: string;
  nbt: NbtCompound;
}

export interface StructureRegion {
  name: string;
  offset: Vec3;
  size: Vec3;
  /** Index 0 is guaranteed to be minecraft:air */
  palette: BlockStateEntry[];
  /**
   * Dense YZX array of length size.x * size.y * size.z
   * Index = x + z * size.x + y * size.x * size.z
   */
  blocks: Uint32Array;
  /** Keyed by `${x},${y},${z}` in region-local coordinates */
  blockEntities: Map<string, BlockEntityData>;
  entities: EntityData[];
}

export interface SuperGlueBox {
  from: [number, number, number];
  to: [number, number, number];
}

export interface UniversalStructureIR {
  name: string;
  author: string;
  description: string;
  sourceFormat: StructureFormatId;
  mcVersion: string;
  dataVersion: number;
  regions: StructureRegion[];
  /** Non-vanilla mod namespaces referenced in palettes or metadata */
  requiredMods: string[];
  /** Optional embedded PNG preview thumbnail (e.g. Axiom .bp) */
  thumbnailPng?: Uint8Array;
  /** Extra format-specific metadata (e.g., Create super glue boxes, Axiom tags) */
  metadata: {
    superGlue?: SuperGlueBox[];
    tags?: string[];
    createdTimestamp?: number;
    [key: string]: unknown;
  };
}

export const DATA_VERSION_1_20_1 = 3465;
export const DATA_VERSION_1_21_1 = 3955;
export const DATA_VERSION_1_21_4 = 4189;
export const DATA_VERSION_1_21_11 = 4671;

export const AIR_BLOCK_STATE: BlockStateEntry = {
  name: 'minecraft:air',
  properties: {}
};

export function normalizeNamespace(blockName: string): string {
  const trimmed = blockName.trim();
  if (!trimmed) return 'minecraft:air';
  return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`;
}

export function getNamespace(blockName: string): string {
  const norm = normalizeNamespace(blockName);
  return norm.split(':')[0]!;
}

export function formatBlockState(state: BlockStateEntry): string {
  const name = normalizeNamespace(state.name);
  const keys = Object.keys(state.properties).sort();
  if (keys.length === 0) return name;
  const propsStr = keys.map((k) => `${k}=${state.properties[k]}`).join(',');
  return `${name}[${propsStr}]`;
}

export function parseBlockStateString(input: string): BlockStateEntry {
  const trimmed = input.trim();
  const bracketStart = trimmed.indexOf('[');
  if (bracketStart === -1) {
    return { name: normalizeNamespace(trimmed), properties: {} };
  }
  const bracketEnd = trimmed.lastIndexOf(']');
  const name = normalizeNamespace(trimmed.slice(0, bracketStart));
  const inner = bracketEnd > bracketStart ? trimmed.slice(bracketStart + 1, bracketEnd) : '';
  const properties: Record<string, string> = {};
  if (inner.trim().length > 0) {
    for (const pair of inner.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (k) properties[k] = v;
      }
    }
  }
  return { name, properties };
}

export function isAirBlock(name: string): boolean {
  const norm = normalizeNamespace(name);
  return (
    norm === 'minecraft:air' ||
    norm === 'minecraft:cave_air' ||
    norm === 'minecraft:void_air' ||
    norm === 'minecraft:structure_void'
  );
}

export function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function voxelIndex(x: number, y: number, z: number, size: Vec3): number {
  return x + z * size.x + y * size.x * size.z;
}
