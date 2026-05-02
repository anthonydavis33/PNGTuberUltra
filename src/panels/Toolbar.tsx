import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Plus,
  Redo2,
  Save,
  Settings,
  Sparkles,
  Undo2,
} from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { useAvatar } from "../store/useAvatar";
import { loadFilesAsAssets } from "../canvas/assetLoader";
import { packAvatar, unpackAvatar } from "../io/pnxr";
import { SAMPLES, type SampleEntry } from "../io/sampleRig";
import { SettingsPopover } from "./SettingsPopover";
import { DEFAULT_ANCHOR, DEFAULT_TRANSFORM } from "../types/avatar";
import { shortPath } from "../utils/path";

/** Detect modifier-key for save/open shortcuts. Cmd on Mac, Ctrl elsewhere. */
const isModifier = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey;

const PNXR_FILTERS = [
  { name: "PNGTuberUltra Avatar", extensions: ["pnxr"] },
];

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoadingAssets, setLoadingAssets] = useState(false);
  const [isFileBusy, setFileBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSampleMenu, setShowSampleMenu] = useState(false);
  const sampleMenuRef = useRef<HTMLDivElement>(null);

  const registerAsset = useAvatar((s) => s.registerAsset);
  const addSprite = useAvatar((s) => s.addSprite);
  const isDirty = useAvatar((s) => s.isDirty);
  const currentFilePath = useAvatar((s) => s.currentFilePath);
  const loadAvatar = useAvatar((s) => s.loadAvatar);
  const markSaved = useAvatar((s) => s.markSaved);
  const undo = useAvatar((s) => s.undo);
  const redo = useAvatar((s) => s.redo);
  // Subscribe to history lengths so the buttons re-render when their
  // enabled state should change.
  const canUndo = useAvatar((s) => s.history.past.length > 0);
  const canRedo = useAvatar((s) => s.history.future.length > 0);

  // ---- Add Sprite ----------------------------------------------------
  const onPickFiles = () => fileInputRef.current?.click();

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setLoadingAssets(true);
    try {
      const loaded = await loadFilesAsAssets(files);
      for (const asset of loaded) {
        registerAsset(asset);
        addSprite({
          name: asset.name,
          asset: asset.id,
          transform: { ...DEFAULT_TRANSFORM },
          anchor: { ...DEFAULT_ANCHOR },
          visible: true,
          bindings: [],
          modifiers: [],
        });
      }
    } catch (err) {
      console.error("Failed to load image(s):", err);
    } finally {
      setLoadingAssets(false);
      e.target.value = "";
      e.target.blur();
    }
  };

  // ---- Open / Save / Save As ----------------------------------------
  const flashStatus = (msg: string) => {
    setStatusMessage(msg);
    window.setTimeout(() => {
      setStatusMessage((s) => (s === msg ? null : s));
    }, 2500);
  };

  const handleOpen = async () => {
    if (isFileBusy) return;
    if (
      isDirty &&
      !window.confirm(
        "You have unsaved changes. Open another avatar anyway?",
      )
    ) {
      return;
    }
    setFileBusy(true);
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: PNXR_FILTERS,
      });
      if (!picked || Array.isArray(picked)) {
        setFileBusy(false);
        return;
      }
      const bytes = await readFile(picked);
      const unpacked = await unpackAvatar(bytes);
      loadAvatar(unpacked.model, unpacked.assets, picked);
      flashStatus(`Opened ${shortPath(picked)}`);
    } catch (err) {
      console.error("Open failed:", err);
      flashStatus(
        err instanceof Error ? `Open failed: ${err.message}` : "Open failed",
      );
    } finally {
      setFileBusy(false);
    }
  };

  const writeToPath = async (path: string) => {
    const state = useAvatar.getState();
    const bytes = await packAvatar({
      model: state.model,
      assets: state.assets,
    });
    // writeFile accepts a Uint8Array.
    await writeFile(path, bytes);
    markSaved(path);
    flashStatus(`Saved ${shortPath(path)}`);
  };

  const handleSave = async () => {
    if (isFileBusy) return;
    setFileBusy(true);
    try {
      let path = currentFilePath;
      if (!path) {
        const picked = await saveDialog({
          defaultPath: "avatar.pnxr",
          filters: PNXR_FILTERS,
        });
        if (!picked) {
          setFileBusy(false);
          return;
        }
        path = picked;
      }
      await writeToPath(path);
    } catch (err) {
      console.error("Save failed:", err);
      flashStatus(
        err instanceof Error ? `Save failed: ${err.message}` : "Save failed",
      );
    } finally {
      setFileBusy(false);
    }
  };

  const handleLoadSample = async (sample: SampleEntry) => {
    if (isFileBusy) return;
    setShowSampleMenu(false);
    if (
      isDirty &&
      !window.confirm(
        `You have unsaved changes. Load the "${sample.name}" sample anyway?`,
      )
    ) {
      return;
    }
    setFileBusy(true);
    try {
      const { model, assets } = await sample.build();
      // null filePath — sample is in-memory only until the user explicitly
      // saves it; matches the "fresh document" semantics the user expects
      // for a starter rig.
      loadAvatar(model, assets, null);
      flashStatus(`Loaded ${sample.name} sample`);
    } catch (err) {
      console.error("Sample rig load failed:", err);
      flashStatus(
        err instanceof Error
          ? `Sample load failed: ${err.message}`
          : "Sample load failed",
      );
    } finally {
      setFileBusy(false);
    }
  };

  // Close the sample menu on outside click / Esc. Same pattern as the
  // mic / webcam / settings popovers — defer one frame so the click
  // that opened the menu doesn't immediately close it.
  useEffect(() => {
    if (!showSampleMenu) return;
    const onClick = (e: MouseEvent) => {
      if (
        sampleMenuRef.current &&
        !sampleMenuRef.current.contains(e.target as Node)
      ) {
        setShowSampleMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSampleMenu(false);
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", onClick);
      document.addEventListener("keydown", onKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [showSampleMenu]);

  const handleSaveAs = async () => {
    if (isFileBusy) return;
    setFileBusy(true);
    try {
      const picked = await saveDialog({
        defaultPath: currentFilePath ?? "avatar.pnxr",
        filters: PNXR_FILTERS,
      });
      if (!picked) {
        setFileBusy(false);
        return;
      }
      await writeToPath(picked);
    } catch (err) {
      console.error("Save As failed:", err);
      flashStatus(
        err instanceof Error
          ? `Save As failed: ${err.message}`
          : "Save As failed",
      );
    } finally {
      setFileBusy(false);
    }
  };

  // ---- Keyboard shortcuts: Ctrl+S, Ctrl+Shift+S, Ctrl+O, Ctrl+Z,
  // Ctrl+Shift+Z, Ctrl+Y -----------
  // The save/open handlers close over component state, so they're not
  // stable across renders. Undo/redo are stable Zustand refs but we keep
  // them in the ref bag too for symmetry. The keydown listener is bound
  // once and always invokes the freshest version through the ref.
  const handlersRef = useRef({
    handleSave,
    handleSaveAs,
    handleOpen,
    undo,
    redo,
  });
  useEffect(() => {
    handlersRef.current = { handleSave, handleSaveAs, handleOpen, undo, redo };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isModifier(e)) return;

      // Don't hijack typing in inputs/textareas — users typing into a
      // field should be able to use undo on the field's own text.
      // contentEditable elements behave the same way.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (e.shiftKey) void handlersRef.current.handleSaveAs();
        else void handlersRef.current.handleSave();
      } else if (key === "o") {
        e.preventDefault();
        void handlersRef.current.handleOpen();
      } else if (key === "z") {
        // Ctrl+Z = undo, Ctrl+Shift+Z = redo (the macOS / Photoshop /
        // VS Code convention).
        e.preventDefault();
        if (e.shiftKey) handlersRef.current.redo();
        else handlersRef.current.undo();
      } else if (key === "y") {
        // Ctrl+Y = redo (the Windows convention; second binding for
        // muscle-memory parity).
        e.preventDefault();
        handlersRef.current.redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="toolbar">
      <span className="brand">
        PNGTuberUltra
        {isDirty && (
          <span
            className="dirty-dot"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
      </span>

      <button
        className="tool-btn"
        onClick={onPickFiles}
        disabled={isLoadingAssets}
        title="Add image sprites — click to pick files, or drag PNG / JPG / WebP onto the canvas"
      >
        <Plus size={14} />
        {isLoadingAssets ? "Loading..." : "Add Sprite"}
      </button>

      <span className="toolbar-divider" />

      <button
        className="tool-btn icon-only"
        onClick={undo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        <Undo2 size={14} />
      </button>

      <button
        className="tool-btn icon-only"
        onClick={redo}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
        aria-label="Redo"
      >
        <Redo2 size={14} />
      </button>

      <span className="toolbar-divider" />

      <button
        className="tool-btn"
        onClick={handleOpen}
        disabled={isFileBusy}
        title="Open a .pnxr avatar (Ctrl+O)"
      >
        <FolderOpen size={14} />
        Open
      </button>

      <div className="sample-menu-wrap" ref={sampleMenuRef}>
        <button
          className="tool-btn"
          onClick={() => setShowSampleMenu((v) => !v)}
          disabled={isFileBusy}
          title="Load a pre-wired sample rig — exercises a different slice of the rigging stack each. Click to choose."
        >
          <Sparkles size={14} />
          Sample
          <ChevronDown size={12} />
        </button>

        {showSampleMenu && (
          <div className="sample-menu" role="menu">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                role="menuitem"
                className="sample-menu-item"
                onClick={() => handleLoadSample(sample)}
                disabled={isFileBusy}
              >
                <div className="sample-menu-name">{sample.name}</div>
                <div className="sample-menu-desc">{sample.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="tool-btn"
        onClick={handleSave}
        disabled={isFileBusy}
        title={
          currentFilePath
            ? `Save to ${shortPath(currentFilePath)} (Ctrl+S)`
            : "Save (Ctrl+S — will prompt for location)"
        }
      >
        <Save size={14} />
        Save
      </button>

      <button
        className="tool-btn"
        onClick={handleSaveAs}
        disabled={isFileBusy}
        title="Save to a new location (Ctrl+Shift+S)"
      >
        Save As…
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={onFiles}
      />

      {statusMessage && <span className="toolbar-status">{statusMessage}</span>}

      <span className="status">Phase 9d — tray + privacy</span>

      <button
        className="tool-btn icon-only toolbar-settings-btn"
        onClick={() => setShowSettings((v) => !v)}
        title="Settings — wheel zoom, future preferences"
        aria-label="Settings"
      >
        <Settings size={14} />
      </button>

      {showSettings && (
        <SettingsPopover onClose={() => setShowSettings(false)} />
      )}
    </header>
  );
}

