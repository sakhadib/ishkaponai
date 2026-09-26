/**
 * SQLite access layer.
 *
 * Uses Node's **built-in** `node:sqlite` module. This is deliberate: a native
 * module such as `better-sqlite3` would force an `electron-rebuild` step and a
 * prebuilt binary per platform/ABI, which is the single largest packaging risk
 * this project could take on. `node:sqlite` ships inside the Node build that
 * Electron already bundles.
 *
 * Two properties of this file are load-bearing:
 *
 * 1. **WAL.** Write-ahead logging lets the session sidebar keep reading while a
 *    streaming turn is being written, instead of the two blocking each other.
 *    `synchronous = NORMAL` is the standard companion setting: durable across
 *    application crashes (which is the case we actually care about) without an
 *    fsync per commit.
 * 2. **`foreign_keys = ON`.** SQLite disables foreign keys per connection by
 *    default, including for `ON DELETE CASCADE`. Without this pragma the
 *    session-deletion cascade in §6 of the spec silently does nothing and the
 *    database accumulates orphans.
 *
 * Statements are prepared once and cached: `node:sqlite` re-parses SQL on every
 * `prepare()`, and the message-append path runs on every streamed turn.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite'

/**
 * Bump when `SCHEMA_SQL` changes, and add the corresponding step to
 * `migrate()`. Recorded in SQLite's `user_version` header.
 */
const SCHEMA_VERSION = 2

/**
 * The schema of §6 of the specification, reproduced exactly. `IF NOT EXISTS`
 * everywhere so the statement is idempotent and safe to re-run on every launch.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  model_id          TEXT,
  subject           TEXT,
  preferred_language TEXT,
  summary           TEXT,
  summary_upto_seq  INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  reasoning   TEXT,
  status      TEXT NOT NULL,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  tool          TEXT NOT NULL DEFAULT 'python',
  code          TEXT NOT NULL,
  stdout        TEXT,
  result_value  TEXT,
  error         TEXT,
  status        TEXT NOT NULL,
  duration_ms   INTEGER,
  truncated     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id          TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  hint        TEXT,
  updated_at  INTEGER NOT NULL
);

/**
 * Token spend, one row per local calendar day.
 *
 * This exists because the obvious place for it - messages.tokens_in - is wrong.
 * Deleting a chat cascades to its messages, so a total read off the transcript
 * shrinks when the student tidies up, and a number that goes *down* after a
 * delete is not a spending record. This table has no foreign key to sessions at
 * all, which is what makes the total monotonic: the only way a figure leaves it
 * is the app being deleted.
 *
 * One row per day rather than per turn because every period the page shows
 * (today, this week, this month, this year) is a range of whole days, so each
 * becomes a single indexed range scan. Per-turn rows would be unbounded and
 * would buy nothing the page can display.
 *
 * The day column is a local YYYY-MM-DD, not a UTC date and not an epoch. A UTC
 * key would file a 1am conversation in Asia/Dhaka under *yesterday*, which is
 * the kind of off-by-one that makes a daily figure look wrong with no way to
 * explain it.
 */
CREATE TABLE IF NOT EXISTS usage_daily (
  day         TEXT PRIMARY KEY,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL    NOT NULL DEFAULT 0,
  turns       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_toolcalls_session ON tool_calls(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`

/** A row as returned by `StatementSync`, widened for ergonomic narrowing. */
export type Row = Record<string, SQLOutputValue>

export class Database {
  private readonly handle: DatabaseSync

  private readonly statements = new Map<string, StatementSync>()

  private closed = false

  /**
   * @param file Absolute path to the database, or `':memory:'` for a throwaway
   *   database (used by the dev self-check in `dev/db-check.ts`).
   */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })

    this.handle = new DatabaseSync(file)

    // WAL: readers never block on the streaming writer. On `:memory:` SQLite
    // keeps the `memory` journal, which is correct for a throwaway database.
    this.handle.exec('PRAGMA journal_mode = WAL')
    this.handle.exec('PRAGMA synchronous = NORMAL')
    this.handle.exec('PRAGMA busy_timeout = 5000')
    // Cascade deletes in §6 are inert without this.
    this.handle.exec('PRAGMA foreign_keys = ON')

    this.migrate()
  }

  /**
   * Applies pending schema migrations. `user_version` is a SQLite header field
   * meant for exactly this; it avoids inventing a migration bookkeeping table
   * inside the frozen §6 schema.
   */
  private migrate(): void {
    const row = this.handle.prepare('PRAGMA user_version').get()
    const current = typeof row?.user_version === 'number' ? row.user_version : 0

    if (current >= SCHEMA_VERSION) return

    this.handle.exec(SCHEMA_SQL)

    // `PRAGMA user_version` does not accept bound parameters. The value is a
    // module-level integer constant, never renderer input, so interpolation is
    // safe here.
    this.handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /** Prepares `sql`, reusing the cached statement on subsequent calls. */
  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached

    const statement = this.handle.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.prepare(sql).get(...params)
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.prepare(sql).all(...params)
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    const { changes } = this.prepare(sql).run(...params)
    return typeof changes === 'bigint' ? Number(changes) : changes
  }

  /**
   * Runs `body` inside an immediate transaction. Immediate rather than deferred
   * so the write lock is taken up front: a deferred transaction that upgrades
   * mid-way can fail with `SQLITE_BUSY`, which is unrecoverable mid-batch.
   */
  transaction<T>(body: () => T): T {
    this.assertOpen()
    this.handle.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.handle.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK')
      } catch {
        // A failed rollback means the transaction was already aborted by SQLite.
      }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    this.handle.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The ISHKAPON database is closed.')
  }
}
