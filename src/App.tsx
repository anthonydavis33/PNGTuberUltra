import { useEffect } from "react";
import { LogOut } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Toolbar } from "./panels/Toolbar";
import { LayerTree } from "./panels/LayerTree";
import { Properties } from "./panels/Properties";
import { StatusBar } from "./panels/StatusBar";
import { PixiCanvas } from "./canvas/PixiCanvas";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAvatar } from "./store/useAvatar";
import { useSettings } from "./store/useSettings";
import {
  promptUnsavedChanges,
  saveAvatarToCurrentPath,
} from "./io/fileOps";
import "./App.css";

export default function App() {
  useKeyboardShortcuts();

  const streamMode = useSettings((s) => s.streamMode);
  const setStreamMode = useSettings((s) => s.setStreamMode);
  const closeToTray = useSettings((s) => s.closeToTray);
  const transparentWindow = useSettings((s) => s.transparentWindow);

  // Push close-to-tray setting through to Rust whenever it changes.
  // Rust holds an atomic flag the window's CloseRequested handler
  // reads — JS is the source of truth, Rust mirrors. invoke is
  // best-effort: if the command doesn't exist (unlikely) we just log.
  useEffect(() => {
    invoke("set_close_to_tray", { enabled: closeToTray }).catch((err) => {
      console.error("[close-to-tray] sync to Rust failed:", err);
    });
  }, [closeToTray]);

  // Propagate transparent-bg state to <html> + <body> so the global
  // background CSS rule (set in App.css for the root elements)
  // doesn't fight the per-component transparent class. Toggling on
  // adds a class that overrides the bg to transparent; toggling off
  // removes it and the default bg returns. The .app.transparent-bg
  // rule handles the middle layers.
  useEffect(() => {
    const transparent = streamMode && transparentWindow;
    document.documentElement.classList.toggle("transparent-bg", transparent);
    document.body.classList.toggle("transparent-bg", transparent);
    return () => {
      document.documentElement.classList.remove("transparent-bg");
      document.body.classList.remove("transparent-bg");
    };
  }, [streamMode, transparentWindow]);

  // Sync the native window title to a clean "PNGTuberUltra" — the avatar
  // filename + dirty state lives in the toolbar's brand label instead, so
  // the OS title bar doesn't double up with what the toolbar already shows.
  useEffect(() => {
    getCurrentWindow()
      .setTitle("PNGTuberUltra")
      .catch((err) =>
        console.error("[App] setTitle failed:", err),
      );
  }, []);

  // Save-prompt on window close. Tauri fires CloseRequested in BOTH
  // the JS `onCloseRequested` listener AND the Rust `on_window_event`
  // handler. The Rust side hijacks for close-to-tray; we coordinate
  // by early-returning here when close-to-tray is on (the window
  // will hide instead of close — no data loss possible — so no
  // prompt is needed).
  //
  // Otherwise: if dirty, preventDefault, prompt the user, and call
  // window.destroy() if they save or discard. destroy bypasses
  // CloseRequested entirely so there's no re-prompt loop.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    window
      .onCloseRequested(async (event) => {
        // Close-to-tray flow: Rust will hide the window. App stays
        // running, no work lost. Skip the prompt.
        if (useSettings.getState().closeToTray) return;
        if (!useAvatar.getState().isDirty) return;

        // Block the default close until we hear back from the user.
        event.preventDefault();

        const choice = await promptUnsavedChanges("close PNGTuberUltra");
        if (choice === "cancel") return;
        if (choice === "save") {
          try {
            await saveAvatarToCurrentPath();
          } catch (err) {
            // Save failed (or user cancelled the save dialog) — keep
            // the window open so they don't lose work. They can try
            // again or close-and-discard explicitly.
            console.error("[App] save before close failed:", err);
            return;
          }
        }
        // save succeeded OR user chose discard — proceed with close.
        // destroy() bypasses CloseRequested entirely so we don't
        // re-trigger this handler in a loop.
        await window.destroy();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("[App] failed to subscribe to close event:", err);
      });
    return () => unlisten?.();
  }, []);

  // Tray menu's "Toggle pause input" item emits this event from Rust;
  // we toggle the JS-side setting so the tray and the in-app Privacy
  // toggle stay in sync. The Tauri webview can lose this listener if
  // the window is destroyed and recreated, so re-subscribe on every
  // mount even though Rust only ever emits once per click.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("tray-toggle-pause", () => {
      const cur = useSettings.getState().inputPaused;
      useSettings.getState().setInputPaused(!cur);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("[tray] failed to subscribe:", err);
      });
    return () => unlisten?.();
  }, []);

  // Ctrl/Cmd+Shift+F toggles stream mode. Skipped while focus is on
  // text inputs so the shortcut doesn't fight with people typing F into
  // a field (rare but possible). The exit button in the corner is the
  // safety net for users who forget the shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const t = e.target as HTMLElement | null;
      if (
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.tagName === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setStreamMode(!useSettings.getState().streamMode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setStreamMode]);

  return (
    <div
      className={[
        "app",
        streamMode ? "stream-mode" : "",
        streamMode && transparentWindow ? "transparent-bg" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Toolbar />
      <main className="editor">
        <LayerTree />
        <PixiCanvas />
        <Properties />
      </main>
      <StatusBar />
      {streamMode && (
        <button
          type="button"
          className="stream-mode-exit"
          onClick={() => setStreamMode(false)}
          title="Exit stream mode (Ctrl+Shift+F)"
          aria-label="Exit stream mode"
        >
          <LogOut size={14} />
          <span>Exit stream mode</span>
        </button>
      )}
    </div>
  );
}
