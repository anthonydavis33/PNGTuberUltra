// Path / filename helpers. Cross-platform — handles both \ (Windows) and /
// (POSIX) separators since Tauri returns native paths on whichever OS is
// running.

const PNXR_EXT = /\.pnxr$/i;

/** Extract the filename (no path, no .pnxr extension) from an absolute path. */
export function fileNameFromPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  const last = parts[parts.length - 1] ?? path;
  return last.replace(PNXR_EXT, "");
}

/** Trim a long path to "…/filename" for compact status display. */
export function shortPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  return parts.length > 1 ? `…${sep}${parts[parts.length - 1]}` : path;
}
