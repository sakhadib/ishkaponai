/**
 * A ```mermaid fence rendered as a diagram.
 *
 * Mermaid is loaded lazily, so the first diagram in a session pays the load.
 * A syntax or render failure falls back to the source text rather than an error
 * (spec §13.1), and "view source" plus a copy button are always available.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { renderMermaid } from '@/lib/mermaid'
import type { RenderOutcome } from '@/lib/mermaid'
import { parseSanitisedSvg } from '@/lib/svg'
import { CopyButton } from '@/components/CopyButton'

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; svg: SVGSVGElement }
  | { kind: 'failed'; message: string }

export interface MermaidBlockProps {
  source: string
}

export function MermaidBlock({ source }: MermaidBlockProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [showSource, setShowSource] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  // Mermaid needs a document-unique id; React's `useId` supplies colons, which
  // are legal in an id but awkward inside a CSS/URL fragment.
  const rawId = useId()
  const renderId = `ishk-mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    let cancelled = false
    setPhase({ kind: 'loading' })

    void renderMermaid(source, renderId).then((outcome: RenderOutcome) => {
      if (cancelled) return
      if (outcome.kind === 'error') {
        setPhase({ kind: 'failed', message: outcome.message })
        return
      }
      const sanitised = parseSanitisedSvg(outcome.svg)
      setPhase(
        sanitised === null
          ? { kind: 'failed', message: 'The rendered diagram could not be read safely.' }
          : { kind: 'ready', svg: sanitised }
      )
    })

    return () => {
      cancelled = true
    }
  }, [source, renderId])

  // Attach the sanitised SVG with the DOM API. This is the point of the
  // exercise: model-derived markup is never handed to an HTML parser.
  useEffect(() => {
    const container = host.current
    if (container === null || phase.kind !== 'ready') return
    container.replaceChildren(phase.svg)
    return () => container.replaceChildren()
  }, [phase])

  return (
    <figure className="mermaid" data-state={phase.kind}>
      <figcaption className="mermaid__bar">
        <span className="mermaid__label">
          {phase.kind === 'failed' ? 'Diagram source' : 'Diagram'}
        </span>
        <span className="mermaid__actions">
          <button
            type="button"
            className="copy-button"
            onClick={() => setShowSource((value) => !value)}
            aria-expanded={showSource}
          >
            {showSource ? 'Hide source' : 'View source'}
          </button>
          <CopyButton value={source} label="Copy diagram" />
        </span>
      </figcaption>

      {phase.kind === 'loading' ? <p className="mermaid__status">Rendering diagram…</p> : null}
      {phase.kind === 'failed' ? (
        <p className="mermaid__status" role="status">
          {phase.message} The source is shown below.
        </p>
      ) : null}

      {phase.kind === 'ready' ? (
        <div className="mermaid__canvas" ref={host} />
      ) : (
        // Source is the fallback rendering, so it is always shown on failure.
        <pre className="mermaid__source">
          <code>{source}</code>
        </pre>
      )}

      {showSource ? (
        <pre className="mermaid__source">
          <code>{source}</code>
        </pre>
      ) : null}
    </figure>
  )
}
