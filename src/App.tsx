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
import { fileNameFromPath } from "./utils/path";
import "./App.css";

export default function App() {
  useKeyboardShortcuts();

  const currentFilePath = useAvatar((s) => s.currentFilePath);
  const streamMode = useSettings((s) => s.streamMode);
  const setStreamMode = useSettings((s) => s.setStreamMode);
  const closeToTray = useSettings((s) => s.closeToTray);

  // Push close-to-tray setting through to Rust whenever it changes.
  // Rust holds an atomic flag the window's CloseRequested handler
  // reads — JS is the source of truth, Rust mirrors. invoke is
  // best-effort: if the command doesn't exist (unlikely) we just log.
  useEffect(() => {
    invoke("set_close_to_tray", { enabled: closeToTray }).catch((err) => {
      console.error("[close-to-tray] sync to Rust failed:", err);
    });
  }, [closeToTray]);

  // Sync the native window title: "PNGTuberUltra - <name>" where <name> is
  // the avatar's filename (no extension), or "Unnamed" until first save/open.
  useEffect(() => {
    const name = currentFilePath
      ? fileNameFromPath(currentFilePath)
      : "Unnamed";
    getCurrentWindow()
      .setTitle(`PNGTuberUltra - ${name}`)
      .catch((err) =>
        console.error("[App] setTitle failed:", err),
      );
  }, [currentFilePath]);

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
    <div className={`app ${streamMode ? "stream-mode" : ""}`}>
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
