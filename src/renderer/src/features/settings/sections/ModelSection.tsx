/**
 * Model: which model answers, and the model used for background chores.
 *
 * Separate from Account because the two are chosen at different times and for
 * different reasons: the key is a credential, the model is a preference.
 */
import { useEffect, useState } from 'react'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
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

      {/* Background work is fixed, so this states what happens rather than
          offering a choice. Naming the model is the useful part: a student can
          see that titling their chats is not being billed to their key. */}
      <div className="settings__note">
        <p className="settings__note-line">
          <strong>Background tasks use OpenRouter’s free router.</strong> Naming a conversation
          and compacting a long one run on <code>openrouter/free</code>, which is always free.
        </p>
        <p className="settings__note-hint">
          Only the model you choose above is billed. Those jobs are housekeeping — they need no
          reasoning and no tools, so a strong model would be paying for nothing.
        </p>
      </div>
    </SettingsPanel>
  )
}
