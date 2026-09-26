/**
 * API key entry (spec §9.2).
 *
 * The plaintext key transits the renderer exactly once — as the student types
 * it — and is never read back. The component therefore shows only what
 * `SecretStatus` reports: whether a key exists and its last four characters.
 *
 * A `backendWarning` means the OS has no real secret store (Linux
 * `basic_text`), so the stored value is effectively plaintext. That is stated
 * plainly, as a prominent banner, rather than left for the student to
 * discover.
 */
import { useState } from 'react'
import type { SecretStatus } from '@shared/types'
import { useSettingsStore } from '@/store/settingsStore'
import { useUiStore } from '@/store/uiStore'

export function ApiKeyPanel(): React.JSX.Element {
  const secret = useSettingsStore((state) => state.secret)
  const setApiKey = useSettingsStore((state) => state.setApiKey)
  const clearApiKey = useSettingsStore((state) => state.clearApiKey)
  const askConfirm = useUiStore((state) => state.askConfirm)
  const notify = useUiStore((state) => state.notify)

  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)

  const status: SecretStatus | null = secret
  const configured = status?.configured === true
  const insecure = status?.backendWarning !== null && status?.backendWarning !== undefined

  const submit = (): void => {
    const key = value.trim()
    if (key === '') return
    setBusy(true)
    void setApiKey(key).then((result) => {
      setBusy(false)
      // The field is cleared either way: on success the key is stored, and on
      // failure the student should retype it rather than leave it lying in a
      // React state value.
      setValue('')
      if (result.ok) notify('success', 'The API key was saved.')
      else if (result.error !== undefined) notify('error', result.error)
    })
  }

  return (
    <section className="settings__section">
      <h2 className="settings__heading">OpenRouter API key</h2>

      {insecure ? (
        <div className="banner banner--warn" role="alert">
          <strong>This computer has no secure key storage.</strong>{' '}
          {status?.backendWarning} The key will be stored unencrypted, so anyone with access to
          this account can read it. On Windows and macOS the key is encrypted by the operating
          system instead.
        </div>
      ) : null}

      <p className="settings__body">
        {configured ? (
          <>
            A key is configured{' '}
            {status?.hint !== null && status?.hint !== undefined ? (
              <>
                ending in <code className="md-inline-code">{status.hint}</code>
              </>
            ) : null}
            . Enter a new key to replace it.
          </>
        ) : (
          'No key is configured yet. ISHKAPON cannot answer anything until one is saved.'
        )}
      </p>

      <div className="api-key">
        <input
          className="field__input api-key__input"
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
          placeholder="sk-or-v1-…"
          autoComplete="off"
          spellCheck={false}
          aria-label="OpenRouter API key"
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setReveal((current) => !current)}
          aria-pressed={reveal}
        >
          {reveal ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={value.trim() === '' || busy}
        >
          {busy ? 'Saving…' : 'Save key'}
        </button>
      </div>

      {configured ? (
        <button
          type="button"
          className="btn btn--danger btn--quiet"
          onClick={() =>
            askConfirm({
              title: 'Remove the stored API key?',
              body: 'ISHKAPON will not be able to answer anything until you enter a new key.',
              confirmLabel: 'Remove key',
              onConfirm: () => void clearApiKey()
            })
          }
        >
          Remove key
        </button>
      ) : null}

      <p className="field__hint">
        The key is encrypted by the operating system and never returned to this window. Create one
        at openrouter.ai/keys. Free models are listed below, so a key with no credits still works.
      </p>
    </section>
  )
}
