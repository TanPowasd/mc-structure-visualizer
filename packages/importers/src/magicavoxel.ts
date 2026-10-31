import {
  type CustomBlockRegistry,
  type UniversalStructureIR,
  createEmptyStructure,
  extractModNamespaces,
  setRegionBlock
} from '@mcvis/core';
import {
  type PaletteFilterPreset,
  buildColorMatcherPalette,
  matchClosestBlockByRgb
} from './color-palette.js';

export interface MagicaVoxelImportOptions {
  palettePreset?: PaletteFilterPreset;
  /** If true, registers exact RGBA custom blocks into customRegistry instead of snapping to vanilla colors */
  generateExactCustomBlocks?: boolean;
  customRegistry?: CustomBlockRegistry;
}

/**
 * Parses MagicaVoxel (.vox) files (version 150 / 200) directly into a UniversalStructureIR!
 * Converts MagicaVoxel right-handed Z-up coordinates to Minecraft Y-up coordinates.
 */
export function importMagicaVoxel(
  bytes: Uint8Array,
  fileName = 'model.vox',
  options?: MagicaVoxelImportOptions
): UniversalStructureIR {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 20 ||
    bytes[0] !== 0x56 || // 'V'
    bytes[1] !== 0x4f || // 'O'
    bytes[2] !== 0x58 || // 'X'
    bytes[3] !== 0x20 // ' '
  ) {
    throw new Error('Invalid MagicaVoxel .vox header (expected "VOX ")');
  }

  // MagicaVoxel SIZE (Z is up in MagicaVoxel!)
  let mvSizeX = 16,
    mvSizeY = 16,
    mvSizeZ = 16;
  const voxels: Array<{ x: number; y: number; z: number; colorIndex: number }> = [];
  const rgbaPalette: Array<[number, number, number]> = buildDefaultVoxPalette();

  const readChunkTag = (off: number) =>
    String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);

  function walkChunks(startOffset: number, endOffset: number) {
    let pos = startOffset;
    while (pos + 12 <= endOffset) {
      const id = readChunkTag(pos);
      const contentBytes = view.getInt32(pos + 4, true);
      const childrenBytes = view.getInt32(pos + 8, true);
      const contentStart = pos + 12;
      const childrenStart = contentStart + contentBytes;

      if (id === 'SIZE' && contentBytes >= 12) {
        mvSizeX = view.getInt32(contentStart, true);
        mvSizeY = view.getInt32(contentStart + 4, true);
        mvSizeZ = view.getInt32(contentStart + 8, true);
      } else if (id === 'XYZI' && contentBytes >= 4) {
        const numVoxels = view.getInt32(contentStart, true);
        let vPos = contentStart + 4;
        for (let i = 0; i < numVoxels && vPos + 4 <= childrenStart; i++) {
          voxels.push({
            x: bytes[vPos]!,
            y: bytes[vPos + 1]!,
            z: bytes[vPos + 2]!,
            colorIndex: bytes[vPos + 3]!
          });
          vPos += 4;
        }
      } else if (id === 'RGBA' && contentBytes >= 1024) {
        // RGBA chunk stores colors [1..255] at indices 0..254
        for (let i = 0; i < 255; i++) {
          const off = contentStart + i * 4;
          rgbaPalette[i + 1] = [bytes[off]!, bytes[off + 1]!, bytes[off + 2]!];
        }
      }

      if (childrenBytes > 0) {
        walkChunks(childrenStart, childrenStart + childrenBytes);
      }
      pos = childrenStart + childrenBytes;
    }
  }

  walkChunks(8, bytes.byteLength);

  // Convert MV (X, Y-depth, Z-up) -> MC (X, Y-up = mvZ, Z = mvY)
  const mcSize = {
    x: Math.max(1, mvSizeX),
    y: Math.max(1, mvSizeZ),
    z: Math.max(1, mvSizeY)
  };

  const baseName = fileName.replace(/\.vox$/i, '');
  const ir = createEmptyStructure(baseName, mcSize, { sourceFormat: 'imported_3d' });
  const reg = ir.regions[0]!;

  const matcherPalette = buildColorMatcherPalette(
    options?.palettePreset ?? 'all_survival',
    options?.customRegistry
  );
  const colorIdxToBlock = new Map<number, string>();

  for (const v of voxels) {
    let blockId = colorIdxToBlock.get(v.colorIndex);
    if (!blockId) {
      const rgb = rgbaPalette[v.colorIndex] ?? [200, 200, 200];
      if (options?.generateExactCustomBlocks && options.customRegistry) {
        const hex =
          '#' +
          rgb
            .map((c) => c.toString(16).padStart(2, '0'))
            .join('');
        const customId = `vox:${baseName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_c${v.colorIndex}`;
        options.customRegistry.register({
          id: customId,
          nameZh: `VOX 色块 ${hex.toUpperCase()}`,
          nameEn: `VOX Color ${hex.toUpperCase()}`,
          archetype: 'cube',
          colorHex: hex,
          renderType: 'solid',
          lightLevel: 0,
          textures: {}
        });
        blockId = customId;
      } else {
        blockId = matchClosestBlockByRgb(rgb[0], rgb[1], rgb[2], matcherPalette);
      }
      colorIdxToBlock.set(v.colorIndex, blockId);
    }

    setRegionBlock(reg, v.x, v.z, mcSize.z - 1 - v.y, blockId);
  }

  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

function buildDefaultVoxPalette(): Array<[number, number, number]> {
  const pal: Array<[number, number, number]> = new Array(256).fill([255, 255, 255]);
  // Standard 6x6x6 RGB cube + grayscale ramp matching MagicaVoxel's built-in default palette
  let idx = 1;
  for (let b = 5; b >= 0; b--) {
    for (let g = 5; g >= 0; g--) {
      for (let r = 5; r >= 0; r--) {
        if (idx < 256) {
          pal[idx++] = [Math.round((r * 255) / 5), Math.round((g * 255) / 5), Math.round((b * 255) / 5)];
        }
      }
    }
  }
  while (idx < 256) {
    const v = Math.round(((256 - idx) / 40) * 255);
    pal[idx++] = [v, v, v];
  }
  return pal;
}
