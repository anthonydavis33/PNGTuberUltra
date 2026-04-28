// .pnxr file format — zip container holding:
//   manifest.json   — { schema, name, savedAt, app }
//   model.json      — full AvatarModel
//   assets/{id}.ext — original asset bytes, keyed by AssetId, ext from MIME

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type AssetEntry,
  type AssetId,
  type AvatarModel,
} from "../types/avatar";
import { loadBytesAsAsset } from "../canvas/assetLoader";

const APP_VERSION = "0.1.0-dev";

interface Manifest {
  schema: 1;
  name: string;
  savedAt: string;
  app: string;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const extForMime = (mime: string): string => MIME_TO_EXT[mime] ?? "bin";
const mimeForExt = (ext: string): string =>
  EXT_TO_MIME[ext.toLowerCase()] ?? "image/png";

export interface UnpackedAvatar {
  manifest: Manifest;
  model: AvatarModel;
  /** Asset entries with textures already loaded into PixiJS's cache. */
  assets: Record<AssetId, AssetEntry>;
}

/**
 * Pack the current avatar (model + asset bytes) into a .pnxr byte array.
 * Caller is responsible for writing the bytes to disk.
 */
export async function packAvatar(args: {
  model: AvatarModel;
  assets: Record<AssetId, AssetEntry>;
  name?: string;
}): Promise<Uint8Array> {
  const manifest: Manifest = {
    schema: 1,
    name: args.name ?? "Avatar",
    savedAt: new Date().toISOString(),
    app: `PNGTuberUltra ${APP_VERSION}`,
  };

  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "model.json": strToU8(JSON.stringify(args.model, null, 2)),
  };

  for (const asset of Object.values(args.assets)) {
    const buf = new Uint8Array(await asset.blob.arrayBuffer());
    const ext = extForMime(asset.mimeType);
    files[`assets/${asset.id}.${ext}`] = buf;
  }

  return zipSync(files, { level: 6 });
}

/**
 * Read a .pnxr byte array, validate, and reconstruct the runtime avatar.
 * Throws on malformed/unsupported zips with a user-friendly message.
 */
export async function unpackAvatar(
  bytes: Uint8Array,
): Promise<UnpackedAvatar> {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch (err) {
    throw new Error(`Could not read .pnxr (corrupt or not a zip): ${String(err)}`);
  }

  const manifestRaw = archive["manifest.json"];
  const modelRaw = archive["model.json"];
  if (!manifestRaw || !modelRaw) {
    throw new Error(
      "Not a valid .pnxr — missing manifest.json or model.json.",
    );
  }

  let manifest: Manifest;
  let model: AvatarModel;
  try {
    manifest = JSON.parse(strFromU8(manifestRaw)) as Manifest;
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${String(err)}`);
  }
  try {
    model = JSON.parse(strFromU8(modelRaw)) as AvatarModel;
  } catch (err) {
    throw new Error(`model.json is not valid JSON: ${String(err)}`);
  }

  if (manifest.schema !== 1) {
    throw new Error(
      `This .pnxr was saved with schema v${manifest.schema}; this build only reads v1.`,
    );
  }
  if (model.schema !== 1) {
    throw new Error(
      `Avatar model is schema v${model.schema}; this build only reads v1.`,
    );
  }

  // Restore assets — read each bytes-file in assets/, build an AssetEntry,
  // pre-warm the Pixi texture cache.
  const assets: Record<AssetId, AssetEntry> = {};
  for (const path in archive) {
    if (!path.startsWith("assets/")) continue;
    const filename = path.slice("assets/".length);
    const lastDot = filename.lastIndexOf(".");
    if (lastDot === -1) continue;
    const id = filename.slice(0, lastDot);
    const ext = filename.slice(lastDot + 1);

    try {
      const entry = await loadBytesAsAsset({
        id,
        name: id,
        bytes: archive[path],
        mimeType: mimeForExt(ext),
      });
      assets[id] = entry;
    } catch (err) {
      console.error(`Failed to load asset ${id}:`, err);
      // Skip the broken asset; sprites referencing it will render as
      // placeholder rectangles.
    }
  }

  return { manifest, model, assets };
}
