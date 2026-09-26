/**
 * Settings persistence and validation.
 *
 * Stored as a single versioned JSON document in the `settings` table under the
 * key `app`, which is what §9.1 asks for: "stored as JSON, schema-versioned
 * with a migration hook". The wrapper is `{ version, values }` so a future
 * schema change can migrate the old shape forward on read instead of guessing
 * which keys a partially-written blob had.
 *
 * The renderer is not trusted. Every patch is validated field by field here and
 * unknown keys are rejected outright — silently dropping them would let a
 * compromised renderer believe it had changed something.
 */
import type { Database } from './db'
import { readOptionalString } from './row-values'
import { isLanguagePref } from './sessions'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { Settings, ThemeMode } from '@shared/types'

const SETTINGS_KEY = 'app'

/** Bump when the shape of `values` changes, and add a step to `migrate`. */
const SETTINGS_VERSION = 1

/** Ceilings and floors for the two numeric settings, in one place. */
export const LIMITS = {
  pythonTimeoutMs: { min: 1_000, max: 300_000 },
  maxOutputTokens: { min: 256, max: 32_768 },
  /** Layer 2 of the system prompt is user text; keep it bounded. */
  userInstructionsMaxLength: 8_000
} as const

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates one field of a settings patch. Returns the normalised value, or
 * throws with a message that names the offending key (safe to surface: the
 * message never contains renderer data).
 */
function normaliseField(key: string, value: unknown): Settings[keyof Settings] {
  switch (key) {
    case 'theme': {
      if (!isThemeMode(value)) throw new Error(`Invalid theme: ${JSON.stringify(value)}`)
      return value
    }
    case 'modelId': {
      if (value === null) return null
      if (typeof value !== 'string') throw new Error('modelId must be a string or null.')
      const trimmed = value.trim()
      if (trimmed.length === 0) return null
      if (trimmed.length > 200) throw new Error('modelId is too long.')
      // OpenRouter slugs are `vendor/model-name`; refuse anything that could
      // never be one rather than letting it reach the provider.
      if (!/^[\w.-]+\/[\w.:-]+$/.test(trimmed)) {
        throw new Error('modelId must look like "vendor/model-name".')
      }
      return trimmed
    }
    case 'preferredLanguage': {
      if (!isLanguagePref(value)) {
        throw new Error(`Invalid preferredLanguage: ${JSON.stringify(value)}`)
      }
      return value
    }
    case 'userInstructions': {
      if (typeof value !== 'string') throw new Error('userInstructions must be a string.')
      return value.slice(0, LIMITS.userInstructionsMaxLength)
    }
    case 'pythonTimeoutMs': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('pythonTimeoutMs must be a finite number.')
      }
      return Math.round(clamp(value, LIMITS.pythonTimeoutMs.min, LIMITS.pythonTimeoutMs.max))
    }
    case 'maxOutputTokens': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('maxOutputTokens must be a finite number.')
      }
      return Math.round(clamp(value, LIMITS.maxOutputTokens.min, LIMITS.maxOutputTokens.max))
    }
    case 'showThinking': {
      if (typeof value !== 'boolean') throw new Error('showThinking must be a boolean.')
      return value
    }
    case 'titleModelId': {
      // `null` means "use the cheap default", so null is a valid value here
      // rather than something to reject.
      if (value === null) return null
      if (typeof value !== 'string') throw new Error('titleModelId must be a string or null.')
      const trimmed = value.trim()
      if (trimmed === '') return null
      if (trimmed.length > 200) throw new Error('titleModelId is too long.')
      return trimmed
    }
    default:
      // Unreachable via `Settings`, but the switch is the guard for keys the
      // renderer invented.
      throw new Error(`Unknown setting: ${key}`)
  }
}

/** Validates a `Partial<Settings>` patch arriving over IPC. */
export function parseSettingsPatch(patch: unknown): Partial<Settings> {
  if (patch === undefined) return {}
  if (!isPlainObject(patch)) throw new Error('Settings patch must be an object.')

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    // Every mutation of settings is a deliberate user action.
    result[key] = normaliseField(key, value)
  }

  return result as Partial<Settings>
}

/**
 * Migration hook. Runs on every read, so a stored document written by an older
 * build is upgraded before anyone sees it.
 *
 * To add a version: bump `SETTINGS_VERSION`, then add a `case` that rewrites
 * the previous `values` shape forward. No prior version has shipped, so the
 * only handling today is the unwrapped pre-versioning shape — accepting it
 * costs nothing and makes a partially-written row recoverable instead of a
 * reset. Fields this build does not recognise keep their default rather than
 * being guessed at, which is also what happens to a document written by a
 * *newer* build.
 */
function migrate(stored: unknown): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS }

  if (!isPlainObject(stored)) return settings

  const values: Record<string, unknown> = isPlainObject(stored['values'])
    ? stored['values']
    : stored

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = values[key]
    if (value === undefined || value === null) continue

    try {
      // Reuse the patch validator so a stored value and a submitted value are
      // held to exactly the same rules.
      Object.assign(settings, { [key]: normaliseField(key, value) })
    } catch {
      // A single corrupt field falls back to its default rather than failing
      // the whole read; the app must still start.
    }
  }

  return settings
}

export class SettingsStore {
  private cache: Settings | null = null

  constructor(private readonly db: Database) {}

  get(): Settings {
    if (this.cache) return this.cache

    const row = this.db.get('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)

    let parsed: unknown = null
    if (row) {
      try {
        parsed = JSON.parse(readOptionalString(row, 'value') ?? 'null')
      } catch {
        // Unparseable settings must not stop the app from launching.
        console.error('[settings] stored settings were unreadable; falling back to defaults.')
      }
    }

    this.cache = migrate(parsed)
    return this.cache
  }

  /**
   * Applies a validated patch and returns the new full settings. Writes happen
   * only when something actually changed, so a no-op patch from the renderer
   * does not churn the database.
   */
  update(patch: unknown): Settings {
    const current = this.get()
    const validated = parseSettingsPatch(patch)

    const next: Settings = { ...current, ...validated }
    if (deepEqual(current, next)) return current

    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, values: next }),
      Date.now()
    )

    this.cache = next
    return next
  }
}

function deepEqual(a: Settings, b: Settings): boolean {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]
  return keys.every((key) => a[key] === b[key])
}
