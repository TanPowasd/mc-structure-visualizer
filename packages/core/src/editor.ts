import {
  AIR_BLOCK_STATE,
  type BlockEntityData,
  type BlockStateEntry,
  type StructureRegion,
  type UniversalStructureIR,
  type Vec3,
  formatBlockState,
  isAirBlock,
  normalizeNamespace,
  parseBlockStateString,
  voxelIndex
} from './types.js';
import { getRegionBlock, mergeRegionsToSingle, setRegionBlock } from './structure.js';

export interface VoxelChange {
  x: number;
  y: number;
  z: number;
  before: string;
  after: string;
}

/** A structural edit that changes region size (trim / expand). Undo swaps whole regions. */
export interface RegionSwap {
  before: StructureRegion;
  after: StructureRegion;
}

export interface EditTransaction {
  label: string;
  changes: VoxelChange[];
  swap?: RegionSwap;
}

export interface BoxRange {
  min: Vec3;
  max: Vec3;
}

export interface ReplaceOptions {
  /** Match the full block state (name + properties) instead of the block name only. */
  matchProperties?: boolean;
  /**
   * Carry over properties (facing, half, waterlogged…) from the old block when the
   * replacement belongs to the same shape family (stairs -> stairs, slab -> slab…).
   */
  keepProperties?: boolean;
  /** Restrict the replace to an inclusive box. */
  box?: BoxRange;
}

/** Shape families whose block-state properties are compatible between materials. */
const SHAPE_FAMILY_SUFFIXES = [
  '_stairs',
  '_slab',
  '_wall',
  '_fence_gate',
  '_fence',
  '_trapdoor',
  '_door',
  '_button',
  '_pressure_plate',
  '_wall_sign',
  '_hanging_sign',
  '_sign',
  '_pane',
  '_log',
  '_wood',
  '_stem',
  '_hyphae',
  '_pillar',
  '_carpet',
  '_bed',
  '_banner',
  '_candle'
];

export function shapeFamilyOf(blockName: string): string | null {
  const name = normalizeNamespace(blockName);
  if (name.endsWith('glass_pane') || name === 'minecraft:iron_bars') return '_pane';
  for (const suf of SHAPE_FAMILY_SUFFIXES) {
    if (name.endsWith(suf)) return suf;
  }
  return null;
}

/**
 * Builds the replacement state for one voxel. When `keepProperties` is on and both blocks
 * share a shape family (or are the same block), the old properties are kept and only the
 * properties explicitly given in the replacement override them.
 */
export function resolveReplacementState(
  current: BlockStateEntry,
  replacement: BlockStateEntry,
  keepProperties: boolean
): BlockStateEntry {
  if (!keepProperties) return replacement;
  const sameBlock = normalizeNamespace(current.name) === normalizeNamespace(replacement.name);
  const fam = shapeFamilyOf(current.name);
  const compatible = sameBlock || (fam !== null && fam === shapeFamilyOf(replacement.name));
  if (!compatible) return replacement;
  return {
    name: replacement.name,
    properties: { ...current.properties, ...replacement.properties }
  };
}

export function cloneRegion(reg: StructureRegion): StructureRegion {
  const blockEntities = new Map<string, BlockEntityData>();
  for (const [k, be] of reg.blockEntities) {
    blockEntities.set(k, { ...be, pos: { ...be.pos } });
  }
  return {
    name: reg.name,
    offset: { ...reg.offset },
    size: { ...reg.size },
    palette: reg.palette.map((p) => ({ name: p.name, properties: { ...p.properties } })),
    blocks: new Uint32Array(reg.blocks),
    blockEntities,
    entities: reg.entities.map((e) => ({ ...e }))
  };
}

/** Inclusive bounds of every non-air voxel, or null when the region is entirely air. */
export function computeSolidBounds(reg: StructureRegion): BoxRange | null {
  const airIdx = new Set<number>();
  reg.palette.forEach((p, i) => {
    if (isAirBlock(p.name)) airIdx.add(i);
  });
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const { x: sx, y: sy, z: sz } = reg.size;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const idx = reg.blocks[x + z * sx + y * sx * sz]!;
        if (airIdx.has(idx)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  if (minX === Infinity) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * Returns a new region with `lo` voxels added before and `hi` voxels added after each axis.
 * Negative values crop. Block entities and entities are shifted accordingly; anything that
 * falls outside is dropped.
 */
export function resizeRegion(reg: StructureRegion, lo: Vec3, hi: Vec3): StructureRegion {
  const size: Vec3 = {
    x: Math.max(1, reg.size.x + lo.x + hi.x),
    y: Math.max(1, reg.size.y + lo.y + hi.y),
    z: Math.max(1, reg.size.z + lo.z + hi.z)
  };
  const blocks = new Uint32Array(size.x * size.y * size.z);
  for (let y = 0; y < reg.size.y; y++) {
    const ny = y + lo.y;
    if (ny < 0 || ny >= size.y) continue;
    for (let z = 0; z < reg.size.z; z++) {
      const nz = z + lo.z;
      if (nz < 0 || nz >= size.z) continue;
      for (let x = 0; x < reg.size.x; x++) {
        const nx = x + lo.x;
        if (nx < 0 || nx >= size.x) continue;
        blocks[voxelIndex(nx, ny, nz, size)] = reg.blocks[voxelIndex(x, y, z, reg.size)]!;
      }
    }
  }
  const inside = (p: Vec3) =>
    p.x >= 0 && p.y >= 0 && p.z >= 0 && p.x < size.x && p.y < size.y && p.z < size.z;
  const blockEntities = new Map<string, BlockEntityData>();
  for (const [, be] of reg.blockEntities) {
    const pos = { x: be.pos.x + lo.x, y: be.pos.y + lo.y, z: be.pos.z + lo.z };
    if (inside(pos)) blockEntities.set(`${pos.x},${pos.y},${pos.z}`, { ...be, pos });
  }
  const entities = reg.entities
    .map((e) => ({
      ...e,
      pos: [e.pos[0] + lo.x, e.pos[1] + lo.y, e.pos[2] + lo.z] as [number, number, number],
      blockPos: { x: e.blockPos.x + lo.x, y: e.blockPos.y + lo.y, z: e.blockPos.z + lo.z }
    }))
    .filter((e) => inside(e.blockPos));
  return {
    name: reg.name,
    offset: { ...reg.offset },
    size,
    palette: reg.palette.map((p) => ({ name: p.name, properties: { ...p.properties } })),
    blocks,
    blockEntities,
    entities
  };
}

export interface BlockUsage {
  /** Block name without properties */
  name: string;
  count: number;
  /** Distinct full states seen for this block */
  states: string[];
}

/** Non-air block usage, most used first. */
export function countBlockUsage(reg: StructureRegion): BlockUsage[] {
  const perIdx = new Uint32Array(reg.palette.length);
  for (let i = 0; i < reg.blocks.length; i++) perIdx[reg.blocks[i]!]!++;
  const byName = new Map<string, BlockUsage>();
  reg.palette.forEach((p, i) => {
    const c = perIdx[i]!;
    if (c === 0 || isAirBlock(p.name)) return;
    const name = normalizeNamespace(p.name);
    const u = byName.get(name) ?? { name, count: 0, states: [] };
    u.count += c;
    const full = formatBlockState(p);
    if (!u.states.includes(full)) u.states.push(full);
    byName.set(name, u);
  });
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

function clampBox(reg: StructureRegion, from: Vec3, to: Vec3): BoxRange {
  return {
    min: {
      x: Math.max(0, Math.min(from.x, to.x)),
      y: Math.max(0, Math.min(from.y, to.y)),
      z: Math.max(0, Math.min(from.z, to.z))
    },
    max: {
      x: Math.min(reg.size.x - 1, Math.max(from.x, to.x)),
      y: Math.min(reg.size.y - 1, Math.max(from.y, to.y)),
      z: Math.min(reg.size.z - 1, Math.max(from.z, to.z))
    }
  };
}

export class VoxelEditorSession {
  private undoStack: EditTransaction[] = [];
  private redoStack: EditTransaction[] = [];
  private maxHistory = 64;

  constructor(private ir: UniversalStructureIR) {
    if (this.ir.regions.length !== 1) {
      this.ir.regions = [mergeRegionsToSingle(this.ir)];
    }
  }

  getStructure(): UniversalStructureIR {
    return this.ir;
  }

  getPrimaryRegion(): StructureRegion {
    if (this.ir.regions.length !== 1) {
      this.ir.regions = [mergeRegionsToSingle(this.ir)];
    }
    return this.ir.regions[0]!;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getHistoryCounts(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /** Label of the transaction that the next undo would revert. */
  peekUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  setBlock(x: number, y: number, z: number, state: BlockStateEntry | string, label = 'Set Block'): boolean {
    const reg = this.getPrimaryRegion();
    const prev = formatBlockState(getRegionBlock(reg, x, y, z));
    const nextEntry = typeof state === 'string' ? parseBlockStateString(state) : state;
    const next = formatBlockState(nextEntry);
    if (prev === next) return false;
    if (x < 0 || y < 0 || z < 0 || x >= reg.size.x || y >= reg.size.y || z >= reg.size.z) return false;

    setRegionBlock(reg, x, y, z, nextEntry);
    this.pushTransaction({
      label,
      changes: [{ x, y, z, before: prev, after: next }]
    });
    return true;
  }

  /**
   * Places a block like a player would. When the target lies just outside the canvas
   * (clicking an outer face), the canvas grows to fit it in the same undo step.
   * `shift` is how far existing blocks moved (non-zero when growing on -x/-y/-z),
   * so the view can follow.
   */
  placeBlock(
    pos: Vec3,
    state: BlockStateEntry | string,
    autoExpand = true
  ): { changed: boolean; shift: Vec3 } {
    const reg = this.getPrimaryRegion();
    const zero = { x: 0, y: 0, z: 0 };
    const inside =
      pos.x >= 0 && pos.y >= 0 && pos.z >= 0 && pos.x < reg.size.x && pos.y < reg.size.y && pos.z < reg.size.z;
    const entry = typeof state === 'string' ? parseBlockStateString(state) : state;
    if (inside) {
      return { changed: this.setBlock(pos.x, pos.y, pos.z, entry, `Place ${formatBlockState(entry)}`), shift: zero };
    }
    if (!autoExpand) return { changed: false, shift: zero };
    const lo: Vec3 = { x: Math.max(0, -pos.x), y: Math.max(0, -pos.y), z: Math.max(0, -pos.z) };
    const hi: Vec3 = {
      x: Math.max(0, pos.x - (reg.size.x - 1)),
      y: Math.max(0, pos.y - (reg.size.y - 1)),
      z: Math.max(0, pos.z - (reg.size.z - 1))
    };
    // Only grow by a few blocks per click; anything further is a stray ray.
    if ([lo.x, lo.y, lo.z, hi.x, hi.y, hi.z].some((v) => v > 4)) return { changed: false, shift: zero };
    const before = cloneRegion(reg);
    const after = resizeRegion(before, lo, hi);
    setRegionBlock(after, pos.x + lo.x, pos.y + lo.y, pos.z + lo.z, entry);
    this.ir.regions = [cloneRegion(after)];
    this.pushTransaction({ label: `Place ${formatBlockState(entry)} (grow canvas)`, changes: [], swap: { before, after } });
    return { changed: true, shift: lo };
  }

  fillBox(from: Vec3, to: Vec3, state: BlockStateEntry | string, label = 'Fill Box'): number {
    const reg = this.getPrimaryRegion();
    const { min, max } = clampBox(reg, from, to);
    const nextEntry = typeof state === 'string' ? parseBlockStateString(state) : state;
    const next = formatBlockState(nextEntry);
    const changes: VoxelChange[] = [];

    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) {
          const prev = formatBlockState(getRegionBlock(reg, x, y, z));
          if (prev !== next) {
            setRegionBlock(reg, x, y, z, nextEntry);
            changes.push({ x, y, z, before: prev, after: next });
          }
        }
      }
    }

    if (changes.length > 0) {
      this.pushTransaction({ label, changes });
    }
    return changes.length;
  }

  /** Hollow box: only the six faces of the box are filled. */
  outlineBox(from: Vec3, to: Vec3, state: BlockStateEntry | string, label = 'Walls'): number {
    const reg = this.getPrimaryRegion();
    const { min, max } = clampBox(reg, from, to);
    const nextEntry = typeof state === 'string' ? parseBlockStateString(state) : state;
    const next = formatBlockState(nextEntry);
    const changes: VoxelChange[] = [];
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) {
          const onFace =
            x === min.x || x === max.x || y === min.y || y === max.y || z === min.z || z === max.z;
          if (!onFace) continue;
          const prev = formatBlockState(getRegionBlock(reg, x, y, z));
          if (prev !== next) {
            setRegionBlock(reg, x, y, z, nextEntry);
            changes.push({ x, y, z, before: prev, after: next });
          }
        }
      }
    }
    if (changes.length > 0) this.pushTransaction({ label, changes });
    return changes.length;
  }

  clearBox(from: Vec3, to: Vec3): number {
    return this.fillBox(from, to, AIR_BLOCK_STATE, 'Clear Box');
  }

  replaceBlock(
    matchBlockNameOrState: string,
    replacementState: string,
    matchPropertiesOrOptions: boolean | ReplaceOptions = false
  ): number {
    const opts: ReplaceOptions =
      typeof matchPropertiesOrOptions === 'boolean'
        ? { matchProperties: matchPropertiesOrOptions }
        : matchPropertiesOrOptions;
    const reg = this.getPrimaryRegion();
    const matchParsed = parseBlockStateString(matchBlockNameOrState);
    const matchFull = formatBlockState(matchParsed);
    const replEntry = parseBlockStateString(replacementState);
    const changes: VoxelChange[] = [];
    const box = opts.box
      ? clampBox(reg, opts.box.min, opts.box.max)
      : { min: { x: 0, y: 0, z: 0 }, max: { x: reg.size.x - 1, y: reg.size.y - 1, z: reg.size.z - 1 } };

    for (let y = box.min.y; y <= box.max.y; y++) {
      for (let z = box.min.z; z <= box.max.z; z++) {
        for (let x = box.min.x; x <= box.max.x; x++) {
          const cur = getRegionBlock(reg, x, y, z);
          const curFull = formatBlockState(cur);
          const hit = opts.matchProperties ? curFull === matchFull : cur.name === matchParsed.name;
          if (!hit) continue;
          const nextEntry = resolveReplacementState(cur, replEntry, !!opts.keepProperties);
          const nextFull = formatBlockState(nextEntry);
          if (curFull !== nextFull) {
            setRegionBlock(reg, x, y, z, nextEntry);
            changes.push({ x, y, z, before: curFull, after: nextFull });
          }
        }
      }
    }

    if (changes.length > 0) {
      this.pushTransaction({
        label: `Replace ${matchBlockNameOrState} -> ${replacementState}`,
        changes
      });
    }
    return changes.length;
  }

  /**
   * Flood-fill replace: swaps the clicked block and every face-connected block with the
   * same name (like a magic wand). `limit` guards against runaway fills on huge builds.
   */
  replaceConnected(
    start: Vec3,
    replacementState: string,
    keepProperties = true,
    limit = 200_000
  ): number {
    const reg = this.getPrimaryRegion();
    const seed = getRegionBlock(reg, start.x, start.y, start.z);
    if (isAirBlock(seed.name)) return 0;
    const replEntry = parseBlockStateString(replacementState);
    const { x: sx, y: sy, z: sz } = reg.size;
    const visited = new Uint8Array(sx * sy * sz);
    const stack: number[] = [voxelIndex(start.x, start.y, start.z, reg.size)];
    const changes: VoxelChange[] = [];
    const seedName = normalizeNamespace(seed.name);

    while (stack.length > 0 && changes.length < limit) {
      const idx = stack.pop()!;
      if (visited[idx]) continue;
      visited[idx] = 1;
      const x = idx % sx;
      const z = Math.floor(idx / sx) % sz;
      const y = Math.floor(idx / (sx * sz));
      const cur = getRegionBlock(reg, x, y, z);
      if (normalizeNamespace(cur.name) !== seedName) continue;
      const curFull = formatBlockState(cur);
      const nextEntry = resolveReplacementState(cur, replEntry, keepProperties);
      const nextFull = formatBlockState(nextEntry);
      if (curFull !== nextFull) {
        setRegionBlock(reg, x, y, z, nextEntry);
        changes.push({ x, y, z, before: curFull, after: nextFull });
      }
      if (x > 0) stack.push(idx - 1);
      if (x < sx - 1) stack.push(idx + 1);
      if (z > 0) stack.push(idx - sx);
      if (z < sz - 1) stack.push(idx + sx);
      if (y > 0) stack.push(idx - sx * sz);
      if (y < sy - 1) stack.push(idx + sx * sz);
    }

    if (changes.length > 0) {
      this.pushTransaction({ label: `Replace connected ${seedName} -> ${replacementState}`, changes });
    }
    return changes.length;
  }

  /** Rewrites one air variant into another (e.g. cave_air -> air, air -> structure_void). */
  convertAir(from: string[], to: string, label: string): number {
    const reg = this.getPrimaryRegion();
    const fromSet = new Set(from.map(normalizeNamespace));
    const toEntry = parseBlockStateString(to);
    const toFull = formatBlockState(toEntry);
    const changes: VoxelChange[] = [];
    for (let y = 0; y < reg.size.y; y++) {
      for (let z = 0; z < reg.size.z; z++) {
        for (let x = 0; x < reg.size.x; x++) {
          const cur = getRegionBlock(reg, x, y, z);
          if (!fromSet.has(normalizeNamespace(cur.name))) continue;
          const curFull = formatBlockState(cur);
          if (curFull === toFull) continue;
          setRegionBlock(reg, x, y, z, toEntry);
          changes.push({ x, y, z, before: curFull, after: toFull });
        }
      }
    }
    if (changes.length > 0) this.pushTransaction({ label, changes });
    return changes.length;
  }

  /** Crops away empty air layers around the build. Returns the new size, or null if nothing changed. */
  trimAir(padding = 0): Vec3 | null {
    const reg = this.getPrimaryRegion();
    const solid = computeSolidBounds(reg);
    if (!solid) return null;
    const lo: Vec3 = {
      x: -Math.max(0, solid.min.x - padding),
      y: -Math.max(0, solid.min.y - padding),
      z: -Math.max(0, solid.min.z - padding)
    };
    const hi: Vec3 = {
      x: -Math.max(0, reg.size.x - 1 - solid.max.x - padding),
      y: -Math.max(0, reg.size.y - 1 - solid.max.y - padding),
      z: -Math.max(0, reg.size.z - 1 - solid.max.z - padding)
    };
    if (lo.x === 0 && lo.y === 0 && lo.z === 0 && hi.x === 0 && hi.y === 0 && hi.z === 0) return null;
    return this.applyResize(lo, hi, 'Trim Air');
  }

  /** Grows (or with negative values, shrinks) the editable canvas around the build. */
  expandCanvas(lo: Vec3, hi: Vec3, label = 'Expand Canvas'): Vec3 | null {
    if ([lo.x, lo.y, lo.z, hi.x, hi.y, hi.z].every((v) => v === 0)) return null;
    return this.applyResize(lo, hi, label);
  }

  undo(): EditTransaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    if (tx.swap) {
      this.ir.regions = [cloneRegion(tx.swap.before)];
    } else {
      const reg = this.getPrimaryRegion();
      for (let i = tx.changes.length - 1; i >= 0; i--) {
        const ch = tx.changes[i]!;
        setRegionBlock(reg, ch.x, ch.y, ch.z, ch.before);
      }
    }
    this.redoStack.push(tx);
    return tx;
  }

  redo(): EditTransaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    if (tx.swap) {
      this.ir.regions = [cloneRegion(tx.swap.after)];
    } else {
      const reg = this.getPrimaryRegion();
      for (const ch of tx.changes) {
        setRegionBlock(reg, ch.x, ch.y, ch.z, ch.after);
      }
    }
    this.undoStack.push(tx);
    return tx;
  }

  private applyResize(lo: Vec3, hi: Vec3, label: string): Vec3 {
    const before = cloneRegion(this.getPrimaryRegion());
    const after = resizeRegion(before, lo, hi);
    this.ir.regions = [cloneRegion(after)];
    this.pushTransaction({ label, changes: [], swap: { before, after } });
    return { ...after.size };
  }

  private pushTransaction(tx: EditTransaction): void {
    this.undoStack.push(tx);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }
}

const HORIZONTAL_ROTATE_CW: Record<string, string> = {
  north: 'east',
  east: 'south',
  south: 'west',
  west: 'north'
};

export function rotateStructureY90(ir: UniversalStructureIR): UniversalStructureIR {
  const src = mergeRegionsToSingle(ir);
  const newSize: Vec3 = { x: src.size.z, y: src.size.y, z: src.size.x };
  const newBlocks = new Uint32Array(newSize.x * newSize.y * newSize.z);
  const rotatedPalette = src.palette.map((st) => {
    const props = { ...st.properties };
    if (props.facing && HORIZONTAL_ROTATE_CW[props.facing]) {
      props.facing = HORIZONTAL_ROTATE_CW[props.facing]!;
    }
    if (props.axis === 'x') props.axis = 'z';
    else if (props.axis === 'z') props.axis = 'x';
    if ('north' in props || 'east' in props || 'south' in props || 'west' in props) {
      const n = props.north,
        e = props.east,
        s = props.south,
        w = props.west;
      if (w !== undefined) props.north = w;
      if (n !== undefined) props.east = n;
      if (e !== undefined) props.south = e;
      if (s !== undefined) props.west = s;
    }
    return { name: st.name, properties: props };
  });

  for (let y = 0; y < src.size.y; y++) {
    for (let z = 0; z < src.size.z; z++) {
      for (let x = 0; x < src.size.x; x++) {
        const nx = src.size.z - 1 - z;
        const nz = x;
        newBlocks[voxelIndex(nx, y, nz, newSize)] = src.blocks[voxelIndex(x, y, z, src.size)]!;
      }
    }
  }

  const newBlockEntities = new Map();
  for (const [, be] of src.blockEntities) {
    const nx = src.size.z - 1 - be.pos.z;
    const nz = be.pos.x;
    newBlockEntities.set(`${nx},${be.pos.y},${nz}`, {
      ...be,
      pos: { x: nx, y: be.pos.y, z: nz }
    });
  }

  return {
    ...ir,
    regions: [
      {
        name: src.name,
        offset: { x: 0, y: 0, z: 0 },
        size: newSize,
        palette: rotatedPalette,
        blocks: newBlocks,
        blockEntities: newBlockEntities,
        entities: []
      }
    ]
  };
}
