/**
 * The IPC contract. Main, preload and renderer all import these names, so a
 * mismatch is a compile error rather than a runtime surprise.
 */
import type {
  AgentEvent,
  AppInfo,
  ModelCatalogResult,
  SecretStatus,
  Session,
  SessionDetail,
  Settings,
  UsageReport
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
  // Usage ledger
  UsageGet: 'usage:get',
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

/** Main -> renderer push channel for settings changes. */
export const SettingsEventChannel = 'settings:changed'

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
  /** The tool-capable catalog, plus a notice if something was substituted. */
  listModels(forceRefresh?: boolean): Promise<ModelCatalogResult>

  /**
   * All-time token spend plus the today/week/month/year breakdown.
   *
   * Read from the usage ledger rather than from `messages`, so deleting a chat
   * does not change the answer.
   */
  getUsage(): Promise<UsageReport>

  // --- Sessions ---
  listSessions(): Promise<Session[]>
  createSession(options?: CreateSessionOptions): Promise<Session>
  getSession(id: string): Promise<SessionDetail | null>
  updateSession(id: string, patch: Partial<Session>): Promise<Session>
  deleteSession(id: string): Promise<void>

  // --- Chat ---
  /**
   * Starts a turn. The returned `messageId` is the **assistant** message being
   * produced — the same id that `turn.started` and subsequent deltas carry.
   */
  sendMessage(sessionId: string, text: string): Promise<{ messageId: string }>
  stopTurn(sessionId: string): Promise<void>

  // --- Events ---
  /** Subscribe to agent events. Returns an unsubscribe function. */
  onAgentEvent(handler: (event: AgentEvent) => void): () => void
  /**
   * Subscribe to settings changes. Main pushes on every write, including writes
   * made outside the renderer, so the UI never shows a stale theme or model.
   */
  onSettingsChanged(handler: (settings: Settings) => void): () => void

  // --- App ---
  getAppInfo(): Promise<AppInfo>
}
