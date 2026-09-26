/**
 * Supervision of the agent host (Electron `utilityProcess`).
 *
 * The host owns everything untrusted or crash-prone: the AI SDK tool loop, the
 * OpenRouter connection, and the Pyodide sandbox that executes model-directed
 * code. Keeping it in a separate process means a crash during a computation
 * cannot take down window management — the worst realistic outcome of a fully
 * hijacked agent is a wrong answer (§8), not a lost app.
 *
 * This module is the only half of the app that knows the host's wire protocol.
 * It:
 *   - forks `out/main/agent.js`, respawning lazily after an unexpected exit;
 *   - hands over the API key with `AgentInitCommand`, and again whenever the
 *     key changes;
 *   - queues commands issued before the child has spawned, so `send` never
 *     races process startup;
 *   - forwards every `AgentEvent` to the renderer and hands it to the
 *     `TurnRecorder` for persistence;
 *   - enforces one in-flight turn per session. A session is the unit of context
 *     (§10.2), so two concurrent turns on one session would interleave into a
 *     transcript nobody asked for.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentSendCommand,
  AgentSettingsCommand,
  AgentStopCommand,
  AgentToMain
} from '@shared/types'
import type { Database } from './db'
import type { SecretStore } from './secrets'
import type { SettingsStore } from './settings'
import { TurnRecorder } from './turn-recorder'
import { buildTurnHistory, getSession } from './sessions'

/** Path of the agent bundle, emitted next to `index.js` by electron-vite. */
const AGENT_ENTRY = 'agent.js'

/** Message shown to the renderer when the host cannot be kept alive. */
const HOST_LOST_MESSAGE = 'The calculation engine stopped unexpectedly. Please try again.'

export interface AgentHostOptions {
  secrets: SecretStore
  settings: SettingsStore
  /** Called for every event the host produces, before it is persisted. */
  onEvent: (event: AgentEvent) => void
}

export class AgentHost {
  private child: UtilityProcess | null = null

  private spawned = false

  private disposed = false

  private readonly recorder: TurnRecorder

  /** sessionId -> the assistant message currently being produced. */
  private readonly activeTurns = new Map<string, string>()

  /** Turns issued before the child spawned, drained once it is ready. */
  private readonly outbox: AgentSendCommand[] = []

  constructor(
    private readonly db: Database,
    private readonly options: AgentHostOptions
  ) {
    this.recorder = new TurnRecorder(db)
  }

  isBusy(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  /**
   * Starts a turn. The IPC layer writes both message rows *before* calling this,
   * so a crash between the two leaves a visible, reconcilable state rather than
   * a missing answer.
   *
   * @param newMessageSeq `seq` of the user message being sent. It bounds the
   *   history window from above, so the message itself is never duplicated into
   *   the replay.
   */
  send(command: AgentSendCommand, newMessageSeq: number): void {
    if (this.disposed) throw new Error('ISHKAPON is shutting down.')
    if (this.activeTurns.has(command.sessionId)) {
      throw new Error('A turn is already running for this session.')
    }

    const session = getSession(this.db, command.sessionId)
    if (!session) throw new Error('Session not found.')

    this.activeTurns.set(command.sessionId, command.messageId)

    // Bounded on both sides: below by whatever the running summary already
    // covers (§10.3), above by the message about to be sent. No other session is
    // ever read (§10.2).
    const history = buildTurnHistory(this.db, command.sessionId, {
      afterSeq: session.summaryUpToSeq,
      beforeSeq: newMessageSeq
    })

    const payload: AgentSendCommand = { ...command, history, summary: session.summary }

    if (!this.ensureRunning()) {
      this.activeTurns.delete(command.sessionId)
      throw new Error(HOST_LOST_MESSAGE)
    }

    this.post(payload)
  }

  /** Asks the host to abort a turn and any running computation. */
  stop(sessionId: string): void {
    if (!this.spawned) return
    this.post({ kind: 'stop', sessionId })
  }

  /**
   * Re-sends the API key after it changed. Called by the IPC layer on set and
   * clear. A `null` key tells the host to refuse to start turns.
   */
  syncCredentials(): void {
    void this.pushInit()
  }

  /** Pushes current settings. Layer 2 of the system prompt lives here. */
  pushSettings(): void {
    if (!this.spawned) return
    this.post({ kind: 'settings', settings: this.options.settings.get() })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.recorder.dispose()
    this.outbox.length = 0
    this.activeTurns.clear()
    this.child?.kill()
    this.child = null
    this.spawned = false
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  private ensureRunning(): boolean {
    if (this.disposed) return false
    if (this.child) return true

    const entry = join(import.meta.dirname, AGENT_ENTRY)

    const child = utilityProcess.fork(entry, [], {
      serviceName: 'ishkapon-agent',
      // The host's stdout/stderr belong in the main process's console: Pyodide
      // load failures and provider errors are only diagnosable from there.
      stdio: 'inherit',
      // On macOS the host runs model-directed code and makes its own network
      // requests. Disclaiming makes the OS treat it as a separate entity for
      // TCC purposes, so a permission prompt it triggers is not attributed to
      // ISHKAPON.
      ...(process.platform === 'darwin' ? { disclaim: true } : {})
    })

    this.child = child

    child.on('spawn', () => {
      this.spawned = true
      void this.onSpawned(child)
    })

    child.on('message', (message: unknown) => this.onMessage(message))

    child.on('exit', (code: number) => this.onExit(code))

    child.on('error', (type, location) => {
      // A fatal V8 error in the host. The `exit` event follows.
      console.error(`[agent-host] fatal ${type} in the agent host at ${location}`)
    })

    return true
  }

  private async onSpawned(child: UtilityProcess): Promise<void> {
    // Decrypting the key is async, so it has to complete before the first turn
    // is released — otherwise the host would start a turn with no credentials.
    await this.pushInit()

    // The host may have exited while the keychain call was in flight.
    if (this.child !== child || this.disposed) return

    this.pushSettings()

    const queued = this.outbox.splice(0, this.outbox.length)
    for (const command of queued) this.post(command)
  }

  private onExit(code: number): void {
    this.spawned = false
    this.child = null
    this.outbox.length = 0

    if (this.disposed) return

    // The host died with turns in flight. Persist what was buffered so the
    // partial answer survives, and close the rows rather than leaving them
    // `streaming` for the next launch to reconcile.
    this.recorder.flush()
    this.failActiveTurns(HOST_LOST_MESSAGE, 'error')

    console.error(
      `[agent-host] the agent host exited unexpectedly (code ${code}); it will be respawned on the next turn.`
    )
  }

  // -------------------------------------------------------------------------
  // Wire protocol
  // -------------------------------------------------------------------------

  private post(command: AgentSendCommand | AgentStopCommand | AgentSettingsCommand): void {
    const child = this.child
    if (!child) return

    if (!this.spawned) {
      // Only turns are worth replaying after a respawn; credentials and settings
      // are re-pushed on `spawn` anyway.
      if (command.kind === 'send') this.outbox.push(command)
      return
    }

    child.postMessage(command)
  }

  /**
   * Decrypts the key and hands it to the host, then lets the plaintext go.
   * `SecretStore.withApiKey` is the only path by which the plaintext leaves
   * that module, and the value is posted straight into `AgentInitCommand` —
   * never stored, never logged, never sent to the renderer.
   */
  private pushInit(): Promise<boolean> {
    const child = this.child
    if (!child) return Promise.resolve(false)

    return this.options.secrets.withApiKey(async (apiKey) => {
      // Re-check: the host may have exited while the key was being decrypted.
      if (this.child !== child) return
      child.postMessage({ kind: 'init', apiKey })
    })
  }

  private onMessage(raw: unknown): void {
    const message = parseAgentToMain(raw)
    if (!message) {
      console.error('[agent-host] discarded an unrecognised message from the agent host.')
      return
    }

    if (message.type === 'host.ready') {
      // Credentials and settings were pushed on `spawn`, before `host.ready` can
      // arrive. Nothing further to do.
      return
    }

    if (message.type === 'host.error') {
      console.error(`[agent-host] ${message.message}`)
      this.failActiveTurns(message.message, 'error')
      return
    }

    // Forward before persisting: the renderer's view of the turn is the most
    // latency-sensitive part of the pipeline, and SQLite writes are synchronous.
    this.options.onEvent(message)
    this.recorder.record(message)

    if (message.type === 'turn.finished' || message.type === 'turn.error') {
      this.activeTurns.delete(message.sessionId)
    }
  }

  /**
   * Ends every in-flight turn: the message rows are closed on disk and the
   * renderer is told, rather than being left with a spinner that never resolves.
   */
  private failActiveTurns(reason: string, status: 'error' | 'cancelled'): void {
    const turns = [...this.activeTurns.entries()]
    this.activeTurns.clear()

    for (const [sessionId, messageId] of turns) {
      if (messageId.length > 0) this.recorder.failStreamingMessage(messageId, status)
      this.options.onEvent({ type: 'turn.error', sessionId, messageId, message: reason, fatal: true })
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound message validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readStringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

const TOOL_STATUSES = ['running', 'complete', 'error', 'timeout', 'cancelled'] as const

type ToolStatus = (typeof TOOL_STATUSES)[number]

function parseToolStatus(value: unknown): ToolStatus {
  return (TOOL_STATUSES as readonly string[]).includes(value as string)
    ? (value as ToolStatus)
    : 'error'
}

/**
 * Narrows an arbitrary value from `utilityProcess` into the `AgentToMain` union.
 *
 * The host is a separate, model-adjacent process, so its output is treated as
 * untrusted data here. Anything that does not match the contract is dropped
 * rather than forwarded: a malformed event must never reach the renderer or the
 * database.
 */
export function parseAgentToMain(raw: unknown): AgentToMain | null {
  if (!isRecord(raw)) return null

  const type = raw['type']

  if (type === 'host.ready') return { type: 'host.ready' }

  if (type === 'host.error') {
    return { type: 'host.error', message: readStringOr(raw['message'], 'Unknown agent host error.') }
  }

  const sessionId = readString(raw['sessionId'])
  if (sessionId === null) return null

  switch (type) {
    case 'turn.started': {
      const messageId = readString(raw['messageId'])
      if (messageId === null) return null
      return { type: 'turn.started', sessionId, messageId }
    }

    case 'reasoning.delta':
    case 'message.delta': {
      const messageId = readString(raw['messageId'])
      const delta = readString(raw['delta'])
      if (messageId === null || delta === null) return null
      return { type, sessionId, messageId, delta }
    }

    case 'tool.started': {
      const messageId = readString(raw['messageId'])
      const toolCall = raw['toolCall']
      if (messageId === null || !isRecord(toolCall)) return null

      const code = readString(toolCall['code'])
      if (code === null) return null

      const durationMs = toolCall['durationMs']

      return {
        type: 'tool.started',
        sessionId,
        messageId,
        toolCall: {
          id: readStringOr(toolCall['id'], ''),
          // The event's ids win over the nested ones. They are the routing keys:
          // the row written to disk and the `tool.finished` that closes it are
          // keyed on the event's `sessionId`/`messageId`, so a host that
          // mislabelled the nested copy would produce a record nothing can
          // update.
          sessionId,
          messageId,
          seq: readNumberOr(toolCall['seq'], 0),
          // v1 has exactly one tool (§7.1), whatever the host claims.
          tool: 'python',
          code,
          stdout: readNullableString(toolCall['stdout']),
          resultValue: readNullableString(toolCall['resultValue']),
          error: readNullableString(toolCall['error']),
          status: 'running',
          durationMs: typeof durationMs === 'number' ? durationMs : null,
          truncated: readBoolean(toolCall['truncated'], false),
          createdAt: readNumberOr(toolCall['createdAt'], Date.now())
        }
      }
    }

    case 'tool.output': {
      const toolCallId = readString(raw['toolCallId'])
      const chunk = readString(raw['chunk'])
      if (toolCallId === null || chunk === null) return null
      return { type: 'tool.output', sessionId, toolCallId, chunk }
    }

    case 'tool.finished': {
      const toolCallId = readString(raw['toolCallId'])
      if (toolCallId === null) return null

      const durationMs = raw['durationMs']
      const truncated = raw['truncated']

      return {
        type: 'tool.finished',
        sessionId,
        toolCallId,
        status: parseToolStatus(raw['status']),
        resultValue: readNullableString(raw['resultValue']),
        error: readNullableString(raw['error']),
        durationMs: typeof durationMs === 'number' ? durationMs : undefined,
        truncated: typeof truncated === 'boolean' ? truncated : undefined
      }
    }

    case 'compaction.started':
      return { type: 'compaction.started', sessionId }

    case 'compaction.finished': {
      const summary = readString(raw['summary'])
      if (summary === null) return null
      return { type: 'compaction.finished', sessionId, summary }
    }

    case 'turn.finished': {
      const messageId = readString(raw['messageId'])
      const usage = raw['usage']
      if (messageId === null || !isRecord(usage)) return null

      const costUsd = usage['costUsd']

      return {
        type: 'turn.finished',
        sessionId,
        messageId,
        usage: {
          tokensIn: readNumberOr(usage['tokensIn'], 0),
          tokensOut: readNumberOr(usage['tokensOut'], 0),
          costUsd: typeof costUsd === 'number' ? costUsd : null
        }
      }
    }

    case 'turn.error':
      return {
        type: 'turn.error',
        sessionId,
        messageId: readStringOr(raw['messageId'], ''),
        message: readStringOr(raw['message'], 'The turn failed.'),
        fatal: readBoolean(raw['fatal'], false)
      }

    default:
      return null
  }
}
