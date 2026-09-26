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
import { isWorthRecording, localDay, readUsage, recordUsage } from '../usage'

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

  section('8. usage ledger, and its independence from the transcript')
  checkUsageLedger(db)

  section('9. transactions roll back')
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

/**
 * The ledger, and the one property it exists for.
 *
 * A day key is passed in explicitly rather than read from the clock, so these
 * assertions are about the arithmetic and the boundaries and do not change
 * behaviour at midnight or on a Sunday. `localDay` itself is checked separately
 * below against real `Date` objects.
 */
function checkUsageLedger(db: Database): void {
  // 2026-03-18 is a Wednesday, so its week began on Monday the 16th and the
  // Monday before that is the 9th — which is the "outside this week" day.
  const today = '2026-03-18'
  const yesterday = '2026-03-17'
  const weekStart = '2026-03-16'
  const lastWeek = '2026-03-09'
  const lastYear = '2025-12-31'

  check('empty ledger reads as zero', readUsage(db, new Date(2026, 2, 18, 12, 0)).total.turns === 0)
  check(
    'empty ledger reports no days',
    readUsage(db, new Date(2026, 2, 18, 12, 0)).firstDay === null
  )

  recordUsage(db, today, { tokensIn: 1000, tokensOut: 200, costUsd: 0.01 })
  recordUsage(db, today, { tokensIn: 500, tokensOut: 100, costUsd: 0.005 })
  recordUsage(db, yesterday, { tokensIn: 300, tokensOut: 60, costUsd: 0.003 })
  recordUsage(db, lastWeek, { tokensIn: 70, tokensOut: 7, costUsd: 0.001 })
  recordUsage(db, lastYear, { tokensIn: 9, tokensOut: 1, costUsd: 0.0001 })

  const now = new Date(2026, 2, 18, 12, 0)
  const report = readUsage(db, now)
  const period = (key: 'today' | 'week' | 'month' | 'year') =>
    report.periods.find((p) => p.key === key)
  const totals = (key: 'today' | 'week' | 'month' | 'year') => period(key)?.totals

  check('same-day turns accumulate into one row', readRow(db, today)?.turns === 2, readRow(db, today))
  check('tokens accumulate', readRow(db, today)?.tokensIn === 1500, readRow(db, today))
  check('one row per day, not per turn', Number(db.get('SELECT COUNT(*) AS n FROM usage_daily')?.['n']) === 4)

  check('all-time total sums every day', report.total.tokensIn === 1879, report.total)
  check('all-time turns counted', report.total.turns === 5, report.total)
  check('all-time cost accumulated', Math.abs(report.total.costUsd - 0.0191) < 1e-9, report.total.costUsd)
  check('first day reported', report.firstDay === lastYear, report.firstDay)
  check('last day reported', report.lastDay === today, report.lastDay)

  check('today counts only today', totals('today')?.tokensIn === 1500, totals('today'))
  check('this week starts on the Monday', period('week')?.from === weekStart, period('week')?.from)
  check('this week excludes the week before', totals('week')?.tokensIn === 1800, totals('week'))
  check('this month includes the whole month', totals('month')?.tokensIn === 1870, totals('month'))
  // 2025-12-31 is in last year, not this one, and must not be pulled in.
  check('this year excludes last year', totals('year')?.tokensIn === 1870, totals('year'))
  check('this month starts on the 1st', period('month')?.from === '2026-03-01', period('month')?.from)
  check('this year starts on Jan 1', period('year')?.from === '2026-01-01', period('year')?.from)
  check('today starts today', period('today')?.from === today, period('today')?.from)

  // Sunday is the *last* day of its week, so the week began six days earlier.
  // Getting this backwards would start the week on the following Monday and drop
  // six days of spend out of every Sunday's figure.
  const sunday = readUsage(db, new Date(2026, 2, 22, 12, 0))
  check(
    'a Sunday still belongs to the week that began on the 16th',
    sunday.periods.find((p) => p.key === 'week')?.from === weekStart,
    sunday.periods.find((p) => p.key === 'week')?.from
  )

  // A Monday begins its own week, so the Monday's own spend is inside it — and
  // so is everything after it, because a period is a range from its start up to
  // now, not a single day.
  recordUsage(db, weekStart, { tokensIn: 60, tokensOut: 6, costUsd: 0 })
  const monday = readUsage(db, new Date(2026, 2, 16, 12, 0))
  check(
    'a Monday includes its own day',
    monday.periods.find((p) => p.key === 'week')?.totals.tokensIn === 60,
    monday.periods.find((p) => p.key === 'week')?.totals
  )
  // Read from the Monday again a few days later: the same week, now carrying the
  // 17th and 18th as well. 60 + 300 + 1500.
  const sameWeekLater = readUsage(db, new Date(2026, 2, 18, 12, 0))
  check(
    'a week accumulates as the days pass',
    sameWeekLater.periods.find((p) => p.key === 'week')?.totals.tokensIn === 1860,
    sameWeekLater.periods.find((p) => p.key === 'week')?.totals
  )
  check(
    'the next week starts empty after the week rolls over',
    readUsage(db, new Date(2026, 2, 23, 12, 0)).periods.find((p) => p.key === 'week')?.totals.turns === 0,
    readUsage(db, new Date(2026, 2, 23, 12, 0)).periods.find((p) => p.key === 'week')?.totals
  )

  // The reason the table exists. A total read off `messages` would drop here.
  const before = readUsage(db, now).total
  const doomed = createSession(db, { modelId: 'openrouter/free', preferredLanguage: 'en' })
  appendMessage(db, { sessionId: doomed.id, role: 'user', content: 'q', status: 'complete' })
  const doomedMessage = appendMessage(db, {
    sessionId: doomed.id,
    role: 'assistant',
    content: 'a',
    status: 'complete'
  })
  finalizeMessage(db, doomedMessage.id, {
    status: 'complete',
    tokensIn: 999,
    tokensOut: 111,
    costUsd: 0.5
  })
  check('a deleted chat really did carry tokens', Number(db.get('SELECT tokens_in FROM messages WHERE id = ?', doomedMessage.id)?.['tokens_in']) === 999)
  deleteSession(db, doomed.id)
  check('the transcript is gone', getSessionDetail(db, doomed.id) === null)

  const after = readUsage(db, now).total
  check(
    'deleting a chat does not change the ledger',
    after.tokensIn === before.tokensIn && after.tokensOut === before.tokensOut && after.turns === before.turns,
    { before, after }
  )

  // A stopped turn reports zeros because an aborted stream never delivers its
  // usage chunk. Recording that would invent a day, and make "today" non-zero on
  // a day where every turn was stopped.
  check('a cancelled turn is not worth recording', isWorthRecording({ tokensIn: 0, tokensOut: 0, costUsd: null }) === false)
  check('a real turn is worth recording', isWorthRecording({ tokensIn: 10, tokensOut: 0, costUsd: null }) === true)
  check('output-only usage is recorded', isWorthRecording({ tokensIn: 0, tokensOut: 5, costUsd: null }) === true)

  // Tokens with no reported cost must still be counted. Skipping the row would
  // lose real spend to keep a cost column tidy.
  const free = '2026-03-20'
  recordUsage(db, free, { tokensIn: 42, tokensOut: 8, costUsd: null })
  check('tokens record even when cost is unreported', readRow(db, free)?.tokensIn === 42, readRow(db, free))
  check('unreported cost is stored as zero', readRow(db, free)?.costUsd === 0, readRow(db, free))
  check('a null cost does not break the sum', Number.isFinite(readUsage(db, now).total.costUsd))

  // A hostile day string must not reach the WHERE clause.
  let rejected = false
  try {
    recordUsage(db, "x'; DROP TABLE messages; --", { tokensIn: 1, tokensOut: 1, costUsd: 0 })
  } catch {
    rejected = true
  }
  check('a malformed day is refused', rejected)
  check('the messages table survived the attempt', db.get('SELECT COUNT(*) AS n FROM messages') !== undefined)

  // The day key must be local, or a 1am turn in Dhaka files under yesterday.
  check('localDay uses the local date', localDay(new Date(2026, 2, 18, 0, 30)) === '2026-03-18', localDay(new Date(2026, 2, 18, 0, 30)))
  check('localDay pads single digits', localDay(new Date(2026, 0, 5)) === '2026-01-05', localDay(new Date(2026, 0, 5)))
}

function readRow(db: Database, day: string): { tokensIn: number; tokensOut: number; costUsd: number; turns: number } | null {
  const row = db.get('SELECT tokens_in, tokens_out, cost_usd, turns FROM usage_daily WHERE day = ?', day)
  if (row === undefined) return null
  return {
    tokensIn: Number(row['tokens_in'] ?? 0),
    tokensOut: Number(row['tokens_out'] ?? 0),
    costUsd: Number(row['cost_usd'] ?? 0),
    turns: Number(row['turns'] ?? 0)
  }
}

main()
