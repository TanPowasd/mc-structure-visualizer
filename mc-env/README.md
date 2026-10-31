# MC Environment Base (`mc-env`)

本目录提供 **MC 结构可视化工具** 的多版本原版资源底座、跨加载器 Mod 资源扫描器，以及本地真实 Minecraft 实机联动测试服环境。

## 已支持的基准与兼容范围

1. **双版本原版资源与官方注册表底座**
   - **Minecraft Java `1.21.11`**（1.21.x 最新稳定版，基于 JDK 21）
   - **Minecraft Java `1.20.1`**（主流模组与生电高占比版本，基于 JDK 17/21）
   - 自动提取官方 `client.jar` 的 `blockstates`、`models`、`textures`、`en_us.json`，并通过官方 SHA-1 校验拉取 `zh_cn.json`。
   - 调用 Mojang 官方内置 Data Generator (`net.minecraft.data.Main --reports`) 生成权威 `blocks.json` 与 `registries.json`，自动编译出 `1.20.1 <-> 1.21.11` 跨版本差异映射表 (`cross-version-compat.json`)。

2. **全加载器 Mod 资源与模型解析底座 (`scan-mods.mjs`)**
   - 原生支持 **Forge** (`META-INF/mods.toml` / `mcmod.info`)、**NeoForge** (`META-INF/neoforge.mods.toml`)、**Fabric** (`fabric.mod.json`)、**Quilt** (`quilt.mod.json`) 与材质包 (`pack.mcmeta`)。
   - 支持内存级递归解析 **Jar-in-Jar (`META-INF/jars/*.jar`)** 嵌套依赖包。
   - 自动识别 `forge:obj` / `neoforge:obj` (`.obj` 网格)、`forge:composite` / `neoforge:composite`、`forge_marker: 1` 及自定义命名空间模型加载器。

3. **本地真实 MC 测试服环境 (`servers/`)**
   - `1.21.11-fabric`（端口 `25565`，RCON `25575`，内置 Fabric API + WorldEdit + Carpet）
   - `1.20.1-fabric`（端口 `25566`，RCON `25576`，内置 Fabric API + WorldEdit + Carpet）
   - 默认仅绑定 `127.0.0.1`，采用红石就绪砂岩超平坦世界（无生物刷怪干扰），支持通过 RCON 实时读写方块状态、控制刻速率 (`/tick`) 与导入导出结构 (`//schem`)。

## 常用命令

```powershell
# 1. 拉取并编译 1.21.11 + 1.20.1 原版资源与 DataGen 注册表
node mc-env/scripts/setup-assets.mjs

# 2. 扫描任意 Forge / NeoForge / Fabric / Quilt 的 mod.jar 或 mods 文件夹
node mc-env/scripts/scan-mods.mjs --verify-fixtures
node mc-env/scripts/scan-mods.mjs "D:\path\to\.minecraft\mods"

# 3. 部署本地 1.21.11 与 1.20.1 测试服务端
node mc-env/scripts/setup-server.mjs

# 4. 启动本地测试服（默认 1.21.11-fabric，可选 1.20.1-fabric）
.\mc-env\start-server.ps1 -Profile "1.21.11-fabric"
.\mc-env\start-server.ps1 -Profile "1.20.1-fabric"

# 5. 通过内置 RCON 客户端向运行中的测试服发送指令
node mc-env/scripts/rcon-cli.mjs --profile=1.21.11-fabric "list" "carpet"

# 6. 运行环境完整性自检（含实机启动与 RCON 读写自检）
node mc-env/scripts/verify-env.mjs --boot-server
```
