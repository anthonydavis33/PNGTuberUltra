import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toolbar } from "./panels/Toolbar";
import { LayerTree } from "./panels/LayerTree";
import { Properties } from "./panels/Properties";
import { StatusBar } from "./panels/StatusBar";
import { PixiCanvas } from "./canvas/PixiCanvas";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAvatar } from "./store/useAvatar";
import { fileNameFromPath } from "./utils/path";
import "./App.css";

export default function App() {
  useKeyboardShortcuts();

  const currentFilePath = useAvatar((s) => s.currentFilePath);

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

  return (
    <div className="app">
      <Toolbar />
      <main className="editor">
        <LayerTree />
        <PixiCanvas />
        <Properties />
      </main>
      <StatusBar />
    </div>
  );
}
