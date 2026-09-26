/**
 * Settings, secret status, and the model catalog.
 *
 * `theme` is the interesting one: main owns resolution (it also drives
 * `nativeTheme`, so the native title bar matches), so the renderer only ever
 * *reflects* what settings say. The resolved `data-theme` on `<html>` is
 * re-asserted by preload, so this store must not write it directly — it calls
 * `updateSettings` and lets main re-emit.
 */
import { create } from 'zustand'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ModelInfo, SecretStatus, Settings } from '@shared/types'
import { call, callQuiet } from '@/lib/bridge'

export interface SettingsState {
  settings: Settings
  /** False until the first `getSettings` resolves. Gates the shell's chrome. */
  loaded: boolean
  secret: SecretStatus | null
  models: ModelInfo[]
  modelsLoading: boolean
  /** Non-null when models came from the bundled fallback list. */
  modelsNotice: string | null
  error: string | null

  load: () => Promise<void>
  loadSecret: () => Promise<void>
  loadModels: (forceRefresh?: boolean) => Promise<void>
  update: (patch: Partial<Settings>) => Promise<void>
  setApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>
  clearApiKey: () => Promise<void>
  clearError: () => void
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  secret: null,
  models: [],
  modelsLoading: false,
  modelsNotice: null,
  error: null,

  load: async () => {
    try {
      const settings = await call('Loading settings', (api) => api.getSettings())
      set({ settings, loaded: true, error: null })
    } catch (error) {
      set({ loaded: true, error: describeError(error) })
    }
  },

  loadSecret: async () => {
    const secret = await callQuiet<SecretStatus | null>(
      'Reading the API key status',
      (api) => api.getSecretStatus(),
      null,
      (error) => set({ error: describeError(error) })
    )
    set({ secret })
  },

  loadModels: async (forceRefresh = false) => {
    if (get().modelsLoading) return
    set({ modelsLoading: true, error: null })
    try {
      const models = await call('Loading the model list', (api) => api.listModels(forceRefresh))
      set({ models, modelsLoading: false, modelsNotice: null })
    } catch (error) {
      set({
        modelsLoading: false,
        models: [],
        modelsNotice: `The model list could not be loaded. ${describeError(error)}`
      })
    }
  },

  update: async (patch) => {
    // Apply optimistically so toggles feel instant, then reconcile with what
    // main actually stored (it clamps and normalises).
    const previous = get().settings
    set({ settings: { ...previous, ...patch } })
    try {
      const settings = await call('Saving settings', (api) => api.updateSettings(patch))
      set({ settings, error: null })
    } catch (error) {
      set({ settings: previous, error: describeError(error) })
    }
  },

  setApiKey: async (key) => {
    const trimmed = key.trim()
    if (trimmed === '') {
      return { ok: false, error: 'Enter an API key first.' }
    }
    try {
      const result = await call('Saving the API key', (api) => api.setApiKey(trimmed))
      if (!result.ok) {
        set({ error: result.error ?? 'The API key was rejected.' })
        return { ok: false, error: result.error }
      }
      set({ error: null })
      // Re-read status so the configured/hint state reflects the new key.
      await get().loadSecret()
      return { ok: true }
    } catch (error) {
      const message = describeError(error)
      set({ error: message })
      return { ok: false, error: message }
    }
  },

  clearApiKey: async () => {
    try {
      await call('Clearing the API key', (api) => api.clearApiKey())
      await get().loadSecret()
    } catch (error) {
      set({ error: describeError(error) })
    }
  },

  clearError: () => set({ error: null })
}))

/**
 * The theme main resolved for the *current* OS state. The store keeps the
 * user's *mode*; this selector reports the concrete value, which is what the
 * UI shows as "currently light".
 */
export function resolvedTheme(settings: Settings, systemPrefersDark: boolean): 'light' | 'dark' {
  if (settings.theme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return settings.theme
}
