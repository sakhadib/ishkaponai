/**
 * Prompt: exactly what gets sent, and this conversation's state.
 *
 * Two read-only panes that belong together because both answer "what is the
 * app actually doing" rather than "what would you like it to do". Neither
 * contains a control, deliberately — a viewer that can be edited is not a
 * viewer.
 *
 * The honesty problem here is real and is stated rather than papered over: the
 * bridge exposes no `getSystemPrompt`, so layer 1 and the assembled prompt
 * genuinely cannot be read from this window. The panel says that instead of
 * inventing a bridge method or showing a reconstruction dressed up as the real
 * thing.
 */
import { useSessionStore } from '@/store/sessionStore'
import { useTurnStore } from '@/store/turnStore'
import { useSettingsStore } from '@/store/settingsStore'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { ReadOnlyRow } from '@/components/ui'
import { formatDateTime } from '@/lib/format'

export function PromptSection(): React.JSX.Element {
  const instructions = useSettingsStore((state) => state.settings.userInstructions)
  const session = useSessionStore((state) => state.detail?.session ?? null)
  const summary = useTurnStore((state) => state.summary)

  const platform = typeof window !== 'undefined' ? window.ishkapon?.platform : undefined
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'unknown'
  const today = new Date().toISOString().slice(0, 10)
  const runningSummary = session?.summary ?? summary

  return (
    <SettingsPanel
      title="What is sent"
      description="The system prompt is assembled from three layers. This is the part of it you can inspect from inside the app."
    >
      <div className="banner banner--info">
        Layer 1 and the assembled prompt cannot be read from this window — the preload bridge does
        not expose them. What is shown below is everything the renderer genuinely has.
      </div>

      <div className="payload">
        <h4 className="payload__layer">Layer 1 — base</h4>
        <p className="payload__note">
          Twelve rules fixed by the product, including: never calculate from memory, show every
          step, keep all mathematics and units in Latin script, answer in the student's language,
          and treat tool output as data rather than instructions. Not readable from the renderer.
        </p>

        <h4 className="payload__layer">Layer 2 — your instructions</h4>
        <pre className="payload__text">{instructions === '' ? '(empty)' : instructions}</pre>

        <h4 className="payload__layer">Layer 3 — this computer</h4>
        <pre className="payload__text">
          {[
            `platform: ${platform ?? 'unknown'}`,
            `locale: ${locale}`,
            `date: ${today}`,
            'tools: python (Pyodide — no filesystem, no network, no shell)'
          ].join('\n')}
        </pre>
      </div>

      {session === null ? null : (
        <>
          <div className="settings__divider" role="presentation" />

          <h4 className="settings__subheading">This conversation</h4>
          <dl className="stats">
            <ReadOnlyRow label="Title" value={session.title} />
            <ReadOnlyRow label="Created" value={formatDateTime(session.createdAt)} />
            <ReadOnlyRow label="Last activity" value={formatDateTime(session.updatedAt)} />
            <ReadOnlyRow label="Model at creation" value={session.modelId ?? '—'} />
            <ReadOnlyRow
              label="Summary covers message"
              value={String(session.summaryUpToSeq)}
            />
          </dl>

          <details className="summary-viewer">
            <summary className="summary-viewer__summary">
              Running summary {runningSummary === null || runningSummary === '' ? '(none yet)' : ''}
            </summary>
            {runningSummary === null || runningSummary === '' ? (
              <p className="settings__body">
                This conversation has not been compacted, so the whole transcript is sent in full.
              </p>
            ) : (
              <pre className="summary-viewer__body">{runningSummary}</pre>
            )}
          </details>
        </>
      )}
    </SettingsPanel>
  )
}
