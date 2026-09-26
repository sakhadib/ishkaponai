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
import { onAgentEvent } from '@/lib/bridge'
import type { Message, ToolCall } from '@shared/types'
import { Composer } from '@/features/chat/Composer'
import { WelcomePane } from '@/features/chat/WelcomePane'
import {
  ExecutionCard,
  describeFailure,
  isFailedStatus,
  toExecutionSource
} from '@/features/chat/ExecutionCard'
import { MessageItem } from '@/features/chat/MessageItem'
import { ThoughtBlock } from '@/features/chat/ThoughtBlock'
import { CopyButton } from '@/components/CopyButton'
import { Markdown } from '@/lib/markdown'
import { call, callQuiet } from '@/lib/bridge'
import { buildCompletedRows, isTurnSettled, useTurnStore } from '@/store/turnStore'
import { useSessionStore } from '@/store/sessionStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useUiStore } from '@/store/uiStore'
import { formatCost, formatTokens, preview } from '@/lib/format'

export interface ChatViewProps {
  /**
   * Shown in place of the greeting when the app cannot answer yet — no API key,
   * or no model chosen. Explaining the product is only useful while the student
   * cannot start.
   */
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
  const showUserMessage = useSessionStore((state) => state.showUserMessage)

  const scroller = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  // Guards the completion hand-off so a `turn.finished` for a session the
  // student has already left does not splice rows into the wrong transcript.
  const settled = useRef<string | null>(null)

  const streamingHere = turn.streaming && turn.sessionId === activeId

  const messages: Message[] = detail?.messages ?? []

  /**
   * The new-session page.
   *
   * Note what is *not* here: `draft`. Typing a problem must not make the
   * greeting disappear out from under a student who is about to send it. The
   * page holds until the conversation actually starts.
   */
  const welcome = messages.length === 0 && !streamingHere

  /**
   * First run, or the app cannot chat yet. The greeting is suppressed here on
   * purpose — "Good morning, Nusrat" above a Send button that cannot work is
   * worse than saying plainly what is missing.
   */
  const needsSetup = (secret !== null && !secret.configured) || settings.modelId === null

  // Keep the viewport pinned to the newest content, unless the student has
  // deliberately scrolled up to read something.
  //
  // `welcome` is in the deps because leaving the new-session page gives the
  // scroller its height back. The effect that fired on the first message ran
  // while it was still collapsed, so the scroll would not have taken, and
  // nothing would change afterwards to make it try again.
  useEffect(() => {
    const element = scroller.current
    if (element === null || !pinnedToBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [detail, turn.text, turn.reasoning, turn.toolCards, streamingHere, welcome])

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
  //
  // "Finished" includes a turn that *failed*. A failed turn streamed real text
  // and ran real calculations, and gating on `phase === 'idle'` meant that
  // content was never handed over — so the live view was hidden (streaming had
  // gone false) and nothing had replaced it. The transcript silently rewrote
  // itself to omit the question, the partial answer and the error. Reloading
  // brought all of it back, because SQLite had it the whole time.
  useEffect(() => {
    if (!isTurnSettled(turn.phase, turn.streaming)) return
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
      turn.usage,
      // Matches what main writes to the same row. A stopped turn arrives as
      // `turn.finished`, so main records it as `complete` and so must this, or
      // the streamed view and the reloaded transcript would disagree about the
      // same row.
      turn.phase === 'error' ? 'error' : 'complete'
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
        const started = await send(sessionId, text)
        // The new session has no `detail` yet, so the question is shown by
        // selecting it — which is also what gives the transcript something to
        // hold the answer.
        await selectSession(sessionId)
        if (started !== null) showUserMessage(started.userMessage)
        await loadSessions()
        return
      }

      setDraft('')
      pinnedToBottom.current = true
      // The question goes on screen here, before the model has produced a single
      // token. It used to wait for the turn to end and the transcript to be
      // re-read, so a second message in a session was invisible for the entire
      // time the student was waiting for the answer to it.
      const started = await send(sessionId, text)
      if (started !== null) showUserMessage(started.userMessage)
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
    settings.preferredLanguage,
    showUserMessage
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

  // Sorted once, then split: the cards go inside the Thought toggle, and the
  // failures are summarised there rather than rendered as steps.
  const liveOrdered = useMemo(() => {
    if (!streamingHere) return []
    return turn.toolCards.slice().sort((a, b) => a.seq - b.seq)
  }, [streamingHere, turn.toolCards])

  const liveCards = useMemo(
    () => liveOrdered.filter((card) => !isFailedStatus(card.status)),
    [liveOrdered]
  )

  const liveParts = useMemo(
    () =>
      liveCards.map((card) => (
        <ExecutionCard
          key={card.toolCallId}
          source={toExecutionSource(card)}
          index={liveOrdered.indexOf(card)}
        />
      )),
    [liveCards, liveOrdered]
  )

  const liveFailures = useMemo(() => {
    if (!streamingHere) return []
    return liveOrdered
      .filter((card) => isFailedStatus(card.status))
      .map((card) => describeFailure(card.toolCallId, card.error, card.status))
  }, [streamingHere, liveOrdered])

  /**
   * Whether the failure notice belongs on this transcript.
   *
   * Scoped to the session that produced it, and to a turn that is actually
   * over. Without the first check, a failure in a background session would
   * surface in whichever conversation the student happened to be reading.
   */
  const showTurnError =
    turn.error !== null && turn.sessionId !== null && turn.sessionId === activeId

  // A generated title belongs to the session, not the turn, so it is applied
  // straight to the session store rather than buffered here.
  const applyGeneratedTitle = useSessionStore((state) => state.applyGeneratedTitle)
  useEffect(() => {
    if (activeId === null) return
    return onAgentEvent((event) => {
      if (event.type === 'title.suggested' && event.sessionId === activeId) {
        applyGeneratedTitle(event.sessionId, event.title)
      }
    })
  }, [activeId, applyGeneratedTitle, onAgentEvent])

  return (
    <div className="chat" data-mode={welcome ? 'welcome' : 'chat'}>
      <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat__inner">
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

              {turn.reasoning.trim() !== '' ||
              liveCards.length > 0 ||
              liveFailures.length > 0 ? (
                <ThoughtBlock
                  reasoning={turn.reasoning}
                  streaming
                  show={settings.showThinking}
                  stepCount={liveCards.length}
                  failures={liveFailures}
                  steps={liveParts}
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

          {/*
            The failure notice, deliberately *outside* the live section.

            It used to live inside it, which meant it vanished at exactly the
            moment it mattered: a failed turn sets `streaming` false, the live
            section stopped rendering, and the explanation of what went wrong went
            with it — at the same instant the partial answer and its cards did.
            Here it survives the handover, because the text and cards have by
            now become ordinary messages and this is the only thing left saying
            the turn did not finish.
          */}
          {showTurnError ? (
            <p className="message__status message__status--error" role="alert">
              {turn.error}
              {turn.errorFatal ? ' This conversation cannot continue until the problem is fixed.' : ''}
            </p>
          ) : null}
        </div>
      </div>

      {/*
        One dock, always in the same place in the tree. The welcome page only
        changes how this is laid out — the composer is never unmounted, so the
        focus and the half-typed draft survive moving from the centre of an
        empty screen to the bottom of a transcript.
      */}
      <div className="chat__dock">
        {welcome ? (
          needsSetup ? (
            <div className="welcome">
              {emptyState}
            </div>
          ) : (
            <WelcomePane name={settings.studentName} />
          )
        ) : null}

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
