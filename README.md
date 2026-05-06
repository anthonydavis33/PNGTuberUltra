# PNGTuberUltra

An open-source PNGTuber app aiming to close the UX and feature gap between PNGTuber+ and Live2D-class tools — without requiring rigged Live2D models.

**Status:** early development. The repo is wired up, the architecture is documented, but it does not run as a usable app yet. See [PLAN.md](PLAN.md) for the full MVP scope, data model, and build phases.

## Stack

- [Tauri 2](https://tauri.app/) — native shell
- React + TypeScript + [Vite](https://vite.dev/)
- [PixiJS](https://pixijs.com/) — canvas renderer
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) — webcam face tracking (planned, not yet integrated)
- [Zustand](https://github.com/pmndrs/zustand) — app state
- pnpm — package manager

## Prerequisites

- Node.js 18+ (tested on 24)
- pnpm (`npm install -g pnpm`)
- Rust toolchain — install via [rustup](https://www.rust-lang.org/tools/install)
- On Windows: Microsoft C++ Build Tools (rustup will prompt if missing)
- See the [Tauri prerequisites page](https://tauri.app/start/prerequisites/) for the canonical list

## Develop

```sh
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` launches the native window with hot reload. `pnpm dev` alone runs the Vite dev server in a browser, useful for iterating on UI without the Tauri shell.

## Build

```sh
pnpm tauri build
```

Produces a native installer for the host OS in `src-tauri/target/release/bundle/`:

- **Windows:** `.msi` (Windows Installer) and `.exe` (NSIS installer) under `bundle/msi/` and `bundle/nsis/`.
- **macOS:** `.dmg` and `.app` under `bundle/dmg/` and `bundle/macos/`.
- **Linux:** `.deb`, `.rpm`, `.AppImage` under their respective subfolders.

Each platform builds only on its native host — Tauri can't cross-compile webview-bound binaries. Use the GitHub Actions release workflow (below) to produce all three from any one machine.

## Release

The repo includes a multi-platform release workflow at `.github/workflows/release.yml`. Pushing a `v*` tag triggers a build for Windows, macOS (Apple Silicon + Intel), and Linux, and creates a draft GitHub Release with the installers attached.

```sh
# Bump version in src-tauri/tauri.conf.json + package.json first.
git tag v0.2.0
git push --tags
```

Then check the [Actions tab](../../actions) — the build takes ~15-25 min across all four runners. When it finishes, the [Releases page](../../releases) has a draft with download links for every platform; edit the release notes and publish.

You can also trigger the workflow manually via the Actions tab → "Release" → "Run workflow" — useful for dry-running the build pipeline without committing a tag.

**A note on signing:** binaries are currently unsigned. Windows SmartScreen and macOS Gatekeeper will flag them as unrecognized; users have to click "More info → Run anyway" (Windows) or right-click → Open → Open (macOS). Code signing requires a paid Authenticode cert ($100-400/yr) on Windows and an Apple Developer account ($99/yr) on macOS. Worth doing once there are users complaining; not worth pre-launch.

## Contributing

This is a personal project. PRs are welcome but reviewed at the maintainer's discretion — no SLA. Fork freely under MIT.

## License

[MIT](LICENSE)
