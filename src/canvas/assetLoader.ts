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
