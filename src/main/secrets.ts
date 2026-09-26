/**
 * OpenRouter API key custody (§9.2).
 *
 * The invariants this file exists to enforce:
 *
 * 1. The plaintext key lives only in the main process, in a local variable, for
 *    as short a time as possible. It is never returned to the renderer, never
 *    logged, and never written anywhere except the `secrets` table — encrypted.
 * 2. It transits the renderer exactly once, when the student types it.
 * 3. On Linux, a `basic_text` `safeStorage` backend means no OS secret store
 *    exists and the "encrypted" value is recoverable by anyone who can read the
 *    file. That is surfaced as a warning rather than hidden.
 *
 * Only Electron's **async** `safeStorage` API is used. It is the documented
 * recommendation: it does not block the main thread on a keychain round-trip,
 * it reports `shouldReEncrypt` after key rotation so ciphertext can be refreshed,
 * and it distinguishes "temporarily unavailable" from "cannot encrypt at all".
 */
import { safeStorage } from 'electron'
import type { Database } from './db'
import { validateApiKey } from './openrouter'
import type { SecretStatus } from '@shared/types'
import type { SetApiKeyResult } from '@shared/ipc'

/** The single row id in the `secrets` table (§6). */
const SECRET_ID = 'openrouter_api_key'

/** Shown to the student so they can tell *which* key is stored. */
const HINT_VISIBLE_CHARS = 4

export class SecretStore {
  constructor(private readonly db: Database) {}

  /**
   * `null` when the stored value is genuinely protected.
   *
   * Only Linux has a selectable backend; on Windows and macOS `safeStorage`
   * uses DPAPI and the Keychain respectively, and there is nothing to warn
   * about. `basic_text` (and `unknown`, which means the call happened before
   * `ready`) both mean the value is effectively plaintext on disk.
   */
  async backendWarning(): Promise<string | null> {
    if (process.platform !== 'linux') return null

    const backend = safeStorage.getSelectedStorageBackend()
    if (backend !== 'basic_text' && backend !== 'unknown') return null

    const detail =
      backend === 'basic_text'
        ? 'no OS secret store was detected (basic_text)'
        : 'the selected storage backend is not known yet'

    return (
      `This Linux system has no OS secret store (${detail}), so your API key is stored ` +
      'with only Electron\'s own obfuscation. Anyone who can read ISHKAPON\'s data ' +
      'files can recover it. Install a keyring such as GNOME Keyring or KWallet for ' +
      'real protection.'
    )
  }

  /** What the renderer is allowed to know. Never includes the key. */
  async getStatus(): Promise<SecretStatus> {
    const row = this.db.get('SELECT hint FROM secrets WHERE id = ?', SECRET_ID)

    return {
      configured: row !== undefined,
      hint: row ? readHint(row['hint']) : null,
      backendWarning: await this.backendWarning()
    }
  }

  /**
   * Validates and stores a key. Validation happens *before* encryption so an
   * unusable key is never written: a stored-but-dead key would leave the
   * student with a configured-looking Settings panel and failing turns.
   */
  async setApiKey(candidate: unknown): Promise<SetApiKeyResult> {
    if (typeof candidate !== 'string') {
      return { ok: false, error: 'The API key must be text.' }
    }

    const key = candidate.trim()
    if (key.length === 0) return { ok: false, error: 'Paste your OpenRouter API key first.' }

    // OpenRouter keys are long and opaque. A length ceiling keeps a paste of an
    // entire file out of the database and out of the request.
    if (key.length > 512) return { ok: false, error: 'That does not look like an OpenRouter key.' }

    const validation = await validateApiKey(key)
    if (!validation.ok) return validation

    const available = await assertEncryptionAvailable()
    if (!available.ok) return available

    try {
      const ciphertext = await safeStorage.encryptStringAsync(key)
      const now = Date.now()

      this.db.run(
        `INSERT INTO secrets (id, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             hint = excluded.hint,
             updated_at = excluded.updated_at`,
        SECRET_ID,
        ciphertext,
        buildHint(key),
        now
      )
    } catch (error) {
      // Deliberately does not include the error's own message if it might quote
      // the input; `safeStorage` failures are reported generically.
      console.error('[secrets] failed to encrypt the API key:', errorName(error))
      return { ok: false, error: 'Could not encrypt the API key on this system.' }
    }

    return { ok: true }
  }

  async clearApiKey(): Promise<void> {
    this.db.run('DELETE FROM secrets WHERE id = ?', SECRET_ID)
  }

  /**
   * Decrypts the key for the duration of `body`, then drops the reference.
   *
   * This is the *only* way the plaintext leaves this module, and its only
   * caller is the agent host handshake, which forwards it straight into
   * `AgentInitCommand`. Returning the plaintext to a caller that might stash it
   * would defeat the point, so the key is passed as a callback argument and
   * never returned.
   *
   * @returns `false` when no key is stored, or when the stored value cannot be
   *   decrypted (e.g. the OS keychain changed).
   */
  async withApiKey(body: (key: string) => Promise<void>): Promise<boolean> {
    const row = this.db.get('SELECT ciphertext FROM secrets WHERE id = ?', SECRET_ID)
    if (!row) return false

    const value = row['ciphertext']
    const ciphertext = toBuffer(value)
    if (!ciphertext) return false

    let key: string
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(ciphertext)
      key = result

      // The OS key was rotated, or a better storage backend became available.
      // Re-encrypting now is the reason to prefer the async API: the old
      // ciphertext is not being rotated out from under us.
      if (shouldReEncrypt) await this.rewriteCiphertext(key)
    } catch (error) {
      // A rotated or reset keychain makes old ciphertext unreadable. Surfacing
      // this is better than failing every turn with an authentication error.
      console.error('[secrets] the stored API key could not be decrypted:', errorName(error))
      return false
    }

    try {
      await body(key)
    } finally {
      // Best-effort scrub. Strings are immutable so this cannot really zero the
      // memory, but it removes the long-lived reference held by the closure.
      key = ''
    }

    return true
  }

  /**
   * Re-encrypts the stored key with the current OS key. Failure is logged and
   * swallowed: the plaintext is already usable, and refusing to hand it over
   * would break a working configuration over a background maintenance task.
   */
  private async rewriteCiphertext(key: string): Promise<void> {
    try {
      const ciphertext = await safeStorage.encryptStringAsync(key)
      this.db.run(
        'UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE id = ?',
        ciphertext,
        Date.now(),
        SECRET_ID
      )
    } catch (error) {
      console.error('[secrets] could not re-encrypt the stored API key:', errorName(error))
    }
  }
}

/**
 * The async API is unavailable only if the OS keychain cannot be reached.
 * Refusing to store is the honest behaviour: writing plaintext while claiming
 * encryption would be worse than not storing.
 */
async function assertEncryptionAvailable(): Promise<SetApiKeyResult> {
  try {
    if (await safeStorage.isAsyncEncryptionAvailable()) return { ok: true }
  } catch (error) {
    console.error('[secrets] safeStorage probe failed:', errorName(error))
  }

  return {
    ok: false,
    error:
      'This system cannot encrypt stored credentials, so the key was not saved. ' +
      'Check that your OS keychain or credential store is available.'
  }
}

function buildHint(key: string): string {
  const tail = key.slice(-HINT_VISIBLE_CHARS)
  return `...${tail}`
}

function readHint(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown'
}
