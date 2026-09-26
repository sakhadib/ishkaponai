import { useState } from 'react'
import type { PingResult } from '@shared/types'

export default function PingPanel(): React.JSX.Element {
  const [result, setResult] = useState<PingResult | null>(null)
  const [pending, setPending] = useState(false)

  const send = async (): Promise<void> => {
    setPending(true)
    try {
      setResult(await window.ishkapon.ping('hello from the renderer'))
    } finally {
      setPending(false)
    }
  }

  return (
    <article className="card">
      <div className="card__head">
        <h2 className="card__title">IPC round trip</h2>
      </div>

      <p className="card__body">
        Sends a message through the preload bridge and awaits the main process reply.
      </p>

      <button className="btn" type="button" disabled={pending} onClick={() => void send()}>
        {pending ? 'Sending…' : 'Send ping'}
      </button>

      {result && (
        <dl className="stats stats--compact">
          <div className="stats__row">
            <dt className="stats__label">Echo</dt>
            <dd className="stats__value">{result.echo}</dd>
          </div>
          <div className="stats__row">
            <dt className="stats__label">Received</dt>
            <dd className="stats__value">{new Date(result.at).toLocaleTimeString()}</dd>
          </div>
          <div className="stats__row">
            <dt className="stats__label">App uptime</dt>
            <dd className="stats__value">{result.uptimeSeconds}s</dd>
          </div>
        </dl>
      )}
    </article>
  )
}
