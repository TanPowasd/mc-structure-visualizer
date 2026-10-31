import {
  type BlockStateEntry,
  type StructureRegion,
  type UniversalStructureIR,
  type Vec3,
  formatBlockState,
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

export interface EditTransaction {
  label: string;
  changes: VoxelChange[];
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

  setBlock(x: number, y: number, z: number, state: BlockStateEntry | string, label = 'Set Block'): boolean {
    const reg = this.getPrimaryRegion();
    const prev = formatBlockState(getRegionBlock(reg, x, y, z));
    const nextEntry = typeof state === 'string' ? parseBlockStateString(state) : state;
    const next = formatBlockState(nextEntry);
    if (prev === next) return false;

    setRegionBlock(reg, x, y, z, nextEntry);
    this.pushTransaction({
      label,
      changes: [{ x, y, z, before: prev, after: next }]
    });
    return true;
  }

  fillBox(from: Vec3, to: Vec3, state: BlockStateEntry | string, label = 'Fill Box'): number {
    const reg = this.getPrimaryRegion();
    const minX = Math.max(0, Math.min(from.x, to.x));
    const minY = Math.max(0, Math.min(from.y, to.y));
    const minZ = Math.max(0, Math.min(from.z, to.z));
    const maxX = Math.min(reg.size.x - 1, Math.max(from.x, to.x));
    const maxY = Math.min(reg.size.y - 1, Math.max(from.y, to.y));
    const maxZ = Math.min(reg.size.z - 1, Math.max(from.z, to.z));

    const nextEntry = typeof state === 'string' ? parseBlockStateString(state) : state;
    const next = formatBlockState(nextEntry);
    const changes: VoxelChange[] = [];

    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
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

  replaceBlock(
    matchBlockNameOrState: string,
    replacementState: string,
    matchProperties = false
  ): number {
    const reg = this.getPrimaryRegion();
    const matchParsed = parseBlockStateString(matchBlockNameOrState);
    const matchFull = formatBlockState(matchParsed);
    const replEntry = parseBlockStateString(replacementState);
    const replFull = formatBlockState(replEntry);
    const changes: VoxelChange[] = [];

    for (let y = 0; y < reg.size.y; y++) {
      for (let z = 0; z < reg.size.z; z++) {
        for (let x = 0; x < reg.size.x; x++) {
          const cur = getRegionBlock(reg, x, y, z);
          const curFull = formatBlockState(cur);
          const hit = matchProperties ? curFull === matchFull : cur.name === matchParsed.name;
          if (hit && curFull !== replFull) {
            setRegionBlock(reg, x, y, z, replEntry);
            changes.push({ x, y, z, before: curFull, after: replFull });
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

  undo(): EditTransaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    const reg = this.getPrimaryRegion();
    for (let i = tx.changes.length - 1; i >= 0; i--) {
      const ch = tx.changes[i]!;
      setRegionBlock(reg, ch.x, ch.y, ch.z, ch.before);
    }
    this.redoStack.push(tx);
    return tx;
  }

  redo(): EditTransaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    const reg = this.getPrimaryRegion();
    for (const ch of tx.changes) {
      setRegionBlock(reg, ch.x, ch.y, ch.z, ch.after);
    }
    this.undoStack.push(tx);
    return tx;
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
