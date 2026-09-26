/**
 * Calculation: the limits on the Python sandbox.
 *
 * These are the settings with real consequences — a timeout that is too long
 * leaves the student waiting on a computation that will never finish, and an
 * output budget that is too large starves a small-context model of room for the
 * conversation itself. Both are grouped here rather than scattered.
 */
import { useEffect, useState } from 'react'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { Field } from '@/components/ui'
import { useSettingsStore } from '@/store/settingsStore'
import { formatSeconds, parseMilliseconds } from '@/lib/format'

export function CalculationSection(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  const [timeout, setTimeoutText] = useState(formatSeconds(settings.pythonTimeoutMs))
  const [maxTokens, setMaxTokensText] = useState(String(settings.maxOutputTokens))

  // Track changes made elsewhere (a migration, another window) without
  // stomping on what is being typed here.
  useEffect(() => {
    setTimeoutText(formatSeconds(settings.pythonTimeoutMs))
  }, [settings.pythonTimeoutMs])

  useEffect(() => {
    setMaxTokensText(String(settings.maxOutputTokens))
  }, [settings.maxOutputTokens])

  const commitTimeout = (): void => {
    const ms = parseMilliseconds(timeout)
    if (ms === null) {
      setTimeoutText(formatSeconds(settings.pythonTimeoutMs))
      return
    }
    // The host enforces this, so an absurd value is a self-inflicted hang.
    // Clamped to a range that is still useful.
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

  return (
    <SettingsPanel
      title="Calculation"
      description="Every number in an answer is produced by Python running in a sandbox with no filesystem, no network, and no shell. These are its limits."
    >
      <Field
        label="Timeout (seconds)"
        htmlFor="setting-timeout"
        hint="How long one calculation may run before it is killed. Long enough for a numerical integration, short enough that a mistake does not hang the app."
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
        hint="Output budget reserved per turn. Lower it for a small-context model so the conversation has room to continue."
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
    </SettingsPanel>
  )
}
