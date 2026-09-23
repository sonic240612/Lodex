#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Daemon {
    child: Child,
    port: u16,
    token: String,
}
struct Bridge {
    daemon: Mutex<Option<Daemon>>,
    client: reqwest::Client,
    stream_epoch: AtomicU64,
    secrets: Mutex<()>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Handshake {
    protocol_version: u8,
    port: u16,
}
impl Bridge {
    fn connection(&self) -> Result<(u16, String), String> {
        let mut guard = self.daemon.lock().map_err(|_| "Daemon lock unavailable")?;
        let daemon = guard.as_mut().ok_or("로컬 데몬이 실행되지 않았습니다.")?;
        if daemon
            .child
            .try_wait()
            .map_err(|_| "데몬 상태 확인 실패")?
            .is_some()
        {
            return Err("로컬 데몬이 종료되었습니다. 앱을 다시 시작하세요.".into());
        }
        Ok((daemon.port, daemon.token.clone()))
    }
    fn stop(&self) {
        if let Ok(mut guard) = self.daemon.lock() {
            if let Some(mut daemon) = guard.take() {
                drop(daemon.child.stdin.take());
                for _ in 0..30 {
                    if daemon.child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = daemon.child.kill();
                let _ = daemon.child.wait();
            }
        }
    }
}

fn openrouter_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.lodex.desktop", "openrouter")
        .map_err(|_| "OS 키 저장소를 열 수 없습니다.".into())
}
fn telegram_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.lodex.desktop", "telegram")
        .map_err(|_| "OS 키 저장소를 열 수 없습니다.".into())
}
fn telegram_token_valid(token: &str) -> bool {
    let Some((owner, secret)) = token.split_once(':') else {
        return false;
    };
    (5..=20).contains(&owner.len())
        && owner.bytes().all(|value| value.is_ascii_digit())
        && (20..=150).contains(&secret.len())
        && secret
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
}
fn start_daemon(app: &tauri::App) -> Result<Daemon, Box<dyn std::error::Error>> {
    let resource = app.path().resource_dir()?;
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut node = resource.join("runtime").join(executable);
    let mut script = resource.join("daemon/main.cjs");
    if cfg!(debug_assertions) && (!node.is_file() || !script.is_file()) {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        node = workspace.join(".runtime").join(executable);
        script = workspace.join("apps/daemon/dist/main.cjs");
    }
    // Tauri may return verbatim Windows paths; Node's module loader rejects them.
    let node = dunce::simplified(&node);
    let script = dunce::simplified(&script);
    let data_path = app.path().app_local_data_dir()?;
    let data_dir = dunce::simplified(&data_path);
    // Development loads only this workspace's .env, never the selected project's.
    // Installed builds use application data, with LODEX_ENV_FILE as an explicit override.
    let development_env = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.env");
    let development_env = dunce::canonicalize(&development_env).unwrap_or(development_env);
    let env_file = if cfg!(debug_assertions) && development_env.is_file() {
        development_env
    } else {
        data_dir.join(".env")
    };
    let env_file = dunce::simplified(&env_file);
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let key = openrouter_key_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok());
    let telegram_token = telegram_key_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok());
    let mut command = Command::new(node);
    command
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let bootstrap = json!({ "token": token, "dataDir": data_dir, "openrouterKey": key, "telegramToken": telegram_token, "parentPid": std::process::id(), "envFile": env_file });
    writeln!(
        child.stdin.as_mut().ok_or("Missing daemon pipe")?,
        "{}",
        bootstrap
    )?;
    let stdout = child.stdout.take().ok_or("Missing daemon output")?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = send.send(result);
    });
    let line = match receive.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(line)) => line,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Lodex daemon startup timed out".into());
        }
    };
    let handshake: Handshake = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    };
    if handshake.protocol_version != 1 || handshake.port == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Incompatible daemon protocol".into());
    }
    Ok(Daemon {
        child,
        port: handshake.port,
        token,
    })
}
fn route_allowed(method: &str, path: &str) -> bool {
    match (method, path) {
        ("GET", "/v1/state")
        | ("GET", "/v1/runtime")
        | ("GET", "/v1/skills")
        | ("GET", "/v1/mcp")
        | ("GET", "/v1/telegram")
        | ("GET", "/v1/worktrees")
        | ("POST", "/v1/telegram/config")
        | ("POST", "/v1/telegram/pair")
        | ("POST", "/v1/telegram/approve")
        | ("POST", "/v1/telegram/unpair")
        | ("POST", "/v1/worktrees")
        | ("POST", "/v1/commands")
        | ("POST", "/v1/projects")
        | ("POST", "/v1/sessions/delete")
        | ("POST", "/v1/execution/cleanup")
        | ("POST", "/v1/runtime/profiles")
        | ("POST", "/v1/runtime/inspect")
        | ("POST", "/v1/runtime/settings")
        | ("POST", "/v1/runtime/action")
        | ("POST", "/v1/runtime/downloads")
        | ("POST", "/v1/runtime/downloads/action")
        | ("GET", "/v1/backups")
        | ("POST", "/v1/backups/create")
        | ("POST", "/v1/backups/export")
        | ("POST", "/v1/backups/settings")
        | ("POST", "/v1/backups/delete")
        | ("POST", "/v1/skills/register")
        | ("POST", "/v1/skills/remove")
        | ("POST", "/v1/mcp/import")
        | ("POST", "/v1/mcp/register")
        | ("POST", "/v1/mcp/remove")
        | ("POST", "/v1/mcp/content")
        | ("POST", "/v1/mcp/completion")
        | ("POST", "/v1/mcp/oauth/prepare")
        | ("POST", "/v1/mcp/oauth/begin")
        | ("POST", "/v1/mcp/oauth/status")
        | ("POST", "/v1/mcp/oauth/cancel")
        | ("POST", "/v1/mcp/oauth/disconnect")
        | ("POST", "/v1/edits")
        | ("POST", "/v1/approvals") => true,
        ("GET", value)
            if value.starts_with("/v1/models?") || value.starts_with("/v1/execution/check?") =>
        {
            !value.contains('#') && !value.contains('\\')
        }
        _ => false,
    }
}
fn external_url_allowed(url: &str) -> bool {
    url.len() <= 8192
        && !url.chars().any(char::is_control)
        && reqwest::Url::parse(url).is_ok_and(|parsed| {
            matches!(parsed.scheme(), "http" | "https" | "mailto")
                && parsed.username().is_empty()
                && parsed.password().is_none()
        })
}
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !external_url_allowed(&url) {
        return Err("지원하지 않는 링크입니다.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "링크를 열지 못했습니다.".into())
}
#[tauri::command]
async fn pick_project_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("프로젝트 폴더 선택")
            .blocking_pick_folder()
            .map(|folder| {
                folder
                    .into_path()
                    .map(|path| dunce::simplified(&path).to_string_lossy().into_owned())
                    .map_err(|_| "로컬 폴더 경로가 필요합니다.".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "폴더 선택 창을 열지 못했습니다.".to_string())?
}
#[tauri::command]
async fn pick_runtime_file(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    if kind != "engine" && kind != "model" {
        return Err("지원하지 않는 파일 종류입니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file().set_title(if kind == "model" {
            "GGUF 모델 선택"
        } else {
            "llama-server 실행 파일 선택"
        });
        if kind == "model" {
            picker = picker.add_filter("GGUF", &["gguf"]);
        }
        picker
            .blocking_pick_file()
            .map(|file| {
                file.into_path()
                    .map(|path| dunce::simplified(&path).to_string_lossy().into_owned())
                    .map_err(|_| "로컬 파일 경로가 필요합니다.".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "파일 선택 창을 열지 못했습니다.".to_string())?
}
#[tauri::command]
async fn pick_mcp_config(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("MCP 설정 파일 선택")
            .add_filter("MCP config", &["json", "jsonc", "toml"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "로컬 파일 경로가 필요합니다.".to_string())?;
        let metadata = std::fs::metadata(&path)
            .map_err(|_| "선택한 MCP 설정 파일을 읽지 못했습니다.".to_string())?;
        if !metadata.is_file() || metadata.len() > 131_072 {
            return Err("MCP 설정은 128 KiB 이하의 일반 파일이어야 합니다.".into());
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|_| "MCP 설정은 UTF-8 텍스트여야 합니다.".to_string())?;
        let cwd = path
            .parent()
            .map(|value| dunce::simplified(value).to_string_lossy().into_owned());
        Ok(Some(json!({
            "path": dunce::simplified(&path).to_string_lossy(),
            "text": text,
            "cwd": cwd
        })))
    })
    .await
    .map_err(|_| "파일 선택 창을 열지 못했습니다.".to_string())?
}
#[tauri::command]
async fn export_backup(
    app: tauri::AppHandle,
    state: State<'_, Bridge>,
) -> Result<Option<Value>, String> {
    let (port, token) = state.connection()?;
    let response = state
        .client
        .post(format!("http://127.0.0.1:{}/v1/backups/export", port))
        .bearer_auth(token)
        .json(&json!({}))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "백업 파일을 만들지 못했습니다.")?;
    if !response.status().is_success() {
        return Err("백업 파일을 만들지 못했습니다.".into());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "잘못된 백업 응답입니다.")?;
    let source = value["path"].as_str().ok_or("백업 파일 경로가 없습니다.")?;
    let name = value["backup"]["name"]
        .as_str()
        .ok_or("백업 파일 이름이 없습니다.")?
        .to_owned();
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "앱 데이터 폴더를 확인하지 못했습니다.")?;
    let root = dunce::canonicalize(data_dir.join("backups"))
        .map_err(|_| "백업 폴더를 확인하지 못했습니다.")?;
    let source = dunce::canonicalize(source).map_err(|_| "백업 파일을 확인하지 못했습니다.")?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("허용되지 않은 백업 파일 경로입니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Lodex 데이터 내보내기")
            .set_file_name(name)
            .add_filter("Lodex backup", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let destination = selected
            .into_path()
            .map_err(|_| "로컬 파일 경로가 필요합니다.".to_string())?;
        if destination != source {
            std::fs::copy(&source, &destination)
                .map_err(|_| "선택한 위치에 백업을 복사하지 못했습니다.".to_string())?;
        }
        Ok(Some(json!({
            "path": dunce::simplified(&destination).to_string_lossy()
        })))
    })
    .await
    .map_err(|_| "파일 저장 창을 열지 못했습니다.".to_string())?
}
#[tauri::command]
async fn daemon_request(
    state: State<'_, Bridge>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !route_allowed(&method, &path) {
        return Err("지원하지 않는 브리지 요청입니다.".into());
    }
    let (port, token) = state.connection()?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "잘못된 요청 방식")?;
    let mut request = state
        .client
        .request(method, format!("http://127.0.0.1:{}{}", port, path))
        .bearer_auth(token)
        .timeout(Duration::from_secs(
            if path == "/v1/runtime/action" || path == "/v1/worktrees" {
                200
            } else if path == "/v1/mcp/register"
                || path == "/v1/mcp/content"
                || path == "/v1/mcp/completion"
                || path == "/v1/mcp/oauth/prepare"
            {
                45
            } else {
                30
            },
        ));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "로컬 데몬 연결이 끊겼습니다.")?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "잘못된 데몬 응답입니다.")?;
    if !status.is_success() {
        return Err(value["error"]["message"]
            .as_str()
            .unwrap_or("명령을 처리하지 못했습니다.")
            .into());
    }
    Ok(value)
}
#[tauri::command]
async fn set_openrouter_key(
    state: State<'_, Bridge>,
    key: Option<String>,
) -> Result<Value, String> {
    if key
        .as_ref()
        .is_some_and(|k| k.is_empty() || k.len() > 1000 || k.contains(['\r', '\n']))
    {
        return Err("API 키 형식이 올바르지 않습니다.".into());
    }
    let (port, token) = state.connection()?;
    let configuration: Value = state
        .client
        .get(format!("http://127.0.0.1:{}/v1/state", port))
        .bearer_auth(&token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "키 설정 상태를 확인하지 못했습니다.")?
        .error_for_status()
        .map_err(|_| "키 설정 상태를 확인하지 못했습니다.")?
        .json()
        .await
        .map_err(|_| "키 설정 상태를 확인하지 못했습니다.")?;
    if matches!(
        configuration["openrouterKeySource"].as_str(),
        Some("environment" | "env_file")
    ) {
        return Err(
            ".env 또는 환경 변수에서 키를 관리 중입니다. 해당 값을 수정하고 앱을 다시 시작하세요."
                .into(),
        );
    }
    {
        let _guard = state.secrets.lock().map_err(|_| "키 저장 잠금 실패")?;
        let entry = openrouter_key_entry()?;
        match &key {
            Some(value) => entry.set_password(value).map_err(|_| {
                "OS 키 저장소에 저장하지 못했습니다. Linux에서는 Secret Service가 필요합니다."
            })?,
            None => match entry.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => (),
                Err(_) => return Err("OS 키 저장소에서 키를 제거하지 못했습니다.".into()),
            },
        }
    }
    let response = state
        .client
        .put(format!("http://127.0.0.1:{}/v1/secret", port))
        .bearer_auth(token)
        .json(&json!({ "key": key }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "키는 OS에 반영됐지만 데몬 연결이 끊겼습니다. 앱을 다시 시작하세요.")?;
    if !response.status().is_success() {
        return Err("키는 OS에 반영됐지만 데몬 갱신이 실패했습니다. 앱을 다시 시작하세요.".into());
    }
    Ok(json!({ "configured": key.is_some() }))
}
#[tauri::command]
async fn set_telegram_token(
    state: State<'_, Bridge>,
    key: Option<String>,
) -> Result<Value, String> {
    if key
        .as_ref()
        .is_some_and(|value| !telegram_token_valid(value))
    {
        return Err("Telegram 봇 토큰 형식이 올바르지 않습니다.".into());
    }
    let (port, token) = state.connection()?;
    let status: Value = state
        .client
        .get(format!("http://127.0.0.1:{}/v1/telegram", port))
        .bearer_auth(&token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Telegram 설정 상태를 확인하지 못했습니다.")?
        .error_for_status()
        .map_err(|_| "Telegram 설정 상태를 확인하지 못했습니다.")?
        .json()
        .await
        .map_err(|_| "Telegram 설정 상태를 확인하지 못했습니다.")?;
    if matches!(
        status["tokenSource"].as_str(),
        Some("environment" | "env_file")
    ) {
        return Err(
            ".env 또는 환경 변수에서 토큰을 관리 중입니다. 해당 값을 수정하고 앱을 다시 시작하세요."
                .into(),
        );
    }
    if status["config"]["enabled"].as_bool() == Some(true) {
        return Err("Telegram 연결을 끄고 설정을 저장한 뒤 토큰을 변경하세요.".into());
    }
    {
        let _guard = state.secrets.lock().map_err(|_| "토큰 저장 잠금 실패")?;
        let entry = telegram_key_entry()?;
        match &key {
            Some(value) => entry.set_password(value).map_err(|_| {
                "OS 키 저장소에 저장하지 못했습니다. Linux에서는 Secret Service가 필요합니다."
            })?,
            None => match entry.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => (),
                Err(_) => return Err("OS 키 저장소에서 토큰을 제거하지 못했습니다.".into()),
            },
        }
    }
    let response = state
        .client
        .put(format!("http://127.0.0.1:{}/v1/telegram/secret", port))
        .bearer_auth(token)
        .json(&json!({ "key": key }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "토큰은 OS에 반영됐지만 Telegram 연결 갱신에 실패했습니다.")?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "잘못된 데몬 응답입니다.")?;
    if !status.is_success() {
        return Err(value["error"]["message"]
            .as_str()
            .unwrap_or("Telegram 토큰을 반영하지 못했습니다.")
            .into());
    }
    Ok(value)
}
#[tauri::command]
async fn connect_events(
    app: tauri::AppHandle,
    state: State<'_, Bridge>,
    after: u64,
    channel: Channel<Value>,
) -> Result<(), String> {
    let (port, token) = state.connection()?;
    let epoch = state.stream_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let client = state.client.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/v1/events?after={}",
                    port, after
                ))
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| ())?;
            if !response.status().is_success() {
                return Err(());
            }
            let mut stream = response.bytes_stream();
            let mut buffer = Vec::new();
            while let Some(chunk) = stream.next().await {
                if app.state::<Bridge>().stream_epoch.load(Ordering::SeqCst) != epoch {
                    return Ok(());
                }
                buffer.extend_from_slice(&chunk.map_err(|_| ())?);
                if buffer.len() > 4_194_304 {
                    return Err(());
                }
                while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=end).collect();
                    if let Some(data) = line.strip_prefix(b"data: ") {
                        let event: Value = serde_json::from_slice(data).map_err(|_| ())?;
                        channel.send(event).map_err(|_| ())?;
                    }
                }
            }
            Err::<(), ()>(())
        }
        .await;
        if result.is_err() && app.state::<Bridge>().stream_epoch.load(Ordering::SeqCst) == epoch {
            let _ = channel.send(json!({ "type": "bridge_disconnected" }));
        }
    });
    Ok(())
}
#[tauri::command]
fn disconnect_events(state: State<'_, Bridge>) {
    state.stream_epoch.fetch_add(1, Ordering::SeqCst);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|app, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(app);
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let daemon = start_daemon(app)?;
            app.manage(Bridge {
                daemon: Mutex::new(Some(daemon)),
                client: reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()?,
                stream_epoch: AtomicU64::new(0),
                secrets: Mutex::new(()),
            });
            let show = MenuItem::with_id(app, "tray_show", "Lodex 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray_quit", "완전히 종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("lodex")
                .tooltip("Lodex")
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_request,
            pick_project_folder,
            pick_runtime_file,
            pick_mcp_config,
            export_backup,
            open_external,
            set_openrouter_key,
            set_telegram_token,
            connect_events,
            disconnect_events
        ])
        .build(tauri::generate_context!())
        .expect("Lodex could not start");
    app.run(|handle, event| match event {
        tauri::RunEvent::Exit => {
            if let Some(bridge) = handle.try_state::<Bridge>() {
                bridge.stop();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(handle),
        _ => {}
    });
}
#[cfg(test)]
mod tests {
    use super::{external_url_allowed, route_allowed, telegram_token_valid};
    #[test]
    fn markdown_can_only_open_web_and_mail_links() {
        assert!(external_url_allowed("https://example.com/docs#section"));
        assert!(external_url_allowed("mailto:person@example.com"));
        for url in [
            "file:///C:/test.exe",
            "javascript:alert(1)",
            "cmd:run",
            "https://user:password@example.com",
            "https://example.com\n",
        ] {
            assert!(!external_url_allowed(url));
        }
    }
    #[test]
    fn renderer_cannot_access_secret_or_arbitrary_url() {
        assert!(route_allowed("GET", "/v1/state"));
        assert!(route_allowed("POST", "/v1/commands"));
        assert!(route_allowed("POST", "/v1/runtime/inspect"));
        assert!(route_allowed("GET", "/v1/backups"));
        assert!(route_allowed("POST", "/v1/backups/export"));
        assert!(route_allowed("POST", "/v1/mcp/completion"));
        assert!(!route_allowed("PUT", "/v1/secret"));
        assert!(!route_allowed("GET", "https://example.com"));
        assert!(!route_allowed("POST", "/v1/models?provider=openrouter"));
    }
    #[test]
    fn telegram_token_validation_does_not_accept_free_form_secrets() {
        assert!(telegram_token_valid(
            "123456789:fixture_token_with_enough_chars"
        ));
        assert!(!telegram_token_valid("short"));
        assert!(!telegram_token_valid("12345:contains whitespace value"));
    }
}
