// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Proof-of-Concept: IPC commands matching window.macshare contract.

use crate::state::{AppState, FullState};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub fn get_state(state: State<'_, AppState>) -> FullState {
    state.snapshot()
}

#[tauri::command]
pub fn set_kvm(partial: Value, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        if let Some(locked) = partial.get("locked").and_then(|v| v.as_bool()) {
            s.input.locked = locked;
        }
        if let Some(mouse) = partial.get("mouse").and_then(|v| v.as_bool()) {
            s.input.mouse = mouse;
        }
        if let Some(keyboard) = partial.get("keyboard").and_then(|v| v.as_bool()) {
            s.input.keyboard = keyboard;
        }
        if let Some(gestures) = partial.get("gestures").and_then(|v| v.as_bool()) {
            s.input.gestures = gestures;
        }
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_clipboard(partial: Value, _state: State<'_, AppState>) -> Result<(), String> {
    if let Some(text) = partial.get("text").and_then(|v| v.as_str()) {
        let mut cb = crate::kvm::NativeClipboard::new();
        cb.set_text(text);
    }
    Ok(())
}

#[tauri::command]
pub fn set_updates(partial: Value, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        if let Some(auto) = partial.get("auto").and_then(|v| v.as_bool()) {
            s.updates.auto = auto;
        }
        if let Some(skipped) = partial.get("skipped").and_then(|v| v.as_str()) {
            s.updates.skipped_version = skipped.to_string();
            s.updates.skipped = !skipped.is_empty();
        }
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn skip_update(version: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let clean = version.trim().trim_start_matches('v').to_string();
    {
        let mut s = state.inner.write();
        s.updates.skipped_version = clean.clone();
        s.updates.skipped = true;
        s.updates.prompt_update = false;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn unskip_update(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.updates.skipped_version.clear();
        s.updates.skipped = false;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn check_updates(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.updates.checking = true;
        s.updates.error.clear();
    }
    push_state(&app, &state);

    // Mock check or GitHub releases fetch
    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;

    {
        let mut s = state.inner.write();
        s.updates.checking = false;
        s.updates.checked_at = chrono::Utc::now().timestamp_millis() as u64;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn open_update(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let url = state.inner.read().updates.release_url.clone();
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_link(key: String, app: AppHandle) -> Result<(), String> {
    let url = match key.as_str() {
        "portfolio" => "https://inukaasith.vercel.app",
        "github" => "https://github.com/InukaAsith/TwinDesk",
        "releases" => "https://github.com/InukaAsith/TwinDesk/releases",
        "licence" => "https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE",
        _ => "https://github.com/InukaAsith/TwinDesk",
    };
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pair_respond(allowed: bool, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    log::info!("Pair response: allowed = {}", allowed);
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.client = None;
        s.input.where_input = "home".to_string();
    }
    push_state(&app, &state);
    Ok(())
}

pub fn push_state(app: &AppHandle, state: &AppState) {
    let snapshot = state.snapshot();
    let _ = app.emit("state-change", &snapshot);
}
