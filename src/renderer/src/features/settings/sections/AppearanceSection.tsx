/**
 * Appearance: theme, and how much of the agent's working is shown.
 */
import { useMemo } from 'react'
import type { ThemeMode } from '@shared/types'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { Field } from '@/components/ui'
import { useSettingsStore, resolvedTheme } from '@/store/settingsStore'
import { useUiStore } from '@/store/uiStore'

const THEMES: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Follow the system' }
]

export function AppearanceSection(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const systemPrefersDark = useUiStore((state) => state.systemPrefersDark)

  const themeNow = useMemo(
    () => resolvedTheme(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  )

  return (
    <SettingsPanel title="Appearance" description="How the app looks, and how much of the model's working is left visible.">
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
            The reasoning trace, and every calculation with its code and output, appear above each
            answer in a collapsible block. Turn this off for a plain answer with no working.
          </span>
        </span>
      </label>
    </SettingsPanel>
  )
}
