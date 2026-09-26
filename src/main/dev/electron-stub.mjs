/**
 * Minimal stand-in for the `electron` module, used only when bundling
 * `dev/core-check.ts` for a plain-Node run.
 *
 * `src/main/agent-host.ts` imports `utilityProcess` at module scope, so the
 * module cannot be loaded outside Electron even to test its pure inbound-message
 * validator. esbuild's `--alias:electron=./src/main/dev/electron-stub.mjs`
 * redirects that one import at bundle time. Nothing in the stub is ever
 * invoked: the checks that run under it only call pure functions.
 *
 * This file is `.mjs` on purpose — `tsconfig.node.json` includes only `.ts` files
 * under `src/main`, so a stub with no types to maintain stays out of the
 * typecheck.
 */
export const utilityProcess = {
  fork() {
    throw new Error('utilityProcess is not available outside Electron.')
  }
}

export const safeStorage = {
  getSelectedStorageBackend() {
    return 'gnome_libsecret'
  },
  async isAsyncEncryptionAvailable() {
    return true
  },
  async encryptStringAsync() {
    return Buffer.alloc(0)
  },
  async decryptStringAsync() {
    return { result: '', shouldReEncrypt: false }
  }
}

export const nativeTheme = { shouldUseDarkColors: true, themeSource: 'system' }
export const app = { getName: () => 'ISHKAPON AI', getVersion: () => '0.0.0', getLocale: () => 'en-US' }
export const ipcMain = { handle() {} }
export const BrowserWindow = class {}
export const Menu = { setApplicationMenu() {}, buildFromTemplate: (t) => t }
export const shell = { openExternal() {} }
export const session = { defaultSession: { webRequest: { onHeadersReceived() {} } } }
