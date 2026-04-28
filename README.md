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

Produces a native installer for the host OS in `src-tauri/target/release/bundle/`.

## Contributing

This is a personal project. PRs are welcome but reviewed at the maintainer's discretion — no SLA. Fork freely under MIT.

## License

[MIT](LICENSE)
