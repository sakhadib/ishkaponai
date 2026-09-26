/**
 * The collapsible "thinking" block, gated by the `showThinking` setting
 * (spec §13.5). While the trace is still growing it starts open, because a
 * block that is being written to and is invisible reads as a hang.
 *
 * The block is also where **failed tool attempts are hidden**. A model that
 * calls the tool wrongly and immediately retries is behaving correctly — the
 * student does not need to see `AI_TypeValidationError` — but the attempt
 * should not simply vanish either, so it is summarised here as a count and
 * revealed only on request.
 */
import { useEffect, useState } from 'react'
import type { FailedAttempt } from '@/features/chat/ExecutionCard'
import { preview } from '@/lib/format'

export interface ThinkingBlockProps {
  reasoning: string
  /** True while the turn that produced it is still streaming. */
  streaming: boolean
  show: boolean
  /** Tool calls that failed, folded out of the main transcript. */
  failures?: FailedAttempt[]
}

function failureSummary(failures: FailedAttempt[]): string {
  const count = failures.length
  return count === 1 ? '1 failed attempt' : `${count} failed attempts`
}

export function ThinkingBlock({
  reasoning,
  streaming,
  show,
  failures = []
}: ThinkingBlockProps): React.JSX.Element | null {
  const trimmed = reasoning.trim()
  const [open, setOpen] = useState(streaming)

  // Follow the stream: open while writing, and let the student close it again.
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])

  // A turn can fail its only tool call without producing any reasoning at all,
  // and the attempt still needs somewhere to live.
  if (!show) return null
  if (trimmed === '' && failures.length === 0) return null

  return (
    <details
      className="thinking"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="thinking__summary">
        <span className="thinking__label">{streaming ? 'Thinking…' : 'Thinking'}</span>
        {failures.length > 0 ? (
          <span className="thinking__badge">{failureSummary(failures)}</span>
        ) : null}
        {open ? null : <span className="thinking__preview">{preview(trimmed, 90)}</span>}
      </summary>
      <div className="thinking__body">
        {trimmed === '' ? null : <div className="thinking__text">{trimmed}</div>}

        {failures.length > 0 ? (
          <details className="thinking__failures">
            <summary className="thinking__failures-summary">{failureSummary(failures)}</summary>
            <ul className="thinking__failures-list">
              {failures.map((failure) => (
                <li
                  key={failure.id}
                  className="thinking__failure"
                  title={failure.detail ?? undefined}
                >
                  A calculation {failure.reason}. The model moved on and used a
                  later step instead.
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  )
}
