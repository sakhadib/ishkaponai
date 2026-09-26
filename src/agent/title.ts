/**
 * Session titles.
 *
 * A session's title is the only thing the student sees in the sidebar before
 * they open it, so a truncation of the first message ("An elephant moves at 10
 * km/h. How many met…") is a poor label. A short, cheap model call turns it into
 * something meaningful instead.
 *
 * Deliberately cheap and deliberately separate from the solving turn:
 *
 *  - It runs on `openrouter/free`, a fixed free router, never on the model the
 *    student chose for problem-solving. Titles are a chore and must not be the
 *    reason a turn costs money.
 *  - It is **not awaited** by the turn. The answer is what the student is
 *    waiting for, and a title arriving a second later is fine.
 *  - It never blocks or fails a turn. Any error falls back to the truncated
 *    first message that main already wrote.
 *  - It only ever fires on a session's **first** message, so a long conversation
 *    is not re-titled on every turn.
 */
import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { LanguagePref } from '@shared/types'

/**
 * The model used for session titles.
 *
 * `openrouter/free` is OpenRouter's free-model router: it resolves to whatever
 * free model is currently available, so this costs the student nothing and
 * cannot go stale when a free model is retired. It is fixed, with no setting to
 * override it, for three reasons:
 *
 *  - A title is a chore. It must never be the reason a turn costs money, and a
 *    student-supplied slug here would put that back in their hands by accident.
 *  - It has no tool-calling requirement, so there is no reason to involve the
 *    model the student chose for solving problems.
 *  - One less setting is one less thing to explain and one less way for the
 *    background path to diverge from the solving path.
 *
 * If the router is unavailable the call fails and the truncated-first-message
 * title stands, so this is a safe dependency to hardcode.
 */
export const TITLE_MODEL = 'openrouter/free'

/** Longest title we will store. Anything longer is truncated by the model. */
const MAX_TITLE_CHARS = 60

const TITLE_SYSTEM_PROMPT = `You name conversations.

Read the student's first message and reply with a title of at most 6 words that
says what the conversation is about.

Rules:
- Match the language of the student's message. A Bangla question gets a Bangla title.
- No quotation marks, no surrounding punctuation, no emoji, no trailing full stop.
- Describe the topic, do not restate the whole question.
- Reply with the title only. No preamble, no explanation, no alternatives.`

/**
 * Tidies whatever came back: trims, strips wrapping quotes and trailing
 * punctuation, collapses whitespace, and enforces the length cap.
 *
 * A model asked for "title only" will occasionally add a preamble anyway, and
 * this is what keeps a stray "Title: Elephant speed problem" out of the sidebar.
 */
export function tidyTitle(raw: string): string {
  let title = raw.trim()

  // Strip a leading label such as `Title:` or `বিষয়:`.
  title = title.replace(/^(?:title|subject|topic)\s*[:\-—]\s*/i, '')
  title = title.replace(/^[^\p{L}\p{N}]+/u, '')

  title = title.replace(/\s+/gu, ' ').trim()

  // Drop a single wrapping quote pair, not an apostrophe inside a word.
  const quoted = /^(['"“‘])(.*)\1$/su.exec(title)
  if (quoted?.[2] !== undefined) title = quoted[2].trim()

  // Trailing sentence punctuation, but keep an abbreviation's dot if that is
  // all the title is.
  title = title.replace(/[.。!?！？,;:]+$/u, '').trim()

  if (title.length > MAX_TITLE_CHARS) {
    title = `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
  }

  return title
}

/** True when a tidied title is worth storing over the existing fallback. */
export function isUsableTitle(title: string): boolean {
  return title.length > 0
}

export interface TitleRequest {
  model: LanguageModel
  /** The student's first message, possibly long. */
  question: string
  preferredLanguage: LanguagePref
}

/**
 * Produces a session title, or `null` if it could not be generated.
 *
 * Never throws: a failed title is a cosmetic problem and must not surface as an
 * error in the transcript.
 */
export async function generateSessionTitle(request: TitleRequest): Promise<string | null> {
  const languageNote =
    request.preferredLanguage === 'bn'
      ? 'The student has chosen Bangla, so title in Bangla.'
      : request.preferredLanguage === 'en'
        ? 'The student has chosen English, so title in English.'
        : ''

  const prompt = `${request.question}\n\n---\n${languageNote}`.trim()

  try {
    // Capped hard: a title is a few tokens, and an uncapped call on a small
    // model is an invitation to ramble.
    const result = await generateText({
      model: request.model,
      system: TITLE_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 32
    })

    const title = tidyTitle(result.text)
    return isUsableTitle(title) ? title : null
  } catch {
    // Swallowed deliberately — see the module comment.
    return null
  }
}
