/**
 * The Markdown pipeline (spec §13.1).
 *
 * `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex`, plus the
 * local `remarkBengaliNumeralsInMath` plugin that makes `২ + ৩` render as
 * `2 + 3` inside math (spec §13.2).
 *
 * Security posture, per spec §12.2 — model output is untrusted:
 *  - `rehype-raw` is deliberately absent, so raw HTML in the source is dropped
 *    rather than parsed.
 *  - `dangerouslySetInnerHTML` appears nowhere in this file or its children.
 *  - `img` is overridden: only `data:` URLs render, and anything else becomes a
 *    visible link to the source so a remote fetch is never even attempted.
 *  - `a` renders as a plain anchor; main's `will-navigate` handler diverts
 *    `http(s)` to the system browser, so no in-app navigation is possible.
 *  - Mermaid SVG is sanitised in `lib/svg.ts` and inserted via the DOM API.
 */
import { Children, isValidElement, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from '@/components/CodeBlock'
import { MermaidBlock } from '@/components/MermaidBlock'
import { remarkBengaliNumeralsInMath } from '@/lib/remarkNumerals'
import type { ReactNode } from 'react'

import 'katex/dist/katex.min.css'

/** Recursively flattens a React node tree to its text content. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** `language-python` -> `python`. */
function parseLanguage(className: string | undefined): string | null {
  if (className === undefined) return null
  for (const entry of className.split(/\s+/)) {
    if (entry.startsWith('language-')) {
      const name = entry.slice('language-'.length).trim()
      if (name !== '') return name
    }
  }
  return null
}

const MERMAID_LANGUAGES = new Set(['mermaid', 'mmd'])

/**
 * URL policy for model output.
 *
 * `react-markdown` applies a `urlTransform` to every `href`/`src` before the
 * component sees it, and its default allows only a handful of protocols — which
 * would also strip the `data:` images the spec calls for (matplotlib output,
 * §14). This policy is explicit rather than inherited:
 *
 *  - `data:image/{png,jpeg,gif,webp}` is allowed. Raster only: a
 *    `data:image/svg+xml` URL is an XML document that can carry script, and it
 *    is refused. The CSP independently limits `img-src` to `'self' data:`.
 *  - `http:`/`https:` is allowed for links. Main diverts navigation to the
 *    system browser, so nothing loads in-app.
 *  - everything else — `javascript:`, `data:text/html`, `file:`, `blob:`,
 *    `vbscript:` — becomes an empty string, which renders as a dead link with
 *    no executable target.
 */
function safeUrl(url: string): string {
  const value = url.trim()
  if (value === '') return ''

  const schemeEnd = value.indexOf(':')
  // A fragment or a relative path is fine.
  if (schemeEnd === -1) return value
  const scheme = value.slice(0, schemeEnd).toLowerCase()

  if (scheme === 'http' || scheme === 'https') return value
  if (scheme === 'data') {
    return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]*$/i.test(value) ? value : ''
  }
  return ''
}


/**
 * `pre` is where a fenced block lands. The default `<pre><code>` is replaced
 * wholesale, so the `code` override below only ever sees inline code.
 */
function PreBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  // A holder rather than two `let`s: the values are filled inside a callback,
  // and TypeScript's control-flow analysis would otherwise narrow the outer
  // bindings to their initial values and treat the reads as unreachable.
  const found: { language: string | null; source: string } = { language: null, source: '' }

  Children.forEach(children, (child) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return
    found.language = parseLanguage(child.props.className) ?? found.language
    found.source = textOf(child.props.children)
  })

  const language = found.language
  if (language !== null && MERMAID_LANGUAGES.has(language.toLowerCase())) {
    return <MermaidBlock source={found.source} />
  }
  return <CodeBlock language={language} source={found.source} />
}

const components: Components = {
  pre: ({ children }) => <PreBlock>{children}</PreBlock>,

  code: ({ children, className }) => (
    <code className={`md-inline-code${className ? ` ${className}` : ''}`}>{children}</code>
  ),

  // Remote images are never fetched: `img-src 'self' data:` would block them
  // anyway, but an explicit fallback shows the student what was referenced
  // instead of a broken-image glyph. `data:` images pass `safeUrl` above and
  // are rendered.
  img: ({ src, alt, title }) => {
    const source = typeof src === 'string' ? src : ''
    if (source !== '' && /^data:image\//i.test(source)) {
      return <img className="md-image" src={source} alt={alt ?? ''} title={title} />
    }
    return (
      <span className="md-image-blocked">
        {alt !== undefined && alt !== '' ? alt : source}
        {source === '' ? null : <span className="md-image-blocked__note"> (image not loaded)</span>}
      </span>
    )
  },

  // `target` is deliberately omitted: main opens external `http(s)` links in
  // the system browser via `will-navigate` and denies every popup. A rejected
  // href arrives empty, and then no anchor is rendered at all, so a
  // `javascript:` link is not even styled as a link.
  a: ({ href, children }) => {
    const target = typeof href === 'string' ? safeUrl(href) : ''
    if (target === '') return <span className="md-link md-link--dead">{children}</span>
    return (
      <a className="md-link" href={target} rel="noreferrer noopener">
        {children}
      </a>
    )
  },

  // GitHub-style tables need a scroll container on a narrow pane.
  table: ({ children }) => (
    <div className="md-table-scroll">
      <table className="md-table">{children}</table>
    </div>
  )
}

export interface MarkdownProps {
  children: string
  className?: string
}

export function Markdown({ children, className }: MarkdownProps): React.JSX.Element {
  // The plugin list is constant; `useMemo` keeps react-markdown from
  // re-parsing on every streamed delta.
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkMath, remarkBengaliNumeralsInMath],
    []
  )
  const rehypePlugins = useMemo(() => [rehypeKatex], [])

  return (
    <div className={className === undefined ? 'markdown' : `markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={safeUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
