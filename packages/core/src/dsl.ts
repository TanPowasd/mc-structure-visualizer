import {
  DATA_VERSION_1_20_1,
  DATA_VERSION_1_21_11,
  type BlockStateEntry,
  formatBlockState,
  isAirBlock,
  normalizeNamespace,
  parseBlockStateString,
  type UniversalStructureIR,
  type Vec3
} from './types.js';
import { createEmptyStructure, extractModNamespaces, setRegionBlock } from './structure.js';
import type { NbtCompound } from './nbt-types.js';

interface PendingVoxel {
  state: BlockStateEntry;
  nbt?: NbtCompound;
}

const MAX_SAFE_DIM = 512;

export class StructureBuilder {
  private name: string;
  private mcVersion: string;
  private minSize: Vec3;
  private voxels = new Map<string, PendingVoxel>();
  private maxCoord: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(name: string, size: Vec3 = { x: 16, y: 16, z: 16 }, mcVersion = '1.21.11') {
    this.name = name || 'AI_Structure';
    this.mcVersion = mcVersion;
    this.minSize = {
      x: Math.max(1, Math.min(MAX_SAFE_DIM, Math.ceil(size.x || 1))),
      y: Math.max(1, Math.min(MAX_SAFE_DIM, Math.ceil(size.y || 1))),
      z: Math.max(1, Math.min(MAX_SAFE_DIM, Math.ceil(size.z || 1)))
    };
    this.maxCoord = {
      x: this.minSize.x - 1,
      y: this.minSize.y - 1,
      z: this.minSize.z - 1
    };
  }

  static fromExisting(base: UniversalStructureIR, newName?: string): StructureBuilder {
    const reg = base.regions[0];
    const size = reg ? { ...reg.size } : { x: 16, y: 16, z: 16 };
    const builder = new StructureBuilder(newName || base.name, size, base.mcVersion);
    for (const r of base.regions) {
      for (let y = 0; y < r.size.y; y++) {
        for (let z = 0; z < r.size.z; z++) {
          for (let x = 0; x < r.size.x; x++) {
            const idx = r.blocks[x + z * r.size.x + y * r.size.x * r.size.z]!;
            if (idx === 0) continue;
            const st = r.palette[idx];
            if (!st || isAirBlock(st.name)) continue;
            const be = r.blockEntities.get(`${x},${y},${z}`);
            builder.set(
              r.offset.x + x,
              r.offset.y + y,
              r.offset.z + z,
              { name: st.name, properties: { ...st.properties } },
              be?.nbt
            );
          }
        }
      }
    }
    return builder;
  }

  private toEntry(blockState: string | BlockStateEntry): BlockStateEntry {
    return typeof blockState === 'string' ? parseBlockStateString(blockState) : blockState;
  }

  set(
    x: number,
    y: number,
    z: number,
    blockState: string | BlockStateEntry,
    nbt?: NbtCompound
  ): this {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    if (
      ix < 0 ||
      iy < 0 ||
      iz < 0 ||
      ix >= MAX_SAFE_DIM ||
      iy >= MAX_SAFE_DIM ||
      iz >= MAX_SAFE_DIM
    ) {
      return this;
    }
    const entry = this.toEntry(blockState);
    const key = `${ix},${iy},${iz}`;
    if (isAirBlock(entry.name)) {
      this.voxels.delete(key);
      return this;
    }
    this.voxels.set(key, { state: entry, nbt });
    if (ix > this.maxCoord.x) this.maxCoord.x = ix;
    if (iy > this.maxCoord.y) this.maxCoord.y = iy;
    if (iz > this.maxCoord.z) this.maxCoord.z = iz;
    return this;
  }

  get(x: number, y: number, z: number): string {
    const v = this.voxels.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
    return v ? formatBlockState(v.state) : 'minecraft:air';
  }

  clear(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): this {
    return this.fill(x1, y1, z1, x2, y2, z2, 'minecraft:air');
  }

  fill(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    blockState: string | BlockStateEntry
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minY = Math.floor(Math.min(y1, y2)),
      maxY = Math.floor(Math.max(y1, y2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const entry = this.toEntry(blockState);
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          this.set(x, y, z, entry);
        }
      }
    }
    return this;
  }

  hollowBox(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    wallState: string | BlockStateEntry
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minY = Math.floor(Math.min(y1, y2)),
      maxY = Math.floor(Math.max(y1, y2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const entry = this.toEntry(wallState);
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (
            x === minX ||
            x === maxX ||
            y === minY ||
            y === maxY ||
            z === minZ ||
            z === maxZ
          ) {
            this.set(x, y, z, entry);
          }
        }
      }
    }
    return this;
  }

  /** Builds 4 vertical perimeter walls without floor or ceiling */
  walls(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    wallState: string | BlockStateEntry
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minY = Math.floor(Math.min(y1, y2)),
      maxY = Math.floor(Math.max(y1, y2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const entry = this.toEntry(wallState);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        this.set(x, y, minZ, entry);
        this.set(x, y, maxZ, entry);
      }
      for (let z = minZ; z <= maxZ; z++) {
        this.set(minX, y, z, entry);
        this.set(maxX, y, z, entry);
      }
    }
    return this;
  }

  line(from: Vec3, to: Vec3, blockState: string | BlockStateEntry): this {
    const steps = Math.max(
      1,
      Math.abs(to.x - from.x),
      Math.abs(to.y - from.y),
      Math.abs(to.z - from.z)
    );
    const entry = this.toEntry(blockState);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.set(
        Math.round(from.x + (to.x - from.x) * t),
        Math.round(from.y + (to.y - from.y) * t),
        Math.round(from.z + (to.z - from.z) * t),
        entry
      );
    }
    return this;
  }

  cylinder(
    cx: number,
    yStart: number,
    cz: number,
    radius: number,
    height: number,
    blockState: string | BlockStateEntry,
    hollow = false
  ): this {
    const r = Math.max(0.5, radius);
    const r2 = r * r;
    const innerR2 = Math.max(0, (r - 1) * (r - 1));
    const entry = this.toEntry(blockState);
    const minX = Math.floor(cx - r),
      maxX = Math.ceil(cx + r);
    const minZ = Math.floor(cz - r),
      maxZ = Math.ceil(cz + r);
    for (let dy = 0; dy < height; dy++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const dist2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
          if (dist2 <= r2 && (!hollow || dist2 >= innerR2)) {
            this.set(x, yStart + dy, z, entry);
          }
        }
      }
    }
    return this;
  }

  sphere(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    blockState: string | BlockStateEntry,
    hollow = false
  ): this {
    const r = Math.max(0.5, radius);
    const r2 = r * r;
    const innerR2 = Math.max(0, (r - 1) * (r - 1));
    const entry = this.toEntry(blockState);
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
          if (d2 <= r2 && (!hollow || d2 >= innerR2)) {
            this.set(x, y, z, entry);
          }
        }
      }
    }
    return this;
  }

  dome(
    cx: number,
    cyBase: number,
    cz: number,
    radius: number,
    blockState: string | BlockStateEntry
  ): this {
    const r = Math.max(1, radius);
    const r2 = r * r;
    const innerR2 = Math.max(0, (r - 1.15) ** 2);
    const entry = this.toEntry(blockState);
    for (let y = Math.floor(cyBase); y <= Math.ceil(cyBase + r); y++) {
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const d2 = (x - cx) ** 2 + (y - cyBase) ** 2 + (z - cz) ** 2;
          if (d2 <= r2 && d2 >= innerR2) {
            this.set(x, y, z, entry);
          }
        }
      }
    }
    return this;
  }

  /**
   * Builds a classic pitched gable roof along `axis` ('x' = ridge runs East-West, 'z' = ridge runs North-South)
   * with properly oriented stair facings!
   */
  gableRoof(
    x1: number,
    yBase: number,
    z1: number,
    x2: number,
    z2: number,
    axis: 'x' | 'z',
    stairBlockId: string,
    slabOrRidgeState?: string
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const baseStair = normalizeNamespace(stairBlockId.split('[')[0]!);
    const ridge = slabOrRidgeState || baseStair.replace(/_stairs$/, '_slab');

    if (axis === 'z') {
      let left = minX;
      let right = maxX;
      let y = Math.floor(yBase);
      while (left <= right) {
        if (left === right) {
          this.fill(left, y, minZ, right, y, maxZ, ridge);
        } else {
          this.fill(left, y, minZ, left, y, maxZ, `${baseStair}[facing=east,half=bottom]`);
          this.fill(right, y, minZ, right, y, maxZ, `${baseStair}[facing=west,half=bottom]`);
        }
        left++;
        right--;
        y++;
      }
    } else {
      let front = minZ;
      let back = maxZ;
      let y = Math.floor(yBase);
      while (front <= back) {
        if (front === back) {
          this.fill(minX, y, front, maxX, y, back, ridge);
        } else {
          this.fill(minX, y, front, maxX, y, front, `${baseStair}[facing=south,half=bottom]`);
          this.fill(minX, y, back, maxX, y, back, `${baseStair}[facing=north,half=bottom]`);
        }
        front++;
        back--;
        y++;
      }
    }
    return this;
  }

  /**
   * Builds a 4-sided pyramid / hipped roof with properly oriented stairs on all 4 sides!
   */
  pyramidRoof(
    x1: number,
    yBase: number,
    z1: number,
    x2: number,
    z2: number,
    stairBlockId: string,
    capBlockState?: string
  ): this {
    let minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    let minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    let y = Math.floor(yBase);
    const baseStair = normalizeNamespace(stairBlockId.split('[')[0]!);
    const cap = capBlockState || baseStair.replace(/_stairs$/, '_slab');

    while (minX <= maxX && minZ <= maxZ) {
      if (minX === maxX || minZ === maxZ) {
        this.fill(minX, y, minZ, maxX, y, maxZ, cap);
        break;
      }
      for (let x = minX; x <= maxX; x++) {
        this.set(x, y, minZ, `${baseStair}[facing=south,half=bottom]`);
        this.set(x, y, maxZ, `${baseStair}[facing=north,half=bottom]`);
      }
      for (let z = minZ + 1; z <= maxZ - 1; z++) {
        this.set(minX, y, z, `${baseStair}[facing=east,half=bottom]`);
        this.set(maxX, y, z, `${baseStair}[facing=west,half=bottom]`);
      }
      minX++;
      maxX--;
      minZ++;
      maxZ--;
      y++;
    }
    return this;
  }

  pillarGrid(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    stepX: number,
    stepZ: number,
    pillarState: string | BlockStateEntry
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const sx = Math.max(1, Math.floor(stepX));
    const sz = Math.max(1, Math.floor(stepZ));
    for (let z = minZ; z <= maxZ; z += sz) {
      for (let x = minX; x <= maxX; x += sx) {
        this.fill(x, y1, z, x, y2, z, pillarState);
      }
    }
    return this;
  }

  checkerboard(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    stateA: string | BlockStateEntry,
    stateB: string | BlockStateEntry
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minY = Math.floor(Math.min(y1, y2)),
      maxY = Math.floor(Math.max(y1, y2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const a = this.toEntry(stateA);
    const b = this.toEntry(stateB);
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          this.set(x, y, z, (x + y + z) % 2 === 0 ? a : b);
        }
      }
    }
    return this;
  }

  windowWall(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    wallState: string | BlockStateEntry,
    windowState: string | BlockStateEntry,
    spacing = 3
  ): this {
    const minX = Math.floor(Math.min(x1, x2)),
      maxX = Math.floor(Math.max(x1, x2));
    const minY = Math.floor(Math.min(y1, y2)),
      maxY = Math.floor(Math.max(y1, y2));
    const minZ = Math.floor(Math.min(z1, z2)),
      maxZ = Math.floor(Math.max(z1, z2));
    const wEntry = this.toEntry(wallState);
    const gEntry = this.toEntry(windowState);
    const period = Math.max(2, Math.floor(spacing));
    for (let y = minY; y <= maxY; y++) {
      const isWindowRow = y > minY && y < maxY;
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const horizIdx = maxX - minX >= maxZ - minZ ? x - minX : z - minZ;
          const isEdge =
            (maxX > minX && (x === minX || x === maxX)) ||
            (maxZ > minZ && (z === minZ || z === maxZ));
          const isGlass = isWindowRow && !isEdge && horizIdx % period === Math.floor(period / 2);
          this.set(x, y, z, isGlass ? gEntry : wEntry);
        }
      }
    }
    return this;
  }

  arch(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    blockState: string | BlockStateEntry
  ): this {
    const minY = Math.floor(Math.min(y1, y2)),
      maxY = Math.floor(Math.max(y1, y2));
    const height = Math.max(2, maxY - minY);
    const steps = 32;
    const entry = this.toEntry(blockState);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = Math.PI * t;
      const x = Math.round(x1 + (x2 - x1) * t);
      const z = Math.round(z1 + (z2 - z1) * t);
      const y = Math.round(minY + Math.sin(angle) * height);
      this.set(x, y, z, entry);
    }
    return this;
  }

  spiralStairs(
    cx: number,
    yStart: number,
    cz: number,
    radius: number,
    height: number,
    blockState: string | BlockStateEntry
  ): this {
    const entry = this.toEntry(blockState);
    const r = Math.max(1, radius);
    const steps = Math.max(1, height * 4);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = t * (height / 4) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(theta) * r);
      const z = Math.round(cz + Math.sin(theta) * r);
      const y = Math.floor(yStart + t * height);
      this.set(x, y, z, entry);
    }
    return this;
  }

  replace(targetBlockName: string, replacementState: string | BlockStateEntry): this {
    const targetNorm = normalizeNamespace(targetBlockName.split('[')[0]!);
    const rep = this.toEntry(replacementState);
    for (const [key, v] of this.voxels.entries()) {
      if (normalizeNamespace(v.state.name) === targetNorm) {
        if (isAirBlock(rep.name)) {
          this.voxels.delete(key);
        } else {
          this.voxels.set(key, { state: rep, nbt: v.nbt });
        }
      }
    }
    return this;
  }

  build(): UniversalStructureIR {
    const finalSize: Vec3 = {
      x: Math.max(this.minSize.x, this.maxCoord.x + 1),
      y: Math.max(this.minSize.y, this.maxCoord.y + 1),
      z: Math.max(this.minSize.z, this.maxCoord.z + 1)
    };
    const dataVersion = this.mcVersion.startsWith('1.20')
      ? DATA_VERSION_1_20_1
      : DATA_VERSION_1_21_11;

    const ir = createEmptyStructure(this.name, finalSize, {
      mcVersion: this.mcVersion,
      dataVersion,
      sourceFormat: 'dsl'
    });
    const reg = ir.regions[0]!;
    for (const [key, v] of this.voxels.entries()) {
      const [xs, ys, zs] = key.split(',');
      setRegionBlock(reg, Number(xs), Number(ys), Number(zs), v.state, v.nbt);
    }
    ir.requiredMods = extractModNamespaces(ir);
    return ir;
  }
}

export function createBuilder(name: string, size?: Vec3, mcVersion = '1.21.11'): StructureBuilder {
  return new StructureBuilder(name, size, mcVersion);
}

export interface RunDslOptions {
  baseStructure?: UniversalStructureIR;
}

/**
 * Executes a user or AI-generated JavaScript DSL script using `createBuilder`, `editBaseStructure` & `Math`.
 */
export function runStructureDslScript(code: string, options?: RunDslOptions): UniversalStructureIR {
  const editBaseStructure = (newName?: string) => {
    if (!options?.baseStructure) {
      return new StructureBuilder(newName || 'Edited_Structure', { x: 16, y: 16, z: 16 });
    }
    return StructureBuilder.fromExisting(options.baseStructure, newName);
  };

  const fn = new Function(
    'createBuilder',
    'editBaseStructure',
    'StructureBuilder',
    'Math',
    `"use strict";\n${code}`
  );
  const result = fn(createBuilder, editBaseStructure, StructureBuilder, Math);
  if (result instanceof StructureBuilder) {
    return result.build();
  }
  if (result && Array.isArray(result.regions)) {
    return result as UniversalStructureIR;
  }
  throw new Error('DSL script must return b.build() or a StructureBuilder instance');
}

export const BUILTIN_SAMPLE_SCRIPTS: Array<{ id: string; title: string; description: string; code: string }> = [
  {
    id: 'redstone-crafter-lab',
    title: '1.21 自动合成器与红石脉冲站 (原版生电示例)',
    description: '包含侦测器脉冲钟、比较器满箱检测、漏斗链、铜灯状态指示与 1.21 合成器',
    code: `const b = createBuilder('1.21 自动合成红石测试台', { x: 11, y: 6, z: 9 }, '1.21.11');
// 砂岩与平滑石台阶底座
b.fill(0, 0, 0, 10, 0, 8, 'minecraft:cut_sandstone');
b.hollowBox(0, 0, 0, 10, 0, 8, 'minecraft:polished_deepslate');

// 侦测器高频脉冲与铜灯 T触发器
b.set(2, 1, 4, 'minecraft:copper_bulb[lit=true,powered=false]');
b.set(3, 1, 4, 'minecraft:observer[facing=west,powered=false]');
b.set(4, 1, 4, 'minecraft:redstone_wire[east=side,west=side,power=15]');
b.set(5, 1, 4, 'minecraft:repeater[facing=west,delay=2,locked=false,powered=true]');
b.set(6, 1, 4, 'minecraft:crafter[orientation=east_up,triggered=true,crafting=false]');
b.set(7, 1, 4, 'minecraft:hopper[facing=east,enabled=true]');
b.set(8, 1, 4, 'minecraft:barrel[facing=up,open=false]');

// 侧翼比较器检测回路
b.set(6, 1, 3, 'minecraft:comparator[facing=south,mode=compare,powered=true]');
b.set(6, 1, 2, 'minecraft:target[power=8]');
b.set(5, 1, 2, 'minecraft:redstone_wire[east=side,west=side,power=8]');
b.set(4, 1, 2, 'minecraft:sticky_piston[facing=up,extended=true]');
b.set(4, 2, 2, 'minecraft:piston_head[facing=up,type=sticky,short=false]');
b.set(4, 3, 2, 'minecraft:redstone_block');

return b.build();`
  },
  {
    id: 'modded-create-ae2-demo',
    title: '跨加载器模组混合工坊 (Create 机械动力 + AE2 示范)',
    description: '演示 Forge/NeoForge 机械动力传动机构与 Fabric/NeoForge AE2 网络节点混合结构',
    code: `const b = createBuilder('Create + AE2 混合自动化单元', { x: 9, y: 5, z: 9 }, '1.20.1');
b.fill(0, 0, 0, 8, 0, 8, 'create:andesite_casing');
b.fill(1, 0, 1, 7, 0, 7, 'minecraft:polished_andesite');

// Create 动力轴承、传动杆与动力辊压机
b.set(2, 1, 4, 'create:mechanical_bearing[facing=up]');
b.set(3, 1, 4, 'create:shaft[axis=x]');
b.set(4, 1, 4, 'create:gearbox[axis=y]');
b.set(5, 1, 4, 'create:depot');
b.set(5, 3, 4, 'create:mechanical_press[facing=north]');

// AE2 控制器与驱动器阵列
b.set(4, 1, 2, 'ae2:controller');
b.set(5, 1, 2, 'ae2:drive[facing=south]');
b.set(6, 1, 2, 'ae2:cable_bus');

// 原版辅助红石输入
b.set(2, 1, 5, 'minecraft:lever[face=floor,facing=south,powered=true]');
return b.build();`
  },
  {
    id: 'oriental-pavilion-showcase',
    title: '中式飞檐重檐阁楼 (高级建筑原语示例)',
    description: '演示 gableRoof、pyramidRoof、pillarGrid 与雕花灯笼中式建筑生成',
    code: `const b = createBuilder('云栖重檐亭阁', { x: 15, y: 14, z: 15 }, '1.21.11');
// 石砖须弥座台基与踏步
b.fill(1, 0, 1, 13, 1, 13, 'minecraft:stone_bricks');
b.checkerboard(2, 1, 2, 12, 1, 12, 'minecraft:polished_andesite', 'minecraft:chiseled_stone_bricks');
b.fill(6, 0, 0, 8, 0, 0, 'minecraft:stone_brick_stairs[facing=south,half=bottom]');
b.fill(6, 1, 1, 8, 1, 1, 'minecraft:stone_brick_stairs[facing=south,half=bottom]');

// 一层朱红去皮金合欢立柱与花格窗墙
b.windowWall(3, 2, 3, 11, 5, 11, 'minecraft:white_terracotta', 'minecraft:oak_fence', 2);
b.clear(6, 2, 3, 8, 4, 3); // 南向正门
b.pillarGrid(2, 2, 2, 12, 6, 12, 5, 5, 'minecraft:stripped_mangrove_log[axis=y]');

// 一层挑檐与二层回廊
b.pyramidRoof(0, 6, 0, 14, 14, 'minecraft:deepslate_tile_stairs', 'minecraft:deepslate_tile_slab');
b.fill(3, 7, 3, 11, 10, 11, 'minecraft:air');
b.walls(4, 7, 4, 10, 9, 10, 'minecraft:spruce_planks');
b.pillarGrid(3, 7, 3, 11, 10, 11, 4, 4, 'minecraft:stripped_mangrove_log[axis=y]');

// 二层重檐四角攒尖顶与宝顶
b.pyramidRoof(2, 10, 2, 12, 12, 'minecraft:dark_prismarine_stairs', 'minecraft:dark_prismarine_slab');
b.set(7, 13, 7, 'minecraft:lightning_rod[facing=up]');
b.set(2, 5, 2, 'minecraft:lantern[hanging=true]');
b.set(12, 5, 2, 'minecraft:lantern[hanging=true]');
b.set(2, 5, 12, 'minecraft:lantern[hanging=true]');
b.set(12, 5, 12, 'minecraft:lantern[hanging=true]');

return b.build();`
  }
];
