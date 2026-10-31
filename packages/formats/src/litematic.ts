import {
  AIR_BLOCK_STATE,
  DATA_VERSION_1_21_11,
  NbtTagType,
  type BlockEntityData,
  type BlockStateEntry,
  type EntityData,
  type NbtCompound,
  type NbtTag,
  type StructureRegion,
  type UniversalStructureIR,
  type Vec3,
  extractModNamespaces,
  getNbtCompound,
  getNbtNumber,
  getNbtString,
  inferMcVersionFromDataVersion,
  nbtCompound,
  nbtInt,
  nbtList,
  nbtLong,
  nbtLongArray,
  nbtString,
  normalizeNamespace,
  posKey,
  voxelIndex
} from '@mcvis/core';
import { readNbt, writeNbt } from './nbt-binary.js';

export function parseNbtBlockStateEntry(tag: NbtCompound): BlockStateEntry {
  const name = normalizeNamespace(getNbtString(tag.value, 'Name') ?? 'minecraft:air');
  const propsTag = getNbtCompound(tag.value, 'Properties');
  const properties: Record<string, string> = {};
  if (propsTag) {
    for (const [k, v] of Object.entries(propsTag)) {
      if (v.type === NbtTagType.String) properties[k] = v.value;
      else properties[k] = String(v.value);
    }
  }
  return { name, properties };
}

export function encodeNbtBlockStateEntry(entry: BlockStateEntry): NbtCompound {
  const fields: Record<string, NbtTag> = {
    Name: nbtString(normalizeNamespace(entry.name))
  };
  const propKeys = Object.keys(entry.properties).sort();
  if (propKeys.length > 0) {
    const propsObj: Record<string, NbtTag> = {};
    for (const k of propKeys) {
      propsObj[k] = nbtString(entry.properties[k]!);
    }
    fields.Properties = nbtCompound(propsObj);
  }
  return nbtCompound(fields);
}

function unpackLitematicLongs(
  longs: BigInt64Array,
  volume: number,
  bits: number
): Uint32Array {
  const out = new Uint32Array(volume);
  if (longs.length === 0 || volume === 0) return out;

  const mask = (1n << BigInt(bits)) - 1n;
  const spanningExpected = Math.ceil((volume * bits) / 64);
  const perLong = Math.floor(64 / bits);
  const nonSpanningExpected = Math.ceil(volume / perLong);

  const isNonSpanning =
    longs.length !== spanningExpected && longs.length === nonSpanningExpected;

  if (isNonSpanning) {
    for (let i = 0; i < volume; i++) {
      const li = Math.floor(i / perLong);
      const bo = (i % perLong) * bits;
      const u = BigInt.asUintN(64, longs[li] ?? 0n);
      out[i] = Number((u >> BigInt(bo)) & mask);
    }
  } else {
    for (let i = 0; i < volume; i++) {
      const startBit = i * bits;
      const startLong = Math.floor(startBit / 64);
      const bitOffset = startBit % 64;
      const u0 = BigInt.asUintN(64, longs[startLong] ?? 0n);
      if (bitOffset + bits <= 64) {
        out[i] = Number((u0 >> BigInt(bitOffset)) & mask);
      } else {
        const u1 = BigInt.asUintN(64, longs[startLong + 1] ?? 0n);
        const lowBits = 64 - bitOffset;
        out[i] = Number(((u0 >> BigInt(bitOffset)) | (u1 << BigInt(lowBits))) & mask);
      }
    }
  }
  return out;
}

function packLitematicLongs(blocks: Uint32Array, paletteLength: number): BigInt64Array {
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, paletteLength))));
  const totalLongs = Math.ceil((blocks.length * bits) / 64);
  const uLongs = new BigUint64Array(totalLongs);
  const mask = (1n << BigInt(bits)) - 1n;

  for (let i = 0; i < blocks.length; i++) {
    const val = BigInt(blocks[i]!) & mask;
    const startBit = i * bits;
    const startLong = Math.floor(startBit / 64);
    const bitOffset = startBit % 64;
    uLongs[startLong] |= val << BigInt(bitOffset);
    if (bitOffset + bits > 64) {
      const lowBits = 64 - bitOffset;
      uLongs[startLong + 1] |= val >> BigInt(lowBits);
    }
  }

  return new BigInt64Array(uLongs.buffer);
}

export function parseLitematic(data: Uint8Array): UniversalStructureIR {
  const { root } = readNbt(data);
  const rv = root.value;

  const dataVersion = getNbtNumber(rv, 'MinecraftDataVersion') ?? DATA_VERSION_1_21_11;
  const meta = getNbtCompound(rv, 'Metadata') ?? {};
  const name = getNbtString(meta, 'Name') ?? 'Untitled Litematic';
  const author = getNbtString(meta, 'Author') ?? 'Unknown';
  const description = getNbtString(meta, 'Description') ?? '';
  const regionsComp = getNbtCompound(rv, 'Regions') ?? {};

  const regions: StructureRegion[] = [];

  for (const [regionName, regTag] of Object.entries(regionsComp)) {
    if (regTag.type !== NbtTagType.Compound) continue;
    const rc = regTag.value;

    const posTag = getNbtCompound(rc, 'Position') ?? {};
    const sizeTag = getNbtCompound(rc, 'Size') ?? {};

    const rawPos: Vec3 = {
      x: getNbtNumber(posTag, 'x') ?? 0,
      y: getNbtNumber(posTag, 'y') ?? 0,
      z: getNbtNumber(posTag, 'z') ?? 0
    };
    const rawSize: Vec3 = {
      x: getNbtNumber(sizeTag, 'x') ?? 1,
      y: getNbtNumber(sizeTag, 'y') ?? 1,
      z: getNbtNumber(sizeTag, 'z') ?? 1
    };

    // Litematica allows negative size components when corner2 < corner1!
    const normSize: Vec3 = {
      x: Math.max(1, Math.abs(rawSize.x)),
      y: Math.max(1, Math.abs(rawSize.y)),
      z: Math.max(1, Math.abs(rawSize.z))
    };
    const normOffset: Vec3 = {
      x: rawSize.x < 0 ? rawPos.x + rawSize.x + 1 : rawPos.x,
      y: rawSize.y < 0 ? rawPos.y + rawSize.y + 1 : rawPos.y,
      z: rawSize.z < 0 ? rawPos.z + rawSize.z + 1 : rawPos.z
    };

    const paletteTag = rc.BlockStatePalette;
    const palette: BlockStateEntry[] = [];
    if (paletteTag?.type === NbtTagType.List) {
      for (const item of paletteTag.value) {
        if (item.type === NbtTagType.Compound) {
          palette.push(parseNbtBlockStateEntry(item));
        }
      }
    }
    if (palette.length === 0) {
      palette.push({ ...AIR_BLOCK_STATE });
    }

    const volume = normSize.x * normSize.y * normSize.z;
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
    const statesTag = rc.BlockStates;
    const blocks =
      statesTag?.type === NbtTagType.LongArray
        ? unpackLitematicLongs(statesTag.value, volume, bits)
        : new Uint32Array(volume);

    const blockEntities = new Map<string, BlockEntityData>();
    if (rc.TileEntities?.type === NbtTagType.List) {
      for (const te of rc.TileEntities.value) {
        if (te.type !== NbtTagType.Compound) continue;
        const x = getNbtNumber(te.value, 'x') ?? 0;
        const y = getNbtNumber(te.value, 'y') ?? 0;
        const z = getNbtNumber(te.value, 'z') ?? 0;
        const pIdx = blocks[voxelIndex(x, y, z, normSize)] ?? 0;
        const id = normalizeNamespace(
          getNbtString(te.value, 'id') ?? palette[pIdx]?.name ?? 'minecraft:chest'
        );
        blockEntities.set(posKey(x, y, z), {
          pos: { x, y, z },
          id,
          nbt: te
        });
      }
    }

    const entities: EntityData[] = [];
    if (rc.Entities?.type === NbtTagType.List) {
      for (const ent of rc.Entities.value) {
        if (ent.type !== NbtTagType.Compound) continue;
        const id = normalizeNamespace(getNbtString(ent.value, 'id') ?? 'minecraft:armor_stand');
        let px = 0,
          py = 0,
          pz = 0;
        if (ent.value.Pos?.type === NbtTagType.List && ent.value.Pos.value.length >= 3) {
          px = Number(ent.value.Pos.value[0]?.value ?? 0);
          py = Number(ent.value.Pos.value[1]?.value ?? 0);
          pz = Number(ent.value.Pos.value[2]?.value ?? 0);
        }
        entities.push({
          pos: [px, py, pz],
          blockPos: { x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz) },
          id,
          nbt: ent
        });
      }
    }

    regions.push({
      name: regionName,
      offset: normOffset,
      size: normSize,
      palette,
      blocks,
      blockEntities,
      entities
    });
  }

  const ir: UniversalStructureIR = {
    name,
    author,
    description,
    sourceFormat: 'litematic',
    mcVersion: inferMcVersionFromDataVersion(dataVersion),
    dataVersion,
    regions,
    requiredMods: [],
    metadata: {}
  };
  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

export function writeLitematic(ir: UniversalStructureIR): Uint8Array {
  const regionsMap: Record<string, NbtTag> = {};
  let totalBlocks = 0;
  let totalVolume = 0;

  let maxX = 1,
    maxY = 1,
    maxZ = 1;

  for (const r of ir.regions) {
    totalVolume += r.size.x * r.size.y * r.size.z;
    maxX = Math.max(maxX, r.offset.x + r.size.x);
    maxY = Math.max(maxY, r.offset.y + r.size.y);
    maxZ = Math.max(maxZ, r.offset.z + r.size.z);

    for (let i = 0; i < r.blocks.length; i++) {
      if (r.blocks[i] !== 0) totalBlocks++;
    }

    const paletteList = nbtList(
      NbtTagType.Compound,
      r.palette.map(encodeNbtBlockStateEntry)
    );
    const packedLongs = packLitematicLongs(r.blocks, r.palette.length);

    const tileEntitiesList: NbtTag[] = [];
    for (const [, be] of r.blockEntities) {
      tileEntitiesList.push(
        nbtCompound({
          ...be.nbt.value,
          id: nbtString(be.id),
          x: nbtInt(be.pos.x),
          y: nbtInt(be.pos.y),
          z: nbtInt(be.pos.z)
        })
      );
    }

    regionsMap[r.name || 'Main'] = nbtCompound({
      Position: nbtCompound({
        x: nbtInt(r.offset.x),
        y: nbtInt(r.offset.y),
        z: nbtInt(r.offset.z)
      }),
      Size: nbtCompound({
        x: nbtInt(r.size.x),
        y: nbtInt(r.size.y),
        z: nbtInt(r.size.z)
      }),
      BlockStatePalette: paletteList,
      BlockStates: nbtLongArray(packedLongs),
      TileEntities: nbtList(NbtTagType.Compound, tileEntitiesList),
      Entities: nbtList(
        NbtTagType.Compound,
        r.entities.map((e) => e.nbt)
      ),
      PendingBlockTicks: nbtList(NbtTagType.Compound, []),
      PendingFluidTicks: nbtList(NbtTagType.Compound, [])
    });
  }

  const now = BigInt(Date.now());
  const root = nbtCompound({
    MinecraftDataVersion: nbtInt(ir.dataVersion || DATA_VERSION_1_21_11),
    Version: nbtInt(6),
    SubVersion: nbtInt(1),
    Metadata: nbtCompound({
      Name: nbtString(ir.name || 'Structure'),
      Author: nbtString(ir.author || 'MC Structure Visualizer'),
      Description: nbtString(ir.description || ''),
      RegionCount: nbtInt(ir.regions.length),
      TotalBlocks: nbtInt(totalBlocks),
      TotalVolume: nbtInt(totalVolume),
      TimeCreated: nbtLong(now),
      TimeModified: nbtLong(now),
      EnclosingSize: nbtCompound({
        x: nbtInt(maxX),
        y: nbtInt(maxY),
        z: nbtInt(maxZ)
      })
    }),
    Regions: nbtCompound(regionsMap)
  });

  return writeNbt(root, { rootName: '', compress: 'gzip' });
}
