import { useEffect } from "react";
import { LogOut } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
