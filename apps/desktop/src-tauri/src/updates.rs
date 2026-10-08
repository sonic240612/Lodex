use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct AppUpdates(Mutex<UpdateState>);
#[derive(Default)]
struct UpdateState {
    busy: bool,
    preview: Option<(String, Instant, Update)>,
}

fn configured(app: &tauri::AppHandle) -> bool {
    let Some(config) = app.config().plugins.0.get("updater") else {
        return false;
    };
    config
        .get("pubkey")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
        && config
            .get("endpoints")
            .and_then(Value::as_array)
            .is_some_and(|urls| !urls.is_empty())
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppUpdates>,
) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    if !configured(&app) {
        return Ok(json!({"configured": false, "currentVersion": current, "available": false}));
    }
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "업데이트 상태를 읽을 수 없습니다.")?;
        if guard.busy {
            return Err("업데이트 작업이 진행 중입니다.".into());
        }
        guard.busy = true;
        guard.preview = None;
    }
    let handle = app.clone();
    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(120))
            .on_before_exit(move || {
                if let Some(bridge) = handle.try_state::<crate::Bridge>() {
                    bridge.stop();
                }
            })
            .build()
            .map_err(|_| "업데이트 설정을 확인할 수 없습니다.")?;
        tokio::time::timeout(Duration::from_secs(30), updater.check())
            .await
            .map_err(|_| "업데이트 조회 시간이 초과되었습니다.")?
            .map_err(|_| "업데이트를 조회하지 못했습니다. 네트워크와 공개된 릴리스를 확인하세요.")
    }
    .await;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "업데이트 상태를 저장할 수 없습니다.")?;
    guard.busy = false;
    let Some(update) = result? else {
        return Ok(json!({"configured": true, "currentVersion": current, "available": false}));
    };
    let token = uuid::Uuid::new_v4().to_string();
    let value = json!({"configured": true, "currentVersion": current, "available": true,
        "token": token, "version": update.version, "notes": update.body});
    guard.preview = Some((token, Instant::now(), update));
    Ok(value)
}

async fn prepare_install(app: &tauri::AppHandle) -> Result<Value, String> {
    let bridge = app.state::<crate::Bridge>();
    let (port, token) = bridge.connection()?;
    let response = bridge
        .client
        .post(format!("http://127.0.0.1:{port}/v1/updates/prepare"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| "업데이트 전 백업을 만들지 못했습니다.")?;
    let ok = response.status().is_success();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "업데이트 준비 결과를 읽지 못했습니다.")?;
    if !ok {
        return Err(value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("대화와 백그라운드 명령을 중지한 뒤 다시 설치하세요.")
            .to_string());
    }
    if value.get("token").and_then(Value::as_str).is_none() {
        return Err("업데이트 준비 상태가 올바르지 않습니다.".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn install_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppUpdates>,
    token: String,
    progress: Channel<Value>,
) -> Result<(), String> {
    let update = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "업데이트 상태를 읽을 수 없습니다.")?;
        if guard.busy {
            return Err("업데이트 작업이 진행 중입니다.".into());
        }
        let (id, checked_at, update) = guard
            .preview
            .as_ref()
            .ok_or("업데이트를 먼저 확인하세요.")?;
        if id != &token || checked_at.elapsed() > Duration::from_secs(900) {
            return Err("업데이트 목록을 다시 확인하세요.".into());
        }
        let update = update.clone();
        guard.busy = true;
        update
    };
    let result = async {
        let mut downloaded = 0_u64;
        let _ = progress.send(json!({"phase": "downloading", "downloaded": 0}));
        // The plugin verifies the bundled public-key signature before returning bytes.
        // A failed download or signature check never stops the daemon or installs files.
        let bytes = update.download(|length, total| {
            downloaded += length as u64;
            let _ = progress.send(json!({"phase": "downloading", "downloaded": downloaded, "total": total}));
        }, || {}).await.map_err(|_| "다운로드 또는 서명 검증에 실패했습니다. 앱은 변경되지 않았습니다.")?;
        let _ = progress.send(json!({"phase": "preparing"}));
        let prepared = prepare_install(&app).await?;
        let _ = progress.send(json!({"phase": "installing", "backup": prepared.get("backup")}));
        if update.install(bytes).is_err() {
            let bridge = app.state::<crate::Bridge>();
            if let Ok((port, auth)) = bridge.connection() {
                let _ = bridge.client.post(format!("http://127.0.0.1:{port}/v1/updates/release"))
                    .bearer_auth(auth).json(&json!({"token": prepared["token"]})).send().await;
            }
            return Err("업데이트 설치에 실패했습니다. 백업은 보존했습니다. 릴리스 페이지에서 설치 파일을 확인하세요.".to_string());
        }
        app.state::<crate::Bridge>().stop();
        app.restart();
    }.await;
    if let Ok(mut guard) = state.0.lock() {
        guard.busy = false;
    }
    result
}

#[tauri::command]
pub fn open_app_releases(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(
            "https://github.com/sonic240612/Lodex/releases",
            None::<&str>,
        )
        .map_err(|_| "릴리스 페이지를 열 수 없습니다.".into())
}
