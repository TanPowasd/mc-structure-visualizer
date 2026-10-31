import {
  type BlockFaceName,
  type CustomBlockDefinition,
  type CustomElementFace,
  type CustomModelElement,
  type UniversalStructureIR,
  createEmptyStructure,
  normalizeNamespace,
  setRegionBlock
} from '@mcvis/core';
import { buildColorMatcherPalette, matchClosestBlockByRgb } from './color-palette.js';

const BB_FACES: BlockFaceName[] = ['north', 'east', 'south', 'west', 'up', 'down'];

/**
 * Mode 1: Imports a Blockbench (.bbmodel) file as a reusable Custom Block Definition
 * for Custom Block Studio (preserving exact cuboid elements, rotations, UVs, and embedded PNGs!).
 */
export function importBlockbenchAsCustomBlock(
  bbmodelJsonText: string,
  customBlockId?: string
): CustomBlockDefinition {
  const bb = JSON.parse(bbmodelJsonText) as Record<string, unknown>;
  const rawName = (typeof bb.name === 'string' && bb.name) || 'custom_bb_block';
  const id = normalizeNamespace(
    customBlockId || `custom:${rawName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
  );

  // Extract embedded data:image/png;base64,... textures from bb.textures
  const texSources: string[] = [];
  if (Array.isArray(bb.textures)) {
    for (const t of bb.textures as Array<Record<string, unknown>>) {
      if (typeof t?.source === 'string') {
        texSources.push(t.source);
      }
    }
  }

  const elements: CustomModelElement[] = [];
  if (Array.isArray(bb.elements)) {
    for (const el of bb.elements as Array<Record<string, unknown>>) {
      if (el.visibility === false) continue;
      const fromArr = Array.isArray(el.from) ? el.from : [0, 0, 0];
      const toArr = Array.isArray(el.to) ? el.to : [16, 16, 16];

      let rotation: CustomModelElement['rotation'];
      if (Array.isArray(el.rotation)) {
        const rx = Number(el.rotation[0] ?? 0);
        const ry = Number(el.rotation[1] ?? 0);
        const rz = Number(el.rotation[2] ?? 0);
        const orig = Array.isArray(el.origin) ? el.origin : [8, 8, 8];
        if (rx !== 0 || ry !== 0 || rz !== 0) {
          const axis = Math.abs(rx) >= Math.abs(ry) && Math.abs(rx) >= Math.abs(rz)
            ? 'x'
            : Math.abs(ry) >= Math.abs(rz)
              ? 'y'
              : 'z';
          const angle = axis === 'x' ? rx : axis === 'y' ? ry : rz;
          rotation = {
            origin: [Number(orig[0] ?? 8), Number(orig[1] ?? 8), Number(orig[2] ?? 8)],
            axis,
            angle
          };
        }
      }

      const faces: Partial<Record<BlockFaceName, CustomElementFace>> = {};
      if (el.faces && typeof el.faces === 'object') {
        for (const faceName of BB_FACES) {
          const fd = (el.faces as Record<string, Record<string, unknown>>)[faceName];
          if (!fd) continue;
          const texIdx = typeof fd.texture === 'number' ? fd.texture : 0;
          const uvArr = Array.isArray(fd.uv) ? fd.uv : undefined;
          // Normalize Blockbench UV resolution (default 16x16) to 0..16 space
          const resW = Number((bb.resolution as Record<string, unknown>)?.width ?? 16) || 16;
          const resH = Number((bb.resolution as Record<string, unknown>)?.height ?? 16) || 16;
          faces[faceName] = {
            texture: texSources[texIdx] ?? texSources[0],
            uv: uvArr
              ? [
                  (Number(uvArr[0] ?? 0) * 16) / resW,
                  (Number(uvArr[1] ?? 0) * 16) / resH,
                  (Number(uvArr[2] ?? 16) * 16) / resW,
                  (Number(uvArr[3] ?? 16) * 16) / resH
                ]
              : undefined
          };
        }
      }

      elements.push({
        name: typeof el.name === 'string' ? el.name : undefined,
        from: [Number(fromArr[0] ?? 0), Number(fromArr[1] ?? 0), Number(fromArr[2] ?? 0)],
        to: [Number(toArr[0] ?? 16), Number(toArr[1] ?? 16), Number(toArr[2] ?? 16)],
        rotation,
        faces
      });
    }
  }

  return {
    id,
    nameZh: rawName,
    nameEn: rawName,
    archetype: elements.length > 0 ? 'custom_elements' : 'cube',
    colorHex: '#5fa8ff',
    renderType: 'cutout',
    lightLevel: 0,
    textures: texSources[0] ? { all: texSources[0] } : {},
    elements
  };
}

/**
 * Mode 2: Voxelizes a Blockbench (.bbmodel) model into a multi-block UniversalStructureIR
 * (1 Blockbench unit = `scaleBlocksPerUnit` Minecraft blocks, default 1 unit = 1 block!).
 */
export function importBlockbenchAsStructure(
  bbmodelJsonText: string,
  scaleBlocksPerUnit = 1
): UniversalStructureIR {
  const def = importBlockbenchAsCustomBlock(bbmodelJsonText);
  const elems = def.elements ?? [];
  if (elems.length === 0) {
    throw new Error('Blockbench .bbmodel contains no visible cuboid elements');
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (const el of elems) {
    minX = Math.min(minX, el.from[0], el.to[0]);
    minY = Math.min(minY, el.from[1], el.to[1]);
    minZ = Math.min(minZ, el.from[2], el.to[2]);
    maxX = Math.max(maxX, el.from[0], el.to[0]);
    maxY = Math.max(maxY, el.from[1], el.to[1]);
    maxZ = Math.max(maxZ, el.from[2], el.to[2]);
  }

  const s = Math.max(0.25, Math.min(8, scaleBlocksPerUnit));
  const sx = Math.max(1, Math.ceil((maxX - minX) * s));
  const sy = Math.max(1, Math.ceil((maxY - minY) * s));
  const sz = Math.max(1, Math.ceil((maxZ - minZ) * s));

  const ir = createEmptyStructure(def.nameEn, { x: sx, y: sy, z: sz }, {
    sourceFormat: 'imported_3d'
  });
  const reg = ir.regions[0]!;
  const palette = buildColorMatcherPalette('all_survival');

  elems.forEach((el, idx) => {
    // Pick distinct pleasing palette tone per element group if texture pixels aren't decoded
    const hueShift = (idx * 53) % 255;
    const blockId = matchClosestBlockByRgb(
      180 - (hueShift % 80),
      150 + (hueShift % 70),
      200 - (hueShift % 90),
      palette
    );

    const x0 = Math.floor((Math.min(el.from[0], el.to[0]) - minX) * s);
    const x1 = Math.max(x0, Math.ceil((Math.max(el.from[0], el.to[0]) - minX) * s) - 1);
    const y0 = Math.floor((Math.min(el.from[1], el.to[1]) - minY) * s);
    const y1 = Math.max(y0, Math.ceil((Math.max(el.from[1], el.to[1]) - minY) * s) - 1);
    const z0 = Math.floor((Math.min(el.from[2], el.to[2]) - minZ) * s);
    const z1 = Math.max(z0, Math.ceil((Math.max(el.from[2], el.to[2]) - minZ) * s) - 1);

    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          setRegionBlock(reg, x, y, z, blockId);
        }
      }
    }
  });

  return ir;
}
