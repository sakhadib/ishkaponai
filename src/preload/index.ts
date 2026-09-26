import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AppInfo, IshkaponApi, PingResult, Platform } from '@shared/types'

/**
 * The only bridge between the sandboxed renderer and the main process.
 * Everything exposed here is an explicit, typed function; no raw `ipcRenderer`
 * and no Node primitives ever reach the page.
 */
const platform = process.platform as Platform

const api: IshkaponApi = {
  platform,
  isMac: platform === 'darwin',
  isWindows: platform === 'win32',
  isLinux: platform === 'linux',

  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppGetInfo),
  ping: (message?: string): Promise<PingResult> => ipcRenderer.invoke(IpcChannel.AppPing, message),
  setWindowTitle: (title: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.WindowSetTitle, title),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.WindowIsMaximized),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.WindowToggleMaximize),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IpcChannel.WindowClose)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('ishkapon', api)
} else {
  // contextIsolation is enforced in the BrowserWindow config; this branch only
  // exists so a misconfiguration fails loudly during development.
  ;(globalThis as unknown as { ishkapon: IshkaponApi }).ishkapon = api
}
