import { normalizeNamespace } from './types.js';

export type CustomBlockArchetype =
  | 'cube'
  | 'glass'
  | 'slab'
  | 'stairs'
  | 'wall'
  | 'pillar'
  | 'cross'
  | 'pipe'
  | 'directional_machine'
  | 'custom_elements';

export type BlockRenderType = 'solid' | 'cutout' | 'translucent';

export type BlockFaceName = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

export interface CustomElementFace {
  uv?: [number, number, number, number];
  texture?: string;
  rotation?: 0 | 90 | 180 | 270;
}

export interface CustomModelElement {
  name?: string;
  /** Coordinates in standard Minecraft/Blockbench 0..16 block space */
  from: [number, number, number];
  to: [number, number, number];
  rotation?: {
    origin: [number, number, number];
    axis: 'x' | 'y' | 'z';
    angle: number;
  };
  faces: Partial<Record<BlockFaceName, CustomElementFace>>;
}

export interface CustomBlockDefinition {
  id: string;
  nameZh: string;
  nameEn: string;
  archetype: CustomBlockArchetype;
  colorHex: string;
  renderType: BlockRenderType;
  lightLevel: number;
  /** Optional base64 data URLs or texture keys per face */
  textures: Partial<Record<BlockFaceName | 'all', string>>;
  /** Optional custom cuboid elements (e.g. imported from Blockbench .bbmodel) */
  elements?: CustomModelElement[];
  /** Custom block state property definitions */
  properties?: Record<string, string[]>;
  category?: string;
}

export interface CustomBlockPack {
  formatVersion: 1;
  packName: string;
  author: string;
  exportedAt: string;
  blocks: CustomBlockDefinition[];
}

export class CustomBlockRegistry {
  private defs = new Map<string, CustomBlockDefinition>();

  register(def: CustomBlockDefinition): CustomBlockDefinition {
    const id = normalizeNamespace(def.id);
    const normalized: CustomBlockDefinition = {
      ...def,
      id,
      nameZh: def.nameZh || id,
      nameEn: def.nameEn || id,
      colorHex: def.colorHex || deterministicNamespaceColor(id),
      renderType: def.renderType || (def.archetype === 'glass' ? 'translucent' : 'solid'),
      lightLevel: Math.max(0, Math.min(15, def.lightLevel ?? 0)),
      textures: { ...def.textures }
    };
    this.defs.set(id, normalized);
    return normalized;
  }

  remove(id: string): boolean {
    return this.defs.delete(normalizeNamespace(id));
  }

  get(id: string): CustomBlockDefinition | undefined {
    return this.defs.get(normalizeNamespace(id));
  }

  has(id: string): boolean {
    return this.defs.has(normalizeNamespace(id));
  }

  list(): CustomBlockDefinition[] {
    return Array.from(this.defs.values());
  }

  clear(): void {
    this.defs.clear();
  }

  exportPack(packName = 'Custom Blocks Pack', author = 'User'): CustomBlockPack {
    return {
      formatVersion: 1,
      packName,
      author,
      exportedAt: new Date().toISOString(),
      blocks: this.list()
    };
  }

  importPack(packOrJson: CustomBlockPack | string): number {
    const parsed: CustomBlockPack =
      typeof packOrJson === 'string' ? JSON.parse(packOrJson) : packOrJson;
    if (!parsed || !Array.isArray(parsed.blocks)) {
      throw new Error('Invalid .mcvis-pack.json format: missing blocks array');
    }
    let count = 0;
    for (const blk of parsed.blocks) {
      if (blk?.id) {
        this.register(blk);
        count++;
      }
    }
    return count;
  }
}

/**
 * Generates a high-contrast, pleasing deterministic HSL->Hex color
 * based on namespace + block ID so unknown modded blocks NEVER look like
 * ugly magenta-black checkerboards!
 */
export function deterministicNamespaceColor(blockId: string): string {
  const norm = normalizeNamespace(blockId);
  const [ns, path = ''] = norm.split(':');
  let nsHash = 2166136261;
  for (let i = 0; i < ns!.length; i++) {
    nsHash ^= ns!.charCodeAt(i);
    nsHash = Math.imul(nsHash, 16777619);
  }
  let pathHash = 2166136261;
  for (let i = 0; i < path.length; i++) {
    pathHash ^= path.charCodeAt(i);
    pathHash = Math.imul(pathHash, 16777619);
  }

  const hue = ((nsHash >>> 0) % 360 + ((pathHash >>> 0) % 35) - 17 + 360) % 360;
  const sat = 52 + ((pathHash >>> 8) % 24);
  const light = 44 + ((pathHash >>> 16) % 20);
  return hslToHex(hue, sat, light);
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * Heuristic shape inference for Zero-Jar Modded Fallback rendering!
 */
export function inferHeuristicArchetype(
  blockId: string,
  props: Record<string, string>
): CustomBlockArchetype {
  const lower = blockId.toLowerCase();
  if (lower.endsWith('_slab') || lower.includes('slab') || ('type' in props && (props.type === 'bottom' || props.type === 'top'))) {
    return 'slab';
  }
  if (lower.endsWith('_stairs') || lower.includes('stairs') || ('shape' in props && 'half' in props && 'facing' in props)) {
    return 'stairs';
  }
  if (
    lower.includes('cable') ||
    lower.includes('pipe') ||
    lower.includes('conduit') ||
    lower.includes('tube') ||
    lower.includes('duct') ||
    lower.includes('wire')
  ) {
    return 'pipe';
  }
  if (lower.endsWith('_wall') || lower.endsWith('_fence') || lower.endsWith('_post')) {
    return 'wall';
  }
  if (lower.includes('glass') || lower.includes('window') || lower.includes('pane')) {
    return 'glass';
  }
  if (
    lower.includes('flower') ||
    lower.includes('sapling') ||
    lower.includes('crop') ||
    lower.includes('bush')
  ) {
    return 'cross';
  }
  if ('axis' in props) {
    return 'pillar';
  }
  if ('facing' in props || 'orientation' in props || 'horizontal_facing' in props) {
    return 'directional_machine';
  }
  return 'cube';
}
