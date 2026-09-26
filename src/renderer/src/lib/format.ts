/**
 * Small formatting helpers shared across views. Pure, so they are trivially
 * predictable and never throw on the values the app actually holds.
 */

/** `null`-safe number formatting with a fixed maximum of `digits` decimals. */
export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  })
}

/** Compact token counts: `1.2K`, `34.5K`, `1.1M`. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/**
 * USD per million tokens, which is how OpenRouter quotes pricing. Renders
 * `free` for zero so a free-tier model is unmistakable.
 */
export function formatPricePerMillion(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value === 0) return 'free'
  if (value < 0.01) return `$${value.toFixed(4)}/M`
  return `$${value.toFixed(3)}/M`
}

/** Total turn cost, which is usually a fraction of a cent. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(5)}`
  return `$${value.toFixed(4)}`
}

/** Relative time for the sidebar; absolute once it is no longer useful. */
export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const delta = now - epochMs
  if (!Number.isFinite(delta)) return ''
  if (delta < 0) return 'just now'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(epochMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function formatDateTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return '—'
  return new Date(epochMs).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Tool-call duration; sub-millisecond is shown as such rather than as `0ms`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** `60000` -> `60`, `90000` -> `1.5`, for the timeout field. */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
}

export function parseMilliseconds(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const seconds = Number(trimmed)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.round(seconds * 1000)
}

/**
 * Truncates a string for a preview, collapsing whitespace so multi-line tool
 * output or a multi-paragraph message cannot break a one-line layout.
 */
export function preview(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1)}…`
}

/** True for strings that contain a Bangla codepoint. */
export function containsBangla(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    if (code >= 0x0980 && code <= 0x09ff) return true
    // Bengali Extended-A / Assamese extensions used for some Bangla letters.
    if (code >= 0x1cd0 && code <= 0x1cff) return true
  }
  return false
}
