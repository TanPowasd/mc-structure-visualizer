import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { computeStructureBounds, type UniversalStructureIR, type Vec3 } from '@mcvis/core';
import { exportAsSetblockCommands } from '@mcvis/formats';
import type { VanillaAssetBundle } from '@mcvis/mod-loader';
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

export const tauriHostBridge: HostBridge = {
  platform: 'desktop-tauri',

  async loadVanillaBundle(mcVersion: '1.21.11' | '1.20.1'): Promise<VanillaAssetBundle | null> {
    try {
      return await invoke<VanillaAssetBundle | null>('load_vanilla_bundle', { mcVersion });
    } catch {
      return null;
    }
  },

  async discoverModpacks(): Promise<DiscoveredModpackInstance[]> {
    return await invoke<DiscoveredModpackInstance[]>('discover_modpacks');
  },

  async readModpackArchives(
    instancePath: string,
    neededNamespaces?: string[]
  ): Promise<Array<{ fileName: string; data: Uint8Array }>> {
    const raw = await invoke<Array<{ fileName: string; base64: string }>>('read_modpack_archives', {
      instancePath,
      neededNamespaces: neededNamespaces ?? []
    });
    return raw.map((entry) => ({
      fileName: entry.fileName,
      data: base64ToUint8(entry.base64)
    }));
  },

  async sendRcon(profile: '1.21.11-fabric' | '1.20.1-fabric', command: string): Promise<string> {
    return await invoke<string>('send_rcon_command', {
      profile,
      command: command.replace(/^\//, '')
    });
  },

  async getServerStatus(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<ServerStatusInfo> {
    return await invoke<ServerStatusInfo>('get_server_status', { profile });
  },

  async startServer(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<string> {
    return await invoke<string>('start_mc_server', { profile });
  },

  async stopServer(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<string> {
    return await invoke<string>('stop_mc_server', { profile });
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

    return await invoke<string>('deploy_schem_to_server', {
      profile,
      schemName,
      schemBase64: uint8ToBase64(schemBytes),
      origin,
      size: bounds.size,
      commands
    });
  },

  async aiChat(req: AiChatBridgeRequest): Promise<AiChatBridgeResponse> {
    return await invoke<AiChatBridgeResponse>('ai_chat_completion', { req });
  },

  async loadAiConfig(): Promise<SavedAiConfig | null> {
    return await invoke<SavedAiConfig | null>('load_ai_config');
  },

  async saveAiConfig(cfg: SavedAiConfig): Promise<void> {
    await invoke<void>('save_ai_config', { cfg });
  },

  async syncLiveStructure(payload): Promise<void> {
    await invoke<void>('sync_live_structure', {
      name: payload.name,
      mcVersion: payload.mcVersion,
      schemBase64: uint8ToBase64(payload.schemBytes),
      dslCode: payload.dslCode ?? ''
    });
  },

  subscribeMcpEvents(onEvent: (ev: McpLivePushEvent) => void): () => void {
    let unlistenFn: (() => void) | null = null;
    listen<{
      type: 'push_structure' | 'mcp_activity';
      source: string;
      toolName?: string;
      summary: string;
      timestamp: number;
      schemBase64?: string;
      dslCode?: string;
    }>('mcp-live-event', (event) => {
      const p = event.payload;
      onEvent({
        type: p.type,
        source: p.source,
        toolName: p.toolName,
        summary: p.summary,
        timestamp: p.timestamp,
        schemBytes: p.schemBase64 ? base64ToUint8(p.schemBase64) : undefined,
        dslCode: p.dslCode
      });
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  },

  getMcpBridgeEndpoints() {
    return {
      httpMcpUrl: 'http://127.0.0.1:5173/api/mcp',
      restGenerateUrl: 'http://127.0.0.1:17890/api/mc-bridge/live-push',
      stdioScriptPath: 'tools/mcp-server.mjs'
    };
  }
};
