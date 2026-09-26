/**
 * The main pane: transcript, live turn, and composer.
 *
 * Owns the send path, which is the one place several stores have to agree:
 *  1. a session must exist before a message can be sent (main creates the row
 *     and the assistant row together),
 *  2. the turn store takes over rendering for the duration,
 *  3. on `turn.finished` the streamed parts are handed to the session store so
 *     the transcript matches what SQLite holds, and the sidebar title/ordering
 *     is refreshed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, ToolCall } from '@shared/types'
import { Composer } from '@/features/chat/Composer'
import {
  ExecutionCard,
  describeFailure,
  isFailedStatus,
  toExecutionSource
} from '@/features/chat/ExecutionCard'
import { MessageItem } from '@/features/chat/MessageItem'
import { ThinkingBlock } from '@/features/chat/ThinkingBlock'
import { CopyButton } from '@/components/CopyButton'
import { Markdown } from '@/lib/markdown'
import { call, callQuiet } from '@/lib/bridge'
import { buildCompletedRows, useTurnStore } from '@/store/turnStore'
import { useSessionStore } from '@/store/sessionStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useUiStore } from '@/store/uiStore'
import { formatCost, formatTokens, preview } from '@/lib/format'

export interface ChatViewProps {
  /** Rendered when there is no session and no draft text. */
  emptyState: React.ReactNode
}

export function ChatView({ emptyState }: ChatViewProps): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const settings = useSettingsStore((state) => state.settings)
  const secret = useSettingsStore((state) => state.secret)
  const notify = useUiStore((state) => state.notify)
  const setView = useUiStore((state) => state.setView)

  const activeId = useSessionStore((state) => state.activeId)
  const detail = useSessionStore((state) => state.detail)
  const loadingDetail = useSessionStore((state) => state.loadingDetail)
  const loadSessions = useSessionStore((state) => state.loadSessions)
  const selectSession = useSessionStore((state) => state.selectSession)
  const applyCompletedTurn = useSessionStore((state) => state.applyCompletedTurn)
  const refreshDetail = useSessionStore((state) => state.refreshDetail)

  const turn = useTurnStore()
  const send = useTurnStore((state) => state.send)
  const stop = useTurnStore((state) => state.stop)
  const reset = useTurnStore((state) => state.reset)

  const scroller = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  // Guards the completion hand-off so a `turn.finished` for a session the
  // student has already left does not splice rows into the wrong transcript.
  const settled = useRef<string | null>(null)

  const streamingHere = turn.streaming && turn.sessionId === activeId
  const hasDraft = draft.trim() !== ''

  // Keep the viewport pinned to the newest content, unless the student has
  // deliberately scrolled up to read something.
  useEffect(() => {
    const element = scroller.current
    if (element === null || !pinnedToBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [detail, turn.text, turn.reasoning, turn.toolCards, streamingHere])

  const onScroll = useCallback(() => {
    const element = scroller.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    pinnedToBottom.current = distance < 80
  }, [])

  // Navigating away from a streaming session leaves the turn running — the
  // student may switch back — but the transcript on screen stops following it,
  // which `streamingHere` already guarantees by comparing session ids.

  // Hand a finished turn over to the session store exactly once. The key
  // includes the message id, so a second turn in the same session is not
  // swallowed by the first one's marker.
  useEffect(() => {
    if (turn.phase !== 'idle' || turn.streaming) return
    const sessionKey = turn.sessionId
    if (sessionKey === null) return
    const key = `${sessionKey}:${turn.messageId ?? ''}`
    if (settled.current === key) return
    settled.current = key

    const rows = buildCompletedRows(
      sessionKey,
      turn.messageId,
      turn.text,
      turn.reasoning,
      turn.toolCards,
      turn.usage
    )
    // Show the streamed parts immediately, then reconcile with SQLite, which
    // is the source of truth and persists as the turn streams (§13.6).
    if (rows.messages.length > 0 || rows.toolCalls.length > 0) {
      applyCompletedTurn(rows.messages, rows.toolCalls)
    }
    void loadSessions()
    void refreshDetail()
  }, [
    turn.phase,
    turn.streaming,
    turn.sessionId,
    turn.messageId,
    turn.text,
    turn.reasoning,
    turn.toolCards,
    turn.usage,
    applyCompletedTurn,
    loadSessions,
    refreshDetail
  ])

  const blockedReason = useMemo(() => {
    if (secret !== null && !secret.configured) return 'Add an OpenRouter API key in Settings first.'
    if (settings.modelId === null) return 'Choose a model in Settings first.'
    return null
  }, [secret, settings.modelId])

  const onSend = useCallback(() => {
    if (blockedReason !== null) {
      notify('warn', blockedReason)
      setView('settings')
      return
    }
    const text = draft.trim()
    if (text === '') return

    void (async () => {
      let sessionId = activeId
      if (sessionId === null) {
        // First message of a new conversation: main creates the session, and
        // derives the title from the message.
        const created = await callQuiet<{ id: string } | null>(
          'Starting a new conversation',
          async (api) => {
            const session = await api.createSession({
              modelId: settings.modelId,
              preferredLanguage: settings.preferredLanguage
            })
            return { id: session.id }
          },
          null,
          (error) => notify('error', error.message)
        )
        if (created === null) return
        sessionId = created.id
        setDraft('')
        reset()
        pinnedToBottom.current = true
        await send(sessionId, text)
        await selectSession(sessionId)
        await loadSessions()
        return
      }

      setDraft('')
      pinnedToBottom.current = true
      await send(sessionId, text)
    })()
  }, [
    activeId,
    blockedReason,
    draft,
    loadSessions,
    notify,
    reset,
    selectSession,
    send,
    settings.modelId,
    settings.preferredLanguage
  ])

  const onStop = useCallback(() => {
    if (activeId !== null) void stop(activeId)
  }, [activeId, stop])

  const storedToolCallsByMessage = useMemo(() => {
    const map = new Map<string, ToolCall[]>()
    for (const call of detail?.toolCalls ?? []) {
      const list = map.get(call.messageId)
      if (list === undefined) map.set(call.messageId, [call])
      else list.push(call)
    }
    return map
  }, [detail?.toolCalls])

  const messages: Message[] = detail?.messages ?? []
  const isEmpty = messages.length === 0 && !hasDraft && !streamingHere

  const liveParts = useMemo(() => {
    if (!streamingHere) return []

    // Same split as the stored transcript: failed attempts are folded into the
    // thinking block rather than shown as steps, but they keep their position
    // so a "Step 2" reference from the model still lines up.
    const ordered = turn.toolCards.slice().sort((a, b) => a.seq - b.seq)

    return ordered
      .filter((card) => !isFailedStatus(card.status))
      .map((card) => (
        <ExecutionCard
          key={card.toolCallId}
          source={toExecutionSource(card)}
          index={ordered.indexOf(card)}
        />
      ))
  }, [streamingHere, turn.toolCards])

  const liveFailures = useMemo(() => {
    if (!streamingHere) return []
    return turn.toolCards
      .filter((card) => isFailedStatus(card.status))
      .map((card) => describeFailure(card.toolCallId, card.error, card.status))
  }, [streamingHere, turn.toolCards])

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat__inner">
          {isEmpty ? <div className="chat__empty">{emptyState}</div> : null}

          {loadingDetail && messages.length === 0 ? (
            <p className="chat__loading">Loading conversation…</p>
          ) : null}

          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              toolCalls={storedToolCallsByMessage.get(message.id) ?? []}
              showThinking={settings.showThinking}
            />
          ))}

          {streamingHere ? (
            <section className="message message--live" data-role="assistant" data-status="streaming">
              <header className="message__head">
                <span className="message__role">ISHKAPON</span>
                <span className="message__time">working…</span>
              </header>

              {turn.reasoning.trim() !== '' || liveFailures.length > 0 ? (
                <ThinkingBlock
                  reasoning={turn.reasoning}
                  streaming
                  show={settings.showThinking}
                  failures={liveFailures}
                />
              ) : null}

              {turn.text.trim() === '' && turn.toolCards.length === 0 ? (
                <p className="message__status message__status--muted">
                  {turn.compaction === 'running' ? 'Compacting earlier messages…' : 'Reading the problem…'}
                </p>
              ) : null}

              {turn.text.trim() !== '' ? (
                <Markdown className="message__markdown">{turn.text}</Markdown>
              ) : null}

              {liveParts}

              {turn.error !== null ? (
                <p className="message__status message__status--error">
                  {turn.error}
                  {turn.errorFatal ? ' This conversation cannot continue until the problem is fixed.' : ''}
                </p>
              ) : null}

              <footer className="message__foot">
                {turn.text.trim() === '' ? null : (
                  <CopyButton value={turn.text} label="Copy response" />
                )}
                {turn.usage !== null ? (
                  <span className="message__usage">
                    <span>in {formatTokens(turn.usage.tokensIn)}</span>
                    <span>out {formatTokens(turn.usage.tokensOut)}</span>
                    <span>{formatCost(turn.usage.costUsd)}</span>
                  </span>
                ) : null}
              </footer>
            </section>
          ) : null}
        </div>
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={onSend}
        onStop={onStop}
        streaming={streamingHere}
        stopping={turn.phase === 'stopping'}
        blockedReason={blockedReason}
        autoFocus
      />
    </div>
  )
}

/** Compact one-line summary of a session for the sidebar tooltip. */
export function sessionPreview(messages: Message[]): string {
  const first = messages.find((message) => message.role === 'user')
  return first === undefined ? '' : preview(first.content, 80)
}

/** Reads the running summary for the transparency panel (spec §10.3). */
export async function fetchSummary(sessionId: string): Promise<string | null> {
  const detail = await call('Reading the conversation summary', (api) => api.getSession(sessionId))
  return detail?.session.summary ?? null
}
