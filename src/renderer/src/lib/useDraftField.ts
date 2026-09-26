/**
 * A text field that edits locally and commits on blur.
 *
 * ## Why this exists
 *
 * A controlled input whose value comes straight from the store cannot be used
 * for a field that main normalises. The round trip is per keystroke, so any
 * normalisation lands before the next character is typed:
 *
 *   type "Nusrat"  → stored "Nusrat"
 *   type " "       → main trims it → store says "Nusrat" → the input loses the
 *                    space before the next keypress
 *
 * The result is a field where it is impossible to enter a second word, which is
 * exactly what happened to the Personalise name. Age had the same shape and the
 * same latent problem: blurring "1" stored the clamped 5, so re-focusing and
 * typing produced "56" when the student meant 16.
 *
 * The fix is to keep the two moments apart. While the field has focus it owns
 * its own text and the store is not consulted; on blur it hands the value to
 * `commit`, and only then does normalisation run. Nothing is lost — a trailing
 * space is dropped on commit, which is what the student wanted anyway.
 *
 * A second thing falls out of this for free: one IPC round trip and one SQLite
 * write per visit to the field, instead of one per character.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

export interface DraftField {
  /** What to render. Local while editing, the stored value otherwise. */
  value: string
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
  /** Enter commits and blurs, rather than inserting a newline in a one-line field. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export function useDraftField(stored: string, commit: (raw: string) => void): DraftField {
  const [draft, setDraft] = useState(stored)
  const draftRef = useRef(stored)
  const editing = useRef(false)

  // `setDraft` through this, so the ref that `onBlur` reads is always the value
  // on screen. Assigning the ref during render instead would be a side effect in
  // render, which React does not guarantee runs only once.
  const apply = useCallback((value: string) => {
    draftRef.current = value
    setDraft(value)
  }, [])

  useEffect(() => {
    // The store is the source of truth only while the field is idle. A write that
    // lands mid-edit — this field's own commit, or anything else — must not
    // overwrite what the student is in the middle of typing.
    if (editing.current) return
    apply(stored)
  }, [stored, apply])

  const onChange = useCallback((value: string) => apply(value), [apply])

  const onFocus = useCallback(() => {
    editing.current = true
  }, [])

  const onBlur = useCallback(() => {
    editing.current = false
    // Skipped when the text is unchanged, so tabbing through a field without
    // touching it costs no round trip.
    if (draftRef.current === stored) return
    commit(draftRef.current)
  }, [commit, stored])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Blur rather than committing directly, so the one commit path stays the
    // only path and the field cannot be committed twice for one edit.
    event.currentTarget.blur()
  }, [])

  return { value: draft, onChange, onFocus, onBlur, onKeyDown }
}
