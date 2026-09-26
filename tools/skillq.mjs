/**
 * Node port of the ui-ux-pro-max search CLI.
 *
 * The skill ships `scripts/search.py`, but this machine has only the Microsoft
 * Store `python.exe` stub, so the tool cannot run here. The data is the valuable
 * part, so this reads the same CSVs directly and does the same thing: keyword
 * match across all columns, rank by hit count, return the top N.
 *
 * Read-only. Writes nothing.
 *
 * The dataset is NOT vendored into this repo — it is a 680-file third-party
 * clone. Point at a local checkout with UI_UX_SKILL_ROOT, or fetch one with:
 *
 *   git clone --depth 1 \
 *     https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git vendor/ui-ux-pro-max
 *
 * Usage:
 *   node tools/skillq.mjs <file.csv> "<query>" [maxResults]
 *   node tools/skillq.mjs --cols <file.csv>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT =
  process.env.UI_UX_SKILL_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'ui-ux-pro-max')

const DATA = join(SKILL_ROOT, '.claude', 'skills', 'ui-ux-pro-max', 'data')

if (!existsSync(DATA)) {
  console.error(`Skill dataset not found at:\n  ${DATA}\n`)
  console.error(
    'Set UI_UX_SKILL_ROOT to a clone of ui-ux-pro-max-skill, or see the header comment.'
  )
  process.exit(2)
}

/** Minimal RFC4180 CSV parser: handles quoted fields, embedded commas and newlines. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

function load(file) {
  const rows = parseCsv(readFileSync(join(DATA, file), 'utf8'))
  const header = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => {
    const o = {}
    header.forEach((h, i) => {
      o[h] = (r[i] ?? '').trim()
    })
    return o
  })
}

const [file, query, maxArg] = process.argv.slice(2)

if (!file) {
  console.error('usage: node skillq.mjs <file.csv> "<query>" [max]')
  process.exit(1)
}

if (file === '--cols') {
  const rows = load(query)
  console.log('columns:', Object.keys(rows[0] ?? {}).join(' | '))
  console.log('rows:', rows.length)
  process.exit(0)
}

const records = load(file)
const terms = query
  .toLowerCase()
  .split(/[^a-z0-9+#.]+/)
  .filter((t) => t.length > 1)

// Score = how many distinct terms hit, weighted by where they hit. Title-ish
// columns count double so a direct name match outranks an incidental mention.
const TITLE_COLS = new Set(['Name', 'Style Category', 'Product Type', 'Issue', 'Font Pairing Name', 'Category'])

const scored = records
  .map((r) => {
    let score = 0
    const hits = []
    for (const [col, value] of Object.entries(r)) {
      const v = (value ?? '').toLowerCase()
      if (v === '') continue
      for (const term of terms) {
        if (!v.includes(term)) continue
        score += TITLE_COLS.has(col) ? 3 : 1
        hits.push(`${col}: ${term}`)
      }
    }
    return { r, score, hits }
  })
  .filter((x) => x.score > 0)
  .sort((a, b) => b.score - a.score)

const max = Number(maxArg ?? 6)
console.log(`# ${file} â€” "${query}" â€” ${scored.length} match(es), top ${max}\n`)

for (const { r, score, hits } of scored.slice(0, max)) {
  const label =
    r['Style Category'] ?? r['Product Type'] ?? r['Font Pairing Name'] ?? r['Issue'] ?? r['Category'] ?? r['Icon Name'] ?? '(row)'
  console.log(`â”€â”€ ${label}  [score ${score}]`)
  // Print the most decision-relevant fields, skipping the long boilerplate ones.
  for (const [k, v] of Object.entries(r)) {
    if (!v || v === '-') continue
    if (k === 'No') continue
    if (['Implementation Checklist', 'CSS Import', 'Tailwind Config', 'Code Example Good', 'Code Example Bad', 'Google Fonts URL'].includes(k)) continue
    if (v.length > 260) continue
    console.log(`   ${k}: ${v}`)
  }
  console.log('')
}

