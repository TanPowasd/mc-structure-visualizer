import { gunzipSync, unzlibSync } from 'fflate';
import {
  DATA_VERSION_1_21_11,
  NbtTagType,
  PaletteInterner,
  type BlockEntityData,
  type BlockStateEntry,
  type UniversalStructureIR,
  type Vec3,
  extractModNamespaces,
  getNbtCompound,
  getNbtNumber,
  getNbtString,
  inferMcVersionFromDataVersion,
  isAirBlock,
  normalizeNamespace,
  posKey,
  voxelIndex
} from '@mcvis/core';
import {
  parseNbtBlockStateEntry,
  readNbt,
  unpackPalettedSection4096
} from '@mcvis/formats';

export interface McaCropBounds {
  min: Vec3;
  max: Vec3;
}

export interface McaChunkSummary {
  chunkX: number;
  chunkZ: number;
  dataVersion: number;
  minSectionY: number;
  maxSectionY: number;
}

/**
 * Lists populated chunks inside an Anvil (.mca) region file (32x32 chunks = 512x512 blocks).
 */
export function inspectAnvilMcaRegion(
  mcaBytes: Uint8Array,
  regionX = 0,
  regionZ = 0
): McaChunkSummary[] {
  if (mcaBytes.byteLength < 8192) return [];
  const view = new DataView(mcaBytes.buffer, mcaBytes.byteOffset, mcaBytes.byteLength);
  const summaries: McaChunkSummary[] = [];

  for (let i = 0; i < 1024; i++) {
    const loc = view.getUint32(i * 4, false);
    if (loc === 0) continue;
    const sectorOffset = (loc >>> 8) * 4096;
    if (sectorOffset + 5 > mcaBytes.byteLength) continue;

    const localChunkX = i & 31;
    const localChunkZ = (i >> 5) & 31;
    summaries.push({
      chunkX: regionX * 32 + localChunkX,
      chunkZ: regionZ * 32 + localChunkZ,
      dataVersion: DATA_VERSION_1_21_11,
      minSectionY: -4,
      maxSectionY: 19
    });
  }
  return summaries;
}

/**
 * Crops an arbitrary world-space bounding box [min..max] directly from one or more
 * Minecraft 1.20.1 / 1.21.x Anvil (.mca) region buffers into a UniversalStructureIR!
 */
export function cropAnvilMcaToStructure(
  regions: Array<{ regionX: number; regionZ: number; data: Uint8Array }>,
  bounds: McaCropBounds,
  name = 'World Save Selection'
): UniversalStructureIR {
  const minX = Math.min(bounds.min.x, bounds.max.x);
  const minY = Math.min(bounds.min.y, bounds.max.y);
  const minZ = Math.min(bounds.min.z, bounds.max.z);
  const maxX = Math.max(bounds.min.x, bounds.max.x);
  const maxY = Math.max(bounds.min.y, bounds.max.y);
  const maxZ = Math.max(bounds.min.z, bounds.max.z);

  const size: Vec3 = {
    x: Math.max(1, maxX - minX + 1),
    y: Math.max(1, maxY - minY + 1),
    z: Math.max(1, maxZ - minZ + 1)
  };

  const interner = new PaletteInterner();
  const blocks = new Uint32Array(size.x * size.y * size.z);
  const blockEntities = new Map<string, BlockEntityData>();
  let detectedDataVersion = DATA_VERSION_1_21_11;

  const minChunkX = Math.floor(minX / 16);
  const maxChunkX = Math.floor(maxX / 16);
  const minChunkZ = Math.floor(minZ / 16);
  const maxChunkZ = Math.floor(maxZ / 16);

  for (const regFile of regions) {
    if (regFile.data.byteLength < 8192) continue;
    const view = new DataView(
      regFile.data.buffer,
      regFile.data.byteOffset,
      regFile.data.byteLength
    );

    for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
      if (Math.floor(cz / 32) !== regFile.regionZ) continue;
      for (let cx = minChunkX; cx <= maxChunkX; cx++) {
        if (Math.floor(cx / 32) !== regFile.regionX) continue;

        const lx = ((cx % 32) + 32) % 32;
        const lz = ((cz % 32) + 32) % 32;
        const headerIdx = lx + lz * 32;
        const loc = view.getUint32(headerIdx * 4, false);
        if (loc === 0) continue;

        const byteOffset = (loc >>> 8) * 4096;
        if (byteOffset + 5 > regFile.data.byteLength) continue;

        const payloadLen = view.getInt32(byteOffset, false);
        const compressionType = regFile.data[byteOffset + 4]!;
        const compressedSlice = regFile.data.subarray(
          byteOffset + 5,
          byteOffset + 4 + payloadLen
        );

        let rawNbtBytes: Uint8Array;
        if (compressionType === 1) {
          rawNbtBytes = gunzipSync(compressedSlice);
        } else if (compressionType === 2) {
          rawNbtBytes = unzlibSync(compressedSlice);
        } else if (compressionType === 3) {
          rawNbtBytes = compressedSlice;
        } else {
          continue;
        }

        const { root } = readNbt(rawNbtBytes);
        const cv = root.value;
        detectedDataVersion = getNbtNumber(cv, 'DataVersion') ?? detectedDataVersion;

        // 1.18+ / 1.20.1 / 1.21.x uses top-level 'sections'
        const sectionsTag = cv.sections ?? getNbtCompound(cv, 'Level')?.Sections;
        if (sectionsTag?.type === NbtTagType.List) {
          for (const secItem of sectionsTag.value) {
            if (secItem.type !== NbtTagType.Compound) continue;
            const sc = secItem.value;
            const secY = getNbtNumber(sc, 'Y');
            if (secY === undefined) continue;

            const secMinWorldY = secY * 16;
            const secMaxWorldY = secMinWorldY + 15;
            if (secMaxWorldY < minY || secMinWorldY > maxY) continue;

            const bsComp = getNbtCompound(sc, 'block_states');
            const palTag = bsComp?.palette ?? sc.Palette;
            if (palTag?.type !== NbtTagType.List) continue;

            const localPalette: BlockStateEntry[] = [];
            for (const p of palTag.value) {
              if (p.type === NbtTagType.Compound) {
                localPalette.push(parseNbtBlockStateEntry(p));
              }
            }
            if (localPalette.length === 0) continue;
            if (localPalette.length === 1 && isAirBlock(localPalette[0]!.name)) continue;

            const dataTag = bsComp?.data ?? sc.BlockStates;
            const longs = dataTag?.type === NbtTagType.LongArray ? dataTag.value : undefined;
            const unpacked = unpackPalettedSection4096(localPalette.length, longs);
            const remap = localPalette.map((st) => interner.intern(st));

            const startWx = Math.max(minX, cx * 16);
            const endWx = Math.min(maxX, cx * 16 + 15);
            const startWz = Math.max(minZ, cz * 16);
            const endWz = Math.min(maxZ, cz * 16 + 15);
            const startWy = Math.max(minY, secMinWorldY);
            const endWy = Math.min(maxY, secMaxWorldY);

            for (let wy = startWy; wy <= endWy; wy++) {
              const sy = wy - secMinWorldY;
              for (let wz = startWz; wz <= endWz; wz++) {
                const sz = wz - cz * 16;
                for (let wx = startWx; wx <= endWx; wx++) {
                  const sx = wx - cx * 16;
                  const pIdx = remap[unpacked[(sy << 8) | (sz << 4) | sx]!]!;
                  if (pIdx !== 0) {
                    blocks[voxelIndex(wx - minX, wy - minY, wz - minZ, size)] = pIdx;
                  }
                }
              }
            }
          }
        }

        const beListTag = cv.block_entities ?? getNbtCompound(cv, 'Level')?.TileEntities;
        if (beListTag?.type === NbtTagType.List) {
          for (const be of beListTag.value) {
            if (be.type !== NbtTagType.Compound) continue;
            const wx = getNbtNumber(be.value, 'x') ?? 0;
            const wy = getNbtNumber(be.value, 'y') ?? 0;
            const wz = getNbtNumber(be.value, 'z') ?? 0;
            if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY && wz >= minZ && wz <= maxZ) {
              const rx = wx - minX;
              const ry = wy - minY;
              const rz = wz - minZ;
              const id = normalizeNamespace(getNbtString(be.value, 'id') ?? 'minecraft:chest');
              blockEntities.set(posKey(rx, ry, rz), {
                pos: { x: rx, y: ry, z: rz },
                id,
                nbt: be
              });
            }
          }
        }
      }
    }
  }

  const ir: UniversalStructureIR = {
    name,
    author: 'Anvil Region Crop',
    description: `Cropped [${minX},${minY},${minZ}]..[${maxX},${maxY},${maxZ}]`,
    sourceFormat: 'imported_3d',
    mcVersion: inferMcVersionFromDataVersion(detectedDataVersion),
    dataVersion: detectedDataVersion,
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
    metadata: {}
  };
  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}
