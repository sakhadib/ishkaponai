# ISHKAPON AI

Cross-platform desktop application built on Electron, React and TypeScript.

Packaging targets **Windows** (an MSI installer), **macOS** (DMG + zip) and **Linux**
(AppImage, deb, rpm) via `electron-builder`.

The Windows build is an MSI rather than an NSIS installer on purpose: it installs
per-user with no administrator prompt, puts a shortcut in the Start menu and on the
desktop, and registers itself in Windows so it can be removed from
*Settings → Apps → Installed apps* like any other program. See
[Windows installation](#windows-installation) for what to expect when a student runs
it, including the publisher warning.

## Requirements

- Node.js **>= 22** (developed and built against 24.x). `package.json` enforces the
  same floor in `engines`, and the two are meant to agree — the earlier `>= 20.19`
  here was left over from a Vite minimum and was never verified on this project.
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

### Development keeps its own data folder

`npm run dev` and an installed copy of the app write to **different directories**:

| Build | Windows folder |
| ----- | -------------- |
| Installed (MSI) | `%APPDATA%\ISHKAPON-AI\` |
| `npm run dev` | `%APPDATA%\ishkapon-ai-dev\` |

This is not a preference, it is a correction. Electron derives `userData` from the
app name, and the two builds disagreed about it: `electron-builder` ships
`productName: "ISHKAPON AI"` as the name `ISHKAPON-AI`, while the repo says
`ishkapon-ai`. Those differ only in case, so on NTFS and on a default-formatted Mac
volume they are the *same folder* — one SQLite database, one encrypted API key, one
usage ledger, shared between a developer's machine and a student's install.

The symptom was an API key and chat history appearing in a freshly installed copy.
The giveaway was that the key still *worked*: Windows DPAPI is scoped to the user
account rather than to the app, so either build can decrypt what the other wrote.

`src/bootstrap.cjs` redirects `userData` for unpackaged runs, before the
single-instance lock is requested — the lock file lives under `userData`, so
redirecting afterwards would separate the databases but leave both builds
contending for one lock. **The installed path is deliberately not touched**, so
updating the app never moves anyone's chats. `src/main/dev/userdata-check.ts` holds
this in place.

## Scripts

| Script               | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `npm run dev`        | Development mode with renderer HMR                       |
| `npm run start`      | Preview the production build without packaging           |
| `npm run build`      | Typecheck, then compile main/preload/renderer to `out/`  |
| `npm run typecheck`  | Typecheck all three TS projects (node, preload, web)   |
| `npm run build:win`  | Windows MSI installer (x64 + arm64)               |
| `npm run build:mac`  | macOS DMG + zip (requires macOS or `electron-builder` CI) |
| `npm run build:linux`| AppImage + deb + rpm                                     |
| `npm run build:unpack` | Package without producing installers (fast smoke test) |
| `npm run icons`      | Regenerate the placeholder `build/icon.png`              |
| `npm run clean`      | Delete `out/` and `release/`                             |

Cross-compilation caveats: building **macOS** artifacts requires macOS (or a
macOS runner), and **deb/rpm** require the respective Linux tooling. The Windows
MSI builds natively on Windows and needs no extra tooling — `electron-builder`
fetches WiX itself on first run.

## Windows installation

`npm run build:win` writes two files to `release/`:

```
ISHKAPON AI-0.1.0-x64-setup.msi      ~143 MB
ISHKAPON AI-0.1.0-arm64-setup.msi    ~138 MB
```

A student double-clicks the one matching their machine and gets:

- an install dialog with a folder to choose and an **Install** button
- **no administrator prompt** — it installs per-user, into their own profile
- a Start menu shortcut and a desktop shortcut, both named `ISHKAPON AI`
- an entry under *Settings → Apps → Installed apps* with a working **Uninstall**
  and **Repair**. *Change* is hidden by `electron-builder`'s MSI template, and
  there is nothing in the app to change, so it would only be a button that opens
  a dialog offering no options.

Running a newer version over an older one replaces it rather than installing
alongside. That works because `upgradeCode` is pinned in `electron-builder.yml`:
Windows Installer uses it to recognise "this is the same product, newer version".
It must never be regenerated, or every installed copy becomes orphaned beside a
second copy with no upgrade path between them.

### The publisher warning

**The MSI is not code-signed.** There is no certificate in this repository and none
configured, so on install Windows will say the publisher is **Unknown** and
SmartScreen may show *"Windows protected your PC"*. The student clicks
**More info → Run anyway**. This is normal for an unsigned installer and it is not a
malware warning, but it is a poor first impression and it is fixable: a code-signing
certificate (`CSC_LINK`, or the `sign` section of `electron-builder.yml`) makes the
publisher name appear and removes the SmartScreen block. Until then, expect to
explain this to anyone installing it.

Chats are **not** deleted by uninstalling. The database lives in the user profile
where Windows leaves it alone; see [PRIVACY.md](PRIVACY.md) for where it is and how
to remove it deliberately.

## Project structure

```
├── electron.vite.config.ts   # Build config for main / preload / renderer
├── electron-builder.yml      # Packaging + per-platform installer config
├── tsconfig.base.json        # Shared strict compiler options
├── tsconfig.node.json        # main + preload + shared (Node types)
├── tsconfig.preload.json     # preload alone (contextBridge surface)
├── tsconfig.web.json         # renderer + shared (DOM types)
├── build/                    # Icons and macOS entitlements
├── scripts/                  # Build-time utilities (icon generation)
├── tools/                    # Dev checks run by hand (contrast, etc.)
├── docs/                     # Design notes
├── out/                      # Compiled bundles (gitignored)
└── src/
    ├── main/                 # Main process: windows, menu, IPC, state
    │   ├── index.ts          #   Lifecycle, single-instance lock, CSP
    │   ├── window.ts         #   Window creation, navigation hardening
    │   ├── ipc.ts            #   Typed ipcMain handlers
    │   ├── menu.ts           #   Cross-platform application menu
    │   ├── db.ts             #   SQLite schema and migrations
    │   ├── sessions.ts       #   Chat and message persistence
    │   ├── settings.ts       #   Validated settings, secrets split out
    │   ├── secrets.ts        #   API key via Electron safeStorage
    │   ├── usage.ts          #   Token ledger, independent of transcripts
    │   ├── agent-host.ts     #   Supervises the agent child process
    │   └── dev/              #   Main-process checks (core, db, context, userdata)
    ├── agent/                # Runs as a child process. Owns the turn loop
    │   ├── host.ts           #   The loop: stream, tool calls, step limit
    │   ├── tools.ts          #   The single `python` tool
    │   ├── sandbox.ts        #   Pyodide: local wheels, hardened, no network
    │   ├── wheels.ts         #   Where calculation packages come from
    │   ├── prompt.ts         #   System prompt layers
    │   ├── provider.ts       #   The one place the network is touched
    │   ├── explain.ts        #   Turn errors turned into plain sentences
    │   └── dev/              #   Fetch-wheels build step + sandbox self-check
    ├── preload/index.ts      # contextBridge API (the only renderer surface)
    ├── renderer/             # React UI
    │   ├── index.html
    │   ├── dev/              #   Renderer checks
    │   └── src/
    │       ├── App.tsx
    │       ├── components/   #   Shared: Icon, CodeBlock, MermaidBlock
    │       ├── features/     #   chat, sessions, settings (one pane per task)
    │       ├── store/        #   zustand: session, turn, settings, ui
    │       ├── lib/          #   markdown + math + mermaid pipeline
    │       └── styles.css
    └── shared/               # Types + IPC channel names used by all processes
```

The three `dev/` folders hold checks that are **not** wired into `npm test` and are
run by hand. Each is bundled with esbuild and executed with `node`; none of them
needs a test framework. `tools/contrast.mjs` measures text-against-background
contrast ratios for the theme tokens — contrast in this project is measured, never
eyeballed.

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

MIT — see [LICENSE](LICENSE).

Two documents sit alongside it and are part of shipping this:

| Document | What it covers |
| -------- | -------------- |
| [PRIVACY.md](PRIVACY.md) | What leaves the device (OpenRouter, and only OpenRouter), what stays, how the API key is stored, and how to delete it |
| [TERMS.md](TERMS.md) | Acceptable use, your API key and any charges, and an honest statement of what the software does not promise |

The privacy document is worth reading before release even if you wrote the code: the
`studentName` and `studentAge` fields in Settings are injected into the system
prompt, so they are **transmitted to OpenRouter with every question** if a student
fills them in. That is a design decision, not an oversight, and it is the one thing
in the data flow most likely to surprise someone.
