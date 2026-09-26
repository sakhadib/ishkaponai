/**
 * The new-session page: a centred composer with a greeting above it.
 *
 * The whole thing is a function of the local clock and the student's name, so
 * the component's only real job is keeping the clock reasonably fresh without
 * making the words move under the student while they read them.
 */
import { useEffect, useState } from 'react'
import { greetingFor, promptFor } from '@/features/chat/welcome'

export interface WelcomePaneProps {
  /** From Personalise. Empty or unknown is fine — the greeting adapts. */
  name: string
}

/** How often the clock is re-read. A band boundary is never finer than an hour. */
const TICK_MS = 60_000

export function WelcomePane({ name }: WelcomePaneProps): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => {
      const next = new Date()
      // Both strings are pure functions of the day and the hour band, so if the
      // band has not moved there is nothing to say that we have not said
      // already. Returning the previous value keeps the re-render off entirely,
      // rather than re-rendering to produce identical text.
      setNow((previous) => (sameSlot(previous, next) ? previous : next))
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="welcome">
      <h1 className="welcome__greeting">{greetingFor(now, name)}</h1>
      <p className="welcome__prompt">{promptFor(now)}</p>
    </div>
  )
}

/** True when a change in clock could not alter the greeting or the prompt. */
function sameSlot(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours()
  )
}
