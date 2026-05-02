// PNGTuberUltra — Tauri backend.
//
// Surface area (phase 9c):
//   - greet command: leftover scaffold, kept for now.
//   - set_global_input_enabled command: toggles global keyboard
//     listening via rdev. Spawns a listener thread on first enable;
//     subsequent toggles flip an atomic flag that gates emit. Failures
//     (e.g. macOS without Accessibility permission) come back as
//     "global-input-error" events so the JS layer can fall back to
//     local listeners and surface a hint.

use rdev::{listen, EventType, Key};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Emitter};

// Whether global input emission is currently active. Flipped by the
// JS side's set_global_input_enabled command. The listener thread
// reads this on every event to decide whether to emit.
static GLOBAL_INPUT_ENABLED: AtomicBool = AtomicBool::new(false);

// Whether the OS-level listener thread has been spawned. We only spawn
// it once per process — rdev::listen blocks forever (no clean shutdown
// API), so we accept the leak and gate emit via GLOBAL_INPUT_ENABLED
// instead.
static LISTENER_SPAWNED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct GlobalKeyPayload {
    key: String,
    pressed: bool,
}

#[derive(Clone, serde::Serialize)]
struct GlobalInputErrorPayload {
    message: String,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
                    // Mouse events deliberately ignored for 9c —
                    // global mouse adds canvas-relative coord
                    // questions (the position the rig sees vs the
                    // position the OS cursor is at) that deserve their
                    // own design pass.
                    _ => {}
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![greet, set_global_input_enabled])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
