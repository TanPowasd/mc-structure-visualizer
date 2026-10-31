import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ASSETS_DIR,
  CACHE_DIR,
  downloadFile,
  fetchJson,
  loadConfig,
  openZipBuffer,
  resolveJava
} from './utils.mjs';

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES_MIRRORS = [
  'https://bmclapi2.bangbang93.com/assets',
  'https://resources.download.minecraft.org'
];

function shouldExtractTexture(entryName) {
  return (
    entryName.startsWith('assets/minecraft/textures/block/') ||
    entryName.startsWith('assets/minecraft/textures/colormap/') ||
    entryName.startsWith('assets/minecraft/textures/entity/chest/') ||
    entryName.startsWith('assets/minecraft/textures/entity/signs/') ||
    entryName.startsWith('assets/minecraft/textures/entity/shulker/') ||
    entryName.startsWith('assets/minecraft/textures/entity/bed/') ||
    entryName.startsWith('assets/minecraft/textures/entity/banner/')
  );
}

async function setupVersionAssets(mcVersion, manifest, javaBin) {
  console.log(`\n========================================`);
  console.log(`[Assets] Setting up Minecraft ${mcVersion} Vanilla Assets & DataGen`);
  console.log(`========================================`);

  const verEntry = manifest.versions.find((v) => v.id === mcVersion);
  if (!verEntry) {
    throw new Error(`Minecraft version ${mcVersion} not found in Mojang manifest`);
  }

  const verCacheDir = path.join(CACHE_DIR, mcVersion);
  const extractedDir = path.join(ASSETS_DIR, 'extracted', mcVersion);
  const bundleDir = path.join(ASSETS_DIR, 'bundle', mcVersion);
  await fsp.mkdir(verCacheDir, { recursive: true });
  await fsp.mkdir(extractedDir, { recursive: true });
  await fsp.mkdir(bundleDir, { recursive: true });

  const verMeta = await fetchJson(verEntry.url);

  // 1. Download client.jar
  const clientDl = verMeta.downloads.client;
  const clientJarPath = path.join(verCacheDir, 'client.jar');
  await downloadFile(clientDl.url, clientJarPath, {
    sha1: clientDl.sha1,
    label: `MC ${mcVersion} client.jar`
  });

  // 2. Extract blockstates, models, textures, and en_us.json from client.jar
  console.log(`  [extract] Reading ${mcVersion} client.jar entries...`);
  const clientBuf = await fsp.readFile(clientJarPath);
  const zip = openZipBuffer(clientBuf);

  const blockstatesMap = {};
  const modelsMap = {};
  let enUsLang = {};
  let extractedTextureCount = 0;

  let mcVersionMeta = null;
  if (zip.has('version.json')) {
    mcVersionMeta = zip.readJson('version.json');
  }

  for (const name of zip.listNames()) {
    if (name.startsWith('assets/minecraft/blockstates/') && name.endsWith('.json')) {
      const id = 'minecraft:' + path.basename(name, '.json');
      blockstatesMap[id] = zip.readJson(name);
      const outPath = path.join(extractedDir, name.replace(/^assets\/minecraft\//, ''));
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, zip.readEntry(name));
    } else if (
      (name.startsWith('assets/minecraft/models/block/') ||
        name.startsWith('assets/minecraft/models/item/')) &&
      name.endsWith('.json')
    ) {
      const relModelId =
        'minecraft:' +
        name.replace(/^assets\/minecraft\/models\//, '').replace(/\.json$/, '');
      modelsMap[relModelId] = zip.readJson(name);
      const outPath = path.join(extractedDir, name.replace(/^assets\/minecraft\//, ''));
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, zip.readEntry(name));
    } else if (shouldExtractTexture(name)) {
      const outPath = path.join(extractedDir, name.replace(/^assets\/minecraft\//, ''));
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, zip.readEntry(name));
      if (name.endsWith('.png')) extractedTextureCount++;
    } else if (name === 'assets/minecraft/lang/en_us.json') {
      enUsLang = zip.readJson(name);
      const outPath = path.join(extractedDir, 'lang', 'en_us.json');
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, zip.readEntry(name));
    }
  }

  // 3. Download zh_cn.json from Mojang official assetIndex
  let zhCnLang = {};
  const assetIndexInfo = verMeta.assetIndex;
  const assetIndexPath = path.join(verCacheDir, `assetIndex-${assetIndexInfo.id}.json`);
  await downloadFile(assetIndexInfo.url, assetIndexPath, {
    sha1: assetIndexInfo.sha1,
    label: `MC ${mcVersion} assetIndex (${assetIndexInfo.id})`
  });
  const assetIndex = JSON.parse(await fsp.readFile(assetIndexPath, 'utf8'));
  const zhEntry = assetIndex.objects?.['minecraft/lang/zh_cn.json'];
  if (zhEntry) {
    const hashPrefix = zhEntry.hash.slice(0, 2);
    const zhDest = path.join(extractedDir, 'lang', 'zh_cn.json');
    let downloadedZh = false;
    for (const mirrorBase of RESOURCES_MIRRORS) {
      const zhUrl = `${mirrorBase}/${hashPrefix}/${zhEntry.hash}`;
      try {
        await downloadFile(zhUrl, zhDest, {
          sha1: zhEntry.hash,
          label: `MC ${mcVersion} zh_cn.json`
        });
        downloadedZh = true;
        break;
      } catch (err) {
        console.warn(`  [warn] Mirror failed (${zhUrl}): ${err.message}, trying next...`);
      }
    }
    if (downloadedZh) {
      zhCnLang = JSON.parse(await fsp.readFile(zhDest, 'utf8'));
    }
  }

  // 4. Download server.jar & run Mojang Official DataGen (--reports)
  const serverDl = verMeta.downloads.server;
  const serverJarPath = path.join(verCacheDir, 'server.jar');
  await downloadFile(serverDl.url, serverJarPath, {
    sha1: serverDl.sha1,
    label: `MC ${mcVersion} server.jar`
  });

  const datagenOutDir = path.join(extractedDir, 'datagen');
  const blocksReportPath = path.join(datagenOutDir, 'reports', 'blocks.json');
  const registriesReportPath = path.join(datagenOutDir, 'reports', 'registries.json');

  if (!fs.existsSync(blocksReportPath) || !fs.existsSync(registriesReportPath)) {
    console.log(`  [datagen] Running Mojang Data Generator (--reports) for ${mcVersion}...`);
    await fsp.mkdir(datagenOutDir, { recursive: true });
    execFileSync(
      javaBin,
      [
        '-DbundlerMainClass=net.minecraft.data.Main',
        '-jar',
        serverJarPath,
        '--reports',
        '--output',
        datagenOutDir
      ],
      { cwd: verCacheDir, stdio: 'inherit' }
    );
  } else {
    console.log(`  [datagen] Cached Mojang DataGen reports found for ${mcVersion}`);
  }

  const blocksReport = JSON.parse(await fsp.readFile(blocksReportPath, 'utf8'));
  const registriesReport = JSON.parse(await fsp.readFile(registriesReportPath, 'utf8'));
  const blockEntitiesSet = new Set(
    Object.keys(registriesReport['minecraft:block_entity_type']?.entries || {})
  );

  // 5. Build unified blocks-registry.json for fast frontend/desktop queries
  const blocksRegistry = {};
  for (const [blockId, info] of Object.entries(blocksReport)) {
    const shortName = blockId.replace(/^minecraft:/, '');
    const langKey = `block.minecraft.${shortName}`;
    let defaultProps = {};
    for (const st of info.states || []) {
      if (st.default) {
        defaultProps = st.properties || {};
        break;
      }
    }
    blocksRegistry[blockId] = {
      properties: info.properties || {},
      defaultState: defaultProps,
      stateCount: (info.states || []).length,
      nameEn: enUsLang[langKey] || shortName,
      nameZh: zhCnLang[langKey] || enUsLang[langKey] || shortName,
      hasBlockEntity: blockEntitiesSet.has(blockId)
    };
  }

  await fsp.writeFile(
    path.join(bundleDir, 'blockstates.json'),
    JSON.stringify(blockstatesMap)
  );
  await fsp.writeFile(
    path.join(bundleDir, 'models.json'),
    JSON.stringify(modelsMap)
  );
  await fsp.writeFile(
    path.join(bundleDir, 'blocks-registry.json'),
    JSON.stringify(blocksRegistry, null, 2)
  );

  const summary = {
    mcVersion,
    dataVersion: mcVersionMeta?.world_version ?? null,
    resourcePackVersion: mcVersionMeta?.pack_version?.resource ?? mcVersionMeta?.pack_version ?? null,
    counts: {
      blocksInRegistry: Object.keys(blocksRegistry).length,
      blockstates: Object.keys(blockstatesMap).length,
      models: Object.keys(modelsMap).length,
      texturesPng: extractedTextureCount,
      blockEntityTypes: blockEntitiesSet.size,
      zhCnEntries: Object.keys(zhCnLang).length
    },
    generatedAt: new Date().toISOString()
  };

  await fsp.writeFile(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log(`  [done] MC ${mcVersion} bundle ready:`, summary.counts);
  return { summary, blocksRegistry };
}

async function main() {
  const cfg = loadConfig();
  const javaBin = resolveJava('jdk21');
  console.log(`[Assets] Using Java: ${javaBin}`);

  const manifest = await fetchJson(MOJANG_MANIFEST_URL);
  const results = {};

  for (const ver of cfg.assetVersions) {
    results[ver] = await setupVersionAssets(ver, manifest, javaBin);
  }

  // Generate cross-version compatibility matrix between 1.20.1 and 1.21.11
  if (results['1.20.1'] && results['1.21.11']) {
    const reg120 = results['1.20.1'].blocksRegistry;
    const reg121 = results['1.21.11'].blocksRegistry;

    const onlyIn120 = Object.keys(reg120).filter((k) => !reg121[k]);
    const onlyIn121 = Object.keys(reg121).filter((k) => !reg120[k]);
    const propertyDiffs = [];

    for (const k of Object.keys(reg120)) {
      if (!reg121[k]) continue;
      const p120 = JSON.stringify(reg120[k].properties);
      const p121 = JSON.stringify(reg121[k].properties);
      if (p120 !== p121) {
        propertyDiffs.push({
          blockId: k,
          props1201: Object.keys(reg120[k].properties),
          props12111: Object.keys(reg121[k].properties)
        });
      }
    }

    const compatReport = {
      baseVersion: '1.20.1',
      targetVersion: '1.21.11',
      dataVersion1201: results['1.20.1'].summary.dataVersion,
      dataVersion12111: results['1.21.11'].summary.dataVersion,
      knownAliases: {
        'minecraft:grass': 'minecraft:short_grass'
      },
      removedOrRenamedFrom1201: onlyIn120,
      addedIn12111Count: onlyIn121.length,
      addedIn12111Sample: onlyIn121.slice(0, 40),
      propertySchemaChangedBlocks: propertyDiffs
    };

    const compatPath = path.join(ASSETS_DIR, 'bundle', 'cross-version-compat.json');
    await fsp.writeFile(compatPath, JSON.stringify(compatReport, null, 2));
    console.log(
      `\n[Compat] Generated 1.20.1 <-> 1.21.11 diff matrix: ` +
        `${onlyIn120.length} renamed/removed, ${onlyIn121.length} added, ${propertyDiffs.length} property-changed blocks.`
    );
  }
}

main().catch((err) => {
  console.error('[Assets] Setup failed:', err);
  process.exit(1);
});
