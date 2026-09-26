/**
 * The application shell.
 *
 * Responsibilities kept here on purpose: one-time boot (settings, secret
 * status, session list), the single `onAgentEvent` subscription for the whole
 * app, and routing between the two views.
 *
 * The theme itself is *not* set from React. Preload applies the resolved theme
 * to `<html data-theme>` before first paint, and main re-asserts it when the
 * setting changes; the renderer only reads it back for display.
 */
import { useEffect, useRef } from 'react'
import { Sidebar } from '@/features/sessions/Sidebar'
import { ChatView } from '@/features/chat/ChatView'
import { Onboarding } from '@/features/chat/Onboarding'
import { SettingsView } from '@/features/settings/SettingsView'
import { ConfirmDialog, NoticeStack } from '@/components/ui'
import { useSessionStore } from '@/store/sessionStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useTurnStore } from '@/store/turnStore'
import { useUiStore } from '@/store/uiStore'

export default function App(): React.JSX.Element {
  const view = useUiStore((state) => state.view)
  const notify = useUiStore((state) => state.notify)
  const setView = useUiStore((state) => state.setView)

  const loadSettings = useSettingsStore((state) => state.load)
  const loadSecret = useSettingsStore((state) => state.loadSecret)
  const settingsLoaded = useSettingsStore((state) => state.loaded)
  const secretLoaded = useSettingsStore((state) => state.secret)
  const modelId = useSettingsStore((state) => state.settings.modelId)

  const loadSessions = useSessionStore((state) => state.loadSessions)
  const sessions = useSessionStore((state) => state.sessions)
  const activeId = useSessionStore((state) => state.activeId)
  const selectSession = useSessionStore((state) => state.selectSession)

  const attach = useTurnStore((state) => state.attach)

  // --- Boot -----------------------------------------------------------------
  useEffect(() => {
    const detach = attach()
    return detach
  }, [attach])

  useEffect(() => {
    void loadSettings()
    void loadSecret()
    void loadSessions()
  }, [loadSecret, loadSessions, loadSettings])

  // Open the most recent conversation so the app never looks empty on relaunch.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    if (settingsLoaded && secretLoaded !== null && sessions.length > 0) {
      restored.current = true
      void selectSession(sessions[0]?.id ?? null)
    }
  }, [secretLoaded, sessions, selectSession, settingsLoaded])

  // --- First-run guidance ---------------------------------------------------
  const guided = useRef(false)
  useEffect(() => {
    if (guided.current) return
    if (!settingsLoaded || secretLoaded === null) return
    guided.current = true
    if (!secretLoaded.configured) {
      setView('settings')
      notify('info', 'Add an OpenRouter API key to start. ISHKAPON cannot answer without one.', 9000)
    } else if (modelId === null) {
      notify('info', 'Choose a model in Settings. Free models are listed first.', 9000)
    }
  }, [modelId, notify, secretLoaded, setView, settingsLoaded])

  // Escape is handled by whichever dialog is open — Settings if it is, the
  // confirm dialog if it is. It used to be handled here as well, which meant two
  // listeners racing to close the same thing.

  const showSidebar = true

  return (
    <div className="app">
      {showSidebar ? <Sidebar /> : null}

      {/* Settings is a modal over the chat rather than a replacement for it, so
          closing it returns the student to the conversation they were in
          instead of an empty pane. The chat stays mounted underneath, which also
          means an in-flight turn keeps streaming while Settings is open. */}
      <main className="app__main">
        <ChatView
          emptyState={
            <Onboarding compact={activeId !== null || sessions.length > 0} />
          }
        />
      </main>

      {view === 'settings' ? <SettingsView onClose={() => setView('chat')} /> : null}

      <NoticeStack />
      <ConfirmDialog />
    </div>
  )
}
