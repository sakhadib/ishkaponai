import { useState } from 'react'

export default function TitleControl(): React.JSX.Element {
  const [value, setValue] = useState('ISHKAPON AI')
  const [maximized, setMaximized] = useState(false)

  const applyTitle = (): void => {
    void window.ishkapon.setWindowTitle(value)
  }

  const toggle = async (): Promise<void> => {
    setMaximized(await window.ishkapon.toggleMaximize())
  }

  return (
    <article className="card">
      <div className="card__head">
        <h2 className="card__title">Window</h2>
      </div>

      <label className="field">
        <span className="field__label">Native window title</span>
        <input
          className="field__input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyTitle()
          }}
          placeholder="Set title…"
        />
      </label>

      <div className="card__actions">
        <button className="btn" type="button" onClick={applyTitle}>
          Apply
        </button>
        <button className="btn btn--ghost" type="button" onClick={() => void toggle()}>
          {maximized ? 'Restore' : 'Maximize'}
        </button>
      </div>
    </article>
  )
}
