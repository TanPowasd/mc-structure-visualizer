import {
  type BlockStateEntry,
  type UniversalStructureIR,
  getNamespace,
  isAirBlock,
  normalizeNamespace
} from './types.js';
import { extractItemsFromBlockEntity } from './version-compat.js';

export interface BomEntry {
  itemId: string;
  namespace: string;
  count: number;
  shulkerBoxes: number;
  stacks: number;
  remainder: number;
  formattedQuantity: string;
}

export interface BomReport {
  totalItems: number;
  entries: BomEntry[];
  byNamespace: Record<string, BomEntry[]>;
  containerItems: BomEntry[];
}

const SHULKER_CAPACITY = 27 * 64; // 1,728

const BLOCK_TO_ITEM_MAP: Record<string, string> = {
  'minecraft:redstone_wire': 'minecraft:redstone',
  'minecraft:wall_torch': 'minecraft:torch',
  'minecraft:soul_wall_torch': 'minecraft:soul_torch',
  'minecraft:redstone_wall_torch': 'minecraft:redstone_torch',
  'minecraft:tripwire': 'minecraft:string',
  'minecraft:water': 'minecraft:water_bucket',
  'minecraft:lava': 'minecraft:lava_bucket',
  'minecraft:powder_snow': 'minecraft:powder_snow_bucket',
  'minecraft:piston_head': '',
  'minecraft:moving_piston': '',
  'minecraft:bubble_column': '',
  'minecraft:fire': '',
  'minecraft:soul_fire': ''
};

/**
 * Survival-accurate item multiplier & item resolution for a placed block state.
 * - Double slabs count as 2 slabs
 * - Doors/tall plants upper half count as 0 (lower half already counts 1)
 * - Beds head part counts as 0 (foot part counts 1)
 * - Piston extended heads count as 0
 */
function resolveSurvivalItemForState(state: BlockStateEntry): { itemId: string; count: number } | null {
  const norm = normalizeNamespace(state.name);
  if (isAirBlock(norm)) return null;

  // Sign wall variants -> base sign item
  if (norm.endsWith('_wall_sign')) {
    return { itemId: norm.replace('_wall_sign', '_sign'), count: 1 };
  }
  if (norm.endsWith('_wall_hanging_sign')) {
    return { itemId: norm.replace('_wall_hanging_sign', '_hanging_sign'), count: 1 };
  }
  if (norm.endsWith('_wall_banner')) {
    return { itemId: norm.replace('_wall_banner', '_banner'), count: 1 };
  }

  const mapped = BLOCK_TO_ITEM_MAP[norm];
  if (mapped === '') return null;

  // Multi-block survival deduplication
  if (state.properties.half === 'upper') return null;
  if (state.properties.part === 'head') return null;
  if (norm === 'minecraft:water' && state.properties.level && state.properties.level !== '0') {
    return null; // Flowing water requires no extra bucket
  }
  if (norm === 'minecraft:lava' && state.properties.level && state.properties.level !== '0') {
    return null;
  }

  const itemId = mapped ?? norm;
  let multiplier = 1;

  if (state.properties.type === 'double' && norm.includes('slab')) {
    multiplier = 2;
  } else if (state.properties.candles) {
    multiplier = Math.max(1, parseInt(state.properties.candles, 10) || 1);
  } else if (state.properties.pickles) {
    multiplier = Math.max(1, parseInt(state.properties.pickles, 10) || 1);
  }

  return { itemId, count: multiplier };
}

export function formatMinecraftQuantity(count: number, stackSize = 64): {
  shulkerBoxes: number;
  stacks: number;
  remainder: number;
  formattedQuantity: string;
} {
  const boxCap = 27 * stackSize;
  const shulkerBoxes = Math.floor(count / boxCap);
  const afterBoxes = count % boxCap;
  const stacks = Math.floor(afterBoxes / stackSize);
  const remainder = afterBoxes % stackSize;

  const parts: string[] = [];
  if (shulkerBoxes > 0) parts.push(`${shulkerBoxes}盒`);
  if (stacks > 0) parts.push(`${stacks}组`);
  if (remainder > 0 || parts.length === 0) parts.push(`${remainder}个`);

  return {
    shulkerBoxes,
    stacks,
    remainder,
    formattedQuantity: parts.join(' + ')
  };
}

function buildSortedBomEntries(countsMap: Map<string, number>): BomEntry[] {
  const entries: BomEntry[] = [];
  for (const [itemId, count] of countsMap.entries()) {
    if (count <= 0) continue;
    const fmt = formatMinecraftQuantity(count);
    entries.push({
      itemId,
      namespace: getNamespace(itemId),
      count,
      ...fmt
    });
  }
  entries.sort((a, b) => b.count - a.count || a.itemId.localeCompare(b.itemId));
  return entries;
}

export function calculateBom(
  ir: UniversalStructureIR,
  options?: { layerRange?: { axis: 'x' | 'y' | 'z'; min: number; max: number } }
): BomReport {
  const blockCounts = new Map<string, number>();
  const containerCounts = new Map<string, number>();

  for (const r of ir.regions) {
    const resolvedPalette = r.palette.map(resolveSurvivalItemForState);

    for (let y = 0; y < r.size.y; y++) {
      const gy = y + r.offset.y;
      if (options?.layerRange?.axis === 'y' && (gy < options.layerRange.min || gy > options.layerRange.max)) {
        continue;
      }
      for (let z = 0; z < r.size.z; z++) {
        const gz = z + r.offset.z;
        if (options?.layerRange?.axis === 'z' && (gz < options.layerRange.min || gz > options.layerRange.max)) {
          continue;
        }
        for (let x = 0; x < r.size.x; x++) {
          const gx = x + r.offset.x;
          if (options?.layerRange?.axis === 'x' && (gx < options.layerRange.min || gx > options.layerRange.max)) {
            continue;
          }
          const idx = x + z * r.size.x + y * r.size.x * r.size.z;
          const pIdx = r.blocks[idx]!;
          const res = resolvedPalette[pIdx];
          if (res) {
            blockCounts.set(res.itemId, (blockCounts.get(res.itemId) ?? 0) + res.count);
          }
        }
      }
    }

    for (const [, be] of r.blockEntities) {
      const items = extractItemsFromBlockEntity(be.nbt);
      for (const it of items) {
        containerCounts.set(it.itemId, (containerCounts.get(it.itemId) ?? 0) + it.count);
      }
    }
  }

  const entries = buildSortedBomEntries(blockCounts);
  const byNamespace: Record<string, BomEntry[]> = {};
  let totalItems = 0;

  for (const e of entries) {
    totalItems += e.count;
    (byNamespace[e.namespace] ??= []).push(e);
  }

  return {
    totalItems,
    entries,
    byNamespace,
    containerItems: buildSortedBomEntries(containerCounts)
  };
}
