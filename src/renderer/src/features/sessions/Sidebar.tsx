/**
 * The left sidebar (spec §13.5): sessions newest-first with pinned on top,
 * search by title, new chat, rename, pin, delete.
 *
 * Nothing here waits on a spinner. The list arrives from local SQLite in one
 * read at boot, and every mutation is applied in place afterwards.
 */
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { filterSessions, useSessionStore } from '@/store/sessionStore'
import { useTurnStore } from '@/store/turnStore'
import { useUiStore } from '@/store/uiStore'
import { formatRelativeTime } from '@/lib/format'

export function Sidebar(): React.JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const activeId = useSessionStore((state) => state.activeId)
  const selectSession = useSessionStore((state) => state.selectSession)
  const newSession = useSessionStore((state) => state.newSession)
  const renameSession = useSessionStore((state) => state.renameSession)
  const togglePin = useSessionStore((state) => state.togglePin)
  const deleteSession = useSessionStore((state) => state.deleteSession)

  const search = useUiStore((state) => state.search)
  const setSearch = useUiStore((state) => state.setSearch)
  const setView = useUiStore((state) => state.setView)
  const askConfirm = useUiStore((state) => state.askConfirm)

  const streamingSessionId = useTurnStore((state) => (state.streaming ? state.sessionId : null))

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInput = useRef<HTMLInputElement>(null)

  const visible = filterSessions(sessions, search)

  useEffect(() => {
    if (renamingId === null) return
    renameInput.current?.focus()
    renameInput.current?.select()
  }, [renamingId])

  const startRename = (session: Session): void => {
    setRenamingId(session.id)
    setRenameValue(session.title)
  }

  const commitRename = (): void => {
    if (renamingId === null) return
    const id = renamingId
    setRenamingId(null)
    void renameSession(id, renameValue)
  }

  const onNewChat = (): void => {
    void newSession()
    setView('chat')
  }

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar__top">
        <button type="button" className="btn btn--primary sidebar__new" onClick={onNewChat}>
          New chat
        </button>
        <button
          type="button"
          className="btn btn--ghost sidebar__settings"
          onClick={() => setView('settings')}
          title="Settings"
        >
          Settings
        </button>
      </div>

      <div className="sidebar__search">
        <input
          type="search"
          className="field__input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations by title"
        />
      </div>

      <div className="sidebar__list">
        {visible.length === 0 ? (
          <p className="sidebar__empty">
            {sessions.length === 0 ? 'No conversations yet.' : 'No conversation matches that search.'}
          </p>
        ) : null}

        {visible.map((session) => {
          const active = session.id === activeId
          const streaming = session.id === streamingSessionId
          const renaming = session.id === renamingId

          return (
            <div
              key={session.id}
              className="session"
              data-active={active}
              data-pinned={session.pinned}
            >
              {renaming ? (
                <input
                  ref={renameInput}
                  className="session__rename"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setRenamingId(null)
                    }
                  }}
                  aria-label="Conversation title"
                />
              ) : (
                <button
                  type="button"
                  className="session__main"
                  onClick={() => {
                    void selectSession(session.id)
                    setView('chat')
                  }}
                  title={session.title}
                >
                  <span className="session__title">{session.title}</span>
                  <span className="session__meta">
                    {session.pinned ? <span className="session__pin-mark">pinned</span> : null}
                    {streaming ? <span className="session__live">working…</span> : null}
                    <span className="session__time">{formatRelativeTime(session.updatedAt)}</span>
                  </span>
                </button>
              )}

              <div className="session__actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => startRename(session)}
                  title="Rename"
                  aria-label={`Rename ${session.title}`}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void togglePin(session.id)}
                  title={session.pinned ? 'Unpin' : 'Pin'}
                  aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${session.title}`}
                  aria-pressed={session.pinned}
                >
                  {session.pinned ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--danger"
                  onClick={() =>
                    askConfirm({
                      title: 'Delete this conversation?',
                      body: `“${session.title}” and every message and calculation in it will be permanently removed.`,
                      confirmLabel: 'Delete',
                      onConfirm: () => void deleteSession(session.id)
                    })
                  }
                  title="Delete"
                  aria-label={`Delete ${session.title}`}
                >
                  ×
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </nav>
  )
}
