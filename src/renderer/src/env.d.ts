/// <reference types="vite/client" />

// `IshkaponApi` lives in `@shared/ipc`, not `@shared/types`. Pointing at the
// wrong module silently degraded `window.ishkapon` to `any`, because
// `skipLibCheck` suppresses the unresolved-export error inside a `.d.ts`.
import type { IshkaponApi } from '@shared/ipc'

declare global {
  interface Window {
    /** Injected by the preload script via `contextBridge`. */
    readonly ishkapon: IshkaponApi
  }
}

export {}
