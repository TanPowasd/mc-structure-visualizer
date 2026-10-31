import {
  DATA_VERSION_1_20_1,
  NbtTagType,
  PaletteInterner,
  type BlockEntityData,
  type BlockStateEntry,
  type NbtCompound,
  type NbtTag,
  type UniversalStructureIR,
  type Vec3,
  extractModNamespaces,
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
  posKey,
  voxelIndex
} from '@mcvis/core';
import { readNbt, writeNbt } from './nbt-binary.js';
import { encodeNbtBlockStateEntry, parseNbtBlockStateEntry } from './litematic.js';

/**
 * Parses Structurize / MineColonies (.blueprint) files!
 * Layout (Gzip NBT):
 *   version, mcversion / DataVersion, size_x, size_y, size_z, name, architects,
 *   required_mods (List<String>), palette (List<Compound>),
 *   blocks (IntArray or ByteArray of Big-Endian uint16 shorts),
 *   tile_entities (List<Compound>), entities (List<Compound>)
 */
export function parseStructurizeBlueprint(
  data: Uint8Array,
  nameHint = 'MineColonies Blueprint'
): UniversalStructureIR {
  const { root } = readNbt(data);
  const rv = root.value;

  const sx = Math.max(1, getNbtNumber(rv, 'size_x') ?? 1);
  const sy = Math.max(1, getNbtNumber(rv, 'size_y') ?? 1);
  const sz = Math.max(1, getNbtNumber(rv, 'size_z') ?? 1);
  const size: Vec3 = { x: sx, y: sy, z: sz };

  const dataVersion =
    getNbtNumber(rv, 'mcversion') ?? getNbtNumber(rv, 'DataVersion') ?? DATA_VERSION_1_20_1;
  const name = getNbtString(rv, 'name') ?? nameHint.replace(/\.blueprint$/i, '');

  const architects: string[] = [];
  if (rv.architects?.type === NbtTagType.List) {
    for (const a of rv.architects.value) {
      if (a.type === NbtTagType.String) architects.push(a.value);
    }
  }

  const requiredMods: string[] = [];
  if (rv.required_mods?.type === NbtTagType.List) {
    for (const m of rv.required_mods.value) {
      if (m.type === NbtTagType.String && m.value !== 'minecraft') {
        requiredMods.push(m.value);
      }
    }
  }

  const rawPalette: BlockStateEntry[] = [];
  if (rv.palette?.type === NbtTagType.List) {
    for (const item of rv.palette.value) {
      if (item.type === NbtTagType.Compound) {
        rawPalette.push(parseNbtBlockStateEntry(item));
      }
    }
  }

  const interner = new PaletteInterner();
  const mappedPalette = rawPalette.map((st) => {
    // Structurize uses structurize:null or structurize:placeholder for air/empty space in scans
    if (st.name === 'structurize:null') return 0;
    return interner.intern(st);
  });

  const volume = sx * sy * sz;
  const blocks = new Uint32Array(volume);
  const rawBlocksTag = rv.blocks;

  if (rawBlocksTag?.type === NbtTagType.IntArray) {
    const arr = rawBlocksTag.value;
    // Check if 32-bit int per block (length === volume) OR packed two 16-bit shorts per 32-bit int!
    if (arr.length === volume) {
      for (let i = 0; i < volume; i++) {
        blocks[i] = mappedPalette[arr[i]! & 0xffff] ?? 0;
      }
    } else {
      let outIdx = 0;
      for (let i = 0; i < arr.length && outIdx < volume; i++) {
        const word = arr[i]!;
        const hi = (word >>> 16) & 0xffff;
        const lo = word & 0xffff;
        blocks[outIdx++] = mappedPalette[hi] ?? 0;
        if (outIdx < volume) {
          blocks[outIdx++] = mappedPalette[lo] ?? 0;
        }
      }
    }
  } else if (rawBlocksTag?.type === NbtTagType.ByteArray) {
    // 2 bytes (uint16 BE) per block in Structurize v1 ByteArray encoding!
    const bytes = rawBlocksTag.value;
    if (bytes.length >= volume * 2) {
      for (let i = 0; i < volume; i++) {
        const hi = bytes[i * 2]! & 0xff;
        const lo = bytes[i * 2 + 1]! & 0xff;
        const idx16 = (hi << 8) | lo;
        blocks[i] = mappedPalette[idx16] ?? 0;
      }
    } else {
      for (let i = 0; i < Math.min(volume, bytes.length); i++) {
        blocks[i] = mappedPalette[bytes[i]! & 0xff] ?? 0;
      }
    }
  }

  const blockEntities = new Map<string, BlockEntityData>();
  if (rv.tile_entities?.type === NbtTagType.List) {
    for (const te of rv.tile_entities.value) {
      if (te.type !== NbtTagType.Compound) continue;
      const x = getNbtNumber(te.value, 'x') ?? 0;
      const y = getNbtNumber(te.value, 'y') ?? 0;
      const z = getNbtNumber(te.value, 'z') ?? 0;
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
      const pIdx = blocks[voxelIndex(x, y, z, size)] ?? 0;
      const id = normalizeNamespace(
        getNbtString(te.value, 'id') ?? interner.palette[pIdx]?.name ?? 'minecraft:chest'
      );
      blockEntities.set(posKey(x, y, z), {
        pos: { x, y, z },
        id,
        nbt: te
      });
    }
  }

  const ir: UniversalStructureIR = {
    name,
    author: architects.length > 0 ? architects.join(', ') : 'Structurize',
    description: 'Structurize / MineColonies Blueprint (.blueprint)',
    sourceFormat: 'structurize_blueprint',
    mcVersion: inferMcVersionFromDataVersion(dataVersion),
    dataVersion,
    regions: [
      {
        name: 'Main',
        offset: { x: 0, y: 0, z: 0 },
        size,
        palette: interner.palette,
        blocks,
        blockEntities,
        entities: []
      }
    ],
    requiredMods,
    metadata: { architects }
  };
  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

export function writeStructurizeBlueprint(ir: UniversalStructureIR): Uint8Array {
  const reg = mergeRegionsToSingle(ir);
  const volume = reg.size.x * reg.size.y * reg.size.z;

  const paletteNbt = nbtList(
    NbtTagType.Compound,
    reg.palette.map(encodeNbtBlockStateEntry)
  );

  // Use IntArray when palette > 32767, or standard 16-bit Big-Endian ByteArray / IntArray
  const blocksTag =
    reg.palette.length > 32767
      ? nbtIntArray(new Int32Array(reg.blocks))
      : (() => {
          const byteBuf = new Int8Array(volume * 2);
          for (let i = 0; i < volume; i++) {
            const v = reg.blocks[i]! & 0xffff;
            byteBuf[i * 2] = (v >> 8) & 0xff;
            byteBuf[i * 2 + 1] = v & 0xff;
          }
          return nbtByteArray(byteBuf);
        })();

  const teList: NbtTag[] = [];
  for (const [, be] of reg.blockEntities) {
    teList.push(
      nbtCompound({
        ...be.nbt.value,
        id: nbtString(be.id),
        x: nbtShort(be.pos.x),
        y: nbtShort(be.pos.y),
        z: nbtShort(be.pos.z)
      })
    );
  }

  const mods = extractModNamespaces(ir);
  const root = nbtCompound({
    version: nbtInt(1),
    mcversion: nbtInt(ir.dataVersion || DATA_VERSION_1_20_1),
    name: nbtString(ir.name || 'Blueprint'),
    size_x: nbtShort(reg.size.x),
    size_y: nbtShort(reg.size.y),
    size_z: nbtShort(reg.size.z),
    architects: nbtList(NbtTagType.String, [nbtString(ir.author || 'MC Structure Visualizer')]),
    required_mods: nbtList(
      NbtTagType.String,
      ['minecraft', ...mods].map((m) => nbtString(m))
    ),
    palette: paletteNbt,
    blocks: blocksTag,
    tile_entities: nbtList(NbtTagType.Compound, teList),
    entities: nbtList(NbtTagType.Compound, [])
  });

  return writeNbt(root, { rootName: 'Blueprint', compress: 'gzip' });
}
