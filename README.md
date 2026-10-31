# MC 结构全生态可视化工作台 (`MC Structure Visualizer`)

面向建筑师、生电红石玩家与大型整合包（Modpack）作者的 **桌面原生 (`Tauri v2 + Rust`) + Web (`React 19 + Three.js WebGL2`) 双栖 Minecraft 3D 结构可视化、转换与实机联调工作台**。

---

## 核心特性一览

### 1. 双核心版本与跨加载器广泛模组生态兼容
- **原生双版本底座 (`Java 1.21.11` & `Java 1.20.1`)**：内置官方客户端资源提取与 DataGen 注册表管线，支持一键双向迁移 `DataVersion`（`3465 <-> 4671`）、重命名方块 ID（如 `minecraft:grass <-> minecraft:short_grass`）以及容器方块实体 `ItemStack` 格式（`1.20.1 {id, Count, tag}` <-> `1.21+ {id, count, components}`）。
- **全模组加载器兼容 (`Forge` / `NeoForge` / `Fabric` / `Quilt`)**：
  - 自动解析 `META-INF/mods.toml`、`META-INF/neoforge.mods.toml`、`fabric.mod.json`、`quilt.mod.json`。
  - 支持递归挂载 **Jar-in-Jar (`META-INF/jars/*.jar`)** 与整合包魔改目录 **`kubejs/assets/`**。
  - 原生解析 **`forge:obj` / `neoforge:obj`** Wavefront `.obj + .mtl` 机械模型（如机械动力 Create 水车/传动杆）、`forge:composite` 复合模型与旧版 `forge_marker: 1`。
  - 支持 **FramedBlocks（伪装方块 `camo`）** 与 **Domum Ornamentum（`textureData`）** 动态 NBT 材质覆盖。
  - **零 JAR 智能语义回退**：未导入模组 JAR 时，自动根据方块名称与属性推断几何体（楼梯/半砖/墙/栅栏/管道）与命名空间确定性配色，彻底告别紫黑缺失块。

### 2. 首批内置 7 大结构格式全双工读写互转
| 格式 | 扩展名 | 支持特性 |
| :--- | :--- | :--- |
| **Litematica 投影** | `.litematic` | 多子区域 (Multi-Region)、紧凑 `LongArray` 位流解包/打包、方块实体保留 |
| **WorldEdit / Sponge** | `.schem` (v1–v3) / `.schematic` | Sponge v1/v2/v3 VarInt 调色板与旧版 1.12 MCEdit Alpha ID 映射 |
| **原版结构与机械动力蓝图** | `.nbt` | 原版 Structure Block 与 Create `create:super_glue` 蓝图无缝读写 |
| **建筑小帮手 (Building Gadgets)** | `.json` / 剪贴板 | 同时支持 1.20.1/1.21 **BG2** (`statePosArrayList` 内嵌 SNBT) 与旧版 **BG1** |
| **Axiom 蓝图** | `.bp` | 二进制魔数头 `0x0AE5BB36` + 自动截取内嵌缩略图 PNG + `16×16×16` 分块 |
| **Structurize / 模拟殖民地** | `.blueprint` | 16-bit 大端 / IntArray 调色板体素矩阵、`required_mods` 依赖解析与导出 |
| **原版调试剪贴板指令** | `F3+I` / `.mcfunction` | 直接粘贴 `/setblock` 指令检视单方块 NBT 或批量导入导出指令集 |

### 3. 自定义方块工坊 & 第三方全能导入中心
- **可视化自定义方块工坊 (`Custom Block Studio`)**：无需编写模组即可创建自定义方块（完整方块/楼梯/半砖/十字植物/透明玻璃/发光体）、上传六面贴图、导入 **Blockbench `.bbmodel`**，并导出/导入 `.mcvis-pack.json` 资源预设包。
- **第三方 3D / 2D / 存档导入**：
  - **外部 3D 网格体素化 (`.obj` / `.stl` / `.glb`)**：BVH 表面采样 + **CIELAB ($\Delta E$) 感知色差匹配** 自动挑选最接近的原版方块。
  - **MagicaVoxel (`.vox`)** 体素直导。
  - **Blockbench (`.bbmodel`)** 双模式导入（高精度自定义方块 / 大比例体素雕塑）。
  - **2D 像素画 & 生存阶梯地图画 (`.png` / `.jpg` / `.webp`)**：支持立面像素画、平铺地图画与 **3D 高低落差阴影地图画 (Staircased Map Art)** + Floyd-Steinberg 抖动。
  - **原版存档区域直裁 (`.mca`)**：拖入 `r.x.z.mca` 即可按坐标裁剪建筑区域。

### 4. 生电红石透视、生存备料单 (BOM)、AI/MCP 生成与本地真服闭环
- **交互式 3D/2D 视图**：透视 / 正交六视图、X/Y/Z 逐层切片、**半透明幽灵引导层 (Ghost Layer)**、体素画笔与全局材质替换（含 Undo/Redo）。
- **生电红石增强叠加层**：3D 朝向箭头（侦测器/漏斗/投掷器/活塞）、红石线 `0–15` 信号强度标签、中继器档位与锁存、比较器减法模式、合成器槽位与铜灯状态徽章。
- **生存精准 BOM 清单**：自动折算 `潜影盒 (1,728) + 组 (64/16/1) + 零散个`，支持双门/双层半砖折算与箱子/木桶/漏斗内部物品汇总，一键导出 CSV / Markdown。
- **Modrinth `.mrpack` 解析与缺失模组一键云端拉取**：支持直接导入 `.mrpack` 整合包（提取 `overrides/kubejs/assets` 及插件服 ItemsAdder/Oraxen 自定义材质包重定向），并支持一键从 Modrinth CDN 自动下载蓝图缺失模组 `.jar`。
- **工作台内建本地真实 MC 测试服 (`1.21.11-fabric` + `1.20.1-fabric`) 启停与实时投射**：可在界面内一键启动/安全关停本地 Fabric 测试服，通过 RCON 将当前结构实时投射进世界、自动保存 WorldEdit `.schem`，并操控 Carpet `tick freeze` / `tick step` 逐步验证红石时序。

### 5. AI 建筑师 · 多厂商大模型桥接与双向 MCP / REST API 实时互联
- **多厂商 AI 结构生成与增量改建 (`packages/core/src/ai-architect.ts` + `tools/ai-bridge.mjs`)**：
  - 原生对接 **Google Gemini (`v1beta`)**、**DeepSeek (`V3` / `R1` 自动剥离 `<think>`)**、**OpenAI 兼容网关（SiliconFlow / 通义千问 / OpenRouter）**、**Anthropic Claude (`v1/messages`)**、**本地 Ollama (`127.0.0.1:11434`)**，并内置 **离线参数化建筑引擎**（免 Key 开箱可生成中式重檐阁楼、哥特哨塔、现代悬挑别墅、赛博反应堆机房、穹顶星象台等）。
  - **真注册表上下文注入与自愈修复**：自动向大模型注入当前基准版本（`1.21.11` / `1.20.1` 方块差异约束）、已挂载 Forge/NeoForge/Fabric 模组方块列表与自定义方块 ID；生成后针对 Mojang 官方 `blocks-registry.json` 自动修复单复数/别名拼写偏差，若脚本报错自动触发 1 轮 AI 自修复重试。
  - **双模式与多轮回溯**：支持 **从零新建 (`createBuilder`)** 与 **基于当前 3D 视口结构增量改建 (`editBaseStructure`)**，支持多轮演进历史一键回滚。
- **双向实时 MCP 桥接 (`Stdio` + `Streamable HTTP`)**：
  - 外部 AI Agent（Claude Desktop / Claude Code / Cursor / Windsurf / Antigravity）调用 MCP 工具生成或修改结构时，通过 SSE（Web 端 `:5173`）与原生 TCP Loopback（Tauri 桌面端 `:17890`）**毫秒级实时推入 3D 视口渲染**，同时可随时读取用户在 3D 视口中正在编辑的结构！
  - 内置 **9 个 MCP 工具**：`get_live_viewport_structure`、`push_structure_to_viewport`、`build_structure_from_dsl`、`edit_live_viewport_structure`、`ai_generate_structure`、`inspect_structure`、`convert_structure`、`deploy_structure_to_server`、`mc_server_rcon`。

---

## 目录架构

```text
MC结构可视化工具/
├── mc-env/                   # 本地双版本 (1.21.11 + 1.20.1) MC 资源提取与 Fabric+WorldEdit+Carpet 测试服环境
├── packages/
│   ├── core/                 # @mcvis/core: UniversalStructureIR、跨版本转换器、BOM、高阶建筑 DSL、AI 建筑师引擎
│   ├── formats/              # @mcvis/formats: 7 大结构格式全双工解析与序列化器 + 二进制 NBT / SNBT
│   ├── mod-loader/           # @mcvis/mod-loader: Forge/NeoForge/Fabric/Quilt JAR 虚拟文件系统、OBJ 解析、FramedBlocks 伪装
│   ├── importers/            # @mcvis/importers: OBJ/STL/GLB 体素化、MagicaVoxel .vox、Blockbench、地图画、Anvil .mca
│   ├── renderer/             # @mcvis/renderer: Three.js WebGL2 分块贪婪/剔除网格化、动态贴图集、红石叠加层
│   └── ui/                   # @mcvis/ui: 共享工作台界面 (Web 与 Tauri 桌面端 100% 共享核心 UI)
├── apps/
│   ├── web/                  # @mcvis/web: 浏览器工作台 + HTTP MCP / SSE 实时桥接 / 多厂商 LLM 代理中间件
│   └── desktop/              # @mcvis/desktop: Tauri v2 + Rust 原生客户端 (内置 ureq LLM 代理 + 127.0.0.1:17890 MCP 桥接)
├── samples/                  # 开箱即测的 9 个全格式示例文件 (.litematic/.schem/.nbt/.bg2.json/.bp/.blueprint/.mcfunction/.obj/.mcvis-pack.json)
└── tools/
    ├── ai-bridge.mjs         # 多厂商大模型 API 路由、AI 自愈生成与 9 大 MCP 工具共享内核
    ├── generate-samples.mjs  # 示例资产一键生成器 (pnpm mc:samples)
    └── mcp-server.mjs        # 双向实时同步 Stdio JSON-RPC 2.0 MCP Server (自动联动 Web :5173 与 Desktop :17890)
```

---

## 快速上手

### 1. 安装依赖与初始化双版本 MC 环境（首次已完成）
```powershell
pnpm install

# 提取 Mojang 1.21.11 + 1.20.1 原版模型/贴图/DataGen 注册表与中文语言包
pnpm mc:assets

# 部署本地 1.21.11-fabric 与 1.20.1-fabric 测试服 (含 Fabric API + WorldEdit + Carpet)
pnpm mc:server

# 环境自检验证
pnpm mc:verify
```

### 2. 启动 Web 工作台（含本地整合包扫描与测试服 RCON 桥接）
```powershell
pnpm dev:web
# 浏览器打开 http://localhost:5173
```

### 3. 启动桌面原生客户端 (`Tauri v2 + Rust`)
```powershell
pnpm dev:desktop
```

### 4. 启动本地真实 MC 测试服进行实机联调
```powershell
# 启动 1.21.11 测试服 (游戏端口 25565, RCON 25575)
.\mc-env\start-server.ps1 -Profile 1.21.11-fabric

# 或启动 1.20.1 测试服 (游戏端口 25566, RCON 25576)
.\mc-env\start-server.ps1 -Profile 1.20.1-fabric
```

### 5. 配置 MCP 双向实时桥接与 REST 生成 API
支持两种 MCP 传输协议，调用工具后生成的结构将**实时推送至当前打开的 Web (`127.0.0.1:5173`) 或 Tauri 桌面端 (`127.0.0.1:17890`) 3D 视口**：

#### 方式 A：Stdio MCP（适用于 Claude Desktop / Claude Code / Cursor / Windsurf / Antigravity）
```json
{
  "mcpServers": {
    "mc-structure-visualizer": {
      "command": "node",
      "args": ["/path/to/mc-structure-visualizer/tools/mcp-server.mjs"]
    }
  }
}
```

#### 方式 B：Streamable HTTP MCP（Web 工作台启动后开箱即用）
```json
{
  "mcpServers": {
    "mc-structure-visualizer-http": {
      "url": "http://127.0.0.1:5173/api/mcp"
    }
  }
}
```

#### 方式 C：外部程序直调 REST 结构生成与推送 API
```powershell
curl -X POST "http://127.0.0.1:5173/api/mc-bridge/generate-structure" `
  -H "Content-Type: application/json" `
  -d '{\"prompt\":\"生成一座 15x14x15 中式飞檐阁楼\",\"mcVersion\":\"1.21.11\",\"format\":\"schem\",\"pushToViewport\":true}'
```
（支持读取系统环境变量 `GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`，或在工作台「AI生成/MCP」面板内配置并保存在本地 gitignore 安全缓存 `mc-env/.cache/ai-config.json`。）
