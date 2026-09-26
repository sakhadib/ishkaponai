/**
 * Session, message and tool-call repository.
 *
 * All writes go through here so the mapping between SQLite rows and the frozen
 * `Session` / `Message` / `ToolCall` contracts lives in exactly one place.
 *
 * Two rules from §6 are enforced here rather than left to callers:
 *   - a session's transcript is never merged with another session's (§10.2), so
 *     every read is keyed on `session_id` alone;
 *   - tool calls are never pruned, because the student's work must stay
 *     auditable.
 */
import { randomUUID } from 'node:crypto'
import type { Database, Row } from './db'
import {
  readBoolean,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString
} from './row-values'
import type {
  LanguagePref,
  Message,
  MessageStatus,
  Role,
  Session,
  SessionDetail,
  Subject,
  ToolCall,
  ToolCallRecord,
  ToolCallStatus,
  TurnRecord
} from '@shared/types'

/** Title given to a session until its first user message supplies a real one. */
export const DEFAULT_SESSION_TITLE = 'New chat'

/** Auto-generated titles are truncated to this many characters (§13.5 sidebar). */
const TITLE_MAX_LENGTH = 60

const ROLES: readonly Role[] = ['user', 'assistant', 'system', 'tool']
const MESSAGE_STATUSES: readonly MessageStatus[] = ['streaming', 'complete', 'error', 'cancelled']
const TOOL_STATUSES: readonly ToolCallStatus[] = ['running', 'complete', 'error', 'timeout', 'cancelled']
const SUBJECTS: readonly Subject[] = ['physics', 'chemistry', 'math', 'general']
const LANGUAGES: readonly LanguagePref[] = ['auto', 'en', 'bn']

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export function isMessageStatus(value: unknown): value is MessageStatus {
  return typeof value === 'string' && (MESSAGE_STATUSES as readonly string[]).includes(value)
}

export function isToolCallStatus(value: unknown): value is ToolCallStatus {
  return typeof value === 'string' && (TOOL_STATUSES as readonly string[]).includes(value)
}

export function isSubject(value: unknown): value is Subject {
  return typeof value === 'string' && (SUBJECTS as readonly string[]).includes(value)
}

export function isLanguagePref(value: unknown): value is LanguagePref {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export function toSession(row: Row): Session {
  return {
    id: readString(row, 'id'),
    title: readString(row, 'title', DEFAULT_SESSION_TITLE),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    modelId: readOptionalString(row, 'model_id'),
    subject: isSubject(row['subject']) ? row['subject'] : null,
    // The column is nullable in SQL but the contract is not, so an absent value
    // degrades to the documented default.
    preferredLanguage: isLanguagePref(row['preferred_language'])
      ? row['preferred_language']
      : 'auto',
    summary: readOptionalString(row, 'summary'),
    summaryUpToSeq: readNumber(row, 'summary_upto_seq'),
    pinned: readBoolean(row, 'pinned')
  }
}

export function toMessage(row: Row): Message {
  return {
    id: readString(row, 'id'),
    sessionId: readString(row, 'session_id'),
    seq: readNumber(row, 'seq'),
    role: isRole(row['role']) ? row['role'] : 'assistant',
    content: readString(row, 'content'),
    reasoning: readOptionalString(row, 'reasoning'),
    status: isMessageStatus(row['status']) ? row['status'] : 'complete',
    tokensIn: readOptionalNumber(row, 'tokens_in'),
    tokensOut: readOptionalNumber(row, 'tokens_out'),
    costUsd: readOptionalNumber(row, 'cost_usd'),
    createdAt: readNumber(row, 'created_at')
  }
}

export function toToolCall(row: Row): ToolCall {
  return {
    id: readString(row, 'id'),
    sessionId: readString(row, 'session_id'),
    messageId: readString(row, 'message_id'),
    seq: readNumber(row, 'seq'),
    // v1 has exactly one tool (§7.1). A row claiming anything else is a bug;
    // report it as `python` rather than inventing a second tool.
    tool: 'python',
    code: readString(row, 'code'),
    stdout: readOptionalString(row, 'stdout'),
    resultValue: readOptionalString(row, 'result_value'),
    error: readOptionalString(row, 'error'),
    status: isToolCallStatus(row['status']) ? row['status'] : 'error',
    durationMs: readOptionalNumber(row, 'duration_ms'),
    truncated: readBoolean(row, 'truncated'),
    createdAt: readNumber(row, 'created_at')
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = `id, title, created_at, updated_at, model_id, subject,
  preferred_language, summary, summary_upto_seq, pinned`

export interface CreateSessionInput {
  title?: string
  modelId: string | null
  preferredLanguage: LanguagePref
  subject?: Subject | null
}

/**
 * Sidebar order: pinned sessions float to the top, then most recently updated.
 * Pinned sessions that have never been touched keep their creation order, which
 * is stable and therefore does not make the list jump around.
 */
export function listSessions(db: Database): Session[] {
  return db
    .all(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       ORDER BY pinned DESC, updated_at DESC, created_at DESC`
    )
    .map(toSession)
}

export function getSession(db: Database, id: string): Session | null {
  const row = db.get(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, id)
  return row ? toSession(row) : null
}

export function createSession(db: Database, input: CreateSessionInput): Session {
  const id = randomUUID()
  const now = Date.now()

  db.run(
    `INSERT INTO sessions
       (id, title, created_at, updated_at, model_id, subject, preferred_language, summary, summary_upto_seq, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
    id,
    input.title ?? DEFAULT_SESSION_TITLE,
    now,
    now,
    input.modelId,
    input.subject ?? null,
    input.preferredLanguage
  )

  const created = getSession(db, id)
  if (!created) throw new Error('Failed to create the session.')
  return created
}

/** Fields the renderer is allowed to change on an existing session. */
export interface SessionPatch {
  title?: string
  pinned?: boolean
  modelId?: string | null
  subject?: Subject | null
  preferredLanguage?: LanguagePref
}

export function updateSession(db: Database, id: string, patch: SessionPatch): Session {
  const assignments: string[] = []
  const params: (string | number | null)[] = []

  if (patch.title !== undefined) {
    assignments.push('title = ?')
    params.push(patch.title)
  }
  if (patch.pinned !== undefined) {
    assignments.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }
  if (patch.modelId !== undefined) {
    assignments.push('model_id = ?')
    params.push(patch.modelId)
  }
  if (patch.subject !== undefined) {
    assignments.push('subject = ?')
    params.push(patch.subject)
  }
  if (patch.preferredLanguage !== undefined) {
    assignments.push('preferred_language = ?')
    params.push(patch.preferredLanguage)
  }

  // `updated_at` moves on every edit, including a pin toggle, so the sidebar
  // reflects the user's most recent interaction with the session.
  assignments.push('updated_at = ?')
  params.push(Date.now())

  params.push(id)

  db.run(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`, ...params)

  const updated = getSession(db, id)
  if (!updated) throw new Error('Session not found.')
  return updated
}

/** Deletes a session. Messages and tool calls cascade (§6). */
export function deleteSession(db: Database, id: string): boolean {
  return db.run('DELETE FROM sessions WHERE id = ?', id) > 0
}

/** Reorders the sidebar by moving `updated_at`. Used when a turn starts. */
export function touchSession(db: Database, sessionId: string, at: number = Date.now()): void {
  db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', at, sessionId)
}

/** Stores the compaction summary produced by the agent host (§10.3). */
export function setSessionSummary(
  db: Database,
  sessionId: string,
  summary: string,
  upToSeq: number
): void {
  db.run(
    'UPDATE sessions SET summary = ?, summary_upto_seq = ? WHERE id = ?',
    summary,
    upToSeq,
    sessionId
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MESSAGE_COLUMNS =
  'id, session_id, seq, role, content, reasoning, status, tokens_in, tokens_out, cost_usd, created_at'

export function listMessages(db: Database, sessionId: string): Message[] {
  return db
    .all(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      sessionId
    )
    .map(toMessage)
}

export function getMessage(db: Database, id: string): Message | null {
  const row = db.get(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, id)
  return row ? toMessage(row) : null
}

export interface AppendMessageInput {
  sessionId: string
  role: Role
  content: string
  reasoning?: string | null
  status: MessageStatus
}

/**
 * Appends a message, assigning the next `seq` in the session.
 *
 * `seq` is unique per session, so the read and the insert must be atomic even
 * though `node:sqlite` is synchronous: two turns appending to the same session
 * would otherwise be able to pick the same number.
 */
export function appendMessage(db: Database, input: AppendMessageInput): Message {
  const id = randomUUID()
  const now = Date.now()

  return db.transaction(() => {
    const row = db.get(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE session_id = ?',
      input.sessionId
    )
    const seq = readNumber(row ?? {}, 'max_seq') + 1

    db.run(
      `INSERT INTO messages
         (id, session_id, seq, role, content, reasoning, status, tokens_in, tokens_out, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      id,
      input.sessionId,
      seq,
      input.role,
      input.content,
      input.reasoning ?? null,
      input.status,
      now
    )

    touchSession(db, input.sessionId, now)

    const created = getMessage(db, id)
    if (!created) throw new Error('Failed to persist the message.')
    return created
  })
}

/**
 * Appends streamed text to a column. This is the hot path of a turn, so the
 * caller (`turn-recorder.ts`) batches deltas rather than calling per token.
 *
 * `COALESCE(column, '')` guards rows written before this column was populated.
 */
export function appendMessageDelta(
  db: Database,
  messageId: string,
  field: 'content' | 'reasoning',
  delta: string
): void {
  if (delta.length === 0) return

  // `field` is a closed union, not renderer input, so this interpolation cannot
  // carry SQL. Binding is not possible for identifiers.
  db.run(
    `UPDATE messages SET ${field} = COALESCE(${field}, '') || ? WHERE id = ?`,
    delta,
    messageId
  )
}

export interface FinalizeMessageInput {
  status: MessageStatus
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
}

export function finalizeMessage(
  db: Database,
  messageId: string,
  input: FinalizeMessageInput
): void {
  db.run(
    `UPDATE messages
        SET status = ?,
            tokens_in = COALESCE(?, tokens_in),
            tokens_out = COALESCE(?, tokens_out),
            cost_usd = COALESCE(?, cost_usd)
      WHERE id = ?`,
    input.status,
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    input.costUsd ?? null,
    messageId
  )
}

/**
 * Reconciles rows left in `streaming` by a crash or a killed agent host.
 *
 * The partial text is deliberately kept: §13.6 requires that a crash mid-answer
 * does not lose the turn. Only the status changes, to `cancelled`, so the
 * renderer does not render an answer as still-arriving on the next launch.
 *
 * @returns How many rows were reconciled, for logging.
 */
export function reconcileInterruptedMessages(db: Database): number {
  return db.run("UPDATE messages SET status = 'cancelled' WHERE status = 'streaming'")
}

// ---------------------------------------------------------------------------
// Auto-title
// ---------------------------------------------------------------------------

/**
 * Derives a session title from the student's first message: collapse
 * whitespace, then cut to a sidebar-friendly length on a word boundary.
 */
export function deriveTitleFromMessage(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return DEFAULT_SESSION_TITLE
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed

  const clipped = collapsed.slice(0, TITLE_MAX_LENGTH)
  const lastSpace = clipped.lastIndexOf(' ')
  // Only honour the word boundary if it does not throw away most of the title.
  const body = lastSpace > TITLE_MAX_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped

  return `${body.trimEnd()}…`
}

/**
 * Names a session from its first user message. Later turns never retitle: the
 * sidebar is a stable list, not a live summary.
 */
export function autoTitleSession(db: Database, sessionId: string, text: string): void {
  const row = db.get('SELECT title FROM sessions WHERE id = ?', sessionId)
  if (!row) return

  const title = readString(row, 'title', DEFAULT_SESSION_TITLE)
  if (title !== DEFAULT_SESSION_TITLE) return

  const derived = deriveTitleFromMessage(text)
  if (derived === DEFAULT_SESSION_TITLE) return

  db.run('UPDATE sessions SET title = ? WHERE id = ?', derived, sessionId)
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const TOOL_CALL_COLUMNS =
  'id, session_id, message_id, seq, tool, code, stdout, result_value, error, status, duration_ms, truncated, created_at'

export interface AppendToolCallInput {
  /**
   * Identity assigned by the agent host. Reused rather than regenerated so the
   * row on disk is the same record the renderer is already rendering — the
   * subsequent `tool.output` and `tool.finished` events are keyed by this id.
   */
  id?: string
  sessionId: string
  messageId: string
  code: string
}

/**
 * Records the start of a `python` execution. The row is written *before* the
 * result arrives so a crash mid-computation still leaves an auditable trail.
 *
 * This is an **upsert** because the agent host legitimately emits `tool.started`
 * twice for one call: once when the model commits to the call (the tool source
 * is not streamed, so the code arrives empty) and again from the tool's own
 * `onStart` hook once the source has been parsed. The second event must refine
 * the first row rather than collide with it. The `seq` assigned on insert is
 * preserved, so the order of execution cards never shifts.
 */
export function appendToolCall(db: Database, input: AppendToolCallInput): ToolCall {
  const id = input.id && input.id.length > 0 ? input.id : randomUUID()
  const now = Date.now()

  return db.transaction(() => {
    const row = db.get(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM tool_calls WHERE session_id = ?',
      input.sessionId
    )
    const seq = readNumber(row ?? {}, 'max_seq') + 1

    db.run(
      `INSERT INTO tool_calls
         (id, session_id, message_id, seq, tool, code, stdout, result_value, error, status, duration_ms, truncated, created_at)
       VALUES (?, ?, ?, ?, 'python', ?, NULL, NULL, NULL, 'running', NULL, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = CASE WHEN excluded.code != '' THEN excluded.code ELSE tool_calls.code END`,
      id,
      input.sessionId,
      input.messageId,
      seq,
      input.code,
      now
    )

    const stored = db.get(`SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE id = ?`, id)
    if (!stored) throw new Error('Failed to persist the tool call.')
    return toToolCall(stored)
  })
}

export function appendToolCallStdout(db: Database, toolCallId: string, chunk: string): void {
  if (chunk.length === 0) return
  db.run(
    "UPDATE tool_calls SET stdout = COALESCE(stdout, '') || ? WHERE id = ?",
    chunk,
    toolCallId
  )
}

export interface FinishToolCallInput {
  status: ToolCallStatus
  resultValue?: string | null
  error?: string | null
  durationMs?: number | null
  truncated?: boolean
}

export function finishToolCall(db: Database, toolCallId: string, input: FinishToolCallInput): void {
  db.run(
    `UPDATE tool_calls
        SET status = ?,
            result_value = COALESCE(?, result_value),
            error = COALESCE(?, error),
            duration_ms = COALESCE(?, duration_ms),
            truncated = CASE WHEN ? THEN 1 ELSE truncated END
      WHERE id = ?`,
    input.status,
    input.resultValue ?? null,
    input.error ?? null,
    input.durationMs ?? null,
    input.truncated === true ? 1 : 0,
    toolCallId
  )
}

// ---------------------------------------------------------------------------
// Context replay
// ---------------------------------------------------------------------------

export interface HistoryWindow {
  /** Exclusive lower bound: messages already covered by the running summary. */
  afterSeq: number
  /** Exclusive upper bound: the seq of the message about to be sent. */
  beforeSeq: number
}

/**
 * Builds the prior turns replayed to the agent host.
 *
 * Only `user` and `assistant` messages become `TurnRecord`s, and only once they
 * are finished: a `streaming` row means the previous turn died, and an `error`
 * row means the model never produced an answer. Replaying either would put
 * something in front of the model that the student never saw.
 *
 * Tool calls are attached to the assistant message that made them so the
 * calculation trail stays in context — the model must be able to refer back to
 * a value it computed rather than recompute it or invent it (§10.3).
 */
export function buildTurnHistory(
  db: Database,
  sessionId: string,
  window: HistoryWindow
): TurnRecord[] {
  const rows = db.all(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
      WHERE session_id = ?
        AND seq > ?
        AND seq < ?
        AND role IN ('user', 'assistant')
        AND status IN ('complete', 'cancelled')
      ORDER BY seq ASC`,
    sessionId,
    window.afterSeq,
    window.beforeSeq
  )

  if (rows.length === 0) return []

  const messages = rows.map(toMessage)
  const messageIds = messages.map((message) => message.id)

  // `node:sqlite` supports only positional binding, so the id list is expanded
  // into placeholders. The list length is bounded by the transcript and the
  // placeholders contain no user data.
  const placeholders = messageIds.map(() => '?').join(', ')
  const toolRows = db.all(
    `SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls
      WHERE message_id IN (${placeholders})
      ORDER BY seq ASC`,
    ...messageIds
  )

  const toolCallsByMessage = new Map<string, ToolCallRecord[]>()
  for (const row of toolRows) {
    const call = toToolCall(row)
    // A call with no final result is an abandoned attempt; §10.3 says
    // intermediate failures are dropped rather than replayed.
    if (call.status === 'running' || call.status === 'cancelled') continue

    const list = toolCallsByMessage.get(call.messageId)
    const record: ToolCallRecord = {
      code: call.code,
      resultValue: call.resultValue,
      stdout: call.stdout,
      error: call.error
    }

    if (list) list.push(record)
    else toolCallsByMessage.set(call.messageId, [record])
  }

  return messages.map((message) => {
    // The query above already restricted `role` to these two; re-assert the type
    // so the replay record matches `TurnRecord`.
    if (message.role !== 'user' && message.role !== 'assistant') {
      return { role: 'assistant', content: message.content }
    }

    const toolCalls = toolCallsByMessage.get(message.id)
    return toolCalls && toolCalls.length > 0
      ? { role: message.role, content: message.content, toolCalls }
      : { role: message.role, content: message.content }
  })
}

/** Messages and tool calls for one session, ordered by `seq`. */
export function getSessionDetail(db: Database, id: string): SessionDetail | null {
  const session = getSession(db, id)
  if (!session) return null

  const toolCalls = db
    .all(
      `SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE session_id = ? ORDER BY seq ASC`,
      id
    )
    .map(toToolCall)

  return { session, messages: listMessages(db, id), toolCalls }
}
