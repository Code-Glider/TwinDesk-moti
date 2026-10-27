// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Proof of Concept (Issue #58):
// - Ultra-low RAM (~25-45 MB vs 600 MB-1.2 GB in Electron)
// - Zero Garbage Collection latency pauses
// - Native OS webview with 100% existing UI reusability

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod kvm;
mod network;
mod state;
mod tray;

use state::AppState;

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::set_kvm,
            commands::set_updates,
            commands::skip_update,
            commands::unskip_update,
            commands::check_updates,
            commands::open_update,
            commands::open_link,
            commands::pair_respond,
            commands::disconnect,
        ])
        .setup(|app| {
            if let Err(e) = tray::setup_tray(app.handle()) {
                log::warn!("Could not initialize system tray: {}", e);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TwinDesk Tauri application");
}
