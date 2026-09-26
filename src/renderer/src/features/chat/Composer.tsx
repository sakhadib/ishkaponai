/**
 * The composer. A plain textarea with Enter-to-send and Shift+Enter for a
 * newline, an auto-growing height, and a Stop button while a turn is running.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { containsBangla } from '@/lib/format'

const MAX_TEXTAREA_HEIGHT = 220

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  stopping: boolean
  /** Disables sending and shows a reason in the hint line. */
  blockedReason: string | null
  autoFocus?: boolean
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  stopping,
  blockedReason,
  autoFocus = false
}: ComposerProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null)

  // Grow with the content, up to a cap, then scroll.
  useLayoutEffect(() => {
    const element = textarea.current
    if (element === null) return
    element.style.height = 'auto'
    const next = Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)
    element.style.height = `${next}px`
    element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
  }, [value])

  useEffect(() => {
    if (autoFocus) textarea.current?.focus()
  }, [autoFocus])

  const canSend = value.trim() !== '' && !streaming && blockedReason === null

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      if (canSend) onSend()
    },
    [canSend, onSend]
  )

  const hint = blockedReason ?? (containsBangla(value) ? 'Enter to send · Shift+Enter for a new line' : null)

  return (
    <div className="composer">
      {hint === null ? null : <p className="composer__hint">{hint}</p>}
      <div className="composer__row">
        <textarea
          ref={textarea}
          className="composer__input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a physics, chemistry, or mathematics problem…"
          rows={1}
          spellCheck={false}
          aria-label="Your problem"
        />
        {streaming ? (
          <button
            type="button"
            className="btn btn--stop"
            onClick={onStop}
            disabled={stopping}
            title="Stop generating and interrupt any running calculation"
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onSend} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
