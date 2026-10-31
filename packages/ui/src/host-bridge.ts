import type { AiChatMessage, AiProviderKind, UniversalStructureIR, Vec3 } from '@mcvis/core';
import type { VanillaAssetBundle } from '@mcvis/mod-loader';

export interface DiscoveredModpackInstance {
  id: string;
  launcher: string;
  name: string;
  path: string;
  modsCount: number;
  hasKubeJs: boolean;
}

export interface ServerStatusInfo {
  online: boolean;
  port: number;
  rconPort: number;
}

export interface SavedAiConfig {
  presetId: string;
  provider: AiProviderKind;
  endpoint: string;
  model: string;
  apiKey?: string;
  hasEnvKey?: Record<string, boolean>;
}

export interface AiChatBridgeRequest {
  provider: AiProviderKind;
  endpoint: string;
  model: string;
  apiKey?: string;
  systemPrompt: string;
  messages: AiChatMessage[];
  temperature?: number;
}

export interface AiChatBridgeResponse {
  content: string;
  provider: string;
  model: string;
  usedEnvKey?: boolean;
}

export interface McpLivePushEvent {
  type: 'push_structure' | 'mcp_activity';
  source: string;
  toolName?: string;
  summary: string;
  timestamp: number;
  /** Base64 Sponge .schem payload when pushing a structure into the live 3D viewport */
  schemBytes?: Uint8Array;
  dslCode?: string;
}

export interface HostBridge {
  platform: 'desktop-tauri' | 'web';
  loadVanillaBundle(mcVersion: '1.21.11' | '1.20.1'): Promise<VanillaAssetBundle | null>;
  discoverModpacks?(): Promise<DiscoveredModpackInstance[]>;
  readModpackArchives?(
    instancePath: string,
    neededNamespaces?: string[]
  ): Promise<Array<{ fileName: string; data: Uint8Array }>>;
  getServerStatus?(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<ServerStatusInfo>;
  startServer?(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<string>;
  stopServer?(profile: '1.21.11-fabric' | '1.20.1-fabric'): Promise<string>;
  sendRcon?(profile: '1.21.11-fabric' | '1.20.1-fabric', command: string): Promise<string>;
  deployToServer?(
    profile: '1.21.11-fabric' | '1.20.1-fabric',
    schemBytes: Uint8Array,
    schemName: string,
    ir: UniversalStructureIR,
    origin: Vec3
  ): Promise<string>;

  /** Server-side / Native Rust LLM API Bridge (zero CORS + env key resolution) */
  aiChat?(req: AiChatBridgeRequest): Promise<AiChatBridgeResponse>;
  loadAiConfig?(): Promise<SavedAiConfig | null>;
  saveAiConfig?(cfg: SavedAiConfig): Promise<void>;

  /** Bidirectional MCP <-> Live 3D Viewport Bridge */
  syncLiveStructure?(payload: {
    name: string;
    mcVersion: string;
    schemBytes: Uint8Array;
    dslCode?: string;
  }): Promise<void>;
  subscribeMcpEvents?(onEvent: (ev: McpLivePushEvent) => void): () => void;
  getMcpBridgeEndpoints?(): {
    httpMcpUrl: string;
    restGenerateUrl: string;
    stdioScriptPath: string;
  };
}
