/**
 * The collapsible "thinking" block, gated by the `showThinking` setting
 * (spec §13.5). While the trace is still growing it starts open, because a
 * block that is being written to and is invisible reads as a hang.
 */
import { useEffect, useState } from 'react'
import { preview } from '@/lib/format'

export interface ThinkingBlockProps {
  reasoning: string
  /** True while the turn that produced it is still streaming. */
  streaming: boolean
  show: boolean
}

export function ThinkingBlock({ reasoning, streaming, show }: ThinkingBlockProps): React.JSX.Element | null {
  const trimmed = reasoning.trim()
  const [open, setOpen] = useState(streaming)

  // Follow the stream: open while writing, and let the student close it again.
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])

  if (!show || trimmed === '') return null

  return (
    <details
      className="thinking"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="thinking__summary">
        <span className="thinking__label">
          {streaming ? 'Thinking…' : 'Thinking'}
        </span>
        {open ? null : <span className="thinking__preview">{preview(trimmed, 90)}</span>}
      </summary>
      <div className="thinking__body">{trimmed}</div>
    </details>
  )
}
