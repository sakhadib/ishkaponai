/**
 * The inline execution card (spec §13.5).
 *
 * This is the product's evidence panel: the Python that ran, the output it
 * produced, the value it returned, any error, how long it took, and a visible
 * marker when the output was capped. Every number in an answer is traceable to
 * one of these, so nothing here is collapsed by default while the turn runs.
 */
import { useMemo } from 'react'
import type { ToolCall } from '@shared/types'
import type { ToolCard } from '@/store/turnStore'
import { CopyButton } from '@/components/CopyButton'
import { formatDuration } from '@/lib/format'

/** What the card shows for a call, whether it is streaming or already stored. */
export interface ExecutionSource {
  id: string
  code: string
  output: string
  resultValue: string | null
  error: string | null
  status: ToolCall['status']
  durationMs: number | null
  truncated: boolean
}

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  running: 'Running',
  complete: 'Complete',
  error: 'Error',
  timeout: 'Timed out',
  cancelled: 'Cancelled'
}

/**
 * Statuses that mean "this attempt did not produce a result".
 *
 * A failed attempt is not a step. The model occasionally calls the tool with
 * malformed arguments and immediately retries, and surfacing that as a step
 * shows a student a raw AI SDK validation error they have no way to act on. The
 * attempt is still recorded — it is in SQLite and visible to a developer — but
 * in the UI it is folded into the collapsed thinking block.
 *
 * A `running` call is deliberately *not* in this set: it is work in progress,
 * not a failure, and hiding it would make the UI look stuck.
 */
const FAILED_STATUSES: ReadonlySet<ToolCall['status']> = new Set<ToolCall['status']>([
  'error',
  'timeout',
  'cancelled'
])

export function isFailedStatus(status: ToolCall['status']): boolean {
  return FAILED_STATUSES.has(status)
}

/** A failed attempt, reduced to what a student needs: that it happened, and why. */
export interface FailedAttempt {
  id: string
  /** Short, non-technical label. Never the raw error. */
  reason: string
  /** Raw text, exposed only as a tooltip for anyone who wants to dig in. */
  detail: string | null
}

/**
 * Maps a raw tool error onto a short human label.
 *
 * The raw text is things like
 * `AI_InvalidToolInputError: ... AI_TypeValidationError: Value: {}`, which is
 * SDK internals. Showing it verbatim to a school student is noise at best, so it
 * is reduced to a phrase and the original is kept only for the tooltip.
 */
export function describeFailure(
  id: string,
  error: string | null,
  status: ToolCall['status']
): FailedAttempt {
  if (status === 'timeout') return { id, reason: 'timed out', detail: error }
  if (status === 'cancelled') return { id, reason: 'stopped before it finished', detail: error }
  if (error === null || error.trim() === '') return { id, reason: 'failed', detail: null }

  if (/AI_InvalidToolInputError|AI_TypeValidationError|tool input/i.test(error)) {
    return { id, reason: 'was called incorrectly', detail: error }
  }
  if (/AI_NoSuchToolError|no such tool|unknown tool/i.test(error)) {
    return { id, reason: 'asked for a tool that does not exist', detail: error }
  }
  if (/interrupt/i.test(error)) return { id, reason: 'was interrupted', detail: error }

  // Unknown shape: show the first line, trimmed, rather than nothing at all.
  const firstLine = error.split('\n')[0]?.trim() ?? ''
  const short = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
  return { id, reason: short === '' ? 'failed' : short, detail: error }
}

export function toExecutionSource(card: ToolCard): ExecutionSource {
  return {
    id: card.toolCallId,
    code: card.code,
    output: card.output,
    resultValue: card.resultValue,
    error: card.error,
    status: card.status,
    durationMs: card.durationMs,
    truncated: card.truncated
  }
}

export function toStoredExecutionSource(call: ToolCall): ExecutionSource {
  return {
    id: call.id,
    code: call.code,
    output: call.stdout ?? '',
    resultValue: call.resultValue,
    error: call.error,
    status: call.status,
    durationMs: call.durationMs,
    truncated: call.truncated
  }
}

export interface ExecutionCardProps {
  source: ExecutionSource
  /** Ordinal within the turn, so the student can follow "step 3 of 5". */
  index: number
}

export function ExecutionCard({ source, index }: ExecutionCardProps): React.JSX.Element {
  const hasOutput = source.output !== ''
  const hasResult = source.resultValue !== null && source.resultValue !== ''
  const live = source.status === 'running'

  // Copying the code *and* its result together is what makes the card useful
  // for checking work, so the button takes both rather than just the source.
  const copyValue = useMemo(() => {
    const parts = [source.code.trimEnd()]
    if (hasOutput) parts.push(source.output.trimEnd())
    if (hasResult) parts.push(source.resultValue ?? '')
    return parts.join('\n')
  }, [source.code, source.output, source.resultValue, hasOutput, hasResult])

  return (
    <section className="exec-card" data-status={source.status} aria-label={`Python step ${index + 1}`}>
      <header className="exec-card__bar">
        <span className="exec-card__title">
          <span className="exec-card__step">Step {index + 1}</span>
          <span className="exec-card__tool">python</span>
        </span>
        <span className="exec-card__status">
          <span className="exec-card__status-label">{STATUS_LABEL[source.status]}</span>
          {source.durationMs !== null ? (
            <span className="exec-card__duration">{formatDuration(source.durationMs)}</span>
          ) : null}
          <CopyButton value={copyValue} label="Copy step" />
        </span>
      </header>

      <pre className="exec-card__code">
        <code>{source.code}</code>
      </pre>

      {hasOutput ? (
        <div className="exec-card__section">
          <h4 className="exec-card__label">Output</h4>
          <pre className="exec-card__output">
            <code>{source.output}</code>
          </pre>
          {source.truncated ? (
            <p className="exec-card__truncated" role="status">
              Output was truncated at the 64 KB cap. The result above is complete only up to that
              point.
            </p>
          ) : null}
        </div>
      ) : null}

      {hasResult ? (
        <div className="exec-card__section">
          <h4 className="exec-card__label">Returned value</h4>
          <pre className="exec-card__result">
            <code>{source.resultValue}</code>
          </pre>
        </div>
      ) : null}

      {source.error !== null && source.error !== '' ? (
        <div className="exec-card__section">
          <h4 className="exec-card__label">Error</h4>
          <pre className="exec-card__error">
            <code>{source.error}</code>
          </pre>
        </div>
      ) : null}

      {live ? <p className="exec-card__live">Executing…</p> : null}
    </section>
  )
}
