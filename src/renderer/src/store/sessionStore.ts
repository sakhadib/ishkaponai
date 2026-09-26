/**
 * Sessions and their transcripts.
 *
 * Everything here is local SQLite reads, so all of it is synchronous-feeling:
 * the list is loaded once at boot and updated in place afterwards. There are no
 * loading spinners for session data by design (spec §13.5) — a spinner would
 * only ever be visible for a few milliseconds and would flicker.
 */
import { create } from 'zustand'
import type { Message, Session, SessionDetail, ToolCall } from '@shared/types'
import { call, callQuiet } from '@/lib/bridge'

export interface SessionState {
  sessions: Session[]
  /** Title of the new session the student is composing, before the first send. */
  draftTitle: string | null
  activeId: string | null
  detail: SessionDetail | null
  /** True while a transcript is being read from disk for `activeId`. */
  loadingDetail: boolean
  error: string | null

  loadSessions: () => Promise<void>
  /**
   * Replace a session's title in place, from a `title.suggested` event.
   */
  applyGeneratedTitle: (id: string, title: string) => void
  selectSession: (id: string | null) => Promise<void>
  newSession: () => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** Re-reads the active transcript, e.g. after a turn finishes persisting. */
  refreshDetail: () => Promise<void>
  /** Drops a finished assistant message from SQLite once it has streamed in. */
  applyCompletedTurn: (messages: Message[], toolCalls: ToolCall[]) => void
  setError: (message: string | null) => void
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Pinned first, then newest first. Spec §13.5. */
export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

function replaceSession(sessions: Session[], next: Session): Session[] {
  const index = sessions.findIndex((session) => session.id === next.id)
  if (index === -1) return sortSessions([...sessions, next])
  const copy = [...sessions]
  copy[index] = next
  return sortSessions(copy)
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  draftTitle: null,
  activeId: null,
  detail: null,
  loadingDetail: false,
  error: null,

  loadSessions: async () => {
    const sessions = await callQuiet<Session[]>(
      'Loading the session list',
      (api) => api.listSessions(),
      [],
      (error) => set({ error: describeError(error) })
    )
    set({ sessions: sortSessions(sessions) })
  },

  /**
   * Applies a model-generated title to the in-memory list.
   *
   * The title arrives over the event stream a moment after the first message, so
   * the sidebar updates in place rather than re-reading the whole list. Left
   * deliberately unawaited: the write already happened in main, and a failure
   * here would be cosmetic.
   */
  applyGeneratedTitle: (id, title) => {
    const trimmed = title.trim()
    if (trimmed === '') return

    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id ? { ...session, title: trimmed } : session
        )
      )
    }))

    // Keep the open conversation's header in step with the sidebar.
    const detail = get().detail
    if (detail !== null && detail.session.id === id) {
      set({ detail: { ...detail, session: { ...detail.session, title: trimmed } } })
    }
  },

  selectSession: async (id) => {
    if (id === null) {
      set({ activeId: null, detail: null, draftTitle: null, loadingDetail: false })
      return
    }

    set({ activeId: id, draftTitle: null, loadingDetail: true, error: null })

    try {
      const detail = await call('Loading the conversation', (api) => api.getSession(id))
      // A slow read for a session the student already navigated away from must
      // not overwrite the transcript now on screen.
      if (get().activeId !== id) return
      if (!detail) {
        set({ detail: null, loadingDetail: false })
        // The session vanished underneath us (deleted in another window).
        await get().loadSessions()
        return
      }
      set({ detail, loadingDetail: false })
    } catch (error) {
      if (get().activeId !== id) return
      set({ detail: null, loadingDetail: false, error: describeError(error) })
    }
  },

  newSession: async () => {
    // The student may start typing before the session row exists. Creating it
    // eagerly on the first send is enough, so the empty state costs no write.
    set({ activeId: null, detail: null, draftTitle: null, loadingDetail: false, error: null })
  },

  renameSession: async (id, title) => {
    const trimmed = title.trim()
    if (trimmed === '') return
    try {
      const next = await call('Renaming the conversation', (api) =>
        api.updateSession(id, { title: trimmed })
      )
      set((state) => ({
        sessions: replaceSession(state.sessions, next),
        detail:
          state.detail && state.detail.session.id === id
            ? { ...state.detail, session: next }
            : state.detail
      }))
    } catch (error) {
      set({ error: describeError(error) })
    }
  },

  togglePin: async (id) => {
    const current = get().sessions.find((session) => session.id === id)
    if (!current) return
    try {
      const next = await call('Updating the conversation', (api) =>
        api.updateSession(id, { pinned: !current.pinned })
      )
      set((state) => ({ sessions: replaceSession(state.sessions, next) }))
    } catch (error) {
      set({ error: describeError(error) })
    }
  },

  deleteSession: async (id) => {
    try {
      await call('Deleting the conversation', (api) => api.deleteSession(id))
    } catch (error) {
      set({ error: describeError(error) })
      return
    }

    const remaining = get().sessions.filter((session) => session.id !== id)
    set({ sessions: sortSessions(remaining) })

    if (get().activeId === id) {
      // Move to the most recent remaining conversation, or the empty state.
      const next = remaining[0]
      if (next) await get().selectSession(next.id)
      else set({ activeId: null, detail: null, draftTitle: null, loadingDetail: false })
    }
  },

  refreshDetail: async () => {
    const id = get().activeId
    if (!id) return
    try {
      const detail = await call('Refreshing the conversation', (api) => api.getSession(id))
      if (get().activeId !== id) return
      if (detail) set({ detail })
    } catch (error) {
      // Non-fatal: the streamed view is already on screen.
      set({ error: describeError(error) })
    }
  },

  applyCompletedTurn: (messages, toolCalls) => {
    const detail = get().detail
    if (!detail) return
    set({
      detail: {
        ...detail,
        messages: mergeById(detail.messages, messages),
        toolCalls: mergeById(detail.toolCalls, toolCalls)
      }
    })
  },

  setError: (message) => set({ error: message })
}))

function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return existing
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()]
}

/** Case- and whitespace-insensitive title search. Spec §13.5. */
export function filterSessions(sessions: Session[], query: string): Session[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sessions
  return sessions.filter((session) => session.title.toLowerCase().includes(needle))
}
