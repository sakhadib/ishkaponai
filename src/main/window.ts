import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { WINDOW_BOUNDS, saveWindowState, loadWindowState } from './store'
import { WINDOW_BACKGROUND } from './theme'

const isDev = !app.isPackaged

export interface WindowEntryPoints {
  /** Dev server URL, present only when launched via `electron-vite dev`. */
  url: string | undefined
  /** Compiled renderer HTML, used in production builds. */
  file: string
}

export function resolveEntryPoints(): WindowEntryPoints {
  return {
    url: process.env.ELECTRON_RENDERER_URL,
    file: join(import.meta.dirname, '../renderer/index.html')
  }
}

/**
 * The one main window. Tracked so IPC handlers can refuse a request that did not
 * come from it, and so agent events have a single destination.
 */
let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export async function createMainWindow(entry: WindowEntryPoints): Promise<BrowserWindow> {
  const state = await loadWindowState()

  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: WINDOW_BOUNDS.MIN_WIDTH,
    minHeight: WINDOW_BOUNDS.MIN_HEIGHT,
    show: false,
    // Matches the renderer's `--bg`, so the frame drawn before the stylesheet
    // lands is the same colour as the page rather than a white flash.
    backgroundColor: WINDOW_BACKGROUND,
    title: 'ISHKAPON AI',
    autoHideMenuBar: true,
    webPreferences: {
      // Emitted as CommonJS with an explicit `.cjs` extension: sandboxed
      // preload scripts cannot use ESM imports.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // Renderer runs sandboxed with no direct Node access; the preload
      // bridge is the only surface it can reach.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow = window

  if (state.maximized) window.maximize()

  // Only reveal the window once the renderer has painted, to avoid a flash.
  window.once('ready-to-show', () => window.show())

  window.webContents.once('did-finish-load', () => {
    if (isDev && !entry.url) return
    if (isDev) window.webContents.openDevTools({ mode: 'detach' })
  })

  hardenNavigation(window)
  trackBounds(window)

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (entry.url) {
    void window.loadURL(entry.url)
  } else {
    void window.loadFile(entry.file)
  }

  return window
}

/**
 * Blocks in-app navigation and popups. External links open in the user's
 * default browser instead of spawning a new Electron window.
 */
function hardenNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return

    const devServer = process.env.ELECTRON_RENDERER_URL
    const isDevServerNavigation = Boolean(devServer) && url.startsWith(devServer as string)

    if (isDevServerNavigation) return

    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

/**
 * Persists window size and position so the app reopens where the user left
 * it. Tracks the "normal" (un-maximized) bounds so un-maximizing restores a
 * sensible size.
 */
function trackBounds(window: BrowserWindow): void {
  let normal: { width: number; height: number; x: number; y: number } | null = null

  const capture = (): void => {
    if (window.isDestroyed() || window.isFullScreen()) return

    const maximized = window.isMaximized()

    if (maximized) {
      // Preserve the pre-maximize geometry instead of the screen-filling bounds.
      if (normal) saveWindowState({ ...normal, maximized: true })
      return
    }

    normal = window.getNormalBounds()
    saveWindowState({ ...normal, maximized: false })
  }

  window.on('resize', capture)
  window.on('move', capture)
  window.on('maximize', capture)
  window.on('unmaximize', capture)
  window.on('close', capture)
}
