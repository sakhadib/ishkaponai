/**
 * Token spend, kept as a ledger that outlives the transcript.
 *
 * ## Why this is not a query over `messages`
 *
 * The obvious implementation is `SELECT SUM(tokens_in) FROM messages`. It is
 * wrong, and wrong in a way that gets worse over time: `messages` is a child of
 * `sessions` with `ON DELETE CASCADE`, so deleting one chat erases the tokens
 * that chat spent. A spending total that *decreases* when the student tidies up
 * is not a spending total — and they will delete chats, because the app offers
 * it. So the numbers are written here as they happen, and this table has no
 * foreign key to anything that can be deleted.
 *
 * ## Why one row per day
 *
 * Every period the page shows — today, this week, this month, this year — is a
 * range of whole days, so each is one indexed range scan over a table that will
 * never hold more than ~365 rows a year. Per-turn rows would grow without bound
 * and would not make a single displayed figure any faster.
 *
 * ## Why the day key is local
 *
 * `day` is a local `YYYY-MM-DD`. A UTC key files a 1am conversation in
 * Asia/Dhaka under *yesterday*, and there is no way for the student to see why
 * today's number disagrees with the turns they just ran. The bucketing happens
 * in this process, which is the only one that knows the machine's timezone.
 */
import type { Database } from './db'
import type { UsagePeriod, UsageReport, UsageTotals } from '@shared/types'

/**
 * The local calendar day of `at`, as `YYYY-MM-DD`.
 *
 * Built from the local getters rather than `toISOString()`, which is UTC. That
 * is the whole point — see the module comment.
 */
export function localDay(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** A `day` we are willing to put in a WHERE clause. */
function assertDay(day: string): string {
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`A usage day must be YYYY-MM-DD, got ${JSON.stringify(day)}.`)
  }
  return day
}

/**
 * Adds one turn's usage to its day.
 *
 * An UPSERT rather than SELECT-then-write: two windows open at once would race,
 * and a lost increment here is a permanently wrong total with no trace.
 *
 * `costUsd` is added as NULL-is-zero so a turn whose provider reported no cost
 * still records its tokens. The alternative — skipping the row — would silently
 * drop real token spend to keep a cost column tidy.
 */
export function recordUsage(
  db: Database,
  day: string,
  usage: { tokensIn: number; tokensOut: number; costUsd: number | null }
): void {
  assertDay(day)

  const tokensIn = clampCount(usage.tokensIn)
  const tokensOut = clampCount(usage.tokensOut)
  // A negative cost is nonsense; treat it as unreported rather than as a credit.
  const cost = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd > 0
    ? usage.costUsd
    : 0

  db.run(
    `INSERT INTO usage_daily (day, tokens_in, tokens_out, cost_usd, turns)
        VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(day) DO UPDATE SET
        tokens_in  = tokens_in  + excluded.tokens_in,
        tokens_out = tokens_out + excluded.tokens_out,
        cost_usd   = cost_usd   + excluded.cost_usd,
        turns      = turns      + 1`,
    day,
    tokensIn,
    tokensOut,
    cost
  )
}

/**
 * Whether a turn is worth a ledger row.
 *
 * A cancelled turn reports `EMPTY_USAGE` — zeros — because an aborted stream
 * never delivers its usage chunk. Writing that as a real day would invent a
 * spend that did not happen and, worse, make "today" non-zero on a day where
 * every turn was stopped. Not knowing is not the same as zero, so nothing is
 * written and the figure stays honestly absent.
 */
export function isWorthRecording(usage: {
  tokensIn: number
  tokensOut: number
  costUsd: number | null
}): boolean {
  return usage.tokensIn > 0 || usage.tokensOut > 0
}

function clampCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const EMPTY: UsageTotals = { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 }

/**
 * The local-midnight start of each period, as a `day` key.
 *
 * The week starts on Monday. That is the ISO 8601 convention and the one most of
 * the world uses, but it is a choice, so the page states it rather than leaving
 * the student to infer it from a number that looks a day off.
 *
 * Computed with local setters throughout. `setDate(getDate() - offset)` walks
 * back through real local midnights, so it stays correct across a daylight-saving
 * boundary in a way that subtracting 7×86400000ms from an epoch does not.
 */
export function periodStarts(now: Date): Record<UsagePeriod['key'], string> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  // getDay() is 0=Sunday..6=Saturday, so Monday-anchored weeks need the Sunday
  // branch to jump back a further six days.
  const sinceMonday = (today.getDay() + 6) % 7
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - sinceMonday)

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const yearStart = new Date(today.getFullYear(), 0, 1)

  return {
    today: localDay(today),
    week: localDay(weekStart),
    month: localDay(monthStart),
    year: localDay(yearStart)
  }
}

/** The label each period carries in the UI. Kept here so it cannot drift. */
export const PERIOD_LABELS: Record<UsagePeriod['key'], string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  year: 'This year'
}

/**
 * Reads the all-time total and each period, in one pass over the table.
 *
 * The whole table is read rather than four range queries. It is bounded by the
 * number of days the install has been used — hundreds of rows at most — and one
 * query with no index dependency is both simpler and faster than four that each
 * have to agree about the boundaries.
 */
export function readUsage(db: Database, now: Date = new Date()): UsageReport {
  const rows = db.all('SELECT day, tokens_in, tokens_out, cost_usd, turns FROM usage_daily')
  const starts = periodStarts(now)

  const total: UsageTotals = { ...EMPTY }
  const buckets: Record<UsagePeriod['key'], UsageTotals> = {
    today: { ...EMPTY },
    week: { ...EMPTY },
    month: { ...EMPTY },
    year: { ...EMPTY }
  }

  // A period runs from its start *up to now*, so the range needs an upper bound
  // as well as a lower one. Nothing in normal operation records a future day, but
  // a clock set backwards does, and without the cap "this month" would report
  // spend from a day that has not happened yet.
  const todayKey = starts.today

  let firstDay: string | null = null
  let lastDay: string | null = null

  for (const row of rows) {
    const day = readString(row['day'])
    if (day === null || !DAY_PATTERN.test(day)) continue

    const tokensIn = readNumber(row['tokens_in'])
    const tokensOut = readNumber(row['tokens_out'])
    const costUsd = readNumber(row['cost_usd'])
    const turns = readNumber(row['turns'])

    // `YYYY-MM-DD` sorts lexicographically in date order, so plain string
    // comparison is the range test. No parsing, no timezone.
    addInto(total, tokensIn, tokensOut, costUsd, turns)

    if (firstDay === null || day < firstDay) firstDay = day
    if (lastDay === null || day > lastDay) lastDay = day

    for (const key of ['today', 'week', 'month', 'year'] as const) {
      if (day >= starts[key] && day <= todayKey) {
        addInto(buckets[key], tokensIn, tokensOut, costUsd, turns)
      }
    }
  }

  const periods = (['today', 'week', 'month', 'year'] as const).map((key) => ({
    key,
    label: PERIOD_LABELS[key],
    from: starts[key],
    totals: buckets[key]
  }))

  return { total, periods, firstDay, lastDay }
}

function addInto(
  target: UsageTotals,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  turns: number
): void {
  target.tokensIn += tokensIn
  target.tokensOut += tokensOut
  target.costUsd += costUsd
  target.turns += turns
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** SQLite hands back NULL for a missing numeric; that is zero, not a crash. */
function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}
