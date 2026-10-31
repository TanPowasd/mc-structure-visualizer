import {
  type BlockStateEntry,
  type Vec3,
  formatBlockState,
  isAirBlock,
  parseBlockStateString,
  voxelIndex
} from './types.js';

/**
 * A copied block of voxels, independent of any structure. `blocks` holds full block-state
 * strings in voxelIndex order (x fastest, then z, then y).
 */
export interface BlockClipboard {
  size: Vec3;
  blocks: string[];
}

/** Rotations are around the vertical axis as seen from above; mirrors flip one axis. */
export type ClipboardTransform = 'rotateCW' | 'rotateCCW' | 'rotate180' | 'mirrorX' | 'mirrorZ' | 'flipY';

const CW: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const MIRROR_X: Record<string, string> = { east: 'west', west: 'east' };
const MIRROR_Z: Record<string, string> = { north: 'south', south: 'north' };
const FLIP_Y: Record<string, string> = { up: 'down', down: 'up' };
const HAND_SWAP: Record<string, string> = {
  left: 'right',
  right: 'left',
  inner_left: 'inner_right',
  inner_right: 'inner_left',
  outer_left: 'outer_right',
  outer_right: 'outer_left'
};
const RAIL_CW: Record<string, string> = {
  north_south: 'east_west',
  east_west: 'north_south',
  ascending_north: 'ascending_east',
  ascending_east: 'ascending_south',
  ascending_south: 'ascending_west',
  ascending_west: 'ascending_north',
  north_east: 'south_east',
  south_east: 'south_west',
  south_west: 'north_west',
  north_west: 'north_east'
};

/** Rewrites every direction word inside a rail shape (north_east, ascending_west…). */
function mapRailShape(shape: string, dirs: Record<string, string>): string {
  const mapped = shape
    .split('_')
    .map((part) => dirs[part] ?? part)
    .join('_');
  // Curved shapes are always written north/south first
  const m = /^(east|west)_(north|south)$/.exec(mapped);
  return m ? `${m[2]}_${m[1]}` : mapped;
}

/** Swaps the values of two properties that both exist (east <-> west connections…). */
function swapProps(p: Record<string, string>, a: string, b: string): void {
  const va = p[a];
  const vb = p[b];
  if (va === undefined && vb === undefined) return;
  if (vb !== undefined) p[a] = vb;
  else delete p[a];
  if (va !== undefined) p[b] = va;
  else delete p[b];
}

function isRailLike(name: string): boolean {
  return /(^|:)(rail|powered_rail|detector_rail|activator_rail)$/.test(name);
}

function rotateCW(entry: BlockStateEntry): BlockStateEntry {
  const p = { ...entry.properties };
  if (p.facing && CW[p.facing]) p.facing = CW[p.facing]!;
  if (p.horizontal_facing && CW[p.horizontal_facing]) p.horizontal_facing = CW[p.horizontal_facing]!;
  if (p.axis === 'x') p.axis = 'z';
  else if (p.axis === 'z') p.axis = 'x';
  if (p.rotation !== undefined && /^\d+$/.test(p.rotation)) p.rotation = String((Number(p.rotation) + 4) % 16);
  if (p.shape && isRailLike(entry.name) && RAIL_CW[p.shape]) p.shape = RAIL_CW[p.shape]!;
  if ('north' in p || 'east' in p || 'south' in p || 'west' in p) {
    const { north: n, east: e, south: s, west: w } = p;
    delete p.north;
    delete p.east;
    delete p.south;
    delete p.west;
    if (w !== undefined) p.north = w;
    if (n !== undefined) p.east = n;
    if (e !== undefined) p.south = e;
    if (s !== undefined) p.west = s;
  }
  return { name: entry.name, properties: p };
}

function mirror(entry: BlockStateEntry, axis: 'x' | 'z'): BlockStateEntry {
  const p = { ...entry.properties };
  const dirs = axis === 'x' ? MIRROR_X : MIRROR_Z;
  if (p.facing && dirs[p.facing]) p.facing = dirs[p.facing]!;
  if (p.horizontal_facing && dirs[p.horizontal_facing]) p.horizontal_facing = dirs[p.horizontal_facing]!;
  if (axis === 'x') swapProps(p, 'east', 'west');
  else swapProps(p, 'north', 'south');
  if (p.rotation !== undefined && /^\d+$/.test(p.rotation)) {
    const r = Number(p.rotation);
    p.rotation = String(axis === 'x' ? (16 - r) % 16 : (24 - r) % 16);
  }
  // A reflection flips handedness: stair corners and door hinges swap sides
  if (p.shape) {
    if (isRailLike(entry.name)) p.shape = mapRailShape(p.shape, dirs);
    else if (HAND_SWAP[p.shape]) p.shape = HAND_SWAP[p.shape]!;
  }
  if (p.hinge && HAND_SWAP[p.hinge]) p.hinge = HAND_SWAP[p.hinge]!;
  return { name: entry.name, properties: p };
}

function flipY(entry: BlockStateEntry): BlockStateEntry {
  const p = { ...entry.properties };
  if (p.facing && FLIP_Y[p.facing]) p.facing = FLIP_Y[p.facing]!;
  if (p.half === 'top') p.half = 'bottom';
  else if (p.half === 'bottom') p.half = 'top';
  else if (p.half === 'upper') p.half = 'lower';
  else if (p.half === 'lower') p.half = 'upper';
  if (p.type === 'top') p.type = 'bottom';
  else if (p.type === 'bottom') p.type = 'top';
  if (p.face === 'floor') p.face = 'ceiling';
  else if (p.face === 'ceiling') p.face = 'floor';
  if (p.attachment === 'floor') p.attachment = 'ceiling';
  else if (p.attachment === 'ceiling') p.attachment = 'floor';
  if (/lantern$/.test(entry.name) && p.hanging !== undefined) p.hanging = p.hanging === 'true' ? 'false' : 'true';
  return { name: entry.name, properties: p };
}

/** Applies a transform to one block state so it still looks right after the voxels move. */
export function transformBlockState(state: string, op: ClipboardTransform): string {
  const entry = parseBlockStateString(state);
  if (isAirBlock(entry.name) || Object.keys(entry.properties).length === 0) return state;
  let out: BlockStateEntry;
  switch (op) {
    case 'rotateCW':
      out = rotateCW(entry);
      break;
    case 'rotate180':
      out = rotateCW(rotateCW(entry));
      break;
    case 'rotateCCW':
      out = rotateCW(rotateCW(rotateCW(entry)));
      break;
    case 'mirrorX':
      out = mirror(entry, 'x');
      break;
    case 'mirrorZ':
      out = mirror(entry, 'z');
      break;
    case 'flipY':
      out = flipY(entry);
      break;
  }
  return formatBlockState(out);
}

/** Returns a new clipboard with voxels moved and block states rewritten to match. */
export function transformClipboard(clip: BlockClipboard, op: ClipboardTransform): BlockClipboard {
  if (op === 'rotateCCW') return transformClipboard(transformClipboard(clip, 'rotate180'), 'rotateCW');
  if (op === 'rotate180') return transformClipboard(transformClipboard(clip, 'rotateCW'), 'rotateCW');
  const { x: sx, y: sy, z: sz } = clip.size;
  const size: Vec3 = op === 'rotateCW' ? { x: sz, y: sy, z: sx } : { ...clip.size };
  const blocks = new Array<string>(size.x * size.y * size.z);
  const cache = new Map<string, string>();
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        let nx = x;
        let ny = y;
        let nz = z;
        if (op === 'rotateCW') {
          nx = sz - 1 - z;
          nz = x;
        } else if (op === 'mirrorX') nx = sx - 1 - x;
        else if (op === 'mirrorZ') nz = sz - 1 - z;
        else if (op === 'flipY') ny = sy - 1 - y;
        const src = clip.blocks[voxelIndex(x, y, z, clip.size)]!;
        let out = cache.get(src);
        if (out === undefined) {
          out = transformBlockState(src, op);
          cache.set(src, out);
        }
        blocks[voxelIndex(nx, ny, nz, size)] = out;
      }
    }
  }
  return { size, blocks };
}

/** Number of non-air voxels, for status text. */
export function countClipboardBlocks(clip: BlockClipboard): number {
  const cache = new Map<string, boolean>();
  let n = 0;
  for (const b of clip.blocks) {
    let air = cache.get(b);
    if (air === undefined) {
      air = isAirBlock(parseBlockStateString(b).name);
      cache.set(b, air);
    }
    if (!air) n++;
  }
  return n;
}
