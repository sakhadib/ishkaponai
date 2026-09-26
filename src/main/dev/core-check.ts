/**
 * Dev-only self-check for the main process's non-Electron logic: settings
 * validation and migration, batched streaming persistence, and the narrowing of
 * messages arriving from the agent host.
 *
 * Like `dev/db-check.ts` this is never bundled into the shipped app — nothing
 * imports it.
 *
 * Run it with plain Node after bundling:
 *
 *   node_modules/.bin/esbuild src/main/dev/core-check.ts \
 *     --bundle --platform=node --format=esm --target=node24 \
 *     --alias:@shared=./src/shared \
 *     --alias:electron=./src/main/dev/electron-stub.mjs \
 *     --outfile=<tmp>/core-check.mjs
 *   node <tmp>/core-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../db'
import { SettingsStore, parseSettingsPatch } from '../settings'
import { TurnRecorder } from '../turn-recorder'
import { parseAgentToMain } from '../agent-host'
import { FALLBACK_MODELS, isFreeTierModel, sortModels } from '../openrouter'
import {
  appendMessage,
  createSession,
  getSession,
  getSessionDetail
} from '../sessions'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AgentEvent } from '@shared/types'

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

function rejects(label: string, body: () => unknown): void {
  try {
    body()
    check(label, false, 'expected a throw')
  } catch {
    check(label, true)
  }
}

function main(): void {
  const directory = mkdtempSync(join(tmpdir(), 'ishkapon-corecheck-'))
  const file = join(directory, 'ishkapon.db')
  const db = new Database(file)

  try {
    checkSettings(db)
    checkRecorder(db)
    checkAgentMessages()
    checkModelCatalog()
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

function checkSettings(db: Database): void {
  section('settings: defaults and validation')

  const store = new SettingsStore(db)
  check('defaults match the contract', JSON.stringify(store.get()) === JSON.stringify(DEFAULT_SETTINGS), store.get())

  const updated = store.update({ theme: 'light', pythonTimeoutMs: 500, maxOutputTokens: 100_000 })
  check('theme applied', updated.theme === 'light', updated.theme)
  check('pythonTimeoutMs clamped up to 1000', updated.pythonTimeoutMs === 1_000, updated.pythonTimeoutMs)
  check('maxOutputTokens clamped down to 32768', updated.maxOutputTokens === 32_768, updated.maxOutputTokens)
  check(
    'userInstructions truncated at 8000',
    store.update({ userInstructions: 'x'.repeat(9_000) }).userInstructions.length === 8_000
  )

  const model = store.update({ modelId: '  openrouter/free  ' })
  check('modelId trimmed', model.modelId === 'openrouter/free', model.modelId)
  check('modelId can be cleared', store.update({ modelId: null }).modelId === null)

  rejects('unknown key rejected', () => parseSettingsPatch({ shellEnabled: true }))
  rejects('bad theme rejected', () => parseSettingsPatch({ theme: 'neon' }))
  rejects('bad modelId rejected', () => parseSettingsPatch({ modelId: 'gpt-4o' }))
  rejects('non-boolean showThinking rejected', () => parseSettingsPatch({ showThinking: 'yes' }))
  rejects('non-object patch rejected', () => parseSettingsPatch('theme'))
  check('undefined values are ignored', JSON.stringify(parseSettingsPatch({ theme: undefined })) === '{}')

  // A no-op patch must not rewrite the row.
  const before = db.get('SELECT value, updated_at FROM settings WHERE key = ?', 'app')
  store.update({ theme: 'light' })
  const after = db.get('SELECT value, updated_at FROM settings WHERE key = ?', 'app')
  check('no-op patch is not persisted', before?.['updated_at'] === after?.['updated_at'])

  section('settings: persistence and migration')
  const reopened = new SettingsStore(db)
  check('settings survive a reopen', reopened.get().theme === 'light', reopened.get())

  const stored = db.get('SELECT value FROM settings WHERE key = ?', 'app')
  const parsed = JSON.parse(String(stored?.['value'])) as { version: number }
  check('stored document is versioned', parsed.version === 1, parsed)

  // A pre-versioning row stored the values object directly.
  db.run(
    "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify({ theme: 'dark', showThinking: false, pythonTimeoutMs: 12_345 })
  )
  const migrated = new SettingsStore(db)
  check('legacy unwrapped document migrates', migrated.get().theme === 'dark', migrated.get())
  check('legacy booleans migrate', migrated.get().showThinking === false)
  check('legacy numbers migrate', migrated.get().pythonTimeoutMs === 12_345)
  check('missing fields fall back to defaults', migrated.get().maxOutputTokens === DEFAULT_SETTINGS.maxOutputTokens)

  // A row that is not JSON at all must not stop the app from starting.
  db.run(
    "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    '{not json'
  )
  const recovered = new SettingsStore(db)
  check('unreadable settings fall back to defaults', recovered.get().theme === DEFAULT_SETTINGS.theme)
}

function checkRecorder(db: Database): void {
  section('turn-recorder: batched streaming persistence')

  const session = createSession(db, { modelId: null, preferredLanguage: 'auto' })
  const user = appendMessage(db, {
    sessionId: session.id,
    role: 'user',
    content: 'compute v = u + a t',
    status: 'complete'
  })
  const assistant = appendMessage(db, {
    sessionId: session.id,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })

  const recorder = new TurnRecorder(db)
  const deltas = ['v = 2', ' + 9.81', ' * 3']
  for (const delta of deltas) {
    recorder.record({ type: 'message.delta', sessionId: session.id, messageId: assistant.id, delta })
  }

  const midStream = getSessionDetail(db, session.id)?.messages.find((m) => m.id === assistant.id)
  check('deltas are buffered, not written per token', midStream?.content === '', midStream?.content)

  recorder.record({ type: 'reasoning.delta', sessionId: session.id, messageId: assistant.id, delta: 'think' })
  recorder.record({ type: 'compaction.started', sessionId: session.id })

  const toolEvent: AgentEvent = {
    type: 'tool.started',
    sessionId: session.id,
    messageId: assistant.id,
    toolCall: {
      id: 'tc-recorder',
      sessionId: session.id,
      messageId: assistant.id,
      seq: 0,
      tool: 'python',
      code: 'u = 2\na = 9.81\nt = 3\nv = u + a * t',
      stdout: null,
      resultValue: null,
      error: null,
      status: 'running',
      durationMs: null,
      truncated: false,
      createdAt: 0
    }
  }
  recorder.record(toolEvent)
  recorder.record({ type: 'tool.output', sessionId: session.id, toolCallId: 'tc-recorder', chunk: '31.43' })

  const afterToolStart = getSessionDetail(db, session.id)
  check(
    'tool call row opened with the host-supplied id',
    afterToolStart?.toolCalls[0]?.id === 'tc-recorder',
    afterToolStart?.toolCalls.map((c) => c.id)
  )
  check(
    'tool output is buffered too',
    afterToolStart?.toolCalls[0]?.stdout === null,
    afterToolStart?.toolCalls[0]?.stdout
  )

  // The host opens the card when the model commits to the call, with no source
  // yet, and re-emits `tool.started` from the tool's own `onStart` once the code
  // has been parsed. That must refine the row, not collide with it.
  recorder.record({
    ...toolEvent,
    toolCall: { ...toolEvent.toolCall, code: '' }
  })
  recorder.record(toolEvent)

  const afterDuplicate = getSessionDetail(db, session.id)
  check(
    'a second tool.started for the same id does not add a row',
    afterDuplicate?.toolCalls.length === 1,
    afterDuplicate?.toolCalls.map((c) => c.id)
  )
  check(
    'the parsed source replaces the empty one',
    afterDuplicate?.toolCalls[0]?.code === 'u = 2\na = 9.81\nt = 3\nv = u + a * t',
    afterDuplicate?.toolCalls[0]?.code
  )
  check(
    'the card keeps its original seq',
    afterDuplicate?.toolCalls[0]?.seq === afterToolStart?.toolCalls[0]?.seq,
    afterDuplicate?.toolCalls[0]?.seq
  )

  recorder.record({
    type: 'tool.finished',
    sessionId: session.id,
    toolCallId: 'tc-recorder',
    status: 'complete',
    resultValue: '31.43',
    durationMs: 12,
    truncated: false
  })

  const afterToolFinish = getSessionDetail(db, session.id)
  check(
    'finishing a call flushes its buffered stdout first',
    afterToolFinish?.toolCalls[0]?.stdout === '31.43',
    afterToolFinish?.toolCalls[0]?.stdout
  )
  check('call result stored', afterToolFinish?.toolCalls[0]?.resultValue === '31.43')
  check('call duration stored', afterToolFinish?.toolCalls[0]?.durationMs === 12)

  recorder.record({
    type: 'compaction.finished',
    sessionId: session.id,
    summary: '## Problem\ncompute v'
  })
  const compacted = getSession(db, session.id)
  check('compaction summary stored', compacted?.summary?.startsWith('## Problem') === true, compacted?.summary)
  check(
    'summary bound stops before the in-progress assistant row',
    compacted?.summaryUpToSeq === user.seq,
    compacted?.summaryUpToSeq
  )

  recorder.record({
    type: 'turn.finished',
    sessionId: session.id,
    messageId: assistant.id,
    usage: { tokensIn: 300, tokensOut: 40, costUsd: 0.0004 }
  })

  const finished = getSessionDetail(db, session.id)
  const row = finished?.messages.find((m) => m.id === assistant.id)
  check('turn.finished flushes the buffered text', row?.content === deltas.join(''), row?.content)
  check('reasoning persisted', row?.reasoning === 'think', row?.reasoning)
  check('status complete', row?.status === 'complete', row?.status)
  check('usage persisted', row?.tokensIn === 300 && row?.tokensOut === 40 && row?.costUsd === 0.0004, row)

  // An interrupted turn: the text survives, the status does not stay streaming.
  const second = appendMessage(db, {
    sessionId: session.id,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })
  recorder.record({ type: 'message.delta', sessionId: session.id, messageId: second.id, delta: 'half an ans' })
  recorder.failStreamingMessage(second.id, 'error')

  const interrupted = getSessionDetail(db, session.id)?.messages.find((m) => m.id === second.id)
  check('interrupted text flushed on failure', interrupted?.content === 'half an ans', interrupted?.content)
  check('interrupted status closed', interrupted?.status === 'error', interrupted?.status)

  recorder.dispose()
  const sealed = getSessionDetail(db, session.id)
  const sealedRow = sealed?.messages.find((m) => m.id === assistant.id)
  recorder.record({ type: 'message.delta', sessionId: session.id, messageId: assistant.id, delta: 'ignored' })
  const afterDispose = getSessionDetail(db, session.id)?.messages.find((m) => m.id === assistant.id)
  check('a disposed recorder ignores further events', afterDispose?.content === sealedRow?.content)
}

function checkAgentMessages(): void {
  section('agent-host: inbound message narrowing')

  check('host.ready accepted', parseAgentToMain({ type: 'host.ready' })?.type === 'host.ready')
  check(
    'host.error defaults its message',
    parseAgentToMain({ type: 'host.error' })?.type === 'host.error' &&
      (parseAgentToMain({ type: 'host.error' }) as { message: string }).message.length > 0
  )

  check('null rejected', parseAgentToMain(null) === null)
  check('array rejected', parseAgentToMain([]) === null)
  check('unknown type rejected', parseAgentToMain({ type: 'nope', sessionId: 's' }) === null)
  check('event without a sessionId rejected', parseAgentToMain({ type: 'message.delta' }) === null)
  check(
    'delta without text rejected',
    parseAgentToMain({ type: 'message.delta', sessionId: 's', messageId: 'm' }) === null
  )
  check(
    'tool.finished without an id rejected',
    parseAgentToMain({ type: 'tool.finished', sessionId: 's' }) === null
  )
  check(
    'tool.finished falls back to a safe status',
    (
      parseAgentToMain({ type: 'tool.finished', sessionId: 's', toolCallId: 't' }) as {
        status: string
      }
    ).status === 'error'
  )

  const started = parseAgentToMain({
    type: 'tool.started',
    sessionId: 's',
    messageId: 'm',
    toolCall: { id: 'tc', code: '1+1', tool: 'shell', sessionId: 'wrong' }
  })
  check(
    'a host claiming a second tool is forced to python',
    started?.type === 'tool.started' && started.toolCall.tool === 'python',
    started
  )
  check(
    'the event ids override a mislabelled nested tool call',
    started?.type === 'tool.started' && started.toolCall.sessionId === 's' && started.toolCall.messageId === 'm',
    started
  )

  const finished = parseAgentToMain({
    type: 'turn.finished',
    sessionId: 's',
    messageId: 'm',
    usage: { tokensIn: 'many', tokensOut: 5 }
  })
  check(
    'a non-numeric token count degrades to 0',
    finished?.type === 'turn.finished' && finished.usage.tokensIn === 0 && finished.usage.tokensOut === 5,
    finished
  )

  const error = parseAgentToMain({ type: 'turn.error', sessionId: 's' })
  check(
    'turn.error gets a default message and is non-fatal',
    error?.type === 'turn.error' && error.fatal === false && error.message.length > 0,
    error
  )
}

function checkModelCatalog(): void {
  section('model catalog: fallback and ordering')

  check('free tier detected by suffix', isFreeTierModel('deepseek/deepseek-chat-v3-0324:free'))
  check('free router detected', isFreeTierModel('openrouter/free'))
  check('paid model is not free tier', !isFreeTierModel('openai/gpt-4.1-mini'))

  const sorted = sortModels([
    { id: 'z/paid', name: 'Zed', contextLength: 1, pricingPrompt: 1, pricingCompletion: 1, supportsTools: true },
    { id: 'a/free:free', name: 'Ay', contextLength: 1, pricingPrompt: 0, pricingCompletion: 0, supportsTools: true }
  ])
  check('free models sort first', sorted[0]?.id === 'a/free:free', sorted.map((m) => m.id))

  check('fallback list is non-empty', FALLBACK_MODELS.length > 0)
  check(
    'every fallback model can call tools',
    FALLBACK_MODELS.every((model) => model.supportsTools),
    FALLBACK_MODELS.filter((m) => !m.supportsTools).map((m) => m.id)
  )
  check(
    'every fallback model has a context length',
    FALLBACK_MODELS.every((model) => model.contextLength > 0)
  )
  check(
    'the free router is in the fallback list',
    FALLBACK_MODELS.some((model) => model.id === 'openrouter/free')
  )
}

main()
