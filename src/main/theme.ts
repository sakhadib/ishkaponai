/**
 * ISHKAPON is light-only, by decision (D28).
 *
 * A student reads solutions here for minutes at a time, often in a bright
 * classroom, and often prints or screenshots the result afterwards. One fixed
 * light surface is easier to read in that situation, and it removes an entire
 * class of work: no second palette to keep accessible, no flash of the wrong
 * theme on first paint, and no ambiguity about what a screenshot shows.
 *
 * The page's own colours are pure CSS in `styles.css` — `:root` is the only
 * token block, and nothing in the renderer reads or writes a theme. What is
 * left here is the part CSS cannot reach: the *native* window.
 */
import { nativeTheme } from 'electron'

/**
 * Matches `--bg` in `styles.css`. Set as the window's own backdrop so the frame
 * drawn before the stylesheet lands is the same colour, rather than a white
 * flash on a light-grey page.
 */
export const WINDOW_BACKGROUND = '#f6f7fc'

/**
 * Pins Chromium's own chrome to light.
 *
 * Without this, a student whose OS is in dark mode gets a dark title bar and
 * dark window frame around a light app. `themeSource` is what makes Chromium
 * draw its own scrollbars, form controls and the caret light as well.
 *
 * Must be called before the first window exists, since it affects the frame the
 * OS draws for it. Idempotent.
 */
export function applyThemeMode(): void {
  nativeTheme.themeSource = 'light'
}
