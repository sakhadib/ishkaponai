/**
 * Theme resolution.
 *
 * `system` is not just a CSS concern: §13.4 requires it to drive
 * `nativeTheme.themeSource` so the native title bar matches the app. That has to
 * happen in the main process, which is also why the resolved value is passed to
 * the window as `--ishkapon-theme=` and applied by the preload before first
 * paint — an inline `<script>` would be blocked by the CSP.
 */
import { nativeTheme, type BrowserWindow } from 'electron'
import type { ThemeMode } from '@shared/types'

export type ResolvedTheme = 'light' | 'dark'

/** Matches the renderer's own background token, per theme. */
const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#0b0d17',
  light: '#f6f7fb'
}

/**
 * Applies the user's theme mode to the native chrome and returns the concrete
 * theme. `system` resolves through `shouldUseDarkColors`, which reflects the OS
 * live — `nativeTheme.themeSource` is what makes that tracking happen at all.
 */
export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  nativeTheme.themeSource = mode
  return resolveTheme()
}

export function resolveTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * Keeps the window's own backdrop in step with the theme so a resize or a
 * transparent gap never flashes the wrong colour. Only meaningful in `system`
 * mode, where the OS can change under the app.
 */
export function syncWindowBackground(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  window.setBackgroundColor(WINDOW_BACKGROUND[resolveTheme()])
}

export function windowBackgroundFor(theme: ResolvedTheme): string {
  return WINDOW_BACKGROUND[theme]
}
