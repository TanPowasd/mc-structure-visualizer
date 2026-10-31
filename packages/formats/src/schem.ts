import {
  AIR_BLOCK_STATE,
  DATA_VERSION_1_20_1,
  DATA_VERSION_1_21_11,
  NbtTagType,
  type BlockEntityData,
  type BlockStateEntry,
  type NbtCompound,
  type NbtTag,
  type UniversalStructureIR,
  type Vec3,
  extractModNamespaces,
  formatBlockState,
  getNbtCompound,
  getNbtNumber,
  getNbtString,
  inferMcVersionFromDataVersion,
  mergeRegionsToSingle,
  nbtByteArray,
  nbtCompound,
  nbtInt,
  nbtIntArray,
  nbtList,
  nbtShort,
  nbtString,
  normalizeNamespace,
  parseBlockStateString,
  posKey
} from '@mcvis/core';
import { readNbt, writeNbt } from './nbt-binary.js';

function decodeVarIntByteArray(bytes: Int8Array, expectedCount: number): Uint32Array {
  const out = new Uint32Array(expectedCount);
  let outIdx = 0;
  let i = 0;
  while (i < bytes.length && outIdx < expectedCount) {
    let value = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++]! & 0xff;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    out[outIdx++] = value >>> 0;
  }
  return out;
}

function encodeVarIntByteArray(indices: Uint32Array): Int8Array {
  const buf: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    let val = indices[i]! >>> 0;
    while ((val & ~0x7f) !== 0) {
      buf.push((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    buf.push(val & 0x7f);
  }
  return new Int8Array(buf);
}

// Common legacy numeric block IDs for MCEdit .schematic (1.12.2 and earlier)
const LEGACY_BLOCK_IDS: Record<number, string> = {
  0: 'minecraft:air',
  1: 'minecraft:stone',
  2: 'minecraft:grass_block',
  3: 'minecraft:dirt',
  4: 'minecraft:cobblestone',
  5: 'minecraft:oak_planks',
  7: 'minecraft:bedrock',
  8: 'minecraft:water',
  9: 'minecraft:water',
  10: 'minecraft:lava',
  11: 'minecraft:lava',
  12: 'minecraft:sand',
  14: 'minecraft:gold_ore',
  15: 'minecraft:iron_ore',
  17: 'minecraft:oak_log',
  18: 'minecraft:oak_leaves',
  20: 'minecraft:glass',
  23: 'minecraft:dispenser',
  24: 'minecraft:sandstone',
  25: 'minecraft:note_block',
  29: 'minecraft:sticky_piston',
  33: 'minecraft:piston',
  34: 'minecraft:piston_head',
  35: 'minecraft:white_wool',
  41: 'minecraft:gold_block',
  42: 'minecraft:iron_block',
  44: 'minecraft:smooth_stone_slab',
  45: 'minecraft:bricks',
  46: 'minecraft:tnt',
  49: 'minecraft:obsidian',
  50: 'minecraft:torch',
  54: 'minecraft:chest',
  55: 'minecraft:redstone_wire',
  57: 'minecraft:diamond_block',
  69: 'minecraft:lever',
  75: 'minecraft:redstone_torch',
  76: 'minecraft:redstone_torch',
  89: 'minecraft:glowstone',
  93: 'minecraft:repeater',
  94: 'minecraft:repeater',
  95: 'minecraft:white_stained_glass',
  98: 'minecraft:stone_bricks',
  123: 'minecraft:redstone_lamp',
  124: 'minecraft:redstone_lamp',
  149: 'minecraft:comparator',
  150: 'minecraft:comparator',
  152: 'minecraft:redstone_block',
  154: 'minecraft:hopper',
  155: 'minecraft:quartz_block',
  158: 'minecraft:dropper',
  159: 'minecraft:white_terracotta',
  165: 'minecraft:slime_block',
  218: 'minecraft:observer',
  251: 'minecraft:white_concrete'
};

export function parseSchemOrSchematic(data: Uint8Array): UniversalStructureIR {
  const { root, rootName } = readNbt(data);
  let rv = root.value;

  // Sponge v3 wraps inside a root 'Schematic' compound when rootName is empty
  if (rv.Schematic?.type === NbtTagType.Compound) {
    rv = rv.Schematic.value;
  }

  // Check if Legacy MCEdit .schematic (has 'Blocks' ByteArray & 'Data' ByteArray)
  if (
    rv.Blocks?.type === NbtTagType.ByteArray &&
    rv.Data?.type === NbtTagType.ByteArray
  ) {
    return parseLegacySchematic(rv, rootName);
  }

  const version = getNbtNumber(rv, 'Version') ?? 2;
  const dataVersion = getNbtNumber(rv, 'DataVersion') ?? DATA_VERSION_1_21_11;
  const width = Math.max(1, getNbtNumber(rv, 'Width') ?? 1);
  const height = Math.max(1, getNbtNumber(rv, 'Height') ?? 1);
  const length = Math.max(1, getNbtNumber(rv, 'Length') ?? 1);
  const size: Vec3 = { x: width, y: height, z: length };

  const meta = getNbtCompound(rv, 'Metadata') ?? {};
  const name = getNbtString(meta, 'Name') ?? (rootName || 'WorldEdit Schematic');
  const author = getNbtString(meta, 'Author') ?? 'Unknown';

  // Sponge v3 puts Palette, Data, BlockEntities inside 'Blocks' compound!
  const blocksSection =
    version >= 3 && rv.Blocks?.type === NbtTagType.Compound ? rv.Blocks.value : rv;

  const paletteComp = getNbtCompound(blocksSection, 'Palette') ?? {};
  let maxIdx = 0;
  for (const tag of Object.values(paletteComp)) {
    if (tag.type === NbtTagType.Int && tag.value > maxIdx) {
      maxIdx = tag.value;
    }
  }
  const palette: BlockStateEntry[] = new Array(maxIdx + 1)
    .fill(null)
    .map(() => ({ ...AIR_BLOCK_STATE }));

  for (const [stateStr, tag] of Object.entries(paletteComp)) {
    if (tag.type === NbtTagType.Int && tag.value >= 0) {
      palette[tag.value] = parseBlockStateString(stateStr);
    }
  }

  const rawDataTag = blocksSection.Data ?? blocksSection.BlockData;
  const volume = width * height * length;
  const blocks =
    rawDataTag?.type === NbtTagType.ByteArray
      ? decodeVarIntByteArray(rawDataTag.value, volume)
      : new Uint32Array(volume);

  const blockEntities = new Map<string, BlockEntityData>();
  const beListTag = blocksSection.BlockEntities ?? rv.TileEntities;
  if (beListTag?.type === NbtTagType.List) {
    for (const item of beListTag.value) {
      if (item.type !== NbtTagType.Compound) continue;
      const ic = item.value;
      let x = 0,
        y = 0,
        z = 0;
      if (ic.Pos?.type === NbtTagType.IntArray && ic.Pos.value.length >= 3) {
        x = ic.Pos.value[0]!;
        y = ic.Pos.value[1]!;
        z = ic.Pos.value[2]!;
      } else {
        x = getNbtNumber(ic, 'x') ?? 0;
        y = getNbtNumber(ic, 'y') ?? 0;
        z = getNbtNumber(ic, 'z') ?? 0;
      }
      const id = normalizeNamespace(
        getNbtString(ic, 'Id') ?? getNbtString(ic, 'id') ?? 'minecraft:chest'
      );
      const dataComp = getNbtCompound(ic, 'Data');
      const finalNbt = dataComp ? nbtCompound({ ...dataComp, id: nbtString(id) }) : item;
      blockEntities.set(posKey(x, y, z), {
        pos: { x, y, z },
        id,
        nbt: finalNbt
      });
    }
  }

  const ir: UniversalStructureIR = {
    name,
    author,
    description: `Sponge Schematic v${version}`,
    sourceFormat: 'schem',
    mcVersion: inferMcVersionFromDataVersion(dataVersion),
    dataVersion,
    regions: [
      {
        name: 'Main',
        offset: { x: 0, y: 0, z: 0 },
        size,
        palette,
        blocks,
        blockEntities,
        entities: []
      }
    ],
    requiredMods: [],
    metadata: {}
  };
  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

function parseLegacySchematic(
  rv: Record<string, NbtTag>,
  rootName: string
): UniversalStructureIR {
  const width = Math.max(1, getNbtNumber(rv, 'Width') ?? 1);
  const height = Math.max(1, getNbtNumber(rv, 'Height') ?? 1);
  const length = Math.max(1, getNbtNumber(rv, 'Length') ?? 1);
  const size: Vec3 = { x: width, y: height, z: length };
  const rawBlocks = (rv.Blocks as Extract<NbtTag, { type: NbtTagType.ByteArray }>).value;

  // Optional Schematica 'Mapping' / 'SchematicaMapping' compound for modded 1.12.2 schematics!
  const customMap: Record<number, string> = { ...LEGACY_BLOCK_IDS };
  const mappingComp =
    getNbtCompound(rv, 'SchematicaMapping') ?? getNbtCompound(rv, 'BlockIDs');
  if (mappingComp) {
    for (const [k, v] of Object.entries(mappingComp)) {
      if (v.type === NbtTagType.Short || v.type === NbtTagType.Int) {
        customMap[v.value] = normalizeNamespace(k);
      } else if (v.type === NbtTagType.String) {
        customMap[Number(k)] = normalizeNamespace(v.value);
      }
    }
  }

  const palette: BlockStateEntry[] = [{ ...AIR_BLOCK_STATE }];
  const idToPaletteIdx = new Map<number, number>([[0, 0]]);
  const volume = width * height * length;
  const blocks = new Uint32Array(volume);

  for (let i = 0; i < Math.min(volume, rawBlocks.length); i++) {
    const blockId = rawBlocks[i]! & 0xff;
    if (blockId === 0) continue;
    let pIdx = idToPaletteIdx.get(blockId);
    if (pIdx === undefined) {
      const mappedName = customMap[blockId] ?? `legacy:block_${blockId}`;
      pIdx = palette.length;
      palette.push({ name: mappedName, properties: {} });
      idToPaletteIdx.set(blockId, pIdx);
    }
    blocks[i] = pIdx;
  }

  const ir: UniversalStructureIR = {
    name: rootName || 'Legacy Schematic',
    author: 'Unknown',
    description: 'Legacy MCEdit/Schematica .schematic',
    sourceFormat: 'schematic',
    mcVersion: '1.20.1',
    dataVersion: DATA_VERSION_1_20_1,
    regions: [
      {
        name: 'Main',
        offset: { x: 0, y: 0, z: 0 },
        size,
        palette,
        blocks,
        blockEntities: new Map(),
        entities: []
      }
    ],
    requiredMods: [],
    metadata: {}
  };
  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

/**
 * Writes Sponge Schematic v2 (.schem) — universally compatible with BOTH
 * WorldEdit 7.2 (MC 1.20.1) and WorldEdit 7.3/7.4 (MC 1.21.x), FAWE, and Litematica!
 */
export function writeSchem(ir: UniversalStructureIR): Uint8Array {
  const reg = mergeRegionsToSingle(ir);
  const paletteObj: Record<string, NbtTag> = {};
  for (let i = 0; i < reg.palette.length; i++) {
    paletteObj[formatBlockState(reg.palette[i]!)] = nbtInt(i);
  }

  const encodedVarInts = encodeVarIntByteArray(reg.blocks);
  const beList: NbtTag[] = [];
  for (const [, be] of reg.blockEntities) {
    const cleanNbt = { ...be.nbt.value };
    delete cleanNbt.x;
    delete cleanNbt.y;
    delete cleanNbt.z;
    delete cleanNbt.id;
    delete cleanNbt.Id;
    delete cleanNbt.Pos;
    beList.push(
      nbtCompound({
        ...cleanNbt,
        Id: nbtString(be.id),
        Pos: nbtIntArray([be.pos.x, be.pos.y, be.pos.z])
      })
    );
  }

  const root = nbtCompound({
    Version: nbtInt(2),
    DataVersion: nbtInt(ir.dataVersion || DATA_VERSION_1_21_11),
    Width: nbtShort(reg.size.x),
    Height: nbtShort(reg.size.y),
    Length: nbtShort(reg.size.z),
    Offset: nbtIntArray([0, 0, 0]),
    PaletteMax: nbtInt(reg.palette.length),
    Palette: nbtCompound(paletteObj),
    BlockData: nbtByteArray(encodedVarInts),
    BlockEntities: nbtList(NbtTagType.Compound, beList),
    Metadata: nbtCompound({
      Name: nbtString(ir.name || 'Structure'),
      Author: nbtString(ir.author || 'MC Structure Visualizer')
    })
  });

  return writeNbt(root, { rootName: 'Schematic', compress: 'gzip' });
}
