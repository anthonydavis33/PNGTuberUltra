import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, Save } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { useAvatar } from "../store/useAvatar";
import { loadFilesAsAssets } from "../canvas/assetLoader";
import { packAvatar, unpackAvatar } from "../io/pnxr";
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

  const registerAsset = useAvatar((s) => s.registerAsset);
  const addSprite = useAvatar((s) => s.addSprite);
  const isDirty = useAvatar((s) => s.isDirty);
  const currentFilePath = useAvatar((s) => s.currentFilePath);
  const loadAvatar = useAvatar((s) => s.loadAvatar);
  const markSaved = useAvatar((s) => s.markSaved);

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

  // ---- Keyboard shortcuts: Ctrl+S, Ctrl+Shift+S, Ctrl+O -----------
  // The handlers above close over component state, so they're not stable
  // across renders. We hold the latest set in a ref so the keydown
  // listener (bound once) always invokes the freshest version.
  const handlersRef = useRef({ handleSave, handleSaveAs, handleOpen });
  useEffect(() => {
    handlersRef.current = { handleSave, handleSaveAs, handleOpen };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isModifier(e)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (e.shiftKey) void handlersRef.current.handleSaveAs();
        else void handlersRef.current.handleSave();
      } else if (key === "o") {
        e.preventDefault();
        void handlersRef.current.handleOpen();
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
        className="tool-btn"
        onClick={handleOpen}
        disabled={isFileBusy}
        title="Open a .pnxr avatar (Ctrl+O)"
      >
        <FolderOpen size={14} />
        Open
      </button>

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

      <span className="status">Phase 4d — webcam visemes</span>
    </header>
  );
}

