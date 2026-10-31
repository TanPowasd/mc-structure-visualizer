import { computeStructureBounds, countStructureStats, extractModNamespaces } from './structure.js';
import { runStructureDslScript } from './dsl.js';
import {
  isAirBlock,
  normalizeNamespace,
  type UniversalStructureIR
} from './types.js';
import { convertStructureVersion } from './version-compat.js';

export type AiProviderKind =
  | 'openai_compat'
  | 'gemini'
  | 'anthropic'
  | 'ollama'
  | 'offline_parametric';

export interface AiProviderPreset {
  id: string;
  label: string;
  provider: AiProviderKind;
  endpoint: string;
  defaultModel: string;
  envKeyHint?: string;
  requiresKey: boolean;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'gemini',
    label: 'Google Gemini API (原生接口)',
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    envKeyHint: 'GEMINI_API_KEY',
    requiresKey: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索 (V3 / R1)',
    provider: 'openai_compat',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    envKeyHint: 'DEEPSEEK_API_KEY',
    requiresKey: true
  },
  {
    id: 'openai',
    label: 'OpenAI / 兼容网关 (SiliconFlow / 通义千问 / OpenRouter)',
    provider: 'openai_compat',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    envKeyHint: 'OPENAI_API_KEY',
    requiresKey: true
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude Messages API',
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-20250514',
    envKeyHint: 'ANTHROPIC_API_KEY',
    requiresKey: true
  },
  {
    id: 'ollama',
    label: '本地 Ollama (127.0.0.1:11434 免 Key)',
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/api/chat',
    defaultModel: 'qwen2.5-coder:7b',
    requiresKey: false
  },
  {
    id: 'offline',
    label: '内置离线参数化建筑引擎 (免网络即时生成)',
    provider: 'offline_parametric',
    endpoint: '',
    defaultModel: 'builtin-architect-v2',
    requiresKey: false
  }
];

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiArchitectContext {
  mcVersion: '1.21.11' | '1.20.1';
  mode: 'create' | 'modify';
  currentStructure?: UniversalStructureIR;
  mountedNamespaces?: string[];
  sampleModBlocks?: string[];
  customBlockIds?: string[];
}

const COMMON_BLOCK_FIXES: Record<string, string> = {
  'minecraft:stone_brick': 'minecraft:stone_bricks',
  'minecraft:brick_block': 'minecraft:bricks',
  'minecraft:oak_plank': 'minecraft:oak_planks',
  'minecraft:spruce_plank': 'minecraft:spruce_planks',
  'minecraft:dark_oak_plank': 'minecraft:dark_oak_planks',
  'minecraft:wood_planks': 'minecraft:oak_planks',
  'minecraft:wooden_door': 'minecraft:oak_door',
  'minecraft:cobblestone_stair': 'minecraft:cobblestone_stairs',
  'minecraft:stone_brick_stair': 'minecraft:stone_brick_stairs',
  'minecraft:quartz': 'minecraft:quartz_block',
  'minecraft:smooth_stone_bricks': 'minecraft:stone_bricks',
  'minecraft:glass_block': 'minecraft:glass',
  'minecraft:glowstone_lamp': 'minecraft:redstone_lamp',
  'minecraft:lit_redstone_lamp': 'minecraft:redstone_lamp[lit=true]',
  'minecraft:water_flowing': 'minecraft:water',
  'minecraft:grass_path': 'minecraft:dirt_path'
};

export function summarizeStructureForAi(ir: UniversalStructureIR): string {
  const bounds = computeStructureBounds(ir);
  const stats = countStructureStats(ir);
  const paletteNames = new Set<string>();
  for (const r of ir.regions) {
    for (const p of r.palette) {
      if (!isAirBlock(p.name)) paletteNames.add(p.name);
    }
  }
  return [
    `Name: "${ir.name}"`,
    `MC Version: ${ir.mcVersion} (DataVersion ${ir.dataVersion})`,
    `Dimensions: ${bounds.size.x} (X) × ${bounds.size.y} (Y height) × ${bounds.size.z} (Z)`,
    `Non-Air Blocks: ${stats.nonAirBlocks}`,
    `Palette (${paletteNames.size}): ${[...paletteNames].slice(0, 40).join(', ')}`
  ].join('\n');
}

export function buildAiArchitectSystemPrompt(ctx: AiArchitectContext): string {
  const modSection =
    ctx.sampleModBlocks && ctx.sampleModBlocks.length > 0
      ? `\nMounted Mod Blocks Available (you MAY use these exact IDs when appropriate):\n${ctx.sampleModBlocks.slice(0, 80).join(', ')}`
      : ctx.mountedNamespaces && ctx.mountedNamespaces.length > 1
        ? `\nMounted Mod Namespaces: ${ctx.mountedNamespaces.join(', ')}`
        : '';

  const customSection =
    ctx.customBlockIds && ctx.customBlockIds.length > 0
      ? `\nUser Custom Blocks Available: ${ctx.customBlockIds.join(', ')}`
      : '';

  const modifySection =
    ctx.mode === 'modify' && ctx.currentStructure
      ? `\nEDIT MODE ACTIVE — Current Structure in Viewport:\n${summarizeStructureForAi(ctx.currentStructure)}\nStart your script with \`const b = editBaseStructure();\` to preserve and modify/extend the existing structure!`
      : `\nCREATE MODE ACTIVE — Start your script with \`const b = createBuilder('<StructureName>', { x: W, y: H, z: D }, '${ctx.mcVersion}');\`.`;

  const versionNote =
    ctx.mcVersion === '1.20.1'
      ? `Target version is Java 1.20.1 (DataVersion 3465): DO NOT use 1.21+ exclusive blocks like crafter, copper_bulb, or tuff_bricks; use minecraft:grass instead of short_grass.`
      : `Target version is Java 1.21.11 (DataVersion 4671): Supports 1.21 blocks (minecraft:crafter, minecraft:copper_bulb[lit=true], minecraft:tuff_bricks, minecraft:chiseled_copper) and uses minecraft:short_grass.`;

  return `You are a master Minecraft Architect & Technical Redstone Engineer.
Write clean, executable JavaScript code for our StructureBuilder DSL to construct rich, detailed, structurally coherent 3D Minecraft builds.

Coordinate System:
- X: West (0) -> East (width-1)
- Y: Ground/Bottom (0) -> Sky/Top (height-1)
- Z: North (0) -> South (depth-1)
- Builder auto-expands bounds if coordinates exceed initial size (0 <= x,y,z < 512).

Available StructureBuilder Methods on \`b\`:
- \`b.set(x, y, z, 'namespace:block[prop=val]')\`
- \`b.get(x, y, z)\` -> returns blockState string at (x,y,z)
- \`b.clear(x1, y1, z1, x2, y2, z2)\` -> carves air (doors, windows, arches, rooms)
- \`b.fill(x1, y1, z1, x2, y2, z2, state)\`
- \`b.hollowBox(x1, y1, z1, x2, y2, z2, state)\`
- \`b.walls(x1, y1, z1, x2, y2, z2, state)\` -> 4 vertical perimeter walls without floor/ceiling
- \`b.windowWall(x1, y1, z1, x2, y2, z2, wallState, windowState, spacing)\`
- \`b.pillarGrid(x1, y1, z1, x2, y2, z2, stepX, stepZ, pillarState)\`
- \`b.checkerboard(x1, y1, z1, x2, y2, z2, stateA, stateB)\`
- \`b.line({x,y,z}, {x,y,z}, state)\`
- \`b.cylinder(cx, yStart, cz, radius, height, state, hollowBoolean)\`
- \`b.sphere(cx, cy, cz, radius, state, hollowBoolean)\`
- \`b.dome(cx, cyBase, cz, radius, state)\`
- \`b.gableRoof(x1, yBase, z1, x2, z2, 'x' | 'z', 'minecraft:spruce_stairs', 'minecraft:spruce_slab')\`
- \`b.pyramidRoof(x1, yBase, z1, x2, z2, 'minecraft:deepslate_tile_stairs', 'minecraft:deepslate_tile_slab')\`
- \`b.arch(x1, y1, z1, x2, y2, z2, state)\`
- \`b.spiralStairs(cx, yStart, cz, radius, height, state)\`
- \`b.replace(oldBlockId, newBlockState)\`
- End with \`return b.build();\`

${versionNote}${modifySection}${modSection}${customSection}

Design Guidelines:
1. Build layered architectural detail: foundation/plinth, textured floors, structural corner pillars, recessed window walls, doorways, interior lighting (lanterns, sea_lantern, copper_bulb, shroomlight), and overhanging roofs!
2. Use exact vanilla/modded registry names (e.g. \`minecraft:stone_bricks\`, \`minecraft:oak_planks\`, \`minecraft:spruce_stairs[facing=north,half=bottom]\`, \`minecraft:lantern[hanging=true]\`).
3. Output a brief 1-2 sentence Chinese design note followed by a single \`\`\`javascript code block ending with \`return b.build();\`.`;
}

export function extractDslFromLlmResponse(rawText: string): {
  code: string;
  explanation: string;
} {
  // Strip <think>...</think> blocks from reasoning models (DeepSeek-R1, QwQ, etc.)
  const withoutThink = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const fenceRegex = /```(?:javascript|js|typescript|ts)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let bestCode = '';
  while ((match = fenceRegex.exec(withoutThink)) !== null) {
    const candidate = match[1]!.trim();
    if (
      candidate.includes('createBuilder') ||
      candidate.includes('editBaseStructure') ||
      candidate.includes('.build()')
    ) {
      bestCode = candidate;
      break;
    }
    if (!bestCode) bestCode = candidate;
  }

  if (bestCode) {
    const explanation = withoutThink
      .replace(/```[\s\S]*?```/g, '')
      .trim()
      .slice(0, 300);
    return { code: bestCode, explanation };
  }

  // Fallback: raw response without fences
  return {
    code: withoutThink,
    explanation: ''
  };
}

export function sanitizeAndExecuteAiDsl(
  code: string,
  options: {
    mcVersion: '1.21.11' | '1.20.1';
    baseStructure?: UniversalStructureIR;
    knownVanillaBlocks?: Set<string>;
  }
): {
  ir: UniversalStructureIR;
  cleanedCode: string;
  fixedBlocks: number;
} {
  const rawIr = runStructureDslScript(code, { baseStructure: options.baseStructure });
  let fixedBlocks = 0;

  for (const reg of rawIr.regions) {
    for (const entry of reg.palette) {
      const norm = normalizeNamespace(entry.name);
      if (COMMON_BLOCK_FIXES[norm]) {
        const replacement = COMMON_BLOCK_FIXES[norm]!;
        const brk = replacement.indexOf('[');
        entry.name = brk >= 0 ? replacement.slice(0, brk) : replacement;
        fixedBlocks++;
      } else if (
        options.knownVanillaBlocks &&
        norm.startsWith('minecraft:') &&
        !isAirBlock(norm) &&
        !options.knownVanillaBlocks.has(norm)
      ) {
        // Smart plural/singular heuristic against real Mojang registry
        const altPlural = `${norm}s`;
        const altSingular = norm.endsWith('s') ? norm.slice(0, -1) : '';
        if (options.knownVanillaBlocks.has(altPlural)) {
          entry.name = altPlural;
          fixedBlocks++;
        } else if (altSingular && options.knownVanillaBlocks.has(altSingular)) {
          entry.name = altSingular;
          fixedBlocks++;
        }
      }
    }
  }

  const adapted = convertStructureVersion(rawIr, options.mcVersion);
  adapted.requiredMods = extractModNamespaces(adapted);
  return {
    ir: adapted,
    cleanedCode: code,
    fixedBlocks
  };
}

/**
 * Rich built-in offline parametric architect so users can generate or edit structures
 * from Chinese/English natural language immediately even without an external LLM API key!
 */
export function generateOfflineParametricDsl(
  prompt: string,
  ctx: AiArchitectContext
): { code: string; explanation: string } {
  const p = prompt.toLowerCase();
  const dims = prompt.match(/(\d{1,3})\s*[x×*]\s*(\d{1,3})\s*[x×*]\s*(\d{1,3})/i);
  const w = dims ? Math.max(7, Math.min(64, parseInt(dims[1]!, 10))) : 15;
  const h = dims ? Math.max(6, Math.min(64, parseInt(dims[2]!, 10))) : 13;
  const d = dims ? Math.max(7, Math.min(64, parseInt(dims[3]!, 10))) : 15;
  const ver = ctx.mcVersion;

  if (ctx.mode === 'modify' && ctx.currentStructure) {
    const bounds = computeStructureBounds(ctx.currentStructure);
    if (p.includes('屋顶') || p.includes('roof') || p.includes('飞檐')) {
      return {
        explanation: '已在当前结构顶部自动加装深板岩瓦四坡攒尖屋顶与四角悬挂灯笼。',
        code: `const b = editBaseStructure('${ctx.currentStructure.name}_加顶');
b.pyramidRoof(0, ${bounds.size.y}, 0, ${bounds.size.x - 1}, ${bounds.size.z - 1}, 'minecraft:deepslate_tile_stairs', 'minecraft:deepslate_tile_slab');
b.set(0, ${Math.max(1, bounds.size.y - 1)}, 0, 'minecraft:lantern[hanging=true]');
b.set(${bounds.size.x - 1}, ${Math.max(1, bounds.size.y - 1)}, 0, 'minecraft:lantern[hanging=true]');
b.set(0, ${Math.max(1, bounds.size.y - 1)}, ${bounds.size.z - 1}, 'minecraft:lantern[hanging=true]');
b.set(${bounds.size.x - 1}, ${Math.max(1, bounds.size.y - 1)}, ${bounds.size.z - 1}, 'minecraft:lantern[hanging=true]');
return b.build();`
      };
    }
    return {
      explanation: '已围绕当前结构扩展雕花石砖护栏回廊与四角照明灯柱。',
      code: `const b = editBaseStructure('${ctx.currentStructure.name}_扩建');
b.walls(0, 0, 0, ${bounds.size.x + 1}, 0, ${bounds.size.z + 1}, 'minecraft:polished_deepslate');
b.set(0, 1, 0, 'minecraft:lantern[hanging=false]');
b.set(${bounds.size.x + 1}, 1, 0, 'minecraft:lantern[hanging=false]');
b.set(0, 1, ${bounds.size.z + 1}, 'minecraft:lantern[hanging=false]');
b.set(${bounds.size.x + 1}, 1, ${bounds.size.z + 1}, 'minecraft:lantern[hanging=false]');
return b.build();`
    };
  }

  // 1. Oriental / Chinese Pavilion (中式亭/阁楼/古建)
  if (p.includes('中式') || p.includes('古风') || p.includes('阁') || p.includes('亭') || p.includes('pagoda')) {
    return {
      explanation: `已生成 ${w}×${h}×${d} 中式重檐飞檐楼阁（石砖须弥座、朱红立柱、花格窗与深色海晶石攒尖顶）。`,
      code: `const b = createBuilder('AI_中式重檐阁楼', { x: ${w}, y: ${h}, z: ${d} }, '${ver}');
b.fill(1, 0, 1, ${w - 2}, 1, ${d - 2}, 'minecraft:stone_bricks');
b.checkerboard(2, 1, 2, ${w - 3}, 1, ${d - 3}, 'minecraft:polished_andesite', 'minecraft:chiseled_stone_bricks');
const midX = Math.floor(${w} / 2);
b.fill(midX - 1, 0, 0, midX + 1, 0, 0, 'minecraft:stone_brick_stairs[facing=south,half=bottom]');
b.windowWall(2, 2, 2, ${w - 3}, 5, ${d - 3}, 'minecraft:white_terracotta', 'minecraft:oak_fence', 2);
b.clear(midX - 1, 2, 2, midX + 1, 4, 2);
b.pillarGrid(2, 2, 2, ${w - 3}, 6, ${d - 3}, Math.max(3, Math.floor((${w} - 5) / 2)), Math.max(3, Math.floor((${d} - 5) / 2)), 'minecraft:stripped_mangrove_log[axis=y]');
b.pyramidRoof(0, 6, 0, ${w - 1}, ${d - 1}, 'minecraft:dark_prismarine_stairs', 'minecraft:dark_prismarine_slab');
b.set(1, 5, 1, 'minecraft:lantern[hanging=true]');
b.set(${w - 2}, 5, 1, 'minecraft:lantern[hanging=true]');
b.set(1, 5, ${d - 2}, 'minecraft:lantern[hanging=true]');
b.set(${w - 2}, 5, ${d - 2}, 'minecraft:lantern[hanging=true]');
return b.build();`
    };
  }

  // 2. Greenhouse / Dome (穹顶/温室/球/生态园)
  if (p.includes('穹顶') || p.includes('温室') || p.includes('球') || p.includes('dome') || p.includes('greenhouse')) {
    const r = Math.max(5, Math.floor(Math.min(w, d) / 2) - 1);
    const cx = r + 1;
    const cz = r + 1;
    return {
      explanation: `已生成半径 ${r} 的玻璃生态穹顶温室（含石英基座、环形水景与中央荧光树）。`,
      code: `const b = createBuilder('AI_生态玻璃穹顶', { x: ${cx * 2 + 1}, y: ${r + 5}, z: ${cz * 2 + 1} }, '${ver}');
b.cylinder(${cx}, 0, ${cz}, ${r}, 1, 'minecraft:moss_block', false);
b.cylinder(${cx}, 1, ${cz}, ${r}, 2, 'minecraft:smooth_quartz', true);
b.dome(${cx}, 2, ${cz}, ${r}, 'minecraft:cyan_stained_glass');
b.clear(${cx} - 1, 1, ${cz - r}, ${cx} + 1, 3, ${cz - r});
b.cylinder(${cx}, 1, ${cz}, 2, 4, 'minecraft:oak_log[axis=y]', false);
b.sphere(${cx}, 5, ${cz}, 3, 'minecraft:flowering_azalea_leaves[persistent=true]', false);
b.set(${cx}, 4, ${cz}, 'minecraft:shroomlight');
return b.build();`
    };
  }

  // 3. Create Mod Kinetic Factory (机械动力/Create/齿轮/水车/工厂)
  if (p.includes('机械动力') || p.includes('create') || p.includes('工厂') || p.includes('齿轮')) {
    return {
      explanation: '已生成机械动力 (Create) 安山铜壳自动化冲击工坊结构。',
      code: `const b = createBuilder('AI_机械动力自动化工坊', { x: 13, y: 8, z: 11 }, '${ver}');
b.fill(0, 0, 0, 12, 0, 10, 'minecraft:polished_deepslate');
b.checkerboard(1, 0, 1, 11, 0, 9, 'create:andesite_casing', 'minecraft:tuff');
b.pillarGrid(0, 1, 0, 12, 5, 10, 6, 5, 'create:brass_casing');
b.set(2, 2, 5, 'create:water_wheel[axis=z]');
for (let x = 3; x <= 9; x++) b.set(x, 2, 5, 'create:shaft[axis=x]');
b.set(6, 2, 5, 'create:gearbox[axis=y]');
b.set(6, 1, 3, 'create:depot');
b.set(6, 3, 3, 'create:mechanical_press[facing=south]');
b.set(8, 1, 3, 'create:basin');
b.set(8, 3, 3, 'create:mechanical_mixer');
b.gableRoof(0, 5, 0, 12, 10, 'x', 'minecraft:brick_stairs', 'minecraft:brick_slab');
return b.build();`
    };
  }

  // 4. Redstone / Technical Contraption (红石/生电/分类/合成/脉冲)
  if (p.includes('红石') || p.includes('生电') || p.includes('合成') || p.includes('脉冲') || p.includes('redstone')) {
    const bulbOrLamp =
      ver === '1.20.1' ? 'minecraft:redstone_lamp[lit=true]' : 'minecraft:copper_bulb[lit=true,powered=false]';
    const crafterOrDropper =
      ver === '1.20.1'
        ? 'minecraft:dropper[facing=east,triggered=false]'
        : 'minecraft:crafter[orientation=east_up,triggered=true,crafting=false]';
    return {
      explanation: `已生成适配 ${ver} 的多通道红石比较器自动检测与脉冲控制单元。`,
      code: `const b = createBuilder('AI_红石多通道控制站', { x: 13, y: 7, z: 11 }, '${ver}');
b.fill(0, 0, 0, 12, 0, 10, 'minecraft:smooth_stone');
b.walls(0, 0, 0, 12, 0, 10, 'minecraft:polished_deepslate');
for (let z = 2; z <= 8; z += 2) {
  b.set(2, 1, z, '${bulbOrLamp}');
  b.set(3, 1, z, 'minecraft:observer[facing=west,powered=false]');
  b.set(4, 1, z, 'minecraft:redstone_wire[east=side,west=side,power=15]');
  b.set(5, 1, z, 'minecraft:repeater[facing=west,delay=2,locked=false,powered=true]');
  b.set(6, 1, z, '${crafterOrDropper}');
  b.set(7, 1, z, 'minecraft:hopper[facing=east,enabled=true]');
  b.set(8, 1, z, 'minecraft:barrel[facing=up,open=false]');
  b.set(8, 2, z, 'minecraft:comparator[facing=west,mode=compare,powered=false]');
}
return b.build();`
    };
  }

  // 5. Modern Villa / House (现代/别墅/小屋/木屋)
  if (p.includes('现代') || p.includes('别墅') || p.includes('小屋') || p.includes('villa') || p.includes('house')) {
    return {
      explanation: `已生成 ${w}×9×${d} 双层现代落地窗别墅建筑（石英挑台、深色橡木格栅与玻璃幕墙）。`,
      code: `const b = createBuilder('AI_现代双层景观别墅', { x: ${w}, y: 10, z: ${d} }, '${ver}');
b.fill(0, 0, 0, ${w - 1}, 0, ${d - 1}, 'minecraft:polished_andesite');
b.fill(1, 0, 1, ${w - 2}, 0, ${d - 2}, 'minecraft:dark_oak_planks');
b.windowWall(1, 1, 1, ${w - 2}, 4, ${d - 2}, 'minecraft:smooth_quartz', 'minecraft:black_stained_glass_pane', 2);
b.clear(3, 1, 1, 4, 3, 1);
b.fill(0, 4, 0, ${w - 1}, 4, ${d - 1}, 'minecraft:smooth_quartz_slab[type=bottom]');
b.windowWall(2, 5, 3, ${w - 3}, 8, ${d - 2}, 'minecraft:gray_concrete', 'minecraft:light_blue_stained_glass', 2);
b.walls(1, 5, 1, ${w - 2}, 5, 3, 'minecraft:black_stained_glass_pane');
b.fill(1, 8, 2, ${w - 2}, 8, ${d - 1}, 'minecraft:smooth_quartz');
b.set(2, 3, 2, 'minecraft:sea_lantern');
b.set(${w - 3}, 7, ${d - 3}, 'minecraft:sea_lantern');
return b.build();`
    };
  }

  // Default: Medieval Watchtower / Keep (中世纪瞭望塔/城堡)
  const cx = Math.floor(w / 2);
  const cz = Math.floor(d / 2);
  const r = Math.max(3, Math.min(cx, cz) - 1);
  return {
    explanation: `已生成高 ${h} 格的中世纪石砖螺旋楼梯瞭望塔（含雉堞垛口、螺旋步道与尖顶）。`,
    code: `const b = createBuilder('AI_中世纪瞭望箭塔', { x: ${w}, y: ${h + 4}, z: ${d} }, '${ver}');
b.cylinder(${cx}, 0, ${cz}, ${r + 1}, 2, 'minecraft:cobblestone', false);
b.cylinder(${cx}, 2, ${cz}, ${r}, ${h - 3}, 'minecraft:stone_bricks', true);
b.clear(${cx}, 2, ${cz - r}, ${cx}, 4, ${cz - r});
b.spiralStairs(${cx}, 2, ${cz}, ${Math.max(1, r - 2)}, ${h - 4}, 'minecraft:spruce_slab[type=bottom]');
b.cylinder(${cx}, ${h - 1}, ${cz}, ${r + 1}, 1, 'minecraft:polished_deepslate', false);
for (let x = ${cx - r - 1}; x <= ${cx + r + 1}; x += 2) {
  b.set(x, ${h}, ${cz - r - 1}, 'minecraft:stone_brick_wall');
  b.set(x, ${h}, ${cz + r + 1}, 'minecraft:stone_brick_wall');
}
b.pyramidRoof(${cx - r}, ${h}, ${cz - r}, ${cx + r}, ${cz + r}, 'minecraft:spruce_stairs', 'minecraft:spruce_slab');
b.set(${cx}, ${h - 2}, ${cz}, 'minecraft:lantern[hanging=true]');
return b.build();`
  };
}
