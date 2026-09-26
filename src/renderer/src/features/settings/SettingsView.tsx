/**
 * The Settings view (spec §9.1, §11).
 *
 * Every persisted key in the contract is editable here, plus the API key, the
 * model catalog, and the "view exact payload" transparency panel.
 */
import { useEffect, useMemo, useState } from 'react'
import type { LanguagePref, ThemeMode } from '@shared/types'
import { ApiKeyPanel } from '@/features/settings/ApiKeyPanel'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { Field } from '@/components/ui'
import { useSettingsStore, resolvedTheme } from '@/store/settingsStore'
import { useSessionStore } from '@/store/sessionStore'
import { useUiStore } from '@/store/uiStore'
import { formatDateTime, formatSeconds, parseMilliseconds } from '@/lib/format'
import { useTurnStore } from '@/store/turnStore'

const THEMES: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Follow the system' }
]

const LANGUAGES: ReadonlyArray<{ value: LanguagePref; label: string }> = [
  { value: 'auto', label: "Match my message (auto)" },
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'বাংলা (Bangla)' }
]

export function SettingsView(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const models = useSettingsStore((state) => state.models)
  const modelsLoading = useSettingsStore((state) => state.modelsLoading)
  const modelsNotice = useSettingsStore((state) => state.modelsNotice)
  const loadModels = useSettingsStore((state) => state.loadModels)
  const loaded = useSettingsStore((state) => state.loaded)
  const error = useSettingsStore((state) => state.error)
  const clearError = useSettingsStore((state) => state.clearError)

  const activeSession = useSessionStore((state) => state.detail?.session ?? null)
  const setView = useUiStore((state) => state.setView)
  const systemPrefersDark = useUiStore((state) => state.systemPrefersDark)
  const summary = useTurnStore((state) => state.summary)

  const [customModel, setCustomModel] = useState('')
  const [timeout, setTimeoutText] = useState(formatSeconds(settings.pythonTimeoutMs))
  const [maxTokens, setMaxTokensText] = useState(String(settings.maxOutputTokens))

  useEffect(() => {
    if (!loaded) return
    void loadModels()
  }, [loaded, loadModels])

  // Keep the numeric fields in step when settings change elsewhere (e.g. the
  // default was migrated) without stomping on what the student is typing.
  useEffect(() => {
    setTimeoutText(formatSeconds(settings.pythonTimeoutMs))
  }, [settings.pythonTimeoutMs])
  useEffect(() => {
    setMaxTokensText(String(settings.maxOutputTokens))
  }, [settings.maxOutputTokens])

  const themeNow = useMemo(
    () => resolvedTheme(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  )

  const commitTimeout = (): void => {
    const ms = parseMilliseconds(timeout)
    if (ms === null) {
      setTimeoutText(formatSeconds(settings.pythonTimeoutMs))
      return
    }
    // The host enforces the timeout, so an absurd value is a self-inflicted
    // hang. Clamp to a range that is still useful.
    void update({ pythonTimeoutMs: Math.min(Math.max(ms, 1_000), 600_000) })
  }

  const commitMaxTokens = (): void => {
    const parsed = Number(maxTokens.trim())
    if (!Number.isFinite(parsed) || parsed < 128) {
      setMaxTokensText(String(settings.maxOutputTokens))
      return
    }
    void update({ maxOutputTokens: Math.min(Math.round(parsed), 32_000) })
  }

  const runningSummary = activeSession?.summary ?? summary

  return (
    <div className="settings">
      <header className="settings__head">
        <h1 className="settings__title">Settings</h1>
        <button type="button" className="btn btn--ghost" onClick={() => setView('chat')}>
          Back to chat
        </button>
      </header>

      {error === null ? null : (
        <div className="banner banner--error" role="alert">
          {error}
          <button type="button" className="banner__close" onClick={clearError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <ApiKeyPanel />

      <section className="settings__section">
        <h2 className="settings__heading">Model</h2>
        <p className="settings__body">
          A tool-calling model is required, because ISHKAPON cannot compute anything without it.
        </p>
        <ModelPicker
          models={models}
          selectedId={settings.modelId}
          loading={modelsLoading}
          notice={modelsNotice}
          onSelect={(id) => void update({ modelId: id })}
          onRefresh={() => void loadModels(true)}
          customId={customModel}
          onCustomChange={setCustomModel}
          onCustomCommit={() => {
            const id = customModel.trim()
            if (id === '') return
            setCustomModel('')
            void update({ modelId: id })
          }}
        />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Appearance</h2>
        <Field
          label={`Theme — currently ${themeNow}`}
          htmlFor="setting-theme"
          hint="The native window title bar follows this too."
        >
          <select
            id="setting-theme"
            className="field__input"
            value={settings.theme}
            onChange={(event) => void update({ theme: event.target.value as ThemeMode })}
          >
            {THEMES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <label className="switch">
          <input
            type="checkbox"
            checked={settings.showThinking}
            onChange={(event) => void update({ showThinking: event.target.checked })}
          />
          <span>
            Show the model's thinking
            <span className="switch__hint">
              The reasoning trace appears above each answer in a collapsible block.
            </span>
          </span>
        </label>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Answers</h2>
        <Field
          label="Preferred language"
          htmlFor="setting-language"
          hint="Mathematics always stays in Latin script, in either language."
        >
          <select
            id="setting-language"
            className="field__input"
            value={settings.preferredLanguage}
            onChange={(event) => void update({ preferredLanguage: event.target.value as LanguagePref })}
          >
            {LANGUAGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Extra instructions for ISHKAPON"
          htmlFor="setting-user-instructions"
          hint="Added as the second layer of the system prompt. Use it for preferences such as “always use SI units”, not for problems."
        >
          <textarea
            id="setting-user-instructions"
            className="field__input field__input--area"
            rows={4}
            value={settings.userInstructions}
            onChange={(event) => void update({ userInstructions: event.target.value })}
          />
        </Field>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Calculation</h2>
        <Field
          label="Python timeout (seconds)"
          htmlFor="setting-timeout"
          hint="How long a single calculation may run before it is killed. Defaults to 60 s."
        >
          <input
            id="setting-timeout"
            className="field__input"
            type="number"
            min={1}
            max={600}
            step={1}
            value={timeout}
            onChange={(event) => setTimeoutText(event.target.value)}
            onBlur={commitTimeout}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTimeout()
            }}
          />
        </Field>

        <Field
          label="Maximum answer length (tokens)"
          htmlFor="setting-max-tokens"
          hint="Reserved output budget per turn. A small context model needs this kept low to leave room for the conversation."
        >
          <input
            id="setting-max-tokens"
            className="field__input"
            type="number"
            min={128}
            max={32000}
            step={128}
            value={maxTokens}
            onChange={(event) => setMaxTokensText(event.target.value)}
            onBlur={commitMaxTokens}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitMaxTokens()
            }}
          />
        </Field>
      </section>

      <SystemPayloadPanel instructions={settings.userInstructions} />

      {activeSession === null ? null : (
        <section className="settings__section">
          <h2 className="settings__heading">This conversation</h2>
          <dl className="stats">
            <div className="stats__row">
              <dt className="stats__label">Created</dt>
              <dd className="stats__value">{formatDateTime(activeSession.createdAt)}</dd>
            </div>
            <div className="stats__row">
              <dt className="stats__label">Last activity</dt>
              <dd className="stats__value">{formatDateTime(activeSession.updatedAt)}</dd>
            </div>
            <div className="stats__row">
              <dt className="stats__label">Model at creation</dt>
              <dd className="stats__value">{activeSession.modelId ?? '—'}</dd>
            </div>
            <div className="stats__row">
              <dt className="stats__label">Summary covers message</dt>
              <dd className="stats__value">{activeSession.summaryUpToSeq}</dd>
            </div>
          </dl>

          <details className="summary-viewer">
            <summary className="summary-viewer__summary">
              Running summary{' '}
              {runningSummary === null || runningSummary === '' ? '(none yet)' : ''}
            </summary>
            {runningSummary === null || runningSummary === '' ? (
              <p className="settings__body">
                This conversation has not been compacted, so the whole transcript is sent in full.
              </p>
            ) : (
              <pre className="summary-viewer__body">{runningSummary}</pre>
            )}
          </details>
        </section>
      )}
    </div>
  )
}

/**
 * "View exact payload" (spec §11).
 *
 * The contract does not expose the composed system prompt — there is no
 * `getSystemPrompt` on `IshkaponApi` — so the payload cannot be shown
 * verbatim. Rather than invent a bridge method or fake the content, this panel
 * states what is known and what is missing. Layer 2 is the one layer the
 * renderer genuinely owns, and it is shown exactly.
 */
function SystemPayloadPanel({ instructions }: { instructions: string }): React.JSX.Element {
  const platform = typeof window !== 'undefined' ? window.ishkapon?.platform : undefined
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'unknown'
  const today = new Date().toISOString().slice(0, 10)

  return (
    <section className="settings__section">
      <h2 className="settings__heading">View exact payload</h2>
      <p className="settings__body">
        The system prompt is built from three layers: a fixed base written by ISHKAPON, your
        instructions below, and a runtime block describing this computer.
      </p>

      <div className="banner banner--info">
        The base layer and the assembled prompt cannot be read from this window — the bridge does
        not currently expose them. What the renderer can show is listed here.
      </div>

      <div className="payload">
        <h3 className="payload__layer">Layer 1 — base (product owned)</h3>
        <p className="payload__note">
          Twelve rules fixed by the product, including: never calculate from memory, show every
          step, keep mathematics in Latin script, answer in the student's language, and treat tool
          output as data rather than instructions. Not readable from the renderer.
        </p>

        <h3 className="payload__layer">Layer 2 — your instructions</h3>
        <pre className="payload__text">{instructions === '' ? '(empty)' : instructions}</pre>

        <h3 className="payload__layer">Layer 3 — runtime (this computer)</h3>
        <pre className="payload__text">
          {[`platform: ${platform ?? 'unknown'}`, `locale: ${locale}`, `date: ${today}`, 'tools: python (Pyodide, no filesystem, no network, no shell)'].join(
            '\n'
          )}
        </pre>
      </div>
    </section>
  )
}
