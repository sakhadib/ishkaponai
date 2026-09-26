import { contextBridge, ipcRenderer } from 'electron'
import { AgentEventChannel, IpcChannel, SettingsEventChannel } from '@shared/ipc'
import type { CreateSessionOptions, IshkaponApi, SetApiKeyResult } from '@shared/ipc'
import type {
  AgentEvent,
  AppInfo,
  ModelInfo,
  SecretStatus,
  Session,
  SessionDetail,
  Settings
} from '@shared/types'

/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Emitted as CommonJS (`.cjs`) because sandboxed preload scripts cannot use ESM
 * imports. Everything the renderer can reach is enumerated in `IshkaponApi` —
 * there is no generic `invoke(channel, ...)` escape hatch, so a compromised
 * renderer cannot reach a channel that is not on this list.
 */

const api: IshkaponApi = {
  platform: process.platform as AppInfo['platform'],

  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IpcChannel.SettingsGet),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IpcChannel.SettingsUpdate, patch),

  getSecretStatus: (): Promise<SecretStatus> => ipcRenderer.invoke(IpcChannel.SecretGetStatus),
  setApiKey: (key: string): Promise<SetApiKeyResult> =>
    ipcRenderer.invoke(IpcChannel.SecretSetApiKey, key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke(IpcChannel.SecretClearApiKey),

  listModels: (forceRefresh?: boolean): Promise<ModelInfo[]> =>
    ipcRenderer.invoke(IpcChannel.ModelsList, forceRefresh === true),

  listSessions: (): Promise<Session[]> => ipcRenderer.invoke(IpcChannel.SessionList),
  createSession: (options?: CreateSessionOptions): Promise<Session> =>
    ipcRenderer.invoke(IpcChannel.SessionCreate, options ?? {}),
  getSession: (id: string): Promise<SessionDetail | null> =>
    ipcRenderer.invoke(IpcChannel.SessionGet, id),
  updateSession: (id: string, patch: Partial<Session>): Promise<Session> =>
    ipcRenderer.invoke(IpcChannel.SessionUpdate, id, patch),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannel.SessionDelete, id),

  sendMessage: (sessionId: string, text: string): Promise<{ messageId: string }> =>
    ipcRenderer.invoke(IpcChannel.ChatSend, sessionId, text),
  stopTurn: (sessionId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.ChatStop, sessionId),

  onAgentEvent: (handler: (event: AgentEvent) => void): (() => void) => {
    // The raw IpcRendererEvent is intentionally not forwarded: it would leak an
    // object with a `sender` reference into the renderer world.
    const listener = (_event: unknown, payload: AgentEvent): void => handler(payload)
    ipcRenderer.on(AgentEventChannel, listener)
    return () => {
      ipcRenderer.removeListener(AgentEventChannel, listener)
    }
  },

  onSettingsChanged: (handler: (settings: Settings) => void): (() => void) => {
    const listener = (_event: unknown, payload: Settings): void => handler(payload)
    ipcRenderer.on(SettingsEventChannel, listener)
    return () => {
      ipcRenderer.removeListener(SettingsEventChannel, listener)
    }
  },

  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppGetInfo)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('ishkapon', api)
} else {
  // contextIsolation is enforced in the BrowserWindow config. This branch
  // exists so a misconfiguration fails loudly during development.
  ;(globalThis as unknown as { ishkapon: IshkaponApi }).ishkapon = api
}
