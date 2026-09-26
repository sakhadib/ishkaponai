/**
 * Model: which model answers, and the model used for background chores.
 *
 * Separate from Account because the two are chosen at different times and for
 * different reasons: the key is a credential, the model is a preference.
 */
import { useEffect, useState } from 'react'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { Field } from '@/components/ui'
import { useSettingsStore } from '@/store/settingsStore'

export function ModelSection(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const models = useSettingsStore((state) => state.models)
  const modelsLoading = useSettingsStore((state) => state.modelsLoading)
  const modelsNotice = useSettingsStore((state) => state.modelsNotice)
  const loadModels = useSettingsStore((state) => state.loadModels)
  const loaded = useSettingsStore((state) => state.loaded)

  const [customModel, setCustomModel] = useState('')
  const [customBackground, setCustomBackground] = useState('')

  useEffect(() => {
    if (!loaded) return
    void loadModels()
  }, [loaded, loadModels])

  return (
    <SettingsPanel
      title="Model"
      description="A tool-calling model is required. ISHKAPON cannot compute anything without one, so a model that cannot call tools will not work here."
    >
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

      <div className="settings__divider" role="presentation" />

      <Field
        label="Model for background tasks"
        htmlFor="setting-title-model"
        hint="Session titles and context compaction. A small cheap model is the right choice here — these jobs run on every turn and never need a strong model. Leave empty to use a built-in default."
      >
        <input
          id="setting-title-model"
          className="field__input"
          type="text"
          value={settings.titleModelId ?? ''}
          placeholder="openai/gpt-4o-mini"
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value.trim()
            setCustomBackground(value)
            // Committed on blur so a half-typed slug is never persisted.
          }}
          onBlur={() => {
            const next = customBackground.trim()
            if (next === (settings.titleModelId ?? '')) return
            void update({ titleModelId: next === '' ? null : next })
          }}
        />
      </Field>
    </SettingsPanel>
  )
}
