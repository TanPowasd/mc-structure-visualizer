import { computeStructureBounds, type UniversalStructureIR, type Vec3 } from '@mcvis/core';
import { exportAsSetblockCommands } from '@mcvis/formats';
import type { BlockRegistryMeta, VanillaAssetBundle } from '@mcvis/mod-loader';
import type {
  AiChatBridgeRequest,
  AiChatBridgeResponse,
  DiscoveredModpackInstance,
  HostBridge,
  McpLivePushEvent,
  SavedAiConfig,
  ServerStatusInfo
} from '@mcvis/ui';

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export const webHostBridge: HostBridge = {
  platform: 'web',

  async loadVanillaBundle(mcVersion: '1.21.11' | '1.20.1'): Promise<VanillaAssetBundle | null> {
    try {
      const base = `/mc-assets/bundle/${mcVersion}`;
      const [bsRes, modRes, regRes] = await Promise.all([
        fetch(`${base}/blockstates.json`),
        fetch(`${base}/models.json`),
        fetch(`${base}/blocks-registry.json`)
      ]);
      if (!bsRes.ok || !modRes.ok || !regRes.ok) {
        return null;
      }
      const [blockstates, models, blocksRegistry] = (await Promise.all([
        bsRes.json(),
        modRes.json(),
        regRes.json()
      ])) as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, BlockRegistryMeta>
      ];

      return {
        mcVersion,
        blockstates,
        models,
        blocksRegistry,
        textureBaseUrl: `/mc-assets/extracted/${mcVersion}`
      };
    } catch {
      return null;
    }
  },

  async discoverModpacks(): Promise<DiscoveredModpackInstance[]> {
    try {
      const res = await fetch('/api/mc-bridge/modpacks', { method: 'POST' });
      if (!res.ok) return [];
      const data = (await res.json()) as { instances?: DiscoveredModpackInstance[] };
      return data.instances ?? [];
    } catch {
      return [];
    }
  },

  async readModpackArchives(
    instancePath: string,
    neededNamespaces?: string[]
  ): Promise<Array<{ fileName: string; data: Uint8Array }>> {
    const res = await fetch('/api/mc-bridge/modpack-jars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instancePath, neededNamespaces })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      archives: Array<{ fileName: string; base64: string }>;
    };
    return (json.archives ?? []).map((item) => ({
      fileName: item.fileName,
      data: base64ToUint8(item.base64)
    }));
  },

  async sendRcon(profile: '1.21.11-fabric' | '1.20.1-fabric', command: string): Promise<string> {
    const res = await fetch('/api/mc-bridge/rcon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, command })
    });
    const json = (await res.json()) as { ok: boolean; output?: string; error?: string };
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.output ?? '';
  },

  async getServerStatus(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<ServerStatusInfo> {
    const res = await fetch('/api/mc-bridge/server-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile })
    });
    if (!res.ok) {
      return { online: false, port: 25565, rconPort: 25575 };
    }
    const json = (await res.json()) as { online: boolean; port: number; rconPort: number };
    return {
      online: Boolean(json.online),
      port: json.port ?? 25565,
      rconPort: json.rconPort ?? 25575
    };
  },

  async startServer(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<string> {
    const res = await fetch('/api/mc-bridge/server-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile })
    });
    const json = (await res.json()) as { ok: boolean; message?: string; error?: string };
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.message ?? '已启动';
  },

  async stopServer(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<string> {
    const res = await fetch('/api/mc-bridge/server-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile })
    });
    const json = (await res.json()) as { ok: boolean; message?: string; error?: string };
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.message ?? '已停止';
  },

  async deployToServer(
    profile: '1.21.11-fabric' | '1.20.1-fabric',
    schemBytes: Uint8Array,
    schemName: string,
    ir: UniversalStructureIR,
    origin: Vec3
  ): Promise<string> {
    const bounds = computeStructureBounds(ir);
    const f3iText = exportAsSetblockCommands(ir, origin);
    const commands = f3iText
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, ''))
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .slice(0, 4096);

    const res = await fetch('/api/mc-bridge/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile,
        schemName,
        schemBase64: uint8ToBase64(schemBytes),
        origin,
        size: bounds.size,
        commands
      })
    });
    const json = (await res.json()) as { ok: boolean; message?: string; error?: string };
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.message ?? '已部署';
  },

  async aiChat(req: AiChatBridgeRequest): Promise<AiChatBridgeResponse> {
    const res = await fetch('/api/mc-bridge/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    });
    const json = (await res.json()) as {
      ok: boolean;
      content?: string;
      provider?: string;
      model?: string;
      usedEnvKey?: boolean;
      error?: string;
    };
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `AI 代理请求失败 (HTTP ${res.status})`);
    }
    return {
      content: json.content ?? '',
      provider: json.provider ?? req.provider,
      model: json.model ?? req.model,
      usedEnvKey: json.usedEnvKey
    };
  },

  async loadAiConfig(): Promise<SavedAiConfig | null> {
    try {
      const res = await fetch('/api/mc-bridge/ai-config');
      if (!res.ok) return null;
      const json = (await res.json()) as { ok: boolean; config?: SavedAiConfig };
      return json.config ?? null;
    } catch {
      return null;
    }
  },

  async saveAiConfig(cfg: SavedAiConfig): Promise<void> {
    await fetch('/api/mc-bridge/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
  },

  async syncLiveStructure(payload): Promise<void> {
    try {
      await fetch('/api/mc-bridge/live-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          mcVersion: payload.mcVersion,
          schemBase64: uint8ToBase64(payload.schemBytes),
          dslCode: payload.dslCode ?? ''
        })
      });
    } catch {
      // ignore when running static offline
    }
  },

  subscribeMcpEvents(onEvent: (ev: McpLivePushEvent) => void): () => void {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/mc-bridge/live-events');
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as {
            type: 'push_structure' | 'mcp_activity';
            source: string;
            toolName?: string;
            summary: string;
            timestamp: number;
            schemBase64?: string;
            dslCode?: string;
          };
          onEvent({
            type: data.type,
            source: data.source,
            toolName: data.toolName,
            summary: data.summary,
            timestamp: data.timestamp,
            schemBytes: data.schemBase64 ? base64ToUint8(data.schemBase64) : undefined,
            dslCode: data.dslCode
          });
        } catch {
          // ignore malformed SSE message
        }
      };
    } catch {
      // ignore if EventSource unavailable
    }
    return () => {
      es?.close();
    };
  },

  getMcpBridgeEndpoints() {
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:5173';
    return {
      httpMcpUrl: `${origin}/api/mcp`,
      restGenerateUrl: `${origin}/api/mc-bridge/generate-structure`,
      stdioScriptPath: 'tools/mcp-server.mjs'
    };
  }
};
