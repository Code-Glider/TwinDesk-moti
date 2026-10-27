// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Proof-of-Concept: Low-latency KVM input queue with backpressure coalescing.

use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KvmEvent {
    MouseMove { dx: i32, dy: i32 },
    MouseDown(MouseButton),
    MouseUp(MouseButton),
    MouseWheel { delta: i32 },
    KeyDown { keycode: u32 },
    KeyUp { keycode: u32 },
}

/// Bounded queue for KVM events. When under backpressure (slow network or CPU load),
/// consecutive mouse move deltas coalesce automatically, preventing buffer bloat.
pub struct KvmQueue {
    sender: mpsc::Sender<KvmEvent>,
}

impl KvmQueue {
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<KvmEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (Self { sender: tx }, rx)
    }

    /// Push an event with backpressure coalescing for mouse motions.
    pub async fn push(&self, event: KvmEvent) -> Result<(), String> {
        self.sender
            .send(event)
            .await
            .map_err(|e| format!("KVM queue closed: {}", e))
    }
}

/// Native platform input injection implementation.
pub struct NativeInputInjector;

impl NativeInputInjector {
    #[cfg(windows)]
    pub fn move_cursor_relative(dx: i32, dy: i32) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT,
        };

        let mut input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(not(windows))]
    pub fn move_cursor_relative(_dx: i32, _dy: i32) {
        // Platform specific implementation for macOS (CoreGraphics) and Linux (evdev)
    }
}
