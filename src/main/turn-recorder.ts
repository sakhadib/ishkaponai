/**
 * Persistence of agent-host events into SQLite.
 *
 * §13.6 requires two things that pull in opposite directions:
 *
 *   - "Partial assistant output is persisted as it streams, so a crash
 *     mid-answer does not lose the turn."
 *   - and the main process must stay responsive while it does.
 *
 * `node:sqlite` is synchronous, so every write blocks the main thread — and
 * therefore the window — for the duration of the commit. Writing once per token
 * would make a streaming answer visibly stutter and would fsync hundreds of
 * times per second. So deltas accumulate in memory and are flushed on a short
 * timer: at most four commits per second while a turn streams, plus an immediate
 * flush whenever the durable state changes (`turn.finished`, `tool.finished`,
 * `turn.error`) or the app is about to quit.
 *
 * A 250 ms worst-case window is an acceptable trade against losing a quarter of
 * a second of text to a hard crash, and the *renderer* still receives every
 * delta immediately, so the answer appears token-by-token regardless.
 */
import type { Database } from './db'
import {
  appendMessageDelta,
  appendToolCall,
  appendToolCallStdout,
  finalizeMessage,
  finishToolCall,
  setSessionSummary,
  touchSession,
  updateSession
} from './sessions'
import type { AgentEvent } from '@shared/types'

const FLUSH_INTERVAL_MS = 250

/** Buffered text awaiting a flush, per message. */
interface MessageBuffer {
  content: string
  reasoning: string
}

/** Buffered tool stdout awaiting a flush, per tool call. */
type ToolBuffers = Map<string, string>

export class TurnRecorder {
  private readonly messages = new Map<string, MessageBuffer>()

  private readonly tools: ToolBuffers = new Map()

  private timer: NodeJS.Timeout | null = null

  private disposed = false

  constructor(private readonly db: Database) {}

  /**
   * Applies one durable event. Every branch that changes the durable record
   * flushes what is buffered *first*, so the final write is never reordered
   * behind a delta that has not been committed yet.
   */
  record(event: AgentEvent): void {
    if (this.disposed) return

    switch (event.type) {
      case 'message.delta':
        this.bufferMessage(event.messageId, 'content', event.delta)
        return

      case 'reasoning.delta':
        this.bufferMessage(event.messageId, 'reasoning', event.delta)
        return

      case 'tool.started':
        this.recordToolStarted(event)
        return

      case 'tool.output':
        this.bufferToolOutput(event.toolCallId, event.chunk)
        return

      case 'tool.finished':
        this.flush()
        this.finishToolCall(event)
        return

      case 'compaction.finished':
        this.recordCompaction(event)
        return

      case 'title.suggested':
        // A title is not turn state and has no buffer, but it must not be
        // silently dropped by this exhaustive switch.
        this.recordTitle(event)
        return

      case 'turn.finished':
        this.finishTurn(event)
        return

      case 'turn.error':
        this.failTurn(event)
        return

      case 'turn.started':
      case 'compaction.started':
        // Nothing durable yet: the IPC layer already wrote both message rows
        // before the turn was dispatched, and compaction has no state until it
        // finishes.
        return
    }
  }

  /**
   * Stores a model-generated session title.
   *
   * Flushed first so the title cannot be written before the buffered deltas it
   * shares a `updated_at` timestamp with, and applied immediately rather than
   * batched: a title arriving a second late should appear in the sidebar at
   * once, and it is a single-row write.
   */
  private recordTitle(event: Extract<AgentEvent, { type: 'title.suggested' }>): void {
    this.flush()
    updateSession(this.db, event.sessionId, { title: event.title })
  }

  /**
   * Flushes every buffer. Safe to call at any time; used on turn boundaries and
   * during shutdown.
   */
  flush(): void {
    this.stopTimer()

    if (this.messages.size === 0 && this.tools.size === 0) return

    // Take the buffers first: a failure mid-flush must not leave a stale entry
    // that is replayed on the next flush and double-applied.
    const messages = [...this.messages]
    const tools = [...this.tools]
    this.messages.clear()
    this.tools.clear()

    for (const [messageId, buffer] of messages) {
      try {
        if (buffer.content.length > 0) {
          appendMessageDelta(this.db, messageId, 'content', buffer.content)
        }
        if (buffer.reasoning.length > 0) {
          appendMessageDelta(this.db, messageId, 'reasoning', buffer.reasoning)
        }
      } catch (error) {
        console.error('[turn-recorder] failed to persist streamed text:', error)
      }
    }

    for (const [toolCallId, chunk] of tools) {
      try {
        appendToolCallStdout(this.db, toolCallId, chunk)
      } catch (error) {
        console.error('[turn-recorder] failed to persist tool output:', error)
      }
    }
  }

  /**
   * Stops buffering. Called once, when the app is quitting: the buffered text is
   * flushed so nothing in memory is lost.
   */
  dispose(): void {
    this.flush()
    this.disposed = true
  }

  /**
   * Closes one message that will never be completed, because the agent host died
   * mid-turn. The partial text is kept — §13.6 requires that a crash mid-answer
   * does not lose the turn — only the status changes so the renderer stops
   * treating it as still-arriving.
   */
  failStreamingMessage(messageId: string, status: 'error' | 'cancelled'): void {
    this.flush()
    this.messages.delete(messageId)

    try {
      finalizeMessage(this.db, messageId, { status })
    } catch (error) {
      console.error('[turn-recorder] failed to close an interrupted message:', error)
    }
  }

  private bufferMessage(messageId: string, field: 'content' | 'reasoning', delta: string): void {
    if (delta.length === 0) return

    let buffer = this.messages.get(messageId)
    if (!buffer) {
      buffer = { content: '', reasoning: '' }
      this.messages.set(messageId, buffer)
    }

    buffer[field] += delta
    this.startTimer()
  }

  private bufferToolOutput(toolCallId: string, chunk: string): void {
    if (chunk.length === 0) return

    this.tools.set(toolCallId, (this.tools.get(toolCallId) ?? '') + chunk)
    this.startTimer()
  }

  private startTimer(): void {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
    // A pending flush must not be the reason the process stays alive.
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private recordToolStarted(event: Extract<AgentEvent, { type: 'tool.started' }>): void {
    try {
      // `appendToolCall` keeps the agent host's id so the row on disk is the
      // same record the renderer is already drawing the execution card from.
      appendToolCall(this.db, {
        id: event.toolCall.id,
        sessionId: event.sessionId,
        messageId: event.messageId,
        code: event.toolCall.code
      })
    } catch (error) {
      console.error('[turn-recorder] failed to open the tool call row:', error)
    }
  }

  private finishToolCall(event: Extract<AgentEvent, { type: 'tool.finished' }>): void {
    try {
      finishToolCall(this.db, event.toolCallId, {
        status: event.status,
        resultValue: event.resultValue ?? null,
        error: event.error ?? null,
        durationMs: event.durationMs ?? null,
        truncated: event.truncated === true
      })
    } catch (error) {
      console.error('[turn-recorder] failed to close the tool call row:', error)
    }
  }

  private recordCompaction(event: Extract<AgentEvent, { type: 'compaction.finished' }>): void {
    try {
      // Compaction runs *before* the model call, so the newest message is the
      // assistant row this turn is about to fill. Bounding the summary by the
      // last *finished* message keeps the in-progress row in the next turn's
      // verbatim history window.
      setSessionSummary(
        this.db,
        event.sessionId,
        event.summary,
        this.latestFinishedSeq(event.sessionId)
      )
    } catch (error) {
      console.error('[turn-recorder] failed to store the compaction summary:', error)
    }
  }

  private finishTurn(event: Extract<AgentEvent, { type: 'turn.finished' }>): void {
    this.flush()

    try {
      finalizeMessage(this.db, event.messageId, {
        status: 'complete',
        tokensIn: event.usage.tokensIn,
        tokensOut: event.usage.tokensOut,
        costUsd: event.usage.costUsd
      })
      touchSession(this.db, event.sessionId)
    } catch (error) {
      console.error('[turn-recorder] failed to complete the assistant message:', error)
    }
  }

  private failTurn(event: Extract<AgentEvent, { type: 'turn.error' }>): void {
    this.flush()

    try {
      finalizeMessage(this.db, event.messageId, { status: 'error' })
    } catch (error) {
      console.error('[turn-recorder] failed to mark the assistant message as failed:', error)
    }
  }

  private latestFinishedSeq(sessionId: string): number {
    const row = this.db.get(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages
        WHERE session_id = ? AND status IN ('complete', 'cancelled')`,
      sessionId
    )
    const value = row?.['max_seq']
    return typeof value === 'number' ? value : 0
  }
}
