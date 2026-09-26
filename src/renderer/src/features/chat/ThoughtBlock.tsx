/**
 * The collapsible "thought" disclosure that sits above an answer.
 *
 * This holds *everything* about how the answer was reached: the model's
 * reasoning, every execution card with its code and output, and any attempt
 * that failed and was retried. The answer itself renders below it, clean, with
 * equations and no code — which is what a student actually reads.
 *
 * Behaviour:
 *  - **Open while the turn is running**, so the work is watchable. A block that
 *    is being written to and is invisible reads as a hang.
 *  - **Then it stays open.** It used to fold away three seconds after the answer
 *    landed, which meant a student part-way through reading the last step had it
 *    taken out from under them. The screen is theirs; closing this is their
 *    click, not the app's.
 *  - Nothing here scrolls on its own. The whole page scrolls, once, and nothing
 *    is ever out of reach behind an inner scrollbar.
 *
 * Gated by the `showThinking` setting; turning it off hides the evidence
 * entirely, which is the student's choice to make.
 */
import { useState, type ReactNode } from 'react'
import type { FailedAttempt } from '@/features/chat/ExecutionCard'
import { preview } from '@/lib/format'

export interface ThoughtBlockProps {
  reasoning: string
  /** True while the turn that produced it is still streaming. */
  streaming: boolean
  show: boolean
  /** Execution cards for this turn. */
  steps: ReactNode
  /** How many steps ran, for the collapsed summary. */
  stepCount: number
  /** Tool calls that failed, folded out of the way. */
  failures: FailedAttempt[]
}

function stepLabel(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`
}

function failureLabel(failures: FailedAttempt[]): string {
  return failures.length === 1 ? '1 retry' : `${failures.length} retries`
}

export function ThoughtBlock({
  reasoning,
  streaming,
  show,
  steps,
  stepCount,
  failures
}: ThoughtBlockProps): React.JSX.Element | null {
  const trimmed = reasoning.trim()
  // Open on arrival, and never closed by anything but the student. Seeding from
  // `streaming` is enough: a stored turn renders already settled and stays open,
  // a live one is open, and neither needs a timer to get there.
  const [open, setOpen] = useState(true)

  if (!show) return null

  const empty = trimmed === '' && stepCount === 0 && failures.length === 0
  if (empty) return null

  return (
    <details
      className="thought"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="thought__summary">
        <span className="thought__label">{streaming ? 'Thinking…' : 'Thinking'}</span>
        {stepCount > 0 ? <span className="thought__badge">{stepLabel(stepCount)}</span> : null}
        {failures.length > 0 ? (
          <span className="thought__badge thought__badge--muted">{failureLabel(failures)}</span>
        ) : null}
        {open ? null : (
          <span className="thought__preview">
            {preview(trimmed === '' ? 'Show the working' : trimmed, 90)}
          </span>
        )}
      </summary>

      <div className="thought__body">
        {trimmed === '' ? null : <div className="thought__text">{trimmed}</div>}

        {stepCount > 0 ? <div className="thought__steps">{steps}</div> : null}

        {failures.length > 0 ? (
          <details className="thought__failures">
            <summary className="thought__failures-summary">{failureLabel(failures)}</summary>
            <ul className="thought__failures-list">
              {failures.map((failure) => (
                <li
                  key={failure.id}
                  className="thought__failure"
                  title={failure.detail ?? undefined}
                >
                  A calculation {failure.reason}. The model moved on and used a later step instead.
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  )
}
