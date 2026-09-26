/**
 * Settings, secret status, and the model catalog.
 *
 * The store only ever *reflects* what main says: it calls `updateSettings` and
 * lets main re-emit, rather than merging a patch locally. That keeps a single
 * writer for the persisted document.
 *
 * There is no theme here, and nothing to reflect. The app is light-only (D28),
 * so the palette is a CSS concern with no round trip through IPC.
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
      // `notice` is how main says "this list is not the real one". It arrives
      // alongside a usable list rather than instead of one, so a failed fetch
      // must not clear the models — only the throw path does that.
      const result = await call('Loading the model list', (api) => api.listModels(forceRefresh))
      set({ models: result.models, modelsLoading: false, modelsNotice: result.notice })
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

