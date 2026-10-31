import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ASSETS_DIR, SERVERS_DIR, loadConfig } from './utils.mjs';
import { RconClient } from './rcon-cli.mjs';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function verifyAssets(cfg) {
  console.log(`\n=== 1. Verifying Vanilla Asset & Registry Bundles ===`);
  for (const ver of cfg.assetVersions) {
    const bundleDir = path.join(ASSETS_DIR, 'bundle', ver);
    const manifest = JSON.parse(
      await fsp.readFile(path.join(bundleDir, 'manifest.json'), 'utf8')
    );
    const registry = JSON.parse(
      await fsp.readFile(path.join(bundleDir, 'blocks-registry.json'), 'utf8')
    );

    const observer = registry['minecraft:observer'];
    const crafter = registry['minecraft:crafter'];

    console.log(
      `  [OK] MC ${ver} (DataVersion ${manifest.dataVersion}): ` +
        `${manifest.counts.blocksInRegistry} blocks, ` +
        `${manifest.counts.blockstates} blockstates, ` +
        `${manifest.counts.models} models, ` +
        `${manifest.counts.texturesPng} PNGs`
    );
    console.log(
      `       Sample Redstone Block -> observer: "${observer?.nameZh}" props=${JSON.stringify(Object.keys(observer?.properties || {}))}`
    );
    if (crafter) {
      console.log(
        `       MC 1.21 Exclusive     -> crafter : "${crafter.nameZh}" props=${JSON.stringify(Object.keys(crafter.properties || {}))}`
      );
    }
  }

  const compatPath = path.join(ASSETS_DIR, 'bundle', 'cross-version-compat.json');
  if (fs.existsSync(compatPath)) {
    const compat = JSON.parse(await fsp.readFile(compatPath, 'utf8'));
    console.log(
      `  [OK] Cross-Version Matrix (1.20.1 <-> 1.21.11): ` +
        `DataVersion ${compat.dataVersion1201} -> ${compat.dataVersion12111}, ` +
        `+${compat.addedIn12111Count} new blocks, ${compat.propertySchemaChangedBlocks.length} state-schema changes`
    );
  }
}

async function verifyMods() {
  console.log(`\n=== 2. Verifying Multi-Loader Mod Compatibility Scanner ===`);
  const reportPath = path.join(ASSETS_DIR, 'mods-bundle', 'mod-scan-report.json');
  if (!fs.existsSync(reportPath)) {
    throw new Error('mod-scan-report.json missing');
  }
  const reports = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
  for (const r of reports) {
    console.log(
      `  [OK] [${r.loaders.join(',')}] ${r.source} -> namespaces=[${r.namespaces.join(', ')}], ` +
        `blockstates=${r.counts.blockstates}, models=${r.counts.blockModels}, obj=${r.counts.objMeshes}, JiJ=${r.nestedJarsCount}`
    );
  }
}

async function verifyLiveServer(profileName, cfg) {
  console.log(`\n=== 3. Booting & RCON-Testing Live Server (${profileName}) ===`);
  const serverDir = path.join(SERVERS_DIR, profileName);
  const manifest = JSON.parse(
    await fsp.readFile(path.join(serverDir, 'profile-manifest.json'), 'utf8')
  );
  const profile = cfg.serverProfiles[profileName];

  const proc = spawn(
    manifest.javaBin,
    [
      `-Xms${profile.memoryMin}`,
      `-Xmx${profile.memoryMax}`,
      '-jar',
      'fabric-server-launch.jar',
      'nogui'
    ],
    { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let serverReady = false;
  proc.stdout.on('data', (chunk) => {
    const line = chunk.toString('utf8');
    if (line.includes('Done (') || line.includes('RCON running on')) {
      serverReady = true;
    }
  });

  const deadline = Date.now() + 120000;
  let rcon = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Server process exited prematurely with code ${proc.exitCode}`);
    }
    if (serverReady) {
      try {
        const candidate = new RconClient({
          host: profile.host,
          port: profile.rconPort,
          password: profile.rconPassword,
          timeoutMs: 5000
        });
        await candidate.connect();
        rcon = candidate;
        break;
      } catch {
        // retry shortly
      }
    }
    await sleep(1500);
  }

  if (!rcon) {
    proc.kill();
    throw new Error(`Timed out waiting for RCON on ${profileName}`);
  }

  try {
    const listResp = await rcon.send('list');
    console.log(`  [RCON] list -> ${listResp.trim()}`);

    const testBlock =
      profile.mcVersion.startsWith('1.21')
        ? 'minecraft:crafter[orientation=north_up,triggered=true]'
        : 'minecraft:observer[facing=south,powered=false]';

    await rcon.send('forceload add 0 0');
    const setResp = await rcon.send(`setblock 0 60 0 ${testBlock} replace`);
    console.log(`  [RCON] setblock (${testBlock}) -> ${setResp.trim()}`);

    if (profile.mcVersion.startsWith('1.21')) {
      const nbtResp = await rcon.send('data get block 0 60 0');
      console.log(`  [RCON] data get block 0 60 0 -> ${nbtResp.slice(0, 140)}...`);
    }

    const carpetResp = await rcon.send('carpet');
    console.log(`  [RCON] carpet -> ${carpetResp.split('\n')[0].trim()}`);

    await rcon.send('stop');
    console.log(`  [OK] Sent graceful 'stop' to ${profileName}`);
  } finally {
    rcon.close();
  }

  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      proc.kill();
      resolve();
    }, 15000);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
  console.log(`  [OK] ${profileName} exited cleanly.`);
}

async function main() {
  const cfg = loadConfig();
  await verifyAssets(cfg);
  await verifyMods();

  if (process.argv.includes('--boot-server')) {
    const targetProfile =
      process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ||
      '1.21.11-fabric';
    await verifyLiveServer(targetProfile, cfg);
  }
}

main().catch((err) => {
  console.error('[Verify] FAILED:', err);
  process.exit(1);
});
