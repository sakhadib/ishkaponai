/**
 * Math pipeline check: a `$$` delimiter must never survive to the screen.
 *
 * Run with:
 *   npx esbuild src/renderer/dev/math-check.ts --bundle --platform=node \
 *     --format=esm --target=node24 --alias:@shared=./src/shared \
 *     --alias:@=./src/renderer/src --outfile=out/math-check.mjs
 *   node out/math-check.mjs
 *
 * ## The bug
 *
 * A multi-line equation arrived with a visible `$$` in front of it and another
 * after it. The cause was a one-character lookbehind in `normaliseMathSource`:
 *
 *   /(?<!\$)\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/
 *
 * `(?<!\$)` asks "is the character immediately before `\begin` a `$`?" — but in
 * an already-delimited block that character is a **newline**, because the `$$`
 * opened on the previous line. The test passed, the environment got wrapped a
 * second time, and
 *
 *   $$\n\begin{align}…\end{align}\n$$
 *
 * became
 *
 *   $$\n$$\begin{align}…\end{align}$$\n$$
 *
 * remark-math parsed the outer pair as the equation and left the inner one as
 * literal text. Hence a rendered equation wearing a `$$` at each end.
 *
 * ## What this file asserts
 *
 * That `normaliseMathSource` followed by remark-math produces the right number
 * of math nodes, and that no `$$` survives into the rendered text. The second
 * half is the one that matters: a wrong node count can still look right, whereas
 * a surviving `$$` is the reported symptom exactly.
 *
 * The pipeline stops at `remark-rehype`, deliberately. Whether a delimiter is
 * visible is decided by remark-math — it either makes a math node or leaves the
 * text alone. `rehype-mathjax` only converts a math node to SVG, so including
 * it would add MathJax's `eval('require')` version probe, which needs the same
 * `PACKAGE_VERSION` define the renderer build sets and throws without it, without
 * changing a single answer here.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import { normaliseMathSource } from '@/lib/mathSource'

interface MdastNode {
  type: string
  value?: string
  lang?: string | null
  meta?: string | null
  children?: MdastNode[]
}

const CASES: ReadonlyArray<{ name: string; source: string; expect: number }> = [
  {
    name: 'A. $$ on its own lines (the reported case)',
    source: 'Before.\n\n$$\nx = 1 + 2\n$$\n\nAfter.',
    expect: 1
  },
  {
    // Mid-line `$$` is the model's own form choice; remark-math makes it inline
    // math, which still renders, so one node is the right answer.
    name: 'B. $$ hugging the content, one line',
    source: 'Before.\n\n$$x = 1 + 2$$\n\nAfter.',
    expect: 1
  },
  {
    name: 'C. multi-line align inside $$',
    source: '$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$',
    expect: 1
  },
  {
    name: 'D. multi-line, closing $$ indented',
    source: '$$\nx = 1\n  y = 2\n$$',
    expect: 1
  },
  {
    name: 'E. closing $$ has trailing spaces',
    source: '$$\nx = 1\n$$   ',
    expect: 1
  },
  {
    name: 'F. blank line inside the block',
    source: '$$\nx = 1\n\ny = 2\n$$',
    expect: 1
  },
  {
    name: 'G. bare align, no delimiters at all',
    source: 'Before.\n\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n\nAfter.',
    expect: 1
  },
  {
    name: 'H. \\[ \\] multi-line',
    source: 'Before.\n\n\\[\n\\begin{align}\na &= b\n\\end{align}\n\\]\n\nAfter.',
    expect: 1
  },
  {
    name: 'I. $$ then a LaTeX row break \\\\, then $$',
    source: '$$\na = 1 \\\\\nb = 2\n$$',
    expect: 1
  },
  {
    name: 'J. two blocks back to back',
    source: '$$\nx = 1\n$$\n\ntext between\n\n$$\ny = 2\n$$',
    expect: 2
  },
  {
    // One inline and one display: the inline `$v = 20$` must not be absorbed
    // into the block, and the block must not swallow the sentence.
    name: 'K. inline math next to a block',
    source: 'Given $v = 20$, then:\n\n$$\nd = v^2 / 2g\n$$',
    expect: 2
  },
  {
    name: 'L. \\( \\) inline',
    source: 'Before \\(x = 1\\) after.',
    expect: 1
  },
  {
    name: 'M. currency must not become math',
    source: 'It costs $5 and $10 per hour.',
    expect: 0
  },
  {
    name: 'N. Python in a fence keeps its dollars',
    source: 'Before.\n\n```python\ncost = "$5"\n```\n\nAfter.',
    expect: 0
  },
  {
    name: 'O. two bare environments in a row',
    source: '\\begin{align}\na &= b\n\\end{align}\n\n\\begin{align}\nc &= d\n\\end{align}',
    expect: 2
  }
]

function flatten(node: MdastNode, depth = 0): string[] {
  const here = `${'  '.repeat(depth)}${node.type}${
    node.type === 'math' || node.type === 'inlineMath'
      ? ` = ${JSON.stringify(node.value ?? '')}`
      : node.type === 'code'
        ? ` lang=${node.lang ?? ''} = ${JSON.stringify((node.value ?? '').slice(0, 40))}`
        : node.value !== undefined && node.value !== ''
          ? ` = ${JSON.stringify(node.value.slice(0, 40))}`
          : ''
  }`
  const out = [here]
  for (const child of node.children ?? []) out.push(...flatten(child, depth + 1))
  return out
}

/** Does any `$$` survive into the visible text of the rendered tree? */
function strayDollars(node: { type: string; value?: string; children?: unknown[] }): string[] {
  const found: string[] = []
  if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('$$')) {
    found.push(node.value)
  }
  for (const child of (node.children ?? []) as Array<{ type: string; value?: string }>) {
    found.push(...strayDollars(child))
  }
  return found
}

/** Math nodes that survived to hast: `[display, inline]`. */
function mathNodes(node: {
  type: string
  tagName?: string
  properties?: unknown
  children?: unknown[]
}): [number, number] {
  const cls = (node.properties as { className?: unknown } | undefined)?.className
  const classes = Array.isArray(cls) ? cls.map(String) : []
  // remark-math renders a display node as `pre > code.language-math.math-display`
  // and an inline one as `code.language-math.math-inline`.
  let display = node.tagName === 'code' && classes.includes('math-display') ? 1 : 0
  let inline = node.tagName === 'code' && classes.includes('math-inline') ? 1 : 0
  for (const child of (node.children ?? []) as Array<{ type: string; tagName?: string }>) {
    const [d, i] = mathNodes(child)
    display += d
    inline += i
  }
  return [display, inline]
}

let failures = 0
let assertions = 0

for (const testCase of CASES) {
  const normalised = normaliseMathSource(testCase.source)
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype)
  const mdast = processor.parse(normalised)
  const hast = processor.runSync(mdast)

  const [display, inline] = mathNodes(hast)
  const stray = strayDollars(hast)
  const total = display + inline
  const nodeTypes = (mdast as MdastNode).children.map((c) => c.type).join(',')

  assertions += 1
  const countOk = total === testCase.expect
  if (!countOk) failures += 1

  assertions += 1
  const cleanOk = stray.length === 0
  if (!cleanOk) failures += 1

  console.log(`\n${countOk && cleanOk ? 'ok  ' : 'FAIL'} ${testCase.name}`)
  if (!countOk || !cleanOk) {
    console.log(`       source     ${JSON.stringify(testCase.source)}`)
    console.log(`       normalised ${JSON.stringify(normalised)}`)
    console.log(`       mdast      ${nodeTypes}`)
  }
  check(`${testCase.name}: ${total} math node(s)`, countOk, total, testCase.expect)
  check(`${testCase.name}: no stray $$`, cleanOk, stray)
}

function check(label: string, ok: boolean, got: unknown, want?: unknown): void {
  if (ok) {
    console.log(`       ok   ${label}`)
  } else {
    console.log(`       FAIL ${label}  got ${JSON.stringify(got)}`)
    if (want !== undefined) console.log(`            want ${JSON.stringify(want)}`)
  }
}

console.log(`\n${assertions - failures}/${assertions} checks passed.`)
if (failures > 0) {
  console.error(`${failures} check(s) failed.`)
  process.exitCode = 1
}

