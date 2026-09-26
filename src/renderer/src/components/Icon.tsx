/**
 * Wireframe icons.
 *
 * Stroke-only, no fills, no colour: the icon inherits `currentColor` and is
 * drawn as an outline so it reads as a diagram rather than as a sticker. The
 * UI skill's guidance is explicit that emoji are not icons, and these replace
 * the `✎ ★ ☆ ×` characters the sidebar used to render as text.
 *
 * Drawn inline rather than pulled from an icon package: the set is small, and
 * inline SVG means no dependency, no extra bundle chunk, and full control over
 * the stroke geometry. Every path is drawn on a 24×24 grid with a 1.75 stroke so
 * the weights match at the sizes used here.
 */
import type { JSX } from 'react'

export const ICON_NAMES = [
  'plus',
  'gear',
  'pencil',
  'pin',
  'pinFilled',
  'close',
  'trash',
  'search',
  'check',
  'stop',
  'copy',
  'alert',
  // Settings navigation.
  'key',
  'sparkle',
  'user',
  'text',
  'calculator',
  'eye'
] as const

export type IconName = (typeof ICON_NAMES)[number]

/**
 * `pinFilled` keeps its fill because a pinned item needs to read as *set*
 * without relying on colour alone — an outline-only pin cannot show state.
 * It is the single exception, and it is still the same wireframe silhouette.
 */
const PATHS: Record<IconName, JSX.Element> = {
  // A plus, centred, arms equal length.
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),

  // Gear: outer teeth ring, inner hub. Drawn as a circle plus radial ticks
  // rather than a full cog path, which stays legible at 16px.
  gear: (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 2.5v2.25M12 19.25v2.25M2.5 12h2.25M19.25 12h2.25" />
      <path d="M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
    </>
  ),

  // Pencil at 45°, with the tip separated by a short line.
  pencil: (
    <>
      <path d="M4 20l1-4L16.5 4.5a2.12 2.12 0 013 3L8 19l-4 1z" />
      <line x1="14.5" y1="6.5" x2="17.5" y2="9.5" />
    </>
  ),

  // Pin: a lozenge head with a tapering spike.
  pin: (
    <>
      <path d="M9 3h6l-.75 5.25 3.25 3.25H6.5l3.25-3.25L9 3z" />
      <line x1="12" y1="11.5" x2="12" y2="21" />
    </>
  ),

  pinFilled: (
    <>
      <path d="M9 3h6l-.75 5.25 3.25 3.25H6.5l3.25-3.25L9 3z" fill="currentColor" />
      <line x1="12" y1="11.5" x2="12" y2="21" />
    </>
  ),

  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),

  // Trash: lid, body, two ribs.
  trash: (
    <>
      <polyline points="4 7 20 7" />
      <path d="M9.5 7V4.75h5V7" />
      <path d="M6.5 7l.85 12.25A1.5 1.5 0 008.84 20.5h6.32a1.5 1.5 0 001.49-1.25L17.5 7" />
      <line x1="10.5" y1="11" x2="10.5" y2="17" />
      <line x1="13.5" y1="11" x2="13.5" y2="17" />
    </>
  ),

  // Magnifier: circle plus a handle at 45 degrees.
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.25" />
      <line x1="15.25" y1="15.25" x2="20.5" y2="20.5" />
    </>
  ),

  check: <polyline points="4.5 12.5 9.5 17.5 19.5 6.5" />,

  // Stop: a filled square. Reads as "halt" unambiguously, and is the one
  // control where a shape beats an outline.
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" />,

  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 6.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h.5" />
    </>
  ),

  // Alert: triangle with a bang.
  alert: (
    <>
      <path d="M12 3.5L21.5 20H2.5L12 3.5z" />
      <line x1="12" y1="10" x2="12" y2="14.5" />
      <circle cx="12" cy="17.25" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),

  // Key: a ring with a ward, for the account section.
  key: (
    <>
      <circle cx="8" cy="8" r="4.25" />
      <line x1="11" y1="11" x2="20" y2="20" />
      <line x1="17" y1="17" x2="19.5" y2="14.5" />
      <line x1="14.5" y1="19.5" x2="17" y2="17" />
    </>
  ),

  // Sparkle: a four-point star with two smaller ones, for model selection.
  // Matches the app mark, which is also a four-point star.
  sparkle: (
    <>
      <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3z" />
      <path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </>
  ),

  // User: head and shoulders, for Personalise.
  user: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.75 20.5a7.25 7.25 0 0114.5 0" />
    </>
  ),

  // Text: two lines with a shorter one, for the answers section.
  text: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="13" y2="17" />
    </>
  ),

  // Calculator: a body with a display strip and a key grid.
  calculator: (
    <>
      <rect x="5" y="2.75" width="14" height="18.5" rx="2" />
      <line x1="8" y1="6.75" x2="16" y2="6.75" />
      <path d="M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h.01M12 18h.01M15.5 18h.01" />
    </>
  ),

  // Eye: the standard "inspect" mark, for viewing the exact payload.
  eye: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  )
}

export interface IconProps {
  name: IconName
  /** Rendered size in pixels. Defaults to 16, the size used in the sidebar. */
  size?: number
  /**
   * Accessible name. When omitted the icon is treated as decorative and gets
   * `aria-hidden`, which is correct for an icon sitting beside a text label —
   * announcing it separately would make a screen reader say "pin, Pin chat".
   */
  label?: string
  className?: string
}

export function Icon({ name, size = 16, label, className }: IconProps): React.JSX.Element {
  const decorative = label === undefined

  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
