import { app, BrowserWindow, session, shell } from 'electron'
import { registerIpcHandlers } from './ipc'
import { buildApplicationMenu } from './menu'
import { flushWindowState } from './store'
import { createMainWindow, resolveEntryPoints } from './window'

const isDev = !app.isPackaged

/**
 * A Content-Security-Policy for the renderer. Applied only in packaged builds
 * because the Vite dev server needs inline scripts and websockets for HMR.
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

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
      }
    })
  })
}

/** Refuses any single-instance launch beyond the first. */
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return

    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // Electron's default menu is replaced once the app is ready so that macOS
  // receives the leading app menu.
  app.whenReady().then(async () => {
    applyContentSecurityPolicy()
    buildApplicationMenu()
    registerIpcHandlers()

    await createMainWindow(resolveEntryPoints())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(resolveEntryPoints())
      }
    })
  })

  app.on('window-all-closed', () => {
    // macOS apps stay resident until the user quits explicitly.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void flushWindowState()
  })

  app.on('web-contents-created', (_event, contents) => {
    // Never let web contents spawn detached children or navigate away freely.
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
