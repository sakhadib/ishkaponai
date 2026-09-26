/**
 * View routing and transient UI state (toasts, the search box, the confirm
 * dialog). Kept apart from domain stores so a re-render caused by a toast
 * cannot pull session data with it.
 */
import { create } from 'zustand'

export type View = 'chat' | 'settings'

export type NoticeTone = 'info' | 'warn' | 'error' | 'success'

export interface Notice {
  id: number
  tone: NoticeTone
  message: string
}

export interface PendingConfirm {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

export interface UiState {
  view: View
  search: string
  notices: Notice[]
  confirm: PendingConfirm | null
  /** True while the OS is in dark mode; drives the resolved-theme display. */
  systemPrefersDark: boolean

  setView: (view: View) => void
  setSearch: (search: string) => void
  setSystemPrefersDark: (dark: boolean) => void
  notify: (tone: NoticeTone, message: string, ttlMs?: number) => void
  dismiss: (id: number) => void
  askConfirm: (request: PendingConfirm) => void
  closeConfirm: () => void
}

let nextNoticeId = 1

export const useUiStore = create<UiState>((set, get) => ({
  view: 'chat',
  search: '',
  notices: [],
  confirm: null,
  systemPrefersDark:
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,

  setView: (view) => set({ view }),
  setSearch: (search) => set({ search }),
  setSystemPrefersDark: (systemPrefersDark) => set({ systemPrefersDark }),

  notify: (tone, message, ttlMs = tone === 'error' ? 12_000 : 5000) => {
    const id = nextNoticeId
    nextNoticeId += 1
    set({ notices: [...get().notices, { id, tone, message }] })
    setTimeout(() => {
      set({ notices: get().notices.filter((notice) => notice.id !== id) })
    }, ttlMs)
  },

  dismiss: (id) => set({ notices: get().notices.filter((notice) => notice.id !== id) }),

  askConfirm: (request) => set({ confirm: request }),
  closeConfirm: () => set({ confirm: null })
}))

/** Convenience for the common "it broke, tell the student" case. */
export function reportError(error: unknown, operation: string): void {
  const message = error instanceof Error ? error.message : String(error)
  useUiStore.getState().notify('error', `${operation}: ${message}`)
}
