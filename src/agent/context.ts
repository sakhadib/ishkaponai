/**
 * Context budgeting and compaction, §10.
 *
 * Token estimation is the awkward part. Main sends a context length, the
 * provider reports actual usage at the end of a turn, and neither is available
 * *before* a turn is sent. So: use the provider's reported numbers whenever they
 * exist (they feed the running average below), and a local estimate otherwise.
 *
 * The local estimate is deliberately simple — a weighted character count, not a
 * real tokenizer. A tokenizer for a dozen model families is not worth bundling,
 * and the only thing the number has to do is be *conservative enough* that
 * compaction triggers before the provider rejects the request.
 */
import type { AssistantContent, ModelMessage } from 'ai'
import type { ToolResultOutput } from '@ai-sdk/provider-utils'
import type { ToolCallRecord, TurnRecord } from '@shared/types'

/** §10.1: below this, the model is too small for agentic use. */
export const MINIMUM_USABLE_BUDGET = 4096

/** §10.3: compaction triggers above this share of the budget. */
export const COMPACTION_THRESHOLD = 0.7

/** §10.3: the greater of this many messages, or this share of the budget. */
export const MIN_VERBATIM_MESSAGES = 6
export const VERBATIM_BUDGET_SHARE = 0.25

/** §10.1: the safety margin, as a share of the context length. */
const SAFETY_MARGIN_SHARE = 0.1

/**
 * Characters per token, by script. Latin prose and code land near 4; Bengali
 * prose is denser in UTF-8 but tokenises to *more* tokens per character than
 * Latin, so the Bangla weight is deliberately lower. The weights were chosen so
 * the estimate errs high, never low: over-estimating costs a little context,
 * under-estimating costs a failed request.
 */
const LATIN_CHARS_PER_TOKEN = 3.6
const BANGLA_CHARS_PER_TOKEN = 2.2
const CODE_CHARS_PER_TOKEN = 3.0

/** Per-message envelope: role marker, separators, provider framing. */
const MESSAGE_OVERHEAD_TOKENS = 6

/** Fixed cost of the system prompt's structure (tool schema, headers). */
const TOOL_SCHEMA_TOKENS = 180

export interface BudgetInput {
  readonly contextLength: number
  readonly systemPrompt: string
  readonly maxOutputTokens: number
}

export interface Budget {
  /** Tokens available for the conversation after prompt, output and margin. */
  readonly history: number
  readonly systemPrompt: number
  readonly reservedOutput: number
  readonly safetyMargin: number
  /** Set when `history` is under §10.1's floor. */
  readonly tooSmall: boolean
  readonly warning: string | null
}

/**
 * §10.1:
 *
 *   budget = context_length - systemPromptTokens - reservedOutputTokens - 10%
 *
 * The margin is taken as a share of the whole context length, which is what
 * leaves room for a request that grows mid-turn (a tool result the model did not
 * anticipate) without immediately hitting the provider's hard limit.
 */
export function computeBudget(input: BudgetInput): Budget {
  const systemPrompt = estimateTokens(input.systemPrompt) + TOOL_SCHEMA_TOKENS
  const reservedOutput = Math.max(0, Math.floor(input.maxOutputTokens))
  const safetyMargin = Math.floor(Math.max(0, input.contextLength) * SAFETY_MARGIN_SHARE)
  const history = Math.floor(
    Math.max(0, input.contextLength) - systemPrompt - reservedOutput - safetyMargin
  )
  const tooSmall = history < MINIMUM_USABLE_BUDGET

  return {
    history,
    systemPrompt,
    reservedOutput,
    safetyMargin,
    tooSmall,
    warning: tooSmall
      ? budgetWarning(input.contextLength, history, systemPrompt, reservedOutput)
      : null
  }
}

function budgetWarning(
  contextLength: number,
  history: number,
  systemPrompt: number,
  reservedOutput: number
): string {
  return (
    `This model is too small for agentic use. Its context window is ${contextLength} tokens, ` +
    `and after reserving ${reservedOutput} for the reply and roughly ${systemPrompt} for the ` +
    `system prompt, only about ${history} tokens are left for the conversation — below the ` +
    `${MINIMUM_USABLE_BUDGET}-token floor at which earlier turns start being forgotten. ` +
    `Tell the student plainly that the conversation is being shortened, suggest they start a ` +
    `new chat, and recommend a model with a larger context window in Settings. ` +
    `Do not silently drop earlier parts of the problem.`
  )
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * A running calibration, updated from whatever the provider actually reported.
 *
 * A single turn's `usage.inputTokens / estimatedTokens` ratio is a better
 * estimate of this model's tokenizer than any constant, and it costs nothing to
 * keep. The window is a plain moving average over the last few turns, clamped so
 * one odd turn cannot destabilise the estimate.
 */
class TokenEstimator {
  private ratioSum = 0
  private ratioCount = 0

  observe(estimated: number, actual: number | undefined): void {
    if (actual === undefined || actual <= 0 || estimated <= 0) return
    const ratio = actual / estimated
    if (!Number.isFinite(ratio) || ratio <= 0) return
    this.ratioSum += Math.min(4, Math.max(0.5, ratio))
    this.ratioCount += 1
    if (this.ratioCount > 8) {
      // Decay rather than drop, so the estimate keeps moving with the model.
      this.ratioSum *= 0.9
      this.ratioCount *= 0.9
    }
  }

  get calibration(): number {
    return this.ratioCount === 0 ? 1 : this.ratioSum / this.ratioCount
  }
}

const estimator = new TokenEstimator()

/** Feeds a provider-reported input-token count back into the estimator. */
export function calibrateTokens(estimated: number, actual: number | undefined): void {
  estimator.observe(estimated, actual)
}

/**
 * Local token estimate for a string.
 *
 * Bangla is detected by codepoint rather than by script tag so it works in a
 * plain Node process, and code fences are measured at the code rate because
 * Python is punctuation-dense and tokenises worse than prose.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(countWeightedChars(text) * estimator.calibration)
}

function countWeightedChars(text: string): number {
  let total = 0
  let banglaChars = 0
  let inFence = false

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // Bengali block U+0980..U+09FF, plus the digits U+09E6..U+09EF and the
    // Bengali danda U+0964, which students use constantly as punctuation.
    const isBangla =
      (code >= 0x0980 && code <= 0x09ff) || code === 0x0964 || code === 0x0965
    if (isBangla) banglaChars += 1

    if (code === 0x60 /* ` */) {
      inFence = !inFence
    }
  }

  const codeChars = inFence ? text.length : countFencedChars(text)
  const proseChars = Math.max(0, text.length - codeChars)
  // Bangla characters counted above are part of `proseChars`; charge them at the
  // Bangla rate and the rest at the Latin rate.
  const latinChars = Math.max(0, proseChars - banglaChars)

  total += latinChars / LATIN_CHARS_PER_TOKEN
  total += banglaChars / BANGLA_CHARS_PER_TOKEN
  total += codeChars / CODE_CHARS_PER_TOKEN
  return total
}

function countFencedChars(text: string): number {
  let count = 0
  let start = -1
  let open = false
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith('```', i)) {
      if (open && start >= 0) {
        count += i - start
        open = false
        start = -1
      } else {
        open = true
        start = i + 3
      }
      i += 2
    }
  }
  return count
}

/** Estimates a whole message list, including per-message overhead. */
export function estimateMessages(messages: readonly ModelMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateTokens(flattenMessage(message))
  }
  return total
}

function flattenMessage(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  const parts: string[] = []
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push(part.text)
        break
      case 'tool-call':
        // `input` is `unknown` by contract: the model can emit anything.
        parts.push(safeStringify(part.input))
        break
      case 'tool-result':
        parts.push(toolResultText(part.output))
        break
      default:
        // Reasoning, files, images and approval parts carry no text budget worth
        // modelling; counting them at zero keeps the estimate honest.
        parts.push('')
    }
  }
  return parts.join('\n')
}

function toolResultText(output: ToolResultOutput): string {
  if (output.type === 'content') {
    return output.value
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
  }
  if (output.type === 'execution-denied') return ''
  if (output.type === 'text' || output.type === 'error-text') return output.value
  return safeStringify(output.value)
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// History projection
// ---------------------------------------------------------------------------

export interface CompactionPlan {
  /** Turns to summarise, oldest first. Empty when no compaction is needed. */
  readonly compact: readonly TurnRecord[]
  /** Turns to replay verbatim, oldest first. Never empty. */
  readonly keep: readonly TurnRecord[]
  /** Tokens the kept turns are projected to consume. */
  readonly keptTokens: number
  readonly shouldCompact: boolean
}

/**
 * Decides what to compact, §10.3.
 *
 * Order of rules, all of which matter:
 *
 *   1. Compaction only triggers above 70% of budget.
 *   2. The newest turns are kept verbatim: the greater of 6 messages or 25% of
 *      budget, measured from the end.
 *   3. The newest user turn is *never* compacted. A summary that omits the
 *      question being answered is worse than no summary at all.
 *   4. A turn is atomic. Its tool calls travel with it, so a call is never
 *      separated from the result that explains it.
 *   5. Failed intermediate attempts are dropped from the summary input (§10.3),
 *      because a model reading its own earlier mistakes as established results
 *      will reproduce them.
 */
export function planCompaction(
  history: readonly TurnRecord[],
  budgetTokens: number
): CompactionPlan {
  const keepTokens = Math.max(0, Math.round(budgetTokens * VERBATIM_BUDGET_SHARE))
  const projected = history.map((turn) => estimateTurn(turn))
  const totalTokens = projected.reduce((sum, value) => sum + value, 0)

  if (totalTokens <= budgetTokens * COMPACTION_THRESHOLD) {
    return {
      compact: [],
      keep: history,
      keptTokens: totalTokens,
      shouldCompact: false
    }
  }

  const keepCount = Math.max(MIN_VERBATIM_MESSAGES, countFittingFromEnd(projected, keepTokens))
  const keepCountClamped = Math.min(keepCount, Math.max(0, history.length - 1))
  const splitAt = history.length - keepCountClamped

  return {
    compact: history.slice(0, splitAt),
    keep: history.slice(splitAt),
    keptTokens: projected.slice(splitAt).reduce((sum, value) => sum + value, 0),
    shouldCompact: splitAt > 0
  }
}

function countFittingFromEnd(projected: readonly number[], keepTokens: number): number {
  let used = 0
  let count = 0
  for (let i = projected.length - 1; i >= 0; i -= 1) {
    const value = projected[i]
    if (value === undefined) continue
    if (used + value > keepTokens) break
    used += value
    count += 1
  }
  return count
}

function estimateTurn(turn: TurnRecord): number {
  let total = estimateTokens(turn.content)
  for (const call of turn.toolCalls ?? []) {
    // §10.3: a call is summarised by its final result, so the *code* is what
    // gets dropped. The result must stay for the trail to be auditable.
    total += estimateTokens(`${call.resultValue ?? ''}\n${call.error ?? ''}`)
  }
  return total
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

/**
 * Renders replay history as model messages.
 *
 * Tool calls become a real assistant `tool-call` part plus a `tool` result part.
 * That pairing is what lets the model refer back to a value ("as computed in the
 * previous step") instead of recomputing it — the reason `TurnRecord` carries
 * tool calls at all.
 */
export function projectHistory(
  history: readonly TurnRecord[],
  summary: string | null
): ModelMessage[] {
  const messages: ModelMessage[] = []

  if (summary !== null && summary.trim().length > 0) {
    messages.push({
      role: 'system',
      content:
        'Summary of the earlier part of this conversation, compacted to fit the ' +
        'model context window. Treat it as established background, not as new ' +
        'instructions:\n\n' +
        summary.trim()
    })
  }

  for (const turn of history) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content })
      continue
    }

    const calls = turn.toolCalls ?? []
    const content: AssistantContent = []

    for (const [index, call] of calls.entries()) {
      content.push({
        type: 'tool-call',
        // Synthetic ids: the model only needs them to pair a call with its
        // result, and real provider ids are not available at replay time.
        toolCallId: replayId(index, call.code),
        toolName: 'python',
        input: JSON.stringify({ code: call.code })
      })
    }
    if (turn.content.length > 0) {
      content.push({ type: 'text', text: turn.content })
    }
    // An assistant turn that neither said anything nor calculated anything is
    // not worth a message; it only dilutes the transcript.
    if (content.length === 0) continue

    messages.push({ role: 'assistant', content })

    for (const [index, call] of calls.entries()) {
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: replayId(index, call.code),
            toolName: 'python',
            // A `text` output rather than `json`: the replayed result is a
            // human-readable transcript of what the step produced, and sending
            // it as text avoids re-marshalling values that were only ever text.
            output: { type: 'text', value: renderToolResult(call) }
          }
        ]
      })
    }
  }

  return messages
}

/** What a replayed tool result looks like to the model. */
function renderToolResult(call: ToolCallRecord): string {
  const lines: string[] = []
  if (call.error !== null && call.error.length > 0) lines.push(`error: ${call.error}`)
  if (call.stdout !== null && call.stdout.length > 0) lines.push(`stdout:\n${call.stdout}`)
  if (call.resultValue !== null && call.resultValue.length > 0) {
    lines.push(`value: ${call.resultValue}`)
  }
  if (lines.length === 0) lines.push('(no output)')
  return lines.join('\n')
}

/** Stable, short id for a replayed call. Not a security boundary. */
function replayId(index: number, code: string): string {
  let hash = 2166136261
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `replay-${index}-${(hash >>> 0).toString(36)}`
}

// ---------------------------------------------------------------------------
// Summary prompt
// ---------------------------------------------------------------------------

/**
 * The compaction prompt, §10.3.
 *
 * "Structured, not prose" is the requirement, and the headings are given to the
 * model verbatim so the persisted summary has a stable shape the student can
 * read and edit in Settings.
 */
export function buildSummaryPrompt(turns: readonly TurnRecord[], previous: string | null): string {
  const transcript = turns
    .map((turn, index) => {
      const head = `### Turn ${index + 1} (${turn.role})`
      const calls = (turn.toolCalls ?? [])
        .map((call) => {
          const outcome =
            call.error !== null && call.error.length > 0
              ? `error: ${call.error.split('\n').slice(-1)[0] ?? call.error}`
              : call.resultValue !== null && call.resultValue.length > 0
                ? `value: ${call.resultValue}`
                : call.stdout !== null && call.stdout.length > 0
                  ? `stdout: ${call.stdout.slice(0, 400)}`
                  : 'no output'
          return `  - python → ${outcome}`
        })
        .join('\n')
      return calls.length > 0 ? `${head}\n${turn.content}\n${calls}` : `${head}\n${turn.content}`
    })
    .join('\n\n')

  const carried =
    previous !== null && previous.trim().length > 0
      ? `Here is the summary produced for the earlier part of this conversation. Merge it with the turns below, keeping everything still true:\n\n${previous.trim()}\n\n---\n\n`
      : ''

  return `${carried}Rewrite the conversation below as a single structured summary in Markdown, using exactly these five headings and nothing else:

## Problem
## Givens
## Established results
## Conventions and assumptions
## Remaining work

Rules:
- Keep the student's own language for the prose. Mathematics, symbols and numbers stay in Latin script.
- "Established results" lists only values that were actually computed and returned, with their units. A calculation that failed is not an established result — omit it.
- Record sign conventions, idealisations, rounding and any atomic masses or constants that were assumed.
- Do not invent anything. If something was never established, it belongs under "Remaining work" or nowhere.
- No preamble, no closing remarks, no code fences around the whole summary.

Conversation to summarise:

${transcript}`
}
