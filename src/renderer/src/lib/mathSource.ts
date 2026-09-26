/**
 * Math source normalisation, run before `remark-math` parses the Markdown.
 *
 * `react-markdown` + `remark-math` alone handles LaTeX badly in practice, for
 * three reasons this module exists to fix:
 *
 * 1. **`\[ \]` and `\( \)` are not supported.** `remark-math@6` only knows
 *    `$…$` and `$$…$$`. Models emit LaTeX's own delimiters constantly, and they
 *    would render as literal `\[x = 1\]` text. These are rewritten to the
 *    dollar forms remark-math does understand.
 *
 * 2. **Bare environments are not supported.** A model that writes
 *    `\begin{align}…\end{align}` with no delimiters at all produces a wall of
 *    unrendered LaTeX. Those are wrapped in `$$`.
 *
 * 3. **Currency is mistaken for mathematics.** This is the failure the library
 *    documents itself: *"Single dollars … often interfere with 'normal' dollars
 *    in text."* `It costs $5 and $10` parses as inline math spanning
 *    `5 and `, and the student's answer arrives with a mangled price in it.
 *
 * The approach for (3) is to invert the problem. Rather than trying to find
 * mathematics among `$` characters, this escapes every `$` that is **not** part
 * of a recognised math span, leaving `remark-math` a clean field of genuine
 * delimiters. Escaping is the safe direction: a false positive renders as
 * literal text that still reads correctly, whereas a false negative mangles the
 * answer.
 *
 * Only **prose** is transformed. Fenced and inline code is passed through
 * byte-for-byte, so a Python line containing `$` or `\[` is untouched — that
 * matters here because the model's own calculation snippets go through this
 * same pipeline.
 */
import { segmentMarkdown } from './numerals'

/**
 * Content that is a bare monetary amount rather than an expression. `$5$` and
 * `$1,000.50$` are prices written with dollar signs on both sides, not maths.
 */
const CURRENCY_AMOUNT = /^[\d.,]+$/

/**
 * Decides whether the text between two `$` characters is an expression.
 *
 * The rules, in order:
 *  - non-empty
 *  - no leading or trailing whitespace — `$5 and $` fails here, which is what
 *    rescues the very common `between $5 and $10` case
 *  - not a bare number, so `$5$` stays currency
 */
function isMathContent(inner: string): boolean {
  if (inner.length === 0) return false
  if (inner !== inner.trim()) return false
  if (CURRENCY_AMOUNT.test(inner)) return false
  return true
}

/**
 * The real `$$…$$` display-math spans in `text`, as `[start, end)` index pairs.
 *
 * A single `$$` that never closes is not a span. Leaving it out is what stops
 * the structuring pass below from treating half an equation as a gap to rewrite,
 * which is how a doubled pair of delimiters used to appear.
 */
function displaySpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < text.length) {
    if (!text.startsWith('$$', i)) {
      i += 1
      continue
    }
    const close = text.indexOf('$$', i + 2)
    if (close === -1) break
    spans.push([i, close + 2])
    i = close + 2
  }
  return spans
}

/**
 * Applies `rewrite` to the text *between* `$$` spans and never inside one.
 *
 * Spans found before the rewrite are copied byte for byte. That is the whole fix
 * for the doubled delimiters: the old version tested `(?<!\$)` immediately
 * before `\begin`, which is a single-character lookbehind and cannot see that a
 * `$$` opened on the *previous line*. An already-delimited `\begin{align}`
 * therefore got wrapped a second time, producing
 * `$$\n$$\begin{align}…\end{align}$$\n$$`, and remark-math parsed only the outer
 * pair — leaving the inner `$$` visible on screen. That is the report this fixes.
 */
function outsideSpans(text: string, rewrite: (gap: string) => string): string {
  const spans = displaySpans(text)
  if (spans.length === 0) return rewrite(text)

  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    out += rewrite(text.slice(cursor, start))
    out += text.slice(start, end)
    cursor = end
  }
  return out + rewrite(text.slice(cursor))
}

/**
 * Rewrites the undelimited LaTeX forms into real `$$` display blocks.
 *
 * **One kind of rewrite per pass**, and every pass re-reads the spans. Folding
 * them into a single pass over each gap did not work, because the second rewrite
 * then saw the `$$` the first one had just inserted: `\[\begin{align}…\end{align}\]`
 * became `$$` + `$$\begin{align}…\end{align}$$` + `$$` and parsed as two
 * equations with the delimiters in between.
 *
 * The newlines are unconditional and deliberate. `\[…\]` and a bare environment
 * are *display* mathematics in LaTeX, so making them blocks is correct even when
 * a model writes them mid-sentence — and remark-math only emits a display node
 * when the opening `$$` starts a line. Without the newlines, a wrapped
 * environment became inline math, which cannot span the blank line that follows
 * it, so the body was split and the text after it was swallowed.
 */
function structureMath(text: string): string {
  const withDisplayBrackets = outsideSpans(text, (gap) =>
    gap.replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$\n${body}\n$$\n`)
  )

  const withBareEnvironments = outsideSpans(withDisplayBrackets, (gap) =>
    // The back-reference keeps `\begin{align}` from pairing with a stray
    // `\end{equation}`, and the single capture group means the replacement must
    // wrap the entire match.
    gap.replace(
      /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/g,
      (match: string) => `\n$$\n${match}\n$$\n`
    )
  )

  return outsideSpans(withBareEnvironments, (gap) =>
    gap.replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`)
  )
}

/**
 * Escapes every `$` that does not delimit real mathematics, leaving genuine
 * `$…$` and `$$…$$` spans intact for `remark-math`.
 */
function escapeNonMathDollars(text: string): string {
  let out = ''
  let i = 0
  const n = text.length

  while (i < n) {
    const char = text[i] as string

    // The model already escaped it. Preserve, and do not treat it as an opener.
    if (char === '\\' && text[i + 1] === '$') {
      out += '\\$'
      i += 2
      continue
    }

    if (char !== '$') {
      out += char
      i += 1
      continue
    }

    // Display math. `$$` is only meaningful if it closes, so an unpaired one
    // degrades to escaped currency rather than swallowing the rest of the text.
    if (text.startsWith('$$', i)) {
      const close = text.indexOf('$$', i + 2)
      if (close !== -1) {
        out += text.slice(i, close + 2)
        i = close + 2
      } else {
        out += '\\$'
        i += 1
      }
      continue
    }

    // Inline math must close on the same line. Requiring that is what stops
    // `costs $5` and the first `$` of `$10` from pairing across a sentence.
    const lineEnd = text.indexOf('\n', i)
    const limit = lineEnd === -1 ? n : lineEnd
    const close = text.indexOf('$', i + 1)

    if (close !== -1 && close < limit) {
      const inner = text.slice(i + 1, close)
      if (isMathContent(inner)) {
        out += text.slice(i, close + 1)
        i = close + 1
        continue
      }
    }

    out += '\\$'
    i += 1
  }

  return out
}

/** Applies the prose-only transforms to one segment. */
function transformProse(text: string): string {
  // Structure first, then escape. The order matters: the structuring pass
  // creates `$$` spans of its own, and the escaper has to see them as real
  // mathematics rather than escape the delimiters it just inserted.
  return escapeNonMathDollars(structureMath(text))
}

/**
 * Normalises model-authored Markdown so `remark-math` can parse the
 * mathematics, and so currency is not misread as mathematics.
 *
 * Code segments are passed through unchanged, which is what keeps the model's
 * own Python snippets — full of `$` and backslashes — intact.
 */
export function normaliseMathSource(markdown: string): string {
  // Nothing to do without a delimiter, and this is the common case for short
  // turns, so skip the segmentation cost entirely.
  if (!markdown.includes('$') && !markdown.includes('\\')) return markdown

  return segmentMarkdown(markdown)
    .map((segment) => (segment.kind === 'code' ? segment.text : transformProse(segment.text)))
    .join('')
}
