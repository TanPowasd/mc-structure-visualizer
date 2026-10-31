import {
  AIR_BLOCK_STATE,
  DATA_VERSION_1_21_11,
  NbtTagType,
  type BlockEntityData,
  type BlockStateEntry,
  type EntityData,
  type SuperGlueBox,
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
  nbtCompound,
  nbtDouble,
  nbtInt,
  nbtList,
  nbtString,
  normalizeNamespace,
  posKey,
  voxelIndex
} from '@mcvis/core';
import { readNbt, writeNbt } from './nbt-binary.js';
import { encodeNbtBlockStateEntry, parseNbtBlockStateEntry } from './litematic.js';

export function parseVanillaOrCreateNbt(data: Uint8Array, nameHint = 'Structure'): UniversalStructureIR {
  const { root } = readNbt(data);
  const rv = root.value;

  const dataVersion = getNbtNumber(rv, 'DataVersion') ?? DATA_VERSION_1_21_11;

  let sx = 1,
    sy = 1,
    sz = 1;
  if (rv.size?.type === NbtTagType.List && rv.size.value.length >= 3) {
    sx = Math.max(1, Number(rv.size.value[0]?.value ?? 1));
    sy = Math.max(1, Number(rv.size.value[1]?.value ?? 1));
    sz = Math.max(1, Number(rv.size.value[2]?.value ?? 1));
  }
  const size: Vec3 = { x: sx, y: sy, z: sz };

  // Palette can be under 'palette' or first entry of 'palettes' (shipwrecks / multi-palette structures)
  let rawPaletteList = rv.palette;
  if (!rawPaletteList && rv.palettes?.type === NbtTagType.List && rv.palettes.value.length > 0) {
    rawPaletteList = rv.palettes.value[0];
  }

  const palette: BlockStateEntry[] = [{ ...AIR_BLOCK_STATE }];
  const fileIdxToPaletteIdx = new Map<number, number>();

  if (rawPaletteList?.type === NbtTagType.List) {
    for (let i = 0; i < rawPaletteList.value.length; i++) {
      const item = rawPaletteList.value[i];
      if (item?.type !== NbtTagType.Compound) continue;
      const entry = parseNbtBlockStateEntry(item);
      if (isAirBlock(entry.name) && Object.keys(entry.properties).length === 0) {
        fileIdxToPaletteIdx.set(i, 0);
      } else {
        const idx = palette.length;
        palette.push(entry);
        fileIdxToPaletteIdx.set(i, idx);
      }
    }
  }

  const blocks = new Uint32Array(sx * sy * sz);
  const blockEntities = new Map<string, BlockEntityData>();

  if (rv.blocks?.type === NbtTagType.List) {
    for (const blk of rv.blocks.value) {
      if (blk.type !== NbtTagType.Compound) continue;
      const bc = blk.value;
      if (bc.pos?.type !== NbtTagType.List || bc.pos.value.length < 3) continue;
      const x = Number(bc.pos.value[0]?.value ?? 0);
      const y = Number(bc.pos.value[1]?.value ?? 0);
      const z = Number(bc.pos.value[2]?.value ?? 0);
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;

      const fileStateIdx = getNbtNumber(bc, 'state') ?? 0;
      const pIdx = fileIdxToPaletteIdx.get(fileStateIdx) ?? 0;
      blocks[voxelIndex(x, y, z, size)] = pIdx;

      if (bc.nbt?.type === NbtTagType.Compound) {
        const id = normalizeNamespace(
          getNbtString(bc.nbt.value, 'id') ?? palette[pIdx]?.name ?? 'minecraft:chest'
        );
        blockEntities.set(posKey(x, y, z), {
          pos: { x, y, z },
          id,
          nbt: bc.nbt
        });
      }
    }
  }

  const entities: EntityData[] = [];
  const superGlue: SuperGlueBox[] = [];
  let isCreateSchematic = false;

  if (rv.entities?.type === NbtTagType.List) {
    for (const ent of rv.entities.value) {
      if (ent.type !== NbtTagType.Compound) continue;
      const ec = ent.value;
      const nbtTag = ec.nbt?.type === NbtTagType.Compound ? ec.nbt : ent;
      const entId = normalizeNamespace(getNbtString(nbtTag.value, 'id') ?? 'minecraft:armor_stand');

      if (entId === 'create:super_glue') {
        isCreateSchematic = true;
        const fromComp = getNbtCompound(nbtTag.value, 'From');
        const toComp = getNbtCompound(nbtTag.value, 'To');
        if (fromComp && toComp) {
          superGlue.push({
            from: [
              getNbtNumber(fromComp, 'X') ?? 0,
              getNbtNumber(fromComp, 'Y') ?? 0,
              getNbtNumber(fromComp, 'Z') ?? 0
            ],
            to: [
              getNbtNumber(toComp, 'X') ?? 0,
              getNbtNumber(toComp, 'Y') ?? 0,
              getNbtNumber(toComp, 'Z') ?? 0
            ]
          });
        }
      }

      let px = 0,
        py = 0,
        pz = 0;
      if (ec.pos?.type === NbtTagType.List && ec.pos.value.length >= 3) {
        px = Number(ec.pos.value[0]?.value ?? 0);
        py = Number(ec.pos.value[1]?.value ?? 0);
        pz = Number(ec.pos.value[2]?.value ?? 0);
      }
      let bx = Math.floor(px),
        by = Math.floor(py),
        bz = Math.floor(pz);
      if (ec.blockPos?.type === NbtTagType.List && ec.blockPos.value.length >= 3) {
        bx = Number(ec.blockPos.value[0]?.value ?? bx);
        by = Number(ec.blockPos.value[1]?.value ?? by);
        bz = Number(ec.blockPos.value[2]?.value ?? bz);
      }
      entities.push({
        pos: [px, py, pz],
        blockPos: { x: bx, y: by, z: bz },
        id: entId,
        nbt: nbtTag
      });
    }
  }

  const ir: UniversalStructureIR = {
    name: nameHint.replace(/\.(nbt)$/i, ''),
    author: getNbtString(rv, 'author') ?? 'Unknown',
    description: '',
    sourceFormat: 'nbt',
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
        entities
      }
    ],
    requiredMods: [],
    metadata: superGlue.length > 0 ? { superGlue } : {}
  };
  ir.requiredMods = extractModNamespaces(ir);
  if (isCreateSchematic || ir.requiredMods.includes('create')) {
    ir.sourceFormat = 'create_nbt';
  }
  return ir;
}

export interface VanillaNbtWriteOptions {
  /**
   * Omit every air-like voxel (air / cave_air / void_air / structure_void). In a vanilla
   * structure file an omitted position behaves like structure_void: pasting leaves the
   * world block there untouched instead of carving it out.
   */
  skipAir?: boolean;
}

export function writeVanillaNbt(ir: UniversalStructureIR, opts: VanillaNbtWriteOptions = {}): Uint8Array {
  const reg = mergeRegionsToSingle(ir);
  const airIdx = new Set<number>();
  reg.palette.forEach((p, i) => {
    if (isAirBlock(p.name)) airIdx.add(i);
  });

  const paletteNbt = nbtList(
    NbtTagType.Compound,
    reg.palette.map(encodeNbtBlockStateEntry)
  );

  const blocksList: NbtTag[] = [];
  for (let y = 0; y < reg.size.y; y++) {
    for (let z = 0; z < reg.size.z; z++) {
      for (let x = 0; x < reg.size.x; x++) {
        const stateIdx = reg.blocks[voxelIndex(x, y, z, reg.size)]!;
        // Include non-air blocks (and air if structure is tiny or Create schematic expects full bounding volume)
        if (opts.skipAir && airIdx.has(stateIdx)) continue;
        if (stateIdx === 0 && reg.size.x * reg.size.y * reg.size.z > 4096) continue;
        const fields: Record<string, NbtTag> = {
          pos: nbtList(NbtTagType.Int, [nbtInt(x), nbtInt(y), nbtInt(z)]),
          state: nbtInt(stateIdx)
        };
        const be = reg.blockEntities.get(posKey(x, y, z));
        if (be) {
          fields.nbt = be.nbt as NbtCompound;
        }
        blocksList.push(nbtCompound(fields));
      }
    }
  }

  const entitiesList: NbtTag[] = reg.entities.map((e) =>
    nbtCompound({
      pos: nbtList(NbtTagType.Double, [
        nbtDouble(e.pos[0]),
        nbtDouble(e.pos[1]),
        nbtDouble(e.pos[2])
      ]),
      blockPos: nbtList(NbtTagType.Int, [
        nbtInt(e.blockPos.x),
        nbtInt(e.blockPos.y),
        nbtInt(e.blockPos.z)
      ]),
      nbt: e.nbt
    })
  );

  const root = nbtCompound({
    DataVersion: nbtInt(ir.dataVersion || DATA_VERSION_1_21_11),
    author: nbtString(ir.author || 'MC Structure Visualizer'),
    size: nbtList(NbtTagType.Int, [
      nbtInt(reg.size.x),
      nbtInt(reg.size.y),
      nbtInt(reg.size.z)
    ]),
    palette: paletteNbt,
    blocks: nbtList(NbtTagType.Compound, blocksList),
    entities: nbtList(NbtTagType.Compound, entitiesList)
  });

  return writeNbt(root, { rootName: '', compress: 'gzip' });
}
