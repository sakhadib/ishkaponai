/**
 * Small shared primitives. Plain elements with class names — the styling
 * lives in `styles.css` as tokens, so there is no component library and no
 * design system to keep in sync.
 */
import { useEffect, useRef } from 'react'
import { useUiStore } from '@/store/uiStore'
import type { NoticeTone } from '@/store/uiStore'

/** A dismissible banner. `tone` picks the token set. */
export function Notice({
  tone,
  message,
  onDismiss,
  action
}: {
  tone: NoticeTone
  message: string
  onDismiss?: () => void
  action?: { label: string; onClick: () => void }
}): React.JSX.Element {
  return (
    <div className="notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice__text">{message}</span>
      {action ? (
        <button type="button" className="notice__action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          className="notice__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

/** The floating stack of transient notices. */
export function NoticeStack(): React.JSX.Element | null {
  const notices = useUiStore((state) => state.notices)
  const dismiss = useUiStore((state) => state.dismiss)

  if (notices.length === 0) return null

  return (
    <div className="notice-stack">
      {notices.map((notice) => (
        <Notice key={notice.id} tone={notice.tone} message={notice.message} onDismiss={() => dismiss(notice.id)} />
      ))}
    </div>
  )
}

/**
 * A modal confirmation. `askConfirm` in the UI store supplies the request;
 * this only renders it.
 */
export function ConfirmDialog(): React.JSX.Element | null {
  const confirm = useUiStore((state) => state.confirm)
  const close = useUiStore((state) => state.closeConfirm)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (confirm === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    root.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, close])

  if (confirm === null) return null

  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={confirm.title}
        tabIndex={-1}
        ref={root}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title">{confirm.title}</h2>
        <p className="modal__body">{confirm.body}</p>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              confirm.onConfirm()
              close()
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A labelled form row. */
export function Field({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  )
}

/** A one-row value/label pair, used for read-only inspectors. */
export function ReadOnlyRow({
  label,
  value
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="stats__row">
      <span className="stats__label">{label}</span>
      <span className="stats__value">{value}</span>
    </div>
  )
}
