/**
 * One-off: collapse the ad-hoc `font-size` values in the stylesheet onto the
 * type scale in `:root`.
 *
 * The stylesheet grew 58 different font sizes before the scale existed, which
 * is why spacing felt arbitrary. This remaps each to the nearest token so the
 * rhythm is consistent; values that have no sensible token are left alone and
 * reported, so nothing is silently flattened.
 *
 * Usage: node tools/normalize-type.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'src',
  'styles.css'
)

/** Nearest token per rem value. Anything not listed is left untouched. */
const MAP = new Map([
  ['0.68rem', 'var(--text-xs)'],   // the tiny mono chip
  ['0.7rem', 'var(--text-xs)'],
  ['0.72rem', 'var(--text-xs)'],
  ['0.74rem', 'var(--text-xs)'],
  ['0.75rem', 'var(--text-xs)'],
  ['0.76rem', 'var(--text-xs)'],
  ['0.78rem', 'var(--text-xs)'],
  ['0.8rem', 'var(--text-sm)'],
  ['0.82rem', 'var(--text-sm)'],
  ['0.84rem', 'var(--text-sm)'],
  ['0.85rem', 'var(--text-sm)'],
  ['0.86rem', 'var(--text-sm)'],
  ['0.87rem', 'var(--text-sm)'],
  ['0.9rem', 'var(--text-sm)'],
  ['0.92rem', 'var(--text-base)'],
  ['0.94rem', 'var(--text-base)'],
  ['0.95rem', 'var(--text-base)'],
  ['0.96rem', 'var(--text-base)'],
  ['1.02rem', 'var(--text-lg)'],
  ['1.05rem', 'var(--text-lg)'],
  ['1.1rem', 'var(--text-lg)'],
  ['1.15rem', 'var(--text-lg)'],
  ['1.3rem', 'var(--text-2xl)'],
  ['1.6rem', 'var(--text-3xl)'],
  ['15px', 'var(--text-base)']
])

const check = process.argv.includes('--check')
const src = readFileSync(CSS, 'utf8')

let changed = 0
const unmapped = new Map()

const out = src.replace(/font-size:\s*([\d.]+)(px|rem)\s*;/g, (match, value, unit) => {
  const key = `${value}${unit}`
  const token = MAP.get(key)
  if (token === undefined) {
    unmapped.set(key, (unmapped.get(key) ?? 0) + 1)
    return match
  }
  changed++
  return `font-size: ${token};`
})

console.log(`remapped ${changed} declaration(s) onto the type scale`)

if (unmapped.size > 0) {
  console.log('\nleft untouched (no sensible token):')
  for (const [k, n] of [...unmapped].sort()) console.log(`  ${k}  x${n}`)
}

const before = (src.match(/font-size:\s*[\d.]+(px|rem)/g) ?? []).length
const after = (out.match(/font-size:\s*[\d.]+(px|rem)/g) ?? []).length
console.log(`\nhardcoded sizes: ${before} -> ${after}`)

if (!check) {
  writeFileSync(CSS, out, 'utf8')
  console.log('\nwritten.')
} else {
  console.log('\n--check: nothing written.')
}
