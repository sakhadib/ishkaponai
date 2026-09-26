/**
 * CJS bootstrap for the Electron main process.
 *
 * ESM modules load asynchronously, so only this file's side effects are
 * guaranteed to run before the `ready` event. Two APIs must happen before
 * `ready` and therefore cannot live in the ESM entry:
 *
 *   - `app.requestSingleInstanceLock()` — must be requested synchronously.
 *   - `app.setAppUserModelId()` — must be set before the app is ready on
 *     Windows, or notifications and taskbar grouping misbehave.
 *
 * Everything else lives in `out/main/index.js`, loaded dynamically below.
 *
 * This file MUST stay CommonJS. Do not convert it to ESM.
 */

const { app } = require('electron')

// Windows taskbar identity and notification attribution.
app.setAppUserModelId('com.ishkapon.ai')

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // A primary instance already exists; this one is redundant.
  app.quit()
} else {
  import('./main/index.js').catch((error) => {
    console.error('[bootstrap] failed to load ESM main process:', error)
    app.quit()
  })
}
