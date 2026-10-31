import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CustomBlockRegistry,
  countStructureStats,
  nbtCompound,
  nbtString
} from '@mcvis/core';
import { NamespaceVirtualFS, UniversalModelCompiler } from '@mcvis/mod-loader';
import {
  convertRgbaToStructure,
  import3dModelToStructure,
  importBlockbenchAsCustomBlock,
  importBlockbenchAsStructure,
  importMagicaVoxel
} from '../index.js';

describe('Mod Loader (Vanilla + Forge/NeoForge/Fabric + Custom Blocks + Dynamic Camo) & Third-Party Importers', () => {
  it('compiles 1.21.11 vanilla JSON models, Forge/NeoForge OBJ & Composite models, Dynamic Camo, and Custom Blocks', () => {
    const vfs = new NamespaceVirtualFS();
    const bundleDir = path.resolve(process.cwd(), 'mc-env/assets/bundle/1.21.11');
    if (fs.existsSync(path.join(bundleDir, 'blockstates.json'))) {
      vfs.registerVanillaBundle({
        mcVersion: '1.21.11',
        blockstates: JSON.parse(fs.readFileSync(path.join(bundleDir, 'blockstates.json'), 'utf8')),
        models: JSON.parse(fs.readFileSync(path.join(bundleDir, 'models.json'), 'utf8')),
        blocksRegistry: JSON.parse(
          fs.readFileSync(path.join(bundleDir, 'blocks-registry.json'), 'utf8')
        )
      });
    }

    // Mount real NeoForge 1.21.1 Create JAR if cached from Phase 0!
    const createJarDir = path.resolve(process.cwd(), 'mc-env/.cache/test-mods/neoforge-1.21.1');
    if (fs.existsSync(createJarDir)) {
      const jarFile = fs.readdirSync(createJarDir).find((f) => f.endsWith('.jar'));
      if (jarFile) {
        const summary = vfs.mountModArchive(
          fs.readFileSync(path.join(createJarDir, jarFile)),
          jarFile
        );
        expect(summary.loaders).toContain('neoforge');
        expect(summary.namespaces).toContain('create');
      }
    }

    const customReg = new CustomBlockRegistry();
    customReg.register({
      id: 'kubejs:star_reactor_core',
      nameZh: '星核反应堆芯',
      nameEn: 'Star Reactor Core',
      archetype: 'directional_machine',
      colorHex: '#00e5ff',
      renderType: 'solid',
      lightLevel: 15,
      textures: {}
    });

    const compiler = new UniversalModelCompiler(vfs, customReg);

    // 1. Vanilla 1.21 Crafter
    const crafter = compiler.compileBlockState({
      name: 'minecraft:crafter',
      properties: { orientation: 'north_up', triggered: 'true', crafting: 'false' }
    });
    expect(crafter.boxes.length).toBeGreaterThan(0);

    // 2. Custom Block Studio block
    const customCompiled = compiler.compileBlockState({
      name: 'kubejs:star_reactor_core',
      properties: { facing: 'east' }
    });
    expect(customCompiled.sourceTier).toBe('custom');

    // 3. FramedBlocks Dynamic Camo extraction from BlockEntity NBT
    const framed = compiler.compileBlockState(
      { name: 'framedblocks:framed_stairs', properties: { facing: 'south', half: 'bottom' } },
      {
        pos: { x: 0, y: 0, z: 0 },
        id: 'framedblocks:framed_tile',
        nbt: nbtCompound({
          camo: nbtCompound({
            state: nbtCompound({ Name: nbtString('minecraft:oak_planks') })
          })
        })
      }
    );
    expect(framed.sourceTier).toBe('dynamic_nbt');
    expect(framed.boxes.length).toBe(2); // stair 2-box geometry!

    // 4. Zero-Jar Fallback for unknown modded cable
    const cable = compiler.compileBlockState({
      name: 'mekanism:ultimate_universal_cable',
      properties: { north: 'normal', south: 'normal', up: 'none' }
    });
    expect(cable.sourceTier).toBe('fallback_semantic');
    expect(cable.boxes.length).toBe(3); // core + north arm + south arm!
  });

  it('imports Wavefront .obj 3D models, MagicaVoxel .vox, Blockbench .bbmodel, and 3D Staircased Map Art', () => {
    // 1. OBJ Tetrahedron voxelization
    const sampleObj = [
      'v 0 0 0',
      'v 10 0 0',
      'v 5 10 0',
      'v 5 5 10',
      'f 1 2 3',
      'f 1 2 4',
      'f 2 3 4',
      'f 1 3 4'
    ].join('\n');
    const objIr = import3dModelToStructure(sampleObj, 'pyramid.obj', { targetMaxDimension: 16 });
    expect(countStructureStats(objIr).nonAirBlocks).toBeGreaterThan(20);

    // 2. MagicaVoxel .vox binary construction & import
    const voxBuf = new Uint8Array(68);
    const dv = new DataView(voxBuf.buffer);
    voxBuf.set([0x56, 0x4f, 0x58, 0x20], 0); // 'VOX '
    dv.setInt32(4, 150, true);
    // MAIN chunk header
    voxBuf.set([0x4d, 0x41, 0x49, 0x4e], 8);
    dv.setInt32(12, 0, true);
    dv.setInt32(16, 12 + 12 + 12 + 12, true);
    // SIZE chunk (4x4x4)
    voxBuf.set([0x53, 0x49, 0x5a, 0x45], 20);
    dv.setInt32(24, 12, true);
    dv.setInt32(28, 0, true);
    dv.setInt32(32, 4, true);
    dv.setInt32(36, 4, true);
    dv.setInt32(40, 4, true);
    // XYZI chunk (2 voxels)
    voxBuf.set([0x58, 0x59, 0x5a, 0x49], 44);
    dv.setInt32(48, 12, true);
    dv.setInt32(52, 0, true);
    dv.setInt32(56, 2, true);
    voxBuf.set([0, 0, 0, 42, 1, 2, 3, 100], 60);

    const voxIr = importMagicaVoxel(voxBuf, 'mini.vox');
    expect(countStructureStats(voxIr).nonAirBlocks).toBe(2);

    // 3. Blockbench .bbmodel dual-mode import
    const bbJson = JSON.stringify({
      name: 'Mini Turret',
      resolution: { width: 16, height: 16 },
      elements: [
        { from: [2, 0, 2], to: [14, 8, 14], faces: { up: { uv: [0, 0, 16, 16] } } },
        { from: [6, 8, 0], to: [10, 12, 12], faces: { north: { uv: [0, 0, 8, 8] } } }
      ]
    });
    const customDef = importBlockbenchAsCustomBlock(bbJson, 'custom:mini_turret');
    expect(customDef.elements?.length).toBe(2);
    const bbIr = importBlockbenchAsStructure(bbJson, 1);
    expect(countStructureStats(bbIr).nonAirBlocks).toBeGreaterThan(50);

    // 4. 3D Staircased Survival Map Art
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) {
      rgba[i * 4] = (i * 4) & 255;
      rgba[i * 4 + 1] = 180;
      rgba[i * 4 + 2] = 90;
      rgba[i * 4 + 3] = 255;
    }
    const mapIr = convertRgbaToStructure(8, 8, rgba, 'Mini MapArt', {
      mode: 'map_art_staircased_3d'
    });
    expect(mapIr.regions[0]!.size.x).toBe(8);
    expect(mapIr.regions[0]!.size.z).toBe(9); // includes north noobline row!
  });
});
