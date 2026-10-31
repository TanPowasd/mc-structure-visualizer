/**
 * Shared Multi-Provider LLM API Client & Bidirectional MCP <-> Live Viewport Bridge Core
 *
 * Used by BOTH:
 *  - `apps/web/vite.config.ts` (HTTP `/api/mcp`, `/api/mc-bridge/ai-chat`, `/api/mc-bridge/generate-structure`, SSE `/api/mc-bridge/live-events`)
 *  - `tools/mcp-server.mjs` (Stdio MCP Server forwarding live viewport updates to Web `5173` & Tauri Desktop `17890`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RconClient } from '../mc-env/scripts/rcon-cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const AI_CONFIG_PATH = path.join(REPO_ROOT, 'mc-env', '.cache', 'ai-config.json');

export function detectEnvKeys() {
  return {
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY)
  };
}

export function resolveEffectiveApiKey(provider, endpoint = '', explicitKey = '', savedKey = '') {
  const trimmed = String(explicitKey || '').trim();
  if (trimmed) return { key: trimmed, fromEnv: false };
  const saved = String(savedKey || '').trim();
  if (saved) return { key: saved, fromEnv: false };

  const ep = endpoint.toLowerCase();
  if (provider === 'gemini' || ep.includes('googleapis.com')) {
    const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (k) return { key: k, fromEnv: true };
  }
  if (ep.includes('deepseek.com') && process.env.DEEPSEEK_API_KEY) {
    return { key: process.env.DEEPSEEK_API_KEY, fromEnv: true };
  }
  if (provider === 'anthropic' || ep.includes('anthropic.com')) {
    const k = process.env.ANTHROPIC_API_KEY || '';
    if (k) return { key: k, fromEnv: true };
  }
  if (process.env.OPENAI_API_KEY) {
    return { key: process.env.OPENAI_API_KEY, fromEnv: true };
  }
  return { key: '', fromEnv: false };
}

export function loadLocalAiConfig() {
  const hasEnvKey = detectEnvKeys();
  try {
    if (fs.existsSync(AI_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf8'));
      return { ...parsed, hasEnvKey };
    }
  } catch {
    // ignore corrupt config
  }
  // Default smart selection based on available env keys
  if (hasEnvKey.gemini) {
    return {
      presetId: 'gemini',
      provider: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      apiKey: '',
      hasEnvKey
    };
  }
  if (hasEnvKey.deepseek) {
    return {
      presetId: 'deepseek',
      provider: 'openai_compat',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKey: '',
      hasEnvKey
    };
  }
  if (hasEnvKey.openai) {
    return {
      presetId: 'openai',
      provider: 'openai_compat',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: '',
      hasEnvKey
    };
  }
  return {
    presetId: 'gemini',
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    apiKey: '',
    hasEnvKey
  };
}

export function saveLocalAiConfig(cfg) {
  fs.mkdirSync(path.dirname(AI_CONFIG_PATH), { recursive: true });
  const safe = {
    presetId: String(cfg.presetId || 'openai'),
    provider: String(cfg.provider || 'openai_compat'),
    endpoint: String(cfg.endpoint || ''),
    model: String(cfg.model || ''),
    apiKey: cfg.apiKey ? String(cfg.apiKey) : ''
  };
  fs.writeFileSync(AI_CONFIG_PATH, JSON.stringify(safe, null, 2), 'utf8');
}

/**
 * Unified Multi-Provider LLM Chat Client:
 * Supports Google Gemini Native (`generateContent`), OpenAI-Compatible (`OpenAI`, `DeepSeek`, `SiliconFlow`, `Qwen`, `OpenRouter`),
 * Anthropic Claude (`v1/messages`), and Local Ollama (`api/chat`).
 */
export async function callMultiProviderLlm({
  provider,
  endpoint,
  model,
  apiKey,
  systemPrompt,
  messages,
  temperature = 0.25
}) {
  const savedCfg = loadLocalAiConfig();
  const { key, fromEnv } = resolveEffectiveApiKey(
    provider,
    endpoint,
    apiKey,
    savedCfg?.apiKey || ''
  );

  // 1. Google Gemini Native REST API
  if (provider === 'gemini') {
    if (!key) {
      throw new Error('未配置 Gemini API Key（可在面板填写或设置环境变量 GEMINI_API_KEY）');
    }
    const base = (endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const cleanModel = (model || 'gemini-2.5-flash').replace(/^models\//, '');
    const url = base.includes(':generateContent')
      ? base
      : `${base}/models/${encodeURIComponent(cleanModel)}:generateContent`;

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content) }]
      }));

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents,
        generationConfig: {
          temperature
        }
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini API HTTP ${resp.status}: ${errText.slice(0, 240)}`);
    }
    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => (p.thought ? '' : p.text || ''))
      .filter(Boolean)
      .join('\n');
    return { content: text, provider: 'gemini', model: cleanModel, usedEnvKey: fromEnv };
  }

  // 2. Anthropic Claude Messages API
  if (provider === 'anthropic') {
    if (!key) {
      throw new Error('未配置 Anthropic API Key（可在面板填写或设置环境变量 ANTHROPIC_API_KEY）');
    }
    const url = endpoint || 'https://api.anthropic.com/v1/messages';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature,
        system: systemPrompt || undefined,
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API HTTP ${resp.status}: ${errText.slice(0, 240)}`);
    }
    const data = await resp.json();
    const text = (data.content ?? [])
      .filter((blk) => blk.type === 'text')
      .map((blk) => blk.text)
      .join('\n');
    return { content: text, provider: 'anthropic', model, usedEnvKey: fromEnv };
  }

  // 3. Local Ollama API
  if (provider === 'ollama') {
    const url = endpoint || 'http://127.0.0.1:11434/api/chat';
    const fullMsgs = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'qwen2.5-coder:7b',
        messages: fullMsgs,
        stream: false,
        options: { temperature }
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Ollama HTTP ${resp.status} (请确认 ollama serve 已运行): ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    return {
      content: data.message?.content ?? '',
      provider: 'ollama',
      model,
      usedEnvKey: false
    };
  }

  // 4. OpenAI-Compatible API (OpenAI / DeepSeek / SiliconFlow / DashScope / OpenRouter / vLLM)
  let url = endpoint || 'https://api.openai.com/v1/chat/completions';
  if (!url.endsWith('/chat/completions') && !url.includes('?')) {
    url = url.replace(/\/$/, '') + '/chat/completions';
  }
  const headers = { 'Content-Type': 'application/json' };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  const fullMsgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: fullMsgs,
      temperature
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API HTTP ${resp.status}: ${errText.slice(0, 240)}`);
  }
  const data = await resp.json();
  const choice = data.choices?.[0]?.message ?? {};
  const content = choice.content ?? '';
  return {
    content,
    provider: 'openai_compat',
    model,
    usedEnvKey: fromEnv
  };
}

let cachedVanillaRegistrySets = new Map();
export function getKnownVanillaBlockSet(mcVersion = '1.21.11') {
  const ver = mcVersion.startsWith('1.20') ? '1.20.1' : '1.21.11';
  if (cachedVanillaRegistrySets.has(ver)) return cachedVanillaRegistrySets.get(ver);
  try {
    const regPath = path.join(REPO_ROOT, 'mc-env', 'assets', 'bundle', ver, 'blocks-registry.json');
    if (fs.existsSync(regPath)) {
      const obj = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const set = new Set(Object.keys(obj));
      cachedVanillaRegistrySets.set(ver, set);
      return set;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export const MCP_TOOLS = [
  {
    name: 'get_live_viewport_structure',
    description:
      'Read the Minecraft structure currently open in the live 3D Visualizer Studio (Web or Tauri Desktop), including dimensions, MC version, palette, BOM, and current DSL script.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'push_structure_to_viewport',
    description:
      'Push a structure file (.litematic, .schem, .nbt, .bp, .blueprint, .bg2.json, .mcfunction) directly onto the user’s live 3D Visualizer viewport in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the structure file on disk' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'build_structure_from_dsl',
    description:
      'Build a 3D Minecraft structure using StructureBuilder JS DSL (`createBuilder`, `fill`, `walls`, `windowWall`, `pillarGrid`, `cylinder`, `dome`, `gableRoof`, `pyramidRoof`, `spiralStairs`, `arch`), push it live to the 3D viewport, and optionally export to outputPath.',
    inputSchema: {
      type: 'object',
      properties: {
        dslCode: { type: 'string', description: 'JavaScript body ending with `return b.build();`' },
        outputPath: { type: 'string', description: 'Optional file path to save the structure' },
        targetFormat: {
          type: 'string',
          enum: [
            'litematic',
            'schem',
            'nbt',
            'building_gadgets_v2',
            'axiom_bp',
            'structurize_blueprint',
            'f3i_command'
          ],
          default: 'litematic'
        },
        pushToViewport: {
          type: 'boolean',
          default: true,
          description: 'Whether to immediately render the generated structure in the live 3D Studio'
        }
      },
      required: ['dslCode']
    }
  },
  {
    name: 'edit_live_viewport_structure',
    description:
      'Iteratively modify or extend the structure currently open in the live 3D Visualizer using `const b = editBaseStructure(); ... return b.build();` and push the updated result back to the live 3D viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        dslCode: {
          type: 'string',
          description: 'JavaScript DSL starting with `const b = editBaseStructure();` and ending with `return b.build();`'
        }
      },
      required: ['dslCode']
    }
  },
  {
    name: 'ai_generate_structure',
    description:
      'Generate or modify a 3D Minecraft structure from a natural-language prompt using the configured Multi-Provider LLM API (Gemini / DeepSeek / OpenAI / Claude / Ollama) with automatic DSL validation, self-repair, optional file export, and live 3D viewport preview.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Natural language architectural or redstone prompt' },
        mcVersion: { type: 'string', enum: ['1.21.11', '1.20.1'], default: '1.21.11' },
        mode: { type: 'string', enum: ['create', 'modify'], default: 'create' },
        outputPath: { type: 'string', description: 'Optional output path for the generated blueprint' },
        targetFormat: {
          type: 'string',
          enum: [
            'litematic',
            'schem',
            'nbt',
            'building_gadgets_v2',
            'axiom_bp',
            'structurize_blueprint',
            'f3i_command'
          ],
          default: 'litematic'
        },
        pushToViewport: { type: 'boolean', default: true }
      },
      required: ['prompt']
    }
  },
  {
    name: 'inspect_structure',
    description:
      'Parse any Minecraft structure file (.litematic, .schem, .schematic, .nbt, Axiom .bp, Structurize .blueprint, Building Gadgets .json, /setblock .mcfunction) and return dimensions, MC version, DataVersion, required mods, and survival BOM.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the structure file' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'convert_structure',
    description:
      'Convert a Minecraft structure between any of the 7 formats (litematic, schem, nbt, building_gadgets_v2, axiom_bp, structurize_blueprint, f3i_command) and optionally adapt between Java 1.20.1 and 1.21.11.',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Source structure file path' },
        outputPath: { type: 'string', description: 'Destination structure file path' },
        targetFormat: {
          type: 'string',
          enum: [
            'litematic',
            'schem',
            'nbt',
            'building_gadgets_v2',
            'axiom_bp',
            'structurize_blueprint',
            'f3i_command'
          ]
        },
        targetMcVersion: {
          type: 'string',
          enum: ['1.21.11', '1.20.1']
        }
      },
      required: ['inputPath', 'outputPath', 'targetFormat']
    }
  },
  {
    name: 'deploy_structure_to_server',
    description:
      'Deploy a structure file into the local MC test server (1.21.11-fabric or 1.20.1-fabric) via RCON and save a WorldEdit .schem copy.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to structure file' },
        profile: {
          type: 'string',
          enum: ['1.21.11-fabric', '1.20.1-fabric'],
          default: '1.21.11-fabric'
        },
        origin: {
          type: 'object',
          properties: {
            x: { type: 'integer', default: 0 },
            y: { type: 'integer', default: 56 },
            z: { type: 'integer', default: 0 }
          }
        }
      },
      required: ['filePath']
    }
  },
  {
    name: 'mc_server_rcon',
    description:
      'Execute an RCON or Carpet tick command (`tick freeze`, `tick step 1`, `data get block 0 56 0`) against the local MC test server.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['1.21.11-fabric', '1.20.1-fabric'],
          default: '1.21.11-fabric'
        },
        command: { type: 'string', description: 'Minecraft server command without leading slash' }
      },
      required: ['command']
    }
  }
];

/**
 * High-level AI Structure Generator with 1-retry self-repair + offline fallback.
 */
export async function generateStructureWithAi({
  core,
  prompt,
  mcVersion = '1.21.11',
  mode = 'create',
  baseStructure,
  mountedNamespaces = [],
  sampleModBlocks = [],
  customBlockIds = [],
  aiOverride,
  history = []
}) {
  const savedCfg = loadLocalAiConfig();
  const provider = aiOverride?.provider || savedCfg.provider || 'offline_parametric';
  const endpoint = aiOverride?.endpoint ?? savedCfg.endpoint ?? '';
  const model = aiOverride?.model || savedCfg.model || '';
  const apiKey = aiOverride?.apiKey ?? savedCfg.apiKey ?? '';

  const ctx = {
    mcVersion,
    mode,
    currentStructure: baseStructure,
    mountedNamespaces,
    sampleModBlocks,
    customBlockIds
  };

  const knownVanillaBlocks = getKnownVanillaBlockSet(mcVersion);
  const { key: effectiveKey } = resolveEffectiveApiKey(provider, endpoint, apiKey, savedCfg.apiKey);

  // If offline mode selected OR key-requiring cloud provider has no key configured, use rich offline engine
  if (
    provider === 'offline_parametric' ||
    ((provider === 'gemini' || provider === 'openai_compat' || provider === 'anthropic') &&
      !effectiveKey &&
      !endpoint.includes('127.0.0.1') &&
      !endpoint.includes('localhost'))
  ) {
    const offline = core.generateOfflineParametricDsl(prompt, ctx);
    const executed = core.sanitizeAndExecuteAiDsl(offline.code, {
      mcVersion,
      baseStructure: mode === 'modify' ? baseStructure : undefined,
      knownVanillaBlocks
    });
    return {
      ir: executed.ir,
      dslCode: executed.cleanedCode,
      explanation: `${offline.explanation}（当前使用离线参数化引擎；配置 API Key 后可解锁云端大模型自由创作）`,
      providerUsed: 'offline_parametric',
      modelUsed: 'builtin-architect-v2',
      fixedBlocks: executed.fixedBlocks,
      repaired: false
    };
  }

  const systemPrompt = core.buildAiArchitectSystemPrompt(ctx);
  const msgs = [
    ...history.slice(-6),
    { role: 'user', content: prompt }
  ];

  const llmRes = await callMultiProviderLlm({
    provider,
    endpoint,
    model,
    apiKey,
    systemPrompt,
    messages: msgs,
    temperature: 0.25
  });

  let { code, explanation } = core.extractDslFromLlmResponse(llmRes.content);
  try {
    const executed = core.sanitizeAndExecuteAiDsl(code, {
      mcVersion,
      baseStructure: mode === 'modify' ? baseStructure : undefined,
      knownVanillaBlocks
    });
    return {
      ir: executed.ir,
      dslCode: executed.cleanedCode,
      explanation: explanation || '已根据描述由大模型生成结构并完成方块校验。',
      providerUsed: llmRes.provider,
      modelUsed: llmRes.model,
      fixedBlocks: executed.fixedBlocks,
      repaired: false
    };
  } catch (firstErr) {
    // Automatic 1-Turn Agentic Self-Repair!
    const repairRes = await callMultiProviderLlm({
      provider,
      endpoint,
      model,
      apiKey,
      systemPrompt,
      messages: [
        ...msgs,
        { role: 'assistant', content: llmRes.content },
        {
          role: 'user',
          content: `Your JavaScript DSL failed execution with error:\n${firstErr.message}\nFix the JavaScript code and return ONLY a valid \`\`\`javascript block ending with \`return b.build();\`.`
        }
      ],
      temperature: 0.1
    });
    const repairedExtracted = core.extractDslFromLlmResponse(repairRes.content);
    const executed = core.sanitizeAndExecuteAiDsl(repairedExtracted.code, {
      mcVersion,
      baseStructure: mode === 'modify' ? baseStructure : undefined,
      knownVanillaBlocks
    });
    return {
      ir: executed.ir,
      dslCode: executed.cleanedCode,
      explanation: explanation || repairedExtracted.explanation || '已自动修复脚本并生成结构。',
      providerUsed: llmRes.provider,
      modelUsed: llmRes.model,
      fixedBlocks: executed.fixedBlocks,
      repaired: true
    };
  }
}

/**
 * Executes any of the 9 MCP tools using `{ core, formats }` and optional `liveBridge` hooks:
 *  - `liveBridge.getLiveState()` -> `{ schemBase64, dslCode, name, mcVersion } | null`
 *  - `liveBridge.pushLiveStructure({ ir, schemBase64, dslCode, summary, toolName })`
 */
export async function executeMcpTool(name, args, { core, formats, liveBridge }) {
  if (name === 'get_live_viewport_structure') {
    const state = (await liveBridge?.getLiveState?.()) ?? null;
    if (!state || !state.schemBase64) {
      return {
        connected: false,
        message: '当前未检测到打开的实时 3D 视口结构（请打开 Web http://localhost:5173 或 Tauri 桌面客户端）'
      };
    }
    const bytes = new Uint8Array(Buffer.from(state.schemBase64, 'base64'));
    const ir = formats.parseSchemOrSchematic(bytes);
    const bounds = core.computeStructureBounds(ir);
    const stats = core.countStructureStats(ir);
    const bom = core.calculateBom(ir);
    return {
      connected: true,
      name: state.name || ir.name,
      mcVersion: state.mcVersion || ir.mcVersion,
      dimensions: bounds.size,
      nonAirBlocks: stats.nonAirBlocks,
      uniqueStates: stats.uniqueStates,
      requiredMods: ir.requiredMods,
      dslCode: state.dslCode || null,
      topMaterials: bom.entries.slice(0, 20)
    };
  }

  if (name === 'push_structure_to_viewport') {
    const abs = path.resolve(String(args.filePath));
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const ir = formats.parseStructureAuto(bytes, path.basename(abs));
    const schemBase64 = Buffer.from(formats.writeSchem(ir)).toString('base64');
    const pushed = await liveBridge?.pushLiveStructure?.({
      ir,
      schemBase64,
      summary: `MCP 推送文件至视口: ${path.basename(abs)}`,
      toolName: name
    });
    const bounds = core.computeStructureBounds(ir);
    return {
      ok: true,
      pushedToLiveViewport: Boolean(pushed),
      name: ir.name,
      dimensions: bounds.size
    };
  }

  if (name === 'build_structure_from_dsl') {
    const knownVanillaBlocks = getKnownVanillaBlockSet('1.21.11');
    const { ir, fixedBlocks } = core.sanitizeAndExecuteAiDsl(String(args.dslCode), {
      mcVersion: '1.21.11',
      knownVanillaBlocks
    });
    let savedTo = null;
    if (args.outputPath) {
      const outPath = path.resolve(String(args.outputPath));
      const fmt = args.targetFormat || 'litematic';
      const serialized = formats.serializeStructure(ir, fmt);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      if (typeof serialized === 'string') {
        fs.writeFileSync(outPath, serialized, 'utf8');
      } else {
        fs.writeFileSync(outPath, Buffer.from(serialized));
      }
      savedTo = outPath;
    }
    let pushed = false;
    if (args.pushToViewport !== false && liveBridge?.pushLiveStructure) {
      const schemBase64 = Buffer.from(formats.writeSchem(ir)).toString('base64');
      pushed = Boolean(
        await liveBridge.pushLiveStructure({
          ir,
          schemBase64,
          dslCode: String(args.dslCode),
          summary: `MCP DSL 实时构建: ${ir.name}`,
          toolName: name
        })
      );
    }
    const stats = core.countStructureStats(ir);
    const bounds = core.computeStructureBounds(ir);
    return {
      ok: true,
      name: ir.name,
      dimensions: bounds.size,
      nonAirBlocks: stats.nonAirBlocks,
      fixedBlocks,
      requiredMods: ir.requiredMods,
      outputPath: savedTo,
      pushedToLiveViewport: pushed
    };
  }

  if (name === 'edit_live_viewport_structure') {
    const state = (await liveBridge?.getLiveState?.()) ?? null;
    let baseIr = undefined;
    let mcVer = '1.21.11';
    if (state?.schemBase64) {
      baseIr = formats.parseSchemOrSchematic(new Uint8Array(Buffer.from(state.schemBase64, 'base64')));
      if (state.name) baseIr.name = state.name;
      mcVer = state.mcVersion === '1.20.1' ? '1.20.1' : '1.21.11';
    }
    const { ir, fixedBlocks } = core.sanitizeAndExecuteAiDsl(String(args.dslCode), {
      mcVersion: mcVer,
      baseStructure: baseIr,
      knownVanillaBlocks: getKnownVanillaBlockSet(mcVer)
    });
    const schemBase64 = Buffer.from(formats.writeSchem(ir)).toString('base64');
    const pushed = Boolean(
      await liveBridge?.pushLiveStructure?.({
        ir,
        schemBase64,
        dslCode: String(args.dslCode),
        summary: `MCP 实时增量修改视口结构: ${ir.name}`,
        toolName: name
      })
    );
    const stats = core.countStructureStats(ir);
    return {
      ok: true,
      name: ir.name,
      nonAirBlocks: stats.nonAirBlocks,
      fixedBlocks,
      pushedToLiveViewport: pushed
    };
  }

  if (name === 'ai_generate_structure') {
    const mcVer = args.mcVersion === '1.20.1' ? '1.20.1' : '1.21.11';
    const mode = args.mode === 'modify' ? 'modify' : 'create';
    let baseIr = undefined;
    if (mode === 'modify') {
      const state = await liveBridge?.getLiveState?.();
      if (state?.schemBase64) {
        baseIr = formats.parseSchemOrSchematic(
          new Uint8Array(Buffer.from(state.schemBase64, 'base64'))
        );
        if (state.name) baseIr.name = state.name;
      }
    }
    const gen = await generateStructureWithAi({
      core,
      prompt: String(args.prompt),
      mcVersion: mcVer,
      mode,
      baseStructure: baseIr
    });

    let savedTo = null;
    if (args.outputPath) {
      const outPath = path.resolve(String(args.outputPath));
      const fmt = args.targetFormat || 'litematic';
      const serialized = formats.serializeStructure(gen.ir, fmt);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      if (typeof serialized === 'string') {
        fs.writeFileSync(outPath, serialized, 'utf8');
      } else {
        fs.writeFileSync(outPath, Buffer.from(serialized));
      }
      savedTo = outPath;
    }

    let pushed = false;
    if (args.pushToViewport !== false && liveBridge?.pushLiveStructure) {
      const schemBase64 = Buffer.from(formats.writeSchem(gen.ir)).toString('base64');
      pushed = Boolean(
        await liveBridge.pushLiveStructure({
          ir: gen.ir,
          schemBase64,
          dslCode: gen.dslCode,
          summary: `AI 生成结构推送: ${gen.ir.name} (${gen.providerUsed})`,
          toolName: name
        })
      );
    }

    const bounds = core.computeStructureBounds(gen.ir);
    const stats = core.countStructureStats(gen.ir);
    return {
      ok: true,
      name: gen.ir.name,
      providerUsed: gen.providerUsed,
      modelUsed: gen.modelUsed,
      explanation: gen.explanation,
      dimensions: bounds.size,
      nonAirBlocks: stats.nonAirBlocks,
      fixedBlocks: gen.fixedBlocks,
      repaired: gen.repaired,
      outputPath: savedTo,
      pushedToLiveViewport: pushed,
      dslCode: gen.dslCode
    };
  }

  if (name === 'inspect_structure') {
    const abs = path.resolve(String(args.filePath));
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const ir = formats.parseStructureAuto(bytes, path.basename(abs));
    const bounds = core.computeStructureBounds(ir);
    const stats = core.countStructureStats(ir);
    const bom = core.calculateBom(ir);
    return {
      name: ir.name,
      author: ir.author,
      sourceFormat: ir.sourceFormat,
      mcVersion: ir.mcVersion,
      dataVersion: ir.dataVersion,
      dimensions: bounds.size,
      nonAirBlocks: stats.nonAirBlocks,
      uniqueBlockStates: stats.uniqueStates,
      blockEntities: stats.blockEntityCount,
      requiredMods: ir.requiredMods,
      totalSurvivalItems: bom.totalItems,
      topMaterials: bom.entries.slice(0, 25),
      containerItems: bom.containerItems
    };
  }

  if (name === 'convert_structure') {
    const inPath = path.resolve(String(args.inputPath));
    const outPath = path.resolve(String(args.outputPath));
    const bytes = new Uint8Array(fs.readFileSync(inPath));
    let ir = formats.parseStructureAuto(bytes, path.basename(inPath));
    if (args.targetMcVersion) {
      ir = core.convertStructureVersion(ir, args.targetMcVersion);
    }
    const fmt = args.targetFormat || args.outputFormat || args.format || path.extname(outPath);
    const serialized = formats.serializeStructure(ir, fmt);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (typeof serialized === 'string') {
      fs.writeFileSync(outPath, serialized, 'utf8');
    } else {
      fs.writeFileSync(outPath, Buffer.from(serialized));
    }
    return {
      ok: true,
      outputPath: outPath,
      targetFormat: fmt,
      mcVersion: ir.mcVersion,
      dataVersion: ir.dataVersion
    };
  }

  if (name === 'deploy_structure_to_server') {
    const inPath = path.resolve(String(args.filePath));
    const profile = String(args.profile || '1.21.11-fabric');
    const origin = {
      x: Number(args.origin?.x ?? 0),
      y: Number(args.origin?.y ?? 56),
      z: Number(args.origin?.z ?? 0)
    };
    const bytes = new Uint8Array(fs.readFileSync(inPath));
    const parsed = formats.parseStructureAuto(bytes, path.basename(inPath));
    const targetVer = profile.startsWith('1.20') ? '1.20.1' : '1.21.11';
    const ir = core.convertStructureVersion(parsed, targetVer);
    const schemBytes = formats.writeSchem(ir);

    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'mc-env', 'config.json'), 'utf8'));
    const srv = cfg.serverProfiles[profile];
    if (!srv) throw new Error(`Unknown server profile: ${profile}`);

    const safeName = (ir.name || 'mcp_deploy').replace(/[^0-9A-Za-z_-]/g, '_');
    const schemDir = path.join(REPO_ROOT, 'mc-env', 'servers', profile, 'config', 'worldedit', 'schematics');
    fs.mkdirSync(schemDir, { recursive: true });
    fs.writeFileSync(path.join(schemDir, `${safeName}.schem`), Buffer.from(schemBytes));

    const bounds = core.computeStructureBounds(ir);
    const cmds = formats
      .exportAsSetblockCommands(ir, origin)
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\//, ''))
      .filter(Boolean);

    const rcon = new RconClient({
      host: '127.0.0.1',
      port: srv.rconPort,
      password: srv.rconPassword
    });
    await rcon.connect();
    try {
      await rcon.send(
        `forceload add ${origin.x - 16} ${origin.z - 16} ${origin.x + bounds.size.x + 16} ${origin.z + bounds.size.z + 16}`
      );
      await rcon.send(
        `fill ${origin.x} ${origin.y} ${origin.z} ${origin.x + Math.max(0, bounds.size.x - 1)} ${origin.y + Math.max(0, bounds.size.y - 1)} ${origin.z + Math.max(0, bounds.size.z - 1)} minecraft:air`
      );
      for (const cmd of cmds) {
        await rcon.send(cmd);
      }
    } finally {
      rcon.close();
    }

    return {
      ok: true,
      profile,
      origin,
      placedBlocks: cmds.length,
      savedWorldEditSchem: `${safeName}.schem`
    };
  }

  if (name === 'mc_server_rcon') {
    const profile = String(args.profile || '1.21.11-fabric');
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'mc-env', 'config.json'), 'utf8'));
    const srv = cfg.serverProfiles[profile];
    if (!srv) throw new Error(`Unknown server profile: ${profile}`);
    const rcon = new RconClient({
      host: '127.0.0.1',
      port: srv.rconPort,
      password: srv.rconPassword
    });
    await rcon.connect();
    try {
      const output = await rcon.send(String(args.command).replace(/^\//, ''));
      return { ok: true, profile, output };
    } finally {
      rcon.close();
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}
