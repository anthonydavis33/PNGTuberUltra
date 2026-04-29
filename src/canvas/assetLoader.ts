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

  return {
    id,
    name: file.name.replace(SUPPORTED_EXTENSIONS, ""),
    blobUrl,
    blob: file,
    mimeType: file.type || "image/png",
    width: img.naturalWidth,
    height: img.naturalHeight,
    alphaMap: extractAlphaMap(img),
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

  return {
    id: args.id,
    name: args.name,
    blobUrl,
    blob,
    mimeType: args.mimeType,
    width: img.naturalWidth,
    height: img.naturalHeight,
    alphaMap: extractAlphaMap(img),
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
