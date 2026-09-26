/**
 * The left sidebar (spec §13.5): sessions newest-first with pinned on top,
 * search by title, new chat, rename, pin, delete.
 *
 * Nothing here waits on a spinner. The list arrives from local SQLite in one
 * read at boot, and every mutation is applied in place afterwards.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { filterSessions, useSessionStore } from '@/store/sessionStore'
import { useTurnStore } from '@/store/turnStore'
import { useUiStore } from '@/store/uiStore'
import { Icon } from '@/components/Icon'
import { formatRelativeTime } from '@/lib/format'

/**
 * Pinned sessions first, then the rest. Split here rather than in the store so
 * the two lists are computed once and the section headings can be omitted when
 * a section is empty.
 */
function partitionSessions(sessions: Session[]): { pinned: Session[]; rest: Session[] } {
  const pinned: Session[] = []
  const rest: Session[] = []
  for (const session of sessions) {
    if (session.pinned) pinned.push(session)
    else rest.push(session)
  }
  return { pinned, rest }
}

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

  // Search is a mode, not a permanent field. The brand and the search box
  // occupy the same row, so opening search replaces the brand rather than
  // pushing the layout down.
  const [searching, setSearching] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)

  const visible = filterSessions(sessions, search)
  const { pinned, rest } = partitionSessions(visible)

  useEffect(() => {
    if (renamingId === null) return
    renameInput.current?.focus()
    renameInput.current?.select()
  }, [renamingId])

  // Focus the field as it appears, and select any existing query so typing
  // replaces it rather than appending.
  useEffect(() => {
    if (!searching) return
    searchInput.current?.focus()
    searchInput.current?.select()
  }, [searching])

  // Clear the query on close. Carrying a filter into the next visit to the
  // list is confusing: the student sees a short list and no reason why.
  const closeSearch = useCallback(() => {
    setSearching(false)
    setSearch('')
  }, [setSearch])

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
    }
  }

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

  /** One session row. Extracted because the pinned and history sections render
   *  the same control and duplicating ~60 lines of interactive markup twice is
   *  how the two sections drift apart. */
  const renderSession = (session: Session): React.JSX.Element => {
    const active = session.id === activeId
    const streaming = session.id === streamingSessionId
    const renaming = session.id === renamingId

    return (
      <div key={session.id} className="session" data-active={active} data-pinned={session.pinned}>
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
            <Icon name="pencil" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void togglePin(session.id)}
            title={session.pinned ? 'Unpin' : 'Pin'}
            aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${session.title}`}
            aria-pressed={session.pinned}
          >
            <Icon name={session.pinned ? 'pinFilled' : 'pin'} />
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
            <Icon name="close" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <nav className="sidebar" aria-label="Conversations">
      {/* Brand and search share one row. Search replaces the brand rather than
          stacking below it, so opening it costs no vertical space and the
          rail's height does not jump. */}
      <div className="sidebar__head">
        {searching ? (
          <div className="sidebar__search">
            <Icon name="search" className="sidebar__search-icon" />
            <input
              ref={searchInput}
              type="text"
              className="sidebar__search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={onSearchKeyDown}
              onBlur={closeSearch}
              placeholder="Search conversations"
              aria-label="Search conversations by title"
            />
            <button
              type="button"
              className="icon-button"
              onClick={closeSearch}
              title="Close search"
              aria-label="Close search"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : (
          <>
            <div className="sidebar__brand">
              <span className="sidebar__brand-mark" aria-hidden="true" />
              <span className="sidebar__brand-name">ISHKAPON</span>
              <span className="sidebar__brand-tld">.ai</span>
            </div>

            <button
              type="button"
              className="icon-button sidebar__search-toggle"
              onClick={() => setSearching(true)}
              title="Search conversations"
              aria-label="Search conversations"
              aria-expanded={searching}
            >
              <Icon name="search" />
            </button>
          </>
        )}
      </div>

      {/* New chat. A quiet text row rather than a filled button: it is the most
          predictable action in the app and does not need to shout. */}
      <button type="button" className="sidebar__action sidebar__new" onClick={onNewChat}>
        <Icon name="plus" />
        <span>New chat</span>
      </button>

      <div className="sidebar__rule" role="presentation" />

      {/* The list scrolls; the brand, new chat and settings do not. */}
      <div className="sidebar__scroll">
        {visible.length === 0 ? (
          <p className="sidebar__empty">
            {sessions.length === 0 ? 'No conversations yet.' : 'No conversation matches that search.'}
          </p>
        ) : null}

        {pinned.length > 0 ? (
          <section className="sidebar__section">
            <h2 className="sidebar__section-title">Pinned</h2>
            <div className="sidebar__list">{pinned.map(renderSession)}</div>
          </section>
        ) : null}

        {rest.length > 0 ? (
          <section className="sidebar__section">
            {pinned.length > 0 ? (
              <div className="sidebar__rule" role="presentation" />
            ) : null}
            <h2 className="sidebar__section-title">History</h2>
            <div className="sidebar__list">{rest.map(renderSession)}</div>
          </section>
        ) : null}
      </div>

      {/* Settings lives at the foot of the rail, where a desktop app is
          expected to find it, and stays visible rather than scrolling away. */}
      <button
        type="button"
        className="sidebar__action sidebar__settings"
        onClick={() => setView('settings')}
      >
        <Icon name="gear" />
        <span>Settings</span>
      </button>
    </nav>
  )
}
