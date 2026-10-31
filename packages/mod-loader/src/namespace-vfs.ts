import { unzipSync } from 'fflate';
import { normalizeNamespace } from '@mcvis/core';

export interface ModArchiveSummary {
  fileName: string;
  loaders: string[];
  mods: Array<{ modId: string; name: string; version: string; loader: string }>;
  namespaces: string[];
  blockstateCount: number;
  modelCount: number;
  objCount: number;
  textureCount: number;
  nestedJars: number;
}

export interface BlockRegistryMeta {
  properties: Record<string, string[]>;
  defaultState: Record<string, string>;
  stateCount: number;
  nameEn: string;
  nameZh: string;
  hasBlockEntity: boolean;
}

export interface VanillaAssetBundle {
  mcVersion: string;
  blockstates: Record<string, unknown>;
  models: Record<string, unknown>;
  blocksRegistry: Record<string, BlockRegistryMeta>;
  /** Base URL or path prefix to resolve `minecraft:block/<tex>` -> `<baseUrl>/textures/block/<tex>.png` */
  textureBaseUrl?: string;
}

function parseModsTomlLite(tomlText: string, loaderName: string) {
  const out: Array<{ modId: string; name: string; version: string; loader: string }> = [];
  const sections = tomlText.split(/\[\[\s*mods\s*\]\]/g).slice(1);
  for (const sec of sections) {
    const end = sec.search(/^\s*\[/m);
    const body = end >= 0 ? sec.slice(0, end) : sec;
    const modId = body.match(/modId\s*=\s*["']([^"']+)["']/)?.[1];
    const displayName = body.match(/displayName\s*=\s*["']([^"']+)["']/)?.[1];
    const version = body.match(/version\s*=\s*["']([^"']+)["']/)?.[1];
    if (modId) {
      out.push({
        modId,
        name: displayName || modId,
        version: version || 'unknown',
        loader: loaderName
      });
    }
  }
  return out;
}

export class NamespaceVirtualFS {
  private vanillaBundles = new Map<string, VanillaAssetBundle>();
  private activeVanillaVersion = '1.21.11';

  // Modded & ResourcePack overlays keyed by normalized IDs:
  // blockstates: "namespace:block_name" -> JSON
  private modBlockstates = new Map<string, Record<string, unknown>>();
  // models: "namespace:block/foo" or "namespace:item/foo" -> JSON
  private modModels = new Map<string, Record<string, unknown>>();
  // raw text files (e.g. .obj, .mtl): "namespace:models/block/foo.obj" -> string
  private modTextAssets = new Map<string, string>();
  // textures: "namespace:block/foo" -> Uint8Array PNG bytes
  private modTextures = new Map<string, Uint8Array>();
  // localized names: "block.namespace.id" -> { zh?: string, en?: string }
  private modLangZh = new Map<string, string>();
  private modLangEn = new Map<string, string>();

  private mountedArchives: ModArchiveSummary[] = [];
  private decoder = new TextDecoder('utf-8');

  registerVanillaBundle(bundle: VanillaAssetBundle): void {
    this.vanillaBundles.set(bundle.mcVersion, bundle);
    this.activeVanillaVersion = bundle.mcVersion;
  }

  setActiveVanillaVersion(mcVersion: '1.20.1' | '1.21.11' | string): void {
    if (this.vanillaBundles.has(mcVersion)) {
      this.activeVanillaVersion = mcVersion;
    }
  }

  getActiveVanillaVersion(): string {
    return this.activeVanillaVersion;
  }

  getActiveVanillaBundle(): VanillaAssetBundle | undefined {
    return (
      this.vanillaBundles.get(this.activeVanillaVersion) ??
      this.vanillaBundles.values().next().value
    );
  }

  getMountedArchives(): ModArchiveSummary[] {
    return [...this.mountedArchives];
  }

  getMountedNamespaces(): Set<string> {
    const set = new Set<string>(['minecraft']);
    for (const a of this.mountedArchives) {
      for (const ns of a.namespaces) set.add(ns);
    }
    for (const k of this.modBlockstates.keys()) {
      set.add(k.split(':')[0]!);
    }
    return set;
  }

  listMountedModBlockIds(limit = 120): string[] {
    const out: string[] = [];
    for (const id of this.modBlockstates.keys()) {
      if (!id.startsWith('minecraft:')) {
        out.push(id);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Mounts ANY Forge, NeoForge, Fabric, Quilt .jar or ResourcePack .zip in memory,
   * including recursive Jar-in-Jar (META-INF/jars/*.jar)!
   */
  mountModArchive(archiveBytes: Uint8Array, fileName: string, depth = 0): ModArchiveSummary {
    const files = unzipSync(archiveBytes);
    const loaders = new Set<string>();
    const mods: Array<{ modId: string; name: string; version: string; loader: string }> = [];
    const namespaces = new Set<string>();

    let blockstateCount = 0;
    let modelCount = 0;
    let objCount = 0;
    let textureCount = 0;
    let nestedJars = 0;

    // 1. Loader metadata detection
    if (files['META-INF/neoforge.mods.toml']) {
      loaders.add('neoforge');
      const txt = this.decoder.decode(files['META-INF/neoforge.mods.toml']);
      mods.push(...parseModsTomlLite(txt, 'neoforge'));
    }
    if (files['META-INF/mods.toml']) {
      const txt = this.decoder.decode(files['META-INF/mods.toml']);
      const ldr = txt.includes('neoforge') ? 'neoforge' : 'forge';
      loaders.add(ldr);
      mods.push(...parseModsTomlLite(txt, ldr));
    }
    if (files['fabric.mod.json']) {
      loaders.add('fabric');
      try {
        const fm = JSON.parse(this.decoder.decode(files['fabric.mod.json']));
        if (fm?.id) {
          mods.push({
            modId: fm.id,
            name: fm.name || fm.id,
            version: fm.version || 'unknown',
            loader: 'fabric'
          });
        }
      } catch {
        // ignore malformed json
      }
    }
    if (files['quilt.mod.json']) {
      loaders.add('quilt');
      try {
        const qm = JSON.parse(this.decoder.decode(files['quilt.mod.json']));
        const id = qm?.quilt_loader?.id;
        if (id) {
          mods.push({
            modId: id,
            name: qm.quilt_loader?.metadata?.name || id,
            version: qm.quilt_loader?.version || 'unknown',
            loader: 'quilt'
          });
        }
      } catch {
        // ignore
      }
    }
    if (files['mcmod.info']) {
      loaders.add('forge-legacy');
    }
    if (loaders.size === 0 && files['pack.mcmeta']) {
      loaders.add('resourcepack');
    }

    // 2. Ingest assets/<namespace>/**
    for (const [entryPath, bytes] of Object.entries(files)) {
      if (bytes.length === 0 && entryPath.endsWith('/')) continue;

      if (depth < 2 && entryPath.startsWith('META-INF/jars/') && entryPath.endsWith('.jar')) {
        try {
          const sub = this.mountModArchive(bytes, `${fileName}!/${entryPath}`, depth + 1);
          nestedJars += 1 + sub.nestedJars;
          for (const ns of sub.namespaces) namespaces.add(ns);
          blockstateCount += sub.blockstateCount;
          modelCount += sub.modelCount;
          objCount += sub.objCount;
          textureCount += sub.textureCount;
        } catch {
          // ignore unreadable nested archive
        }
        continue;
      }

      this.ingestAssetEntry(entryPath, bytes, namespaces, {
        onBlockstate: () => blockstateCount++,
        onModel: () => modelCount++,
        onObj: () => objCount++,
        onTexture: () => textureCount++
      });
    }

    const summary: ModArchiveSummary = {
      fileName,
      loaders: Array.from(loaders),
      mods,
      namespaces: Array.from(namespaces),
      blockstateCount,
      modelCount,
      objCount,
      textureCount,
      nestedJars
    };

    if (depth === 0) {
      this.mountedArchives.push(summary);
    }
    return summary;
  }

  /**
   * Mounts loose KubeJS or unpacked ResourcePack files (e.g. `kubejs/assets/<ns>/...`).
   */
  mountLooseAssetFiles(
    files: Array<{ path: string; data: Uint8Array }>,
    sourceLabel = 'kubejs/assets'
  ): ModArchiveSummary {
    const namespaces = new Set<string>();
    let blockstateCount = 0;
    let modelCount = 0;
    let objCount = 0;
    let textureCount = 0;

    for (const f of files) {
      const normalizedPath = f.path.replace(/\\/g, '/').replace(/^.*?assets\//, 'assets/');
      this.ingestAssetEntry(normalizedPath, f.data, namespaces, {
        onBlockstate: () => blockstateCount++,
        onModel: () => modelCount++,
        onObj: () => objCount++,
        onTexture: () => textureCount++
      });
    }

    const summary: ModArchiveSummary = {
      fileName: sourceLabel,
      loaders: ['kubejs/loose'],
      mods: [{ modId: 'kubejs', name: 'KubeJS Custom Assets', version: 'local', loader: 'kubejs' }],
      namespaces: Array.from(namespaces),
      blockstateCount,
      modelCount,
      objCount,
      textureCount,
      nestedJars: 0
    };
    this.mountedArchives.push(summary);
    return summary;
  }

  private ingestAssetEntry(
    entryPath: string,
    bytes: Uint8Array,
    namespaces: Set<string>,
    hooks: {
      onBlockstate: () => void;
      onModel: () => void;
      onObj: () => void;
      onTexture: () => void;
    }
  ): void {
    const m = entryPath.match(/^assets\/([^/]+)\/(.+)$/);
    if (!m) return;
    const [, ns, rest] = m as [string, string, string];
    namespaces.add(ns);

    if (rest.startsWith('blockstates/') && rest.endsWith('.json')) {
      try {
        const id = `${ns}:${rest.slice('blockstates/'.length, -'.json'.length)}`;
        this.modBlockstates.set(id, JSON.parse(this.decoder.decode(bytes)));
        hooks.onBlockstate();
      } catch {
        // ignore invalid json
      }
    } else if (rest.startsWith('models/') && rest.endsWith('.json')) {
      try {
        const modelKey = `${ns}:${rest.slice('models/'.length, -'.json'.length)}`;
        this.modModels.set(modelKey, JSON.parse(this.decoder.decode(bytes)));
        hooks.onModel();
      } catch {
        // ignore
      }
    } else if (rest.endsWith('.obj') || rest.endsWith('.mtl')) {
      this.modTextAssets.set(`${ns}:${rest}`, this.decoder.decode(bytes));
      if (rest.endsWith('.obj')) hooks.onObj();
    } else if (rest.startsWith('textures/') && rest.endsWith('.png')) {
      const texKey = `${ns}:${rest.slice('textures/'.length, -'.png'.length)}`;
      this.modTextures.set(texKey, bytes);
      hooks.onTexture();
    } else if (rest === 'lang/zh_cn.json' || rest === 'lang/en_us.json') {
      try {
        const dict = JSON.parse(this.decoder.decode(bytes)) as Record<string, string>;
        const target = rest.includes('zh_cn') ? this.modLangZh : this.modLangEn;
        for (const [k, v] of Object.entries(dict)) {
          if (typeof v === 'string') target.set(k, v);
        }
      } catch {
        // ignore
      }
    }
  }

  getBlockstateJson(blockId: string): Record<string, unknown> | undefined {
    const norm = normalizeNamespace(blockId);
    const modded = this.modBlockstates.get(norm);
    if (modded) return modded;
    const vanilla = this.getActiveVanillaBundle();
    return vanilla?.blockstates[norm] as Record<string, unknown> | undefined;
  }

  getModelJson(modelRef: string): Record<string, unknown> | undefined {
    const norm = normalizeModelRef(modelRef);
    const modded = this.modModels.get(norm);
    if (modded) return modded;
    const vanilla = this.getActiveVanillaBundle();
    return vanilla?.models[norm] as Record<string, unknown> | undefined;
  }

  getTextAsset(assetRef: string): string | undefined {
    const norm = normalizeNamespace(assetRef);
    return this.modTextAssets.get(norm);
  }

  getModTextureBytes(texRef: string): Uint8Array | undefined {
    const norm = normalizeTextureRef(texRef);
    return this.modTextures.get(norm);
  }

  getVanillaTextureUrl(texRef: string): string | undefined {
    const norm = normalizeTextureRef(texRef);
    if (!norm.startsWith('minecraft:')) return undefined;
    const bundle = this.getActiveVanillaBundle();
    if (!bundle?.textureBaseUrl) return undefined;
    const rel = norm.slice('minecraft:'.length);
    return `${bundle.textureBaseUrl.replace(/\/$/, '')}/textures/${rel}.png`;
  }

  getBlockDisplayName(blockId: string, preferZh = true): string {
    const norm = normalizeNamespace(blockId);
    const [ns, name] = norm.split(':') as [string, string];
    const langKey = `block.${ns}.${name}`;

    if (preferZh && this.modLangZh.has(langKey)) return this.modLangZh.get(langKey)!;
    if (this.modLangEn.has(langKey)) return this.modLangEn.get(langKey)!;

    const bundle = this.getActiveVanillaBundle();
    const meta = bundle?.blocksRegistry[norm];
    if (meta) {
      return preferZh ? meta.nameZh : meta.nameEn;
    }
    return norm;
  }

  /** Every block id in the active vanilla registry, with its display names (for block pickers). */
  listRegistryBlocks(): Array<{ id: string; nameEn: string; nameZh: string }> {
    const reg = this.getActiveVanillaBundle()?.blocksRegistry;
    if (!reg) return [];
    return Object.entries(reg).map(([id, meta]) => ({ id, nameEn: meta.nameEn, nameZh: meta.nameZh }));
  }

  getBlockRegistryMeta(blockId: string): BlockRegistryMeta | undefined {
    return this.getActiveVanillaBundle()?.blocksRegistry[normalizeNamespace(blockId)];
  }

  /**
   * Mounts a Modrinth `.mrpack` modpack archive:
   * - Ingests `overrides/kubejs/assets/...` & `client-overrides/kubejs/assets/...`
   * - Mounts embedded `.jar` / `.zip` resourcepacks in `overrides/`
   * - Parses `modrinth.index.json` and returns downloadable Modrinth CDN URLs
   */
  mountMrpackArchive(mrpackBytes: Uint8Array, fileName: string): MrpackImportSummary {
    const entries = unzipSync(mrpackBytes);
    const namespaces = new Set<string>();
    let kubeJsAssets = 0;
    let embeddedArchives = 0;
    let packName = fileName.replace(/\.mrpack$/i, '');
    let mcVersion = '';
    const modDownloads: Array<{ fileName: string; url: string }> = [];

    const indexBytes = entries['modrinth.index.json'];
    if (indexBytes) {
      try {
        const indexJson = JSON.parse(this.decoder.decode(indexBytes)) as {
          name?: string;
          dependencies?: Record<string, string>;
          files?: Array<{ path?: string; downloads?: string[] }>;
        };
        if (indexJson.name) packName = indexJson.name;
        mcVersion = indexJson.dependencies?.minecraft ?? '';
        for (const f of indexJson.files ?? []) {
          const url = f.downloads?.[0];
          const p = f.path ?? '';
          if (url && p.toLowerCase().endsWith('.jar')) {
            const base = p.split('/').pop() || 'mod.jar';
            modDownloads.push({ fileName: base, url });
          }
        }
      } catch {
        // ignore malformed index
      }
    }

    for (const [entryPath, bytes] of Object.entries(entries)) {
      const clean = entryPath.replace(/\\/g, '/');
      const kubeMatch = clean.match(/^(?:overrides|client-overrides)\/kubejs\/(assets\/.+)$/);
      if (kubeMatch) {
        this.ingestAssetEntry(kubeMatch[1]!, bytes, namespaces, {
          onBlockstate: () => {
            kubeJsAssets++;
          },
          onModel: () => {
            kubeJsAssets++;
          },
          onObj: () => {
            kubeJsAssets++;
          },
          onTexture: () => {
            kubeJsAssets++;
          }
        });
        continue;
      }

      if (
        (clean.startsWith('overrides/mods/') ||
          clean.startsWith('overrides/resourcepacks/') ||
          clean.startsWith('client-overrides/resourcepacks/')) &&
        (clean.toLowerCase().endsWith('.jar') || clean.toLowerCase().endsWith('.zip'))
      ) {
        const subName = clean.split('/').pop() || clean;
        const subSummary = this.mountModArchive(bytes, subName, 1);
        for (const ns of subSummary.namespaces) namespaces.add(ns);
        embeddedArchives++;
      }
    }

    if (kubeJsAssets > 0) {
      this.mountedArchives.push({
        fileName: `${packName} (.mrpack KubeJS)`,
        loaders: ['mrpack'],
        mods: [{ modId: 'kubejs', name: packName, version: mcVersion || '1.0', loader: 'mrpack' }],
        namespaces: [...namespaces],
        blockstateCount: kubeJsAssets,
        modelCount: 0,
        objCount: 0,
        textureCount: 0,
        nestedJars: embeddedArchives
      });
    }

    return {
      packName,
      mcVersion,
      namespaces: [...namespaces],
      kubeJsAssets,
      embeddedArchives,
      modDownloads
    };
  }

  /**
   * Automatically resolves a missing mod namespace from Modrinth API (`api.modrinth.com/v2`),
   * downloads the matching 1.20.1 / 1.21.x `.jar` across Forge/NeoForge/Fabric/Quilt, and mounts it!
   */
  async fetchModJarFromModrinth(
    namespace: string,
    mcVersion: '1.20.1' | '1.21.11' | string
  ): Promise<ModArchiveSummary | null> {
    const SLUG_ALIASES: Record<string, string> = {
      ae2: 'ae2',
      appliedenergistics2: 'ae2',
      create: 'create',
      framedblocks: 'framedblocks',
      supplementaries: 'supplementaries',
      quark: 'quark',
      farmersdelight: 'farmers-delight',
      twilightforest: 'the-twilight-forest',
      immersiveengineering: 'immersiveengineering',
      botania: 'botania',
      mekanism: 'mekanism',
      chipped: 'chipped',
      rechiseled: 'rechiseled',
      biomesoplenty: 'biomes-o-plenty'
    };

    const normNs = namespace.trim().toLowerCase();
    if (!normNs || normNs === 'minecraft') return null;

    const candidateSlugs: string[] = [];
    if (SLUG_ALIASES[normNs]) candidateSlugs.push(SLUG_ALIASES[normNs]!);
    candidateSlugs.push(normNs, normNs.replace(/_/g, '-'));

    let projectId: string | null = null;
    for (const slug of candidateSlugs) {
      try {
        const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}`);
        if (r.ok) {
          const proj = (await r.json()) as { id?: string };
          if (proj.id) {
            projectId = proj.id;
            break;
          }
        }
      } catch {
        // continue
      }
    }

    if (!projectId) {
      try {
        const sr = await fetch(
          `https://api.modrinth.com/v2/search?query=${encodeURIComponent(normNs)}&limit=3&facets=${encodeURIComponent('[["project_type:mod"]]')}`
        );
        if (sr.ok) {
          const sdata = (await sr.json()) as { hits?: Array<{ project_id?: string }> };
          projectId = sdata.hits?.[0]?.project_id ?? null;
        }
      } catch {
        return null;
      }
    }

    if (!projectId) return null;

    // For 1.21.11 structures, most mods publish assets on 1.21.1 / 1.21.4 if 1.21.11 isn't tagged yet
    const versionCandidates = mcVersion.startsWith('1.20')
      ? ['1.20.1', '1.20.4']
      : ['1.21.11', '1.21.4', '1.21.1', '1.20.1'];

    const verQuery = encodeURIComponent(JSON.stringify(versionCandidates));
    const vr = await fetch(
      `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=${verQuery}`
    );
    if (!vr.ok) return null;
    const versions = (await vr.json()) as Array<{
      files?: Array<{ url?: string; filename?: string; primary?: boolean; size?: number }>;
    }>;
    if (!versions.length) return null;

    const chosenFile =
      versions[0]?.files?.find((f) => f.primary && f.filename?.endsWith('.jar')) ??
      versions[0]?.files?.find((f) => f.filename?.endsWith('.jar'));
    if (!chosenFile?.url || (chosenFile.size && chosenFile.size > 100 * 1024 * 1024)) {
      return null;
    }

    const jarResp = await fetch(chosenFile.url);
    if (!jarResp.ok) return null;
    const jarBytes = new Uint8Array(await jarResp.arrayBuffer());
    return this.mountModArchive(jarBytes, chosenFile.filename || `${normNs}.jar`);
  }
}

export interface MrpackImportSummary {
  packName: string;
  mcVersion: string;
  namespaces: string[];
  kubeJsAssets: number;
  embeddedArchives: number;
  modDownloads: Array<{ fileName: string; url: string }>;
}

export function normalizeModelRef(ref: string): string {
  const clean = ref.trim().replace(/\.json$/i, '');
  if (clean.includes(':')) return clean;
  return `minecraft:${clean}`;
}

export function normalizeTextureRef(ref: string): string {
  const clean = ref.trim().replace(/^textures\//, '').replace(/\.png$/i, '');
  if (clean.includes(':')) {
    const [ns, rest] = clean.split(':') as [string, string];
    return `${ns}:${rest.replace(/^textures\//, '')}`;
  }
  return `minecraft:${clean}`;
}
