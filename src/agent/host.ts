/**
 * Agent host: orchestration.
 *
 * Runs as an Electron `utilityProcess`. Owns the turn lifecycle for every chat
 * session — one in-flight turn per `sessionId` — and is the only place in the
 * app that talks to OpenRouter or executes code.
 *
 * Wire protocol
 * -------------
 * Inbound (main -> host, `process.parentPort`):  `AgentCommand`
 * Outbound (host -> main, `process.parentPort.postMessage`): `AgentToMain`
 *
 * Invariants worth stating once, at the top:
 *
 *   - One in-flight turn per session. A second `send` for the same session is
 *     rejected rather than queued: two concurrent turns would interleave their
 *     deltas into one transcript and share a single sandbox.
 *   - Every turn emits exactly one terminal event (`turn.finished` or
 *     `turn.error`). The UI must never be left waiting, so the abort path, the
 *     error path and the happy path all converge on that invariant.
 *   - The OpenRouter key lives in a closure in this file. It is never logged,
 *     never persisted, and never handed to the sandbox.
 */
import { stepCountIs, streamText } from 'ai'
import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'
import type {
  AgentCommand,
  AgentEvent,
  AgentToMain,
  ModelInfo,
  Settings,
  ToolCall,
  ToolCallStatus,
  TurnRecord
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { PythonSandbox } from './sandbox'
import type { SandboxStatusInfo } from './sandbox'
import { buildToolRegistry } from './tools'
import { composeSystemPrompt, composeSystemPromptLayers } from './prompt'
import type { PromptInput } from './prompt'
import {
  buildSummaryPrompt,
  calibrateTokens,
  computeBudget,
  estimateMessages,
  estimateTokens,
  planCompaction,
  projectHistory
} from './context'
import { createResolver, contextLengthFor, DEFAULT_COMPACTION_MODEL } from './provider'
import type { ChatModelFactory } from './provider'
import { explainTurnError } from './explain'
import { TITLE_MODEL, generateSessionTitle } from './title'
import { PRELOAD_PACKAGES } from './wheels'
import { generateText } from 'ai'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on model steps in one turn (§7.2's "as many calculations as it
 * wants", bounded).
 *
 * A model that keeps calling the tool without ever answering is a cost problem,
 * not a safety one (§12.3), but an unbounded loop would hang the UI indefinitely
 * and burn the student's credits silently. 24 steps is far beyond a school
 * solution — the acceptance criteria's own examples need two or three.
 */
const MAX_STEPS = 24

/** Summary generation is a mechanical task; it does not need a long answer. */
const COMPACTION_MAX_OUTPUT_TOKENS = 900

/** Guard against a summariser that returns something absurd. */
const MAX_SUMMARY_CHARS = 8_000

/** Turn-level wall-clock ceiling, independent of any single step's timeout. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

interface ActiveTurn {
  readonly sessionId: string
  readonly messageId: string
  /** The model this turn asked for, so a failure can be explained in its terms. */
  readonly modelId: string
  readonly controller: AbortController
  /** Ids of tool calls that have been opened but not yet closed. */
  readonly openToolCalls: Set<string>
  /** Code recorded per tool call, so `tool.finished` can be cross-checked. */
  readonly toolCode: Map<string, string>
  /** Latest reported input tokens, used to calibrate the estimator. */
  lastInputTokens: number | undefined
  /** Set once the terminal event has been posted, so it is posted exactly once. */
  settled: boolean
}

export interface HostOptions {
  /**
   * Overrides the model factory. Used by `selfcheck.ts` to run the full turn
   * pipeline without an API key. Production never passes this.
   */
  readonly chatModelFactory?: ChatModelFactory
  /** Overrides the compaction model id. */
  readonly compactionModelId?: string
  /** Sends a message to the main process. Defaults to `parentPort.postMessage`. */
  readonly send?: (message: AgentToMain) => void
  /**
   * Model catalog, used only for context lengths. Main owns the catalog and its
   * cache (§9.3); supplying it here keeps §10.1's arithmetic honest. Empty in
   * production unless main forwards it.
   */
  readonly catalog?: readonly ModelInfo[]
  /** Overrides the resolved context length entirely. Used by the self-check. */
  readonly contextLength?: number
}

/**
 * Starts the agent host and wires the command loop.
 *
 * The sandbox is initialised eagerly but *not* awaited before `host.ready`:
 * Pyodide takes ~1.5 s to boot and a host that reports ready late looks broken
 * in the UI. A turn that arrives before the interpreter is up simply waits on
 * the same promise, and a turn that arrives when it failed gets a clear error
 * instead of a hang.
 */
export async function startAgentHost(options: HostOptions = {}): Promise<void> {
  const host = new AgentHost(options)

  const port = process.parentPort
  port.on('message', (event: { data: unknown }) => {
    void host.handle(event.data as AgentCommand)
  })

  host.post({ type: 'host.ready' })
  await host.start()
}

/**
 * Exported so `dev/selfcheck.ts` can drive the whole turn pipeline with an
 * injected model. Production goes through `startAgentHost`, which is the only
 * thing that touches the message port.
 */
export class AgentHost {  private readonly sandbox = new PythonSandbox()
  private readonly send: (message: AgentToMain) => void
  /**
   * The single in-flight turn. Null when idle.
   *
   * One slot rather than a map keyed by `sessionId`: there is a single
   * interpreter, so two turns in different chats would share one Python
   * namespace. §10.2 makes session isolation absolute, and sharing the
   * interpreter is the only way to break it.
   */
  private activeTurn: ActiveTurn | null = null
  private readonly providedChatFactory: ChatModelFactory | undefined
  private readonly compactionModelId: string | undefined
  private readonly contextLengthOverride: number | undefined
  private readonly catalog: readonly ModelInfo[]

  private settings: Settings = { ...DEFAULT_SETTINGS }
  private chatFactory: ChatModelFactory | null = null
  private sandboxReady: Promise<void> | null = null
  private lastSandboxSessionId: string | null = null

  constructor(options: HostOptions) {
    this.send = options.send ?? ((message) => process.parentPort.postMessage(message))
    this.providedChatFactory = options.chatModelFactory
    this.compactionModelId = options.compactionModelId
    this.contextLengthOverride = options.contextLength
    this.catalog = options.catalog ?? []
  }

  /** Boots the interpreter off the critical path. Never rejects. */
  async start(): Promise<void> {
    this.sandboxReady = this.sandbox.init().then(async () => {
      await this.sandbox.warmUp()
    })
    try {
      await this.sandboxReady
    } catch {
      // `init` and `warmUp` both record their own failure; there is nothing to
      // add here, and an unhandled rejection would take the process down.
    }
    const status = this.sandbox.status()
    this.log(
      `ready: python=${status.pythonVersion ?? 'unavailable'} init=${status.initMs ?? '-'}ms ` +
        `packages=${status.packagesReady ? `${status.packagesMs}ms` : 'unavailable'} ` +
        `wheels=${status.wheelsFound ? 'found' : 'MISSING'} interrupts=${status.interruptSupported}`
    )
  }

  post(event: AgentToMain): void {
    this.send(event)
  }

  private log(message: string): void {
    console.log(`[agent] ${message}`)
  }

  // -------------------------------------------------------------------------
  // Command dispatch
  // -------------------------------------------------------------------------

  async handle(command: AgentCommand): Promise<void> {
    switch (command.kind) {
      case 'init':
        this.handleInit(command.apiKey)
        return
      case 'settings':
        this.settings = command.settings
        this.log(
          `settings updated: model=${this.settings.modelId ?? '(none)'} ` +
            `timeout=${this.settings.pythonTimeoutMs}ms maxTokens=${this.settings.maxOutputTokens}`
        )
        return
      case 'reset-interpreter':
        await this.handleResetInterpreter(command.sessionId)
        return
      case 'stop':
        this.handleStop(command.sessionId)
        return
      case 'send':
        await this.handleSend(command)
        return
      default: {
        // Exhaustiveness guard: a new command kind is a compile error here
        // rather than a silently ignored message at run time.
        const never: never = command
        this.log(`ignoring unknown command: ${JSON.stringify(never)}`)
      }
    }
  }

  private handleInit(apiKey: string | null): void {
    if (apiKey === null || apiKey.trim().length === 0) {
      // §9.2: with no key the agent must refuse to start turns. Dropping the
      // factory is what enforces that — `resolveChatFactory` throws.
      this.chatFactory = null
      this.log('api key cleared; turns are disabled until one is set')
      return
    }
    const resolver = createResolver(apiKey, this.compactionModelId)
    this.chatFactory = resolver.chat
    this.compactionModelOverride = resolver.compactionModelId
    this.log('api key accepted (not logged, not persisted)')
  }

  private compactionModelOverride: string | undefined

  private async handleResetInterpreter(sessionId: string): Promise<void> {
    this.log(`resetting interpreter for session ${sessionId}`)
    this.lastSandboxSessionId = null
    // Awaited before returning so the next `send` for this session is issued
    // against a clean interpreter rather than racing the reset.
    await this.sandbox.reset()
    this.log('interpreter reset complete')
  }

  private handleStop(sessionId: string): void {
    const turn = this.activeTurn
    if (turn === null || turn.sessionId !== sessionId) {
      this.log(`stop for ${sessionId}: no turn in flight`)
      return
    }
    this.log(`stopping turn for ${sessionId}`)
    // One abort covers both halves of the turn: the model stream, and — because
    // the sandbox watches the same signal — the Python computation currently
    // running on the sandbox thread. Neither is merely abandoned.
    turn.controller.abort()
  }

  private async handleSend(command: Extract<AgentCommand, { kind: 'send' }>): Promise<void> {
    const { sessionId, messageId } = command

    const existing = this.activeTurn
    if (existing !== null) {
      // One turn at a time, app-wide. There is exactly one interpreter, and
      // §10.2 makes session identity absolute: two concurrent turns would share
      // a mutable Python namespace and cross-contaminate two supposedly
      // unrelated conversations. Queuing instead would be friendlier, but a
      // queued turn would also queue behind a 60-second computation the student
      // may already have stopped watching for.
      this.post({
        type: 'turn.error',
        sessionId,
        messageId,
        message: 'A reply is already being generated. Wait for it to finish, or press Stop first.',
        fatal: false
      })
      return
    }

    const chat = this.resolveChatFactory()
    if (chat === null) {
      this.post({
        type: 'turn.error',
        sessionId,
        messageId,
        message:
          'No OpenRouter API key is configured. Add one in Settings before asking a question.',
        fatal: false
      })
      return
    }

    // Name the session before the turn starts, but do not await it.
    this.maybeTitleSession(command)

    const turn: ActiveTurn = {
      sessionId,
      messageId,
      modelId: command.modelId,
      controller: new AbortController(),
      openToolCalls: new Set<string>(),
      toolCode: new Map<string, string>(),
      lastInputTokens: undefined,
      settled: false
    }
    this.activeTurn = turn

    try {
      await this.runTurn(command, turn, chat)
    } catch (error) {
      const reason = errorMessage(error)
      this.settle(turn, {
        type: 'turn.error',
        sessionId,
        messageId,
        message: explainTurnError(reason, command.modelId),
        fatal: false
      })
    } finally {
      if (this.activeTurn === turn) this.activeTurn = null
    }
  }

  private resolveChatFactory(): ChatModelFactory | null {
    if (this.providedChatFactory !== undefined) return this.providedChatFactory
    return this.chatFactory
  }

  /**
   * Names the session, once, on its first message.
   *
   * Fire-and-forget by design: the student is waiting for an answer, and a title
   * arriving a moment later is fine. Failure is silent because a missing title
   * is cosmetic — main has already written the truncated-first-message fallback.
   */
  private maybeTitleSession(command: Extract<AgentCommand, { kind: 'send' }>): void {
    // Only the first message. A conversation is not re-titled on every turn.
    if (command.history.length > 0) return

    const factory = this.resolveChatFactory()
    if (factory === null) return

    // Already titled: either a previous attempt succeeded, or the user renamed
    // the session. Re-asking would overwrite their choice.
    if (this.titledSessions.has(command.sessionId)) return

    this.titledSessions.add(command.sessionId)

    void generateSessionTitle({
      // Fixed, not configurable: a title must never cost the student money.
      model: factory(TITLE_MODEL),
      question: command.text,
      preferredLanguage: command.preferredLanguage
    })
      .then((title) => {
        if (title === null) {
          this.log('title generation produced nothing; keeping the fallback title')
          return
        }
        this.post({ type: 'title.suggested', sessionId: command.sessionId, title })
      })
      .catch((error: unknown) => {
        const name = error instanceof Error ? error.name : typeof error
        this.log(`title generation failed: ${name}`)
      })
  }

  /** Sessions that have been through title generation, so it happens once. */
  private readonly titledSessions = new Set<string>()

  // -------------------------------------------------------------------------
  // The turn
  // -------------------------------------------------------------------------

  private async runTurn(
    command: Extract<AgentCommand, { kind: 'send' }>,
    turn: ActiveTurn,
    chat: ChatModelFactory
  ): Promise<void> {
    const { sessionId, messageId } = command
    this.post({ type: 'turn.started', sessionId, messageId })

    // A sandbox that failed to boot must not fail the turn: the model can still
    // narrate, and §11 layer 3 tells it to say that calculation is unavailable.
    if (this.sandboxReady !== null) await this.sandboxReady.catch(() => undefined)

    await this.enforceSessionIsolation(sessionId)

    const systemPrompt = this.buildSystemPrompt(command)
    const budget = computeBudget({
      contextLength: this.resolveContextLength(command.modelId),
      systemPrompt,
      maxOutputTokens: command.maxOutputTokens
    })

    let sent: readonly TurnRecord[] = command.history
    let summary = command.summary

    const plan = planCompaction(sent, budget.history)
    if (plan.shouldCompact) {
      const compacted = await this.compact(sessionId, plan.compact, summary, turn)
      if (compacted !== null) {
        summary = compacted
        // Only the compacted prefix leaves the window; the kept tail is sent
        // verbatim. SQLite still holds the unabridged transcript (§10.3).
        sent = plan.keep
      } else {
        // §10.3: on failure the turn proceeds with verbatim history and a retry
        // is scheduled by the next turn.
        this.log('compaction failed; proceeding with verbatim history')
      }
    }

    const messages = [
      ...projectHistory(sent, summary),
      { role: 'user' as const, content: command.text }
    ]

    const projected = estimateMessages(messages)
    calibrateTokens(projected + budget.systemPrompt, turn.lastInputTokens)
    this.log(
      `turn: model=${command.modelId} history=${sent.length} turns ` +
        `~${projected}/${budget.history} tokens (${((projected / Math.max(1, budget.history)) * 100).toFixed(0)}% of budget) ` +
        `steps<=${MAX_STEPS}`
    )

    const tools = this.buildTools(turn, command)
    const turnTimeout = setTimeout(() => turn.controller.abort(), TURN_TIMEOUT_MS)

    try {
      const result = streamText({
        model: chat(command.modelId),
        system: systemPrompt,
        messages,
        tools: tools as ToolSet,
        // Multi-step: the model calls `python` as many times as the problem
        // needs, then answers. Bounded, because an unbounded loop is a cost
        // problem with no upside for a school solution.
        stopWhen: stepCountIs(MAX_STEPS),
        maxOutputTokens: command.maxOutputTokens,
        abortSignal: turn.controller.signal,
        onError: ({ error }) => {
          this.log(`stream error part: ${errorMessage(error)}`)
        }
      })

      for await (const part of result.fullStream) {
        this.handleStreamPart(turn, part)
      }

      if (turn.settled) return

      if (turn.controller.signal.aborted) {
        // Cancellation is a normal outcome: the partial answer is persisted by
        // main and the turn closes cleanly rather than as an error the student
        // has to interpret.
        this.settle(turn, {
          type: 'turn.finished',
          sessionId,
          messageId,
          usage: EMPTY_USAGE
        })
        return
      }

      // `usage` is a thenable, not a promise, so it cannot be `.catch`ed
      // directly; a rejection here must not take down the turn.
      let usage: LanguageModelUsage | null = null
      try {
        usage = await result.usage
      } catch (error) {
        this.log(`usage unavailable: ${errorMessage(error)}`)
      }
      turn.lastInputTokens = usage?.inputTokens
      this.settle(turn, {
        type: 'turn.finished',
        sessionId,
        messageId,
        usage: toTurnUsage(usage)
      })
    } finally {
      clearTimeout(turnTimeout)
      // A turn that ended with an interrupt or a timeout leaves CPython in an
      // unknown state; rebuild before it can be used again.
      if (turn.controller.signal.aborted) {
        void this.sandbox.reset(true).catch((error: unknown) => {
          this.log(`interpreter rebuild after abort failed: ${errorMessage(error)}`)
        })
      }
    }
  }

  /**
   * §7.2: reset between sessions so no state leaks across conversations.
   *
   * Session identity is the unit of context, so a variable named in one chat
   * must not be visible in another. The check is on the *sandbox* rather than on
   * the message history because the history is rebuilt from the database on
   * every send anyway — the interpreter is the part that would leak.
   */
  private async enforceSessionIsolation(sessionId: string): Promise<void> {
    if (this.lastSandboxSessionId === sessionId) return
    this.lastSandboxSessionId = sessionId
    if (this.sandbox.status().ready) {
      this.log(`session boundary: resetting interpreter before ${sessionId}`)
      await this.sandbox.reset()
    }
  }

  // -------------------------------------------------------------------------
  // Stream part mapping
  // -------------------------------------------------------------------------

  /**
   * Maps one `fullStream` part onto zero or more `AgentEvent`s.
   *
   * Returns `true` for a terminal part. Every branch of the union is handled
   * explicitly; the default arm logs an unrecognised part type rather than
   * dropping it, because a silently dropped part is a bug that shows up as a
   * missing sentence in a student's answer with nothing to point at.
   */
  private handleStreamPart(turn: ActiveTurn, part: TextStreamPart<ToolSet>): boolean {
    switch (part.type) {
      case 'start':
        return false

      case 'start-step':
        this.log('step started')
        return false

      case 'text-start':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-end':
        return false

      case 'reasoning-delta':
        this.post({
          type: 'reasoning.delta',
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          delta: part.text
        })
        return false

      case 'text-delta':
        this.post({
          type: 'message.delta',
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          delta: part.text
        })
        return false

      case 'tool-input-start': {
        // Card opens as soon as the model commits to a call, so the student
        // sees the step appear while it is still running.
        if (part.toolName === 'python') {
          turn.openToolCalls.add(part.id)
          this.post({
            type: 'tool.started',
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            toolCall: emptyToolCall(part.id, turn.sessionId, turn.messageId, '')
          })
        }
        return false
      }

      case 'tool-input-delta':
        // The source is replayed from the parsed input on `tool-call`, so the
        // partially-streamed JSON is not accumulated here.
        return false

      case 'tool-input-end':
        return false

      case 'tool-call': {
        if (part.toolName !== 'python') {
          this.log(`unhandled tool call: ${part.toolName}`)
          return false
        }
        const code = extractCode(part.input)
        turn.toolCode.set(part.toolCallId, code)
        if (!turn.openToolCalls.has(part.toolCallId)) {
          turn.openToolCalls.add(part.toolCallId)
          this.post({
            type: 'tool.started',
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            toolCall: emptyToolCall(part.toolCallId, turn.sessionId, turn.messageId, code)
          })
        }
        return false
      }

      case 'tool-result': {
        if (part.toolName !== 'python') return false
        this.closeToolCall(turn, part.toolCallId, fromToolOutput(part.output))
        return false
      }

      case 'tool-error': {
        this.log(`tool ${part.toolName}/${part.toolCallId} threw: ${errorMessage(part.error)}`)
        // A throwing tool still needs its card closed, or the UI shows a spinner
        // for the rest of the session.
        this.closeToolCall(turn, part.toolCallId, thrownOutcome(part.error))
        return false
      }

      case 'finish-step':
        this.log(
          `step finished: reason=${part.finishReason} in=${part.usage.inputTokens ?? '?'} out=${part.usage.outputTokens ?? '?'}`
        )
        return false

      case 'finish':
        this.log(`stream finished: reason=${part.finishReason}`)
        return true

      case 'abort':
        this.log(`stream aborted: ${part.reason ?? 'no reason given'}`)
        return true

      case 'error': {
        const reason = errorMessage(part.error)
        this.log(`stream error: ${reason}`)
        this.settle(turn, {
          type: 'turn.error',
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          // Restated in plain words: the provider's own text names the id but not
          // the cause, and never says where to fix it.
          message: explainTurnError(reason, turn.modelId),
          fatal: false
        })
        return true
      }

      // Parts that cannot occur with a single local tool, handled so a future
      // SDK addition is a log line rather than a silent drop.
      case 'custom':
      case 'source':
      case 'file':
      case 'reasoning-file':
      case 'raw':
        this.log(`ignoring stream part of type ${part.type}`)
        return false

      case 'tool-output-denied':
      case 'tool-approval-request':
      case 'tool-approval-response':
        // There is no approval flow (§8): the tool is safe by construction. If
        // a model ever asks for approval, refusing it is the correct behaviour.
        this.log(`ignoring approval part ${part.type}`)
        return false

      default: {
        const unhandled: never = part
        this.log(`unrecognised stream part: ${JSON.stringify(unhandled)}`)
        return false
      }
    }
  }

  private closeToolCall(
    turn: ActiveTurn,
    toolCallId: string,
    outcome: ToolOutcome
  ): void {
    turn.openToolCalls.delete(toolCallId)
    this.post({
      type: 'tool.finished',
      sessionId: turn.sessionId,
      toolCallId,
      status: outcome.status,
      resultValue: outcome.value,
      error: outcome.error,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated
    })
    // `stdout` is not part of `tool.finished`; the frozen contract delivers it
    // as `tool.output` chunks during the step. The final text is still worth
    // logging for a turn that produced output faster than the UI could show.
    if (outcome.stdout !== null && outcome.stdout.length > 0) {
      this.log(`tool ${toolCallId} produced ${outcome.stdout.length} chars of output`)
    }
  }

  /** Posts the turn's single terminal event. Idempotent by design. */
  private settle(turn: ActiveTurn, event: AgentEvent): void {
    if (turn.settled) return
    turn.settled = true
    this.post(event)
  }

  // -------------------------------------------------------------------------
  // Tool wiring
  // -------------------------------------------------------------------------

  private buildTools(
    turn: ActiveTurn,
    command: Extract<AgentCommand, { kind: 'send' }>
  ): ReturnType<typeof buildToolRegistry> {
    const host = this
    return buildToolRegistry({
      run: (code, options) => host.sandbox.run(code, options),
      timeoutMs: () => command.pythonTimeoutMs,
      shouldAbort: () => turn.controller.signal.aborted,
      onStart: (toolCallId, code) => {
        if (!turn.openToolCalls.has(toolCallId)) {
          turn.openToolCalls.add(toolCallId)
          host.post({
            type: 'tool.started',
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            toolCall: emptyToolCall(toolCallId, turn.sessionId, turn.messageId, code)
          })
        } else if (code.length > 0) {
          // The card was opened by `tool-input-start` with no source; the parsed
          // input is the first point where the real code is known.
          host.post({
            type: 'tool.started',
            sessionId: turn.sessionId,
            messageId: turn.messageId,
            toolCall: emptyToolCall(toolCallId, turn.sessionId, turn.messageId, code)
          })
        }
      },
      onOutput: (chunk) => {
        host.post({
          type: 'tool.output',
          sessionId: turn.sessionId,
          toolCallId: host.currentToolCallId(turn),
          chunk
        })
      },
      isCurrentCall: () => true
    })
  }

  /**
   * The tool call a stdout chunk belongs to.
   *
   * Steps are strictly sequential — `MAX_STEPS` stops before the SDK would ever
   * run two in parallel — so at most one card is open, and the first open id is
   * the right target.
   */
  private currentToolCallId(turn: ActiveTurn): string {
    for (const id of turn.openToolCalls) return id
    return ''
  }

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------

  /**
   * The composed prompt for this turn.
   *
   * Built from the same function that serves the Settings "view exact payload"
   * inspector, so what the student is shown is what the model receives. The
   * inspector asks for it over the host's message port, which means main
   * forwards the question here rather than rebuilding the text — there is no
   * second implementation that could drift.
   */
  private buildSystemPrompt(command: Extract<AgentCommand, { kind: 'send' }>): string {
    const input = this.promptInput(
      command.modelId,
      command.maxOutputTokens,
      command.preferredLanguage
    )
    return composeSystemPrompt(input)
  }

  private promptInput(
    modelId: string,
    maxOutputTokens: number,
    preferredLanguage: Settings['preferredLanguage']
  ): PromptInput {
    const status: SandboxStatusInfo = this.sandbox.status()
    const contextLength = this.resolveContextLength(modelId)
    // The §10.1 floor depends on the system prompt's own size, so it is
    // computed against a placeholder here; `buildSystemPrompt` recomputes it
    // against the composed text before the request is sent.
    const budget = computeBudget({ contextLength, systemPrompt: '', maxOutputTokens })

    return {
      userInstructions: this.settings.userInstructions,
      preferredLanguage,
      // Personalise. Passed as one object rather than four arguments so the
      // profile can grow a field without changing this signature again.
      student: {
        name: this.settings.studentName,
        age: this.settings.studentAge,
        grade: this.settings.studentGrade,
        subjects: this.settings.studySubjects
      },
      budgetWarning: budget.warning,
      environment: {
        platform: process.platform,
        arch: process.arch,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        date: new Date().toISOString().slice(0, 10),
        modelId,
        contextLength,
        maxOutputTokens,
        pythonTimeoutMs: this.settings.pythonTimeoutMs,
        pythonVersion: status.pythonVersion,
        packages: [...PRELOAD_PACKAGES],
        sandboxError: status.error ?? (status.packagesError === null ? null : status.packagesError)
      }
    }
  }

  /**
   * The payload the Settings inspector shows.
   *
   * Exposed as a method rather than a command variant because the frozen
   * `AgentCommand` union has no member for it; main calls it through
   * `inspectSystemPrompt` on the host instance. Documented here because it is the
   * one deliberate deviation from "events only".
   */
  inspectSystemPrompt(
    modelId: string,
    maxOutputTokens: number,
    preferredLanguage: Settings['preferredLanguage']
  ): { base: string; user: string | null; runtime: string; full: string } {
    return composeSystemPromptLayers(
      this.promptInput(modelId, maxOutputTokens, preferredLanguage)
    )
  }

  private resolveContextLength(modelId: string): number {
    if (this.contextLengthOverride !== undefined) return this.contextLengthOverride
    // Main owns the catalog and its cache; when it is not supplied, fall back to
    // a conservative window rather than guessing high.
    return contextLengthFor(modelId, this.catalog)
  }

  // -------------------------------------------------------------------------
  // Compaction, §10.3
  // -------------------------------------------------------------------------

  private async compact(
    sessionId: string,
    turns: readonly TurnRecord[],
    previous: string | null,
    turn: ActiveTurn
  ): Promise<string | null> {    if (turns.length === 0) return null
    this.post({ type: 'compaction.started', sessionId })
    this.log(`compacting ${turns.length} turns`)

    const chat = this.resolveChatFactory()
    if (chat === null) {
      this.post({ type: 'compaction.finished', sessionId, summary: previous ?? '' })
      return null
    }

    try {
      const result = await generateText({
        model: chat(this.compactionModelOverride ?? DEFAULT_COMPACTION_MODEL),
        prompt: buildSummaryPrompt(turns, previous),
        maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
        // A summary that fails must not fail the turn; the abort is only
        // honoured so a hung compaction call cannot outlive the Stop button.
        abortSignal: turn.controller.signal
      })

      const summary = result.text.trim()
      if (summary.length === 0) throw new Error('the summariser returned nothing')

      const clipped = summary.slice(0, MAX_SUMMARY_CHARS)
      this.log(
        `compaction produced ${estimateTokens(clipped)} tokens ` +
          `(${result.usage.inputTokens ?? '?'} in / ${result.usage.outputTokens ?? '?'} out)`
      )
      // The summary is returned to main, which persists it. The compacted turns
      // themselves are untouched in SQLite (§10.3).
      this.post({ type: 'compaction.finished', sessionId, summary: clipped })
      return clipped
    } catch (error) {
      this.log(`compaction failed: ${errorMessage(error)}`)
      this.post({ type: 'compaction.finished', sessionId, summary: previous ?? '' })
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Tool outcome plumbing
// ---------------------------------------------------------------------------

interface ToolOutcome {
  readonly status: ToolCallStatus
  readonly stdout: string | null
  readonly value: string | null
  readonly error: string | null
  readonly durationMs: number
  readonly truncated: boolean
}

interface ToolOutputShape {
  readonly status?: unknown
  readonly stdout?: unknown
  readonly value?: unknown
  readonly error?: unknown
  readonly durationMs?: unknown
  readonly truncated?: unknown
}

/**
 * Reads a tool result back out of the model message stream.
 *
 * Narrowing every field rather than casting: a tool output arrives as
 * `unknown` on the `tool-result` part, and a stray field type here would put
 * `undefined` into `ToolCall.resultValue`, which main persists.
 */
function fromToolOutput(output: unknown): ToolOutcome {
  const shape = (typeof output === 'object' && output !== null ? output : {}) as ToolOutputShape
  const status = typeof shape.status === 'string' ? shape.status : 'error'
  return {
    status: toToolCallStatus(status),
    stdout: typeof shape.stdout === 'string' ? shape.stdout : null,
    value: typeof shape.value === 'string' ? shape.value : null,
    error: typeof shape.error === 'string' ? shape.error : null,
    durationMs: typeof shape.durationMs === 'number' ? shape.durationMs : 0,
    truncated: shape.truncated === true
  }
}

/** The outcome for a tool that threw rather than returning. */
function thrownOutcome(error: unknown): ToolOutcome {
  return {
    status: 'error',
    stdout: null,
    value: null,
    error: errorMessage(error),
    durationMs: 0,
    truncated: false
  }
}

function toToolCallStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'ok':
      return 'complete'
    case 'error':
      return 'error'
    case 'timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'error'
  }
}

/** Pulls `code` out of a tool input that may or may not have parsed. */
function extractCode(input: unknown): string {
  if (typeof input === 'string') {
    try {
      return extractCode(JSON.parse(input) as unknown)
    } catch {
      return input
    }
  }
  if (typeof input === 'object' && input !== null && 'code' in input) {
    const code = (input as { code: unknown }).code
    return typeof code === 'string' ? code : ''
  }
  return ''
}

function emptyToolCall(
  id: string,
  sessionId: string,
  messageId: string,
  code: string
): ToolCall {
  return {
    id,
    sessionId,
    messageId,
    seq: 0,
    tool: 'python',
    code,
    stdout: null,
    resultValue: null,
    error: null,
    status: 'running',
    durationMs: null,
    truncated: false,
    createdAt: Date.now()
  }
}

const EMPTY_USAGE = { tokensIn: 0, tokensOut: 0, costUsd: null }

function toTurnUsage(usage: LanguageModelUsage | null): {
  tokensIn: number
  tokensOut: number
  costUsd: number | null
} {
  if (usage === null) return EMPTY_USAGE
  return {
    tokensIn: usage.inputTokens ?? 0,
    tokensOut: usage.outputTokens ?? 0,
    costUsd: readCost(usage)
  }
}

/**
 * OpenRouter reports cost in `providerMetadata.openrouter.totalCost` (USD) or,
 * on some routes, in a non-standard usage field. Read both defensively: the
 * student is told what they are spending, and a missing number must not become
 * a fabricated one.
 */
function readCost(usage: LanguageModelUsage): number | null {
  const raw = usage as unknown as {
    cost?: unknown
    providerMetadata?: { openrouter?: { totalCost?: unknown } }
  }
  if (typeof raw.cost === 'number' && Number.isFinite(raw.cost)) return raw.cost
  const reported = raw.providerMetadata?.openrouter?.totalCost
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported
  return null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}


