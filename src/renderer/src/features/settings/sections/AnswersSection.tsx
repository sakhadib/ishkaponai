/**
 * Answers: how responses read.
 *
 * Language, the student's own standing instructions, and how much of the
 * model's working is left visible. Grouped together because all three change
 * what an answer *looks like* rather than how the app behaves — which is why
 * `showThinking` came here when the Appearance pane went (D28) rather than
 * leaving the setting homeless.
 */
import type { LanguagePref } from '@shared/types'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { Field } from '@/components/ui'
import { useSettingsStore } from '@/store/settingsStore'

const LANGUAGES: ReadonlyArray<{ value: LanguagePref; label: string }> = [
  { value: 'auto', label: 'Match my message' },
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'বাংলা (Bangla)' }
]

export function AnswersSection(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  return (
    <SettingsPanel
      title="Answers"
      description="How ISHKAPON writes its solutions. The mathematics always stays in Latin script, whichever language you pick here."
    >
      <Field
        label="Preferred language"
        htmlFor="setting-language"
        hint="“Match my message” follows whichever language you wrote the question in."
      >
        <select
          id="setting-language"
          className="field__input"
          value={settings.preferredLanguage}
          onChange={(event) =>
            void update({ preferredLanguage: event.target.value as LanguagePref })
          }
        >
          {LANGUAGES.map((option) => (
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
          Show the working
          <span className="switch__hint">
            The reasoning trace, and every calculation with its code and output, appear above each
            answer in a collapsible block. Turn this off for a plain answer with no working.
          </span>
        </span>
      </label>

      <Field
        label="Extra instructions"
        htmlFor="setting-user-instructions"
        hint="Added to the system prompt for every question. Use it for standing preferences such as “always use SI units” or “be brief”, not for individual problems."
      >
        <textarea
          id="setting-user-instructions"
          className="field__input field__input--area"
          rows={5}
          value={settings.userInstructions}
          placeholder="e.g. Always round to 3 significant figures."
          onChange={(event) => void update({ userInstructions: event.target.value })}
        />
      </Field>
    </SettingsPanel>
  )
}
