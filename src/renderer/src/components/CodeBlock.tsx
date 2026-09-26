/**
 * A fenced code block with its own copy button (spec §13.1).
 *
 * Bengali numerals are normalised here as well as in `remark-math`: a Python
 * step the model wrote with `২.৫` must display and copy as `2.5`.
 */
import { useMemo } from 'react'
import { normalizeNumerals } from '@/lib/numerals'
import { CopyButton } from '@/components/CopyButton'

export interface CodeBlockProps {
  /** Info string after the opening fence, e.g. `python`. Null when absent. */
  language: string | null
  source: string
}

export function CodeBlock({ language, source }: CodeBlockProps): React.JSX.Element {
  const normalised = useMemo(() => normalizeNumerals(source), [source])

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{language ?? 'text'}</span>
        <CopyButton value={normalised} label="Copy code" />
      </div>
      <pre className="code-block__pre">
        <code className={language === null ? undefined : `language-${language}`}>{normalised}</code>
      </pre>
    </div>
  )
}
