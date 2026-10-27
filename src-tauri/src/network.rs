// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Proof-of-Concept: Async networking engine without V8 Garbage Collection stalls.

use std::time::Duration;
use tokio::time::Instant;

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(3000);
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(12000);

pub struct HeartbeatTracker {
    last_received: Instant,
}

impl HeartbeatTracker {
    pub fn new() -> Self {
        Self {
            last_received: Instant::now(),
        }
    }

    pub fn record_ping(&mut self) {
        self.last_received = Instant::now();
    }

    pub fn is_stale(&self) -> bool {
        self.last_received.elapsed() > HEARTBEAT_TIMEOUT
    }
}
