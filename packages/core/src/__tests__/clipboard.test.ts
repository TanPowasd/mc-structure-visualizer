import { describe, expect, it } from 'vitest';
import {
  VoxelEditorSession,
  createEmptyStructure,
  formatBlockState,
  getRegionBlock,
  parseBlockStateString,
  setRegionBlock,
  transformBlockState,
  transformClipboard
} from '../index.js';

function makeSession(size = { x: 8, y: 4, z: 8 }) {
  return new VoxelEditorSession(createEmptyStructure('t', size, { mcVersion: '1.21.11' }));
}
const at = (s: VoxelEditorSession, x: number, y: number, z: number) =>
  formatBlockState(getRegionBlock(s.getPrimaryRegion(), x, y, z));
const norm = (st: string) => formatBlockState(parseBlockStateString(st));
const props = (st: string) => parseBlockStateString(st).properties;

describe('Block state transforms', () => {
  it('rotates facing, axis, connections and sign rotation clockwise', () => {
    expect(props(transformBlockState('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]', 'rotateCW')).facing).toBe('east');
    expect(props(transformBlockState('minecraft:oak_log[axis=x]', 'rotateCW')).axis).toBe('z');
    const fence = props(transformBlockState('minecraft:oak_fence[north=true,east=false,south=false,west=false]', 'rotateCW'));
    expect(fence).toMatchObject({ north: 'false', east: 'true', south: 'false', west: 'false' });
    expect(props(transformBlockState('minecraft:oak_sign[rotation=14]', 'rotateCW')).rotation).toBe('2');
    expect(props(transformBlockState('minecraft:rail[shape=north_east]', 'rotateCW')).shape).toBe('south_east');
    expect(props(transformBlockState('minecraft:oak_stairs[facing=north]', 'rotateCCW')).facing).toBe('west');
  });

  it('mirrors swap handedness of stair corners and door hinges', () => {
    const st = props(transformBlockState('minecraft:oak_stairs[facing=east,shape=inner_left]', 'mirrorX'));
    expect(st).toMatchObject({ facing: 'west', shape: 'inner_right' });
    expect(props(transformBlockState('minecraft:oak_door[facing=north,hinge=left]', 'mirrorX'))).toMatchObject({
      facing: 'north',
      hinge: 'right'
    });
    expect(props(transformBlockState('minecraft:rail[shape=north_east]', 'mirrorX')).shape).toBe('north_west');
    expect(props(transformBlockState('minecraft:rail[shape=ascending_north]', 'mirrorZ')).shape).toBe('ascending_south');
    expect(props(transformBlockState('minecraft:oak_sign[rotation=4]', 'mirrorX')).rotation).toBe('12');
  });

  it('flips upper/lower halves and slab types vertically', () => {
    expect(props(transformBlockState('minecraft:stone_slab[type=bottom]', 'flipY')).type).toBe('top');
    expect(props(transformBlockState('minecraft:oak_stairs[facing=north,half=bottom]', 'flipY')).half).toBe('top');
  });

  it('four clockwise turns give back the original clipboard', () => {
    const clip = {
      size: { x: 2, y: 1, z: 3 },
      blocks: [
        'minecraft:stone',
        norm('minecraft:oak_stairs[facing=north,half=bottom,shape=outer_left]'),
        'minecraft:air',
        'minecraft:dirt',
        norm('minecraft:oak_log[axis=x]'),
        'minecraft:glass'
      ]
    };
    let c = clip;
    for (let i = 0; i < 4; i++) c = transformClipboard(c, 'rotateCW');
    expect(c).toEqual(clip);
    const once = transformClipboard(clip, 'rotateCW');
    expect(once.size).toEqual({ x: 3, y: 1, z: 2 });
  });
});

describe('Selection clipboard editing', () => {
  it('copies and pastes without punching air holes, in one undo step', () => {
    const s = makeSession();
    const reg = s.getPrimaryRegion();
    setRegionBlock(reg, 0, 0, 0, 'minecraft:stone');
    setRegionBlock(reg, 1, 0, 0, 'minecraft:dirt');
    setRegionBlock(reg, 5, 0, 1, 'minecraft:gold_block');
    const clip = s.copyBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 });
    expect(clip.size).toEqual({ x: 2, y: 1, z: 2 });

    const res = s.pasteClipboard(clip, { x: 4, y: 0, z: 0 });
    expect(res.changed).toBe(2);
    expect(at(s, 4, 0, 0)).toBe('minecraft:stone');
    expect(at(s, 5, 0, 0)).toBe('minecraft:dirt');
    expect(at(s, 5, 0, 1)).toBe('minecraft:gold_block'); // clipboard air skipped
    s.undo();
    expect(at(s, 4, 0, 0)).toBe('minecraft:air');
  });

  it('pasting past the edge grows the canvas and reports the shift', () => {
    const s = makeSession({ x: 4, y: 2, z: 4 });
    setRegionBlock(s.getPrimaryRegion(), 0, 0, 0, 'minecraft:stone');
    const clip = s.copyBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const res = s.pasteClipboard(clip, { x: -2, y: 0, z: 5 });
    expect(res.shift).toEqual({ x: 2, y: 0, z: 0 });
    expect(s.getPrimaryRegion().size).toEqual({ x: 6, y: 2, z: 6 });
    expect(at(s, 0, 0, 5)).toBe('minecraft:stone');
    expect(at(s, 2, 0, 0)).toBe('minecraft:stone');
    expect(res.box).toEqual({ min: { x: 0, y: 0, z: 5 }, max: { x: 0, y: 0, z: 5 } });
    s.undo();
    expect(s.getPrimaryRegion().size).toEqual({ x: 4, y: 2, z: 4 });
  });

  it('moves a selection and leaves air behind', () => {
    const s = makeSession();
    setRegionBlock(s.getPrimaryRegion(), 1, 0, 1, 'minecraft:stone');
    setRegionBlock(s.getPrimaryRegion(), 2, 0, 1, 'minecraft:dirt');
    const res = s.moveBox({ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
    expect(at(s, 1, 0, 1)).toBe('minecraft:air');
    expect(at(s, 2, 0, 1)).toBe('minecraft:stone');
    expect(at(s, 3, 0, 1)).toBe('minecraft:dirt');
    expect(res.box).toEqual({ min: { x: 2, y: 0, z: 1 }, max: { x: 3, y: 0, z: 1 } });
    s.undo();
    expect(at(s, 1, 0, 1)).toBe('minecraft:stone');
    expect(at(s, 3, 0, 1)).toBe('minecraft:air');
  });

  it('rotates a selection in place, swapping its footprint and block facing', () => {
    const s = makeSession();
    const reg = s.getPrimaryRegion();
    // 3 wide (x) by 1 deep (z) wall of stairs facing north
    for (let x = 0; x < 3; x++) setRegionBlock(reg, x, 0, 0, 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
    setRegionBlock(reg, 0, 0, 0, 'minecraft:stone');
    const res = s.transformBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 'rotateCW');
    expect(res.box).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 2 } });
    expect(at(s, 0, 0, 0)).toBe('minecraft:stone');
    expect(props(at(s, 0, 0, 1)).facing).toBe('east');
    expect(at(s, 1, 0, 0)).toBe('minecraft:air');
    expect(s.peekUndoLabel()).toBe('Rotate Selection CW');
    s.undo();
    expect(props(at(s, 1, 0, 0)).facing).toBe('north');
  });
});
