// Keyboard settings popover — anchored above the status bar's keyboard gear.
// Two stacked sections: Regions (with the on-screen keyboard editor) and
// Hotkeys. Auto-saves to AvatarModel.inputs.keyboard on every change.

import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import { useInputValue } from "../hooks/useInputValue";
import { VirtualKeyboard } from "../components/VirtualKeyboard";
import { normalizeKey } from "../inputs/KeyboardSource";
import {
  DEFAULT_KEYBOARD_CONFIG,
  type Hotkey,
  type HotkeyKind,
  type KeyboardRegion,
  type RegionMode,
} from "../types/avatar";

interface KeyboardPopoverProps {
  onClose: () => void;
}

const newId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export function KeyboardPopover({ onClose }: KeyboardPopoverProps) {
  const config =
    useAvatar((s) => s.model.inputs?.keyboard) ?? DEFAULT_KEYBOARD_CONFIG;
  const updateKeyboardConfig = useAvatar((s) => s.updateKeyboardConfig);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [editingRegionId, setEditingRegionId] = useState<string | null>(null);
  /** Hotkey id in "press a key to bind" mode (null = idle). */
  const [bindingHotkeyId, setBindingHotkeyId] = useState<string | null>(null);

  const pressedKeys = useInputValue<Set<string>>("KeyDown") ?? new Set();

  // Outside click + Escape close. Defer one frame so the click that opened us
  // doesn't immediately close us.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (bindingHotkeyId) {
          setBindingHotkeyId(null);
          return;
        }
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, bindingHotkeyId]);

  // While "press a key to bind" mode is active, capture the next keydown
  // anywhere as the new key for that hotkey.
  useEffect(() => {
    if (!bindingHotkeyId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setBindingHotkeyId(null);
        return;
      }
      const key = normalizeKey(e);
      updateHotkey(bindingHotkeyId, { key });
      setBindingHotkeyId(null);
    };
    // Capture phase so we beat the global keyboard listener.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingHotkeyId]);

  // ----- Region helpers ------------------------------------------------
  const editingRegion =
    editingRegionId !== null
      ? config.regions.find((r) => r.id === editingRegionId) ?? null
      : null;

  const otherUsedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of config.regions) {
      if (r.id === editingRegionId) continue;
      for (const k of r.keys) set.add(k);
    }
    return set;
  }, [config.regions, editingRegionId]);

  /** Names that appear more than once across regions. Region names must be
   *  unique because they're the public bus value sprites bind to. */
  const duplicateRegionNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of config.regions) {
      const trimmed = r.name.trim();
      if (!trimmed) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, c]) => c > 1)
        .map(([n]) => n),
    );
  }, [config.regions]);

  const hasInvalidRegions =
    duplicateRegionNames.size > 0 ||
    config.regions.some((r) => !r.name.trim());

  const updateRegion = (id: string, patch: Partial<KeyboardRegion>) => {
    updateKeyboardConfig({
      regions: config.regions.map((r) =>
        r.id === id ? { ...r, ...patch } : r,
      ),
    });
  };

  const addRegion = () => {
    const region: KeyboardRegion = {
      id: newId("region"),
      name: "new region",
      keys: [],
      mode: "momentary",
    };
    updateKeyboardConfig({ regions: [...config.regions, region] });
    setEditingRegionId(region.id);
  };

  const removeRegion = (id: string) => {
    updateKeyboardConfig({
      regions: config.regions.filter((r) => r.id !== id),
    });
    if (editingRegionId === id) setEditingRegionId(null);
  };

  const toggleKeyInRegion = (key: string) => {
    if (!editingRegion) return;
    const has = editingRegion.keys.includes(key);
    updateRegion(editingRegion.id, {
      keys: has
        ? editingRegion.keys.filter((k) => k !== key)
        : [...editingRegion.keys, key],
    });
  };

  // ----- Hotkey helpers ------------------------------------------------
  const updateHotkey = (id: string, patch: Partial<Hotkey>) => {
    updateKeyboardConfig({
      hotkeys: config.hotkeys.map((h) =>
        h.id === id ? { ...h, ...patch } : h,
      ),
    });
  };

  const addHotkey = () => {
    const hk: Hotkey = {
      id: newId("hk"),
      name: "new hotkey",
      key: "",
      kind: "set",
      channel: "Expression",
      value: "",
    };
    updateKeyboardConfig({ hotkeys: [...config.hotkeys, hk] });
    setBindingHotkeyId(hk.id);
  };

  const removeHotkey = (id: string) => {
    updateKeyboardConfig({
      hotkeys: config.hotkeys.filter((h) => h.id !== id),
    });
    if (bindingHotkeyId === id) setBindingHotkeyId(null);
  };

  return (
    <div ref={popoverRef} className="settings-popover keyboard-popover">
      <div className="settings-popover-header">
        <h3>Keyboard Settings</h3>
        <button
          onClick={onClose}
          className="popover-close"
          title="Close (Esc)"
          aria-label="Close keyboard settings"
        >
          <X size={14} />
        </button>
      </div>

      {/* ===================== REGIONS ===================== */}
      <section className="popover-section">
        <div className="popover-section-header">
          <span>Regions</span>
          <button onClick={addRegion} className="tool-btn">
            + Region
          </button>
        </div>

        {hasInvalidRegions && (
          <p className="validation-warning">
            Each region needs a unique, non-empty name. Region names are how
            sprites identify which region is active.
          </p>
        )}

        {config.regions.length === 0 ? (
          <p className="empty">
            No regions yet. Use regions to group keys (e.g. left/right halves
            for Bongo Cat-style typing).
          </p>
        ) : (
          <ul className="region-list">
            {config.regions.map((r) => (
              <li
                key={r.id}
                className={editingRegionId === r.id ? "editing" : ""}
                onClick={() =>
                  setEditingRegionId(editingRegionId === r.id ? null : r.id)
                }
              >
                <input
                  type="text"
                  className={`region-name ${
                    duplicateRegionNames.has(r.name.trim()) ||
                    !r.name.trim()
                      ? "has-error"
                      : ""
                  }`}
                  value={r.name}
                  onChange={(e) =>
                    updateRegion(r.id, { name: e.target.value })
                  }
                  onClick={(e) => e.stopPropagation()}
                  placeholder="region name"
                  title={
                    duplicateRegionNames.has(r.name.trim())
                      ? "Duplicate region name. Each region must have a unique name."
                      : !r.name.trim()
                      ? "Region name required."
                      : undefined
                  }
                />
                <select
                  className="region-mode"
                  value={r.mode ?? "momentary"}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    updateRegion(r.id, {
                      mode: e.target.value as RegionMode,
                    });
                  }}
                  title={
                    "momentary: clears when keys released. latching: stays until another region key is pressed."
                  }
                >
                  <option value="momentary">momentary</option>
                  <option value="latching">latching</option>
                </select>
                <span className="region-keycount">{r.keys.length} keys</span>
                <button
                  className="region-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRegion(r.id);
                  }}
                  title="Remove region"
                  aria-label={`Remove ${r.name}`}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {editingRegion && (
          <>
            <div className="region-edit-hint">
              Click keys to add/remove from <strong>{editingRegion.name}</strong>.
              Dashed = used by another region.
            </div>
            <VirtualKeyboard
              highlightedKeys={new Set(editingRegion.keys)}
              otherUsedKeys={otherUsedKeys}
              pressedKeys={pressedKeys}
              onKeyClick={toggleKeyInRegion}
            />
          </>
        )}
      </section>

      {/* ===================== HOTKEYS ===================== */}
      <section className="popover-section">
        <div className="popover-section-header">
          <span>Hotkeys</span>
          <button onClick={addHotkey} className="tool-btn">
            + Hotkey
          </button>
        </div>

        {config.hotkeys.length === 0 ? (
          <p className="empty">
            No hotkeys yet. Hotkeys publish to bus channels — multiple "set"
            hotkeys on one channel give radio behavior; "toggle" hotkeys flip
            booleans.
          </p>
        ) : (
          <table className="hotkey-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Kind</th>
                <th>Channel</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {config.hotkeys.map((hk) => (
                <tr key={hk.id}>
                  <td>
                    <input
                      type="text"
                      value={hk.name}
                      onChange={(e) =>
                        updateHotkey(hk.id, { name: e.target.value })
                      }
                      placeholder="name"
                    />
                  </td>
                  <td>
                    <button
                      className={`tool-btn hotkey-key ${
                        bindingHotkeyId === hk.id ? "binding" : ""
                      }`}
                      onClick={() =>
                        setBindingHotkeyId(
                          bindingHotkeyId === hk.id ? null : hk.id,
                        )
                      }
                      title="Click and press a key to rebind"
                    >
                      {bindingHotkeyId === hk.id
                        ? "press key…"
                        : hk.key || "—"}
                    </button>
                  </td>
                  <td>
                    <select
                      value={hk.kind}
                      onChange={(e) =>
                        updateHotkey(hk.id, {
                          kind: e.target.value as HotkeyKind,
                        })
                      }
                    >
                      <option value="set">set</option>
                      <option value="toggle">toggle</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      value={hk.channel}
                      onChange={(e) =>
                        updateHotkey(hk.id, { channel: e.target.value })
                      }
                      placeholder="Expression"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={hk.value ?? ""}
                      disabled={hk.kind === "toggle"}
                      onChange={(e) =>
                        updateHotkey(hk.id, { value: e.target.value })
                      }
                      placeholder={hk.kind === "toggle" ? "—" : "happy"}
                    />
                  </td>
                  <td>
                    <button
                      className="hotkey-delete"
                      onClick={() => removeHotkey(hk.id)}
                      title="Remove hotkey"
                      aria-label={`Remove ${hk.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
