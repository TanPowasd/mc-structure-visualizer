#!/usr/bin/env node
/**
 * MC Structure Visualizer — Bidirectional MCP Stdio Server
 *
 * Bridges external AI Agents (Claude Desktop / Claude Code / Cursor / Antigravity / Cline)
 * directly to:
 *   1. Live 3D Visualizer Viewport (Web `127.0.0.1:5173` & Tauri Desktop `127.0.0.1:17890`)
 *   2. Multi-Provider AI Structure Architect (`ai_generate_structure`)
 *   3. 7-Format Structure Codec & Local Real MC Test Server (`1.21.11-fabric` / `1.20.1-fabric`)
 */
import path from 'node:path';
import readline from 'node:readline';
import { createServer } from 'vite';
import { executeMcpTool, MCP_TOOLS, REPO_ROOT } from './ai-bridge.mjs';

const STUDIO_PORTS = [17890, 5173];

let sdkPromise = null;
async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const vite = await createServer({
        configFile: false,
        root: REPO_ROOT,
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true },
        resolve: {
          alias: {
            '@mcvis/core': path.resolve(REPO_ROOT, 'packages/core/src/index.ts'),
            '@mcvis/formats': path.resolve(REPO_ROOT, 'packages/formats/src/index.ts')
          }
        },
        server: { middlewareMode: true, hmr: false, ws: false },
        appType: 'custom'
      });
      const core = await vite.ssrLoadModule(path.resolve(REPO_ROOT, 'packages/core/src/index.ts'));
      const formats = await vite.ssrLoadModule(path.resolve(REPO_ROOT, 'packages/formats/src/index.ts'));
      return { vite, core, formats };
    })();
  }
  return sdkPromise;
}

const remoteLiveBridge = {
  async getLiveState() {
    for (const port of STUDIO_PORTS) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 800);
        const r = await fetch(`http://127.0.0.1:${port}/api/mc-bridge/live-state`, {
          method: 'GET',
          signal: ac.signal
        });
        clearTimeout(timer);
        if (r.ok) {
          const json = await r.json();
          if (json?.schemBase64) return json;
        }
      } catch {
        // try next port
      }
    }
    return null;
  },

  async pushLiveStructure({ ir, schemBase64, dslCode, summary, toolName }) {
    let pushedAny = false;
    for (const port of STUDIO_PORTS) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 1200);
        const r = await fetch(`http://127.0.0.1:${port}/api/mc-bridge/live-push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            source: 'mcp-stdio',
            toolName,
            summary,
            name: ir?.name || 'MCP_Structure',
            mcVersion: ir?.mcVersion || '1.21.11',
            schemBase64,
            dslCode: dslCode || ''
          })
        });
        clearTimeout(timer);
        if (r.ok) pushedAny = true;
      } catch {
        // port not listening
      }
    }
    return pushedAny;
  }
};

function sendRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (process.argv.includes('--self-test')) {
  const { vite, core, formats } = await loadSdk();
  const built = await executeMcpTool(
    'ai_generate_structure',
    {
      prompt: '生成一座 15x13x15 的中式飞檐重檐阁楼',
      mcVersion: '1.21.11',
      outputPath: path.join(REPO_ROOT, 'mc-env', '.cache', 'mcp-ai-selftest.bp'),
      targetFormat: 'axiom_bp',
      pushToViewport: true
    },
    { core, formats, liveBridge: remoteLiveBridge }
  );
  const inspected = await executeMcpTool(
    'inspect_structure',
    { filePath: path.join(REPO_ROOT, 'mc-env', '.cache', 'mcp-ai-selftest.bp') },
    { core, formats, liveBridge: remoteLiveBridge }
  );
  await vite.close();
  console.log(JSON.stringify({ built: { ...built, dslCode: '[omitted]' }, inspected }, null, 2));
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mc-structure-visualizer-mcp', version: '0.2.0' }
      }
    });
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return;
  }

  if (msg.method === 'tools/list') {
    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: MCP_TOOLS }
    });
    return;
  }

  if (msg.method === 'tools/call') {
    try {
      const { core, formats } = await loadSdk();
      const data = await executeMcpTool(msg.params?.name, msg.params?.arguments ?? {}, {
        core,
        formats,
        liveBridge: remoteLiveBridge
      });
      sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }
      });
    } catch (err) {
      sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }]
        }
      });
    }
    return;
  }

  if (msg.id !== undefined) {
    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    });
  }
});
