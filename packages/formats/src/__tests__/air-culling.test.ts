import { describe, expect, it } from 'vitest';
import { createEmptyStructure, countStructureStats, setRegionBlock } from '@mcvis/core';
import { parseVanillaOrCreateNbt, readNbt, serializeStructure } from '../index.js';

describe('Export air culling', () => {
  const ir = createEmptyStructure('air', { x: 4, y: 4, z: 4 }, { mcVersion: '1.21.11' });
  setRegionBlock(ir.regions[0]!, 1, 1, 1, 'minecraft:stone');
  setRegionBlock(ir.regions[0]!, 2, 2, 2, 'minecraft:cave_air');

  it('drops every air voxel from .nbt so a paste leaves terrain untouched', () => {
    const full = serializeStructure(ir, 'nbt') as Uint8Array;
    const culled = serializeStructure(ir, 'nbt', { skipAir: true }) as Uint8Array;
    const countEntries = (bytes: Uint8Array) => {
      const blocks = readNbt(bytes).root.value.blocks as { value: unknown[] };
      return blocks.value.length;
    };
    expect(countEntries(full)).toBe(64);
    expect(countEntries(culled)).toBe(1);
    expect(countStructureStats(parseVanillaOrCreateNbt(culled)).nonAirBlocks).toBe(1);
  });

  it('never emits setblock commands for air variants', () => {
    const cmds = serializeStructure(ir, 'f3i_command') as string;
    expect(cmds).toContain('minecraft:stone');
    expect(cmds).not.toContain('cave_air');
  });
});
