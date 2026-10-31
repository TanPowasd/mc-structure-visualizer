import {
  type CustomBlockRegistry,
  type UniversalStructureIR,
  createEmptyStructure,
  setRegionBlock
} from '@mcvis/core';
import {
  type PaletteFilterPreset,
  buildColorMatcherPalette,
  matchClosestBlockByRgb,
  rgbToLab
} from './color-palette.js';

export type ImageImportMode = 'wall_pixel_art' | 'map_art_flat' | 'map_art_staircased_3d';

export interface ImageArtOptions {
  mode: ImageImportMode;
  palettePreset?: PaletteFilterPreset;
  customRegistry?: CustomBlockRegistry;
  alphaThreshold?: number;
}

/**
 * Converts decoded RGBA image pixels into:
 * 1) Vertical Wall Pixel Art (X-Y plane)
 * 2) 2D Flat Survival Map Art (X-Z plane, e.g. 128x128 with north noobline)
 * 3) 3D Staircased Survival Map Art (X-Y-Z using Minecraft's 180/220/255 north height-shade multiplier!)
 */
export function convertRgbaToStructure(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  name = 'Image Art',
  options: ImageArtOptions
): UniversalStructureIR {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const alphaMin = options.alphaThreshold ?? 32;
  const palette = buildColorMatcherPalette(
    options.palettePreset ?? 'all_survival',
    options.customRegistry
  );

  if (options.mode === 'wall_pixel_art') {
    const ir = createEmptyStructure(name, { x: w, y: h, z: 1 }, { sourceFormat: 'imported_3d' });
    const reg = ir.regions[0]!;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const off = (py * w + px) * 4;
        if ((rgba[off + 3] ?? 255) < alphaMin) continue;
        const blk = matchClosestBlockByRgb(rgba[off]!, rgba[off + 1]!, rgba[off + 2]!, palette);
        setRegionBlock(reg, px, h - 1 - py, 0, blk);
      }
    }
    return ir;
  }

  if (options.mode === 'map_art_flat') {
    // Include z=0 north noobline row (cobblestone) so z=1..h gets exact 220/255 flat shade in-game!
    const ir = createEmptyStructure(
      name,
      { x: w, y: 1, z: h + 1 },
      { sourceFormat: 'imported_3d' }
    );
    const reg = ir.regions[0]!;
    for (let px = 0; px < w; px++) {
      setRegionBlock(reg, px, 0, 0, 'minecraft:cobblestone');
    }
    for (let pz = 0; pz < h; pz++) {
      for (let px = 0; px < w; px++) {
        const off = (pz * w + px) * 4;
        if ((rgba[off + 3] ?? 255) < alphaMin) {
          setRegionBlock(reg, px, 0, pz + 1, 'minecraft:glass');
          continue;
        }
        const blk = matchClosestBlockByRgb(rgba[off]!, rgba[off + 1]!, rgba[off + 2]!, palette);
        setRegionBlock(reg, px, 0, pz + 1, blk);
      }
    }
    return ir;
  }

  // 3D Staircased Map Art:
  // Minecraft shade multipliers relative to North neighbor height:
  //   deltaY = -1 (lower than North)  -> 180 / 255
  //   deltaY =  0 (same as North)     -> 220 / 255
  //   deltaY = +1 (higher than North) -> 255 / 255
  const SHADES: Array<{ dy: -1 | 0 | 1; mult: number }> = [
    { dy: -1, mult: 180 / 255 },
    { dy: 0, mult: 220 / 255 },
    { dy: 1, mult: 255 / 255 }
  ];

  const shadedPalette = palette.flatMap((entry) =>
    SHADES.map((s) => {
      const sr = Math.round(entry.rgb[0] * s.mult);
      const sg = Math.round(entry.rgb[1] * s.mult);
      const sb = Math.round(entry.rgb[2] * s.mult);
      return {
        blockId: entry.blockId,
        dy: s.dy,
        lab: rgbToLab(sr, sg, sb)
      };
    })
  );

  // Per column X, compute chosen blockId and relative heights along Z
  const colBlocks: string[][] = Array.from({ length: w }, () => new Array(h + 1).fill('minecraft:cobblestone'));
  const colHeights: number[][] = Array.from({ length: w }, () => new Array(h + 1).fill(0));

  let globalMaxHeight = 1;

  for (let px = 0; px < w; px++) {
    let curY = 0;
    colHeights[px]![0] = 0;
    for (let pz = 0; pz < h; pz++) {
      const off = (pz * w + px) * 4;
      const r = rgba[off]!;
      const g = rgba[off + 1]!;
      const b = rgba[off + 2]!;
      const [tl, ta, tb] = rgbToLab(r, g, b);

      let best = shadedPalette[0]!;
      let bestDist = Infinity;
      for (const cand of shadedPalette) {
        const dl = tl - cand.lab[0];
        const da = ta - cand.lab[1];
        const db = tb - cand.lab[2];
        const d = dl * dl + da * da + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = cand;
        }
      }
      curY += best.dy;
      colBlocks[px]![pz + 1] = best.blockId;
      colHeights[px]![pz + 1] = curY;
    }

    // Shift column vertically so minimum Y in this column is >= 0!
    const minColY = Math.min(...colHeights[px]!);
    for (let z = 0; z <= h; z++) {
      const shifted = colHeights[px]![z]! - minColY;
      colHeights[px]![z] = shifted;
      if (shifted + 1 > globalMaxHeight) globalMaxHeight = shifted + 1;
    }
  }

  const ir = createEmptyStructure(
    name,
    { x: w, y: Math.min(256, globalMaxHeight), z: h + 1 },
    { sourceFormat: 'imported_3d' }
  );
  const reg = ir.regions[0]!;

  for (let px = 0; px < w; px++) {
    for (let z = 0; z <= h; z++) {
      const y = Math.min(reg.size.y - 1, colHeights[px]![z]!);
      setRegionBlock(reg, px, y, z, colBlocks[px]![z]!);
    }
  }

  return ir;
}
