/**
 * A `remark` plugin that normalises Bengali numerals inside math nodes.
 *
 * Why a plugin rather than a string pass over the Markdown source: at this
 * point the parser has already isolated `$…$` and `$$…$$` as `inlineMath` /
 * `math` nodes, so the transformation cannot touch surrounding prose by
 * construction. That is the requirement in spec §13.2, and doing it here makes
 * it structural instead of a heuristic.
 *
 * **The non-obvious part.** `mdast-util-math` does not just set `node.value`;
 * while parsing it also pre-builds the *hast* equivalent and parks it in
 * `node.data.hChildren` (a `<code class="math-inline">` / `<pre>` wrapper with
 * the raw source as a text child). `mdast-util-to-hast` prefers
 * `data.hChildren` over `node.value`, so rewriting `value` alone is silently
 * ignored and the renderer still receives `২`. Both copies therefore have to be
 * rewritten, or the maths reaches MathJax unnormalised.
 *
 * With `remark-math` installed, the node types come from `mdast-util-math`.
 * They are declared structurally below so this file does not depend on a
 * transitive type package.
 */
import { normalizeNumerals } from './numerals'
import type { Root } from 'hast'
import type { Plugin } from 'unified'
import type { Node, Parent } from 'unist'

/** `mdast` node shape for `inlineMath` and `math`, as produced by remark-math. */
interface MathNode extends Node {
  type: 'inlineMath' | 'math'
  value: string
  data?: { hName?: unknown; hChildren?: unknown; [key: string]: unknown }
}

function isMathNode(node: Node): node is MathNode {
  return node.type === 'inlineMath' || node.type === 'math'
}

function isParent(node: Node): node is Parent {
  return 'children' in node && Array.isArray((node as { children?: unknown }).children)
}

/**
 * Normalises every `text` node reachable from `value`'s companion hast tree.
 * This is what `mdast-util-to-hast` actually reads.
 */
function normaliseHastChildren(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) normaliseHastChildren(entry)
    return
  }
  if (value === null || typeof value !== 'object') return

  const node = value as { type?: unknown; value?: unknown; children?: unknown }

  if (node.type === 'text' && typeof node.value === 'string') {
    node.value = normalizeNumerals(node.value)
    return
  }
  if (Array.isArray(node.children)) normaliseHastChildren(node.children)
}

/**
 * Rewrites one math node: the mdast `value` *and* the pre-built hast children.
 */
function normaliseMathNode(node: MathNode): void {
  const normalised = normalizeNumerals(node.value)
  node.value = normalised

  // `data` is absent when a tree has been round-tripped through a serialiser
  // that drops it, in which case `value` is all there is and that is correct.
  const hChildren = node.data?.hChildren
  if (hChildren === undefined) return

  normaliseHastChildren(hChildren)
}

/**
 * `remarkBengaliNumeralsInMath`
 *
 * Recursively rewrites every math node. Idempotent: `normalizeNumerals`
 * short-circuits when no Bengali digit is present, so a second pass is a no-op.
 */
export const remarkBengaliNumeralsInMath: Plugin<[], Root> = () => {
  return (tree: Node): undefined => {
    visit(tree)
  }
}

function visit(node: Node): void {
  if (isMathNode(node)) {
    normaliseMathNode(node)
    // Math nodes have no mdast children, so there is nothing below to visit.
    return
  }
  if (isParent(node)) {
    for (const child of node.children) visit(child)
  }
}
