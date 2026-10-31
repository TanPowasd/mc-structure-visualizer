#!/usr/bin/env node
/**
 * Generates ready-to-open showcase files in `samples/` across ALL 7 Minecraft structure formats
 * + MagicaVoxel (.vox) + Wavefront 3D (.obj) + Custom Block Studio Pack (.mcvis-pack.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'samples');
fs.mkdirSync(outDir, { recursive: true });

const vite = await createServer({
  root: repoRoot,
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true },
  resolve: {
    alias: {
      '@mcvis/core': path.resolve(repoRoot, 'packages/core/src/index.ts'),
      '@mcvis/formats': path.resolve(repoRoot, 'packages/formats/src/index.ts')
    }
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom'
});

const core = await vite.ssrLoadModule(path.resolve(repoRoot, 'packages/core/src/index.ts'));
const formats = await vite.ssrLoadModule(path.resolve(repoRoot, 'packages/formats/src/index.ts'));

// 1. Built-in sample scripts -> 7 structure formats!
const samples = core.BUILTIN_SAMPLE_SCRIPTS;
const redstoneIr = core.runStructureDslScript(samples[0].code);
const createIr = core.runStructureDslScript(samples[1].code);
const pavilionIr = core.runStructureDslScript(samples[2] ? samples[2].code : samples[0].code);

fs.writeFileSync(
  path.join(outDir, '01-redstone-crafter-1.21.litematic'),
  Buffer.from(formats.serializeStructure(redstoneIr, 'litematic'))
);
fs.writeFileSync(
  path.join(outDir, '02-worldedit-crafter.schem'),
  Buffer.from(formats.serializeStructure(redstoneIr, 'schem'))
);
fs.writeFileSync(
  path.join(outDir, '03-create-mod-contraption-1.20.1.nbt'),
  Buffer.from(formats.serializeStructure(core.convertStructureVersion(createIr, '1.20.1'), 'nbt'))
);
fs.writeFileSync(
  path.join(outDir, '04-building-gadgets-2-paste.bg2.json'),
  String(formats.serializeStructure(createIr, 'building_gadgets_v2')),
  'utf8'
);
fs.writeFileSync(
  path.join(outDir, '05-axiom-blueprint.bp'),
  Buffer.from(formats.serializeStructure(pavilionIr, 'axiom_bp'))
);
fs.writeFileSync(
  path.join(outDir, '06-minecolonies-structurize.blueprint'),
  Buffer.from(formats.serializeStructure(pavilionIr, 'structurize_blueprint'))
);
fs.writeFileSync(
  path.join(outDir, '07-f3i-commands.mcfunction'),
  String(formats.serializeStructure(redstoneIr, 'f3i_command')),
  'utf8'
);

// 8. Wavefront 3D .obj Torii Gate for 3D Mesh Voxelizer testing
const objLines = [
  '# Low-poly Torii Gate for MC Structure Visualizer 3D Voxelizer',
  'v -4 0 -0.6', 'v -2.8 0 -0.6', 'v -2.8 8 -0.6', 'v -4 8 -0.6',
  'v -4 0 0.6',  'v -2.8 0 0.6',  'v -2.8 8 0.6',  'v -4 8 0.6',
  'f 1 2 3 4', 'f 5 8 7 6', 'f 1 5 6 2', 'f 2 6 7 3', 'f 3 7 8 4', 'f 4 8 5 1',
  'v 2.8 0 -0.6', 'v 4 0 -0.6', 'v 4 8 -0.6', 'v 2.8 8 -0.6',
  'v 2.8 0 0.6',  'v 4 0 0.6',  'v 4 8 0.6',  'v 2.8 8 0.6',
  'f 9 10 11 12', 'f 13 16 15 14', 'f 9 13 14 10', 'f 10 14 15 11', 'f 11 15 16 12', 'f 12 16 13 9',
  'v -6 7.8 -1', 'v 6 7.8 -1', 'v 6 9.2 -1', 'v -6 9.2 -1',
  'v -6 7.8 1',  'v 6 7.8 1',  'v 6 9.2 1',  'v -6 9.2 1',
  'f 17 18 19 20', 'f 21 24 23 22', 'f 17 21 22 18', 'f 19 23 24 20'
].join('\n');
fs.writeFileSync(path.join(outDir, '08-torii-gate-3d-mesh.obj'), objLines, 'utf8');

// 9. Custom Block Studio Preset Pack (.mcvis-pack.json)
const reg = new core.CustomBlockRegistry();
reg.register({
  id: 'kubejs:void_alloy_casing',
  nameZh: '虚空合金机壳',
  nameEn: 'Void Alloy Casing',
  archetype: 'directional_machine',
  colorHex: '#38bdf8',
  renderType: 'solid',
  lightLevel: 7,
  textures: {}
});
reg.register({
  id: 'kubejs:aether_crystal_glass',
  nameZh: '以太水晶玻璃',
  nameEn: 'Aether Crystal Glass',
  archetype: 'glass',
  colorHex: '#c084fc',
  renderType: 'translucent',
  lightLevel: 12,
  textures: {}
});
fs.writeFileSync(
  path.join(outDir, '09-kubejs-custom-blocks.mcvis-pack.json'),
  JSON.stringify(reg.exportPack(), null, 2),
  'utf8'
);

await vite.close();
console.log(`Generated ${fs.readdirSync(outDir).length} sample files in ${outDir}`);
