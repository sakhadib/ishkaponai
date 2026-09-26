/**
 * A settings panel.
 *
 * Each section is a mounted-once pane rather than a route: there are six of
 * them, they are all in memory, and a router would add a URL and a history
 * entry for something the student opens, changes, and closes.
 */
export function SettingsPanel({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings__pane">
      <header className="settings__pane-head">
        <h3 className="settings__pane-title">{title}</h3>
        {description === undefined ? null : (
          <p className="settings__pane-desc">{description}</p>
        )}
      </header>
      <div className="settings__pane-body">{children}</div>
    </div>
  )
}
