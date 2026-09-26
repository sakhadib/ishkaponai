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
const { join } = require('node:path')

// Keep the dev build out of the installed app's data folder.
//
// Electron derives `userData` from `app.getPath('appData')` plus the app name,
// and the two builds do not agree on the name. A packaged build reads the `name`
// that electron-builder injects from `productName`, which is normalised to
// "ISHKAPON-AI"; a dev build reads "ishkapon-ai" straight out of this repo's
// package.json. Those differ only in case, so on NTFS and on APFS/HFS+ - the
// default on Windows and macOS - they are the *same directory*. On a
// case-sensitive filesystem they are two, which is why this never showed up
// anywhere but on the platforms students actually use.
//
// The shared directory meant a dev run and an installed run opened one
// ishkapon.db, one secrets row and one usage_daily table. The API key appeared
// to transfer and still worked, because Windows DPAPI is scoped to the user
// account rather than to the app, so either build could decrypt what the other
// wrote. The quieter consequences are worse than the obvious one: a schema
// migration in a dev build lands in the database the installed build reads, the
// token ledger counts development against a real student's total, and the two
// builds contend for one single-instance lock, so the second to launch quits.
//
// This has to happen here rather than in `out/main/index.js`, because the
// single-instance lock is requested below and resolves its lock file through
// `userData`. Setting the path after the lock would separate the databases and
// leave the two builds still unable to run at the same time.
//
// The released app keeps its existing folder, so installing an update - or
// moving from a dev machine to a student's - does not orphan anyone's chats.
// Only development moves.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'ishkapon-ai-dev'))
}

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
