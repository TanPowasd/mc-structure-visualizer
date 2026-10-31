import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Camera,
  ClipboardPaste,
  Code2,
  Cpu,
  Download,
  Eye,
  FileUp,
  FolderArchive,
  Grid,
  Hammer,
  Layers,
  Package,
  Play,
  Redo2,
  RotateCw,
  Search,
  Server,
  Sparkles,
  Trash2,
  Undo2
} from 'lucide-react';
import {
  AI_PROVIDER_PRESETS,
  type AiChatMessage,
  type AiProviderKind,
  BUILTIN_SAMPLE_SCRIPTS,
  CustomBlockRegistry,
  type CustomBlockArchetype,
  type UniversalStructureIR,
  VoxelEditorSession,
  buildAiArchitectSystemPrompt,
  calculateBom,
  computeStructureBounds,
  convertStructureVersion,
  countStructureStats,
  extractDslFromLlmResponse,
  extractItemsFromBlockEntity,
  formatBlockState,
  generateOfflineParametricDsl,
  rotateStructureY90,
  runStructureDslScript,
  sanitizeAndExecuteAiDsl,
  unwrapNbtToJson
} from '@mcvis/core';
import {
  type ExportableFormatId,
  SUPPORTED_EXPORT_FORMATS,
  parseSchemOrSchematic,
  parseStructureAuto,
  serializeStructure,
  stringifySnbt,
  writeSchem
} from '@mcvis/formats';
import { NamespaceVirtualFS, UniversalModelCompiler } from '@mcvis/mod-loader';
import {
  type ImageImportMode,
  type PaletteFilterPreset,
  convertRgbaToStructure,
  cropAnvilMcaToStructure,
  import3dModelToStructure,
  importBlockbenchAsCustomBlock,
  importBlockbenchAsStructure,
  importMagicaVoxel
} from '@mcvis/importers';
import {
  type PickedVoxelInfo,
  type SliceAxis,
  type SliceConfig,
  type SliceMode,
  StructureViewportController,
  type ViewportProjectionMode
} from '@mcvis/renderer';
import type { DiscoveredModpackInstance, HostBridge } from './host-bridge.js';

type ActiveTab = 'inspect' | 'bom' | 'mods_custom' | 'importers' | 'dsl_ai' | 'live_server';
type ToolMode = 'inspect' | 'place' | 'erase';

export interface WorkbenchAppProps {
  bridge: HostBridge;
}

export function WorkbenchApp({ bridge }: WorkbenchAppProps) {
  const viewportHostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<StructureViewportController | null>(null);
  const vfsRef = useRef(new NamespaceVirtualFS());
  const customRegistryRef = useRef(new CustomBlockRegistry());
  const compilerRef = useRef(
    new UniversalModelCompiler(vfsRef.current, customRegistryRef.current)
  );
  const editorRef = useRef<VoxelEditorSession | null>(null);

  const [ir, setIr] = useState<UniversalStructureIR>(() =>
    runStructureDslScript(BUILTIN_SAMPLE_SCRIPTS[0]!.code)
  );
  const [renderVersion, setRenderVersion] = useState(0);
  const [mcAssetVersion, setMcAssetVersion] = useState<'1.21.11' | '1.20.1'>('1.21.11');
  const [triangleCount, setTriangleCount] = useState(0);

  const [projectionMode, setProjectionMode] = useState<ViewportProjectionMode>('3d_perspective');
  const [showOverlay, setShowOverlay] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [toolMode, setToolMode] = useState<ToolMode>('inspect');
  const [brushBlock, setBrushBlock] = useState('minecraft:copper_bulb[lit=true]');

  const [slice, setSlice] = useState<SliceConfig>({
    axis: 'y',
    mode: 'all',
    layer: 0,
    maxLayer: 5,
    ghostBelowLayer: true
  });

  const [activeTab, setActiveTab] = useState<ActiveTab>('inspect');
  const [picked, setPicked] = useState<PickedVoxelInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Replace state
  const [replaceFrom, setReplaceFrom] = useState('minecraft:cut_sandstone');
  const [replaceTo, setReplaceTo] = useState('minecraft:quartz_bricks');

  // Mods & Custom Blocks state
  const [mountedRev, setMountedRev] = useState(0);
  const [discoveredPacks, setDiscoveredPacks] = useState<DiscoveredModpackInstance[]>([]);
  const [cbId, setCbId] = useState('kubejs:void_alloy_casing');
  const [cbNameZh, setCbNameZh] = useState('虚空合金机壳');
  const [cbArchetype, setCbArchetype] = useState<CustomBlockArchetype>('directional_machine');
  const [cbColor, setCbColor] = useState('#38bdf8');
  const [cbTextureDataUrl, setCbTextureDataUrl] = useState<string>('');

  // Third-party importer state
  const [voxelResolution, setVoxelResolution] = useState(48);
  const [palettePreset, setPalettePreset] = useState<PaletteFilterPreset>('all_survival');
  const [voxExactCustom, setVoxExactCustom] = useState(false);
  const [imgArtMode, setImgArtMode] = useState<ImageImportMode>('map_art_staircased_3d');
  const [mcaMinCoords, setMcaMinCoords] = useState('0,54,0');
  const [mcaMaxCoords, setMcaMaxCoords] = useState('15,65,15');

  // DSL & AI + MCP Live Bridge state
  const [dslCode, setDslCode] = useState(BUILTIN_SAMPLE_SCRIPTS[0]!.code);
  const [aiPrompt, setAiPrompt] = useState('生成一座 15x14x15 的中式飞檐重檐阁楼，一层白墙花窗，二层暗海晶石攒尖顶');
  const [aiMode, setAiMode] = useState<'create' | 'modify'>('create');
  const [aiPresetId, setAiPresetId] = useState('gemini');
  const [aiProvider, setAiProvider] = useState<AiProviderKind>('gemini');
  const [aiEndpoint, setAiEndpoint] = useState('https://generativelanguage.googleapis.com/v1beta');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('gemini-2.5-flash');
  const [aiEnvKeyFlags, setAiEnvKeyFlags] = useState<Record<string, boolean>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHistory, setAiHistory] = useState<
    Array<{
      id: number;
      prompt: string;
      explanation: string;
      mode: 'create' | 'modify';
      provider: string;
      dslCode: string;
      snapshotIr: UniversalStructureIR;
    }>
  >([]);
  const [mcpConnected, setMcpConnected] = useState(false);
  const [mcpEvents, setMcpEvents] = useState<string[]>([]);

  // Live Server RCON state
  const [serverProfile, setServerProfile] = useState<'1.21.11-fabric' | '1.20.1-fabric'>(
    '1.21.11-fabric'
  );
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [modrinthFetching, setModrinthFetching] = useState(false);
  const [deployOrigin, setDeployOrigin] = useState('0,56,0');
  const [rconCmd, setRconCmd] = useState('carpet');
  const [rconLogs, setRconLogs] = useState<string[]>([]);

  const refreshServerStatus = useCallback(
    async (prof: '1.21.11-fabric' | '1.20.1-fabric' = serverProfile) => {
      if (!bridge.getServerStatus) return;
      try {
        const st = await bridge.getServerStatus(prof);
        setServerOnline(st.online);
      } catch {
        setServerOnline(false);
      }
    },
    [bridge, serverProfile]
  );

  useEffect(() => {
    if (activeTab === 'live_server') {
      void refreshServerStatus(serverProfile);
    }
  }, [activeTab, serverProfile, refreshServerStatus]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3800);
  }, []);

  // Initialize editor session whenever `ir` changes identity
  useEffect(() => {
    editorRef.current = new VoxelEditorSession(ir);
    const bounds = computeStructureBounds(ir);
    setSlice((prev) => ({
      ...prev,
      layer: 0,
      maxLayer: Math.max(0, bounds.size[prev.axis] - 1)
    }));
  }, [ir]);

  // Mount Three.js Viewport Controller & Load Vanilla Bundles (`1.21.11` & `1.20.1`)
  useEffect(() => {
    if (!viewportHostRef.current) return;
    const ctrl = new StructureViewportController(viewportHostRef.current);
    controllerRef.current = ctrl;

    (async () => {
      for (const ver of ['1.21.11', '1.20.1'] as const) {
        const bundle = await bridge.loadVanillaBundle(ver);
        if (bundle) {
          vfsRef.current.registerVanillaBundle(bundle);
        }
      }
      vfsRef.current.setActiveVanillaVersion('1.21.11');
      compilerRef.current.clearCache();
      setMountedRev((r) => r + 1);

      if (bridge.discoverModpacks) {
        const packs = await bridge.discoverModpacks().catch(() => []);
        setDiscoveredPacks(packs);
      }
      if (bridge.loadAiConfig) {
        const saved = await bridge.loadAiConfig().catch(() => null);
        if (saved) {
          setAiPresetId(saved.presetId || 'gemini');
          setAiProvider(saved.provider || 'gemini');
          setAiEndpoint(saved.endpoint || '');
          setAiModel(saved.model || '');
          if (saved.apiKey) setAiApiKey(saved.apiKey);
          if (saved.hasEnvKey) setAiEnvKeyFlags(saved.hasEnvKey);
        }
      }
    })();

    return () => {
      ctrl.dispose();
      controllerRef.current = null;
    };
  }, [bridge]);

  // Subscribe to Bidirectional MCP <-> Live Viewport Bridge Events
  useEffect(() => {
    if (!bridge.subscribeMcpEvents) return;
    setMcpConnected(true);
    const unsub = bridge.subscribeMcpEvents((ev) => {
      const timeStr = new Date(ev.timestamp || Date.now()).toLocaleTimeString();
      setMcpEvents((prev) => [`[${timeStr}] ${ev.summary}`, ...prev].slice(0, 30));
      if (ev.type === 'push_structure' && ev.schemBytes) {
        try {
          const incomingIr = parseSchemOrSchematic(ev.schemBytes);
          if (ev.dslCode) setDslCode(ev.dslCode);
          const targetVer = incomingIr.dataVersion <= 3700 ? '1.20.1' : '1.21.11';
          vfsRef.current.setActiveVanillaVersion(targetVer);
          setMcAssetVersion(targetVer);
          compilerRef.current.clearCache();
          setRenderVersion(0);
          setPicked(null);
          setIr(incomingIr);
          setToast(`⚡ ${ev.summary}`);
        } catch {
          // ignore malformed incoming schem
        }
      }
    });
    return () => {
      setMcpConnected(false);
      unsub();
    };
  }, [bridge]);

  // Automatically sync current 3D Viewport Structure to MCP Bridge Hub whenever `ir` updates
  useEffect(() => {
    if (!bridge.syncLiveStructure) return;
    const timer = setTimeout(() => {
      try {
        const schemBytes = writeSchem(ir);
        void bridge.syncLiveStructure?.({
          name: ir.name,
          mcVersion: ir.mcVersion,
          schemBytes,
          dslCode
        });
      } catch {
        // ignore serialization error on empty/transient state
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [bridge, ir, renderVersion, dslCode]);

  // Re-render 3D scene when structure, mounted assets, or custom blocks change
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    let cancelled = false;
    ctrl
      .loadAndRender(ir, vfsRef.current, compilerRef.current, slice, renderVersion === 0)
      .then((res) => {
        if (!cancelled) setTriangleCount(res.triangleCount);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ir, mountedRev, renderVersion]);

  // Fast mesh-only rebuild when slice parameters change!
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const res = ctrl.rebuildMeshesOnly(compilerRef.current, slice);
    setTriangleCount(res.triangleCount);
  }, [slice]);

  const loadNewStructure = useCallback(
    (nextIr: UniversalStructureIR, msg?: string) => {
      const targetVer = nextIr.dataVersion <= 3700 ? '1.20.1' : '1.21.11';
      vfsRef.current.setActiveVanillaVersion(targetVer);
      setMcAssetVersion(targetVer);
      compilerRef.current.clearCache();
      setRenderVersion(0);
      setPicked(null);
      setIr(nextIr);
      if (msg) notify(msg);
    },
    [notify]
  );

  // Unified File Drop / Open handler (supports all 7 structure formats + Mod JARs + 3D/VOX/BBModel/MCA/Pack!)
  const handleIngestFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      let mountedAnyJar = false;
      for (const file of files) {
        const lower = file.name.toLowerCase();
        const bytes = new Uint8Array(await file.arrayBuffer());

        try {
          if (lower.endsWith('.mrpack')) {
            const mr = vfsRef.current.mountMrpackArchive(bytes, file.name);
            mountedAnyJar = true;
            notify(
              `已解析整合包 ${mr.packName} (KubeJS 资源: ${mr.kubeJsAssets}, 索引模组: ${mr.modDownloads.length})`
            );
          } else if (lower.endsWith('.jar') || (lower.endsWith('.zip') && !lower.endsWith('.schem.zip'))) {
            const sum = vfsRef.current.mountModArchive(bytes, file.name);
            mountedAnyJar = true;
            notify(
              `已挂载模组/资源包 ${file.name} (${sum.loaders.join('/') || 'zip'}: ${sum.namespaces.join(', ')})`
            );
          } else if (lower.endsWith('.mcvis-pack.json')) {
            const cnt = customRegistryRef.current.importPack(new TextDecoder().decode(bytes));
            mountedAnyJar = true;
            notify(`已导入 ${cnt} 个自定义方块定义`);
          } else if (lower.endsWith('.vox')) {
            const voxIr = importMagicaVoxel(bytes, file.name, {
              palettePreset,
              generateExactCustomBlocks: voxExactCustom,
              customRegistry: customRegistryRef.current
            });
            compilerRef.current.clearCache();
            loadNewStructure(voxIr, `已导入 MagicaVoxel 体素模型: ${file.name}`);
          } else if (lower.endsWith('.obj') || lower.endsWith('.stl') || lower.endsWith('.glb')) {
            const meshIr = import3dModelToStructure(bytes, file.name, {
              targetMaxDimension: voxelResolution,
              palettePreset,
              customRegistry: customRegistryRef.current
            });
            loadNewStructure(meshIr, `已体素化导入 3D 模型: ${file.name}`);
          } else if (lower.endsWith('.bbmodel')) {
            const txt = new TextDecoder().decode(bytes);
            if (activeTab === 'mods_custom') {
              const def = importBlockbenchAsCustomBlock(txt, cbId);
              customRegistryRef.current.register(def);
              mountedAnyJar = true;
              notify(`已将 Blockbench 模型注册为自定义方块: ${def.id}`);
            } else {
              const bbIr = importBlockbenchAsStructure(txt, 1);
              loadNewStructure(bbIr, `已将 Blockbench 模型导入为多方块结构: ${file.name}`);
            }
          } else if (lower.endsWith('.mca')) {
            const parseVec = (s: string, fallback: [number, number, number]) => {
              const p = s.split(',').map((n) => parseInt(n.trim(), 10));
              return {
                x: Number.isFinite(p[0]) ? p[0]! : fallback[0],
                y: Number.isFinite(p[1]) ? p[1]! : fallback[1],
                z: Number.isFinite(p[2]) ? p[2]! : fallback[2]
              };
            };
            // Parse r.X.Z.mca coordinates from filename if present
            const rm = file.name.match(/r\.(-?\d+)\.(-?\d+)\.mca/i);
            const rx = rm ? parseInt(rm[1]!, 10) : 0;
            const rz = rm ? parseInt(rm[2]!, 10) : 0;
            const cropped = cropAnvilMcaToStructure(
              [{ regionX: rx, regionZ: rz, data: bytes }],
              { min: parseVec(mcaMinCoords, [0, 54, 0]), max: parseVec(mcaMaxCoords, [15, 65, 15]) },
              file.name
            );
            loadNewStructure(cropped, `已从存档区块 ${file.name} 截取选区结构`);
          } else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
            const bmp = await createImageBitmap(file);
            const maxArtDim = 128;
            const ratio = Math.min(1, maxArtDim / Math.max(bmp.width, bmp.height));
            const w = Math.max(1, Math.round(bmp.width * ratio));
            const h = Math.max(1, Math.round(bmp.height * ratio));
            const cnv = document.createElement('canvas');
            cnv.width = w;
            cnv.height = h;
            const ctx = cnv.getContext('2d')!;
            ctx.drawImage(bmp, 0, 0, w, h);
            const imgData = ctx.getImageData(0, 0, w, h);
            const artIr = convertRgbaToStructure(w, h, imgData.data, file.name, {
              mode: imgArtMode,
              palettePreset,
              customRegistry: customRegistryRef.current
            });
            loadNewStructure(artIr, `已生成图像结构 (${w}x${h}): ${file.name}`);
          } else {
            const parsed = parseStructureAuto(bytes, file.name);
            loadNewStructure(
              parsed,
              `成功加载结构: ${parsed.name} (${parsed.sourceFormat})`
            );
          }
        } catch (err) {
          notify(`文件解析失败 (${file.name}): ${(err as Error).message}`);
        }
      }

      if (mountedAnyJar) {
        compilerRef.current.clearCache();
        setMountedRev((r) => r + 1);
      }
    },
    [
      activeTab,
      cbId,
      imgArtMode,
      loadNewStructure,
      mcaMaxCoords,
      mcaMinCoords,
      notify,
      palettePreset,
      voxExactCustom,
      voxelResolution
    ]
  );

  // Pointer click in 3D/2D Viewport
  const pointerDownPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleCanvasPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const dist = Math.hypot(
      e.clientX - pointerDownPos.current.x,
      e.clientY - pointerDownPos.current.y
    );
    if (dist > 5) return; // camera orbit drag, not a voxel click

    const ctrl = controllerRef.current;
    const session = editorRef.current;
    if (!ctrl || !session) return;

    const hit = ctrl.pickVoxel(e.clientX, e.clientY);
    if (!hit) {
      ctrl.setHighlightedVoxel(null);
      setPicked(null);
      return;
    }

    if (toolMode === 'inspect') {
      ctrl.setHighlightedVoxel(hit.blockPos);
      setPicked(hit);
      if (e.altKey) {
        const pickedStr = formatBlockState(hit.state);
        setBrushBlock(pickedStr);
        notify(`已吸取画笔方块: ${pickedStr}`);
      }
    } else if (toolMode === 'place') {
      const changed = session.setBlock(
        hit.adjacentPos.x,
        hit.adjacentPos.y,
        hit.adjacentPos.z,
        brushBlock,
        `Place ${brushBlock}`
      );
      if (changed) setRenderVersion((v) => v + 1);
    } else if (toolMode === 'erase') {
      const changed = session.setBlock(
        hit.blockPos.x,
        hit.blockPos.y,
        hit.blockPos.z,
        'minecraft:air',
        'Erase Block'
      );
      if (changed) {
        ctrl.setHighlightedVoxel(null);
        setRenderVersion((v) => v + 1);
      }
    }
  };

  const handleExportFormat = async (fmtId: ExportableFormatId) => {
    try {
      const descriptor = SUPPORTED_EXPORT_FORMATS.find((f) => f.id === fmtId)!;
      const exportIr = { ...ir };
      if (fmtId === 'axiom_bp' && controllerRef.current) {
        exportIr.thumbnailPng = await controllerRef.current.captureThumbnailPng();
      }
      const data = serializeStructure(exportIr, fmtId);
      const blob =
        typeof data === 'string'
          ? new Blob([data], { type: descriptor.mimeType })
          : new Blob([data as BlobPart], { type: descriptor.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (ir.name || 'structure').replace(/[\\/:*?"<>|]/g, '_');
      a.href = url;
      a.download = `${safeName}${descriptor.extension}`;
      a.click();
      URL.revokeObjectURL(url);
      notify(`已导出: ${safeName}${descriptor.extension}`);
    } catch (err) {
      notify(`导出失败: ${(err as Error).message}`);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        notify('剪贴板为空');
        return;
      }
      const parsed = parseStructureAuto(text, 'clipboard');
      loadNewStructure(parsed, `已从剪贴板导入 (${parsed.sourceFormat})`);
    } catch (err) {
      notify(`剪贴板解析失败: ${(err as Error).message}`);
    }
  };

  const handleSwitchMcVersion = (ver: '1.21.11' | '1.20.1') => {
    setMcAssetVersion(ver);
    vfsRef.current.setActiveVanillaVersion(ver);
    compilerRef.current.clearCache();
    const converted = convertStructureVersion(ir, ver);
    setRenderVersion(0);
    setIr(converted);
    notify(`已切换并转换结构至 Minecraft ${ver} (DataVersion ${converted.dataVersion})`);
  };

  const handleGenerateParametricOrAi = async () => {
    setAiLoading(true);
    try {
      const bundle = vfsRef.current.getActiveVanillaBundle();
      const knownVanilla = bundle ? new Set(Object.keys(bundle.blocksRegistry)) : undefined;
      const customIds = customRegistryRef.current.list().map((c) => c.id);
      const modBlockSample = vfsRef.current.listMountedModBlockIds(80);
      const ctx = {
        mcVersion: mcAssetVersion,
        mode: aiMode,
        currentStructure: aiMode === 'modify' ? ir : undefined,
        mountedNamespaces: [...vfsRef.current.getMountedNamespaces()],
        sampleModBlocks: modBlockSample,
        customBlockIds: customIds
      };

      const envKeyReady =
        (aiProvider === 'gemini' && aiEnvKeyFlags.gemini) ||
        (aiEndpoint.includes('deepseek') && aiEnvKeyFlags.deepseek) ||
        (aiProvider === 'anthropic' && aiEnvKeyFlags.anthropic) ||
        (aiProvider === 'openai_compat' && aiEnvKeyFlags.openai);

      const useOffline =
        aiProvider === 'offline_parametric' ||
        ((aiProvider === 'gemini' || aiProvider === 'openai_compat' || aiProvider === 'anthropic') &&
          !aiApiKey.trim() &&
          !envKeyReady &&
          !aiEndpoint.includes('127.0.0.1') &&
          !aiEndpoint.includes('localhost'));

      if (useOffline) {
        const offline = generateOfflineParametricDsl(aiPrompt, ctx);
        const executed = sanitizeAndExecuteAiDsl(offline.code, {
          mcVersion: mcAssetVersion,
          baseStructure: aiMode === 'modify' ? ir : undefined,
          knownVanillaBlocks: knownVanilla
        });
        setDslCode(executed.cleanedCode);
        loadNewStructure(executed.ir, `✨ 离线参数化建筑引擎已生成: ${executed.ir.name}`);
        setAiHistory((prev) => [
          {
            id: Date.now(),
            prompt: aiPrompt,
            explanation: `${offline.explanation}（提示：在下方配置 Gemini / DeepSeek / OpenAI / Ollama 接口即可开启自由大模型生成）`,
            mode: aiMode,
            provider: '离线建筑引擎',
            dslCode: executed.cleanedCode,
            snapshotIr: executed.ir
          },
          ...prev
        ]);
        return;
      }

      const sysPrompt = buildAiArchitectSystemPrompt(ctx);
      const historyMsgs: AiChatMessage[] = [];
      for (const h of aiHistory.slice(0, 3).reverse()) {
        historyMsgs.push({ role: 'user', content: h.prompt });
        historyMsgs.push({ role: 'assistant', content: `\`\`\`javascript\n${h.dslCode}\n\`\`\`` });
      }
      historyMsgs.push({ role: 'user', content: aiPrompt });

      const callBackendLlm = async (messages: AiChatMessage[], temperature = 0.25) => {
        if (bridge.aiChat) {
          return await bridge.aiChat({
            provider: aiProvider,
            endpoint: aiEndpoint,
            model: aiModel,
            apiKey: aiApiKey.trim(),
            systemPrompt: sysPrompt,
            messages,
            temperature
          });
        }
        // Static web fallback
        const resp = await fetch(aiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(aiApiKey.trim() ? { Authorization: `Bearer ${aiApiKey.trim()}` } : {})
          },
          body: JSON.stringify({
            model: aiModel,
            messages: [{ role: 'system', content: sysPrompt }, ...messages],
            temperature
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        return {
          content: String(json.choices?.[0]?.message?.content ?? ''),
          provider: aiProvider,
          model: aiModel
        };
      };

      const firstResp = await callBackendLlm(historyMsgs, 0.25);
      const extracted = extractDslFromLlmResponse(firstResp.content);

      let finalIr: UniversalStructureIR;
      let finalCode = extracted.code;
      let finalNote = extracted.explanation || '已由 AI 生成并通过方块注册表校验。';
      let repaired = false;

      try {
        const res = sanitizeAndExecuteAiDsl(extracted.code, {
          mcVersion: mcAssetVersion,
          baseStructure: aiMode === 'modify' ? ir : undefined,
          knownVanillaBlocks: knownVanilla
        });
        finalIr = res.ir;
        finalCode = res.cleanedCode;
        if (res.fixedBlocks > 0) {
          finalNote += `（自动修正 ${res.fixedBlocks} 个方块名）`;
        }
      } catch (firstErr) {
        notify('检测到生成代码存在语法偏差，正在自动触发 AI 自修复重试...');
        const repairResp = await callBackendLlm(
          [
            ...historyMsgs,
            { role: 'assistant', content: firstResp.content },
            {
              role: 'user',
              content: `Execution failed with error: ${(firstErr as Error).message}\nFix the JavaScript DSL and return ONLY a valid \`\`\`javascript block ending with \`return b.build();\`.`
            }
          ],
          0.1
        );
        const repExt = extractDslFromLlmResponse(repairResp.content);
        const res = sanitizeAndExecuteAiDsl(repExt.code, {
          mcVersion: mcAssetVersion,
          baseStructure: aiMode === 'modify' ? ir : undefined,
          knownVanillaBlocks: knownVanilla
        });
        finalIr = res.ir;
        finalCode = res.cleanedCode;
        repaired = true;
      }

      setDslCode(finalCode);
      loadNewStructure(
        finalIr,
        `🤖 AI 结构生成成功 (${firstResp.model}${repaired ? ' · 自动自愈' : ''})！`
      );
      setAiHistory((prev) => [
        {
          id: Date.now(),
          prompt: aiPrompt,
          explanation: finalNote,
          mode: aiMode,
          provider: `${firstResp.provider}:${firstResp.model}`,
          dslCode: finalCode,
          snapshotIr: finalIr
        },
        ...prev
      ]);
    } catch (err) {
      notify(`AI 生成失败: ${(err as Error).message}`);
    } finally {
      setAiLoading(false);
    }
  };

  const stats = useMemo(() => countStructureStats(ir), [ir, renderVersion]);
  const bounds = useMemo(() => computeStructureBounds(ir), [ir, renderVersion]);
  const bom = useMemo(
    () =>
      calculateBom(
        ir,
        slice.mode === 'all'
          ? undefined
          : {
              layerRange: {
                axis: slice.axis,
                min: slice.mode === 'below' ? 0 : slice.layer,
                max: slice.mode === 'range' ? slice.maxLayer : slice.layer
              }
            }
      ),
    [ir, renderVersion, slice]
  );

  const mountedNamespaces = useMemo(
    () => vfsRef.current.getMountedNamespaces(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mountedRev]
  );

  const axisMax = Math.max(0, bounds.size[slice.axis] - 1);

  return (
    <div
      className="mcvis-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) {
          handleIngestFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Top Studio Bar */}
      <header className="mcvis-topbar">
        <div className="mcvis-brand">
          <Box size={18} color="#38bdf8" />
          <span>MC 结构全生态可视化工作台</span>
          <span className="mcvis-badge">
            {bridge.platform === 'desktop-tauri' ? 'Desktop Native (Tauri v2)' : 'Web Studio'}
          </span>
          <button
            type="button"
            className="mcvis-badge"
            onClick={() => setActiveTab('dsl_ai')}
            title="点击打开 AI 结构生成与 MCP / API 实时桥接中心"
            style={{
              cursor: 'pointer',
              border: '1px solid rgba(52, 211, 153, 0.35)',
              background: mcpConnected ? 'rgba(16, 185, 129, 0.16)' : 'rgba(148, 163, 184, 0.16)',
              color: mcpConnected ? '#34d399' : '#94a3b8'
            }}
          >
            {mcpConnected ? '● MCP 桥接就绪' : '○ MCP 离线'}
          </button>
        </div>

        <div className="mcvis-toolbar-group">
          <label className="mcvis-btn primary" style={{ cursor: 'pointer' }}>
            <FileUp size={14} />
            <span>打开文件 / 模组 / 3D导入</span>
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              accept=".litematic,.schem,.schematic,.nbt,.bp,.blueprint,.json,.mcfunction,.jar,.zip,.mrpack,.vox,.obj,.stl,.glb,.bbmodel,.mca,.png,.jpg,.webp"
              onChange={(e) => {
                if (e.target.files) handleIngestFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>

          <button className="mcvis-btn" onClick={handlePasteClipboard} title="粘贴 Building Gadgets JSON 或原版 F3+I /setblock 指令">
            <ClipboardPaste size={14} />
            <span>剪贴板导入</span>
          </button>

          <select
            className="mcvis-select"
            defaultValue=""
            onChange={(e) => {
              const sample = BUILTIN_SAMPLE_SCRIPTS.find((s) => s.id === e.target.value);
              if (sample) {
                setDslCode(sample.code);
                loadNewStructure(runStructureDslScript(sample.code), `已加载示例: ${sample.title}`);
              }
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              快速内置示例...
            </option>
            {BUILTIN_SAMPLE_SCRIPTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>

          <select
            className="mcvis-select"
            value={mcAssetVersion}
            onChange={(e) => handleSwitchMcVersion(e.target.value as '1.21.11' | '1.20.1')}
            title="一键切换并转换 1.21.11 与 1.20.1 资源与容器数据版本"
          >
            <option value="1.21.11">基准版本: Java 1.21.11</option>
            <option value="1.20.1">基准版本: Java 1.20.1</option>
          </select>

          <select
            className="mcvis-select"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) handleExportFormat(e.target.value as ExportableFormatId);
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              导出为 7 大格式...
            </option>
            {SUPPORTED_EXPORT_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                导出: {f.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="mcvis-main">
        {/* Center 3D / 2D Interactive Viewport */}
        <div className="mcvis-viewport-wrap">
          <div
            ref={viewportHostRef}
            className="mcvis-canvas-host"
            onPointerDown={handleCanvasPointerDown}
            onPointerUp={handleCanvasPointerUp}
          />

          {/* Top-Left Structure Summary HUD */}
          <div className="mcvis-hud-tl">
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{ir.name}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
              尺寸: <span className="mcvis-mono">{bounds.size.x} × {bounds.size.y} × {bounds.size.z}</span>
              {' | '}有效方块: <span className="mcvis-mono">{stats.nonAirBlocks.toLocaleString()}</span>
              {' | '}三角面: <span className="mcvis-mono">{triangleCount.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              <span className="mcvis-badge">格式: {ir.sourceFormat}</span>
              <span className="mcvis-badge">DV: {ir.dataVersion}</span>
              {ir.requiredMods.map((mod) => {
                const hasAsset =
                  mountedNamespaces.has(mod) ||
                  customRegistryRef.current.list().some((b) => b.id.startsWith(`${mod}:`));
                return (
                  <span
                    key={mod}
                    className={`mcvis-badge ${hasAsset ? 'emerald' : 'amber'}`}
                    title={hasAsset ? `已加载 ${mod} 真实资源` : `未挂载 ${mod}.jar，当前启用智能语义几何降级`}
                  >
                    {hasAsset ? `✓ ${mod}` : `⚡ ${mod} (智能降级)`}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Top-Right Camera & Edit Tool Bar */}
          <div className="mcvis-hud-tr">
            <div className="mcvis-hud-bar">
              <button
                className={`mcvis-btn ${projectionMode === '3d_perspective' ? 'active' : ''}`}
                onClick={() => {
                  setProjectionMode('3d_perspective');
                  controllerRef.current?.setProjectionMode('3d_perspective');
                }}
              >
                3D 透视
              </button>
              <button
                className={`mcvis-btn ${projectionMode === '2d_blueprint' ? 'active' : ''}`}
                onClick={() => {
                  setProjectionMode('2d_blueprint');
                  controllerRef.current?.setProjectionMode('2d_blueprint');
                }}
              >
                2D 俯视图纸
              </button>
              <button
                className={`mcvis-btn ${showOverlay ? 'active' : ''}`}
                onClick={() => {
                  const next = !showOverlay;
                  setShowOverlay(next);
                  controllerRef.current?.setTechnicalOverlayVisible(next);
                }}
                title="显示/隐藏生电红石朝向箭头、档位、信号强度与强力胶区域"
              >
                <Eye size={13} />
                <span>生电透视</span>
              </button>
              <button
                className={`mcvis-btn ${showGrid ? 'active' : ''}`}
                onClick={() => {
                  const next = !showGrid;
                  setShowGrid(next);
                  controllerRef.current?.setChunkGridVisible(next);
                }}
                title="显示/隐藏 16×16 区块边界与方块网格"
              >
                <Grid size={13} />
              </button>
              <button
                className="mcvis-btn"
                onClick={() => controllerRef.current?.resetCameraToFit()}
                title="重置相机视角"
              >
                <Camera size={13} />
              </button>
            </div>

            <div className="mcvis-hud-bar">
              <button
                className={`mcvis-btn ${toolMode === 'inspect' ? 'active' : ''}`}
                onClick={() => setToolMode('inspect')}
                title="左键检视方块状态与 NBT（Alt+左键吸取为画笔）"
              >
                <Search size={13} />
                <span>检视</span>
              </button>
              <button
                className={`mcvis-btn ${toolMode === 'place' ? 'active' : ''}`}
                onClick={() => setToolMode('place')}
                title="在点击面相邻位置放置画笔方块"
              >
                <Hammer size={13} />
                <span>放置</span>
              </button>
              <button
                className={`mcvis-btn ${toolMode === 'erase' ? 'active' : ''}`}
                onClick={() => setToolMode('erase')}
                title="移除点击的方块"
              >
                <Trash2 size={13} />
                <span>清除</span>
              </button>
              <button
                className="mcvis-btn"
                onClick={() => {
                  if (editorRef.current?.undo()) setRenderVersion((v) => v + 1);
                }}
                title="撤销 (Undo)"
              >
                <Undo2 size={13} />
              </button>
              <button
                className="mcvis-btn"
                onClick={() => {
                  if (editorRef.current?.redo()) setRenderVersion((v) => v + 1);
                }}
                title="重做 (Redo)"
              >
                <Redo2 size={13} />
              </button>
              <button
                className="mcvis-btn"
                onClick={() => loadNewStructure(rotateStructureY90(ir), '已顺时针旋转结构 90°（同步修正方块朝向属性）')}
                title="整体顺时针旋转 90° 并自动旋转方块朝向属性"
              >
                <RotateCw size={13} />
              </button>
            </div>
          </div>

          {/* Bottom 3-Axis Layer Slicer Dock */}
          <div className="mcvis-slice-dock">
            <Layers size={15} color="#38bdf8" />
            <select
              className="mcvis-select"
              value={slice.axis}
              onChange={(e) => {
                const axis = e.target.value as SliceAxis;
                setSlice((s) => ({
                  ...s,
                  axis,
                  layer: 0,
                  maxLayer: Math.max(0, bounds.size[axis] - 1)
                }));
              }}
            >
              <option value="y">Y 轴 (层高)</option>
              <option value="x">X 轴 (东西)</option>
              <option value="z">Z 轴 (南北)</option>
            </select>

            <select
              className="mcvis-select"
              value={slice.mode}
              onChange={(e) => setSlice((s) => ({ ...s, mode: e.target.value as SliceMode }))}
            >
              <option value="all">全部层显示</option>
              <option value="single">单层跟建切片</option>
              <option value="below">当前层及以下</option>
              <option value="range">层区间截取</option>
            </select>

            {slice.mode !== 'all' && (
              <>
                <button
                  className="mcvis-btn"
                  onClick={() => setSlice((s) => ({ ...s, layer: Math.max(0, s.layer - 1) }))}
                >
                  -
                </button>
                <input
                  type="range"
                  min={0}
                  max={axisMax}
                  value={Math.min(slice.layer, axisMax)}
                  onChange={(e) => setSlice((s) => ({ ...s, layer: Number(e.target.value) }))}
                  style={{ flex: 1 }}
                />
                <button
                  className="mcvis-btn"
                  onClick={() => setSlice((s) => ({ ...s, layer: Math.min(axisMax, s.layer + 1) }))}
                >
                  +
                </button>
                <span className="mcvis-mono" style={{ minWidth: 58, textAlign: 'right' }}>
                  {slice.axis.toUpperCase()} = {slice.layer}/{axisMax}
                </span>
                {slice.mode === 'single' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                    <input
                      type="checkbox"
                      checked={slice.ghostBelowLayer}
                      onChange={(e) =>
                        setSlice((s) => ({ ...s, ghostBelowLayer: e.target.checked }))
                      }
                    />
                    幽灵底图
                  </label>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right 6-Tab Inspector & Engineering Sidebar */}
        <aside className="mcvis-sidebar">
          <nav className="mcvis-tabs">
            <button
              className={`mcvis-tab ${activeTab === 'inspect' ? 'active' : ''}`}
              onClick={() => setActiveTab('inspect')}
            >
              <Search size={14} />
              <span>检视编辑</span>
            </button>
            <button
              className={`mcvis-tab ${activeTab === 'bom' ? 'active' : ''}`}
              onClick={() => setActiveTab('bom')}
            >
              <Package size={14} />
              <span>BOM清单</span>
            </button>
            <button
              className={`mcvis-tab ${activeTab === 'mods_custom' ? 'active' : ''}`}
              onClick={() => setActiveTab('mods_custom')}
            >
              <FolderArchive size={14} />
              <span>模组/自定义</span>
            </button>
            <button
              className={`mcvis-tab ${activeTab === 'importers' ? 'active' : ''}`}
              onClick={() => setActiveTab('importers')}
            >
              <Download size={14} />
              <span>跨界导入</span>
            </button>
            <button
              className={`mcvis-tab ${activeTab === 'dsl_ai' ? 'active' : ''}`}
              onClick={() => setActiveTab('dsl_ai')}
            >
              <Sparkles size={14} />
              <span>AI生成/MCP</span>
            </button>
            <button
              className={`mcvis-tab ${activeTab === 'live_server' ? 'active' : ''}`}
              onClick={() => setActiveTab('live_server')}
            >
              <Server size={14} />
              <span>实机联调</span>
            </button>
          </nav>

          <div className="mcvis-panel-body">
            {/* TAB 1: INSPECT & EDIT */}
            {activeTab === 'inspect' && (
              <>
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>生电方块与 NBT 深度检视</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>左键点击方块</span>
                  </div>
                  {picked ? (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: '#38bdf8' }}>
                        {vfsRef.current.getBlockDisplayName(picked.state.name)}
                      </div>
                      <div className="mcvis-mono" style={{ color: 'var(--text-secondary)', margin: '4px 0 8px' }}>
                        {formatBlockState(picked.state)}
                      </div>
                      <div className="mcvis-kv-row">
                        <span>局部坐标</span>
                        <span className="mcvis-mono">
                          [{picked.blockPos.x}, {picked.blockPos.y}, {picked.blockPos.z}]
                        </span>
                      </div>
                      <div className="mcvis-kv-row">
                        <span>模型解析层级</span>
                        <span className="mcvis-badge">
                          {compilerRef.current.compileBlockState(picked.state, picked.blockEntity).sourceTier}
                        </span>
                      </div>

                      {Object.keys(picked.state.properties).length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginBottom: 4 }}>
                            方块状态属性 (BlockState Properties)
                          </div>
                          {Object.entries(picked.state.properties).map(([k, v]) => (
                            <div key={k} className="mcvis-kv-row">
                              <span className="mcvis-mono">{k}</span>
                              <span className="mcvis-mono" style={{ color: '#fbbf24' }}>{v}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {picked.blockEntity && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ color: '#34d399', fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>
                            方块实体 NBT ({picked.blockEntity.id})
                          </div>
                          {(() => {
                            const items = extractItemsFromBlockEntity(picked.blockEntity.nbt);
                            if (items.length === 0) return null;
                            return (
                              <div style={{ marginBottom: 6 }}>
                                {items.map((it, idx) => (
                                  <div key={idx} className="mcvis-kv-row">
                                    <span>Slot #{it.slot}: {vfsRef.current.getBlockDisplayName(it.itemId)}</span>
                                    <span className="mcvis-mono">×{it.count}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                          <pre
                            className="mcvis-mono"
                            style={{
                              background: '#090d16',
                              padding: 8,
                              borderRadius: 6,
                              overflowX: 'auto',
                              maxHeight: 190,
                              margin: 0
                            }}
                          >
                            {JSON.stringify(unwrapNbtToJson(picked.blockEntity.nbt), null, 2)}
                          </pre>
                          <button
                            className="mcvis-btn"
                            style={{ marginTop: 6, width: '100%' }}
                            onClick={() => {
                              navigator.clipboard.writeText(stringifySnbt(picked.blockEntity!.nbt));
                              notify('已复制该方块实体的 SNBT 字符串');
                            }}
                          >
                            复制方块 SNBT
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', padding: '12px 0' }}>
                      在左侧视口点击任意方块即可查看其状态属性、容器内物品与完整 NBT 结构（按住 Alt 点击可吸取为画笔）。
                    </div>
                  )}
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">画笔与全局批量替换</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                      当前放置画笔方块状态
                    </label>
                    <input
                      className="mcvis-input mcvis-mono"
                      value={brushBlock}
                      onChange={(e) => setBrushBlock(e.target.value)}
                    />
                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
                        全局替换方块
                      </div>
                      <input
                        className="mcvis-input mcvis-mono"
                        style={{ width: '100%', marginBottom: 6 }}
                        value={replaceFrom}
                        onChange={(e) => setReplaceFrom(e.target.value)}
                        placeholder="源方块 ID (如 minecraft:cobblestone)"
                      />
                      <input
                        className="mcvis-input mcvis-mono"
                        style={{ width: '100%', marginBottom: 6 }}
                        value={replaceTo}
                        onChange={(e) => setReplaceTo(e.target.value)}
                        placeholder="目标方块状态 (如 minecraft:deepslate_bricks)"
                      />
                      <button
                        className="mcvis-btn primary"
                        style={{ width: '100%' }}
                        onClick={() => {
                          const cnt = editorRef.current?.replaceBlock(replaceFrom, replaceTo, false) ?? 0;
                          if (cnt > 0) setRenderVersion((v) => v + 1);
                          notify(`批量替换完成，共更新 ${cnt} 个方块`);
                        }}
                      >
                        执行全局替换
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* TAB 2: BOM MATERIAL LIST */}
            {activeTab === 'bom' && (
              <>
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>生存精准材料清单 (BOM)</span>
                    <button
                      className="mcvis-btn"
                      onClick={() => {
                        const csv = [
                          'ItemID,Name,Namespace,Count,Formatted',
                          ...bom.entries.map(
                            (e) =>
                              `${e.itemId},"${vfsRef.current.getBlockDisplayName(e.itemId)}",${e.namespace},${e.count},"${e.formattedQuantity}"`
                          )
                        ].join('\n');
                        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${ir.name || 'structure'}-bom.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                        notify('已导出 BOM 材料表 CSV');
                      }}
                    >
                      导出 CSV
                    </button>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 11.5, marginBottom: 8 }}>
                    统计范围: {slice.mode === 'all' ? '完整结构' : `当前切片 (${slice.axis.toUpperCase()}=${slice.layer})`} | 总计 {bom.totalItems.toLocaleString()} 个物品（双层半砖自动×2，门/床/活塞头已按生存实际去重）
                  </div>
                  {bom.entries.map((entry) => (
                    <div key={entry.itemId} className="mcvis-bom-row">
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {vfsRef.current.getBlockDisplayName(entry.itemId)}
                        </div>
                        <div className="mcvis-mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                          {entry.itemId}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="mcvis-mono" style={{ color: '#38bdf8', fontWeight: 600 }}>
                          {entry.formattedQuantity}
                        </div>
                        <div className="mcvis-mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                          共 {entry.count.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {bom.containerItems.length > 0 && (
                  <div className="mcvis-card">
                    <div className="mcvis-card-title">容器内部存储物品汇总 (1.20.1 & 1.21 兼容)</div>
                    {bom.containerItems.map((it) => (
                      <div key={it.itemId} className="mcvis-bom-row">
                        <span>{vfsRef.current.getBlockDisplayName(it.itemId)}</span>
                        <span className="mcvis-mono" style={{ color: '#34d399' }}>
                          {it.formattedQuantity} ({it.count})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* TAB 3: MULTI-LOADER MODS & CUSTOM BLOCK STUDIO */}
            {activeTab === 'mods_custom' && (
              <>
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>跨加载器 Mod 资源挂载 (Forge / NeoForge / Fabric / Quilt)</span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 11.5, marginBottom: 8 }}>
                    支持直接拖入任意加载器的 `.jar` 模组包（自动递归解析 JiJ 内嵌包、`forge/neoforge:obj` 与 `composite` 模型）或挂载本机整合包目录：
                  </div>
                  <label className="mcvis-btn primary" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}>
                    <FolderArchive size={14} />
                    <span>选择本地 Mod .jar / 材质包 .zip / .mrpack 挂载</span>
                    <input
                      type="file"
                      multiple
                      accept=".jar,.zip,.mrpack"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files) handleIngestFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>

                  {(() => {
                    const missingNs = ir.requiredMods.filter(
                      (ns) => !mountedNamespaces.has(ns) && !customRegistryRef.current.get(`${ns}:*`)
                    );
                    if (missingNs.length === 0) return null;
                    return (
                      <div
                        style={{
                          padding: 8,
                          marginBottom: 8,
                          borderRadius: 6,
                          background: 'rgba(245, 158, 11, 0.1)',
                          border: '1px solid rgba(245, 158, 11, 0.35)'
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: '#fbbf24', marginBottom: 6 }}>
                          当前结构含未挂载模组命名空间（已启用零 JAR 语义几何降级）：
                          <span className="mcvis-mono" style={{ marginLeft: 4 }}>
                            {missingNs.join(', ')}
                          </span>
                        </div>
                        <button
                          className="mcvis-btn"
                          style={{ width: '100%', justifyContent: 'center' }}
                          disabled={modrinthFetching}
                          onClick={async () => {
                            setModrinthFetching(true);
                            let okCount = 0;
                            try {
                              for (const ns of missingNs) {
                                notify(`正在从 Modrinth 检索并下载 ${ns} (${mcAssetVersion})...`);
                                const sum = await vfsRef.current.fetchModJarFromModrinth(
                                  ns,
                                  mcAssetVersion
                                );
                                if (sum) okCount++;
                              }
                              if (okCount > 0) {
                                compilerRef.current.clearCache();
                                setMountedRev((r) => r + 1);
                                notify(`已从 Modrinth 自动补全 ${okCount}/${missingNs.length} 个模组资源！`);
                              } else {
                                notify('未在 Modrinth 找到匹配的公开模组包，请手动拖入本地 .jar');
                              }
                            } catch (err) {
                              notify(`Modrinth 拉取失败: ${(err as Error).message}`);
                            } finally {
                              setModrinthFetching(false);
                            }
                          }}
                        >
                          {modrinthFetching
                            ? '正在从 Modrinth CDN 拉取模组资源...'
                            : '☁ 一键从 Modrinth 自动补全缺失模组 JAR'}
                        </button>
                      </div>
                    );
                  })()}

                  {discoveredPacks.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 11.5, color: '#34d399', marginBottom: 4 }}>
                        发现本机 MC 环境 / 启动器模组目录:
                      </div>
                      {discoveredPacks.map((pk) => (
                        <div key={pk.id} className="mcvis-bom-row">
                          <div>
                            <div style={{ fontWeight: 600 }}>[{pk.launcher}] {pk.name}</div>
                            <div className="mcvis-mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                              {pk.modsCount} 个 JAR {pk.hasKubeJs ? '+ KubeJS' : ''}
                            </div>
                          </div>
                          <button
                            className="mcvis-btn"
                            onClick={async () => {
                              if (!bridge.readModpackArchives) return;
                              notify(`正在按需加载 ${pk.name} 模组资源...`);
                              const archives = await bridge.readModpackArchives(
                                pk.path,
                                ir.requiredMods
                              );
                              for (const a of archives) {
                                vfsRef.current.mountModArchive(a.data, a.fileName);
                              }
                              compilerRef.current.clearCache();
                              setMountedRev((r) => r + 1);
                              notify(`已从 ${pk.name} 挂载 ${archives.length} 个模组包！`);
                            }}
                          >
                            一键挂载
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {vfsRef.current.getMountedArchives().length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        已挂载包体 ({vfsRef.current.getMountedArchives().length}):
                      </div>
                      {vfsRef.current.getMountedArchives().map((m, idx) => (
                        <div key={idx} className="mcvis-kv-row">
                          <span className="mcvis-mono">{m.fileName}</span>
                          <span className="mcvis-badge emerald">{m.namespaces.join(', ')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* CUSTOM BLOCK STUDIO */}
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>自定义方块工坊 (Custom Block Studio)</span>
                    <button
                      className="mcvis-btn"
                      onClick={() => {
                        const pack = customRegistryRef.current.exportPack();
                        const blob = new Blob([JSON.stringify(pack, null, 2)], {
                          type: 'application/json'
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'custom-blocks.mcvis-pack.json';
                        a.click();
                        URL.revokeObjectURL(url);
                        notify('已导出 .mcvis-pack.json 自定义方块预设包');
                      }}
                    >
                      导出预设包
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <input
                      className="mcvis-input mcvis-mono"
                      value={cbId}
                      onChange={(e) => setCbId(e.target.value)}
                      placeholder="自定义方块 ID (如 kubejs:star_casing)"
                    />
                    <input
                      className="mcvis-input"
                      value={cbNameZh}
                      onChange={(e) => setCbNameZh(e.target.value)}
                      placeholder="中文显示名称"
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        className="mcvis-select"
                        style={{ flex: 1 }}
                        value={cbArchetype}
                        onChange={(e) => setCbArchetype(e.target.value as CustomBlockArchetype)}
                      >
                        <option value="cube">完整立方体 (Cube)</option>
                        <option value="directional_machine">方向性机器 (Machine)</option>
                        <option value="slab">半砖台阶 (Slab)</option>
                        <option value="stairs">楼梯 (Stairs)</option>
                        <option value="pipe">六向连接线缆/管道 (Pipe/Cable)</option>
                        <option value="glass">半透明玻璃 (Glass)</option>
                        <option value="wall">墙柱/栅栏 (Wall)</option>
                        <option value="cross">十字植物 (Cross)</option>
                      </select>
                      <input
                        type="color"
                        value={cbColor}
                        onChange={(e) => setCbColor(e.target.value)}
                        style={{ width: 42, height: 30, background: 'none', border: 'none', cursor: 'pointer' }}
                      />
                    </div>

                    <div style={{ display: 'flex', gap: 6 }}>
                      <label className="mcvis-btn" style={{ flex: 1, justifyContent: 'center' }}>
                        <span>上传贴图 PNG (可选)</span>
                        <input
                          type="file"
                          accept="image/png,image/webp"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            const reader = new FileReader();
                            reader.onload = () => setCbTextureDataUrl(String(reader.result || ''));
                            reader.readAsDataURL(f);
                          }}
                        />
                      </label>
                      <label className="mcvis-btn" style={{ flex: 1, justifyContent: 'center' }}>
                        <span>导入 Blockbench (.bbmodel)</span>
                        <input
                          type="file"
                          accept=".bbmodel"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            if (e.target.files) handleIngestFiles(e.target.files);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>

                    <button
                      className="mcvis-btn primary"
                      onClick={() => {
                        const def = customRegistryRef.current.register({
                          id: cbId,
                          nameZh: cbNameZh,
                          nameEn: cbNameZh,
                          archetype: cbArchetype,
                          colorHex: cbColor,
                          renderType: cbArchetype === 'glass' ? 'translucent' : 'solid',
                          lightLevel: 0,
                          textures: cbTextureDataUrl ? { all: cbTextureDataUrl } : {}
                        });
                        setBrushBlock(def.id);
                        compilerRef.current.clearCache();
                        setMountedRev((r) => r + 1);
                        notify(`已注册自定义方块 ${def.id} 并设为当前放置画笔！`);
                      }}
                    >
                      注册自定义方块并设为画笔
                    </button>

                    {customRegistryRef.current.list().map((c) => (
                      <div key={c.id} className="mcvis-kv-row">
                        <span className="mcvis-mono">{c.id} ({c.nameZh})</span>
                        <button
                          className="mcvis-btn"
                          style={{ padding: '2px 6px' }}
                          onClick={() => {
                            setBrushBlock(c.id);
                            setToolMode('place');
                            notify(`已切换画笔为 ${c.id}`);
                          }}
                        >
                          设为画笔
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* TAB 4: THIRD-PARTY IMPORTERS */}
            {activeTab === 'importers' && (
              <>
                <div className="mcvis-card">
                  <div className="mcvis-card-title">通用调色板约束设定</div>
                  <select
                    className="mcvis-select"
                    style={{ width: '100%' }}
                    value={palettePreset}
                    onChange={(e) => setPalettePreset(e.target.value as PaletteFilterPreset)}
                  >
                    <option value="all_survival">全原版生存建筑方块 (混凝土+羊毛+陶瓦+石木矿)</option>
                    <option value="concrete_only">仅 16 色混凝土 (高饱和纯净体素)</option>
                    <option value="wool_concrete">混凝土 + 羊毛混合</option>
                    <option value="include_custom">包含自定义方块工坊已注册色块</option>
                  </select>
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">1. 3D 网格体素化 (.obj / .stl / .glb) & Blockbench</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span>目标最大尺寸:</span>
                    <input
                      type="range"
                      min={16}
                      max={160}
                      value={voxelResolution}
                      onChange={(e) => setVoxelResolution(Number(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span className="mcvis-mono">{voxelResolution} 格</span>
                  </div>
                  <label className="mcvis-btn primary" style={{ width: '100%', justifyContent: 'center' }}>
                    <span>导入 .obj / .stl / .glb / .bbmodel 为结构</span>
                    <input
                      type="file"
                      accept=".obj,.stl,.glb,.bbmodel"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files) handleIngestFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">2. MagicaVoxel (.vox) 原生体素导入</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={voxExactCustom}
                      onChange={(e) => setVoxExactCustom(e.target.checked)}
                    />
                    自动生成 1:1 精确 RGB 自定义方块（勾选后零色差还原）
                  </label>
                  <label className="mcvis-btn" style={{ width: '100%', justifyContent: 'center' }}>
                    <span>导入 .vox 工程文件</span>
                    <input
                      type="file"
                      accept=".vox"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files) handleIngestFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">3. 2D 像素画 & 3D 阶梯阴影生存地图画</div>
                  <select
                    className="mcvis-select"
                    style={{ width: '100%', marginBottom: 8 }}
                    value={imgArtMode}
                    onChange={(e) => setImgArtMode(e.target.value as ImageImportMode)}
                  >
                    <option value="map_art_staircased_3d">3D 阶梯阴影生存地图画 (180/220/255 三阶色深)</option>
                    <option value="map_art_flat">2D 平铺生存地图画 (带北侧基准行)</option>
                    <option value="wall_pixel_art">立面竖直像素画 (X-Y 墙面)</option>
                  </select>
                  <label className="mcvis-btn" style={{ width: '100%', justifyContent: 'center' }}>
                    <span>选择图片 (.png / .jpg / .webp) 转换</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files) handleIngestFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">4. 本地世界存档选区截取 (Anvil .mca)</div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <input
                      className="mcvis-input mcvis-mono"
                      style={{ flex: 1 }}
                      value={mcaMinCoords}
                      onChange={(e) => setMcaMinCoords(e.target.value)}
                      placeholder="起点 x,y,z"
                    />
                    <input
                      className="mcvis-input mcvis-mono"
                      style={{ flex: 1 }}
                      value={mcaMaxCoords}
                      onChange={(e) => setMcaMaxCoords(e.target.value)}
                      placeholder="终点 x,y,z"
                    />
                  </div>
                  <label className="mcvis-btn" style={{ width: '100%', justifyContent: 'center' }}>
                    <span>打开存档 region/r.X.Z.mca 截取结构</span>
                    <input
                      type="file"
                      accept=".mca"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files) handleIngestFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </>
            )}

            {/* TAB 5: AI STRUCTURE ARCHITECT + MCP & API LIVE BRIDGE + DSL WORKBENCH */}
            {activeTab === 'dsl_ai' && (
              <>
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>AI 建筑师 · 自然语言结构生成与改建</span>
                    <Sparkles size={14} color="#a855f7" />
                  </div>

                  {/* Mode Switch: Create vs Modify Live Viewport */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <button
                      type="button"
                      className={`mcvis-btn ${aiMode === 'create' ? 'primary' : ''}`}
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11.5 }}
                      onClick={() => setAiMode('create')}
                    >
                      ✨ 从零新建结构
                    </button>
                    <button
                      type="button"
                      className={`mcvis-btn ${aiMode === 'modify' ? 'primary' : ''}`}
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11.5 }}
                      onClick={() => setAiMode('modify')}
                      title={`基于当前 3D 视口结构 (${ir.name}) 进行增量扩建、换材质或加盖屋顶`}
                    >
                      🛠️ 基于当前视口增量改建
                    </button>
                  </div>

                  {/* Quick Inspiration Chips */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                    {(aiMode === 'create'
                      ? [
                          {
                            tag: '🏯 中式飞檐阁楼',
                            text: '生成一座 17x15x17 的中式重檐飞檐阁楼，青砖台基、朱红立柱、白墙花窗与暗海晶石屋顶'
                          },
                          {
                            tag: '🏰 哥特中世纪塔楼',
                            text: '建造一座 15x22x15 的中世纪石砖哨塔，内部带螺旋楼梯、彩绘高窗与深板岩锥形塔尖'
                          },
                          {
                            tag: '🏡 现代极简别墅',
                            text: '设计一栋 18x11x14 的双层现代极简悬挑玻璃别墅，白混凝土框架、橡木露台与屋顶泳池'
                          },
                          {
                            tag: '⚙️ 模组能源核心仓',
                            text: '构建一座 15x13x15 赛博工业反应堆核心机房，带铜灯泡阵列、观察口与地下管线廊道'
                          },
                          {
                            tag: '🔭 穹顶星象台',
                            text: '建造一座直径 15 格的古典石英立柱与青色玻璃半球穹顶星象观测台'
                          }
                        ]
                      : [
                          {
                            tag: '➕ 加盖飞檐屋顶',
                            text: '在当前建筑顶部加盖一层暗海晶石双坡飞檐屋顶，并在四角悬挂灯笼'
                          },
                          {
                            tag: '🧱 增设庭院围墙与路灯',
                            text: '在当前结构外围扩建一圈深板岩砖矮墙、拱门入口与四角铜灯路灯柱'
                          },
                          {
                            tag: '🎨 升级石英与海晶灯材质',
                            text: '将当前结构中的普通石头或砂岩替换为石英砖，并在顶部边缘嵌装海晶灯照明带'
                          }
                        ]
                    ).map((chip) => (
                      <button
                        key={chip.tag}
                        type="button"
                        className="mcvis-badge"
                        style={{
                          cursor: 'pointer',
                          border: '1px solid rgba(168, 85, 247, 0.3)',
                          background: 'rgba(168, 85, 247, 0.1)',
                          color: '#d8b4fe'
                        }}
                        onClick={() => setAiPrompt(chip.text)}
                      >
                        {chip.tag}
                      </button>
                    ))}
                  </div>

                  <textarea
                    className="mcvis-textarea"
                    rows={3}
                    style={{ width: '100%', marginBottom: 8 }}
                    placeholder={
                      aiMode === 'create'
                        ? '描述你想生成的建筑尺寸、风格、楼层、屋顶与模组方块...'
                        : `描述如何修改当前视口中的「${ir.name}」（如加盖二层、换材质、开窗、加围墙）...`
                    }
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                  />

                  {/* Multi-Provider LLM API Bridge Config */}
                  <details style={{ marginBottom: 8 }}>
                    <summary
                      style={{
                        cursor: 'pointer',
                        fontSize: 11.5,
                        color: 'var(--text-secondary)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                    >
                      <span>🔌 多厂商大模型 API 桥接配置 ({aiProvider === 'offline_parametric' ? '离线引擎' : aiModel})</span>
                      <span className="mcvis-mono" style={{ fontSize: 10.5, color: '#38bdf8' }}>
                        {aiApiKey.trim()
                          ? '已填 Key'
                          : aiEnvKeyFlags[aiPresetId] || (aiProvider === 'gemini' && aiEnvKeyFlags.gemini)
                            ? '环境变量已就绪'
                            : aiProvider === 'ollama' || aiProvider === 'offline_parametric'
                              ? '免 Key 就绪'
                              : '未设 Key → 自动降级离线引擎'}
                      </span>
                    </summary>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      <select
                        className="mcvis-select"
                        value={aiPresetId}
                        onChange={(e) => {
                          const pid = e.target.value;
                          setAiPresetId(pid);
                          const preset = AI_PROVIDER_PRESETS.find((p) => p.id === pid);
                          if (preset) {
                            setAiProvider(preset.provider);
                            setAiEndpoint(preset.endpoint);
                            setAiModel(preset.defaultModel);
                          }
                        }}
                      >
                        {AI_PROVIDER_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>

                      {aiProvider !== 'offline_parametric' && (
                        <>
                          <input
                            className="mcvis-input mcvis-mono"
                            value={aiEndpoint}
                            onChange={(e) => setAiEndpoint(e.target.value)}
                            placeholder="API Endpoint URL"
                          />
                          <input
                            className="mcvis-input mcvis-mono"
                            value={aiModel}
                            onChange={(e) => setAiModel(e.target.value)}
                            placeholder="Model ID (如 gemini-2.5-flash / deepseek-chat / gpt-4o)"
                          />
                          {aiProvider !== 'ollama' && (
                            <input
                              type="password"
                              className="mcvis-input mcvis-mono"
                              value={aiApiKey}
                              onChange={(e) => setAiApiKey(e.target.value)}
                              placeholder={
                                AI_PROVIDER_PRESETS.find((p) => p.id === aiPresetId)?.envKeyHint
                                  ? `API Key (支持直接读取系统环境变量 ${AI_PROVIDER_PRESETS.find((p) => p.id === aiPresetId)?.envKeyHint})`
                                  : 'API Key (仅保存在本地 gitignore 缓存)'
                              }
                            />
                          )}
                        </>
                      )}

                      <div style={{ display: 'flex', gap: 6 }}>
                        {bridge.saveAiConfig && (
                          <button
                            type="button"
                            className="mcvis-btn"
                            style={{ flex: 1, justifyContent: 'center' }}
                            onClick={async () => {
                              try {
                                await bridge.saveAiConfig!({
                                  presetId: aiPresetId,
                                  provider: aiProvider,
                                  endpoint: aiEndpoint,
                                  model: aiModel,
                                  apiKey: aiApiKey
                                });
                                notify('已保存 AI 桥接配置至本地安全缓存 (mc-env/.cache/ai-config.json)');
                              } catch (err) {
                                notify(`保存配置失败: ${(err as Error).message}`);
                              }
                            }}
                          >
                            💾 保存本地配置
                          </button>
                        )}
                        {bridge.aiChat && aiProvider !== 'offline_parametric' && (
                          <button
                            type="button"
                            className="mcvis-btn"
                            style={{ flex: 1, justifyContent: 'center' }}
                            onClick={async () => {
                              try {
                                notify(`正在通过后端桥接测试 ${aiModel} 连通性...`);
                                const res = await bridge.aiChat!({
                                  provider: aiProvider,
                                  endpoint: aiEndpoint,
                                  model: aiModel,
                                  apiKey: aiApiKey.trim(),
                                  systemPrompt: 'Reply with a short greeting in 10 words.',
                                  messages: [{ role: 'user', content: 'ping' }],
                                  temperature: 0.1
                                });
                                notify(`✅ 接口连通正常 (${res.model}): ${res.content.slice(0, 40)}`);
                              } catch (err) {
                                notify(`❌ 接口连接失败: ${(err as Error).message}`);
                              }
                            }}
                          >
                            ⚡ 测试 API 连通
                          </button>
                        )}
                      </div>
                    </div>
                  </details>

                  <button
                    type="button"
                    className="mcvis-btn primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={aiLoading}
                    onClick={handleGenerateParametricOrAi}
                  >
                    <Sparkles size={14} />
                    <span>
                      {aiLoading
                        ? 'AI 建筑师正在推演结构并校验方块...'
                        : aiMode === 'modify'
                          ? `增量改建当前结构 (${mcAssetVersion})`
                          : `立即生成 3D 结构 (${mcAssetVersion})`}
                    </span>
                  </button>

                  {/* Multi-turn AI Generation History & One-Click Rollback */}
                  {aiHistory.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>
                        多轮生成演进历史 ({aiHistory.length})
                      </div>
                      <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {aiHistory.map((item) => (
                          <div
                            key={item.id}
                            style={{
                              padding: '6px 8px',
                              borderRadius: 6,
                              background: 'rgba(15, 23, 42, 0.72)',
                              border: '1px solid rgba(148, 163, 184, 0.16)',
                              fontSize: 11.5
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 600, color: '#e2e8f0' }}>
                                {item.mode === 'modify' ? '🛠️ 增量' : '✨ 新建'} · {item.snapshotIr.name}
                              </span>
                              <button
                                type="button"
                                className="mcvis-badge"
                                style={{ cursor: 'pointer', color: '#38bdf8' }}
                                onClick={() => {
                                  setDslCode(item.dslCode);
                                  loadNewStructure(item.snapshotIr, `已回滚至历史版本: ${item.snapshotIr.name}`);
                                }}
                              >
                                回滚此版
                              </button>
                            </div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 }}>
                              {item.prompt}
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: 10.5, marginTop: 2 }}>
                              [{item.provider}] {item.explanation}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* MCP & REST API LIVE BRIDGE HUB */}
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>MCP 协议 & REST API 双向实时桥接</span>
                    <span
                      className="mcvis-badge"
                      style={{
                        background: mcpConnected ? 'rgba(16, 185, 129, 0.18)' : 'rgba(148, 163, 184, 0.16)',
                        color: mcpConnected ? '#34d399' : '#94a3b8'
                      }}
                    >
                      {mcpConnected ? '● 实时同步中' : '○ 未连接'}
                    </span>
                  </div>

                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
                    支持 Claude Desktop / Cursor / Windsurf / Antigravity 等外部 AI Agent 通过 <b>Stdio MCP</b> 或{' '}
                    <b>Streamable HTTP MCP</b> 直接读取、生成并实时推送到当前 3D 视口。
                  </div>

                  {bridge.getMcpBridgeEndpoints && (() => {
                    const ep = bridge.getMcpBridgeEndpoints();
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                        <div className="mcvis-kv-row">
                          <span>HTTP MCP 端点</span>
                          <span className="mcvis-mono" style={{ fontSize: 11, color: '#38bdf8' }}>
                            {ep.httpMcpUrl}
                          </span>
                        </div>
                        <div className="mcvis-kv-row">
                          <span>REST 生成接口</span>
                          <span className="mcvis-mono" style={{ fontSize: 11, color: '#a855f7' }}>
                            {ep.restGenerateUrl}
                          </span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          <button
                            type="button"
                            className="mcvis-btn"
                            style={{ flex: 1, fontSize: 11, justifyContent: 'center' }}
                            onClick={() => {
                              const cfg = JSON.stringify(
                                {
                                  mcpServers: {
                                    'mc-structure-visualizer': {
                                      command: 'node',
                                      args: [ep.stdioScriptPath]
                                    }
                                  }
                                },
                                null,
                                2
                              );
                              void navigator.clipboard.writeText(cfg);
                              notify('已复制 Stdio MCP JSON 配置到剪贴板！');
                            }}
                          >
                            📋 复制 Stdio MCP 配置
                          </button>
                          <button
                            type="button"
                            className="mcvis-btn"
                            style={{ flex: 1, fontSize: 11, justifyContent: 'center' }}
                            onClick={() => {
                              const cfg = JSON.stringify(
                                {
                                  mcpServers: {
                                    'mc-structure-visualizer-http': {
                                      url: ep.httpMcpUrl
                                    }
                                  }
                                },
                                null,
                                2
                              );
                              void navigator.clipboard.writeText(cfg);
                              notify('已复制 Streamable HTTP MCP 配置到剪贴板！');
                            }}
                          >
                            🌐 复制 HTTP MCP 配置
                          </button>
                          <button
                            type="button"
                            className="mcvis-btn"
                            style={{ width: '100%', fontSize: 11, justifyContent: 'center' }}
                            onClick={() => {
                              const curl = `curl -X POST "${ep.restGenerateUrl}" -H "Content-Type: application/json" -d "{\\"prompt\\":\\"生成一座15x14x15中式飞檐阁楼\\",\\"mcVersion\\":\\"${mcAssetVersion}\\",\\"pushToViewport\\":true}"`;
                              void navigator.clipboard.writeText(curl);
                              notify('已复制 REST API 生成并推送 3D 视口的 cURL 示例！');
                            }}
                          >
                            ⚡ 复制 REST API 实时推送 cURL
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: mcpEvents.length > 0 ? 8 : 0 }}>
                    {[
                      'ai_generate_structure',
                      'edit_live_viewport_structure',
                      'get_live_viewport_structure',
                      'push_structure_to_viewport',
                      'build_structure_from_dsl',
                      'convert_structure',
                      'deploy_structure_to_server'
                    ].map((tool) => (
                      <span key={tool} className="mcvis-badge mcvis-mono" style={{ fontSize: 10 }}>
                        {tool}
                      </span>
                    ))}
                  </div>

                  {mcpEvents.length > 0 && (
                    <pre
                      className="mcvis-mono"
                      style={{
                        background: '#090d16',
                        padding: 8,
                        borderRadius: 6,
                        maxHeight: 110,
                        overflowY: 'auto',
                        fontSize: 10.5,
                        color: '#34d399',
                        margin: 0
                      }}
                    >
                      {mcpEvents.join('\n')}
                    </pre>
                  )}
                </div>

                {/* DSL SCRIPTING WORKBENCH */}
                <div className="mcvis-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div className="mcvis-card-title">
                    <span>StructureBuilder 脚本工作台 (支持 editBaseStructure)</span>
                    <button
                      type="button"
                      className="mcvis-btn primary"
                      onClick={() => {
                        try {
                          const built = runStructureDslScript(dslCode, { baseStructure: ir });
                          loadNewStructure(built, `脚本执行成功: ${built.name}`);
                        } catch (err) {
                          notify(`脚本错误: ${(err as Error).message}`);
                        }
                      }}
                    >
                      <Play size={13} />
                      <span>运行脚本</span>
                    </button>
                  </div>
                  <textarea
                    className="mcvis-textarea mcvis-mono"
                    style={{ width: '100%', minHeight: 240, flex: 1, resize: 'vertical' }}
                    value={dslCode}
                    onChange={(e) => setDslCode(e.target.value)}
                  />
                </div>
              </>
            )}

            {/* TAB 6: LIVE MC SERVER RCON & CARPET SYNC */}
            {activeTab === 'live_server' && (
              <>
                <div className="mcvis-card">
                  <div className="mcvis-card-title">
                    <span>本地真实 MC 测试服闭环联调</span>
                    <span
                      className={`mcvis-badge ${serverOnline ? 'emerald' : ''}`}
                      style={{
                        background: serverOnline
                          ? 'rgba(16, 185, 129, 0.2)'
                          : 'rgba(148, 163, 184, 0.16)',
                        color: serverOnline ? '#34d399' : '#94a3b8'
                      }}
                    >
                      {serverOnline === null ? '检测中...' : serverOnline ? '● 在线运行中' : '○ 未启动'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <select
                      className="mcvis-select"
                      value={serverProfile}
                      onChange={(e) =>
                        setServerProfile(e.target.value as '1.21.11-fabric' | '1.20.1-fabric')
                      }
                    >
                      <option value="1.21.11-fabric">1.21.11-fabric (游戏 25565 / RCON 25575)</option>
                      <option value="1.20.1-fabric">1.20.1-fabric (游戏 25566 / RCON 25576)</option>
                    </select>

                    {bridge.startServer && bridge.stopServer && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="mcvis-btn"
                          style={{ flex: 1, justifyContent: 'center' }}
                          disabled={serverBusy || Boolean(serverOnline)}
                          onClick={async () => {
                            if (!bridge.startServer) return;
                            setServerBusy(true);
                            notify(`正在后台启动 ${serverProfile} (预计 10~25 秒)...`);
                            try {
                              const msg = await bridge.startServer(serverProfile);
                              setRconLogs((prev) => [`[Server] ${msg}`, ...prev]);
                              await refreshServerStatus(serverProfile);
                              notify(msg);
                            } catch (err) {
                              notify(`启动测试服失败: ${(err as Error).message}`);
                            } finally {
                              setServerBusy(false);
                            }
                          }}
                        >
                          {serverBusy ? '启动中...' : '▶ 一键启动测试服'}
                        </button>
                        <button
                          className="mcvis-btn"
                          style={{ flex: 1, justifyContent: 'center' }}
                          disabled={serverBusy || !serverOnline}
                          onClick={async () => {
                            if (!bridge.stopServer) return;
                            setServerBusy(true);
                            try {
                              const msg = await bridge.stopServer(serverProfile);
                              setRconLogs((prev) => [`[Server] ${msg}`, ...prev]);
                              setTimeout(() => void refreshServerStatus(serverProfile), 1500);
                              notify(msg);
                            } catch (err) {
                              notify(`停服失败: ${(err as Error).message}`);
                            } finally {
                              setServerBusy(false);
                            }
                          }}
                        >
                          ⏹ 安全停服
                        </button>
                        <button
                          className="mcvis-btn"
                          onClick={() => void refreshServerStatus(serverProfile)}
                          title="刷新测试服在线状态"
                        >
                          刷新
                        </button>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 12 }}>投射起点坐标:</span>
                      <input
                        className="mcvis-input mcvis-mono"
                        style={{ flex: 1 }}
                        value={deployOrigin}
                        onChange={(e) => setDeployOrigin(e.target.value)}
                      />
                    </div>
                    <button
                      className="mcvis-btn primary"
                      disabled={!bridge.deployToServer}
                      onClick={async () => {
                        if (!bridge.deployToServer) return;
                        try {
                          const targetVer = serverProfile.startsWith('1.20') ? '1.20.1' : '1.21.11';
                          const adapted = convertStructureVersion(ir, targetVer);
                          const schemBytes = writeSchem(adapted);
                          const parts = deployOrigin.split(',').map((n) => parseInt(n.trim(), 10));
                          const origin = {
                            x: parts[0] || 0,
                            y: parts[1] || 56,
                            z: parts[2] || 0
                          };
                          const msg = await bridge.deployToServer(
                            serverProfile,
                            schemBytes,
                            (ir.name || 'mcvis_live').replace(/\W+/g, '_'),
                            adapted,
                            origin
                          );
                          setRconLogs((prev) => [`[Deploy] ${msg}`, ...prev]);
                          notify('已投射至本地 MC 测试服并写入 WorldEdit schematics！');
                        } catch (err) {
                          notify(`实机投射失败 (请确认测试服已启动): ${(err as Error).message}`);
                        }
                      }}
                    >
                      一键投射当前结构到实机世界 + 保存 .schem
                    </button>
                  </div>
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">Carpet 红石刻控制器 (Tick Stepping)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {[
                      { label: '❄ 冻结游戏刻', cmd: 'tick freeze' },
                      { label: '▶ 恢复正常刻', cmd: 'tick unfreeze' },
                      { label: '⏭ 单步 1gt', cmd: 'tick step 1' },
                      { label: '⏭ 步进 5gt', cmd: 'tick step 5' }
                    ].map((btn) => (
                      <button
                        key={btn.cmd}
                        className="mcvis-btn"
                        disabled={!bridge.sendRcon}
                        onClick={async () => {
                          if (!bridge.sendRcon) return;
                          try {
                            const out = await bridge.sendRcon(serverProfile, btn.cmd);
                            setRconLogs((prev) => [`> /${btn.cmd}\n${out}`, ...prev]);
                          } catch (err) {
                            notify(`RCON 未连接: ${(err as Error).message}`);
                          }
                        }}
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mcvis-card">
                  <div className="mcvis-card-title">RCON 实时指令终端</div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <input
                      className="mcvis-input mcvis-mono"
                      style={{ flex: 1 }}
                      value={rconCmd}
                      onChange={(e) => setRconCmd(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && bridge.sendRcon) {
                          try {
                            const out = await bridge.sendRcon(serverProfile, rconCmd);
                            setRconLogs((prev) => [`> ${rconCmd}\n${out}`, ...prev]);
                          } catch (err) {
                            setRconLogs((prev) => [`[ERR] ${(err as Error).message}`, ...prev]);
                          }
                        }
                      }}
                    />
                    <button
                      className="mcvis-btn primary"
                      disabled={!bridge.sendRcon}
                      onClick={async () => {
                        if (!bridge.sendRcon) return;
                        try {
                          const out = await bridge.sendRcon(serverProfile, rconCmd);
                          setRconLogs((prev) => [`> ${rconCmd}\n${out}`, ...prev]);
                        } catch (err) {
                          setRconLogs((prev) => [`[ERR] ${(err as Error).message}`, ...prev]);
                        }
                      }}
                    >
                      发送
                    </button>
                  </div>
                  <pre
                    className="mcvis-mono"
                    style={{
                      background: '#090d16',
                      padding: 8,
                      borderRadius: 6,
                      maxHeight: 200,
                      overflowY: 'auto',
                      margin: 0,
                      whiteSpace: 'pre-wrap'
                    }}
                  >
                    {rconLogs.length > 0
                      ? rconLogs.join('\n\n')
                      : '尚未发送指令。可通过 .\\mc-env\\start-server.ps1 启动本地测试服后在此实时交互。'}
                  </pre>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>

      {toast && <div className="mcvis-toast">{toast}</div>}
    </div>
  );
}
