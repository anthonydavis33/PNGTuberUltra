import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FilePlus,
  FolderOpen,
  Redo2,
  Save,
  Settings,
  Sparkles,
  Undo2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { useAvatar } from "../store/useAvatar";
import { unpackAvatar } from "../io/pnxr";
import { SAMPLES, type SampleEntry } from "../io/sampleRig";
import {
  PNXR_FILTERS,
  promptUnsavedChanges,
  saveAvatarAs,
  saveAvatarToCurrentPath,
} from "../io/fileOps";
import { SettingsPopover } from "./SettingsPopover";
import { fileNameFromPath, shortPath } from "../utils/path";

/** Displayed in the top-right "version" slot. Bump this in lockstep
 *  with package.json on releases. The toolbar shows it in plain text;
 *  no fancy formatting. */
const APP_VERSION = "v0.9.8";

/** Detect modifier-key for save/open shortcuts. Cmd on Mac, Ctrl elsewhere. */
const isModifier = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey;

export function Toolbar() {
  const [isFileBusy, setFileBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSampleMenu, setShowSampleMenu] = useState(false);
  const sampleMenuRef = useRef<HTMLDivElement>(null);

  const isDirty = useAvatar((s) => s.isDirty);
  const currentFilePath = useAvatar((s) => s.currentFilePath);
  const loadAvatar = useAvatar((s) => s.loadAvatar);
  const newAvatar = useAvatar((s) => s.newAvatar);
  const undo = useAvatar((s) => s.undo);
  const redo = useAvatar((s) => s.redo);
  // Subscribe to history lengths so the buttons re-render when their
  // enabled state should change.
  const canUndo = useAvatar((s) => s.history.past.length > 0);
  const canRedo = useAvatar((s) => s.history.future.length > 0);

  // ---- Open / Save / Save As ----------------------------------------
  const flashStatus = (msg: string) => {
    setStatusMessage(msg);
    window.setTimeout(() => {
      setStatusMessage((s) => (s === msg ? null : s));
    }, 2500);
  };

  /**
   * Run the unsaved-changes prompt before a destructive operation
   * (New / Open / Load Sample). Returns false if the user cancelled
   * (caller aborts), true if they chose to save (already saved
   * synchronously here) or to discard. Centralizes the dirty check
   * so all destructive handlers behave identically — same prompt,
   * same save flow, same error handling.
   */
  const confirmDiscardChanges = async (
    actionLabel: string,
  ): Promise<boolean> => {
    if (!isDirty) return true;
    const choice = await promptUnsavedChanges(actionLabel);
    if (choice === "cancel") return false;
    if (choice === "save") {
      try {
        const path = await saveAvatarToCurrentPath();
        flashStatus(`Saved ${shortPath(path)}`);
      } catch (err) {
        console.error("Save failed before destructive op:", err);
        flashStatus(
          err instanceof Error
            ? `Save failed: ${err.message}`
            : "Save failed",
        );
        return false; // don't proceed if save failed / cancelled
      }
    }
    return true;
  };

  const handleNew = async () => {
    if (isFileBusy) return;
    if (!(await confirmDiscardChanges("start a new avatar"))) return;
    setFileBusy(true);
    try {
      newAvatar();
      flashStatus("New avatar");
    } finally {
      setFileBusy(false);
    }
  };

  const handleOpen = async () => {
    if (isFileBusy) return;
    if (!(await confirmDiscardChanges("open another avatar"))) return;
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

  const handleSave = async () => {
    if (isFileBusy) return;
    setFileBusy(true);
    try {
      const path = await saveAvatarToCurrentPath();
      flashStatus(`Saved ${shortPath(path)}`);
    } catch (err) {
      // "Save cancelled by user" is the cancel path from the save
      // dialog — don't surface that as an error toast since the
      // user knew what they were doing. Only show the toast for
      // genuine failures (write errors, packing failures).
      if (err instanceof Error && err.message === "Save cancelled by user") {
        // no-op
      } else {
        console.error("Save failed:", err);
        flashStatus(
          err instanceof Error ? `Save failed: ${err.message}` : "Save failed",
        );
      }
    } finally {
      setFileBusy(false);
    }
  };

  const handleLoadSample = async (sample: SampleEntry) => {
    if (isFileBusy) return;
    setShowSampleMenu(false);
    if (!(await confirmDiscardChanges(`load the "${sample.name}" sample`))) {
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
      const path = await saveAvatarAs();
      flashStatus(`Saved ${shortPath(path)}`);
    } catch (err) {
      if (err instanceof Error && err.message === "Save cancelled by user") {
        // no-op
      } else {
        console.error("Save As failed:", err);
        flashStatus(
          err instanceof Error
            ? `Save As failed: ${err.message}`
            : "Save As failed",
        );
      }
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
    handleNew,
    undo,
    redo,
  });
  useEffect(() => {
    handlersRef.current = {
      handleSave,
      handleSaveAs,
      handleOpen,
      handleNew,
      undo,
      redo,
    };
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
      if (key === "n") {
        e.preventDefault();
        void handlersRef.current.handleNew();
      } else if (key === "s") {
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

  // Filename label: shows "Untitled" until the user saves to disk, then
  // the basename (no extension). Color flips between green (clean —
  // current state matches what's saved) and red (dirty — there are
  // unsaved edits) so the user has an at-a-glance read on whether
  // pressing Save would persist anything. The animated dirty dot
  // remains as a secondary cue for accessibility / muted color
  // schemes where the green/red distinction is harder to see.
  const fileLabel = currentFilePath
    ? fileNameFromPath(currentFilePath)
    : "Untitled";
  const fileLabelTitle = currentFilePath
    ? isDirty
      ? `${shortPath(currentFilePath)} — unsaved changes (Ctrl+S to save)`
      : `${shortPath(currentFilePath)} — saved`
    : isDirty
      ? "Unsaved changes — Ctrl+S to save"
      : "No file — Ctrl+S to save for the first time";

  return (
    <header className="toolbar">
      <span
        className={`brand ${isDirty ? "dirty" : "clean"}`}
        title={fileLabelTitle}
      >
        {fileLabel}
        {isDirty && (
          <span
            className="dirty-dot"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
      </span>

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
        onClick={handleNew}
        disabled={isFileBusy}
        title="Start a new avatar (Ctrl+N) — clears the scene. Prompts to save if there are unsaved changes."
      >
        <FilePlus size={14} />
        New
      </button>

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

      {/* Sample dropdown sits to the right of Save As — tertiary file
       *  action, distinct from the primary Open / Save / Save As flow. */}
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

      {statusMessage && <span className="toolbar-status">{statusMessage}</span>}

      <span className="status" title="App version">{APP_VERSION}</span>

      <button
        className="tool-btn icon-only toolbar-settings-btn"
        onClick={() => setShowSettings((v) => !v)}
        title="Settings — wheel zoom, streaming, privacy, global input"
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

