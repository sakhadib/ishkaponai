/**
 * Bengali numeral normalisation (spec §13.2).
 *
 * KaTeX cannot parse Bengali digits. A student who types `২+৩` — which is
 * natural for the target user — would otherwise get a raw KaTeX parse error
 * instead of an answer. This module maps `০১২৩৪৫৬৭৮৯` to `0123456789`.
 *
 * The mapping is built from literal glyphs rather than a hand-written codepoint
 * offset, because the two adjacent blocks are visually near-identical:
 * U+09E6..U+09EF is Bengali, U+0966..U+096F is Assamese. Getting that wrong
 * fails silently, and the literals cannot be mis-transcribed.
 *
 * The function is deliberately pure and exported so it can be verified without
 * a test runner: `node --experimental-strip-types` against this file exercises
 * the real code, not a copy of it.
 *
 * Prose is never normalised — only math and code spans. See
 * `normalizeNumeralsInMarkdown` for the segment-aware wrapper used by the
 * Markdown pipeline, and `lib/markdown.tsx` for the math-node plugin.
 */

/**
 * The ten Bengali digits in numeric order. Index `i` corresponds to ASCII `i`.
 * Declared `as const` so the tuple type survives; only the string values matter.
 */
const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const

const BENGALI_DIGIT_TO_ASCII: ReadonlyMap<string, string> = new Map(
  BENGALI_DIGITS.map((digit, index) => [digit as string, String(index)])
)

/** True for a single Bengali digit `০`–`৯`. Bengali prose is not a digit. */
export function isBengaliDigit(char: string): boolean {
  return BENGALI_DIGIT_TO_ASCII.has(char)
}

/**
 * Maps one Bengali digit to its ASCII equivalent. Returns `undefined` for
 * anything else, so callers can use it as a predicate.
 */
export function bengaliDigitToAscii(char: string): string | undefined {
  return BENGALI_DIGIT_TO_ASCII.get(char)
}

/** True when the string contains at least one Bengali digit. */
export function containsBengaliDigits(text: string): boolean {
  for (const char of text) {
    if (BENGALI_DIGIT_TO_ASCII.has(char)) return true
  }
  return false
}

/**
 * Replaces every Bengali digit in `text` with its ASCII equivalent, leaving
 * every other character exactly as it was (including Bangla prose letters,
 * punctuation, and astral characters).
 *
 * This is the primitive. Callers that must preserve prose should use
 * `normalizeNumeralsInMarkdown` instead of applying this to whole documents.
 */
export function normalizeNumerals(input: string): string {
  if (!containsBengaliDigits(input)) return input

  let out = ''
  for (const char of input) {
    out += BENGALI_DIGIT_TO_ASCII.get(char) ?? char
  }
  return out
}

// ---------------------------------------------------------------------------
// Markdown-aware segmentation
// ---------------------------------------------------------------------------

/**
 * Inline-code or fence delimiter runs, captured so the run length is known.
 */
const FENCE = /(`{3,}|~{3,})/

export type MarkdownSegmentKind = 'prose' | 'code'

export interface MarkdownSegment {
  kind: MarkdownSegmentKind
  text: string
}

/**
 * Splits Markdown source into `prose` and `code` segments without a Markdown
 * parser, so this module stays dependency-free and testable in isolation.
 *
 * Recognises fenced blocks (``` and ~~~), inline code spans (CommonMark's
 * equal-length run rule), and indented code. That is exactly the distinction
 * that matters for the "do not normalise prose" rule.
 *
 * **Invariant:** the concatenation of every segment's `text` is exactly the
 * input, newlines included.
 */
export function segmentMarkdown(input: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  const lines = input.split('\n')
  let fenceMarker: string | null = null

  const push = (kind: MarkdownSegmentKind, text: string): void => {
    if (text === '') return
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) last.text += text
    else segments.push({ kind, text })
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const trimmed = line.trimStart()
    // Re-emit the newline that `split` consumed, preserving the invariant.
    const eol = i < lines.length - 1 ? '\n' : ''

    // Inside a fenced block: the closing fence is a run of the same character,
    // optionally indented, with nothing else on the line.
    if (fenceMarker !== null) {
      if (trimmed.startsWith(fenceMarker) && trimmed.trim() === fenceMarker) fenceMarker = null
      push('code', line + eol)
      continue
    }

    const fenceMatch = FENCE.exec(trimmed)
    if (fenceMatch && fenceMatch.index === 0) {
      fenceMarker = fenceMatch[1] as string
      push('code', line + eol)
      continue
    }

    // Indented code block (four spaces or a tab).
    if (/^(?: {4}|\t)/.test(line)) {
      push('code', line + eol)
      continue
    }

    // Inline code spans, line by line.
    let cursor = 0
    let emitted = false
    while (cursor < line.length) {
      const open = line.indexOf('`', cursor)
      if (open === -1) {
        push('prose', line.slice(cursor) + eol)
        emitted = true
        break
      }

      let runEnd = open
      while (runEnd < line.length && line[runEnd] === '`') runEnd += 1
      const runLength = runEnd - open
      const close = line.indexOf('`'.repeat(runLength), runEnd)
      if (close === -1) {
        // Unmatched backtick: not a code span. Treat the rest as prose.
        push('prose', line.slice(cursor) + eol)
        emitted = true
        break
      }

      push('prose', line.slice(cursor, open))
      push('code', line.slice(open, close + runLength))
      cursor = close + runLength
      emitted = true
      if (cursor >= line.length) {
        push('prose', eol)
        break
      }
    }
    // An empty line still contributes its newline.
    if (!emitted) push('prose', eol)
  }

  return segments
}

/**
 * Normalises Bengali digits in the **code** segments of a Markdown document and
 * leaves prose untouched.
 *
 * `$$ … $$` display math is deliberately not handled here. The Markdown
 * pipeline normalises math nodes themselves in a `remark` plugin, where the
 * parser has already isolated the math; doing it again on the raw string would
 * be redundant and would risk touching display-math prose if the plugin were
 * ever removed.
 */
export function normalizeNumeralsInMarkdown(input: string): string {
  if (!containsBengaliDigits(input)) return input

  const segments = segmentMarkdown(input)
  const hasCode = segments.some((segment) => segment.kind === 'code')
  if (!hasCode) return input

  return segments
    .map((segment) => (segment.kind === 'code' ? normalizeNumerals(segment.text) : segment.text))
    .join('')
}
