/**
 * The IPC contract. Main, preload and renderer all import these names, so a
 * mismatch is a compile error rather than a runtime surprise.
 */
import type {
  AgentEvent,
  AppInfo,
  ModelInfo,
  SecretStatus,
  Session,
  SessionDetail,
  Settings
} from './types'

/** `invoke`/`handle` channel names. */
export const IpcChannel = {
  // Settings
  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  // Secrets
  SecretGetStatus: 'secret:get-status',
  SecretSetApiKey: 'secret:set-api-key',
  SecretClearApiKey: 'secret:clear-api-key',
  // Model catalog
  ModelsList: 'models:list',
  // Sessions
  SessionList: 'session:list',
  SessionCreate: 'session:create',
  SessionGet: 'session:get',
  SessionUpdate: 'session:update',
  SessionDelete: 'session:delete',
  // Chat
  ChatSend: 'chat:send',
  ChatStop: 'chat:stop',
  // App
  AppGetInfo: 'app:get-info'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

/** Main -> renderer push channel for agent events. */
export const AgentEventChannel = 'agent:event'

export interface CreateSessionOptions {
  modelId?: string | null
  preferredLanguage?: Session['preferredLanguage']
}

export interface SetApiKeyResult {
  ok: boolean
  /** Present when `ok` is false. Safe to display to the user. */
  error?: string
}

/**
 * The complete API surface exposed on `window.ishkapon` by the preload script.
 *
 * This is the renderer's entire privileged surface. There is no filesystem
 * access, no direct network access, and no generic `invoke(channel, ...)`
 * escape hatch, and no way to invoke the calculation tool without going through
 * a chat turn.
 */
export interface IshkaponApi {
  readonly platform: AppInfo['platform']

  // --- Settings ---
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>

  // --- Secrets ---
  getSecretStatus(): Promise<SecretStatus>
  setApiKey(key: string): Promise<SetApiKeyResult>
  clearApiKey(): Promise<void>

  // --- Models ---
  listModels(forceRefresh?: boolean): Promise<ModelInfo[]>

  // --- Sessions ---
  listSessions(): Promise<Session[]>
  createSession(options?: CreateSessionOptions): Promise<Session>
  getSession(id: string): Promise<SessionDetail | null>
  updateSession(id: string, patch: Partial<Session>): Promise<Session>
  deleteSession(id: string): Promise<void>

  // --- Chat ---
  sendMessage(sessionId: string, text: string): Promise<{ messageId: string }>
  stopTurn(sessionId: string): Promise<void>

  // --- Events ---
  /** Subscribe to agent events. Returns an unsubscribe function. */
  onAgentEvent(handler: (event: AgentEvent) => void): () => void

  // --- App ---
  getAppInfo(): Promise<AppInfo>
}
