/**
 * One stored message plus the execution cards that belong to it.
 *
 * The transcript comes from SQLite, so a reloaded session renders through the
 * same component as a live turn — there is no separate "history" renderer.
 */
import type { Message, ToolCall } from '@shared/types'
import { ExecutionCard, toStoredExecutionSource } from '@/features/chat/ExecutionCard'
import { ThinkingBlock } from '@/features/chat/ThinkingBlock'
import { CopyButton } from '@/components/CopyButton'
import { Markdown } from '@/lib/markdown'
import { formatCost, formatDateTime, formatTokens } from '@/lib/format'

export interface MessageItemProps {
  message: Message
  toolCalls: ToolCall[]
  showThinking: boolean
}

const ROLE_LABEL: Record<Message['role'], string> = {
  user: 'You',
  assistant: 'ISHKAPON',
  system: 'System',
  tool: 'Tool'
}

export function MessageItem({ message, toolCalls, showThinking }: MessageItemProps): React.JSX.Element {
  const ordered = [...toolCalls].sort((a, b) => a.seq - b.seq)
  const hasContent = message.content.trim() !== ''
  const hasThinking = message.reasoning !== null && message.reasoning.trim() !== ''

  return (
    <article className="message" data-role={message.role} data-status={message.status}>
      <header className="message__head">
        <span className="message__role">{ROLE_LABEL[message.role]}</span>
        <span className="message__time" title={formatDateTime(message.createdAt)}>
          {formatDateTime(message.createdAt)}
        </span>
      </header>

      {hasThinking ? (
        <ThinkingBlock
          reasoning={message.reasoning ?? ''}
          streaming={message.status === 'streaming'}
          show={showThinking}
        />
      ) : null}

      {hasContent ? (
        message.role === 'user' ? (
          <p className="message__user-text">{message.content}</p>
        ) : (
          <Markdown className="message__markdown">{message.content}</Markdown>
        )
      ) : null}

      {ordered.map((call, index) => (
        <ExecutionCard key={call.id} source={toStoredExecutionSource(call)} index={index} />
      ))}

      {message.status === 'error' ? (
        <p className="message__status message__status--error">
          This message was not completed. The turn ended with an error.
        </p>
      ) : null}
      {message.status === 'cancelled' ? (
        <p className="message__status message__status--muted">
          Stopped before it finished.
        </p>
      ) : null}
      {message.status === 'streaming' ? (
        <p className="message__status message__status--muted">Still writing…</p>
      ) : null}

      <footer className="message__foot">
        {message.role === 'assistant' && hasContent ? (
          <CopyButton value={message.content} label="Copy response" />
        ) : null}
        <span className="message__usage">
          {message.tokensIn !== null || message.tokensOut !== null ? (
            <>
              <span title="Prompt tokens">in {formatTokens(message.tokensIn)}</span>
              <span title="Completion tokens">out {formatTokens(message.tokensOut)}</span>
            </>
          ) : null}
          {message.costUsd !== null ? <span title="Cost of this turn">{formatCost(message.costUsd)}</span> : null}
        </span>
      </footer>
    </article>
  )
}
