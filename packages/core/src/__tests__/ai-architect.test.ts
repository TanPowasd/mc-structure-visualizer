import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SAMPLE_SCRIPTS,
  DATA_VERSION_1_20_1,
  DATA_VERSION_1_21_11,
  buildAiArchitectSystemPrompt,
  computeStructureBounds,
  countStructureStats,
  extractDslFromLlmResponse,
  generateOfflineParametricDsl,
  runStructureDslScript,
  sanitizeAndExecuteAiDsl
} from '../index.js';

describe('StructureBuilder High-Level Architectural Primitives & Iterative Editing', () => {
  it('supports gableRoof, pyramidRoof, dome, cylinder, windowWall, spiralStairs and dynamic auto-expansion', () => {
    const code = `
      const b = createBuilder('Architectural_Test', { x: 8, y: 6, z: 8 }, '1.21.11');
      b.checkerboard(0, 0, 0, 12, 0, 12, 'minecraft:stone_bricks', 'minecraft:polished_andesite');
      b.walls(1, 1, 1, 11, 5, 11, 'minecraft:white_concrete');
      b.windowWall(1, 2, 1, 11, 4, 1, 'minecraft:white_concrete', 'minecraft:glass_pane', 2);
      b.arch(4, 1, 1, 8, 4, 1, 'minecraft:stone_bricks');
      b.spiralStairs(6, 1, 6, 2, 5, 'minecraft:oak_slab');
      b.gableRoof(0, 6, 0, 12, 12, 'x', 'minecraft:dark_prismarine_stairs', 'minecraft:dark_prismarine_slab');
      b.dome(6, 10, 6, 3, 'minecraft:cyan_stained_glass');
      return b.build();
    `;
    const ir = runStructureDslScript(code);
    const bounds = computeStructureBounds(ir);
    const stats = countStructureStats(ir);

    // Initial size was 8x6x8, but roof & dome expanded past 12 and height > 10!
    expect(bounds.size.x).toBeGreaterThanOrEqual(13);
    expect(bounds.size.y).toBeGreaterThanOrEqual(13);
    expect(bounds.size.z).toBeGreaterThanOrEqual(13);
    expect(stats.nonAirBlocks).toBeGreaterThan(150);
  });

  it('supports editBaseStructure() for iterative AI modifications preserving base blocks', () => {
    const base = runStructureDslScript(`
      const b = createBuilder('Base_Cabin', { x: 9, y: 6, z: 9 }, '1.21.11');
      b.fill(0, 0, 0, 8, 0, 8, 'minecraft:cobblestone');
      b.walls(1, 1, 1, 7, 4, 7, 'minecraft:oak_planks');
      return b.build();
    `);
    const baseStats = countStructureStats(base);

    const modIr = runStructureDslScript(
      `
      const b = editBaseStructure('Cabin_Upgraded');
      b.replace('minecraft:cobblestone', 'minecraft:stone_bricks');
      b.pyramidRoof(0, 5, 0, 8, 8, 'minecraft:spruce_stairs', 'minecraft:spruce_slab');
      return b.build();
    `,
      { baseStructure: base }
    );

    const modStats = countStructureStats(modIr);
    expect(modIr.name).toBe('Cabin_Upgraded');
    expect(modStats.nonAirBlocks).toBeGreaterThan(baseStats.nonAirBlocks);
    const paletteNames = modIr.regions[0]!.palette.map((p) => p.name);
    expect(paletteNames).toContain('minecraft:stone_bricks');
    expect(paletteNames).not.toContain('minecraft:cobblestone');
    expect(paletteNames).toContain('minecraft:spruce_stairs');
  });

  it('executes all BUILTIN_SAMPLE_SCRIPTS cleanly including oriental pavilion showcase', () => {
    expect(BUILTIN_SAMPLE_SCRIPTS.length).toBeGreaterThanOrEqual(3);
    for (const sample of BUILTIN_SAMPLE_SCRIPTS) {
      const ir = runStructureDslScript(sample.code);
      expect(countStructureStats(ir).nonAirBlocks).toBeGreaterThan(50);
    }
  });
});

describe('AI Architect Prompting, Extraction, Registry Repair & Offline Engine', () => {
  it('strips <think> reasoning tags and extracts fenced JS DSL with Chinese design note', () => {
    const raw = `<think>
Let's plan a 11x10x11 watchtower with stone bricks and lanterns.
</think>
已为您设计一座石砖哨塔，配有木质楼板与顶部灯笼照明。

\`\`\`javascript
const b = createBuilder('AI_Watchtower', { x: 11, y: 10, z: 11 }, '1.21.11');
b.fill(0, 0, 0, 10, 0, 10, 'minecraft:stone_brick');
b.walls(2, 1, 2, 8, 8, 8, 'minecraft:cobblestones');
return b.build();
\`\`\`
`;
    const extracted = extractDslFromLlmResponse(raw);
    expect(extracted.explanation).toContain('石砖哨塔');
    expect(extracted.code).toContain("createBuilder('AI_Watchtower'");
    expect(extracted.code).not.toContain('<think>');

    const knownVanilla = new Set([
      'minecraft:air',
      'minecraft:stone_bricks',
      'minecraft:cobblestone'
    ]);
    const repaired = sanitizeAndExecuteAiDsl(extracted.code, {
      mcVersion: '1.20.1',
      knownVanillaBlocks: knownVanilla
    });

    expect(repaired.fixedBlocks).toBe(2);
    expect(repaired.ir.mcVersion).toBe('1.20.1');
    expect(repaired.ir.dataVersion).toBe(DATA_VERSION_1_20_1);
    const names = repaired.ir.regions[0]!.palette.map((p) => p.name);
    expect(names).toContain('minecraft:stone_bricks');
    expect(names).toContain('minecraft:cobblestone');
  });

  it('injects 1.20.1 rules, mounted mod blocks, and custom blocks into system prompt', () => {
    const prompt = buildAiArchitectSystemPrompt({
      mcVersion: '1.20.1',
      mode: 'create',
      mountedNamespaces: ['create', 'ae2'],
      sampleModBlocks: ['create:brass_casing', 'ae2:fluix_block'],
      customBlockIds: ['kubejs:void_alloy_casing']
    });
    expect(prompt).toContain('1.20.1');
    expect(prompt).toContain('create:brass_casing');
    expect(prompt).toContain('kubejs:void_alloy_casing');
  });

  it('generates rich parametric structures in both create and modify modes offline', () => {
    const created = generateOfflineParametricDsl('生成一座 15x14x15 中式飞檐重檐阁楼', {
      mcVersion: '1.21.11',
      mode: 'create'
    });
    const resCreate = sanitizeAndExecuteAiDsl(created.code, { mcVersion: '1.21.11' });
    expect(resCreate.ir.dataVersion).toBe(DATA_VERSION_1_21_11);
    expect(countStructureStats(resCreate.ir).nonAirBlocks).toBeGreaterThan(200);

    const modified = generateOfflineParametricDsl('给当前建筑加盖屋顶和围墙', {
      mcVersion: '1.21.11',
      mode: 'modify',
      currentStructure: resCreate.ir
    });
    const resModify = sanitizeAndExecuteAiDsl(modified.code, {
      mcVersion: '1.21.11',
      baseStructure: resCreate.ir
    });
    expect(countStructureStats(resModify.ir).nonAirBlocks).toBeGreaterThan(
      countStructureStats(resCreate.ir).nonAirBlocks
    );
  });
});
