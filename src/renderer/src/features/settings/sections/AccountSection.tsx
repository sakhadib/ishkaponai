/**
 * Account: the OpenRouter API key.
 *
 * Its own section because it is the one setting that can stop the app working
 * at all, and because the key has a lifecycle the other settings do not: it is
 * written once, never read back, and can only be replaced or cleared.
 */
import { ApiKeyPanel } from '@/features/settings/ApiKeyPanel'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { useSettingsStore } from '@/store/settingsStore'

export function AccountSection(): React.JSX.Element {
  const secret = useSettingsStore((state) => state.secret)
  const configured = secret?.configured ?? false

  return (
    <SettingsPanel
      title="Account"
      description={
        configured
          ? 'ISHKAPON talks to OpenRouter using your own key. It is stored encrypted by the operating system and never shown to the app again.'
          : 'ISHKAPON has no backend of its own. It talks to OpenRouter directly using a key you supply, and nothing is sent anywhere else.'
      }
    >
      <ApiKeyPanel />
    </SettingsPanel>
  )
}
