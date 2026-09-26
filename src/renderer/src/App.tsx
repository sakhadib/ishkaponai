import { useCallback, useEffect, useState } from 'react'
import SystemInfoCard from './components/SystemInfoCard'
import PingPanel from './components/PingPanel'
import TitleControl from './components/TitleControl'
import type { AppInfo } from '@shared/types'

export default function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await window.ishkapon.getAppInfo())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])

  // Keep the native window title in sync so the OS taskbar reflects app state.
  useEffect(() => {
    if (info) void window.ishkapon.setWindowTitle(`ISHKAPON AI — ${info.version}`)
  }, [info])

  return (
    <main className="app">
      <header className="app__header">
        <div className="app__mark" aria-hidden="true" />
        <div>
          <h1 className="app__title">ISHKAPON AI</h1>
          <p className="app__subtitle">Cross-platform Electron workspace</p>
        </div>
      </header>

      {error && (
        <p className="app__error" role="alert">
          Failed to reach the main process: {error}
        </p>
      )}

      <section className="app__grid">
        <SystemInfoCard info={info} onRefresh={loadInfo} />
        <PingPanel />
        <TitleControl />
      </section>

      <footer className="app__footer">
        <span>
          Renderer runs sandboxed with <code>contextIsolation</code> enabled — Node access is
          reachable only through the typed preload bridge.
        </span>
      </footer>
    </main>
  )
}
