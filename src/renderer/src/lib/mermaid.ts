/**
 * Mermaid, loaded on demand.
 *
 * `mermaid` is several megabytes of bundled JavaScript. It must not be in the
 * initial chunk, so it is reached only through a dynamic `import()` that Vite
 * splits into its own file. The module is initialised exactly once, and every
 * concurrent caller awaits the same promise.
 */
import type { MermaidConfig } from 'mermaid'

type MermaidApi = {
  initialize: (config: MermaidConfig) => void
  parse: (text: string, options?: { suppressErrors?: boolean }) => Promise<boolean>
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let loading: Promise<MermaidApi | null> | null = null

/**
 * The renderer has no network access and a strict CSP, so mermaid must not
 * attempt to load its own external assets or fonts. Everything it needs is
 * either in the bundle or inlined into the SVG it produces.
 */
function configure(api: MermaidApi): MermaidApi {
  api.initialize({
    startOnLoad: false,
    // A rendering error must not throw past this module: the caller falls back
    // to showing the source, which is the documented behaviour (spec §13.1).
    securityLevel: 'strict',
    theme: 'neutral',
    fontFamily: "'Roboto', 'Kalpurush', sans-serif",
    themeVariables: {
      // Read from CSS custom properties so diagrams follow the app's theme.
      fontSize: '14px'
    },
    flowchart: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  })
  return api
}

/**
 * Loads mermaid, or returns `null` if it is unavailable. Never throws: a
 * diagram that cannot render degrades to its source text, which is preferable
 * to an error dialog in the middle of a worked solution.
 */
export function loadMermaid(): Promise<MermaidApi | null> {
  if (loading !== null) return loading

  loading = import('mermaid')
    .then((module) => {
      const api = (module.default ?? module) as unknown as MermaidApi
      return configure(api)
    })
    .catch((error: unknown) => {
      // A network blip in dev, or a stripped package in a broken build.
      console.warn('[mermaid] failed to load', error)
      return null
    })

  return loading
}

export type RenderOutcome =
  | { kind: 'svg'; svg: string }
  | { kind: 'error'; message: string }

/**
 * Validates then renders `source`. The two-step is deliberate: `parse` is what
 * reports a *syntax* error with a useful message, and running it first means a
 * broken diagram never produces a half-drawn SVG.
 */
export async function renderMermaid(source: string, id: string): Promise<RenderOutcome> {
  const api = await loadMermaid()
  if (api === null) return { kind: 'error', message: 'The diagram renderer is unavailable.' }

  try {
    const valid = await api.parse(source)
    if (!valid) return { kind: 'error', message: 'Mermaid could not parse this diagram.' }
  } catch (error) {
    return { kind: 'error', message: describeMermaidError(error) }
  }

  try {
    const { svg } = await api.render(id, source)
    if (svg === '') return { kind: 'error', message: 'Mermaid produced an empty diagram.' }
    return { kind: 'svg', svg }
  } catch (error) {
    return { kind: 'error', message: describeMermaidError(error) }
  }
}

/**
 * Mermaid throws a `Error` whose message is a decorated parse dump. Keep the
 * first meaningful line only — the student does not need a stack trace, and the
 * full text is available from the "view source" toggle anyway.
 */
function describeMermaidError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !/^mermaid\./i.test(entry))
  return line ?? 'The diagram could not be rendered.'
}
