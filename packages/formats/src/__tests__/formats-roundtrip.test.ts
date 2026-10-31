import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SAMPLE_SCRIPTS,
  NbtTagType,
  VoxelEditorSession,
  calculateBom,
  convertStructureVersion,
  countStructureStats,
  createBuilder,
  formatBlockState,
  getRegionBlock,
  nbtByte,
  nbtCompound,
  nbtInt,
  nbtList,
  nbtString,
  runStructureDslScript
} from '@mcvis/core';
import {
  type ExportableFormatId,
  parseStructureAuto,
  serializeStructure
} from '../index.js';

function createModdedAndRedstoneTestStructure() {
  const b = createBuilder('Universal Roundtrip Test', { x: 6, y: 4, z: 5 }, '1.21.11');
  b.fill(0, 0, 0, 5, 0, 4, 'minecraft:polished_deepslate');
  // Redstone & 1.21 Crafter
  b.set(1, 1, 1, 'minecraft:observer[facing=east,powered=false]');
  b.set(2, 1, 1, 'minecraft:crafter[crafting=false,orientation=east_up,triggered=true]');
  // Double slab (counts as 2 items in BOM!)
  b.set(3, 1, 1, 'minecraft:smooth_stone_slab[type=double,waterlogged=false]');
  // Modded blocks (Forge/NeoForge Create + Fabric AE2 + Structurize)
  b.set(1, 1, 2, 'create:mechanical_bearing[facing=up]');
  b.set(2, 1, 2, 'ae2:controller');
  b.set(3, 1, 2, 'structurize:placeholder[facing=north]');
  // Barrel with 1.21 Item Components inventory
  b.set(
    4,
    1,
    2,
    'minecraft:barrel[facing=up,open=false]',
    nbtCompound({
      id: nbtString('minecraft:barrel'),
      Items: nbtList(NbtTagType.Compound, [
        nbtCompound({
          Slot: nbtByte(0),
          id: nbtString('minecraft:redstone'),
          count: nbtInt(64),
          components: nbtCompound({
            'minecraft:custom_name': nbtString('Signal Dust')
          })
        })
      ])
    })
  );
  return b.build();
}

describe('All 7 Structure Formats Roundtrip & Cross-Version Compatibility', () => {
  const formatsToTest: Array<{ id: ExportableFormatId; ext: string }> = [
    { id: 'litematic', ext: 'test.litematic' },
    { id: 'schem', ext: 'test.schem' },
    { id: 'nbt', ext: 'test.nbt' },
    { id: 'building_gadgets_v2', ext: 'test.bg2.json' },
    { id: 'axiom_bp', ext: 'test.bp' },
    { id: 'structurize_blueprint', ext: 'test.blueprint' },
    { id: 'f3i_command', ext: 'test.mcfunction' }
  ];

  for (const fmt of formatsToTest) {
    it(`round-trips blocks, modded namespaces, and properties via ${fmt.id}`, () => {
      const original = createModdedAndRedstoneTestStructure();
      const origStats = countStructureStats(original);

      const encoded = serializeStructure(original, fmt.id);
      const decoded = parseStructureAuto(encoded, fmt.ext);
      const decStats = countStructureStats(decoded);

      expect(decStats.nonAirBlocks).toBe(origStats.nonAirBlocks);
      expect(decoded.requiredMods).toEqual(expect.arrayContaining(['ae2', 'create']));

      const reg = decoded.regions[0]!;
      expect(formatBlockState(getRegionBlock(reg, 1, 1, 1))).toBe(
        'minecraft:observer[facing=east,powered=false]'
      );
      expect(formatBlockState(getRegionBlock(reg, 2, 1, 1))).toBe(
        'minecraft:crafter[crafting=false,orientation=east_up,triggered=true]'
      );
      expect(formatBlockState(getRegionBlock(reg, 1, 1, 2))).toBe(
        'create:mechanical_bearing[facing=up]'
      );

      if (fmt.id !== 'structurize_blueprint') {
        // Structurize preserves block entities as well; verify container items!
        const bom = calculateBom(decoded);
        expect(bom.containerItems.find((i) => i.itemId === 'minecraft:redstone')?.count).toBe(64);
      }
    });
  }

  it('converts 1.21.11 structures to 1.20.1 (DataVersion 3465 + legacy Item Count/tag) and back', () => {
    const ir121 = createModdedAndRedstoneTestStructure();
    createBuilder('Grass Test', { x: 2, y: 2, z: 2 });
    const session = new VoxelEditorSession(ir121);
    session.setBlock(0, 1, 0, 'minecraft:short_grass');

    const ir120 = convertStructureVersion(session.getStructure(), '1.20.1');
    expect(ir120.dataVersion).toBe(3465);
    expect(getRegionBlock(ir120.regions[0]!, 0, 1, 0).name).toBe('minecraft:grass');

    const bom120 = calculateBom(ir120);
    expect(bom120.containerItems.find((i) => i.itemId === 'minecraft:redstone')?.count).toBe(64);
    // Double slab counted as 2 slabs!
    expect(
      bom120.entries.find((e) => e.itemId === 'minecraft:smooth_stone_slab')?.count
    ).toBe(2);

    // Undo / Redo check
    expect(session.canUndo()).toBe(true);
    session.undo();
    expect(getRegionBlock(session.getPrimaryRegion(), 0, 1, 0).name).toBe('minecraft:air');
    session.redo();
    expect(getRegionBlock(session.getPrimaryRegion(), 0, 1, 0).name).toBe('minecraft:short_grass');
  });

  it('executes built-in DSL sample scripts cleanly', () => {
    for (const sample of BUILTIN_SAMPLE_SCRIPTS) {
      const ir = runStructureDslScript(sample.code);
      expect(countStructureStats(ir).nonAirBlocks).toBeGreaterThan(10);
    }
  });
});
