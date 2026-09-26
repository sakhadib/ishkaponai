# ISHKAPON AI

Cross-platform desktop application built on Electron, React and TypeScript.

Packaging targets **Windows** (NSIS installer + portable zip), **macOS** (DMG +
zip, universal-friendly x64/arm64) and **Linux** (AppImage, deb, rpm) via
`electron-builder`.

## Requirements

- Node.js **>= 20.19** (developed against 24.x)
- npm 10+

> If you are on Windows PowerShell and npm is blocked by your execution policy,
> use `npm.cmd` instead of `npm` (or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).

## Getting started

```bash
npm install     # install dependencies
npm run dev     # start the app with hot reload
```

`npm run dev` starts the Vite dev server for the renderer, compiles the main and
preload processes, and launches Electron pointed at the dev server.

## Scripts

| Script               | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `npm run dev`        | Development mode with renderer HMR                       |
| `npm run start`      | Preview the production build without packaging           |
| `npm run build`      | Typecheck, then compile main/preload/renderer to `out/`  |
| `npm run typecheck`  | Typecheck both TS projects                               |
| `npm run build:win`  | Windows NSIS installer + portable zip                    |
| `npm run build:mac`  | macOS DMG + zip (requires macOS or `electron-builder` CI) |
| `npm run build:linux`| AppImage + deb + rpm                                     |
| `npm run build:unpack` | Package without producing installers (fast smoke test) |
| `npm run icons`      | Regenerate the placeholder `build/icon.png`              |
| `npm run clean`      | Delete `out/` and `release/`                             |

Cross-compilation caveats: building **macOS** artifacts requires macOS (or a
macOS runner), and **deb/rpm** require the respective Linux tooling. Windows
targets build natively on Windows.

## Project structure

```
├── electron.vite.config.ts   # Build config for main / preload / renderer
├── electron-builder.yml      # Packaging + per-platform installer config
├── tsconfig.base.json        # Shared strict compiler options
├── tsconfig.node.json        # main + preload + shared (Node types)
├── tsconfig.web.json         # renderer + shared (DOM types)
├── build/                    # Icons and macOS entitlements
├── scripts/                  # Utility scripts (icon generation)
└── src/
    ├── main/                 # Main process: windows, menu, IPC, state
    │   ├── index.ts          #   Lifecycle, single-instance lock, CSP
    │   ├── window.ts         #   Window creation, navigation hardening
    │   ├── ipc.ts            #   Typed ipcMain handlers
    │   ├── menu.ts           #   Cross-platform application menu
    │   └── store.ts          #   Persisted window bounds
    ├── preload/index.ts      # contextBridge API (the only renderer surface)
    ├── renderer/             # React UI
    │   ├── index.html
    │   └── src/
    │       ├── App.tsx
    │       ├── components/
    │       └── styles.css
    └── shared/               # Types + IPC channel names used by all processes
```

## Architecture notes

**Process model.** Three separate bundles are produced: `out/main`, `out/preload`
and `out/renderer`. Only the main process has Node access.

**Security posture.** The renderer runs with `contextIsolation: true`,
`nodeIntegration: false` and `sandbox: true`. The renderer therefore cannot touch
`ipcRenderer` or any Node primitive — it can only call the typed functions
exposed on `window.ishkapon` by the preload script. New capabilities should be
added deliberately in `src/preload/index.ts` and typed in
`src/shared/types.ts`; never widen `nodeIntegration` or disable
`contextIsolation` to work around a missing bridge method.

Additional hardening already in place:

- In-app navigation and popups are blocked; `http(s)` links open in the system browser.
- A strict `Content-Security-Policy` is applied to packaged builds only (the dev
  server needs inline scripts and websockets for HMR).
- A single-instance lock is requested, and a second launch focuses the existing window.

**Shared types.** `src/shared/types.ts` must stay free of Node and DOM imports
so it can be bundled into every process target.

**Renderer minification.** `electron-vite` leaves the renderer unminified by
default; this project opts in via `build.minify` in `electron.vite.config.ts`.
The main and preload bundles are intentionally left unminified for readable
stack traces.

**Dependencies.** React is a `devDependency` on purpose: Vite bundles it into
the renderer output, so shipping it again inside `app.asar` would only bloat
the package. If you add a dependency that is genuinely required at runtime by
the main process, put it in `dependencies` so it gets included.

## Icons

`build/icon.png` is a generated placeholder. Replace it with real artwork at
**1024x1024** and `electron-builder` will derive `icon.ico` and `icon.icns`
automatically. Regenerate the placeholder at any time with `npm run icons`.

## License

MIT
