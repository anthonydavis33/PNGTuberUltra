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
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

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
            set_close_to_tray
        ])
        .setup(|app| {
            // Tray failures shouldn't crash the app — log + continue.
            // Streamers without a tray-supporting OS still get the
            // full editor.
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] failed to build: {:?}", e);
            }
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
