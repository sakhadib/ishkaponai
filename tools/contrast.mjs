/**
 * WCAG contrast checker for the ISHKAPON palette.
 *
 * Run this before changing a colour. Guessing at contrast is how a "readable"
 * theme ends up shipping 3.1:1 body text.
 *
 * Usage: node tools/contrast.mjs
 */

const hex = (h) => {
  const s = h.replace('#', '')
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

const lin = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

const luminance = (h) => {
  const [r, g, b] = hex(h)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const ratio = (a, b) => {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const LIGHT = {
  bg: '#F6F7FC',
  elevated: '#FFFFFF',
  sunken: '#EAEDF6',
  subtle: '#F0F2F9',
  text: '#14182A',
  muted: '#4A5266',
  faint: '#5F6880',
  accent: '#4F46E5',
  accentHover: '#4338CA',
  onAccent: '#FFFFFF',
  danger: '#B3261E',
  onDanger: '#FFFFFF',
  success: '#10663A',
  warn: '#7A4A00',
  info: '#1B4F6B'
}

/** [label, foreground, background, minimum, note] */
const CHECKS = (t) => [
  ['body text on page', t.text, t.bg, 4.5, 'long-form reading'],
  ['body text on card', t.text, t.elevated, 4.5, ''],
  ['body text on sunken', t.text, t.sunken, 4.5, ''],
  ['muted text on page', t.muted, t.bg, 4.5, 'secondary prose'],
  ['muted text on card', t.muted, t.elevated, 4.5, ''],
  ['faint text on page', t.faint, t.bg, 4.5, 'timestamps, previews'],
  ['faint text on card', t.faint, t.elevated, 4.5, ''],
  ['faint text on sunken', t.faint, t.sunken, 4.5, ''],
  ['accent on page (link)', t.accent, t.bg, 4.5, 'inline links'],
  ['accent on card (link)', t.accent, t.elevated, 4.5, ''],
  ['on-accent on accent', t.onAccent, t.accent, 4.5, 'primary button'],
  ['on-accent on accent hover', t.onAccent, t.accentHover, 4.5, 'primary button hover'],
  ['danger on page', t.danger, t.bg, 4.5, 'error text'],
  ['success on page', t.success, t.bg, 4.5, 'success text'],
  ['warn on page', t.warn, t.bg, 4.5, 'warning text'],
  ['info on page', t.info, t.bg, 4.5, 'info text']
]

let failures = 0
// One palette, because there is one theme (D28). The light tokens below are a
// transcription of the `:root` block in `styles.css` — if you change a colour
// there, change it here, or this tool is checking a palette nobody ships.
for (const [name, tokens] of [['LIGHT', LIGHT]]) {
  console.log(`\n=== ${name} ===`)
  for (const [label, fg, bg, min, note] of CHECKS(tokens)) {
    const r = ratio(fg, bg)
    const ok = r >= min
    if (!ok) failures++
    const mark = ok ? 'ok  ' : 'FAIL'
    console.log(
      `  ${mark} ${r.toFixed(2).padStart(5)}:1  (min ${min})  ${label.padEnd(26)} ${fg} on ${bg}${note ? '  # ' + note : ''}`
    )
  }
}

console.log(`\n${failures === 0 ? 'All pairs pass.' : failures + ' pair(s) FAIL.'}`)
process.exit(failures === 0 ? 0 : 1)
