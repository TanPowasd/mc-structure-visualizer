import {
  AIR_BLOCK_STATE,
  DATA_VERSION_1_20_1,
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
  isAirBlock,
  mergeRegionsToSingle,
  nbtCompound,
  nbtInt,
  nbtIntArray,
  nbtList,
  nbtLong,
  nbtString,
  normalizeNamespace,
  posKey,
  voxelIndex
} from '@mcvis/core';
import { parseSnbt, stringifySnbt } from './snbt.js';
import { encodeNbtBlockStateEntry, parseNbtBlockStateEntry } from './litematic.js';
import { readNbt } from './nbt-binary.js';

function cleanCopyPasteText(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
}

/**
 * Parses BOTH Building Gadgets 2 (MC 1.20.1 - 1.21.x Forge / NeoForge)
 * AND Building Gadgets v1 (MC 1.16 - 1.19) JSON / SNBT paste strings!
 */
export function parseBuildingGadgets(input: string | Uint8Array): UniversalStructureIR {
  const rawStr =
    typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  const cleaned = cleanCopyPasteText(rawStr);

  // Allow either outer JSON wrapper { name, statePosArrayList: "{...}" } or direct SNBT "{blockstatemap:...}"
  let name = 'Building Gadgets Blueprint';
  let snbtBody = cleaned;
  let bg1BodyBase64: string | undefined;

  if (cleaned.startsWith('{')) {
    try {
      const jsonObj = JSON.parse(cleaned);
      if (typeof jsonObj.name === 'string' && jsonObj.name) {
        name = jsonObj.name;
      }
      if (typeof jsonObj.statePosArrayList === 'string') {
        snbtBody = jsonObj.statePosArrayList;
      } else if (typeof jsonObj.body === 'string') {
        bg1BodyBase64 = jsonObj.body;
        if (jsonObj.header?.name) name = jsonObj.header.name;
      }
    } catch {
      // Not strict JSON — treat directly as SNBT compound!
    }
  }

  if (bg1BodyBase64) {
    return parseBuildingGadgetsV1Base64(bg1BodyBase64, name);
  }

  const root = parseSnbt(snbtBody);
  const rv = root.value;

  // BG2 format: blockstatemap, startpos, endpos, statelist, optional teData
  if (rv.blockstatemap?.type === NbtTagType.List) {
    const rawPalette: BlockStateEntry[] = [];
    for (const item of rv.blockstatemap.value) {
      if (item.type === NbtTagType.Compound) {
        rawPalette.push(parseNbtBlockStateEntry(item));
      }
    }

    const startComp = getNbtCompound(rv, 'startpos') ?? { X: nbtInt(0), Y: nbtInt(0), Z: nbtInt(0) };
    const endComp = getNbtCompound(rv, 'endpos') ?? { X: nbtInt(0), Y: nbtInt(0), Z: nbtInt(0) };

    const sx0 = getNbtNumber(startComp, 'X') ?? getNbtNumber(startComp, 'x') ?? 0;
    const sy0 = getNbtNumber(startComp, 'Y') ?? getNbtNumber(startComp, 'y') ?? 0;
    const sz0 = getNbtNumber(startComp, 'Z') ?? getNbtNumber(startComp, 'z') ?? 0;
    const ex0 = getNbtNumber(endComp, 'X') ?? getNbtNumber(endComp, 'x') ?? 0;
    const ey0 = getNbtNumber(endComp, 'Y') ?? getNbtNumber(endComp, 'y') ?? 0;
    const ez0 = getNbtNumber(endComp, 'Z') ?? getNbtNumber(endComp, 'z') ?? 0;

    const minX = Math.min(sx0, ex0),
      maxX = Math.max(sx0, ex0);
    const minY = Math.min(sy0, ey0),
      maxY = Math.max(sy0, ey0);
    const minZ = Math.min(sz0, ez0),
      maxZ = Math.max(sz0, ez0);

    const size: Vec3 = {
      x: Math.max(1, maxX - minX + 1),
      y: Math.max(1, maxY - minY + 1),
      z: Math.max(1, maxZ - minZ + 1)
    };

    const interner = new PaletteInterner();
    const mappedIdx = rawPalette.map((st) => interner.intern(st));
    const blocks = new Uint32Array(size.x * size.y * size.z);

    let stateInts: ArrayLike<number> = [];
    if (rv.statelist?.type === NbtTagType.IntArray) {
      stateInts = rv.statelist.value;
    } else if (rv.statelist?.type === NbtTagType.List) {
      stateInts = rv.statelist.value.map((v) => Number(v.value));
    }

    // BG2 iterates Y (minY..maxY), Z (minZ..maxZ), X (minX..maxX)
    let cursor = 0;
    for (let y = 0; y < size.y; y++) {
      for (let z = 0; z < size.z; z++) {
        for (let x = 0; x < size.x; x++) {
          if (cursor >= stateInts.length) break;
          const rawIdx = stateInts[cursor++]!;
          const pIdx = mappedIdx[rawIdx] ?? 0;
          blocks[voxelIndex(x, y, z, size)] = pIdx;
        }
      }
    }

    const blockEntities = new Map<string, BlockEntityData>();
    if (rv.teData?.type === NbtTagType.List) {
      for (const teItem of rv.teData.value) {
        if (teItem.type !== NbtTagType.Compound) continue;
        const posVal = teItem.value.pos;
        const nbtData = teItem.value.data ?? teItem.value.nbt;
        if (nbtData?.type !== NbtTagType.Compound) continue;

        let bx = 0,
          by = 0,
          bz = 0;
        if (posVal?.type === NbtTagType.Long) {
          // Packed BlockPos.asLong() (26 bits X, 26 bits Z, 12 bits Y)
          const packed = posVal.value;
          bx = Number(BigInt.asIntN(26, packed >> 38n)) - minX;
          bz = Number(BigInt.asIntN(26, packed >> 12n)) - minZ;
          by = Number(BigInt.asIntN(12, packed)) - minY;
        } else if (posVal?.type === NbtTagType.Compound) {
          bx = (getNbtNumber(posVal.value, 'X') ?? getNbtNumber(posVal.value, 'x') ?? 0) - minX;
          by = (getNbtNumber(posVal.value, 'Y') ?? getNbtNumber(posVal.value, 'y') ?? 0) - minY;
          bz = (getNbtNumber(posVal.value, 'Z') ?? getNbtNumber(posVal.value, 'z') ?? 0) - minZ;
        }
        if (bx >= 0 && by >= 0 && bz >= 0 && bx < size.x && by < size.y && bz < size.z) {
          const pIdx = blocks[voxelIndex(bx, by, bz, size)] ?? 0;
          const id = normalizeNamespace(
            getNbtString(nbtData.value, 'id') ?? interner.palette[pIdx]?.name ?? 'minecraft:chest'
          );
          blockEntities.set(posKey(bx, by, bz), {
            pos: { x: bx, y: by, z: bz },
            id,
            nbt: nbtData
          });
        }
      }
    }

    const ir: UniversalStructureIR = {
      name,
      author: 'Building Gadgets 2',
      description: 'Imported from Building Gadgets 2 JSON/SNBT template',
      sourceFormat: 'building_gadgets_v2',
      mcVersion: '1.21.11',
      dataVersion: DATA_VERSION_1_21_11,
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

  // BG1 SNBT fallback: stateIntArray + posIntArray + mapIntState
  if (rv.stateIntArray && rv.mapIntState?.type === NbtTagType.List) {
    return parseBg1Compound(rv, name);
  }

  throw new Error('Unrecognized Building Gadgets template schema');
}

function parseBuildingGadgetsV1Base64(b64: string, name: string): UniversalStructureIR {
  const binStr =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const { root } = readNbt(bytes);
  return parseBg1Compound(root.value, name);
}

function parseBg1Compound(rv: Record<string, NbtTag>, name: string): UniversalStructureIR {
  const interner = new PaletteInterner();
  const slotToPalette = new Map<number, number>();

  if (rv.mapIntState?.type === NbtTagType.List) {
    for (const item of rv.mapIntState.value) {
      if (item.type !== NbtTagType.Compound) continue;
      const slot = getNbtNumber(item.value, 'mapSlot') ?? 0;
      const mapState = item.value.mapState;
      if (mapState?.type === NbtTagType.Compound) {
        slotToPalette.set(slot, interner.intern(parseNbtBlockStateEntry(mapState)));
      }
    }
  }

  const states =
    rv.stateIntArray?.type === NbtTagType.IntArray ? rv.stateIntArray.value : new Int32Array(0);
  const positions =
    rv.posIntArray?.type === NbtTagType.IntArray ? rv.posIntArray.value : new Int32Array(0);

  const coords: Array<{ x: number; y: number; z: number; pIdx: number }> = [];
  let minX = 0,
    minY = 0,
    minZ = 0,
    maxX = 0,
    maxY = 0,
    maxZ = 0;

  for (let i = 0; i < Math.min(states.length, positions.length); i++) {
    const packed = positions[i]!;
    // BG1 packs signed 8-bit X, Y, Z into 24-bit int: (x & 0xff) << 16 | (y & 0xff) << 8 | (z & 0xff)
    const x = (packed << 8) >> 24;
    const y = (packed << 16) >> 24;
    const z = (packed << 24) >> 24;
    const pIdx = slotToPalette.get(states[i]!) ?? 0;
    if (i === 0) {
      minX = maxX = x;
      minY = maxY = y;
      minZ = maxZ = z;
    } else {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    coords.push({ x, y, z, pIdx });
  }

  const size: Vec3 = {
    x: Math.max(1, maxX - minX + 1),
    y: Math.max(1, maxY - minY + 1),
    z: Math.max(1, maxZ - minZ + 1)
  };
  const blocks = new Uint32Array(size.x * size.y * size.z);
  for (const c of coords) {
    blocks[voxelIndex(c.x - minX, c.y - minY, c.z - minZ, size)] = c.pIdx;
  }

  const ir: UniversalStructureIR = {
    name,
    author: 'Building Gadgets v1',
    description: 'Imported from Building Gadgets v1 template',
    sourceFormat: 'building_gadgets_v1',
    mcVersion: '1.20.1',
    dataVersion: DATA_VERSION_1_20_1,
    regions: [
      {
        name: 'Main',
        offset: { x: 0, y: 0, z: 0 },
        size,
        palette: interner.palette,
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

function packBlockPosLong(x: number, y: number, z: number): bigint {
  const bx = BigInt.asUintN(26, BigInt(x));
  const bz = BigInt.asUintN(26, BigInt(z));
  const by = BigInt.asUintN(12, BigInt(y));
  return BigInt.asIntN(64, (bx << 38n) | (bz << 12n) | by);
}

/**
 * Serializes any structure to Building Gadgets 2 Copy-Paste JSON!
 */
export function writeBuildingGadgetsV2(ir: UniversalStructureIR): string {
  const reg = mergeRegionsToSingle(ir);

  const blockstatemap = nbtList(
    NbtTagType.Compound,
    reg.palette.map(encodeNbtBlockStateEntry)
  );

  const statelist = new Int32Array(reg.size.x * reg.size.y * reg.size.z);
  const requiredItems: Record<string, number> = {};

  let cursor = 0;
  for (let y = 0; y < reg.size.y; y++) {
    for (let z = 0; z < reg.size.z; z++) {
      for (let x = 0; x < reg.size.x; x++) {
        const pIdx = reg.blocks[voxelIndex(x, y, z, reg.size)]!;
        statelist[cursor++] = pIdx;
        const st = reg.palette[pIdx]!;
        if (!isAirBlock(st.name)) {
          requiredItems[st.name] = (requiredItems[st.name] ?? 0) + 1;
        }
      }
    }
  }

  const teDataList: NbtTag[] = [];
  for (const [, be] of reg.blockEntities) {
    teDataList.push(
      nbtCompound({
        pos: nbtLong(packBlockPosLong(be.pos.x, be.pos.y, be.pos.z)),
        data: be.nbt as NbtCompound
      })
    );
  }

  const innerFields: Record<string, NbtTag> = {
    blockstatemap,
    startpos: nbtCompound({
      X: nbtInt(0),
      Y: nbtInt(0),
      Z: nbtInt(0)
    }),
    endpos: nbtCompound({
      X: nbtInt(reg.size.x - 1),
      Y: nbtInt(reg.size.y - 1),
      Z: nbtInt(reg.size.z - 1)
    }),
    statelist: nbtIntArray(statelist)
  };
  if (teDataList.length > 0) {
    innerFields.teData = nbtList(NbtTagType.Compound, teDataList);
  }

  const payload = {
    name: ir.name || 'Blueprint',
    statePosArrayList: stringifySnbt(nbtCompound(innerFields)),
    requiredItems
  };

  return JSON.stringify(payload, null, 2);
}
