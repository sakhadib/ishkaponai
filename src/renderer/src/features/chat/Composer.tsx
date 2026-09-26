/**
 * The composer. A plain textarea with Enter-to-send and Shift+Enter for a
 * newline, an auto-growing height, and a Stop button while a turn is running.
 *
 * The textarea and the button share one bordered box rather than sitting side by
 * side, so the whole control reads as a single surface — and the focus ring
 * belongs to the box, which lights up the whole thing rather than one edge of it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { containsBangla } from '@/lib/format'

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

  /**
   * Grow with the content, up to the stylesheet's cap, then scroll inside.
   *
   * The height has to be assigned in pixels, not left to `height: auto`. A
   * `<textarea>`'s intrinsic height comes from its `rows` attribute, not from its
   * content, so `height: auto` on its own leaves the box at one line however much
   * is typed into it — and setting it to the value it already holds is a no-op,
   * so nothing even recomputes. The explicit measurement below is what makes it
   * grow.
   *
   * `useLayoutEffect`, not `useEffect`: this writes a layout property the browser
   * has to act on before the frame is painted, or the box visibly jumps on every
   * keystroke.
   */
  useLayoutEffect(() => {
    const element = textarea.current
    if (element === null) return

    // Reset first, so the `scrollHeight` read below is the full height of the
    // content rather than whatever the element is currently clipped to.
    element.style.height = 'auto'

    // The cap stays in the stylesheet as `max-height` and is read back here
    // rather than restated as a number. Two definitions of "seven lines" is two
    // definitions that drift; `getComputedStyle` resolves the calc to pixels.
    const limit = Number.parseFloat(window.getComputedStyle(element).maxHeight)
    const content = element.scrollHeight
    const ceiling = Number.isFinite(limit) ? limit : content

    element.style.height = `${Math.min(content, ceiling)}px`
    // Scroll only once there is genuinely more below, so the gutter does not
    // appear while the box is still growing towards the cap.
    element.style.overflowY = content > ceiling ? 'auto' : 'hidden'
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
      <div className="composer__box">
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
            className="btn btn--stop composer__send"
            onClick={onStop}
            disabled={stopping}
            title="Stop generating and interrupt any running calculation"
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary composer__send"
            onClick={onSend}
            disabled={!canSend}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
