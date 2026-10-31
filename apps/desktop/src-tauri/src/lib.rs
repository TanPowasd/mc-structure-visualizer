use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use zip::write::SimpleFileOptions;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModpackInstance {
    pub id: String,
    pub launcher: String,
    pub name: String,
    pub path: String,
    pub mods_count: usize,
    pub has_kube_js: bool,
}

#[derive(Clone)]
struct InternalModpackRecord {
    pub info: DiscoveredModpackInstance,
    pub mods_dir: PathBuf,
    pub root_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedArchive {
    pub file_name: String,
    pub base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VanillaAssetBundlePayload {
    pub mc_version: String,
    pub blockstates: Value,
    pub models: Value,
    pub blocks_registry: Value,
    pub texture_base_url: String,
}

#[derive(Deserialize)]
pub struct Vec3Input {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusPayload {
    pub online: bool,
    pub port: u16,
    pub rcon_port: u16,
}

#[derive(Deserialize)]
struct McEnvServerCfg {
    #[serde(default)]
    #[serde(rename = "javaKey")]
    java_key: String,
    port: u16,
    #[serde(rename = "rconPort")]
    rcon_port: u16,
    #[serde(rename = "rconPassword")]
    rcon_password: String,
    #[serde(default = "default_mem_min")]
    #[serde(rename = "memoryMin")]
    memory_min: String,
    #[serde(default = "default_mem_max")]
    #[serde(rename = "memoryMax")]
    memory_max: String,
}

fn default_mem_min() -> String {
    "1G".to_string()
}
fn default_mem_max() -> String {
    "3G".to_string()
}

#[derive(Deserialize)]
struct McEnvConfig {
    #[serde(default)]
    java: std::collections::HashMap<String, String>,
    #[serde(rename = "serverProfiles")]
    server_profiles: std::collections::HashMap<String, McEnvServerCfg>,
}

fn locate_mc_env_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<&Path> = Some(cwd.as_path());
        while let Some(dir) = cur {
            candidates.push(dir.join("mc-env"));
            cur = dir.parent();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur: Option<&Path> = exe.parent();
        while let Some(dir) = cur {
            candidates.push(dir.join("mc-env"));
            cur = dir.parent();
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest_dir.parent().and_then(|p| p.parent()) {
        candidates.push(repo_root.join("mc-env"));
    }

    candidates.into_iter().find(|p| p.join("config.json").is_file())
}

fn mcasset_scheme_base() -> &'static str {
    if cfg!(target_os = "windows") || cfg!(target_os = "android") {
        "http://mcasset.localhost"
    } else {
        "mcasset://localhost"
    }
}

fn sanitize_rel_path(raw_uri_path: &str) -> Option<PathBuf> {
    let trimmed = raw_uri_path.trim_start_matches('/');
    let mut rel = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(seg) => rel.push(seg),
            _ => return None,
        }
    }
    Some(rel)
}

fn count_jars(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("jar"))
                .unwrap_or(false)
        })
        .count()
}

fn scan_all_modpacks() -> Vec<InternalModpackRecord> {
    let mut records: Vec<InternalModpackRecord> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    let mut push_candidate = |launcher: &str, name: &str, root: PathBuf, custom_mods: Option<PathBuf>| {
        let canonical = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        if !seen.insert(canonical.clone()) {
            return;
        }
        let mods_dir = custom_mods.unwrap_or_else(|| root.join("mods"));
        let mods_count = count_jars(&mods_dir);
        let has_kube_js = root.join("kubejs").join("assets").is_dir();
        if mods_count == 0 && !has_kube_js {
            return;
        }
        let idx = records.len();
        records.push(InternalModpackRecord {
            info: DiscoveredModpackInstance {
                id: format!("{launcher}:{name}:{idx}"),
                launcher: launcher.to_string(),
                name: name.to_string(),
                path: canonical.to_string_lossy().to_string(),
                mods_count,
                has_kube_js,
            },
            mods_dir,
            root_dir: canonical,
        });
    };

    // 1. Built-in verified test mods from mc-env/.cache/test-mods
    if let Some(mc_env) = locate_mc_env_dir() {
        let test_mods = mc_env.join(".cache").join("test-mods");
        if test_mods.is_dir() {
            push_candidate(
                "MC-Env 内置测试库",
                "根目录测试模组",
                test_mods.clone(),
                Some(test_mods.clone()),
            );
            if let Ok(subs) = fs::read_dir(&test_mods) {
                for ent in subs.flatten() {
                    if ent.path().is_dir() {
                        let name = ent.file_name().to_string_lossy().to_string();
                        push_candidate(
                            "MC-Env 实测模组集",
                            &name,
                            ent.path(),
                            Some(ent.path()),
                        );
                    }
                }
            }
        }
    }

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let app_data = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join("AppData").join("Roaming")));

    // 2. .minecraft + PCL2 / HMCL isolated versions
    if let Some(ref roaming) = app_data {
        let dot_mc = roaming.join(".minecraft");
        if dot_mc.is_dir() {
            push_candidate("Official/PCL2/HMCL", ".minecraft (主目录)", dot_mc.clone(), None);
            if let Ok(vers) = fs::read_dir(dot_mc.join("versions")) {
                for ent in vers.flatten() {
                    if ent.path().is_dir() {
                        let name = ent.file_name().to_string_lossy().to_string();
                        push_candidate("PCL2/HMCL 版本隔离", &name, ent.path(), None);
                    }
                }
            }
        }

        // 3. PrismLauncher
        let prism = roaming.join("PrismLauncher").join("instances");
        if let Ok(insts) = fs::read_dir(prism) {
            for ent in insts.flatten() {
                if ent.path().is_dir() {
                    let name = ent.file_name().to_string_lossy().to_string();
                    let sub_dot = ent.path().join(".minecraft");
                    let target = if sub_dot.is_dir() {
                        sub_dot
                    } else {
                        ent.path().join("minecraft")
                    };
                    push_candidate("PrismLauncher", &name, target, None);
                }
            }
        }

        // 4. Modrinth App
        let modrinth = roaming.join("ModrinthApp").join("profiles");
        if let Ok(profs) = fs::read_dir(modrinth) {
            for ent in profs.flatten() {
                if ent.path().is_dir() {
                    let name = ent.file_name().to_string_lossy().to_string();
                    push_candidate("Modrinth", &name, ent.path(), None);
                }
            }
        }
    }

    // 5. CurseForge
    if let Some(ref h) = home {
        let cf = h.join("curseforge").join("minecraft").join("Instances");
        if let Ok(insts) = fs::read_dir(cf) {
            for ent in insts.flatten() {
                if ent.path().is_dir() {
                    let name = ent.file_name().to_string_lossy().to_string();
                    push_candidate("CurseForge", &name, ent.path(), None);
                }
            }
        }
    }

    records
}

fn build_kubejs_zip(instance_root: &Path) -> Option<Vec<u8>> {
    let kube_assets = instance_root.join("kubejs").join("assets");
    if !kube_assets.is_dir() {
        return None;
    }

    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut count = 0usize;

        fn walk_dir(
            dir: &Path,
            prefix: &str,
            zip: &mut zip::ZipWriter<&mut Cursor<Vec<u8>>>,
            opts: SimpleFileOptions,
            count: &mut usize,
        ) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for ent in entries.flatten() {
                let p = ent.path();
                let name = ent.file_name().to_string_lossy().to_string();
                let rel = format!("{prefix}/{name}");
                if p.is_dir() {
                    walk_dir(&p, &rel, zip, opts, count);
                } else if let Ok(bytes) = fs::read(&p) {
                    if zip.start_file(&rel, opts).is_ok() && zip.write_all(&bytes).is_ok() {
                        *count += 1;
                    }
                }
            }
        }

        walk_dir(&kube_assets, "assets", &mut zip, opts, &mut count);
        if count == 0 {
            return None;
        }
        let _ = zip.finish();
    }
    Some(buf.into_inner())
}

fn rcon_write_packet(stream: &mut TcpStream, req_id: i32, pkt_type: i32, body: &str) -> Result<(), String> {
    let body_bytes = body.as_bytes();
    let pkt_len = (4 + 4 + body_bytes.len() + 2) as i32;
    let mut buf = Vec::with_capacity(4 + pkt_len as usize);
    buf.extend_from_slice(&pkt_len.to_le_bytes());
    buf.extend_from_slice(&req_id.to_le_bytes());
    buf.extend_from_slice(&pkt_type.to_le_bytes());
    buf.extend_from_slice(body_bytes);
    buf.push(0);
    buf.push(0);
    stream.write_all(&buf).map_err(|e| format!("RCON 发送失败: {e}"))
}

fn rcon_read_packet(stream: &mut TcpStream) -> Result<(i32, i32, String), String> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .map_err(|e| format!("RCON 读取响应失败: {e}"))?;
    let pkt_len = i32::from_le_bytes(len_buf);
    if !(10..=4_194_304).contains(&pkt_len) {
        return Err(format!("非法 RCON 封包长度: {pkt_len}"));
    }
    let mut payload = vec![0u8; pkt_len as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|e| format!("RCON 读取负载失败: {e}"))?;
    let req_id = i32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let pkt_type = i32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
    let text_end = payload.len().saturating_sub(2);
    let body = String::from_utf8_lossy(&payload[8..text_end]).to_string();
    Ok((req_id, pkt_type, body))
}

fn execute_rcon_batch(port: u16, password: &str, commands: &[String]) -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| {
        format!("无法连接到本地测试服 RCON (127.0.0.1:{port}): {e}。请先运行 .\\mc-env\\start-server.ps1")
    })?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));

    // Authenticate (type = 3)
    rcon_write_packet(&mut stream, 1, 3, password)?;
    loop {
        let (resp_id, _pkt_type, _) = rcon_read_packet(&mut stream)?;
        if resp_id == -1 {
            return Err("RCON 认证密码错误".to_string());
        }
        if resp_id == 1 {
            break;
        }
    }

    let mut outputs = Vec::new();
    for (idx, cmd) in commands.iter().enumerate() {
        let req_id = 10 + idx as i32;
        rcon_write_packet(&mut stream, req_id, 2, cmd)?;
        let (_rid, _ptype, body) = rcon_read_packet(&mut stream)?;
        if !body.is_empty() {
            outputs.push(body);
        }
    }
    Ok(outputs.join("\n"))
}

#[tauri::command]
fn load_vanilla_bundle(mc_version: String) -> Result<Option<VanillaAssetBundlePayload>, String> {
    if mc_version != "1.21.11" && mc_version != "1.20.1" {
        return Err(format!("Unsupported MC version: {mc_version}"));
    }
    let Some(mc_env) = locate_mc_env_dir() else {
        return Ok(None);
    };
    let bundle_dir = mc_env.join("assets").join("bundle").join(&mc_version);
    if !bundle_dir.is_dir() {
        return Ok(None);
    }

    let bs_str = fs::read_to_string(bundle_dir.join("blockstates.json"))
        .map_err(|e| format!("Failed reading blockstates.json: {e}"))?;
    let mod_str = fs::read_to_string(bundle_dir.join("models.json"))
        .map_err(|e| format!("Failed reading models.json: {e}"))?;
    let reg_str = fs::read_to_string(bundle_dir.join("blocks-registry.json"))
        .map_err(|e| format!("Failed reading blocks-registry.json: {e}"))?;

    let blockstates: Value = serde_json::from_str(&bs_str).map_err(|e| e.to_string())?;
    let models: Value = serde_json::from_str(&mod_str).map_err(|e| e.to_string())?;
    let blocks_registry: Value = serde_json::from_str(&reg_str).map_err(|e| e.to_string())?;

    Ok(Some(VanillaAssetBundlePayload {
        texture_base_url: format!("{}/extracted/{}", mcasset_scheme_base(), mc_version),
        mc_version,
        blockstates,
        models,
        blocks_registry,
    }))
}

#[tauri::command]
fn discover_modpacks() -> Vec<DiscoveredModpackInstance> {
    scan_all_modpacks().into_iter().map(|r| r.info).collect()
}

#[tauri::command]
fn read_modpack_archives(
    instance_path: String,
    needed_namespaces: Vec<String>,
) -> Result<Vec<EncodedArchive>, String> {
    let target_canon = fs::canonicalize(&instance_path).unwrap_or_else(|_| PathBuf::from(&instance_path));
    let record = scan_all_modpacks()
        .into_iter()
        .find(|r| r.root_dir == target_canon)
        .ok_or_else(|| "未受信任或不存在的整合包路径".to_string())?;

    let lowered_ns: Vec<String> = needed_namespaces.iter().map(|s| s.to_lowercase()).collect();
    let mut jar_paths: Vec<(usize, String, PathBuf)> = Vec::new();

    if let Ok(entries) = fs::read_dir(&record.mods_dir) {
        for ent in entries.flatten() {
            let p = ent.path();
            let is_jar = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("jar"))
                .unwrap_or(false);
            if !is_jar {
                continue;
            }
            if let Ok(meta) = p.metadata() {
                if meta.len() > 120 * 1024 * 1024 {
                    continue;
                }
            }
            let fname = ent.file_name().to_string_lossy().to_string();
            let lower_fname = fname.to_lowercase();
            let compact_fname = lower_fname.replace(['-', '_'], "");
            let matched = lowered_ns.is_empty()
                || lowered_ns.iter().any(|ns| {
                    lower_fname.contains(ns) || compact_fname.contains(&ns.replace(['-', '_'], ""))
                });
            jar_paths.push((if matched { 0 } else { 1 }, fname, p));
        }
    }

    jar_paths.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    jar_paths.truncate(64);

    // Multi-core parallel reading + Base64 encoding via Rayon!
    let mut encoded: Vec<EncodedArchive> = jar_paths
        .into_par_iter()
        .filter_map(|(_, fname, path)| {
            let bytes = fs::read(&path).ok()?;
            Some(EncodedArchive {
                file_name: fname,
                base64: BASE64.encode(bytes),
            })
        })
        .collect();

    if let Some(kube_zip) = build_kubejs_zip(&record.root_dir) {
        encoded.push(EncodedArchive {
            file_name: "kubejs-assets.zip".to_string(),
            base64: BASE64.encode(kube_zip),
        });
    }

    Ok(encoded)
}

fn is_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

#[tauri::command]
fn get_server_status(profile: String) -> Result<ServerStatusPayload, String> {
    let mc_env = locate_mc_env_dir().ok_or_else(|| "未找到 mc-env 目录".to_string())?;
    let cfg_str = fs::read_to_string(mc_env.join("config.json")).map_err(|e| e.to_string())?;
    let cfg: McEnvConfig = serde_json::from_str(&cfg_str).map_err(|e| e.to_string())?;
    let srv = cfg
        .server_profiles
        .get(&profile)
        .ok_or_else(|| format!("未知测试服配置: {profile}"))?;
    Ok(ServerStatusPayload {
        online: is_port_open(srv.rcon_port),
        port: srv.port,
        rcon_port: srv.rcon_port,
    })
}

#[tauri::command]
async fn start_mc_server(profile: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mc_env = locate_mc_env_dir().ok_or_else(|| "未找到 mc-env 目录".to_string())?;
        let cfg_str = fs::read_to_string(mc_env.join("config.json")).map_err(|e| e.to_string())?;
        let cfg: McEnvConfig = serde_json::from_str(&cfg_str).map_err(|e| e.to_string())?;
        let srv = cfg
            .server_profiles
            .get(&profile)
            .ok_or_else(|| format!("未知测试服配置: {profile}"))?;

        if is_port_open(srv.rcon_port) {
            return Ok(format!("{profile} 已在运行中 (RCON 127.0.0.1:{})", srv.rcon_port));
        }

        let srv_dir = mc_env.join("servers").join(&profile);
        let jar_path = srv_dir.join("fabric-server-launch.jar");
        if !jar_path.is_file() {
            return Err(format!("未找到 {:?}，请先运行 pnpm mc:server", jar_path));
        }

        let java_exe = cfg
            .java
            .get(&srv.java_key)
            .cloned()
            .unwrap_or_else(|| "java".to_string());

        let mut cmd = std::process::Command::new(java_exe);
        cmd.current_dir(&srv_dir)
            .args([
                &format!("-Xms{}", srv.memory_min),
                &format!("-Xmx{}", srv.memory_max),
                "-jar",
                "fabric-server-launch.jar",
                "nogui",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.spawn().map_err(|e| format!("拉起 Java 测试服失败: {e}"))?;

        for _ in 0..45 {
            std::thread::sleep(Duration::from_secs(1));
            if is_port_open(srv.rcon_port) {
                return Ok(format!(
                    "{profile} 启动就绪！游戏地址 127.0.0.1:{}，RCON 127.0.0.1:{}",
                    srv.port, srv.rcon_port
                ));
            }
        }
        Ok(format!("{profile} 已在后台拉起，世界加载中，请稍候刷新状态"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_mc_server(profile: String) -> Result<String, String> {
    let mc_env = locate_mc_env_dir().ok_or_else(|| "未找到 mc-env 目录".to_string())?;
    let cfg_str = fs::read_to_string(mc_env.join("config.json")).map_err(|e| e.to_string())?;
    let cfg: McEnvConfig = serde_json::from_str(&cfg_str).map_err(|e| e.to_string())?;
    let srv = cfg
        .server_profiles
        .get(&profile)
        .ok_or_else(|| format!("未知测试服配置: {profile}"))?;
    if !is_port_open(srv.rcon_port) {
        return Ok(format!("{profile} 当前未运行"));
    }
    let _ = execute_rcon_batch(srv.rcon_port, &srv.rcon_password, &["stop".to_string()]);
    Ok(format!("已向 {profile} 发送安全保存停服指令 (stop)"))
}

#[tauri::command]
fn send_rcon_command(profile: String, command: String) -> Result<String, String> {
    let mc_env = locate_mc_env_dir().ok_or_else(|| "未找到 mc-env 目录".to_string())?;
    let cfg_str = fs::read_to_string(mc_env.join("config.json")).map_err(|e| e.to_string())?;
    let cfg: McEnvConfig = serde_json::from_str(&cfg_str).map_err(|e| e.to_string())?;
    let srv = cfg
        .server_profiles
        .get(&profile)
        .ok_or_else(|| format!("未知测试服配置: {profile}"))?;

    let clean = command.trim_start_matches('/').to_string();
    let out = execute_rcon_batch(srv.rcon_port, &srv.rcon_password, &[clean])?;
    Ok(if out.is_empty() {
        "(指令已执行，无文本回显)".to_string()
    } else {
        out
    })
}

#[tauri::command]
fn deploy_schem_to_server(
    profile: String,
    schem_name: String,
    schem_base64: String,
    origin: Vec3Input,
    size: Vec3Input,
    commands: Vec<String>,
) -> Result<String, String> {
    let mc_env = locate_mc_env_dir().ok_or_else(|| "未找到 mc-env 目录".to_string())?;
    let cfg_str = fs::read_to_string(mc_env.join("config.json")).map_err(|e| e.to_string())?;
    let cfg: McEnvConfig = serde_json::from_str(&cfg_str).map_err(|e| e.to_string())?;
    let srv = cfg
        .server_profiles
        .get(&profile)
        .ok_or_else(|| format!("未知测试服配置: {profile}"))?;

    let safe_name: String = schem_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let schem_bytes = BASE64
        .decode(schem_base64.as_bytes())
        .map_err(|e| format!("Invalid schem base64: {e}"))?;

    let schem_dir = mc_env
        .join("servers")
        .join(&profile)
        .join("config")
        .join("worldedit")
        .join("schematics");
    fs::create_dir_all(&schem_dir).map_err(|e| e.to_string())?;
    fs::write(schem_dir.join(format!("{safe_name}.schem")), &schem_bytes)
        .map_err(|e| format!("写入 .schem 失败: {e}"))?;

    let mut batch = Vec::with_capacity(commands.len() + 2);
    batch.push(format!(
        "forceload add {} {} {} {}",
        origin.x - 16,
        origin.z - 16,
        origin.x + size.x + 16,
        origin.z + size.z + 16
    ));
    batch.push(format!(
        "fill {} {} {} {} {} {} minecraft:air",
        origin.x,
        origin.y,
        origin.z,
        origin.x + (size.x - 1).max(0),
        origin.y + (size.y - 1).max(0),
        origin.z + (size.z - 1).max(0)
    ));
    batch.extend(commands.iter().cloned());

    execute_rcon_batch(srv.rcon_port, &srv.rcon_password, &batch)?;
    Ok(format!(
        "已写入 WorldEdit 原理图 {safe_name}.schem，并通过原生 Rust RCON 向 ({}, {}, {}) 投射 {} 个方块",
        origin.x,
        origin.y,
        origin.z,
        commands.len()
    ))
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLiveState {
    pub name: String,
    pub mc_version: String,
    pub schem_base64: String,
    pub dsl_code: String,
    pub updated_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMsgInput {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatReqInput {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub system_prompt: String,
    pub messages: Vec<AiChatMsgInput>,
    #[serde(default = "default_temp")]
    pub temperature: f64,
}

fn default_temp() -> f64 {
    0.25
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRespOutput {
    pub content: String,
    pub provider: String,
    pub model: String,
    pub used_env_key: bool,
}

fn detect_env_keys_json() -> Value {
    json!({
        "gemini": std::env::var("GEMINI_API_KEY").is_ok() || std::env::var("GOOGLE_API_KEY").is_ok(),
        "deepseek": std::env::var("DEEPSEEK_API_KEY").is_ok(),
        "openai": std::env::var("OPENAI_API_KEY").is_ok(),
        "anthropic": std::env::var("ANTHROPIC_API_KEY").is_ok(),
    })
}

fn resolve_rust_api_key(provider: &str, endpoint: &str, explicit: &str, saved: &str) -> (String, bool) {
    if !explicit.trim().is_empty() {
        return (explicit.trim().to_string(), false);
    }
    if !saved.trim().is_empty() {
        return (saved.trim().to_string(), false);
    }
    let ep = endpoint.to_lowercase();
    if provider == "gemini" || ep.contains("googleapis.com") {
        if let Ok(k) = std::env::var("GEMINI_API_KEY").or_else(|_| std::env::var("GOOGLE_API_KEY")) {
            if !k.is_empty() {
                return (k, true);
            }
        }
    }
    if ep.contains("deepseek.com") {
        if let Ok(k) = std::env::var("DEEPSEEK_API_KEY") {
            if !k.is_empty() {
                return (k, true);
            }
        }
    }
    if provider == "anthropic" || ep.contains("anthropic.com") {
        if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
            if !k.is_empty() {
                return (k, true);
            }
        }
    }
    if let Ok(k) = std::env::var("OPENAI_API_KEY") {
        if !k.is_empty() {
            return (k, true);
        }
    }
    (String::new(), false)
}

#[tauri::command]
fn load_ai_config() -> Result<Option<Value>, String> {
    let has_env = detect_env_keys_json();
    if let Some(mc_env) = locate_mc_env_dir() {
        let p = mc_env.join(".cache").join("ai-config.json");
        if let Ok(txt) = fs::read_to_string(p) {
            if let Ok(mut val) = serde_json::from_str::<Value>(&txt) {
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("hasEnvKey".to_string(), has_env);
                }
                return Ok(Some(val));
            }
        }
    }
    Ok(Some(json!({
        "presetId": "gemini",
        "provider": "gemini",
        "endpoint": "https://generativelanguage.googleapis.com/v1beta",
        "model": "gemini-2.5-flash",
        "apiKey": "",
        "hasEnvKey": has_env
    })))
}

#[tauri::command]
fn save_ai_config(cfg: Value) -> Result<(), String> {
    let Some(mc_env) = locate_mc_env_dir() else {
        return Err("未找到 mc-env 目录".to_string());
    };
    let dir = mc_env.join(".cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("ai-config.json"),
        serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ai_chat_completion(req: AiChatReqInput) -> Result<AiChatRespOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let saved_key = load_ai_config()
            .ok()
            .flatten()
            .and_then(|v| v.get("apiKey").and_then(|k| k.as_str()).map(|s| s.to_string()))
            .unwrap_or_default();

        let (key, used_env) = resolve_rust_api_key(&req.provider, &req.endpoint, &req.api_key, &saved_key);

        if req.provider == "gemini" {
            if key.is_empty() {
                return Err("未配置 Gemini API Key（可在面板填写或设置 GEMINI_API_KEY）".to_string());
            }
            let base = if req.endpoint.is_empty() {
                "https://generativelanguage.googleapis.com/v1beta"
            } else {
                req.endpoint.trim_end_matches('/')
            };
            let clean_model = req.model.trim_start_matches("models/");
            let url = if base.contains(":generateContent") {
                base.to_string()
            } else {
                format!("{base}/models/{clean_model}:generateContent")
            };
            let contents: Vec<Value> = req
                .messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| {
                    json!({
                        "role": if m.role == "assistant" { "model" } else { "user" },
                        "parts": [{ "text": m.content }]
                    })
                })
                .collect();

            let mut body = json!({
                "contents": contents,
                "generationConfig": { "temperature": req.temperature }
            });
            if !req.system_prompt.is_empty() {
                body["system_instruction"] = json!({ "parts": [{ "text": req.system_prompt }] });
            }

            let resp = ureq::post(&url)
                .set("Content-Type", "application/json")
                .set("x-goog-api-key", &key)
                .send_json(body)
                .map_err(|e| format!("Gemini API 请求错误: {e}"))?;
            let data: Value = resp.into_json().map_err(|e| e.to_string())?;
            let mut texts = Vec::new();
            if let Some(parts) = data["candidates"][0]["content"]["parts"].as_array() {
                for p in parts {
                    if !p["thought"].as_bool().unwrap_or(false) {
                        if let Some(t) = p["text"].as_str() {
                            texts.push(t.to_string());
                        }
                    }
                }
            }
            return Ok(AiChatRespOutput {
                content: texts.join("\n"),
                provider: "gemini".to_string(),
                model: clean_model.to_string(),
                used_env_key: used_env,
            });
        }

        if req.provider == "anthropic" {
            if key.is_empty() {
                return Err("未配置 Anthropic API Key".to_string());
            }
            let url = if req.endpoint.is_empty() {
                "https://api.anthropic.com/v1/messages"
            } else {
                &req.endpoint
            };
            let msgs: Vec<Value> = req
                .messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| json!({ "role": m.role, "content": m.content }))
                .collect();
            let resp = ureq::post(url)
                .set("Content-Type", "application/json")
                .set("x-api-key", &key)
                .set("anthropic-version", "2023-06-01")
                .send_json(json!({
                    "model": req.model,
                    "max_tokens": 4096,
                    "temperature": req.temperature,
                    "system": req.system_prompt,
                    "messages": msgs
                }))
                .map_err(|e| format!("Anthropic API 请求错误: {e}"))?;
            let data: Value = resp.into_json().map_err(|e| e.to_string())?;
            let text = data["content"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            return Ok(AiChatRespOutput {
                content: text,
                provider: "anthropic".to_string(),
                model: req.model,
                used_env_key: used_env,
            });
        }

        if req.provider == "ollama" {
            let url = if req.endpoint.is_empty() {
                "http://127.0.0.1:11434/api/chat"
            } else {
                &req.endpoint
            };
            let mut msgs = Vec::new();
            if !req.system_prompt.is_empty() {
                msgs.push(json!({ "role": "system", "content": req.system_prompt }));
            }
            for m in &req.messages {
                msgs.push(json!({ "role": m.role, "content": m.content }));
            }
            let resp = ureq::post(url)
                .set("Content-Type", "application/json")
                .send_json(json!({
                    "model": req.model,
                    "messages": msgs,
                    "stream": false,
                    "options": { "temperature": req.temperature }
                }))
                .map_err(|e| format!("Ollama 本地服务请求失败: {e}"))?;
            let data: Value = resp.into_json().map_err(|e| e.to_string())?;
            return Ok(AiChatRespOutput {
                content: data["message"]["content"].as_str().unwrap_or_default().to_string(),
                provider: "ollama".to_string(),
                model: req.model,
                used_env_key: false,
            });
        }

        // OpenAI-compatible (OpenAI / DeepSeek / SiliconFlow / Qwen / OpenRouter)
        let mut url = if req.endpoint.is_empty() {
            "https://api.openai.com/v1/chat/completions".to_string()
        } else {
            req.endpoint.clone()
        };
        if !url.ends_with("/chat/completions") && !url.contains('?') {
            url = format!("{}/chat/completions", url.trim_end_matches('/'));
        }
        let mut msgs = Vec::new();
        if !req.system_prompt.is_empty() {
            msgs.push(json!({ "role": "system", "content": req.system_prompt }));
        }
        for m in &req.messages {
            msgs.push(json!({ "role": m.role, "content": m.content }));
        }
        let mut request = ureq::post(&url).set("Content-Type", "application/json");
        if !key.is_empty() {
            request = request.set("Authorization", &format!("Bearer {key}"));
        }
        let resp = request
            .send_json(json!({
                "model": req.model,
                "messages": msgs,
                "temperature": req.temperature
            }))
            .map_err(|e| format!("大模型 API 请求错误: {e}"))?;
        let data: Value = resp.into_json().map_err(|e| e.to_string())?;
        let content = data["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        Ok(AiChatRespOutput {
            content,
            provider: "openai_compat".to_string(),
            model: req.model,
            used_env_key: used_env,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn sync_live_structure(
    state: tauri::State<'_, Arc<Mutex<DesktopLiveState>>>,
    name: String,
    mc_version: String,
    schem_base64: String,
    dsl_code: String,
) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(mut guard) = state.lock() {
        *guard = DesktopLiveState {
            name,
            mc_version,
            schem_base64,
            dsl_code,
            updated_at: now,
        };
    }
    Ok(())
}

fn spawn_desktop_mcp_bridge_listener(
    app_handle: tauri::AppHandle,
    shared_state: Arc<Mutex<DesktopLiveState>>,
) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind("127.0.0.1:17890") else {
            return;
        };
        for stream in listener.incoming().flatten() {
            let state_ref = Arc::clone(&shared_state);
            let handle_ref = app_handle.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    return;
                }
                let parts: Vec<&str> = request_line.split_whitespace().collect();
                if parts.len() < 2 {
                    return;
                }
                let method = parts[0];
                let path = parts[1];

                let mut content_len = 0usize;
                loop {
                    let mut hdr = String::new();
                    if reader.read_line(&mut hdr).is_err() || hdr == "\r\n" || hdr.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = hdr.split_once(':') {
                        if k.trim().eq_ignore_ascii_case("content-length") {
                            content_len = v.trim().parse().unwrap_or(0);
                        }
                    }
                }

                let mut body_bytes = vec![0u8; content_len.min(32 * 1024 * 1024)];
                if content_len > 0 && reader.read_exact(&mut body_bytes).is_err() {
                    return;
                }

                let write_json = |mut s: &TcpStream, status: &str, val: Value| {
                    let body = val.to_string();
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = s.write_all(resp.as_bytes());
                };

                if method == "GET" && path.starts_with("/api/mc-bridge/live-state") {
                    let snap = state_ref.lock().map(|g| g.clone()).unwrap_or_default();
                    write_json(&stream, "200 OK", serde_json::to_value(snap).unwrap_or_else(|_| json!({})));
                    return;
                }

                if method == "POST" && path.starts_with("/api/mc-bridge/live-push") {
                    if let Ok(val) = serde_json::from_slice::<Value>(&body_bytes) {
                        let schem = val["schemBase64"].as_str().unwrap_or_default().to_string();
                        let dsl = val["dslCode"].as_str().unwrap_or_default().to_string();
                        let name = val["name"].as_str().unwrap_or("MCP_Structure").to_string();
                        let mc_ver = val["mcVersion"].as_str().unwrap_or("1.21.11").to_string();
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        if let Ok(mut guard) = state_ref.lock() {
                            *guard = DesktopLiveState {
                                name,
                                mc_version: mc_ver,
                                schem_base64: schem.clone(),
                                dsl_code: dsl.clone(),
                                updated_at: now,
                            };
                        }
                        let _ = handle_ref.emit(
                            "mcp-live-event",
                            json!({
                                "type": "push_structure",
                                "source": val["source"].as_str().unwrap_or("mcp-stdio"),
                                "toolName": val["toolName"].as_str().unwrap_or("live_push"),
                                "summary": val["summary"].as_str().unwrap_or("收到外部 MCP 实时结构推送"),
                                "timestamp": now,
                                "schemBase64": schem,
                                "dslCode": dsl
                            }),
                        );
                        write_json(&stream, "200 OK", json!({ "ok": true }));
                        return;
                    }
                }

                write_json(&stream, "404 Not Found", json!({ "ok": false }));
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_live_state = Arc::new(Mutex::new(DesktopLiveState::default()));
    let state_for_setup = Arc::clone(&shared_live_state);

    tauri::Builder::default()
        .manage(shared_live_state)
        .setup(move |app| {
            spawn_desktop_mcp_bridge_listener(app.handle().clone(), state_for_setup);
            Ok(())
        })
        .register_uri_scheme_protocol("mcasset", |_ctx, request| {
            let status_err = |code: u16, msg: &str| {
                tauri::http::Response::builder()
                    .status(code)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(msg.as_bytes().to_vec())
                    .unwrap()
            };

            let Some(mc_env) = locate_mc_env_dir() else {
                return status_err(404, "mc-env not found");
            };
            let Some(rel) = sanitize_rel_path(request.uri().path()) else {
                return status_err(403, "invalid path");
            };
            let full_path = mc_env.join("assets").join(rel);
            let Ok(bytes) = fs::read(&full_path) else {
                return status_err(404, "asset not found");
            };
            let mime = match full_path.extension().and_then(|s| s.to_str()) {
                Some("png") => "image/png",
                Some("json") => "application/json; charset=utf-8",
                _ => "application/octet-stream",
            };

            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "public, max-age=3600")
                .body(bytes)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            load_vanilla_bundle,
            discover_modpacks,
            read_modpack_archives,
            get_server_status,
            start_mc_server,
            stop_mc_server,
            send_rcon_command,
            deploy_schem_to_server,
            load_ai_config,
            save_ai_config,
            ai_chat_completion,
            sync_live_structure
        ])
        .run(tauri::generate_context!())
        .expect("error while running MC Structure Visualizer desktop application");
}
