import {
  DATA_VERSION_1_20_1,
  DATA_VERSION_1_21_11,
  type BlockStateEntry,
  type UniversalStructureIR,
  normalizeNamespace
} from './types.js';
import {
  NbtTagType,
  type NbtCompound,
  type NbtTag,
  getNbtCompound,
  getNbtNumber,
  getNbtString,
  nbtByte,
  nbtCompound,
  nbtInt,
  nbtList,
  nbtString
} from './nbt-types.js';

export interface ParsedContainerItem {
  slot: number;
  itemId: string;
  count: number;
  customName?: string;
  schemaVersion: '1.20.1-tag' | '1.21-components';
}

const BLOCK_RENAMES_120_TO_121: Record<string, string> = {
  'minecraft:grass': 'minecraft:short_grass'
};

const BLOCK_RENAMES_121_TO_120: Record<string, string> = {
  'minecraft:short_grass': 'minecraft:grass'
};

export function inferMcVersionFromDataVersion(dataVersion?: number): string {
  if (!dataVersion || dataVersion <= 0) return '1.21.11';
  if (dataVersion <= 3465) return '1.20.1';
  if (dataVersion < 3837) return '1.20.4';
  if (dataVersion < 3953) return '1.20.6';
  return '1.21.11';
}

export function resolveAssetProfileVersion(mcVersionOrDataVersion: string | number): '1.20.1' | '1.21.11' {
  if (typeof mcVersionOrDataVersion === 'number') {
    return mcVersionOrDataVersion <= 3700 ? '1.20.1' : '1.21.11';
  }
  return mcVersionOrDataVersion.startsWith('1.20') || mcVersionOrDataVersion.startsWith('1.1')
    ? '1.20.1'
    : '1.21.11';
}

export function translateBlockStateForVersion(
  state: BlockStateEntry,
  targetVersion: '1.20.1' | '1.21.11'
): BlockStateEntry {
  const normName = normalizeNamespace(state.name);
  const map = targetVersion === '1.21.11' ? BLOCK_RENAMES_120_TO_121 : BLOCK_RENAMES_121_TO_120;
  const mappedName = map[normName] ?? normName;
  return {
    name: mappedName,
    properties: { ...state.properties }
  };
}

/**
 * Extracts items stored inside any BlockEntity NBT across BOTH
 * MC 1.20.1 ({ id, Count, tag }) AND MC 1.20.5+/1.21.x ({ id, count, components }),
 * including nested Shulker Box contents!
 */
export function extractItemsFromBlockEntity(nbt: NbtCompound): ParsedContainerItem[] {
  const result: ParsedContainerItem[] = [];

  function scanItemList(listTag: NbtTag | undefined) {
    if (!listTag || listTag.type !== NbtTagType.List) return;
    for (const elem of listTag.value) {
      if (elem.type !== NbtTagType.Compound) continue;
      const comp = elem.value;
      const rawId = getNbtString(comp, 'id');
      if (!rawId) continue;
      const itemId = normalizeNamespace(rawId);
      if (itemId === 'minecraft:air') continue;

      const slot = getNbtNumber(comp, 'Slot') ?? -1;
      const hasNewCount = comp.count !== undefined || comp.components !== undefined;
      const count = getNbtNumber(comp, 'count') ?? getNbtNumber(comp, 'Count') ?? 1;
      if (count <= 0) continue;

      let customName: string | undefined;
      const components = getNbtCompound(comp, 'components');
      const legacyTag = getNbtCompound(comp, 'tag');

      if (components) {
        customName = getNbtString(components, 'minecraft:custom_name') ?? getNbtString(components, 'minecraft:item_name');
        // Check 1.21+ nested container component (e.g. Shulker Box inside a Chest!)
        const nestedContainer = components['minecraft:container'];
        if (nestedContainer?.type === NbtTagType.List) {
          for (const slotWrapper of nestedContainer.value) {
            if (slotWrapper.type === NbtTagType.Compound && slotWrapper.value.item) {
              scanItemList(nbtList(NbtTagType.Compound, [slotWrapper.value.item]));
            }
          }
        }
      } else if (legacyTag) {
        const display = getNbtCompound(legacyTag, 'display');
        customName = getNbtString(display, 'Name');
        // Check 1.20.1 nested BlockEntityTag.Items
        const beTag = getNbtCompound(legacyTag, 'BlockEntityTag');
        if (beTag?.Items) {
          scanItemList(beTag.Items);
        }
      }

      result.push({
        slot,
        itemId,
        count,
        customName,
        schemaVersion: hasNewCount ? '1.21-components' : '1.20.1-tag'
      });
    }
  }

  scanItemList(nbt.value.Items);
  // Also support Create / modded inventories stored under "Inventory" -> "Items"
  const modInv = getNbtCompound(nbt.value, 'Inventory');
  if (modInv?.Items) {
    scanItemList(modInv.Items);
  }

  return result;
}

/**
 * Converts a structure IR cleanly to a target Minecraft version (1.20.1 or 1.21.11),
 * updating DataVersion, block aliases, and BlockEntity ItemStack NBT formats.
 */
export function convertStructureVersion(
  ir: UniversalStructureIR,
  targetVersion: '1.20.1' | '1.21.11'
): UniversalStructureIR {
  const targetDataVersion =
    targetVersion === '1.20.1' ? DATA_VERSION_1_20_1 : DATA_VERSION_1_21_11;

  const convertedRegions = ir.regions.map((r) => {
    const newPalette = r.palette.map((st) => translateBlockStateForVersion(st, targetVersion));
    const newBlockEntities = new Map(r.blockEntities);

    for (const [k, be] of newBlockEntities) {
      const itemsTag = be.nbt.value.Items;
      if (itemsTag?.type === NbtTagType.List) {
        const convertedItems: NbtTag[] = [];
        for (const item of itemsTag.value) {
          if (item.type !== NbtTagType.Compound) continue;
          const ic = { ...item.value };
          const cnt = getNbtNumber(ic, 'count') ?? getNbtNumber(ic, 'Count') ?? 1;
          const rawId = getNbtString(ic, 'id') ?? 'minecraft:air';
          const mappedId =
            (targetVersion === '1.21.11'
              ? BLOCK_RENAMES_120_TO_121[normalizeNamespace(rawId)]
              : BLOCK_RENAMES_121_TO_120[normalizeNamespace(rawId)]) ?? normalizeNamespace(rawId);

          if (targetVersion === '1.21.11') {
            delete ic.Count;
            const legacyTag = getNbtCompound(ic, 'tag');
            delete ic.tag;
            ic.id = nbtString(mappedId);
            ic.count = nbtInt(cnt);
            if (legacyTag) {
              const display = getNbtCompound(legacyTag, 'display');
              const customName = getNbtString(display, 'Name');
              if (customName) {
                ic.components = nbtCompound({
                  'minecraft:custom_name': nbtString(customName)
                });
              }
            }
          } else {
            delete ic.count;
            const comps = getNbtCompound(ic, 'components');
            delete ic.components;
            ic.id = nbtString(mappedId);
            ic.Count = nbtByte(Math.min(127, cnt));
            if (comps) {
              const customName = getNbtString(comps, 'minecraft:custom_name');
              if (customName) {
                ic.tag = nbtCompound({
                  display: nbtCompound({ Name: nbtString(customName) })
                });
              }
            }
          }
          convertedItems.push(nbtCompound(ic));
        }
        newBlockEntities.set(k, {
          ...be,
          nbt: nbtCompound({
            ...be.nbt.value,
            Items: nbtList(NbtTagType.Compound, convertedItems)
          })
        });
      }
    }

    return {
      ...r,
      palette: newPalette,
      blocks: new Uint32Array(r.blocks),
      blockEntities: newBlockEntities,
      entities: [...r.entities]
    };
  });

  return {
    ...ir,
    mcVersion: targetVersion,
    dataVersion: targetDataVersion,
    regions: convertedRegions
  };
}
