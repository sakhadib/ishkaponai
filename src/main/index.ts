/**
 * Main process entry point.
 *
 * Loaded dynamically by `src/bootstrap.cjs`, which is CommonJS on purpose: ESM
 * modules load asynchronously, and `app.requestSingleInstanceLock()` and
 * `app.setAppUserModelId()` must run before `ready`. **This file must not
 * re-request the single-instance lock** — the bootstrap already owns it, and a
 * second call in the same process does not mean what the first one meant. This
 * module only handles the consequence of holding the lock: focusing the existing
 * window on a second launch.
 *
 * The wiring here is deliberately thin. Each concern lives in its own module:
 *
 *   `db`            SQLite schema, migrations, statement cache
 *   `sessions`      session / message / tool-call repository
 *   `settings`      validated, versioned settings
 *   `secrets`       safeStorage custody of the OpenRouter key
 *   `openrouter`    key validation and the model catalog
 *   `agent-host`    utilityProcess supervision
 *   `turn-recorder` batched persistence of streamed events
 *   `ipc`           the typed IPC surface
 */
import { app, BrowserWindow, nativeTheme, session as electronSession, shell } from 'electron'
import { join } from 'node:path'
import { buildApplicationMenu } from './menu'
import { flushWindowState } from './store'
import { createMainWindow, getMainWindow, resolveEntryPoints } from './window'
import { AgentHost } from './agent-host'
import { Database } from './db'
import { SecretStore } from './secrets'
import { SettingsStore } from './settings'
import { applyThemeMode, syncWindowBackground } from './theme'
import { broadcastAgentEvent, registerIpcHandlers } from './ipc'
import { reconcileInterruptedMessages } from './sessions'

const isDev = !app.isPackaged

/** File name of the SQLite database inside `app.getPath('userData')`. */
const DATABASE_FILE = 'ishkapon.db'

/**
 * A Content-Security-Policy for the renderer. Applied only in packaged builds
 * because the Vite dev server needs inline scripts and websockets for HMR.
 *
 * No `wasm-unsafe-eval`: Pyodide runs in the agent host, not the renderer
 * (§5.3, §14). `connect-src 'self'` is what stops the renderer from calling
 * OpenRouter itself — all model traffic originates in the agent host.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function applyContentSecurityPolicy(): void {
  if (isDev) return

  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
      }
    })
  })
}

/** Holds the live resources so `before-quit` can release them in order. */
interface Runtime {
  db: Database
  agentHost: AgentHost
}

let runtime: Runtime | null = null

// The bootstrap already took the lock and only imports this module when it won.
app.on('second-instance', () => {
  const existing = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!existing) return

  if (existing.isMinimized()) existing.restore()
  existing.focus()
})

void bootstrap()

async function bootstrap(): Promise<void> {
  app.whenReady().then(onReady).catch((error: unknown) => {
    console.error('[main] failed to start:', error)
    app.quit()
  })

  app.on('window-all-closed', () => {
    // macOS apps stay resident until the user quits explicitly.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // Order matters: the host may still emit events, so it is stopped before the
    // database it writes to is closed.
    runtime?.agentHost.dispose()
    runtime?.db.close()
    void flushWindowState()
  })

  app.on('web-contents-created', (_event, contents) => {
    // Backstop for any web contents that is not the main window: never let one
    // navigate away freely or spawn detached children.
    contents.on('will-navigate', (event) => {
      const url = contents.getURL()
      const devServer = process.env.ELECTRON_RENDERER_URL

      if (devServer && url.startsWith(devServer)) return
      if (url.startsWith('file://')) return

      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    })
  })

  // A crashed GPU process should be surfaced rather than silently swallowed.
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU' && details.reason !== 'clean-exit') {
      console.error(`[main] GPU process gone unexpectedly (${details.reason})`)
    }
  })

  process.on('uncaughtException', (error) => {
    console.error('[main] uncaught exception:', error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandled rejection:', reason)
  })
}

async function onReady(): Promise<void> {
  applyContentSecurityPolicy()
  buildApplicationMenu()

  const db = new Database(join(app.getPath('userData'), DATABASE_FILE))

  // A turn interrupted by a crash or a killed agent host left its assistant row
  // as `streaming`. Close it now, keeping the partial text, so the sidebar and
  // the transcript do not show an answer that is still "arriving" (§13.6).
  const reconciled = reconcileInterruptedMessages(db)
  if (reconciled > 0) {
    console.warn(`[main] reconciled ${reconciled} interrupted message(s) from a previous run.`)
  }

  const settings = new SettingsStore(db)
  const secrets = new SecretStore(db)

  // Set `nativeTheme.themeSource` before any window exists, so the native title
  // bar is correct from the first frame and `system` mode starts tracking the
  // OS immediately (§13.4). The return value is unused here; `openWindow`
  // re-resolves it per window so a window re-created after `activate` picks up
  // a theme changed while it was closed. The call is idempotent.
  applyThemeMode(settings.get().theme)

  const agentHost = new AgentHost(db, {
    secrets,
    settings,
    onEvent: (event) => broadcastAgentEvent(getMainWindow, event)
  })

  runtime = { db, agentHost }

  registerIpcHandlers({ db, settings, secrets, agentHost, getWindow: getMainWindow })

  // In `system` mode the OS can change theme while the app is open. The renderer
  // already follows it via `prefers-color-scheme`; this keeps the native window
  // backdrop in step so a resize does not flash the wrong colour.
  nativeTheme.on('updated', () => syncWindowBackground(getMainWindow()))

  // The agent host is not started eagerly. It is a ~50 MB WebAssembly sandbox,
  // and a student who only opens Settings to paste a key should not pay for it.
  // `AgentHost.ensureRunning` forks it on the first turn and respawns it after an
  // unexpected exit.
  //
  // Read the mode fresh on each launch rather than closing over `theme`, so a
  // window re-created after `activate` picks up a theme the user changed while
  // the window was closed.
  const openWindow = async (): Promise<void> => {
    const mode = settings.get().theme
    await createMainWindow(resolveEntryPoints(), applyThemeMode(mode), mode)
  }

  await openWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openWindow()
    }
  })
}
