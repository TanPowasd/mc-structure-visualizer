import { describe, expect, it } from 'vitest';
import {
  VoxelEditorSession,
  computeSolidBounds,
  countBlockUsage,
  createEmptyStructure,
  formatBlockState,
  getRegionBlock,
  resolveReplacementState,
  parseBlockStateString,
  setRegionBlock
} from '../index.js';

function makeSession(size = { x: 10, y: 6, z: 10 }) {
  const ir = createEmptyStructure('t', size, { mcVersion: '1.21.11' });
  return new VoxelEditorSession(ir);
}

const at = (s: VoxelEditorSession, x: number, y: number, z: number) =>
  formatBlockState(getRegionBlock(s.getPrimaryRegion(), x, y, z));

describe('Air culling', () => {
  it('trims empty air margins and shifts block entities, undo restores the original canvas', () => {
    const s = makeSession();
    const reg = s.getPrimaryRegion();
    setRegionBlock(reg, 3, 1, 4, 'minecraft:stone');
    setRegionBlock(reg, 5, 2, 6, 'minecraft:chest[facing=north]', { type: 10, value: {} } as never);

    expect(computeSolidBounds(reg)).toEqual({ min: { x: 3, y: 1, z: 4 }, max: { x: 5, y: 2, z: 6 } });
    const size = s.trimAir();
    expect(size).toEqual({ x: 3, y: 2, z: 3 });
    expect(at(s, 0, 0, 0)).toBe('minecraft:stone');
    expect(at(s, 2, 1, 2)).toBe('minecraft:chest[facing=north]');
    expect(s.getPrimaryRegion().blockEntities.has('2,1,2')).toBe(true);

    // Nothing left to trim
    expect(s.trimAir()).toBeNull();

    s.undo();
    expect(s.getPrimaryRegion().size).toEqual({ x: 10, y: 6, z: 10 });
    expect(at(s, 3, 1, 4)).toBe('minecraft:stone');
    s.redo();
    expect(s.getPrimaryRegion().size).toEqual({ x: 3, y: 2, z: 3 });
  });

  it('expands the canvas on every side so people can keep building outward', () => {
    const s = makeSession({ x: 2, y: 2, z: 2 });
    s.setBlock(0, 0, 0, 'minecraft:oak_planks');
    s.expandCanvas({ x: 2, y: 0, z: 2 }, { x: 2, y: 4, z: 2 });
    expect(s.getPrimaryRegion().size).toEqual({ x: 6, y: 6, z: 6 });
    expect(at(s, 2, 0, 2)).toBe('minecraft:oak_planks');
    // Block edits after a resize still undo cleanly, then the resize itself
    s.setBlock(5, 5, 5, 'minecraft:glass');
    s.undo();
    expect(at(s, 5, 5, 5)).toBe('minecraft:air');
    s.undo();
    expect(s.getPrimaryRegion().size).toEqual({ x: 2, y: 2, z: 2 });
  });

  it('grows the canvas when placing on an outer face, in one undo step', () => {
    const s = makeSession({ x: 2, y: 1, z: 1 });
    s.setBlock(0, 0, 0, 'minecraft:stone');
    const r = s.placeBlock({ x: -1, y: 0, z: 0 }, 'minecraft:glass');
    expect(r).toEqual({ changed: true, shift: { x: 1, y: 0, z: 0 } });
    expect(s.getPrimaryRegion().size).toEqual({ x: 3, y: 1, z: 1 });
    expect(at(s, 0, 0, 0)).toBe('minecraft:glass');
    expect(at(s, 1, 0, 0)).toBe('minecraft:stone');
    s.undo();
    expect(s.getPrimaryRegion().size).toEqual({ x: 2, y: 1, z: 1 });
    expect(at(s, 0, 0, 0)).toBe('minecraft:stone');
  });

  it('normalises cave_air/void_air and converts air to structure_void', () => {
    const s = makeSession({ x: 2, y: 1, z: 1 });
    s.setBlock(0, 0, 0, 'minecraft:cave_air');
    expect(s.convertAir(['minecraft:cave_air', 'minecraft:void_air'], 'minecraft:air', 'n')).toBe(1);
    expect(at(s, 0, 0, 0)).toBe('minecraft:air');
    expect(s.convertAir(['minecraft:air'], 'minecraft:structure_void', 'v')).toBe(2);
    expect(at(s, 1, 0, 0)).toBe('minecraft:structure_void');
    expect(computeSolidBounds(s.getPrimaryRegion())).toBeNull();
  });
});

describe('Quick replace', () => {
  it('keeps facing/half when swapping within a shape family, not across families', () => {
    const old = parseBlockStateString('minecraft:oak_stairs[facing=east,half=top]');
    expect(formatBlockState(resolveReplacementState(old, parseBlockStateString('minecraft:stone_brick_stairs'), true))).toBe(
      'minecraft:stone_brick_stairs[facing=east,half=top]'
    );
    expect(formatBlockState(resolveReplacementState(old, parseBlockStateString('minecraft:stone'), true))).toBe(
      'minecraft:stone'
    );
    expect(formatBlockState(resolveReplacementState(old, parseBlockStateString('minecraft:stone_brick_stairs'), false))).toBe(
      'minecraft:stone_brick_stairs'
    );
  });

  it('replaces only inside a selection box', () => {
    const s = makeSession({ x: 4, y: 1, z: 1 });
    s.fillBox({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 'minecraft:dirt');
    const n = s.replaceBlock('minecraft:dirt', 'minecraft:grass_block', {
      box: { min: { x: 1, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } }
    });
    expect(n).toBe(2);
    expect([0, 1, 2, 3].map((x) => at(s, x, 0, 0))).toEqual([
      'minecraft:dirt',
      'minecraft:grass_block',
      'minecraft:grass_block',
      'minecraft:dirt'
    ]);
  });

  it('flood-replaces only face-connected blocks of the same type', () => {
    const s = makeSession({ x: 5, y: 1, z: 1 });
    s.fillBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 'minecraft:stone');
    s.setBlock(3, 0, 0, 'minecraft:stone');
    expect(s.replaceConnected({ x: 0, y: 0, z: 0 }, 'minecraft:andesite')).toBe(2);
    expect(at(s, 3, 0, 0)).toBe('minecraft:stone');
    s.undo();
    expect(at(s, 0, 0, 0)).toBe('minecraft:stone');
  });

  it('counts block usage for the palette list, air excluded', () => {
    const s = makeSession({ x: 3, y: 1, z: 1 });
    s.setBlock(0, 0, 0, 'minecraft:oak_stairs[facing=north]');
    s.setBlock(1, 0, 0, 'minecraft:oak_stairs[facing=south]');
    s.setBlock(2, 0, 0, 'minecraft:glass');
    const usage = countBlockUsage(s.getPrimaryRegion());
    expect(usage[0]).toMatchObject({ name: 'minecraft:oak_stairs', count: 2 });
    expect(usage[0]!.states).toHaveLength(2);
    expect(usage.map((u) => u.name)).not.toContain('minecraft:air');
  });

  it('outlines a hollow box', () => {
    const s = makeSession({ x: 3, y: 3, z: 3 });
    expect(s.outlineBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }, 'minecraft:stone')).toBe(26);
    expect(at(s, 1, 1, 1)).toBe('minecraft:air');
  });
});
