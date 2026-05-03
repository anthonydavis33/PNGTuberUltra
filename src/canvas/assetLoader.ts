// Loads image files into PixiJS's Assets cache so syncSprites can stay
// synchronous. The cache is keyed by AssetId — PixiApp later retrieves
// textures via `Assets.cache.get(assetId)`.
//
// Why we don't use Assets.load(blobUrl) directly: Pixi's Assets resolver
// infers the loader from the URL extension, and blob:* URLs have none, so
// it fails to produce a Texture. We bypass it by loading via a plain
// HTMLImageElement and constructing the Texture ourselves.

import { Assets, Texture } from "pixi.js";
import type { AssetEntry } from "../types/avatar";

let nextAssetNum = 1;
const genAssetId = (): string => `asset-${nextAssetNum++}`;

const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Extract per-pixel alpha from an HTMLImageElement via a hidden 2D canvas.
 * Used by the per-pixel hit-testing path in PixiApp so clicks pass through
 * transparent areas of a sprite to whatever's underneath.
 *
 * Returns undefined if the canvas is tainted (cross-origin) or 2D context
 * is unavailable — caller falls back to rectangular hit testing in that case.
 */
function extractAlphaMap(img: HTMLImageElement): Uint8Array | undefined {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w === 0 || h === 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0);
  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, w, h);
  } catch {
    return undefined;
  }
  const data = pixels.data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3];
  }
  return alpha;
}

/** Alpha threshold (0..255) used for both hit testing and visible-
 *  bounds computation. Pixels at or below count as transparent.
 *  Matches the threshold used by the per-pixel hit test in PixiApp. */
const ALPHA_THRESHOLD = 10;

/**
 * Compute the tight bounding rectangle of non-transparent pixels.
 * One full O(w·h) pass through the alpha map at asset load time —
 * caller stores the result on the AssetEntry so the runtime can
 * align mesh quads + the editor's free-transform overlay to the
 * visible art instead of the full texture rect.
 *
 * Returns undefined for fully transparent textures (no pixel above
 * threshold) — caller falls back to full bounds in that case.
 */
function computeVisibleBounds(
  alpha: Uint8Array,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowStart = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[rowStart + x] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined; // fully transparent
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export async function loadFileAsAsset(file: File): Promise<AssetEntry> {
  const id = genAssetId();
  const blobUrl = URL.createObjectURL(file);

  const img = new Image();
  img.src = blobUrl;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    console.error(`Could not decode image: ${file.name}`, err);
    throw err;
  }

  const texture = Texture.from(img);
  Assets.cache.set(id, texture);

  const alphaMap = extractAlphaMap(img);
  const visibleBounds = alphaMap
    ? computeVisibleBounds(alphaMap, img.naturalWidth, img.naturalHeight)
    : undefined;

  return {
    id,
    name: file.name.replace(SUPPORTED_EXTENSIONS, ""),
    blobUrl,
    blob: file,
    mimeType: file.type || "image/png",
    width: img.naturalWidth,
    height: img.naturalHeight,
    alphaMap,
    visibleBounds,
  };
}

/**
 * Build an AssetEntry from raw bytes (e.g. when loading a .pnxr from disk).
 * Same flow as loadFileAsAsset but skips the File wrapper.
 */
export async function loadBytesAsAsset(args: {
  id: string;
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<AssetEntry> {
  const blob = new Blob([args.bytes as BlobPart], { type: args.mimeType });
  const blobUrl = URL.createObjectURL(blob);

  const img = new Image();
  img.src = blobUrl;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }

  const texture = Texture.from(img);
  Assets.cache.set(args.id, texture);

  const alphaMap = extractAlphaMap(img);
  const visibleBounds = alphaMap
    ? computeVisibleBounds(alphaMap, img.naturalWidth, img.naturalHeight)
    : undefined;

  return {
    id: args.id,
    name: args.name,
    blobUrl,
    blob,
    mimeType: args.mimeType,
    width: img.naturalWidth,
    height: img.naturalHeight,
    alphaMap,
    visibleBounds,
  };
}

/** Load multiple files in parallel. */
export async function loadFilesAsAssets(
  files: FileList | File[],
): Promise<AssetEntry[]> {
  return Promise.all(Array.from(files).map(loadFileAsAsset));
}

/** Free both Pixi's cached texture and the blob URL. */
export async function unloadAsset(asset: AssetEntry): Promise<void> {
  URL.revokeObjectURL(asset.blobUrl);
  if (Assets.cache.has(asset.id)) {
    Assets.cache.remove(asset.id);
  }
}
