/// <reference types="vite/client" />

import type { IshkaponApi } from '@shared/types'

declare global {
  interface Window {
    /** Injected by the preload script via `contextBridge`. */
    readonly ishkapon: IshkaponApi
  }
}

export {}
