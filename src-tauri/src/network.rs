// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust: Phase 2 Async Networking & Mesh Engine
// Replaces Node.js WebSocket with native async Tokio + Tungstenite (zero-GC latency, bounded backpressure).

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

pub const DEFAULT_PORT: u16 = 52420;
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(3000);
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(12000);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum MeshPacket {
    #[serde(rename = "hello")]
    Hello {
        id: String,
        name: String,
        os: String,
        version: String,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "input")]
    Input(serde_json::Value),
    #[serde(rename = "clip")]
    Clipboard { text: String },
    #[serde(rename = "disconnect")]
    Disconnect,
}

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

/// Mesh networking server listening for incoming peer connections.
pub struct MeshServer {
    port: u16,
}

impl MeshServer {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    pub async fn run(
        &self,
        incoming_tx: mpsc::Sender<(SocketAddr, MeshPacket)>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(&addr).await?;
        log::info!("[MeshServer] Listening on {}", addr);

        while let Ok((stream, peer_addr)) = listener.accept().await {
            let tx = incoming_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = Self::handle_connection(stream, peer_addr, tx).await {
                    log::warn!("[MeshServer] Peer {} disconnected: {}", peer_addr, e);
                }
            });
        }

        Ok(())
    }

    async fn handle_connection(
        stream: TcpStream,
        peer_addr: SocketAddr,
        tx: mpsc::Sender<(SocketAddr, MeshPacket)>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut ws_stream = accept_async(stream).await?;
        let mut tracker = HeartbeatTracker::new();

        while let Some(msg_result) = ws_stream.next().await {
            let msg = msg_result?;
            tracker.record_ping();

            match msg {
                Message::Text(text) => {
                    if let Ok(packet) = serde_json::from_str::<MeshPacket>(&text) {
                        let _ = tx.send((peer_addr, packet)).await;
                    }
                }
                Message::Binary(bin) => {
                    if let Ok(packet) = serde_json::from_slice::<MeshPacket>(&bin) {
                        let _ = tx.send((peer_addr, packet)).await;
                    }
                }
                Message::Ping(payload) => {
                    ws_stream.send(Message::Pong(payload)).await?;
                }
                Message::Close(_) => break,
                _ => {}
            }

            if tracker.is_stale() {
                log::warn!("[MeshServer] Peer {} timed out (heartbeat > 12s)", peer_addr);
                break;
            }
        }

        Ok(())
    }
}

/// Mesh networking client connecting to a remote peer.
pub struct MeshClient;

impl MeshClient {
    pub async fn connect(
        url: &str,
        outgoing_rx: &mut mpsc::Receiver<MeshPacket>,
        incoming_tx: mpsc::Sender<MeshPacket>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        let mut tracker = HeartbeatTracker::new();

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if tracker.is_stale() {
                        return Err("Heartbeat timeout (12s without reply)".into());
                    }
                    let ping = serde_json::to_string(&MeshPacket::Ping)?;
                    write.send(Message::Text(ping)).await?;
                }

                Some(packet) = outgoing_rx.recv() => {
                    let json = serde_json::to_string(&packet)?;
                    write.send(Message::Text(json)).await?;
                }

                Some(msg_res) = read.next() => {
                    let msg = msg_res?;
                    tracker.record_ping();
                    match msg {
                        Message::Text(text) => {
                            if let Ok(pkt) = serde_json::from_str::<MeshPacket>(&text) {
                                let _ = incoming_tx.send(pkt).await;
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }
}
