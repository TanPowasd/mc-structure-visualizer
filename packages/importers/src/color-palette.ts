import type { CustomBlockRegistry } from '@mcvis/core';

export interface PaletteColorBlock {
  blockId: string;
  rgb: [number, number, number];
  lab: [number, number, number];
  category: 'concrete' | 'wool' | 'terracotta' | 'natural' | 'custom';
}

export type PaletteFilterPreset = 'all_survival' | 'concrete_only' | 'wool_concrete' | 'include_custom';

const VANILLA_COLOR_PALETTE_RAW: Array<{
  id: string;
  rgb: [number, number, number];
  cat: PaletteColorBlock['category'];
}> = [
  { id: 'minecraft:white_concrete', rgb: [207, 213, 214], cat: 'concrete' },
  { id: 'minecraft:orange_concrete', rgb: [224, 97, 1], cat: 'concrete' },
  { id: 'minecraft:magenta_concrete', rgb: [169, 48, 159], cat: 'concrete' },
  { id: 'minecraft:light_blue_concrete', rgb: [36, 137, 199], cat: 'concrete' },
  { id: 'minecraft:yellow_concrete', rgb: [241, 175, 21], cat: 'concrete' },
  { id: 'minecraft:lime_concrete', rgb: [94, 169, 24], cat: 'concrete' },
  { id: 'minecraft:pink_concrete', rgb: [214, 101, 143], cat: 'concrete' },
  { id: 'minecraft:gray_concrete', rgb: [55, 58, 62], cat: 'concrete' },
  { id: 'minecraft:light_gray_concrete', rgb: [125, 125, 115], cat: 'concrete' },
  { id: 'minecraft:cyan_concrete', rgb: [21, 119, 136], cat: 'concrete' },
  { id: 'minecraft:purple_concrete', rgb: [100, 32, 156], cat: 'concrete' },
  { id: 'minecraft:blue_concrete', rgb: [45, 47, 143], cat: 'concrete' },
  { id: 'minecraft:brown_concrete', rgb: [96, 60, 32], cat: 'concrete' },
  { id: 'minecraft:green_concrete', rgb: [73, 91, 36], cat: 'concrete' },
  { id: 'minecraft:red_concrete', rgb: [142, 33, 33], cat: 'concrete' },
  { id: 'minecraft:black_concrete', rgb: [8, 10, 15], cat: 'concrete' },

  { id: 'minecraft:white_wool', rgb: [233, 236, 236], cat: 'wool' },
  { id: 'minecraft:orange_wool', rgb: [240, 118, 19], cat: 'wool' },
  { id: 'minecraft:magenta_wool', rgb: [189, 68, 179], cat: 'wool' },
  { id: 'minecraft:light_blue_wool', rgb: [58, 175, 217], cat: 'wool' },
  { id: 'minecraft:yellow_wool', rgb: [248, 198, 39], cat: 'wool' },
  { id: 'minecraft:lime_wool', rgb: [112, 185, 25], cat: 'wool' },
  { id: 'minecraft:pink_wool', rgb: [237, 141, 172], cat: 'wool' },
  { id: 'minecraft:gray_wool', rgb: [62, 68, 71], cat: 'wool' },
  { id: 'minecraft:light_gray_wool', rgb: [142, 142, 134], cat: 'wool' },
  { id: 'minecraft:cyan_wool', rgb: [21, 137, 145], cat: 'wool' },
  { id: 'minecraft:purple_wool', rgb: [121, 42, 172], cat: 'wool' },
  { id: 'minecraft:blue_wool', rgb: [53, 57, 157], cat: 'wool' },
  { id: 'minecraft:brown_wool', rgb: [114, 71, 40], cat: 'wool' },
  { id: 'minecraft:green_wool', rgb: [84, 109, 27], cat: 'wool' },
  { id: 'minecraft:red_wool', rgb: [161, 39, 34], cat: 'wool' },
  { id: 'minecraft:black_wool', rgb: [20, 21, 25], cat: 'wool' },

  { id: 'minecraft:white_terracotta', rgb: [209, 178, 161], cat: 'terracotta' },
  { id: 'minecraft:orange_terracotta', rgb: [161, 83, 37], cat: 'terracotta' },
  { id: 'minecraft:yellow_terracotta', rgb: [186, 133, 35], cat: 'terracotta' },
  { id: 'minecraft:brown_terracotta', rgb: [77, 51, 35], cat: 'terracotta' },
  { id: 'minecraft:red_terracotta', rgb: [143, 61, 46], cat: 'terracotta' },
  { id: 'minecraft:cyan_terracotta', rgb: [86, 91, 91], cat: 'terracotta' },

  { id: 'minecraft:smooth_quartz', rgb: [235, 229, 222], cat: 'natural' },
  { id: 'minecraft:stone', rgb: [125, 125, 125], cat: 'natural' },
  { id: 'minecraft:deepslate_tiles', rgb: [54, 54, 58], cat: 'natural' },
  { id: 'minecraft:oak_planks', rgb: [162, 130, 78], cat: 'natural' },
  { id: 'minecraft:spruce_planks', rgb: [114, 84, 48], cat: 'natural' },
  { id: 'minecraft:birch_planks', rgb: [192, 175, 121], cat: 'natural' },
  { id: 'minecraft:dark_oak_planks', rgb: [66, 43, 20], cat: 'natural' },
  { id: 'minecraft:gold_block', rgb: [246, 208, 61], cat: 'natural' },
  { id: 'minecraft:iron_block', rgb: [220, 220, 220], cat: 'natural' },
  { id: 'minecraft:copper_block', rgb: [192, 107, 79], cat: 'natural' },
  { id: 'minecraft:prismarine_bricks', rgb: [99, 171, 158], cat: 'natural' },
  { id: 'minecraft:lapis_block', rgb: [30, 67, 140], cat: 'natural' },
  { id: 'minecraft:emerald_block', rgb: [42, 203, 87], cat: 'natural' },
  { id: 'minecraft:redstone_block', rgb: [175, 24, 5], cat: 'natural' }
];

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const toLinear = (c: number) => {
    const v = c / 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  };
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) / 1.0;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const n = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function buildColorMatcherPalette(
  preset: PaletteFilterPreset = 'all_survival',
  customRegistry?: CustomBlockRegistry
): PaletteColorBlock[] {
  const list: PaletteColorBlock[] = [];

  for (const item of VANILLA_COLOR_PALETTE_RAW) {
    if (preset === 'concrete_only' && item.cat !== 'concrete') continue;
    if (preset === 'wool_concrete' && item.cat !== 'concrete' && item.cat !== 'wool') continue;
    list.push({
      blockId: item.id,
      rgb: item.rgb,
      lab: rgbToLab(item.rgb[0], item.rgb[1], item.rgb[2]),
      category: item.cat
    });
  }

  if (preset === 'include_custom' && customRegistry) {
    for (const def of customRegistry.list()) {
      const rgb = hexToRgb(def.colorHex);
      list.push({
        blockId: def.id,
        rgb,
        lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
        category: 'custom'
      });
    }
  }

  return list;
}

export function matchClosestBlockByRgb(
  r: number,
  g: number,
  b: number,
  palette: PaletteColorBlock[]
): string {
  const [l1, a1, b1] = rgbToLab(r, g, b);
  let bestId = palette[0]?.blockId ?? 'minecraft:white_concrete';
  let bestDist = Infinity;

  for (const entry of palette) {
    const dl = l1 - entry.lab[0];
    const da = a1 - entry.lab[1];
    const db = b1 - entry.lab[2];
    const dist = dl * dl + da * da + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestId = entry.blockId;
    }
  }
  return bestId;
}
