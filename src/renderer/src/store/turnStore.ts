/**
 * Live turn state, fed by the `AgentEvent` stream.
 *
 * Two things make this non-trivial:
 *
 * 1. **Coalescing.** A provider emits deltas far faster than a human reads.
 *    Applying each one to the store would re-render React per character. Deltas
 *    are therefore buffered per field and flushed on a ~30 ms timer, matching
 *    the interval main already coalesces at (spec §13.6).
 *
 * 2. **Ordering.** Tool cards and assistant text interleave. Rather than
 *    reconstructing a global order from event arrival (which is racy), the turn
 *    keeps a monotonically increasing `seq` per part, assigned when the part
 *    *starts*, and renders parts in that order. `tool.started` therefore always
 *    lands after the prose that preceded it, which is how a student reads a
 *    worked solution.
 */
import { create } from 'zustand'
import type { AgentEvent, Message, ToolCall, ToolCallStatus, TurnUsage } from '@shared/types'
import { call, onAgentEvent } from '@/lib/bridge'

/** Matches the ~30 ms coalescing interval in spec §13.6. */
const FLUSH_INTERVAL_MS = 30

/** Stop flushing when a turn is quiet for this long, to release the timer. */
const IDLE_RELEASE_MS = 400

export type TurnPhase = 'idle' | 'running' | 'stopping' | 'error'

export interface ToolCard {
  toolCallId: string
  messageId: string
  seq: number
  tool: 'python'
  code: string
  /** Streamed stdout, accumulated. */
  output: string
  resultValue: string | null
  error: string | null
  status: ToolCallStatus
  durationMs: number | null
  truncated: boolean
  /**
   * True when the turn ended before this call reported, so the card's status
   * was assigned by the sweep rather than by the agent. The UI shows this so a
   * student is never told a calculation is "Running" after it has stopped.
   */
  abandoned?: boolean
}

/**
 * Forces every still-running card to a terminal state.
 *
 * Without this, a turn that dies mid-`python` (fatal error, or a stop that
 * aborted the stream while a computation was in flight) leaves its card reading
 * "Running" forever, because no `tool.finished` will ever arrive for it. Called
 * from both terminal events.
 */
function finaliseRunningCards(
  cards: ToolCard[],
  status: Extract<ToolCallStatus, 'error' | 'cancelled'>,
  reason: string
): ToolCard[] {
  let changed = false
  const next = cards.map((card) => {
    if (card.status !== 'running') return card
    changed = true
    return { ...card, status, error: card.error ?? reason, abandoned: true } as ToolCard
  })
  return changed ? next : cards
}

export interface TurnState {
  sessionId: string | null
  messageId: string | null
  phase: TurnPhase
  /** True between `turn.started` and `turn.finished`; what the Stop button uses. */
  streaming: boolean
  /** Assistant text accumulated so far. */
  text: string
  /** Model "thinking" trace accumulated so far. */
  reasoning: string
  toolCards: ToolCard[]
  usage: TurnUsage | null
  error: string | null
  errorFatal: boolean
  /** Non-null while compaction runs, and briefly after it finishes. */
  compaction: 'running' | 'done' | null
  /** The last compacted summary, per §10.3. */
  summary: string | null
  /** Monotonic counter backing part ordering. */
  nextSeq: number

  attach: () => () => void
  send: (sessionId: string, text: string) => Promise<void>
  stop: (sessionId: string) => Promise<void>
  reset: () => void
  /** Test seam: apply an event without the timer. */
  applyEvent: (event: AgentEvent) => void
  flush: () => void
}

interface Pending {
  text: string
  reasoning: string
  /** Tool ids that received output since the last flush. */
  toolOutputs: Map<string, string>
}

function emptyPending(): Pending {
  return { text: '', reasoning: '', toolOutputs: new Map() }
}

function initialState(): Pick<
  TurnState,
  | 'sessionId'
  | 'messageId'
  | 'phase'
  | 'streaming'
  | 'text'
  | 'reasoning'
  | 'toolCards'
  | 'usage'
  | 'error'
  | 'errorFatal'
  | 'compaction'
  | 'summary'
> {
  return {
    sessionId: null,
    messageId: null,
    phase: 'idle',
    streaming: false,
    text: '',
    reasoning: '',
    toolCards: [],
    usage: null,
    error: null,
    errorFatal: false,
    compaction: null,
    summary: null
  }
}

/**
 * A started tool call, in the shape the renderer needs, from the wire shape.
 * The event carries a full `ToolCall`, but `tool.finished` may arrive before we
 * have re-rendered, so every field is treated as provisional.
 */
function toCard(toolCall: ToolCall, seq: number): ToolCard {
  return {
    toolCallId: toolCall.id,
    messageId: toolCall.messageId,
    seq,
    tool: toolCall.tool,
    code: toolCall.code,
    output: toolCall.stdout ?? '',
    resultValue: toolCall.resultValue,
    error: toolCall.error,
    status: toolCall.status,
    durationMs: toolCall.durationMs,
    truncated: toolCall.truncated
  }
}

export const useTurnStore = create<TurnState>((set, get) => {
  let pending: Pending = emptyPending()
  let timer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null

  const clearTimers = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  /** Writes the buffer into the store. Safe to call when the buffer is empty. */
  const applyPending = (): void => {
    const { text, reasoning, toolOutputs } = pending
    if (text === '' && reasoning === '' && toolOutputs.size === 0) {
      pending = emptyPending()
      return
    }
    // The session a flush belongs to. A flush must never land on a turn the
    // student has already navigated away from.
    const sessionId = get().sessionId
    set((state) => {
      if (sessionId !== null && state.sessionId !== null && state.sessionId !== sessionId) {
        return {}
      }
      const toolCards =
        toolOutputs.size === 0
          ? state.toolCards
          : state.toolCards.map((card) => {
              const chunk = toolOutputs.get(card.toolCallId)
              return chunk === undefined ? card : { ...card, output: card.output + chunk }
            })
      return {
        text: state.text + text,
        reasoning: state.reasoning + reasoning,
        toolCards
      }
    })
    pending = emptyPending()
  }

  const scheduleFlush = (): void => {
    if (timer === null) timer = setTimeout(() => {
      timer = null
      applyPending()
    }, FLUSH_INTERVAL_MS)

    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      // Nothing new arrived; drop the timer so an idle turn holds no handle.
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      applyPending()
    }, IDLE_RELEASE_MS)
  }

  const applyEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'turn.started': {
        // A new turn supersedes anything buffered from a previous one.
        clearTimers()
        pending = emptyPending()
        set({
          ...initialState(),
          sessionId: event.sessionId,
          messageId: event.messageId,
          phase: 'running',
          streaming: true,
          nextSeq: 0,
          summary: get().summary
        })
        return
      }

      case 'reasoning.delta': {
        if (!isCurrentTurn(get(), event.sessionId, event.messageId)) return
        pending.reasoning += event.delta
        scheduleFlush()
        return
      }

      case 'message.delta': {
        if (!isCurrentTurn(get(), event.sessionId, event.messageId)) return
        pending.text += event.delta
        scheduleFlush()
        return
      }

      case 'tool.started': {
        if (get().sessionId !== event.sessionId) return
        set((state) => {
          if (state.toolCards.some((card) => card.toolCallId === event.toolCall.id)) return {}
          return {
            toolCards: [...state.toolCards, toCard(event.toolCall, state.nextSeq)],
            nextSeq: state.nextSeq + 1
          }
        })
        return
      }

      case 'tool.output': {
        if (get().sessionId !== event.sessionId) return
        const known = get().toolCards.some((card) => card.toolCallId === event.toolCallId)
        if (!known) {
          // Output for a card we never saw start. Show it rather than dropping
          // evidence: the execution happened and the student should see it.
          set((state) => ({
            toolCards: [
              ...state.toolCards,
              {
                toolCallId: event.toolCallId,
                messageId: state.messageId ?? '',
                seq: state.nextSeq,
                tool: 'python' as const,
                code: '',
                output: '',
                resultValue: null,
                error: null,
                status: 'running' as ToolCallStatus,
                durationMs: null,
                truncated: false
              }
            ],
            nextSeq: state.nextSeq + 1
          }))
        }
        const existing = pending.toolOutputs.get(event.toolCallId)
        pending.toolOutputs.set(event.toolCallId, (existing ?? '') + event.chunk)
        scheduleFlush()
        return
      }

      case 'tool.finished': {
        if (get().sessionId !== event.sessionId) return
        // Apply the buffered output first so ordering inside the card is right.
        applyPending()
        set((state) => ({
          toolCards: state.toolCards.map((card) =>
            card.toolCallId === event.toolCallId
              ? {
                  ...card,
                  status: event.status,
                  resultValue: event.resultValue ?? card.resultValue,
                  error: event.error ?? null,
                  durationMs: event.durationMs ?? card.durationMs,
                  truncated: event.truncated ?? card.truncated
                }
              : card
          )
        }))
        return
      }

      case 'compaction.started': {
        if (get().sessionId !== event.sessionId) return
        set({ compaction: 'running' })
        return
      }

      case 'compaction.finished': {
        if (get().sessionId !== event.sessionId) return
        set({ compaction: 'done', summary: event.summary })
        // Keep the "context was compacted" notice up long enough to be read,
        // then drop the transient marker but leave `summary` in place.
        setTimeout(() => {
          if (useTurnStore.getState().compaction === 'done') set({ compaction: null })
        }, 6000)
        return
      }

      case 'turn.finished': {
        if (get().sessionId !== event.sessionId) return
        applyPending()
        clearTimers()
        set((state) => ({
          streaming: false,
          phase: 'idle',
          usage: event.usage,
          messageId: event.messageId,
          // A card still running at normal end means the agent moved on without
          // reporting it. Do not leave it spinning.
          toolCards: finaliseRunningCards(
            state.toolCards,
            'cancelled',
            'The turn ended before this calculation reported a result.'
          )
        }))
        return
      }

      case 'turn.error': {
        if (get().sessionId !== event.sessionId) return
        applyPending()
        clearTimers()
        set((state) => ({
          streaming: false,
          phase: 'error',
          error: event.message,
          errorFatal: event.fatal,
          toolCards: finaliseRunningCards(
            state.toolCards,
            'error',
            'The turn failed before this calculation reported a result.'
          ),
          messageId: state.messageId ?? event.messageId
        }))
        return
      }

      default: {
        // Exhaustiveness guard: adding a member to `AgentEvent` breaks the build
        // here rather than silently dropping the event.
        const never: never = event
        void never
      }
    }
  }

  return {
    ...initialState(),
    nextSeq: 0,

    attach: () => {
      if (unsubscribe !== null) return unsubscribe
      unsubscribe = onAgentEvent(applyEvent)
      return () => {
        if (unsubscribe !== null) {
          unsubscribe()
          unsubscribe = null
        }
        clearTimers()
        pending = emptyPending()
      }
    },

    send: async (sessionId, text) => {
      const trimmed = text.trim()
      if (trimmed === '') return
      clearTimers()
      pending = emptyPending()
      set({
        ...initialState(),
        sessionId,
        phase: 'running',
        streaming: true,
        nextSeq: 0
      })
      try {
        const { messageId } = await call('Sending the message', (api) =>
          api.sendMessage(sessionId, trimmed)
        )
        set({ messageId })
      } catch (error) {
        set({
          streaming: false,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    },

    stop: async (sessionId) => {
      set({ phase: 'stopping' })
      try {
        await call('Stopping the turn', (api) => api.stopTurn(sessionId))
      } catch (error) {
        set({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },

    reset: () => {
      clearTimers()
      pending = emptyPending()
      set({ ...initialState(), nextSeq: 0 })
    },

    applyEvent,
    flush: applyPending
  }
})

/** True when the event names the turn currently on screen. */
function isCurrentTurn(state: TurnState, sessionId: string, messageId: string): boolean {
  if (state.sessionId !== sessionId) return false
  if (state.messageId === null) return true
  return state.messageId === messageId
}

/**
 * Persisted rows a completed turn produced, so the streamed view can hand them
 * to the session store and SQLite stays the single source of truth on reload.
 */
export interface CompletedTurnRows {
  messages: Message[]
  toolCalls: ToolCall[]
}

export function buildCompletedRows(
  sessionId: string,
  messageId: string | null,
  text: string,
  reasoning: string,
  cards: ToolCard[],
  usage: TurnUsage | null,
  now = Date.now()
): CompletedTurnRows {
  const messages: Message[] = []
  if (messageId !== null && (text !== '' || reasoning !== '')) {
    messages.push({
      id: messageId,
      sessionId,
      seq: 0,
      role: 'assistant',
      content: text,
      reasoning: reasoning === '' ? null : reasoning,
      status: 'complete',
      tokensIn: usage?.tokensIn ?? null,
      tokensOut: usage?.tokensOut ?? null,
      costUsd: usage?.costUsd ?? null,
      createdAt: now
    })
  }

  const toolCalls: ToolCall[] = cards.map((card, index) => ({
    id: card.toolCallId,
    sessionId,
    messageId: card.messageId === '' ? (messageId ?? card.toolCallId) : card.messageId,
    seq: index,
    tool: card.tool,
    code: card.code,
    stdout: card.output === '' ? null : card.output,
    resultValue: card.resultValue,
    error: card.error,
    status: card.status,
    durationMs: card.durationMs,
    truncated: card.truncated,
    createdAt: now
  }))

  return { messages, toolCalls }
}
