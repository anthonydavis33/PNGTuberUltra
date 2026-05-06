// PNGTuberUltra — Tauri backend.
//
// Surface area:
//   - greet command: leftover scaffold, kept for now.
//   - set_global_input_enabled command: toggles global keyboard
//     listening via rdev. Spawns a listener thread on first enable;
//     subsequent toggles flip an atomic flag that gates emit. Failures
//     (e.g. macOS without Accessibility permission) come back as
//     "global-input-error" events so the JS layer can fall back to
//     local listeners and surface a hint.
//   - System tray (build_tray): show window / toggle pause / quit.
//
// Privacy contract (audited at 9d):
//   - rdev events are translated to key IDENTITY strings only via
//     key_to_string ("a", "Space", "ArrowUp"). The Key enum's debug
//     formatting is the fallback for unmapped variants — also pure
//     identity ("F23", "KpEnter"), never typed content.
//   - eprintln! sites log errors only, never key/mouse content.
//   - No file or network IO of input data anywhere in this module.
//   - emit() pushes the identity payload to JS where the bus carries
//     it; no Tauri-side persistence.

use rdev::{listen, Button, EventType, Key};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU16, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

// Whether global input emission is currently active. Flipped by the
// JS side's set_global_input_enabled command. The listener thread
// reads this on every event to decide whether to emit.
static GLOBAL_INPUT_ENABLED: AtomicBool = AtomicBool::new(false);

// Whether the OS-level listener thread has been spawned. We only spawn
// it once per process — rdev::listen blocks forever (no clean shutdown
// API), so we accept the leak and gate emit via GLOBAL_INPUT_ENABLED
// instead.
static LISTENER_SPAWNED: AtomicBool = AtomicBool::new(false);

// Whether the window's close button should hide-to-tray instead of
// quitting. Set from the JS side via set_close_to_tray; read by the
// window's CloseRequested event handler in the setup callback.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

// Most recent timestamp (ms since unix epoch) the JS side reported a
// Pixi tick. Set by the heartbeat command, read by the /heartbeat HTTP
// endpoint. The OBS browser source page uses this to display
// "Connected — main app live" vs "Waiting for main app…" based on
// freshness. AtomicI64 because we need lock-free read across the
// HTTP server thread.
static LAST_TICK_MS: AtomicI64 = AtomicI64::new(0);

/// Port the OBS browser source HTTP server binds to. Hard-coded for
/// 9h scaffolding — making it configurable is a follow-up if users
/// need it (port conflicts are rare on this range, and OBS just needs
/// a URL the user can copy).
const STREAM_PORT: u16 = 47882;

/// Port for the OAuth callback listener. Spawned on-demand by the
/// frontend when a user initiates an OAuth flow (Twitch / YouTube).
/// Same port for both flows — they're never live concurrently. Picked
/// from the dynamic port range and unlikely to collide.
const OAUTH_CALLBACK_PORT: u16 = 47883;

/// Active OAuth listener port — set when start_oauth_callback_listener
/// runs, so a duplicate call returns early instead of trying to bind
/// twice. 0 means no listener active.
static OAUTH_LISTENER_PORT: AtomicU16 = AtomicU16::new(0);

/// Whether to cancel the active OAuth listener early (e.g. user
/// closed the connect dialog before completing the flow).
static OAUTH_LISTENER_CANCEL: AtomicBool = AtomicBool::new(false);

/// Storage for the most recent webhook event payload, keyed by event
/// type. The frontend's WebhookSource subscribes via Tauri events;
/// this Mutex<HashMap> is just a debug introspection point. Not
/// load-bearing — the event channel is the primary delivery path.
static LAST_WEBHOOK_EVENT: Mutex<Option<(String, String)>> =
    Mutex::new(None);

// stream/index.html embedded at compile time. Served by the
// tiny_http server below.
const STREAM_HTML: &str = include_str!("../stream/index.html");

#[derive(Clone, serde::Serialize)]
struct GlobalKeyPayload {
    key: String,
    pressed: bool,
}

/// Discriminated payload for all mouse events. Kind is "move", "down",
/// "up", or "wheel"; the relevant other fields are populated per kind.
/// Single payload type keeps the JS handler one switch instead of N
/// separate listeners.
#[derive(Clone, serde::Serialize)]
struct GlobalMousePayload {
    kind: String,
    button: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    #[serde(rename = "deltaY")]
    delta_y: Option<f64>,
}

#[derive(Clone, serde::Serialize)]
struct GlobalInputErrorPayload {
    message: String,
}

/// Payload emitted to the frontend when an OAuth callback redirect
/// arrives at our listener. `flow_id` is whatever the JS layer passed
/// when starting the flow (e.g. "twitch", "youtube") — lets a single
/// event channel multiplex multiple OAuth providers without confusion.
#[derive(Clone, serde::Serialize)]
struct OAuthCallbackPayload {
    #[serde(rename = "flowId")]
    flow_id: String,
    /// Auth code from the redirect's `?code=...`. Present on success.
    code: Option<String>,
    /// Anti-CSRF state parameter the frontend supplied — JS verifies
    /// it matches the value sent in the auth URL.
    state: Option<String>,
    /// OAuth `?error=...` parameter when the provider rejects the
    /// flow (user denied, scope problem, etc.).
    error: Option<String>,
    /// Human-readable error description from the provider.
    #[serde(rename = "errorDescription")]
    error_description: Option<String>,
}

/// Payload emitted when the generic /webhook endpoint receives a POST.
/// The frontend WebhookSource subscribes to this and decodes the
/// JSON body into bus channels. Decoupled from any specific provider:
/// TikTok bridges, Streamer.bot, custom Python scripts — anything that
/// can POST JSON works.
#[derive(Clone, serde::Serialize)]
struct WebhookEventPayload {
    /// Source identifier from `X-Source` header or body's `source` field.
    /// Examples: "tiktok", "streamerbot", "custom".
    source: String,
    /// Event type from `X-Event` header or body's `event` field.
    /// Examples: "chat", "gift", "follow".
    event: String,
    /// Raw JSON body as a string — frontend parses for richer fields.
    /// Kept opaque on the Rust side to avoid coupling to any provider's
    /// schema.
    body: String,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Toggle close-to-tray behavior for the main window. When enabled,
/// the window's CloseRequested event hides the window instead of
/// dropping it; the user can reshow via the tray "Show window" menu
/// item. JS side calls this whenever the user flips the setting in
/// the Settings popover.
#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

/// Record a Pixi tick heartbeat. The OBS browser source page polls
/// /heartbeat to detect whether the main app is alive and ticking;
/// freshness of this timestamp drives the page's "live" / "waiting"
/// indicator. JS calls this periodically (not every tick — once per
/// second is enough for liveness).
#[tauri::command]
fn record_tick_heartbeat() {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    LAST_TICK_MS.store(now_ms, Ordering::SeqCst);
}

/// Spawn the OBS browser source HTTP server. Binds 127.0.0.1:STREAM_PORT
/// and serves several routes:
///   GET  /               → stream.html (embedded)
///   GET  /heartbeat      → JSON { lastTickMs: number } so the page can
///                          show connection status
///   POST /webhook/event  → external event ingress. Body: JSON.
///                          Headers: X-Source (provider name), X-Event
///                          (event type). Falls back to body's
///                          `source` / `event` fields if headers are
///                          absent. Emits a `webhook-event` Tauri
///                          event the frontend's WebhookSource picks
///                          up. Used by external bridges (TikTok Live
///                          Connector, Streamer.bot, custom scripts).
///   anything else        → 404
///
/// Server runs in a dedicated thread for the lifetime of the process.
/// On bind failure (port taken, etc.) we log and continue — the
/// editor still works without the OBS source.
fn spawn_stream_server(app: AppHandle) {
    thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", STREAM_PORT);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "[stream-server] failed to bind {}: {:?}. OBS browser \
                     source URL will not be available this session.",
                    addr, e
                );
                return;
            }
        };
        eprintln!("[stream-server] listening on http://{}", addr);

        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            // POST /webhook/event — external event ingress for TikTok
            // bridges, Streamer.bot, custom scripts. Read the body
            // first (otherwise we can't move past the request),
            // pull headers, then emit + respond.
            if matches!(method, Method::Post) && url.starts_with("/webhook/event")
            {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let mut source: Option<String> = None;
                let mut event: Option<String> = None;
                for h in request.headers() {
                    let name = h.field.as_str().as_str().to_lowercase();
                    if name == "x-source" {
                        source = Some(h.value.as_str().to_string());
                    } else if name == "x-event" {
                        event = Some(h.value.as_str().to_string());
                    }
                }
                // Header-less payloads can carry source/event in the
                // body — try a best-effort parse for top-level keys
                // without bringing in a JSON dep on the Rust side.
                if source.is_none() {
                    source = extract_top_string(&body, "source");
                }
                if event.is_none() {
                    event = extract_top_string(&body, "event");
                }

                let payload = WebhookEventPayload {
                    source: source.unwrap_or_else(|| "unknown".to_string()),
                    event: event.unwrap_or_else(|| "event".to_string()),
                    body: body.clone(),
                };
                if let Ok(mut last) = LAST_WEBHOOK_EVENT.lock() {
                    *last = Some((payload.event.clone(), body));
                }
                let _ = app.emit("webhook-event", payload);

                let json_header = Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"application/json"[..],
                )
                .expect("static header parse");
                let _ = request.respond(
                    Response::from_string("{\"ok\":true}").with_header(json_header),
                );
                continue;
            }

            // Everything else is GET-only.
            if !matches!(method, Method::Get) {
                let _ = request.respond(
                    Response::from_string("Method not allowed").with_status_code(405),
                );
                continue;
            }

            let response = if url == "/" || url == "/index.html" {
                let html_header = Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"text/html; charset=utf-8"[..],
                )
                .expect("static header parse");
                Response::from_string(STREAM_HTML).with_header(html_header)
            } else if url == "/heartbeat" {
                let last = LAST_TICK_MS.load(Ordering::SeqCst);
                let body = format!("{{\"lastTickMs\":{}}}", last);
                let json_header = Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"application/json"[..],
                )
                .expect("static header parse");
                let cache_header = Header::from_bytes(
                    &b"Cache-Control"[..],
                    &b"no-store"[..],
                )
                .expect("static header parse");
                Response::from_string(body)
                    .with_header(json_header)
                    .with_header(cache_header)
            } else {
                Response::from_string("Not found").with_status_code(404)
            };
            let _ = request.respond(response);
        }
    });
}

/// Extract a top-level string field from a JSON body without bringing
/// in a JSON dependency on the Rust side. Naive: looks for
/// `"key"\s*:\s*"value"` and returns value with simple unescaping.
/// Sufficient for the webhook header-fallback use case (we only need
/// `source` and `event` strings); frontend does the real JSON parsing.
fn extract_top_string(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let start = json.find(&needle)?;
    let after_key = &json[start + needle.len()..];
    // Skip whitespace + ':' + whitespace, then expect '"'.
    let mut chars = after_key.char_indices();
    let mut found_colon = false;
    let mut value_start: Option<usize> = None;
    while let Some((i, c)) = chars.next() {
        if !found_colon {
            if c == ':' {
                found_colon = true;
            } else if !c.is_whitespace() {
                return None;
            }
        } else {
            if c == '"' {
                value_start = Some(i + 1);
                break;
            } else if !c.is_whitespace() {
                return None;
            }
        }
    }
    let value_start = value_start?;
    // Walk forward to closing quote, respecting backslash-escaped quotes.
    let bytes = after_key.as_bytes();
    let mut i = value_start;
    let mut out = String::new();
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            return Some(out);
        }
        if b == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            match next {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'n' => out.push('\n'),
                b't' => out.push('\t'),
                b'/' => out.push('/'),
                _ => out.push(next as char),
            }
            i += 2;
        } else {
            out.push(b as char);
            i += 1;
        }
    }
    None
}

/// Spawn a one-shot HTTP listener on OAUTH_CALLBACK_PORT to capture
/// an OAuth provider's redirect. The frontend builds the auth URL with
/// `redirect_uri=http://localhost:OAUTH_CALLBACK_PORT/oauth/callback`,
/// opens it in the system browser, then calls this command to wait
/// for the redirect. We block in a background thread (so this command
/// returns immediately) and emit `oauth-callback` when the request
/// arrives.
///
/// Why a separate listener and not a /oauth route on the existing
/// stream server? Two reasons: (1) OAuth listeners want a short
/// lifetime — they should shut down after the single expected
/// redirect, both for cleanliness and so subsequent flows can reuse
/// the port without race conditions, and (2) the stream server runs
/// for the process lifetime and would have to maintain pending-flow
/// state to multiplex callbacks; a one-shot dedicated listener is
/// simpler.
///
/// Lifecycle:
///   1. Frontend calls this command before opening the browser.
///   2. Server binds, accepts one request, parses the query string.
///   3. Sends a "you can close this tab" success page back to the
///      browser.
///   4. Emits `oauth-callback` with the parsed code/state/error.
///   5. Server thread exits.
///
/// If the user closes the browser without completing the flow, the
/// frontend should call cancel_oauth_callback_listener — the listener
/// thread polls a cancel flag and exits within ~500ms.
#[tauri::command]
fn start_oauth_callback_listener(
    app: AppHandle,
    flow_id: String,
) -> Result<u16, String> {
    // If a listener is already active for a previous flow, refuse —
    // the user needs to either complete or cancel that one first.
    if OAUTH_LISTENER_PORT.load(Ordering::SeqCst) != 0 {
        return Err("oauth listener already active".into());
    }
    OAUTH_LISTENER_CANCEL.store(false, Ordering::SeqCst);
    OAUTH_LISTENER_PORT.store(OAUTH_CALLBACK_PORT, Ordering::SeqCst);

    let app_handle = app.clone();
    thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", OAUTH_CALLBACK_PORT);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[oauth] failed to bind {}: {:?}", addr, e);
                OAUTH_LISTENER_PORT.store(0, Ordering::SeqCst);
                let _ = app_handle.emit(
                    "oauth-callback",
                    OAuthCallbackPayload {
                        flow_id: flow_id.clone(),
                        code: None,
                        state: None,
                        error: Some("listener_bind_failed".into()),
                        error_description: Some(format!("{:?}", e)),
                    },
                );
                return;
            }
        };

        // Poll with 200ms timeout so we can check the cancel flag and
        // exit cleanly if the user backed out of the flow.
        loop {
            if OAUTH_LISTENER_CANCEL.load(Ordering::SeqCst) {
                break;
            }
            match server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => {
                    let url = request.url().to_string();
                    let mut code: Option<String> = None;
                    let mut state: Option<String> = None;
                    let mut err: Option<String> = None;
                    let mut err_desc: Option<String> = None;
                    if let Some(qs_idx) = url.find('?') {
                        let qs = &url[qs_idx + 1..];
                        for pair in qs.split('&') {
                            let mut parts = pair.splitn(2, '=');
                            let k = parts.next().unwrap_or("");
                            let v = parts.next().unwrap_or("");
                            let v = url_decode(v);
                            match k {
                                "code" => code = Some(v),
                                "state" => state = Some(v),
                                "error" => err = Some(v),
                                "error_description" => err_desc = Some(v),
                                _ => {}
                            }
                        }
                    }

                    // Send a closeable success page back to the
                    // browser — minimal HTML, no external assets,
                    // styled enough to look intentional. Auto-closes
                    // the tab after 1s on success.
                    let body = if err.is_some() {
                        format!(
                            "<!doctype html><html><body style=\"font-family:system-ui;background:#1a1a1a;color:#eee;padding:40px;text-align:center;\">\
                            <h2 style=\"color:#ff5544\">Authorization failed</h2>\
                            <p>{}</p>\
                            <p style=\"color:#888;font-size:14px\">You can close this tab and return to PNGTuberUltra.</p>\
                            </body></html>",
                            html_escape(err_desc.as_deref().unwrap_or("Unknown error"))
                        )
                    } else {
                        "<!doctype html><html><body style=\"font-family:system-ui;background:#1a1a1a;color:#eee;padding:40px;text-align:center;\">\
                        <h2 style=\"color:#62d76b\">Connected</h2>\
                        <p>You can close this tab and return to PNGTuberUltra.</p>\
                        <script>setTimeout(()=>window.close(),1500)</script>\
                        </body></html>".to_string()
                    };
                    let html_header = Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"text/html; charset=utf-8"[..],
                    )
                    .expect("static header parse");
                    let _ = request.respond(
                        Response::from_string(body).with_header(html_header),
                    );

                    let _ = app_handle.emit(
                        "oauth-callback",
                        OAuthCallbackPayload {
                            flow_id: flow_id.clone(),
                            code,
                            state,
                            error: err,
                            error_description: err_desc,
                        },
                    );
                    break;
                }
                Ok(None) => {
                    // Timeout — loop again to check cancel flag.
                    continue;
                }
                Err(_e) => break,
            }
        }
        OAUTH_LISTENER_PORT.store(0, Ordering::SeqCst);
    });
    Ok(OAUTH_CALLBACK_PORT)
}

/// Cancel an in-flight OAuth listener. Safe to call even if no
/// listener is active (no-op). Used when the user closes the connect
/// dialog before completing the browser flow.
#[tauri::command]
fn cancel_oauth_callback_listener() {
    OAUTH_LISTENER_CANCEL.store(true, Ordering::SeqCst);
}

/// Minimal URL percent-decoding — handles %XX escapes and `+` → space
/// (the standard form-encoded variant used by OAuth providers).
/// Sufficient for OAuth query strings; not a general-purpose decoder.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                let v = u8::from_str_radix(hex, 16).unwrap_or(0);
                out.push(v);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Minimal HTML escaping for the OAuth success/error page. We only
/// inject error_description into HTML; everything else is static.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Toggle global keyboard listening on/off.
///
/// First call with `enabled = true` spawns the listener thread.
/// Subsequent calls flip the atomic flag without re-spawning.
/// Disabling stops emit but the thread keeps running (rdev's listen has
/// no shutdown signal — re-enable is fast since the thread is already
/// up). Returns an error string if rdev::listen itself fails (e.g.
/// macOS Accessibility denied) — the JS side uses that to fall back
/// to local listeners and notify the user.
#[tauri::command]
fn set_global_input_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    GLOBAL_INPUT_ENABLED.store(enabled, Ordering::SeqCst);

    if enabled && !LISTENER_SPAWNED.swap(true, Ordering::SeqCst) {
        let app_handle = app.clone();
        thread::spawn(move || {
            // The listen closure is FnMut + 'static and takes ownership
            // of any captured values. We clone app_handle into a
            // separate binding for the closure so the outer thread
            // still owns the original handle for emitting errors after
            // listen returns Err. listen blocks forever on success;
            // the closure reads GLOBAL_INPUT_ENABLED on every event
            // and returns early if disabled, so toggling off is fast
            // and lossless.
            let listen_handle = app_handle.clone();
            let result = listen(move |event| {
                if !GLOBAL_INPUT_ENABLED.load(Ordering::SeqCst) {
                    return;
                }
                match event.event_type {
                    EventType::KeyPress(key) => {
                        let _ = listen_handle.emit(
                            "global-key",
                            GlobalKeyPayload {
                                key: key_to_string(&key),
                                pressed: true,
                            },
                        );
                    }
                    EventType::KeyRelease(key) => {
                        let _ = listen_handle.emit(
                            "global-key",
                            GlobalKeyPayload {
                                key: key_to_string(&key),
                                pressed: false,
                            },
                        );
                    }
                    EventType::MouseMove { x, y } => {
                        let _ = listen_handle.emit(
                            "global-mouse",
                            GlobalMousePayload {
                                kind: "move".to_string(),
                                button: None,
                                x: Some(x),
                                y: Some(y),
                                delta_y: None,
                            },
                        );
                    }
                    EventType::ButtonPress(button) => {
                        let _ = listen_handle.emit(
                            "global-mouse",
                            GlobalMousePayload {
                                kind: "down".to_string(),
                                button: Some(button_to_string(&button)),
                                x: None,
                                y: None,
                                delta_y: None,
                            },
                        );
                    }
                    EventType::ButtonRelease(button) => {
                        let _ = listen_handle.emit(
                            "global-mouse",
                            GlobalMousePayload {
                                kind: "up".to_string(),
                                button: Some(button_to_string(&button)),
                                x: None,
                                y: None,
                                delta_y: None,
                            },
                        );
                    }
                    EventType::Wheel { delta_y, .. } => {
                        // delta_y from rdev is signed (negative = up,
                        // positive = down), already matches DOM
                        // WheelEvent.deltaY convention. We ignore
                        // delta_x for now — horizontal wheel is rare
                        // and adds a channel few rigs would use.
                        let _ = listen_handle.emit(
                            "global-mouse",
                            GlobalMousePayload {
                                kind: "wheel".to_string(),
                                button: None,
                                x: None,
                                y: None,
                                delta_y: Some(delta_y as f64),
                            },
                        );
                    }
                }
            });
            if let Err(e) = result {
                eprintln!("[global-input] rdev listen failed: {:?}", e);
                // Reset flags so the next enable attempt re-spawns,
                // giving the user a chance to grant permissions and
                // retry without restarting the app.
                LISTENER_SPAWNED.store(false, Ordering::SeqCst);
                GLOBAL_INPUT_ENABLED.store(false, Ordering::SeqCst);
                let _ = app_handle.emit(
                    "global-input-error",
                    GlobalInputErrorPayload {
                        message: format!("{:?}", e),
                    },
                );
            }
        });
    }

    Ok(())
}

/// Translate rdev's Button enum to "left" / "right" / "middle" /
/// debug-format. Matches the channel-name convention in MouseSource.ts
/// (which publishes MouseLeft / MouseRight / MouseMiddle); the JS
/// global mouse bridge maps this string back to the channel.
fn button_to_string(button: &Button) -> String {
    match button {
        Button::Left => "left".to_string(),
        Button::Right => "right".to_string(),
        Button::Middle => "middle".to_string(),
        // Side buttons / unknown — debug formatting so the user can
        // at least see what fired and decide whether to bind to it.
        // Won't match any of our canonical channels.
        _ => format!("{:?}", button).to_lowercase(),
    }
}

/// Translate rdev's Key enum to a string compatible with the
/// frontend's `normalizeKey()` convention in KeyboardSource.ts:
///   - Single chars lowercased ("a", not "A")
///   - Spacebar => "Space"
///   - Named keys => their KeyboardEvent.key form ("Enter",
///     "ArrowUp", "Shift", etc.)
/// Unknown variants fall through to Debug formatting so users at least
/// see what fired and can bind something to it.
fn key_to_string(key: &Key) -> String {
    use rdev::Key::*;
    let s: &str = match key {
        // Letters
        KeyA => "a",
        KeyB => "b",
        KeyC => "c",
        KeyD => "d",
        KeyE => "e",
        KeyF => "f",
        KeyG => "g",
        KeyH => "h",
        KeyI => "i",
        KeyJ => "j",
        KeyK => "k",
        KeyL => "l",
        KeyM => "m",
        KeyN => "n",
        KeyO => "o",
        KeyP => "p",
        KeyQ => "q",
        KeyR => "r",
        KeyS => "s",
        KeyT => "t",
        KeyU => "u",
        KeyV => "v",
        KeyW => "w",
        KeyX => "x",
        KeyY => "y",
        KeyZ => "z",
        // Number row
        Num0 => "0",
        Num1 => "1",
        Num2 => "2",
        Num3 => "3",
        Num4 => "4",
        Num5 => "5",
        Num6 => "6",
        Num7 => "7",
        Num8 => "8",
        Num9 => "9",
        // Named keys — match KeyboardEvent.key conventions
        Space => "Space",
        Return => "Enter",
        Tab => "Tab",
        Escape => "Escape",
        Backspace => "Backspace",
        Delete => "Delete",
        Home => "Home",
        End => "End",
        PageUp => "PageUp",
        PageDown => "PageDown",
        Insert => "Insert",
        UpArrow => "ArrowUp",
        DownArrow => "ArrowDown",
        LeftArrow => "ArrowLeft",
        RightArrow => "ArrowRight",
        // Modifiers — collapse left/right variants since
        // KeyboardEvent.key doesn't distinguish them either.
        ShiftLeft | ShiftRight => "Shift",
        ControlLeft | ControlRight => "Control",
        Alt | AltGr => "Alt",
        MetaLeft | MetaRight => "Meta",
        // F-keys
        F1 => "F1",
        F2 => "F2",
        F3 => "F3",
        F4 => "F4",
        F5 => "F5",
        F6 => "F6",
        F7 => "F7",
        F8 => "F8",
        F9 => "F9",
        F10 => "F10",
        F11 => "F11",
        F12 => "F12",
        // Punctuation
        Comma => ",",
        Dot => ".",
        Slash => "/",
        SemiColon => ";",
        Quote => "'",
        BackQuote => "`",
        BackSlash => "\\",
        LeftBracket => "[",
        RightBracket => "]",
        Equal => "=",
        Minus => "-",
        // Anything not explicitly mapped — debug formatting so users
        // can at least see the key name and bind to it. Will look
        // like "Function" or "KpReturn" etc.
        _ => return format!("{:?}", key),
    };
    s.to_string()
}

/// Build a system tray icon with quick-action menu items. Phase 9d.
///
/// Items:
///   - "Show window"    — unminimize + focus the main window. Useful
///                        when the user has minimized the app while
///                        streaming and wants to bring it back.
///   - "Toggle pause"   — emits a tray-toggle-pause event the JS side
///                        listens for; JS flips the inputPaused
///                        setting. We intentionally keep the menu
///                        text static (not "Pause" / "Resume" based
///                        on state) because Tauri 2 menu-item label
///                        updates require explicit relabel calls,
///                        and the JS side knows the current state.
///   - "Quit"           — exits the app.
///
/// The tray icon is always-on while the app runs; users can hide it
/// in the OS tray-settings if they don't want it visible. We don't
/// hijack the window close button to minimize-to-tray — that's a
/// separate UX choice that deserves its own toggle.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray-show", "Show window", true, None::<&str>)?;
    let pause_item =
        MenuItem::with_id(app, "tray-toggle-pause", "Toggle pause input", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &pause_item, &separator, &quit_item])?;

    let _tray = TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?
                .clone(),
        )
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "tray-toggle-pause" => {
                // Defer the actual toggle to JS so the user-facing
                // setting (useSettings.inputPaused) stays the source
                // of truth. JS subscribes to this event and flips
                // the setter.
                let _ = app.emit("tray-toggle-pause", ());
            }
            "tray-quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            set_global_input_enabled,
            set_close_to_tray,
            record_tick_heartbeat,
            start_oauth_callback_listener,
            cancel_oauth_callback_listener
        ])
        .setup(|app| {
            // Tray failures shouldn't crash the app — log + continue.
            // Streamers without a tray-supporting OS still get the
            // full editor.
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] failed to build: {:?}", e);
            }
            // Stream server — OBS browser source URL endpoint AND
            // generic /webhook/event ingress for external bridges.
            // Bind failures are non-fatal (port conflict, sandboxed
            // environment, etc.); the editor works without it.
            spawn_stream_server(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray hijack. When the setting is on AND the
            // user clicks X (or hits Cmd+W on macOS), prevent the
            // close and hide the window. The tray menu's "Show
            // window" + "Quit" items remain the path back / out.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
