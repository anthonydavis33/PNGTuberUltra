import { useRef, useState } from "react";
import { useAvatar } from "../store/useAvatar";
import { loadFilesAsAssets } from "../canvas/assetLoader";
import { DEFAULT_ANCHOR, DEFAULT_TRANSFORM } from "../types/avatar";

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setLoading] = useState(false);
  const registerAsset = useAvatar((s) => s.registerAsset);
  const addSprite = useAvatar((s) => s.addSprite);

  const onPickFiles = () => fileInputRef.current?.click();

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setLoading(true);
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
      setLoading(false);
      // Reset so picking the same file twice in a row still triggers onChange.
      e.target.value = "";
      // Drop focus from the hidden file input so keyboard shortcuts (Delete
      // etc.) work right after picking files.
      e.target.blur();
    }
  };

  return (
    <header className="toolbar">
      <span className="brand">PNGTuberUltra</span>
      <button
        className="tool-btn"
        onClick={onPickFiles}
        disabled={isLoading}
        title="Add one or more PNG/JPG/WebP images as sprites"
      >
        {isLoading ? "Loading..." : "+ Add Sprite"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={onFiles}
      />
      <span className="status">Phase 2a — real PNG sprites</span>
    </header>
  );
}
