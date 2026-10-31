import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ASSETS_DIR,
  CACHE_DIR,
  downloadFile,
  fetchJson,
  loadConfig,
  openZipBuffer
} from './utils.mjs';

/**
 * Lightweight TOML extractor for Forge (mods.toml) and NeoForge (neoforge.mods.toml)
 * Extracts modId, displayName, version without external dependencies.
 */
function parseModsToml(tomlText, defaultLoader) {
  const mods = [];
  const blocks = tomlText.split(/\[\[\s*mods\s*\]\]/g).slice(1);
  for (const blk of blocks) {
    const endIdx = blk.search(/^\s*\[/m);
    const section = endIdx >= 0 ? blk.slice(0, endIdx) : blk;
    const modId = section.match(/modId\s*=\s*["']([^"']+)["']/)?.[1];
    const displayName = section.match(/displayName\s*=\s*["']([^"']+)["']/)?.[1];
    const version = section.match(/version\s*=\s*["']([^"']+)["']/)?.[1];
    if (modId) {
      mods.push({
        modId,
        name: displayName || modId,
        version: version || 'unknown',
        loader: defaultLoader
      });
    }
  }
  return mods;
}

/**
 * Recursively scans a Mod JAR / ResourcePack ZIP buffer (including nested Jar-in-Jar META-INF/jars/*.jar!)
 * Supports: Forge, NeoForge, Fabric, Quilt, Legacy Forge (mcmod.info), and ResourcePacks.
 */
export function scanModArchiveBuffer(buf, sourceLabel, depth = 0) {
  const zip = openZipBuffer(buf);
  const detectedMods = [];
  const loadersDetected = new Set();

  // 1. Detect Loader Metadata
  if (zip.has('META-INF/neoforge.mods.toml')) {
    loadersDetected.add('neoforge');
    const parsed = parseModsToml(zip.readText('META-INF/neoforge.mods.toml'), 'neoforge');
    detectedMods.push(...parsed);
  }
  if (zip.has('META-INF/mods.toml')) {
    const toml = zip.readText('META-INF/mods.toml');
    const isNeo = toml.includes('neoforge');
    const loader = isNeo ? 'neoforge/forge' : 'forge';
    loadersDetected.add(loader);
    detectedMods.push(...parseModsToml(toml, loader));
  }
  if (zip.has('fabric.mod.json')) {
    loadersDetected.add('fabric');
    try {
      const fm = zip.readJson('fabric.mod.json');
      detectedMods.push({
        modId: fm.id,
        name: fm.name || fm.id,
        version: fm.version || 'unknown',
        loader: 'fabric'
      });
    } catch {
      // ignore malformed json
    }
  }
  if (zip.has('quilt.mod.json')) {
    loadersDetected.add('quilt');
    try {
      const qm = zip.readJson('quilt.mod.json');
      const id = qm.quilt_loader?.id || 'unknown';
      detectedMods.push({
        modId: id,
        name: qm.quilt_loader?.metadata?.name || id,
        version: qm.quilt_loader?.version || 'unknown',
        loader: 'quilt'
      });
    } catch {
      // ignore
    }
  }
  if (zip.has('mcmod.info')) {
    loadersDetected.add('forge-legacy');
  }
  if (loadersDetected.size === 0 && zip.has('pack.mcmeta')) {
    loadersDetected.add('resourcepack');
  }

  // 2. Scan assets/<namespace>/...
  const namespaces = new Set();
  const counts = {
    blockstates: 0,
    blockModels: 0,
    itemModels: 0,
    objMeshes: 0,
    textures: 0,
    langFiles: 0,
    forgeMarkerBlockstates: 0,
    customLoaderModels: {}
  };
  const sampleBlocks = [];

  for (const entryName of zip.listNames()) {
    const assetMatch = entryName.match(/^assets\/([^/]+)\/(.+)$/);
    if (assetMatch) {
      const [, ns, rest] = assetMatch;
      namespaces.add(ns);

      if (rest.startsWith('blockstates/') && rest.endsWith('.json')) {
        counts.blockstates++;
        const blockName = path.basename(rest, '.json');
        if (sampleBlocks.length < 15 && ns !== 'minecraft') {
          sampleBlocks.push(`${ns}:${blockName}`);
        }
        try {
          const bs = zip.readJson(entryName);
          if (bs?.forge_marker) counts.forgeMarkerBlockstates++;
        } catch {
          // ignore non-strict json comments if any
        }
      } else if (rest.startsWith('models/block/') && rest.endsWith('.json')) {
        counts.blockModels++;
        try {
          const mdl = zip.readJson(entryName);
          if (mdl?.loader) {
            counts.customLoaderModels[mdl.loader] =
              (counts.customLoaderModels[mdl.loader] || 0) + 1;
          }
        } catch {
          // ignore
        }
      } else if (rest.startsWith('models/item/') && rest.endsWith('.json')) {
        counts.itemModels++;
      } else if (rest.endsWith('.obj')) {
        counts.objMeshes++;
      } else if (rest.startsWith('textures/') && rest.endsWith('.png')) {
        counts.textures++;
      } else if (
        rest === 'lang/zh_cn.json' ||
        rest === 'lang/en_us.json' ||
        rest === 'lang/zh_cn.lang' ||
        rest === 'lang/en_us.lang'
      ) {
        counts.langFiles++;
      }
    }
  }

  // 3. Recursively scan Jar-in-Jar (META-INF/jars/*.jar) up to depth 2
  const nestedJars = [];
  if (depth < 2) {
    for (const entryName of zip.listNames()) {
      if (entryName.startsWith('META-INF/jars/') && entryName.endsWith('.jar')) {
        try {
          const nestedBuf = zip.readEntry(entryName);
          const nestedResult = scanModArchiveBuffer(
            nestedBuf,
            `${sourceLabel}!/${entryName}`,
            depth + 1
          );
          nestedJars.push({
            jarPath: entryName,
            mods: nestedResult.detectedMods,
            namespaces: nestedResult.namespaces,
            counts: nestedResult.counts
          });
          for (const ns of nestedResult.namespaces) namespaces.add(ns);
        } catch {
          // skip unreadable nested archive
        }
      }
    }
  }

  return {
    source: sourceLabel,
    loaders: Array.from(loadersDetected),
    detectedMods,
    namespaces: Array.from(namespaces),
    counts,
    sampleBlocks,
    nestedJarsCount: nestedJars.length,
    nestedJars
  };
}

async function fetchModrinthFixture(fixture) {
  const { project, loader, mcVersion } = fixture;
  const url =
    `https://api.modrinth.com/v2/project/${encodeURIComponent(project)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify([loader]))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;

  const versions = await fetchJson(url);
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`No Modrinth version found for ${project} (${loader} ${mcVersion})`);
  }

  const chosen = versions[0];
  const primaryFile = chosen.files.find((f) => f.primary) || chosen.files[0];
  const destPath = path.join(
    CACHE_DIR,
    'test-mods',
    `${loader}-${mcVersion}`,
    primaryFile.filename
  );

  await downloadFile(primaryFile.url, destPath, {
    sha512: primaryFile.hashes?.sha512,
    label: `[${loader} ${mcVersion}] ${primaryFile.filename}`
  });

  return destPath;
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();

  const targetPaths = [];

  if (args.includes('--verify-fixtures')) {
    console.log(`[ModScanner] Downloading & verifying multi-loader Mod JAR fixtures...`);
    for (const fixture of cfg.modCompatibilityFixtures) {
      const jarPath = await fetchModrinthFixture(fixture);
      targetPaths.push(jarPath);
    }
  } else {
    for (const arg of args) {
      if (!arg.startsWith('--') && fs.existsSync(arg)) {
        const stat = await fsp.stat(arg);
        if (stat.isDirectory()) {
          const files = await fsp.readdir(arg);
          for (const f of files) {
            if (f.endsWith('.jar') || f.endsWith('.zip')) {
              targetPaths.push(path.join(arg, f));
            }
          }
        } else {
          targetPaths.push(arg);
        }
      }
    }
  }

  if (targetPaths.length === 0) {
    console.log(
      'Usage: node mc-env/scripts/scan-mods.mjs --verify-fixtures | <path-to-mod.jar-or-mods-dir>'
    );
    return;
  }

  const reports = [];
  for (const p of targetPaths) {
    const buf = await fsp.readFile(p);
    const report = scanModArchiveBuffer(buf, path.basename(p));
    reports.push(report);
    console.log(`\n  [Mod] ${report.source}`);
    console.log(`    Loaders     : ${report.loaders.join(', ')}`);
    console.log(
      `    Mods        : ${report.detectedMods.map((m) => `${m.modId}@${m.version}`).join(', ')}`
    );
    console.log(`    Namespaces  : ${report.namespaces.join(', ')}`);
    console.log(
      `    Assets      : ${report.counts.blockstates} blockstates, ` +
        `${report.counts.blockModels} block models, ${report.counts.objMeshes} OBJ meshes, ` +
        `${report.counts.textures} textures, ${report.nestedJarsCount} nested JiJ jars`
    );
    if (Object.keys(report.counts.customLoaderModels).length > 0) {
      console.log(`    ModelLoaders: ${JSON.stringify(report.counts.customLoaderModels)}`);
    }
  }

  const outDir = path.join(ASSETS_DIR, 'mods-bundle');
  await fsp.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'mod-scan-report.json');
  await fsp.writeFile(reportPath, JSON.stringify(reports, null, 2));
  console.log(`\n[ModScanner] Wrote multi-loader scan report to ${reportPath}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scan-mods.mjs')) {
  main().catch((err) => {
    console.error('[ModScanner] Error:', err);
    process.exit(1);
  });
}
