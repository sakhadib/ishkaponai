import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AppInfo, PingResult, Platform } from '@shared/types'

/**
 * Registers every `invoke` handler exposed to the renderer.
 * Handlers are thin: validate input here, keep business logic elsewhere.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.AppGetInfo, (): AppInfo => collectAppInfo())

  ipcMain.handle(IpcChannel.AppPing, (_event, message?: unknown): PingResult => {
    const echo = typeof message === 'string' ? message : 'pong'
    return {
      echo,
      at: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime())
    }
  })

  ipcMain.handle(IpcChannel.WindowSetTitle, (event, title: unknown) => {
    if (typeof title !== 'string') throw new TypeError('title must be a string')

    const window = BrowserWindow.fromWebContents(event.sender)
    // Guard against absurd values pushed over IPC.
    window?.setTitle(title.slice(0, 200))
  })

  ipcMain.handle(IpcChannel.WindowIsMaximized, (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  ipcMain.handle(IpcChannel.WindowToggleMaximize, (event): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false

    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }

    return window.isMaximized()
  })

  ipcMain.handle(IpcChannel.WindowClose, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

export function collectAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron ?? 'n/a',
    chromeVersion: process.versions.chrome ?? 'n/a',
    nodeVersion: process.versions.node,
    platform: process.platform as Platform,
    arch: process.arch,
    locale: app.getLocale()
  }
}

/** Opens a URL in the user's default browser, exposed to the main process only. */
export function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}
