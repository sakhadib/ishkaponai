/**
 * Context replay: a multi-turn conversation driven through the real modules.
 *
 * §10 is the part of this app most likely to break silently. Nothing throws when
 * history is dropped, truncated, or mis-paired — the model just quietly forgets,
 * which reads as "the AI is not very bright" rather than as a bug. So this
 * exercises the whole path — `appendMessage` → `finalizeMessage` →
 * `buildTurnHistory` → `computeBudget` → `planCompaction` → `projectHistory` —
 * and asserts on what would actually be handed to the model.
 *
 * The conversation deliberately re-runs **the same Python snippet every turn**,
 * which is the normal case for a physics follow-up and is exactly what used to
 * collide in `replayId`.
 *
 * Like `dev/db-check.ts`, never bundled into the shipped app. Run it with plain
 * Node after bundling:
 *
 *   node_modules/.bin/esbuild src/main/dev/context-check.ts \
 *     --bundle --platform=node --format=esm --target=node24 \
 *     --alias:@shared=./src/shared --alias:@agent=./src/agent \
 *     --outfile=<tmp>/context-check.mjs
 *   node <tmp>/context-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { Database } from '../db'
import {
  appendMessage,
  appendMessageDelta,
  appendToolCall,
  appendToolCallStdout,
  buildTurnHistory,
  createSession,
  finalizeMessage,
  finishToolCall,
  getSession
} from '../sessions'
import { computeBudget, estimateMessages, planCompaction, projectHistory } from '../../agent/context'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`)
}

/** One `tool-call` id per replayed call, in order. */
function toolCallIds(messages: readonly ModelMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-call') ids.push(part.toolCallId)
    }
  }
  return ids
}

function toolResultIds(messages: readonly ModelMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-result') ids.push(part.toolCallId)
    }
  }
  return ids
}

const QUESTIONS = [
  'A ball weighing 2.5 kg is dropped. Find the force on it.',
  'Now the kinetic energy when it reaches 9.81 m/s.',
  'What is the momentum just before impact?',
  'And the power, if it fell for three seconds?',
  'Finally the total energy from the release point.'
]

/** The same snippet every turn: recomputing W is the normal follow-up case. */
const SNIPPET = 'm = 2.5\ng = 9.81\nW = m * g'

const CONTEXT_LENGTH = 128_000
const MAX_OUTPUT = 2048
const SYSTEM_PROMPT = 'rule. '.repeat(400)

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'ishkapon-context-'))
  const db = new Database(join(dir, 'check.db'))

  try {
    run(db)
  } finally {
    // The handle has to go before the directory does, or Windows refuses the
    // delete with EPERM and the check looks like it failed when it passed.
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

function run(db: Database): void {
  const session = createSession(db, { modelId: 'test/model', preferredLanguage: 'en' })

  let lastRequest: ModelMessage[] = []

  for (const [index, question] of QUESTIONS.entries()) {
    const turn = index + 1

    const user = appendMessage(db, {
      sessionId: session.id,
      role: 'user',
      content: question,
      status: 'complete'
    })
    const assistant = appendMessage(db, {
      sessionId: session.id,
      role: 'assistant',
      content: '',
      status: 'streaming'
    })
    for (const chunk of question.match(/.{1,40}/gu) ?? []) {
      appendMessageDelta(db, assistant.id, 'content', chunk)
    }
    const call = appendToolCall(db, {
      id: `tc-${turn}`,
      sessionId: session.id,
      messageId: assistant.id,
      code: SNIPPET
    })
    appendToolCallStdout(db, call.id, `${(24.525 * turn).toFixed(3)}\n`)
    finishToolCall(db, call.id, {
      status: 'complete',
      resultValue: (24.525 * turn).toFixed(3),
      durationMs: 30,
      truncated: false
    })
    finalizeMessage(db, assistant.id, { status: 'complete' })

    // Exactly what `AgentHostSupervisor.send` does, in the same order.
    const stored = getSession(db, session.id)
    if (stored === null) {
      check('the session is readable', false, session.id)
      return
    }
    const history = buildTurnHistory(db, session.id, {
      afterSeq: stored.summaryUpToSeq,
      beforeSeq: user.seq
    })
    const budget = computeBudget({
      contextLength: CONTEXT_LENGTH,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: MAX_OUTPUT
    })
    const plan = planCompaction(history, budget.history)
    const messages: ModelMessage[] = [
      ...projectHistory(plan.keep, stored.summary),
      { role: 'user', content: question }
    ]
    lastRequest = messages

    section(`turn ${turn}`)
    check('prior turns are replayed', history.length === Math.max(0, turn * 2 - 2), history.length)

    const ids = toolCallIds(messages)
    const results = toolResultIds(messages)
    const unique = new Set(ids)
    check('every tool_call_id is unique', unique.size === ids.length, {
      total: ids.length,
      unique: unique.size
    })
    check('every call has its result', ids.length === results.length, {
      calls: ids.length,
      results: results.length
    })
    check(
      'results pair to calls by id',
      results.every((id) => unique.has(id)),
      results.filter((id) => !unique.has(id))
    )
    check(
      'the replayed code is present for the model',
      turn === 1 || JSON.stringify(messages).includes('W = m * g')
    )
    check(
      'the earlier question is still in the request',
      turn === 1 || JSON.stringify(messages).includes(QUESTIONS[0] as string)
    )
    check('no premature compaction', plan.shouldCompact === false, plan.compact.length)
    const projected = estimateMessages(messages)
    check(
      `inside the compaction threshold (${projected}/${budget.history})`,
      projected <= budget.history * 0.7,
      projected
    )
  }

  section('the whole conversation')
  const everyId = toolCallIds(lastRequest)
  check(
    `all ${QUESTIONS.length} turns are in the final request`,
    QUESTIONS.every((q) => JSON.stringify(lastRequest).includes(q))
  )
  check(
    'and the same snippet ran five times without an id collision',
    new Set(everyId).size === everyId.length,
    { total: everyId.length, unique: new Set(everyId).size }
  )
}

main()
