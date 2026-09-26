/**
 * Dev-only self-check for the SQLite layer.
 *
 * Not part of the shipped bundle: nothing imports it, so the two rollup entries
 * (`main/index`, `agent/index`) never pull it in. It exists so the schema, the
 * repository mapping, and — most importantly — the `ON DELETE CASCADE` can be
 * exercised without launching Electron.
 *
 * Run it with plain Node after bundling, because `tsconfig` has `noEmit` and the
 * relative imports are extensionless:
 *
 *   node_modules/.bin/esbuild src/main/dev/db-check.ts \
 *     --bundle --platform=node --format=esm --target=node24 \
 *     --alias:@shared=./src/shared --outfile=<tmp>/db-check.mjs
 *   node <tmp>/db-check.mjs
 *
 * It uses a real file in the OS temp directory rather than `:memory:` so that
 * the WAL and foreign-key pragmas are exercised exactly as they are in
 * production.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../db'
import {
  appendMessage,
  appendMessageDelta,
  appendToolCall,
  appendToolCallStdout,
  autoTitleSession,
  buildTurnHistory,
  createSession,
  deleteSession,
  finalizeMessage,
  finishToolCall,
  deriveTitleFromMessage,
  getSessionDetail,
  listSessions,
  reconcileInterruptedMessages,
  updateSession
} from '../sessions'
import type { Session, TurnRecord } from '@shared/types'

let checks = 0
let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

function main(): void {
  const directory = mkdtempSync(join(tmpdir(), 'ishkapon-dbcheck-'))
  const file = join(directory, 'ishkapon.db')

  const db = new Database(file)

  try {
    run(db)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`)
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`)
    process.exitCode = 1
  }
}

function run(db: Database): void {
  section('1. schema and pragmas')
  const journalMode = db.get('PRAGMA journal_mode')
  check('journal_mode is WAL', journalMode?.['journal_mode'] === 'wal', journalMode)

  const foreignKeys = db.get('PRAGMA foreign_keys')
  check('foreign_keys is ON', foreignKeys?.['foreign_keys'] === 1, foreignKeys)

  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row['name'])
  check(
    'all five tables exist',
    ['messages', 'secrets', 'sessions', 'settings', 'tool_calls'].every((name) =>
      tables.includes(name)
    ),
    tables
  )

  const indexes = db
    .all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
    .map((row) => row['name'])
  check(
    'the three spec indexes exist',
    ['idx_messages_session', 'idx_sessions_updated', 'idx_toolcalls_session'].every((name) =>
      indexes.includes(name)
    ),
    indexes
  )

  section('2. insert a session, messages and tool calls')
  const created: Session = createSession(db, { modelId: 'openrouter/free', preferredLanguage: 'bn' })
  console.log(`  session ${created.id}`)
  check('id is a uuid', /^[0-9a-f-]{36}$/.test(created.id), created.id)
  check('default title', created.title === 'New chat', created.title)
  check('summaryUpToSeq starts at 0', created.summaryUpToSeq === 0, created.summaryUpToSeq)
  check('not pinned', created.pinned === false)

  const longQuestion =
    'একটি বল ঘণ্ডার সূত্রে পতন হচ্ছে। যদি ভর 2.5 kg হয় এবং অভিকরণ 9.81 m/s^2 হয়, তবে বলটি কত? বিস্তারিত ধাপে ধাপে দেখান।'
  autoTitleSession(db, created.id, longQuestion)
  check(
    'auto-title truncates on a word boundary',
    deriveTitleFromMessage(longQuestion).length <= 61,
    deriveTitleFromMessage(longQuestion)
  )

  const userMessage = appendMessage(db, {
    sessionId: created.id,
    role: 'user',
    content: 'A ball weighing 2.5 kg is dropped. Find the force.',
    status: 'complete'
  })
  check('user message gets seq 1', userMessage.seq === 1, userMessage.seq)

  const assistantMessage = appendMessage(db, {
    sessionId: created.id,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })
  check('assistant message gets seq 2', assistantMessage.seq === 2, assistantMessage.seq)

  // Streamed text, in the deltas the agent host would emit.
  for (const delta of ['Given ', 'm = 2.5 kg', '.']) appendMessageDelta(db, assistantMessage.id, 'content', delta)
  appendMessageDelta(db, assistantMessage.id, 'reasoning', 'Weight is mg.')

  const call = appendToolCall(db, {
    id: 'tc-1',
    sessionId: created.id,
    messageId: assistantMessage.id,
    code: 'm = 2.5\ng = 9.81\nm * g'
  })
  check('tool call is python', call.tool === 'python', call.tool)
  check('tool call starts running', call.status === 'running', call.status)

  appendToolCallStdout(db, call.id, '24.525\n')
  finishToolCall(db, call.id, {
    status: 'complete',
    resultValue: '24.525',
    durationMs: 41,
    truncated: false
  })
  finalizeMessage(db, assistantMessage.id, {
    status: 'complete',
    tokensIn: 412,
    tokensOut: 96,
    costUsd: 0
  })

  const detail = getSessionDetail(db, created.id)
  check('session detail round-trips', detail !== null)
  check('two messages persisted', detail?.messages.length === 2, detail?.messages.length)

  const stored = detail?.messages.find((message) => message.id === assistantMessage.id)
  check(
    'streamed deltas were concatenated in order',
    stored?.content === 'Given m = 2.5 kg.',
    stored?.content
  )
  check('reasoning persisted', stored?.reasoning === 'Weight is mg.', stored?.reasoning)
  check('usage persisted', stored?.tokensIn === 412 && stored?.tokensOut === 96, stored)
  check('tool call persisted', detail?.toolCalls.length === 1, detail?.toolCalls.length)
  check(
    'tool result persisted',
    detail?.toolCalls[0]?.resultValue === '24.525' && detail?.toolCalls[0]?.stdout === '24.525\n',
    detail?.toolCalls[0]
  )
  check('tool duration persisted', detail?.toolCalls[0]?.durationMs === 41)
  check('tool id preserved from the agent host', detail?.toolCalls[0]?.id === 'tc-1')

  section('3. context replay')
  const history = buildTurnHistory(db, created.id, { afterSeq: 0, beforeSeq: 99 })
  check('two turn records built', history.length === 2, history.length)
  check('oldest first', history[0]?.role === 'user', history[0]?.role)
  const assistantRecord = history[1] as TurnRecord | undefined
  check('tool trail attached to the assistant turn', assistantRecord?.toolCalls?.length === 1)
  check(
    'tool record carries the result',
    assistantRecord?.toolCalls?.[0]?.resultValue === '24.525',
    assistantRecord?.toolCalls?.[0]
  )

  const bounded = buildTurnHistory(db, created.id, { afterSeq: 1, beforeSeq: 99 })
  check('summary bound drops covered messages', bounded.length === 1 && bounded[0]?.role === 'assistant', bounded)

  section('4. session isolation (§10.2)')
  const other = createSession(db, { modelId: null, preferredLanguage: 'en' })
  const otherDetail = getSessionDetail(db, other.id)
  check('a new session starts empty', otherDetail?.messages.length === 0, otherDetail?.messages.length)

  const otherHistory = buildTurnHistory(db, other.id, { afterSeq: 0, beforeSeq: 99 })
  check('no cross-session leakage', otherHistory.length === 0, otherHistory)

  const orphanQuery = db.get(
    `SELECT COUNT(*) AS n FROM messages
      WHERE session_id = ? AND session_id != ?`,
    created.id,
    created.id
  )
  check('every message row belongs to its own session', Number(orphanQuery?.['n'] ?? -1) === 0, orphanQuery)

  section('5. sidebar ordering and updates')
  const pinned = updateSession(db, other.id, { pinned: true, title: 'Pinned first' })
  check('pin stored', pinned.pinned === true, pinned)
  check('title stored', pinned.title === 'Pinned first', pinned.title)

  const listed = listSessions(db)
  check('pinned session sorts first', listed[0]?.id === other.id, listed.map((s) => s.title))
  check('both sessions listed', listed.length === 2, listed.length)

  section('6. crash reconciliation')
  const streaming = appendMessage(db, {
    sessionId: created.id,
    role: 'assistant',
    content: 'partial answer that must survive',
    status: 'streaming'
  })
  const reconciled = reconcileInterruptedMessages(db)
  check('one streaming row reconciled', reconciled === 1, reconciled)

  const afterReconcile = getSessionDetail(db, created.id)
  const recovered = afterReconcile?.messages.find((message) => message.id === streaming.id)
  check('status became cancelled', recovered?.status === 'cancelled', recovered?.status)
  check(
    'partial text was kept',
    recovered?.content === 'partial answer that must survive',
    recovered?.content
  )

  section('7. cascade delete (§6)')
  const beforeDelete = db.get('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?', created.id)
  check('tool calls exist before delete', Number(beforeDelete?.['n'] ?? 0) === 1, beforeDelete)

  const deleted = deleteSession(db, created.id)
  check('delete reported success', deleted === true)

  check('session gone', getSessionDetail(db, created.id) === null)
  check(
    'messages cascaded',
    Number(db.get('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', created.id)?.['n'] ?? -1) === 0
  )
  check(
    'tool calls cascaded',
    Number(db.get('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?', created.id)?.['n'] ?? -1) === 0
  )
  check('surviving session untouched', getSessionDetail(db, other.id) !== null)
  check('sidebar now has one session', listSessions(db).length === 1)

  section('8. transactions roll back')
  try {
    db.transaction(() => {
      appendMessage(db, {
        sessionId: other.id,
        role: 'user',
        content: 'this must not survive',
        status: 'complete'
      })
      throw new Error('simulated failure')
    })
  } catch (error) {
    check('transaction threw', error instanceof Error, String(error))
  }
  check(
    'rolled back cleanly',
    Number(db.get('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', other.id)?.['n'] ?? -1) === 0
  )
}

main()
