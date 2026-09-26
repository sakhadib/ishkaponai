/**
 * Answers: how responses read.
 *
 * Language and the student's own standing instructions. Grouped together
 * because both change what an answer looks like rather than how the app
 * behaves.
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
