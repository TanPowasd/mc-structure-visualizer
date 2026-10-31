import type { StructureFormatId, UniversalStructureIR } from '@mcvis/core';
import { readNbt } from './nbt-binary.js';
import { parseLitematic, writeLitematic } from './litematic.js';
import { parseSchemOrSchematic, writeSchem } from './schem.js';
import { parseVanillaOrCreateNbt, writeVanillaNbt } from './vanilla-nbt.js';
import { parseBuildingGadgets, writeBuildingGadgetsV2 } from './building-gadgets.js';
import { AXIOM_MAGIC, parseAxiomBp, writeAxiomBp } from './axiom-bp.js';
import { parseStructurizeBlueprint, writeStructurizeBlueprint } from './structurize.js';
import { exportAsSetblockCommands, parseF3ICommand } from './f3i-command.js';

export * from './nbt-binary.js';
export * from './snbt.js';
export * from './litematic.js';
export * from './schem.js';
export * from './vanilla-nbt.js';
export * from './building-gadgets.js';
export * from './axiom-bp.js';
export * from './structurize.js';
export * from './f3i-command.js';

export type ExportableFormatId =
  | 'litematic'
  | 'schem'
  | 'nbt'
  | 'building_gadgets_v2'
  | 'axiom_bp'
  | 'structurize_blueprint'
  | 'f3i_command';

export interface FormatDescriptor {
  id: ExportableFormatId;
  label: string;
  extension: string;
  mimeType: string;
  isText: boolean;
}

export const SUPPORTED_EXPORT_FORMATS: FormatDescriptor[] = [
  {
    id: 'litematic',
    label: 'Litematica (.litematic)',
    extension: '.litematic',
    mimeType: 'application/octet-stream',
    isText: false
  },
  {
    id: 'schem',
    label: 'WorldEdit Sponge (.schem)',
    extension: '.schem',
    mimeType: 'application/octet-stream',
    isText: false
  },
  {
    id: 'nbt',
    label: 'Vanilla / Create 机械动力 (.nbt)',
    extension: '.nbt',
    mimeType: 'application/octet-stream',
    isText: false
  },
  {
    id: 'building_gadgets_v2',
    label: 'Building Gadgets 2 建筑小帮手 (.json)',
    extension: '.bg2.json',
    mimeType: 'application/json',
    isText: true
  },
  {
    id: 'axiom_bp',
    label: 'Axiom Blueprint (.bp)',
    extension: '.bp',
    mimeType: 'application/octet-stream',
    isText: false
  },
  {
    id: 'structurize_blueprint',
    label: 'Structurize / 模拟殖民地 (.blueprint)',
    extension: '.blueprint',
    mimeType: 'application/octet-stream',
    isText: false
  },
  {
    id: 'f3i_command',
    label: 'Minecraft /setblock 指令集 (.mcfunction)',
    extension: '.mcfunction',
    mimeType: 'text/plain',
    isText: true
  }
];

/**
 * Automatically detects and parses ANY of the 7 supported structure formats
 * from binary Uint8Array or clipboard string!
 */
export function parseStructureAuto(
  input: Uint8Array | string,
  fileName = 'structure'
): UniversalStructureIR {
  const lowerName = fileName.toLowerCase();

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('/setblock') || trimmed.startsWith('setblock')) {
      return parseF3ICommand(trimmed);
    }
    return parseBuildingGadgets(trimmed);
  }

  // 1. Check Axiom .bp 4-byte binary magic header (0x0AE5BB36)
  if (input.byteLength >= 4) {
    const magic = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(
      0,
      false
    );
    if (magic === AXIOM_MAGIC) {
      return parseAxiomBp(input);
    }
  }

  // 2. Check plain-text JSON / SNBT / /setblock files
  const firstNonWs = findFirstNonWhitespaceByte(input);
  if (firstNonWs === 0x7b /* '{' */ || firstNonWs === 0x2f /* '/' */ || lowerName.endsWith('.json') || lowerName.endsWith('.mcfunction') || lowerName.endsWith('.txt')) {
    const text = new TextDecoder('utf-8').decode(input).trim();
    if (text.startsWith('/setblock') || text.startsWith('setblock')) {
      return parseF3ICommand(text);
    }
    if (text.startsWith('{')) {
      return parseBuildingGadgets(text);
    }
  }

  // 3. Extension hints first, with smart NBT root inspection fallback
  if (lowerName.endsWith('.litematic')) {
    return parseLitematic(input);
  }
  if (lowerName.endsWith('.blueprint')) {
    return parseStructurizeBlueprint(input, fileName);
  }
  if (lowerName.endsWith('.schem') || lowerName.endsWith('.schematic')) {
    return parseSchemOrSchematic(input);
  }
  if (lowerName.endsWith('.nbt')) {
    return parseVanillaOrCreateNbt(input, fileName);
  }

  // 4. Deep NBT Root Inspection when extension is unknown!
  const { root } = readNbt(input);
  const rv = root.value;
  if ('Regions' in rv && 'MinecraftDataVersion' in rv) {
    return parseLitematic(input);
  }
  if ('size_x' in rv && 'size_y' in rv && 'palette' in rv) {
    return parseStructurizeBlueprint(input, fileName);
  }
  if ('Schematic' in rv || ('Width' in rv && ('BlockData' in rv || 'Blocks' in rv))) {
    return parseSchemOrSchematic(input);
  }
  if ('size' in rv && ('palette' in rv || 'palettes' in rv)) {
    return parseVanillaOrCreateNbt(input, fileName);
  }

  throw new Error(`Unable to identify structure format for "${fileName}"`);
}

function findFirstNonWhitespaceByte(bytes: Uint8Array): number {
  for (let i = 0; i < Math.min(bytes.length, 64); i++) {
    const b = bytes[i]!;
    if (b === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) {
      i += 2;
      continue;
    }
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      return b;
    }
  }
  return 0;
}

export function resolveExportFormat(raw: string): ExportableFormatId {
  const key = raw.trim().toLowerCase().replace(/^\./, '');
  switch (key) {
    case 'litematic':
    case 'litematica':
      return 'litematic';
    case 'schem':
    case 'schematic':
      return 'schem';
    case 'nbt':
    case 'vanilla_nbt':
      return 'nbt';
    case 'building_gadgets_v2':
    case 'building_gadgets':
    case 'bg2':
    case 'bg2.json':
    case 'json':
      return 'building_gadgets_v2';
    case 'axiom_bp':
    case 'axiom':
    case 'bp':
      return 'axiom_bp';
    case 'structurize_blueprint':
    case 'structurize':
    case 'blueprint':
      return 'structurize_blueprint';
    case 'f3i_command':
    case 'mcfunction':
    case 'setblock':
      return 'f3i_command';
    default:
      throw new Error(`Unsupported export format: ${raw}`);
  }
}

export interface SerializeOptions {
  /**
   * Air culling on export. Sparse formats (.nbt, F3+I commands, Building Gadgets) drop air
   * voxels entirely so a paste never overwrites terrain; dense formats keep their grid but
   * get cave_air / void_air normalised to plain air.
   */
  skipAir?: boolean;
}

/** Formats where `skipAir` removes air from the file (paste leaves terrain untouched). */
export const AIR_CULLING_SPARSE_FORMATS: ReadonlySet<ExportableFormatId> = new Set<ExportableFormatId>([
  'nbt',
  'f3i_command',
  'building_gadgets_v2'
]);

export function serializeStructure(
  ir: UniversalStructureIR,
  format: ExportableFormatId | string,
  opts: SerializeOptions = {}
): Uint8Array | string {
  const resolved = resolveExportFormat(String(format));
  if (opts.skipAir) {
    ir = normalizeAirVariants(ir);
  }
  switch (resolved) {
    case 'litematic':
      return writeLitematic(ir);
    case 'schem':
      return writeSchem(ir);
    case 'nbt':
      return writeVanillaNbt(ir, { skipAir: opts.skipAir });
    case 'building_gadgets_v2':
      return writeBuildingGadgetsV2(ir);
    case 'axiom_bp':
      return writeAxiomBp(ir);
    case 'structurize_blueprint':
      return writeStructurizeBlueprint(ir);
    case 'f3i_command':
      return exportAsSetblockCommands(ir);
  }
}

/** Returns a copy whose cave_air / void_air palette entries are rewritten to minecraft:air. */
function normalizeAirVariants(ir: UniversalStructureIR): UniversalStructureIR {
  let touched = false;
  const regions = ir.regions.map((r) => {
    if (!r.palette.some((p) => p.name === 'minecraft:cave_air' || p.name === 'minecraft:void_air')) return r;
    touched = true;
    return {
      ...r,
      palette: r.palette.map((p) =>
        p.name === 'minecraft:cave_air' || p.name === 'minecraft:void_air'
          ? { name: 'minecraft:air', properties: {} }
          : p
      )
    };
  });
  return touched ? { ...ir, regions } : ir;
}
