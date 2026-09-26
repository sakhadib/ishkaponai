/**
 * The typed IPC surface — one handler per channel in `IpcChannel`, which is
 * exactly the set the preload bridge exposes on `window.ishkapon`. There is no
 * generic `invoke(channel, ...)` escape hatch, so the renderer cannot reach a
 * handler that is not listed here.
 *
 * The renderer is treated as untrusted input even though it is our own code
 * (§12.1: the model is an untrusted component, and the renderer is downstream of
 * it). Every argument is validated before it reaches a repository, and every
 * error returned to the renderer is a message written for the student rather
 * than a raw exception.
 */
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { AgentEventChannel, IpcChannel, SettingsEventChannel } from '@shared/ipc'
import type { CreateSessionOptions, SetApiKeyResult } from '@shared/ipc'
import type {
  AgentEvent,
  AgentSendCommand,
  AppInfo,
  Platform,
  SessionDetail,
  Settings
} from '@shared/types'
import type { AgentHost } from './agent-host'
import type { Database } from './db'
import type { SecretStore } from './secrets'
import type { SettingsStore } from './settings'
import { parseSettingsPatch } from './settings'
import { listModels } from './openrouter'
import {
  appendMessage,
  autoTitleSession,
  createSession,
  deleteSession,
  finalizeMessage,
  getSession,
  getSessionDetail,
  isLanguagePref,
  isSubject,
  listSessions,
  updateSession,
  type SessionPatch
} from './sessions'

/** Upper bound on a student message, to bound history growth and IPC size. */
const MAX_MESSAGE_LENGTH = 32_000

/** Upper bound on a session title. */
const MAX_TITLE_LENGTH = 200

export interface IpcDependencies {
  db: Database
  settings: SettingsStore
  secrets: SecretStore
  agentHost: AgentHost
  /** Resolves the main window, or `null` before it exists. */
  getWindow: () => BrowserWindow | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A thrown, user-facing failure. Its message is safe to display verbatim. */
class UserError extends Error {}

function userError(message: string): UserError {
  return new UserError(message)
}

function readStringArg(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw userError(`${label} must be text.`)
  if (value.length === 0) throw userError(`${label} is required.`)
  if (value.length > maxLength) throw userError(`${label} is too long.`)
  return value
}

/** Session ids come from us, but a 36-char uuid is the only shape we accept. */
function readSessionId(value: unknown): string {
  const id = readStringArg(value, 'Session id', 64)
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw userError('That session id is not valid.')
  return id
}

/**
 * Refuses a call that did not come from the main window. `IshkaponApi` is the
 * renderer's whole surface, and it only ever lives in the main window's
 * webContents, so anything else is a bug or an attempt.
 */
function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  if (event.sender !== window.webContents) {
    throw userError('This request did not come from the ISHKAPON window.')
  }
}

function readCreateSessionOptions(value: unknown): CreateSessionOptions {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw userError('Session options must be an object.')

  const options: CreateSessionOptions = {}

  if (value['modelId'] !== undefined) {
    if (value['modelId'] === null) options.modelId = null
    else if (typeof value['modelId'] === 'string') options.modelId = value['modelId']
    else throw userError('modelId must be a string or null.')
  }

  if (value['preferredLanguage'] !== undefined) {
    if (!isLanguagePref(value['preferredLanguage'])) {
      throw userError('preferredLanguage must be auto, en or bn.')
    }
    options.preferredLanguage = value['preferredLanguage']
  }

  return options
}

function readSessionPatch(value: unknown): SessionPatch {
  if (!isRecord(value)) throw userError('Session patch must be an object.')

  const patch: SessionPatch = {}

  if (value['title'] !== undefined) {
    if (typeof value['title'] !== 'string') throw userError('title must be text.')
    const title = value['title'].replace(/\s+/g, ' ').trim()
    if (title.length === 0) throw userError('The title cannot be empty.')
    patch.title = title.slice(0, MAX_TITLE_LENGTH)
  }

  if (value['pinned'] !== undefined) {
    if (typeof value['pinned'] !== 'boolean') throw userError('pinned must be true or false.')
    patch.pinned = value['pinned']
  }

  if (value['modelId'] !== undefined) {
    if (value['modelId'] !== null && typeof value['modelId'] !== 'string') {
      throw userError('modelId must be a string or null.')
    }
    patch.modelId = value['modelId'] as string | null
  }

  if (value['subject'] !== undefined) {
    if (value['subject'] === null) {
      patch.subject = null
    } else if (isSubject(value['subject'])) {
      patch.subject = value['subject']
    } else {
      throw userError('subject must be physics, chemistry, math, general, or null.')
    }
  }

  if (value['preferredLanguage'] !== undefined) {
    if (!isLanguagePref(value['preferredLanguage'])) {
      throw userError('preferredLanguage must be auto, en or bn.')
    }
    patch.preferredLanguage = value['preferredLanguage']
  }

  return patch
}

const KNOWN_PLATFORMS: readonly Platform[] = [
  'win32',
  'darwin',
  'linux',
  'freebsd',
  'openbsd',
  'sunos'
]

function readAppInfo(): AppInfo {
  const platform = process.platform

  return {
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node,
    // `process.platform` is wider than the contract's subset; anything exotic
    // falls back rather than being smuggled across the bridge.
    platform: (KNOWN_PLATFORMS as readonly string[]).includes(platform)
      ? (platform as Platform)
      : 'linux',
    arch: process.arch,
    locale: app.getLocale()
  }
}

/**
 * Wraps a handler so an internal failure never leaks a stack trace or a file
 * path to the renderer, while a `UserError` keeps its student-facing message.
 */
function guard<TArgs extends unknown[], TResult>(
  label: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
): (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      if (error instanceof UserError) throw new Error(error.message)

      console.error(`[ipc] ${label} failed:`, error)
      throw new Error('Something went wrong. See the main process log.')
    }
  }
}

export function registerIpcHandlers(deps: IpcDependencies): void {
  const { db, settings, secrets, agentHost, getWindow } = deps

  // --- Settings ------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.SettingsGet,
    guard('settings:get', (event) => {
      assertTrustedSender(event, getWindow())
      return settings.get()
    })
  )

  ipcMain.handle(
    IpcChannel.SettingsUpdate,
    guard('settings:update', (event, patch: unknown) => {
      assertTrustedSender(event, getWindow())

      // Validated here as well as inside `SettingsStore`, so a rejection
      // surfaces as a message the student can act on rather than the generic
      // "something went wrong". The store re-validates because it must not trust
      // that its only caller did.
      let validated: Partial<Settings>
      try {
        validated = parseSettingsPatch(patch)
      } catch (error) {
        throw userError(error instanceof Error ? error.message : 'Those settings are not valid.')
      }

      const next = settings.update(validated)

      // The user instructions are system-prompt layer 2 and the timeout drives
      // the sandbox, so the host needs both.
      agentHost.pushSettings()

      // Push rather than relying on the promise: a write made from anywhere
      // (including a future second window) must not leave the UI showing a
      // stale value.
      getWindow()?.webContents.send(SettingsEventChannel, next)

      return next
    })
  )

  // --- Secrets -------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.SecretGetStatus,
    guard('secret:get-status', async (event) => {
      assertTrustedSender(event, getWindow())
      return secrets.getStatus()
    })
  )

  ipcMain.handle(
    IpcChannel.SecretSetApiKey,
    guard('secret:set-api-key', async (event, key: unknown): Promise<SetApiKeyResult> => {
      assertTrustedSender(event, getWindow())

      const result = await secrets.setApiKey(key)
      // Only on success: a rejected key was never stored, so there is nothing
      // new to hand the host.
      if (result.ok) agentHost.syncCredentials()

      return result
    })
  )

  ipcMain.handle(
    IpcChannel.SecretClearApiKey,
    guard('secret:clear-api-key', async (event) => {
      assertTrustedSender(event, getWindow())
      await secrets.clearApiKey()
      // `null` tells the host to refuse further turns.
      agentHost.syncCredentials()
    })
  )

  // --- Models --------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.ModelsList,
    guard('models:list', async (event, forceRefresh: unknown) => {
      assertTrustedSender(event, getWindow())
      return listModels(forceRefresh === true)
    })
  )

  // --- Sessions ------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.SessionList,
    guard('session:list', (event) => {
      assertTrustedSender(event, getWindow())
      return listSessions(db)
    })
  )

  ipcMain.handle(
    IpcChannel.SessionCreate,
    guard('session:create', (event, options: unknown) => {
      assertTrustedSender(event, getWindow())

      const parsed = readCreateSessionOptions(options)
      const current = settings.get()

      return createSession(db, {
        // A session records the model it started on (§6) so reopening it later
        // can explain why its answers differ from a new session's.
        modelId: parsed.modelId !== undefined ? parsed.modelId : current.modelId,
        preferredLanguage: parsed.preferredLanguage ?? current.preferredLanguage
      })
    })
  )

  ipcMain.handle(
    IpcChannel.SessionGet,
    guard('session:get', (event, id: unknown): SessionDetail | null => {
      assertTrustedSender(event, getWindow())
      return getSessionDetail(db, readSessionId(id))
    })
  )

  ipcMain.handle(
    IpcChannel.SessionUpdate,
    guard('session:update', (event, id: unknown, patch: unknown) => {
      assertTrustedSender(event, getWindow())
      return updateSession(db, readSessionId(id), readSessionPatch(patch))
    })
  )

  ipcMain.handle(
    IpcChannel.SessionDelete,
    guard('session:delete', (event, id: unknown) => {
      assertTrustedSender(event, getWindow())
      deleteSession(db, readSessionId(id))
    })
  )

  // --- Chat ----------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.ChatSend,
    guard('chat:send', async (event, sessionId: unknown, text: unknown) => {
      assertTrustedSender(event, getWindow())

      const id = readSessionId(sessionId)
      const message = readStringArg(text, 'Message', MAX_MESSAGE_LENGTH)
      const trimmed = message.trim()
      if (trimmed.length === 0) throw userError('Type a problem first.')

      const session = getSession(db, id)
      if (!session) throw userError('That session no longer exists.')

      if (agentHost.isBusy(id)) throw userError('Wait for the current answer to finish.')

      const current = settings.get()

      // The model is resolved once, here, so a turn cannot start with a model
      // that was never chosen and then fail deep inside the host.
      const modelId = session.modelId ?? current.modelId
      if (!modelId) throw userError('Choose a model in Settings first.')

      // §4.1: the app cannot chat without a key. Checked before any row is
      // written so a refusal leaves no empty transcript.
      const status = await secrets.getStatus()
      if (!status.configured) {
        throw userError('Add your OpenRouter API key in Settings to start solving problems.')
      }

      // The student asked a question; the title should say what it was.
      autoTitleSession(db, id, trimmed)

      const userMessage = appendMessage(db, {
        sessionId: id,
        role: 'user',
        content: trimmed,
        status: 'complete'
      })

      // Written up front so a host crash leaves a reconcilable row rather than a
      // gap in the transcript, and so the renderer can render the answer slot
      // before the first delta arrives.
      const assistantMessage = appendMessage(db, {
        sessionId: id,
        role: 'assistant',
        content: '',
        status: 'streaming'
      })

      const command: AgentSendCommand = {
        kind: 'send',
        sessionId: id,
        messageId: assistantMessage.id,
        text: trimmed,
        // Filled in by the host from SQLite: this session only, bounded by the
        // running summary. Never a hand-off from the caller.
        history: [],
        summary: null,
        modelId,
        maxOutputTokens: current.maxOutputTokens,
        pythonTimeoutMs: current.pythonTimeoutMs,
        preferredLanguage: session.preferredLanguage
      }

      try {
        agentHost.send(command, userMessage.seq)
      } catch (error) {
        // The turn never started, so close the placeholder rather than leaving
        // it `streaming` forever.
        finalizeMessage(db, assistantMessage.id, { status: 'error' })
        throw error instanceof UserError ? error : userError(describeError(error))
      }

      return { messageId: assistantMessage.id }
    })
  )

  ipcMain.handle(
    IpcChannel.ChatStop,
    guard('chat:stop', (event, sessionId: unknown) => {
      assertTrustedSender(event, getWindow())
      const id = readSessionId(sessionId)
      if (getSession(db, id)) agentHost.stop(id)
    })
  )

  // --- App -----------------------------------------------------------------

  ipcMain.handle(
    IpcChannel.AppGetInfo,
    guard('app:get-info', (event) => {
      assertTrustedSender(event, getWindow())
      return readAppInfo()
    })
  )
}

/**
 * Pushes an agent event to the renderer on the single event channel.
 *
 * The payload is forwarded as received — the host's message was already
 * narrowed by `parseAgentToMain` before it got here, so re-validating would be
 * a second copy of the same rules.
 */
export function broadcastAgentEvent(
  getWindow: () => BrowserWindow | null,
  event: AgentEvent
): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) return

  const contents = window.webContents
  if (contents.isDestroyed()) return

  contents.send(AgentEventChannel, event)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The turn could not be started.'
}
