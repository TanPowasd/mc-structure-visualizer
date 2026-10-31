import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { zipSync } from 'fflate';
import { createServer, defineConfig, type Connect, type Plugin, type ViteDevServer } from 'vite';
// @ts-expect-error shared Node ESM helper
import * as aiBridge from '../../tools/ai-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const mcAssetsDir = path.join(repoRoot, 'mc-env', 'assets');
const mcEnvDir = path.join(repoRoot, 'mc-env');

interface ModpackRecord {
  id: string;
  launcher: string;
  name: string;
  path: string;
  modsDir: string;
  modsCount: number;
  hasKubeJs: boolean;
}

function isLoopback(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

function countJarsInDir(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar')).length;
  } catch {
    return 0;
  }
}

function scanModpackInstances(): ModpackRecord[] {
  const results: ModpackRecord[] = [];
  const seen = new Set<string>();

  const pushCandidate = (launcher: string, name: string, instanceRoot: string, modsDir?: string) => {
    const actualMods = modsDir ?? path.join(instanceRoot, 'mods');
    const resolved = path.resolve(instanceRoot);
    if (seen.has(resolved)) return;
    const modsCount = countJarsInDir(actualMods);
    const kubeAssets = path.join(instanceRoot, 'kubejs', 'assets');
    const hasKubeJs = fs.existsSync(kubeAssets);
    if (modsCount === 0 && !hasKubeJs) return;
    seen.add(resolved);
    results.push({
      id: `${launcher}:${name}:${results.length}`,
      launcher,
      name,
      path: resolved,
      modsDir: actualMods,
      modsCount,
      hasKubeJs
    });
  };

  // 1. Built-in verified Multi-Loader Test Fixtures (Forge + NeoForge + Fabric)
  const testModsDir = path.join(mcEnvDir, '.cache', 'test-mods');
  if (fs.existsSync(testModsDir)) {
    pushCandidate('MC-Env 内置测试库', '根目录测试模组', testModsDir, testModsDir);
    for (const sub of fs.readdirSync(testModsDir, { withFileTypes: true })) {
      if (sub.isDirectory()) {
        const subDir = path.join(testModsDir, sub.name);
        pushCandidate('MC-Env 实测模组集', sub.name, subDir, subDir);
      }
    }
  }

  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  // 2. Official / PCL2 / HMCL .minecraft & isolated versions
  const dotMc = path.join(appData, '.minecraft');
  if (fs.existsSync(dotMc)) {
    pushCandidate('Official/PCL2/HMCL', '.minecraft (主目录)', dotMc);
    const versionsDir = path.join(dotMc, 'versions');
    if (fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          pushCandidate('PCL2/HMCL 版本隔离', entry.name, path.join(versionsDir, entry.name));
        }
      }
    }
  }

  // 3. PrismLauncher
  const prismDir = path.join(appData, 'PrismLauncher', 'instances');
  if (fs.existsSync(prismDir)) {
    for (const entry of fs.readdirSync(prismDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const mcSub = path.join(prismDir, entry.name, '.minecraft');
        const dotMinecraftAlt = path.join(prismDir, entry.name, 'minecraft');
        const target = fs.existsSync(mcSub) ? mcSub : dotMinecraftAlt;
        pushCandidate('PrismLauncher', entry.name, target);
      }
    }
  }

  // 4. CurseForge
  const cfDir = path.join(home, 'curseforge', 'minecraft', 'Instances');
  if (fs.existsSync(cfDir)) {
    for (const entry of fs.readdirSync(cfDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pushCandidate('CurseForge', entry.name, path.join(cfDir, entry.name));
      }
    }
  }

  // 5. Modrinth App
  const mrDir = path.join(appData, 'ModrinthApp', 'profiles');
  if (fs.existsSync(mrDir)) {
    for (const entry of fs.readdirSync(mrDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pushCandidate('Modrinth', entry.name, path.join(mrDir, entry.name));
      }
    }
  }

  return results;
}

function collectKubeJsZip(instanceRoot: string): Uint8Array | null {
  const kubeAssets = path.join(instanceRoot, 'kubejs', 'assets');
  if (!fs.existsSync(kubeAssets)) return null;
  const entries: Record<string, Uint8Array> = {};
  const walk = (dir: string, relPrefix: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = `${relPrefix}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else {
        entries[rel] = new Uint8Array(fs.readFileSync(full));
      }
    }
  };
  walk(kubeAssets, 'assets');
  return Object.keys(entries).length > 0 ? zipSync(entries, { level: 0 }) : null;
}

function execRconSingle(host: string, port: number, password: string, commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let rx = Buffer.alloc(0);
    let nextId = 10;
    const outputs: string[] = [];
    let cmdIdx = 0;

    const writePacket = (id: number, type: number, body: string) => {
      const bodyBuf = Buffer.from(body, 'utf8');
      const len = 4 + 4 + bodyBuf.length + 2;
      const pkt = Buffer.alloc(4 + len);
      pkt.writeInt32LE(len, 0);
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      bodyBuf.copy(pkt, 12);
      socket.write(pkt);
    };

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`RCON 连接超时 (${host}:${port})，请确认已运行 .\\mc-env\\start-server.ps1`));
    }, 8000);

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.once('connect', () => {
      writePacket(1, 3, password);
    });

    const pumpNext = () => {
      if (cmdIdx >= commands.length) {
        clearTimeout(timer);
        socket.end();
        resolve(outputs.filter(Boolean).join('\n'));
        return;
      }
      const cmd = commands[cmdIdx++]!;
      writePacket(nextId++, 2, cmd);
    };

    socket.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 4) {
        const len = rx.readInt32LE(0);
        if (rx.length < 4 + len) break;
        const id = rx.readInt32LE(4);
        const body = rx.toString('utf8', 12, 4 + len - 2);
        rx = rx.subarray(4 + len);
        if (id === -1) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('RCON 密码校验失败'));
          return;
        }
        if (id === 1) {
          pumpNext();
        } else if (id >= 10) {
          if (body) outputs.push(body);
          pumpNext();
        }
      }
    });
  });
}

function readJsonBody(req: Connect.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

interface LiveViewportState {
  name: string;
  mcVersion: string;
  schemBase64: string;
  dslCode: string;
  updatedAt: number;
}

let currentLiveState: LiveViewportState | null = null;
const sseClients = new Set<ServerResponse>();

function broadcastSseEvent(payload: Record<string, unknown>) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

let fallbackSsrPromise: Promise<{ core: unknown; formats: unknown }> | null = null;

function attachMcMiddleware(middlewares: Connect.Server, devServer?: ViteDevServer) {
  const loadWorkspaceModules = async () => {
    if (devServer) {
      try {
        const core = await devServer.ssrLoadModule(path.resolve(repoRoot, 'packages/core/src/index.ts'));
        const formats = await devServer.ssrLoadModule(path.resolve(repoRoot, 'packages/formats/src/index.ts'));
        return { core, formats };
      } catch {
        // Fallback to standalone configless SSR loader below
      }
    }
    if (!fallbackSsrPromise) {
      fallbackSsrPromise = (async () => {
        const ssrVite = await createServer({
          configFile: false,
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
        const core = await ssrVite.ssrLoadModule(path.resolve(repoRoot, 'packages/core/src/index.ts'));
        const formats = await ssrVite.ssrLoadModule(path.resolve(repoRoot, 'packages/formats/src/index.ts'));
        return { core, formats };
      })();
    }
    return fallbackSsrPromise;
  };

  const inProcessLiveBridge = {
    async getLiveState() {
      return currentLiveState;
    },
    async pushLiveStructure({
      ir,
      schemBase64,
      dslCode,
      summary,
      toolName
    }: {
      ir?: { name?: string; mcVersion?: string };
      schemBase64: string;
      dslCode?: string;
      summary: string;
      toolName?: string;
    }) {
      currentLiveState = {
        name: ir?.name || 'MCP_Structure',
        mcVersion: ir?.mcVersion || '1.21.11',
        schemBase64,
        dslCode: dslCode || '',
        updatedAt: Date.now()
      };
      broadcastSseEvent({
        type: 'push_structure',
        source: 'mcp-http',
        toolName,
        summary,
        timestamp: Date.now(),
        schemBase64,
        dslCode: dslCode || ''
      });
      return true;
    }
  };

  // Streamable HTTP JSON-RPC 2.0 MCP Server (`POST http://127.0.0.1:5173/api/mcp`)
  middlewares.use('/api/mcp', async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'Loopback access only' }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          name: 'mc-structure-visualizer-mcp',
          version: '0.2.0',
          transport: 'streamable-http',
          toolsCount: aiBridge.MCP_TOOLS.length
        })
      );
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let rpcId: unknown = null;
    try {
      const msg = await readJsonBody(req);
      const id = msg.id ?? null;
      rpcId = id;
      const method = String(msg.method || '');

      if (method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'mc-structure-visualizer-mcp', version: '0.2.0' }
            }
          })
        );
        return;
      }

      if (method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }

      if (method === 'tools/list') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { tools: aiBridge.MCP_TOOLS }
          })
        );
        return;
      }

      if (method === 'tools/call') {
        const params = (msg.params as { name?: string; arguments?: Record<string, unknown> }) || {};
        const { core, formats } = await loadWorkspaceModules();
        const toolResult = await aiBridge.executeMcpTool(
          String(params.name || ''),
          params.arguments ?? {},
          { core, formats, liveBridge: inProcessLiveBridge }
        );
        broadcastSseEvent({
          type: 'mcp_activity',
          source: 'mcp-http',
          toolName: String(params.name || ''),
          summary: `MCP HTTP 调用工具: ${String(params.name || '')}`,
          timestamp: Date.now()
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }]
            }
          })
        );
        return;
      }

      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        })
      );
    } catch (err) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32000, message: (err as Error).message }
        })
      );
    }
  });

  // Static serving of /mc-assets/* from mc-env/assets/*
  middlewares.use('/mc-assets', (req, res, next) => {
    const cleanUrl = decodeURIComponent((req.url || '/').split('?')[0]!);
    const targetPath = path.resolve(mcAssetsDir, '.' + cleanUrl);
    if (!targetPath.startsWith(mcAssetsDir)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      const ext = path.extname(targetPath).toLowerCase();
      res.setHeader(
        'Content-Type',
        ext === '.png' ? 'image/png' : ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream'
      );
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(targetPath).pipe(res);
      return;
    }
    next();
  });

  // Loopback-only local MC environment bridge API
  middlewares.use('/api/mc-bridge', async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: 'Loopback access only' }));
      return;
    }

    const route = (req.url || '/').split('?')[0];

    // SSE Live MCP <-> Viewport Event Stream
    if (route === '/live-events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'mcp_activity', source: 'bridge', summary: 'MCP & REST 实时桥接通道已连接', timestamp: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      // Live Viewport State Sync (GET by MCP server / POST by Web UI)
      if (route === '/live-state') {
        if (req.method === 'GET') {
          res.end(JSON.stringify(currentLiveState ?? { schemBase64: '' }));
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          currentLiveState = {
            name: String(body.name || 'Structure'),
            mcVersion: String(body.mcVersion || '1.21.11'),
            schemBase64: String(body.schemBase64 || ''),
            dslCode: String(body.dslCode || ''),
            updatedAt: Date.now()
          };
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      // Live Push from External Stdio MCP (`tools/mcp-server.mjs`) or REST scripts
      if (route === '/live-push' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const schemBase64 = String(body.schemBase64 || '');
        const dslCode = String(body.dslCode || '');
        currentLiveState = {
          name: String(body.name || 'MCP_Structure'),
          mcVersion: String(body.mcVersion || '1.21.11'),
          schemBase64,
          dslCode,
          updatedAt: Date.now()
        };
        broadcastSseEvent({
          type: 'push_structure',
          source: String(body.source || 'mcp-stdio'),
          toolName: String(body.toolName || 'live_push'),
          summary: String(body.summary || `收到外部 MCP 推送结构: ${currentLiveState.name}`),
          timestamp: Date.now(),
          schemBase64,
          dslCode
        });
        res.end(JSON.stringify({ ok: true, clientsNotified: sseClients.size }));
        return;
      }

      // AI Config Persistence (local gitignored `mc-env/.cache/ai-config.json`)
      if (route === '/ai-config') {
        if (req.method === 'GET') {
          const cfg = aiBridge.loadLocalAiConfig();
          res.end(JSON.stringify({ ok: true, config: cfg }));
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          aiBridge.saveLocalAiConfig(body);
          res.end(JSON.stringify({ ok: true, config: aiBridge.loadLocalAiConfig() }));
          return;
        }
      }

      // Multi-Provider Server-Side LLM Chat Proxy (zero CORS!)
      if (route === '/ai-chat' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await aiBridge.callMultiProviderLlm({
          provider: String(body.provider || 'openai_compat'),
          endpoint: String(body.endpoint || ''),
          model: String(body.model || ''),
          apiKey: body.apiKey ? String(body.apiKey) : '',
          systemPrompt: String(body.systemPrompt || ''),
          messages: Array.isArray(body.messages) ? body.messages : [],
          temperature: typeof body.temperature === 'number' ? body.temperature : 0.25
        });
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }

      // High-Level REST Structure Generation API (`POST /api/mc-bridge/generate-structure`)
      if (route === '/generate-structure' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { core, formats } = await loadWorkspaceModules();
        const mcVer = body.mcVersion === '1.20.1' ? '1.20.1' : '1.21.11';
        const mode = body.mode === 'modify' ? 'modify' : 'create';
        let baseIr = undefined;
        if (mode === 'modify' && currentLiveState?.schemBase64) {
          baseIr = formats.parseSchemOrSchematic(
            new Uint8Array(Buffer.from(currentLiveState.schemBase64, 'base64'))
          );
        }
        const gen = await aiBridge.generateStructureWithAi({
          core,
          prompt: String(body.prompt || '生成一座双层中式亭阁'),
          mcVersion: mcVer,
          mode,
          baseStructure: baseIr,
          aiOverride: body.aiConfig as Record<string, unknown> | undefined
        });

        const schemBytes = formats.writeSchem(gen.ir);
        const schemBase64 = Buffer.from(schemBytes).toString('base64');
        if (body.pushToViewport !== false) {
          await inProcessLiveBridge.pushLiveStructure({
            ir: gen.ir,
            schemBase64,
            dslCode: gen.dslCode,
            summary: `REST API 生成并推送结构: ${gen.ir.name}`,
            toolName: 'rest_generate_structure'
          });
        }

        const outFmt = String(body.format || body.exportFormat || 'schem');
        const exported = formats.serializeStructure(gen.ir, outFmt);
        const bounds = core.computeStructureBounds(gen.ir);
        const stats = core.countStructureStats(gen.ir);
        res.end(
          JSON.stringify({
            ok: true,
            name: gen.ir.name,
            mcVersion: gen.ir.mcVersion,
            providerUsed: gen.providerUsed,
            modelUsed: gen.modelUsed,
            explanation: gen.explanation,
            dimensions: bounds.size,
            nonAirBlocks: stats.nonAirBlocks,
            dslCode: gen.dslCode,
            format: outFmt,
            dataBase64:
              typeof exported === 'string'
                ? Buffer.from(exported, 'utf8').toString('base64')
                : Buffer.from(exported).toString('base64')
          })
        );
        return;
      }

      if (route === '/modpacks' && req.method === 'POST') {
        const instances = scanModpackInstances().map(({ modsDir: _m, ...rest }) => rest);
        res.end(JSON.stringify({ ok: true, instances }));
        return;
      }

      if (route === '/modpack-jars' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const requestedPath = path.resolve(String(body.instancePath || ''));
        const neededNamespaces = Array.isArray(body.neededNamespaces)
          ? (body.neededNamespaces as string[]).map((s) => s.toLowerCase())
          : [];
        const match = scanModpackInstances().find((i) => i.path === requestedPath);
        if (!match) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: '未受信任或不存在的整合包目录' }));
          return;
        }

        const archives: Array<{ fileName: string; base64: string }> = [];
        if (fs.existsSync(match.modsDir)) {
          const jarFiles = fs
            .readdirSync(match.modsDir)
            .filter((f) => f.toLowerCase().endsWith('.jar'));

          // Prioritize jars whose filename hints at neededNamespaces, while still loading others up to 64 jars
          const scored = jarFiles.map((fileName) => {
            const lower = fileName.toLowerCase();
            const hit =
              neededNamespaces.length === 0 ||
              neededNamespaces.some((ns) => lower.includes(ns) || lower.replace(/[-_]/g, '').includes(ns.replace(/[-_]/g, '')));
            return { fileName, score: hit ? 0 : 1 };
          });
          scored.sort((a, b) => a.score - b.score);

          for (const item of scored.slice(0, 64)) {
            const fullJar = path.join(match.modsDir, item.fileName);
            const stat = fs.statSync(fullJar);
            if (stat.size > 120 * 1024 * 1024) continue;
            archives.push({
              fileName: item.fileName,
              base64: fs.readFileSync(fullJar).toString('base64')
            });
          }
        }

        const kubeZip = collectKubeJsZip(match.path);
        if (kubeZip) {
          archives.push({
            fileName: 'kubejs-assets.zip',
            base64: Buffer.from(kubeZip).toString('base64')
          });
        }

        res.end(JSON.stringify({ ok: true, archives }));
        return;
      }

      const cfgRaw = JSON.parse(fs.readFileSync(path.join(mcEnvDir, 'config.json'), 'utf8')) as {
        java?: Record<string, string>;
        serverProfiles: Record<
          string,
          {
            javaKey?: string;
            port: number;
            rconPort: number;
            rconPassword: string;
            memoryMin?: string;
            memoryMax?: string;
          }
        >;
      };

      const checkPortOpen = (port: number): Promise<boolean> =>
        new Promise((resolve) => {
          const s = net.createConnection({ host: '127.0.0.1', port });
          const done = (ok: boolean) => {
            s.destroy();
            resolve(ok);
          };
          s.setTimeout(600, () => done(false));
          s.once('connect', () => done(true));
          s.once('error', () => done(false));
        });

      if (route === '/server-status' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const profile = String(body.profile || '1.21.11-fabric');
        const srv = cfgRaw.serverProfiles[profile];
        if (!srv) throw new Error(`未知服务端配置: ${profile}`);
        const online = await checkPortOpen(srv.rconPort);
        res.end(JSON.stringify({ ok: true, online, port: srv.port, rconPort: srv.rconPort }));
        return;
      }

      if (route === '/server-start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const profile = String(body.profile || '1.21.11-fabric');
        const srv = cfgRaw.serverProfiles[profile];
        if (!srv) throw new Error(`未知服务端配置: ${profile}`);
        if (await checkPortOpen(srv.rconPort)) {
          res.end(JSON.stringify({ ok: true, message: `${profile} 已在运行中 (RCON 127.0.0.1:${srv.rconPort})` }));
          return;
        }
        const srvDir = path.join(mcEnvDir, 'servers', profile);
        const jarPath = path.join(srvDir, 'fabric-server-launch.jar');
        if (!fs.existsSync(jarPath)) {
          throw new Error(`未找到 ${jarPath}，请先运行 pnpm mc:server`);
        }
        const javaExe = (srv.javaKey && cfgRaw.java?.[srv.javaKey]) || 'java';
        const child = spawn(
          javaExe,
          [
            `-Xms${srv.memoryMin || '1G'}`,
            `-Xmx${srv.memoryMax || '3G'}`,
            '-jar',
            'fabric-server-launch.jar',
            'nogui'
          ],
          {
            cwd: srvDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          }
        );
        child.unref();

        // Poll up to 45s for RCON readiness
        for (let i = 0; i < 45; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (await checkPortOpen(srv.rconPort)) {
            res.end(
              JSON.stringify({
                ok: true,
                message: `${profile} 启动就绪！游戏地址 127.0.0.1:${srv.port}，RCON 127.0.0.1:${srv.rconPort}`
              })
            );
            return;
          }
        }
        res.end(
          JSON.stringify({
            ok: true,
            message: `${profile} 后台进程已拉起，正在加载世界中，请稍候点击刷新状态`
          })
        );
        return;
      }

      if (route === '/server-stop' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const profile = String(body.profile || '1.21.11-fabric');
        const srv = cfgRaw.serverProfiles[profile];
        if (!srv) throw new Error(`未知服务端配置: ${profile}`);
        if (!(await checkPortOpen(srv.rconPort))) {
          res.end(JSON.stringify({ ok: true, message: `${profile} 当前未运行` }));
          return;
        }
        await execRconSingle('127.0.0.1', srv.rconPort, srv.rconPassword, ['stop']);
        res.end(JSON.stringify({ ok: true, message: `已向 ${profile} 发送安全保存并停服指令 (stop)` }));
        return;
      }

      if (route === '/rcon' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const profile = String(body.profile || '1.21.11-fabric');
        const command = String(body.command || '').replace(/^\//, '');
        const srv = cfgRaw.serverProfiles[profile];
        if (!srv) throw new Error(`未知服务端配置: ${profile}`);
        const output = await execRconSingle('127.0.0.1', srv.rconPort, srv.rconPassword, [command]);
        res.end(JSON.stringify({ ok: true, output: output || '(指令已执行，无文本回显)' }));
        return;
      }

      if (route === '/deploy' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const profile = String(body.profile || '1.21.11-fabric');
        const srv = cfgRaw.serverProfiles[profile];
        if (!srv) throw new Error(`未知服务端配置: ${profile}`);

        const safeName = String(body.schemName || 'mcvis_live').replace(/[^0-9A-Za-z_-]/g, '_');
        const schemBytes = Buffer.from(String(body.schemBase64 || ''), 'base64');
        const schemDir = path.join(mcEnvDir, 'servers', profile, 'config', 'worldedit', 'schematics');
        fs.mkdirSync(schemDir, { recursive: true });
        const schemPath = path.join(schemDir, `${safeName}.schem`);
        fs.writeFileSync(schemPath, schemBytes);

        const origin = (body.origin as { x: number; y: number; z: number }) || { x: 0, y: 56, z: 0 };
        const size = (body.size as { x: number; y: number; z: number }) || { x: 1, y: 1, z: 1 };
        const cmds = Array.isArray(body.commands) ? (body.commands as string[]) : [];

        const batch: string[] = [
          `forceload add ${origin.x - 16} ${origin.z - 16} ${origin.x + size.x + 16} ${origin.z + size.z + 16}`,
          `fill ${origin.x} ${origin.y} ${origin.z} ${origin.x + Math.max(0, size.x - 1)} ${origin.y + Math.max(0, size.y - 1)} ${origin.z + Math.max(0, size.z - 1)} minecraft:air`,
          ...cmds
        ];
        await execRconSingle('127.0.0.1', srv.rconPort, srv.rconPassword, batch);
        res.end(
          JSON.stringify({
            ok: true,
            message: `已保存 WorldEdit 原理图 ${safeName}.schem，并通过 RCON 向 (${origin.x}, ${origin.y}, ${origin.z}) 实时放置了 ${cmds.length} 个方块`
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'Unknown endpoint' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  });
}

function copyDirRecursive(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function mcEnvBridgePlugin(): Plugin {
  return {
    name: 'mcvis-mc-env-bridge',
    configureServer(server) {
      attachMcMiddleware(server.middlewares, server);
    },
    configurePreviewServer(server) {
      attachMcMiddleware(server.middlewares);
    },
    closeBundle() {
      if (process.env.MCVIS_SKIP_ASSET_COPY === '1') return;
      const outAssets = path.resolve(__dirname, 'dist', 'mc-assets');
      copyDirRecursive(path.join(mcAssetsDir, 'bundle'), path.join(outAssets, 'bundle'));
      for (const ver of ['1.21.11', '1.20.1']) {
        copyDirRecursive(
          path.join(mcAssetsDir, 'extracted', ver, 'textures'),
          path.join(outAssets, 'extracted', ver, 'textures')
        );
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), mcEnvBridgePlugin()],
  resolve: {
    alias: {
      '@mcvis/core': path.resolve(repoRoot, 'packages/core/src/index.ts'),
      '@mcvis/formats': path.resolve(repoRoot, 'packages/formats/src/index.ts'),
      '@mcvis/mod-loader': path.resolve(repoRoot, 'packages/mod-loader/src/index.ts'),
      '@mcvis/importers': path.resolve(repoRoot, 'packages/importers/src/index.ts'),
      '@mcvis/renderer': path.resolve(repoRoot, 'packages/renderer/src/index.ts'),
      '@mcvis/ui': path.resolve(repoRoot, 'packages/ui/src/index.ts')
    }
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500
  }
});
