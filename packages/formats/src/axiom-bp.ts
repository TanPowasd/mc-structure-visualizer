import {
  DATA_VERSION_1_21_11,
  NbtTagType,
  PaletteInterner,
  type BlockEntityData,
  type BlockStateEntry,
  type NbtCompound,
  type NbtTag,
  type UniversalStructureIR,
  type Vec3,
  extractModNamespaces,
  getNbtCompound,
  getNbtNumber,
  getNbtString,
  inferMcVersionFromDataVersion,
  isAirBlock,
  mergeRegionsToSingle,
  nbtByte,
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
import { encodeNbtBlockStateEntry, parseNbtBlockStateEntry } from './litematic.js';

export const AXIOM_MAGIC = 0x0ae5bb36;

// Minimal valid 1x1 transparent PNG fallback when exporting .bp without a rendered thumbnail
const FALLBACK_1X1_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/**
 * Unpacks a standard Minecraft 1.16+ non-spanning PalettedContainer (4096 blocks = 16x16x16).
 * Shared by Axiom .bp SavedBlockRegions and Anvil .mca chunk sections!
 */
export function unpackPalettedSection4096(
  paletteLen: number,
  dataLongs: BigInt64Array | undefined
): Uint16Array {
  const out = new Uint16Array(4096);
  if (paletteLen <= 1 || !dataLongs || dataLongs.length === 0) {
    return out;
  }
  const bits = Math.max(4, Math.ceil(Math.log2(paletteLen)));
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;

  for (let i = 0; i < 4096; i++) {
    const li = Math.floor(i / perLong);
    const bo = (i % perLong) * bits;
    const u = BigInt.asUintN(64, dataLongs[li] ?? 0n);
    out[i] = Number((u >> BigInt(bo)) & mask);
  }
  return out;
}

export function packPalettedSection4096(
  indices: Uint16Array,
  paletteLen: number
): BigInt64Array | null {
  if (paletteLen <= 1) return null;
  const bits = Math.max(4, Math.ceil(Math.log2(paletteLen)));
  const perLong = Math.floor(64 / bits);
  const totalLongs = Math.ceil(4096 / perLong);
  const uLongs = new BigUint64Array(totalLongs);
  const mask = (1n << BigInt(bits)) - 1n;

  for (let i = 0; i < 4096; i++) {
    const li = Math.floor(i / perLong);
    const bo = (i % perLong) * bits;
    uLongs[li] |= (BigInt(indices[i]!) & mask) << BigInt(bo);
  }
  return new BigInt64Array(uLongs.buffer);
}

/**
 * Parses Axiom Blueprint (.bp) files!
 * Layout:
 *   [int32BE: 0x0AE5BB36]
 *   [int32BE: headerLen] [Header NBT (Name, Author, Tags, BlockCount, ContainsAir)]
 *   [int32BE: thumbnailLen] [Raw PNG bytes]
 *   [int32BE: blockDataLen] [Gzip/Zstd NBT: DataVersion, BlockRegion (SavedBlockRegions), BlockEntities]
 */
export function parseAxiomBp(data: Uint8Array): UniversalStructureIR {
  if (data.byteLength < 16) {
    throw new Error('File too short to be an Axiom .bp blueprint');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== AXIOM_MAGIC) {
    throw new Error(`Invalid Axiom .bp magic bytes: 0x${magic.toString(16)}`);
  }

  let offset = 4;
  const headerLen = view.getInt32(offset, false);
  offset += 4;
  const headerSlice = data.subarray(offset, offset + headerLen);
  offset += headerLen;

  const thumbLen = view.getInt32(offset, false);
  offset += 4;
  const thumbnailPng = thumbLen > 0 ? data.slice(offset, offset + thumbLen) : undefined;
  offset += thumbLen;

  const bodyLen = view.getInt32(offset, false);
  offset += 4;
  const bodySlice = data.subarray(offset, offset + bodyLen);

  const { root: headerNbt } = readNbt(headerSlice, { allowNamelessRoot: true });
  const hv = headerNbt.value;
  const name = getNbtString(hv, 'Name') ?? 'Axiom Blueprint';
  const author = getNbtString(hv, 'Author') ?? 'Unknown';
  const tags: string[] = [];
  if (hv.Tags?.type === NbtTagType.List) {
    for (const t of hv.Tags.value) {
      if (t.type === NbtTagType.String) tags.push(t.value);
    }
  }

  const { root: bodyNbt } = readNbt(bodySlice, { allowNamelessRoot: true });
  const bv = bodyNbt.value;
  const dataVersion = getNbtNumber(bv, 'DataVersion') ?? DATA_VERSION_1_21_11;

  const regionListTag = bv.BlockRegion ?? bv.SavedBlockRegions;
  interface DecodedChunk {
    cx: number;
    cy: number;
    cz: number;
    palette: BlockStateEntry[];
    voxels: Uint16Array;
  }

  const chunks: DecodedChunk[] = [];
  let minBlockX = Infinity,
    minBlockY = Infinity,
    minBlockZ = Infinity;
  let maxBlockX = -Infinity,
    maxBlockY = -Infinity,
    maxBlockZ = -Infinity;

  if (regionListTag?.type === NbtTagType.List) {
    for (const item of regionListTag.value) {
      if (item.type !== NbtTagType.Compound) continue;
      const cc = item.value;
      const cx = getNbtNumber(cc, 'X') ?? getNbtNumber(cc, 'x') ?? 0;
      const cy = getNbtNumber(cc, 'Y') ?? getNbtNumber(cc, 'y') ?? 0;
      const cz = getNbtNumber(cc, 'Z') ?? getNbtNumber(cc, 'z') ?? 0;

      const bsComp = getNbtCompound(cc, 'BlockStates') ?? cc;
      const palTag = bsComp.palette ?? bsComp.Palette;
      const localPalette: BlockStateEntry[] = [];
      if (palTag?.type === NbtTagType.List) {
        for (const p of palTag.value) {
          if (p.type === NbtTagType.Compound) {
            localPalette.push(parseNbtBlockStateEntry(p));
          }
        }
      }
      if (localPalette.length === 0) continue;

      const dataTag = bsComp.data ?? bsComp.Data;
      const longs = dataTag?.type === NbtTagType.LongArray ? dataTag.value : undefined;
      const voxels = unpackPalettedSection4096(localPalette.length, longs);

      // Compute exact tight non-air bounding box across all 16x16x16 chunks
      let chunkHasBlocks = false;
      for (let i = 0; i < 4096; i++) {
        const st = localPalette[voxels[i]!];
        if (st && !isAirBlock(st.name)) {
          chunkHasBlocks = true;
          const lx = i & 15;
          const lz = (i >> 4) & 15;
          const ly = (i >> 8) & 15;
          const gx = cx * 16 + lx;
          const gy = cy * 16 + ly;
          const gz = cz * 16 + lz;
          if (gx < minBlockX) minBlockX = gx;
          if (gy < minBlockY) minBlockY = gy;
          if (gz < minBlockZ) minBlockZ = gz;
          if (gx > maxBlockX) maxBlockX = gx;
          if (gy > maxBlockY) maxBlockY = gy;
          if (gz > maxBlockZ) maxBlockZ = gz;
        }
      }

      if (chunkHasBlocks) {
        chunks.push({ cx, cy, cz, palette: localPalette, voxels });
      }
    }
  }

  if (chunks.length === 0) {
    minBlockX = minBlockY = minBlockZ = 0;
    maxBlockX = maxBlockY = maxBlockZ = 0;
  }

  const size: Vec3 = {
    x: Math.max(1, maxBlockX - minBlockX + 1),
    y: Math.max(1, maxBlockY - minBlockY + 1),
    z: Math.max(1, maxBlockZ - minBlockZ + 1)
  };

  const interner = new PaletteInterner();
  const blocks = new Uint32Array(size.x * size.y * size.z);

  for (const ch of chunks) {
    const remap = ch.palette.map((st) => interner.intern(st));
    for (let i = 0; i < 4096; i++) {
      const mapped = remap[ch.voxels[i]!]!;
      if (mapped === 0) continue;
      const gx = ch.cx * 16 + (i & 15) - minBlockX;
      const gz = ch.cz * 16 + ((i >> 4) & 15) - minBlockZ;
      const gy = ch.cy * 16 + ((i >> 8) & 15) - minBlockY;
      if (gx >= 0 && gy >= 0 && gz >= 0 && gx < size.x && gy < size.y && gz < size.z) {
        blocks[voxelIndex(gx, gy, gz, size)] = mapped;
      }
    }
  }

  const blockEntities = new Map<string, BlockEntityData>();
  if (bv.BlockEntities?.type === NbtTagType.List) {
    for (const item of bv.BlockEntities.value) {
      if (item.type !== NbtTagType.Compound) continue;
      const gx = (getNbtNumber(item.value, 'x') ?? 0) - minBlockX;
      const gy = (getNbtNumber(item.value, 'y') ?? 0) - minBlockY;
      const gz = (getNbtNumber(item.value, 'z') ?? 0) - minBlockZ;
      if (gx >= 0 && gy >= 0 && gz >= 0 && gx < size.x && gy < size.y && gz < size.z) {
        const pIdx = blocks[voxelIndex(gx, gy, gz, size)] ?? 0;
        const id = normalizeNamespace(
          getNbtString(item.value, 'id') ?? interner.palette[pIdx]?.name ?? 'minecraft:chest'
        );
        blockEntities.set(posKey(gx, gy, gz), {
          pos: { x: gx, y: gy, z: gz },
          id,
          nbt: item
        });
      }
    }
  }

  const ir: UniversalStructureIR = {
    name,
    author,
    description: tags.length > 0 ? `Axiom Tags: ${tags.join(', ')}` : 'Axiom Blueprint (.bp)',
    sourceFormat: 'axiom_bp',
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
    requiredMods: [],
    thumbnailPng,
    metadata: { tags }
  };
  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

export function writeAxiomBp(ir: UniversalStructureIR): Uint8Array {
  const reg = mergeRegionsToSingle(ir);

  let nonAirCount = 0;
  for (let i = 0; i < reg.blocks.length; i++) {
    if (reg.blocks[i] !== 0) nonAirCount++;
  }

  const tagsList = (ir.metadata.tags ?? []).map((t) => nbtString(t));
  const headerRoot = nbtCompound({
    Version: nbtLong(1n),
    Name: nbtString(ir.name || 'Blueprint'),
    Author: nbtString(ir.author || 'MC Structure Visualizer'),
    Tags: nbtList(NbtTagType.String, tagsList),
    ThumbnailYaw: nbtInt(135),
    ThumbnailPitch: nbtInt(30),
    LockedThumbnail: nbtByte(0),
    BlockCount: nbtInt(nonAirCount),
    ContainsAir: nbtByte(0)
  });

  const headerBytes = writeNbt(headerRoot, { rootName: '', compress: 'none' });
  const thumbBytes = ir.thumbnailPng && ir.thumbnailPng.length > 0 ? ir.thumbnailPng : FALLBACK_1X1_PNG;

  // Partition into 16x16x16 chunks
  const chunksX = Math.ceil(reg.size.x / 16);
  const chunksY = Math.ceil(reg.size.y / 16);
  const chunksZ = Math.ceil(reg.size.z / 16);
  const regionChunksNbt: NbtTag[] = [];

  for (let cy = 0; cy < chunksY; cy++) {
    for (let cz = 0; cz < chunksZ; cz++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const localInterner = new PaletteInterner();
        const sectionIndices = new Uint16Array(4096);
        let hasNonAir = false;

        for (let ly = 0; ly < 16; ly++) {
          const gy = cy * 16 + ly;
          if (gy >= reg.size.y) continue;
          for (let lz = 0; lz < 16; lz++) {
            const gz = cz * 16 + lz;
            if (gz >= reg.size.z) continue;
            for (let lx = 0; lx < 16; lx++) {
              const gx = cx * 16 + lx;
              if (gx >= reg.size.x) continue;
              const pIdx = reg.blocks[voxelIndex(gx, gy, gz, reg.size)]!;
              if (pIdx !== 0) {
                hasNonAir = true;
                const localIdx = localInterner.intern(reg.palette[pIdx]!);
                sectionIndices[(ly << 8) | (lz << 4) | lx] = localIdx;
              }
            }
          }
        }

        if (!hasNonAir) continue;
        const packedLongs = packPalettedSection4096(
          sectionIndices,
          localInterner.palette.length
        );
        const bsFields: Record<string, NbtTag> = {
          palette: nbtList(
            NbtTagType.Compound,
            localInterner.palette.map(encodeNbtBlockStateEntry)
          )
        };
        if (packedLongs) {
          bsFields.data = nbtLongArray(packedLongs);
        }
        regionChunksNbt.push(
          nbtCompound({
            X: nbtInt(cx),
            Y: nbtInt(cy),
            Z: nbtInt(cz),
            BlockStates: nbtCompound(bsFields)
          })
        );
      }
    }
  }

  const beList: NbtTag[] = [];
  for (const [, be] of reg.blockEntities) {
    beList.push(
      nbtCompound({
        ...be.nbt.value,
        id: nbtString(be.id),
        x: nbtInt(be.pos.x),
        y: nbtInt(be.pos.y),
        z: nbtInt(be.pos.z)
      })
    );
  }

  const bodyRoot = nbtCompound({
    DataVersion: nbtInt(ir.dataVersion || DATA_VERSION_1_21_11),
    BlockRegion: nbtList(NbtTagType.Compound, regionChunksNbt),
    BlockEntities: nbtList(NbtTagType.Compound, beList),
    Entities: nbtList(NbtTagType.Compound, [])
  });
  const bodyBytes = writeNbt(bodyRoot, { rootName: '', compress: 'gzip' });

  const totalLen = 4 + 4 + headerBytes.length + 4 + thumbBytes.length + 4 + bodyBytes.length;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  let pos = 0;

  view.setUint32(pos, AXIOM_MAGIC, false);
  pos += 4;
  view.setInt32(pos, headerBytes.length, false);
  pos += 4;
  out.set(headerBytes, pos);
  pos += headerBytes.length;
  view.setInt32(pos, thumbBytes.length, false);
  pos += 4;
  out.set(thumbBytes, pos);
  pos += thumbBytes.length;
  view.setInt32(pos, bodyBytes.length, false);
  pos += 4;
  out.set(bodyBytes, pos);

  return out;
}
