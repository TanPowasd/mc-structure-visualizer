import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import {
  CustomBlockRegistry,
  convertStructureVersion,
  createEmptyStructure,
  nbtByte,
  nbtCompound,
  nbtInt,
  nbtList,
  nbtString,
  NbtTagType,
  parseBlockStateString,
  setRegionBlock
} from '@mcvis/core';
import { NamespaceVirtualFS, UniversalModelCompiler } from '../index.js';

describe('Multi-Loader Mod Asset Resolver & 1.20.1 <-> 1.21.11 Version Adapter', () => {
  it('mounts NeoForge/Forge/Fabric archives with recursive Jar-in-Jar and compiles forge:obj models', () => {
    const encoder = new TextEncoder();

    // Inner nested Jar-in-Jar (Fabric sub-module)
    const innerJar = zipSync({
      'fabric.mod.json': encoder.encode(
        JSON.stringify({ id: 'subcable', name: 'Sub Cable JIJ', version: '1.0.0' })
      ),
      'assets/subcable/blockstates/fluix_pipe.json': encoder.encode(
        JSON.stringify({
          variants: { '': { model: 'subcable:block/fluix_pipe' } }
        })
      ),
      'assets/subcable/models/block/fluix_pipe.json': encoder.encode(
        JSON.stringify({
          textures: { all: 'subcable:block/fluix' },
          elements: [{ from: [4, 4, 0], to: [12, 12, 16], faces: { up: { texture: '#all' } } }]
        })
      )
    });

    // Outer NeoForge JAR with neoforge:obj Wavefront model + nested JIJ
    const outerJar = zipSync({
      'META-INF/neoforge.mods.toml': encoder.encode(`
[[mods]]
modId="create"
version="6.0.10"
displayName="Create"
`),
      'META-INF/jars/subcable-1.0.0.jar': innerJar,
      'assets/create/blockstates/water_wheel.json': encoder.encode(
        JSON.stringify({
          variants: {
            'axis=y': { model: 'create:block/water_wheel', x: 0, y: 90 }
          }
        })
      ),
      'assets/create/models/block/water_wheel.json': encoder.encode(
        JSON.stringify({
          loader: 'neoforge:obj',
          model: 'create:models/block/water_wheel.obj',
          textures: { particle: 'create:block/axis' }
        })
      ),
      'assets/create/models/block/water_wheel.mtl': encoder.encode(
        'newmtl wheel_mat\nmap_Kd create:block/planks\n'
      ),
      'assets/create/models/block/water_wheel.obj': encoder.encode(
        [
          'mtllib water_wheel.mtl',
          'usemtl wheel_mat',
          'v 0 0 0',
          'v 1 0 0',
          'v 0 1 0',
          'vt 0 0',
          'vt 1 0',
          'vt 0 1',
          'vn 0 0 1',
          'f 1/1/1 2/2/1 3/3/1'
        ].join('\n')
      )
    });

    const vfs = new NamespaceVirtualFS();
    const summary = vfs.mountModArchive(outerJar, 'create-neoforge-test.jar');
    expect(summary.loaders).toContain('neoforge');
    expect(summary.nestedJars).toBe(1);
    expect(vfs.getMountedNamespaces().has('create')).toBe(true);
    expect(vfs.getMountedNamespaces().has('subcable')).toBe(true);

    const compiler = new UniversalModelCompiler(vfs, new CustomBlockRegistry());
    const objModel = compiler.compileBlockState(parseBlockStateString('create:water_wheel[axis=y]'));
    expect(objModel.sourceTier).toBe('forge_obj');
    expect(objModel.objTriangles?.length).toBe(1);
    expect(objModel.objTriangles?.[0]?.textureRef).toBe('create:block/planks');

    const jijModel = compiler.compileBlockState(parseBlockStateString('subcable:fluix_pipe'));
    expect(jijModel.sourceTier).toBe('asset_json');
    expect(jijModel.boxes.length).toBe(1);
  });

  it('resolves FramedBlocks dynamic camo BlockEntity NBT and Zero-Jar semantic fallbacks', () => {
    const vfs = new NamespaceVirtualFS();
    vfs.registerVanillaBundle({
      mcVersion: '1.20.1',
      blockstates: {
        'minecraft:gold_block': {
          variants: { '': { model: 'minecraft:block/gold_block' } }
        }
      },
      models: {
        'minecraft:block/gold_block': {
          textures: { all: 'minecraft:block/gold_block' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 16, 16],
              faces: {
                up: { texture: '#all' },
                north: { texture: '#all' }
              }
            }
          ]
        }
      },
      blocksRegistry: {}
    });

    const compiler = new UniversalModelCompiler(vfs, new CustomBlockRegistry());

    // FramedBlocks dynamic camo override
    const camoBe = {
      pos: { x: 0, y: 0, z: 0 },
      id: 'framedblocks:framed_tile',
      nbt: nbtCompound({
        camo: nbtCompound({
          state: nbtCompound({
            Name: nbtString('minecraft:gold_block')
          })
        })
      })
    };
    const framed = compiler.compileBlockState(
      parseBlockStateString('framedblocks:framed_stairs[facing=east,half=bottom]'),
      camoBe
    );
    expect(framed.sourceTier).toBe('dynamic_nbt');
    expect(framed.boxes.length).toBe(2); // stairs archetype = 2 boxes
    expect(framed.boxes[0]?.faces.up?.textureRef).toBe('minecraft:block/gold_block');

    // Zero-Jar unknown modded slab fallback (never missing magenta-black!)
    const unknownSlab = compiler.compileBlockState(
      parseBlockStateString(' twilightforest:aurora_slab[type=top] ')
    );
    expect(unknownSlab.sourceTier).toBe('fallback_semantic');
    expect(unknownSlab.boxes[0]?.from[1]).toBe(8);
    expect(unknownSlab.boxes[0]?.to[1]).toBe(16);
    expect(unknownSlab.fallbackColorHex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('converts structures bidirectionally between 1.20.1 (DataVersion 3465) and 1.21.11 (DataVersion 4671)', () => {
    const ir120 = createEmptyStructure('Legacy_1201', { x: 2, y: 1, z: 1 }, {
      mcVersion: '1.20.1',
      dataVersion: 3465
    });
    setRegionBlock(ir120.regions[0]!, 0, 0, 0, parseBlockStateString('minecraft:grass'));
    setRegionBlock(
      ir120.regions[0]!,
      1,
      0,
      0,
      parseBlockStateString('minecraft:chest[facing=north]'),
      nbtCompound({
        id: nbtString('minecraft:chest'),
        Items: nbtList(NbtTagType.Compound, [
          nbtCompound({
            Slot: nbtByte(0),
            id: nbtString('minecraft:redstone'),
            Count: nbtByte(64),
            tag: nbtCompound({ RepairCost: nbtInt(1) })
          })
        ])
      })
    );

    const upgraded = convertStructureVersion(ir120, '1.21.11');
    expect(upgraded.dataVersion).toBe(4671);
    expect(upgraded.regions[0]!.palette.some((p) => p.name === 'minecraft:short_grass')).toBe(true);
    const chest121 = upgraded.regions[0]!.blockEntities.get('1,0,0')!;
    const item121 = (chest121.nbt.value.Items as { value: Array<{ value: Record<string, unknown> }> })
      .value[0]!.value;
    expect(item121.count).toBeDefined();
    expect(item121.Count).toBeUndefined();

    const downgraded = convertStructureVersion(upgraded, '1.20.1');
    expect(downgraded.dataVersion).toBe(3465);
    expect(downgraded.regions[0]!.palette.some((p) => p.name === 'minecraft:grass')).toBe(true);
    const chestBack = downgraded.regions[0]!.blockEntities.get('1,0,0')!;
    const itemBack = (chestBack.nbt.value.Items as { value: Array<{ value: Record<string, unknown> }> })
      .value[0]!.value;
    expect(itemBack.Count).toBeDefined();
  });

  it('mounts Modrinth .mrpack KubeJS overrides and resolves ItemsAdder/Oraxen note_block redirects', () => {
    const encoder = new TextEncoder();
    const mrpack = zipSync({
      'modrinth.index.json': encoder.encode(
        JSON.stringify({
          name: 'All The Tech Pack',
          dependencies: { minecraft: '1.20.1', 'forge': '47.3.0' },
          files: [
            {
              path: 'mods/create-1.20.1-6.0.8.jar',
              downloads: ['https://cdn.modrinth.com/data/LNytGWDc/versions/example/create.jar']
            }
          ]
        })
      ),
      'overrides/kubejs/assets/kubejs/blockstates/void_casing.json': encoder.encode(
        JSON.stringify({
          variants: { '': { model: 'kubejs:block/void_casing' } }
        })
      ),
      'overrides/kubejs/assets/kubejs/models/block/void_casing.json': encoder.encode(
        JSON.stringify({
          textures: { all: 'kubejs:block/void_casing' },
          elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' } } }]
        })
      ),
      'overrides/resourcepacks/itemsadder_pack.zip': zipSync({
        'pack.mcmeta': encoder.encode(JSON.stringify({ pack: { pack_format: 15, description: 'IA' } })),
        'assets/minecraft/blockstates/note_block.json': encoder.encode(
          JSON.stringify({
            variants: {
              'instrument=harp,note=1,powered=false': { model: 'itemsadder:block/ruby_ore' }
            }
          })
        ),
        'assets/itemsadder/models/block/ruby_ore.json': encoder.encode(
          JSON.stringify({
            textures: { all: 'itemsadder:block/ruby_ore' },
            elements: [{ from: [2, 2, 2], to: [14, 14, 14], faces: { up: { texture: '#all' } } }]
          })
        )
      })
    });

    const vfs = new NamespaceVirtualFS();
    const mrSummary = vfs.mountMrpackArchive(mrpack, 'all-the-tech.mrpack');
    expect(mrSummary.packName).toBe('All The Tech Pack');
    expect(mrSummary.kubeJsAssets).toBe(2);
    expect(mrSummary.modDownloads.length).toBe(1);
    expect(vfs.getMountedNamespaces().has('kubejs')).toBe(true);
    expect(vfs.getMountedNamespaces().has('itemsadder')).toBe(true);

    const compiler = new UniversalModelCompiler(vfs, new CustomBlockRegistry());
    const kubeCompiled = compiler.compileBlockState(parseBlockStateString('kubejs:void_casing'));
    expect(kubeCompiled.sourceTier).toBe('asset_json');

    const iaRedirect = compiler.compileBlockState(
      parseBlockStateString('minecraft:note_block[instrument=harp,note=1,powered=false]')
    );
    expect(iaRedirect.sourceTier).toBe('asset_json');
    expect(iaRedirect.boxes[0]?.from).toEqual([2, 2, 2]);
  });
});
