/**
 * Types shared by the main process, the preload bridge and the renderer.
 * This module must stay free of Node and DOM imports so it can be bundled
 * into every process target.
 */

/** Subset of `NodeJS.Platform` that the renderer is allowed to depend on. */
export type Platform = 'win32' | 'darwin' | 'linux' | 'freebsd' | 'openbsd' | 'win'

export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersion: string
  readonly platform: Platform
  readonly arch: string
  readonly locale: string
}

export interface PingResult {
  /** Echo of the value sent by the renderer, used to verify the round trip. */
  readonly echo: string
  /** ISO-8601 timestamp captured in the main process. */
  readonly at: string
  readonly uptimeSeconds: number
}

/**
 * The API surface exposed on `window.ishkapon` by the preload script.
 * Everything here is callable from the renderer; nothing else is reachable.
 */
export interface IshkaponApi {
  /** Synchronously available platform detection, safe to read during render. */
  readonly platform: Platform
  readonly isMac: boolean
  readonly isWindows: boolean
  readonly isLinux: boolean

  getAppInfo(): Promise<AppInfo>
  ping(message?: string): Promise<PingResult>
  setWindowTitle(title: string): Promise<void>
  isMaximized(): Promise<boolean>
  toggleMaximize(): Promise<boolean>
  closeWindow(): Promise<void>
}
