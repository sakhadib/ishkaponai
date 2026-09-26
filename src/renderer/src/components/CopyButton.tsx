/**
 * A copy button that reports its own outcome for a moment, so the student gets
 * feedback without needing a toast for every click.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { copyText } from '@/lib/clipboard'

export interface CopyButtonProps {
  /** Exactly what goes on the clipboard — the raw Markdown, not rendered text. */
  value: string
  label?: string
  className?: string
}

type State = 'idle' | 'copied' | 'failed'

export function CopyButton({ value, label = 'Copy', className }: CopyButtonProps): React.JSX.Element {
  const [state, setState] = useState<State>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const onClick = useCallback(() => {
    void copyText(value).then((ok) => {
      setState(ok ? 'copied' : 'failed')
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 1600)
    })
  }, [value])

  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label

  return (
    <button
      type="button"
      className={`copy-button${className ? ` ${className}` : ''}`}
      data-state={state}
      onClick={onClick}
      disabled={value === ''}
      title="Copy the raw Markdown source"
    >
      {text}
    </button>
  )
}
