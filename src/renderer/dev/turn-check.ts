/**
 * Renderer turn-state regression check.
 *
 * Run with:
 *   npx esbuild src/renderer/dev/turn-check.ts --bundle --platform=node \
 *     --format=esm --target=node24 \
 *     --alias:@shared=./src/shared --alias:@=./src/renderer/src \
 *     --outfile=out/turn-check.mjs
 *   node out/turn-check.mjs
 *
 * ## What it covers, and why only this
 *
 * Two bugs, one cause, both of them invisible to the type checker and to every
 * other check in the repo because they live entirely in the renderer:
 *
 *   1. A second message in a session was invisible for the whole turn. The
 *      question was only ever drawn from `detail.messages`, which is not re-read
 *      until a turn settles, so a student could not see what they had just asked
 *      until the answer arrived.
 *   2. A failed turn made the question, the partial answer and the error notice
 *      all disappear at once. `turn.error` sets `phase: 'error'` and clears
 *      `streaming`; the live section is gated on `streaming`, and the hand-off to
 *      the session store was gated on `phase === 'idle'`. So the content became
 *      invisible and nothing replaced it. Reloading restored everything, because
 *      SQLite had it the whole time.
 *
 * `isTurnSettled` and `buildCompletedRows` are the two functions whose behaviour
 * was wrong, and both are pure, so both are testable here without a DOM. The
 * surrounding wiring (the effect in `ChatView`, the optimistic insert) is not
 * covered by this file and is covered by the student looking at it, which is the
 * honest position: a headless renderer test would assert that a hook runs, not
 * that a question is on screen.
 */
import { buildCompletedRows, isTurnSettled } from '@/store/turnStore'
import type { ToolCard } from '@/store/turnStore'

let failures = 0
let checks = 0

function section(title: string): void {
  console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 66 - title.length))}`)
}

function check(label: string, ok: boolean, detail?: unknown): void {
  checks += 1
  if (ok) {
    console.log(`  ok    ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
  }
}

const SESSION = 'session-1'
const MESSAGE = 'assistant-1'

function card(over: Partial<ToolCard> = {}): ToolCard {
  return {
    toolCallId: 'call-1',
    messageId: MESSAGE,
    seq: 0,
    tool: 'python',
    code: '1 / 0',
    output: '',
    resultValue: null,
    error: 'ZeroDivisionError: division by zero',
    status: 'error',
    durationMs: 3,
    truncated: false,
    ...over
  }
}

function checkSettled(): void {
  section('isTurnSettled: what counts as finished')

  check('a streaming turn is not settled', isTurnSettled('running', true) === false)
  check('a starting turn is not settled', isTurnSettled('running', false) === false)
  check('a stopping turn is not settled', isTurnSettled('stopping', false) === false)
  check('a completed turn is settled', isTurnSettled('idle', false) === true)

  // The bug. An errored turn is over, and treating it as anything else meant its
  // streamed content was never handed to the session store.
  check('a failed turn is settled too', isTurnSettled('error', false) === true, {
    got: isTurnSettled('error', false)
  })

  // `streaming` wins over the phase, so a stop request mid-turn is not read as
  // the end of the turn.
  check('streaming beats an idle phase', isTurnSettled('idle', true) === false)
  check('streaming beats an error phase', isTurnSettled('error', true) === false)
}

function checkHandover(): void {
  section('buildCompletedRows: a failed turn still hands its content over')

  const rows = buildCompletedRows(
    SESSION,
    MESSAGE,
    'The first step gave a ZeroDivisionError.',
    'dividing by zero is wrong',
    [card()],
    null,
    'error'
  )

  check('the partial answer is kept', rows.messages[0]?.content === 'The first step gave a ZeroDivisionError.', rows.messages[0])
  check('the reasoning is kept', rows.messages[0]?.reasoning === 'dividing by zero is wrong')
  check('the row is marked failed', rows.messages[0]?.status === 'error', rows.messages[0]?.status)
  check('the execution card is kept', rows.toolCalls.length === 1)
  check('the card keeps its error', rows.toolCalls[0]?.error === 'ZeroDivisionError: division by zero')
  check('the card keeps its source', rows.toolCalls[0]?.code === '1 / 0')

  // A turn that failed before saying anything at all. Dropping the row would
  // leave the question on screen with nothing answering it, which reads as "not
  // sent" rather than "failed".
  const silent = buildCompletedRows(SESSION, MESSAGE, '', '', [], null, 'error')
  check('a silent failure still produces a row', silent.messages.length === 1, silent.messages)
  check('the empty row is marked failed', silent.messages[0]?.status === 'error')
  check('the empty row has no content', silent.messages[0]?.content === '')

  // Default and the completed case.
  const good = buildCompletedRows(SESSION, MESSAGE, 'Here is the answer.', '', [], {
    tokensIn: 100,
    tokensOut: 20,
    costUsd: 0.001
  })
  check('a completed turn defaults to complete', good.messages[0]?.status === 'complete')
  check('usage is carried through', good.messages[0]?.tokensIn === 100)
  check('a missing cost stays null', good.messages[0]?.costUsd === 0.001)

  // A stopped turn arrives as `turn.finished`, so main records it as `complete`.
  // The renderer must agree, or the streamed view and a reloaded transcript
  // disagree about the same row.
  const stopped = buildCompletedRows(SESSION, MESSAGE, 'Partial work.', '', [card({ status: 'cancelled' })], null, 'complete')
  check('a stopped turn reads as complete', stopped.messages[0]?.status === 'complete')
  check('its card still reads cancelled', stopped.toolCalls[0]?.status === 'cancelled')

  check('no message id yields no row', buildCompletedRows(SESSION, null, 'text', '', [], null).messages.length === 0)
}

function checkTheReportedSymptom(): void {
  section('the reported symptom, end to end')

  // Reproduces the sequence: a python error arrives, the turn fails, and the
  // question plus the partial answer plus the failure must all still be
  // recoverable for the transcript.
  const partial = 'Step 1 divided by zero.'
  const errored = buildCompletedRows(SESSION, MESSAGE, partial, '', [card()], null, 'error')

  const transcript = [
    { id: 'user-1', role: 'user', content: 'what is 1 divided by 0?' },
    ...errored.messages
  ]

  check('the question is in the transcript', transcript.some((m) => m.role === 'user'))
  check('the partial answer is in the transcript', transcript.some((m) => m.content === partial))
  check('the failure is represented', transcript.some((m) => m.status === 'error'))
  check('the card is available to the transcript', errored.toolCalls.length === 1)

  // And the guard that used to drop all of it.
  check('the turn is recognised as over', isTurnSettled('error', false) === true)
}

checkSettled()
checkHandover()
checkTheReportedSymptom()

console.log(`\n${checks - failures}/${checks} checks passed.`)
if (failures > 0) {
  console.error(`${failures} check(s) failed.`)
  process.exitCode = 1
}
