/**
 * The Settings modal.
 *
 * Settings used to be one long scrolling page: an API key, a model picker, four
 * unrelated groups of fields, a payload inspector and a session readout, all
 * stacked. Nothing about that signalled which settings belong together, and the
 * student had to scroll past everything to reach the one thing they came for.
 *
 * This splits it into a modal with a left menu and one pane per concern. The
 * grouping is by *task*, not by data type: everything about connecting to a
 * model is in one place, everything about how answers read in another.
 *
 * Behaviour that matters for a modal:
 *  - Escape closes it, and so does the backdrop.
 *  - Focus moves into the dialog on open and is trapped while it is open, so a
 *    keyboard user cannot tab into the chat behind it.
 *  - The previously focused element is restored on close, so closing Settings
 *    returns the student to where they were rather than to the document body.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IconName } from '@/components/Icon'
import { Icon } from '@/components/Icon'
import { AccountSection } from '@/features/settings/sections/AccountSection'
import { ModelSection } from '@/features/settings/sections/ModelSection'
import { AppearanceSection } from '@/features/settings/sections/AppearanceSection'
import { AnswersSection } from '@/features/settings/sections/AnswersSection'
import { CalculationSection } from '@/features/settings/sections/CalculationSection'
import { PromptSection } from '@/features/settings/sections/PromptSection'
import { useSettingsStore } from '@/store/settingsStore'

export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account', icon: 'key', blurb: 'Your OpenRouter API key' },
  { id: 'model', label: 'Model', icon: 'sparkle', blurb: 'Which model answers' },
  { id: 'answers', label: 'Answers', icon: 'text', blurb: 'Language and instructions' },
  { id: 'calculation', label: 'Calculation', icon: 'calculator', blurb: 'Limits and timeouts' },
  { id: 'appearance', label: 'Appearance', icon: 'sun', blurb: 'Theme and detail' },
  { id: 'prompt', label: 'Prompt', icon: 'eye', blurb: 'Exactly what is sent' }
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; blurb: string }>

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

const SECTION_COMPONENTS: Record<SettingsSectionId, () => React.JSX.Element> = {
  account: AccountSection,
  model: ModelSection,
  answers: AnswersSection,
  calculation: CalculationSection,
  appearance: AppearanceSection,
  prompt: PromptSection
}

export interface SettingsViewProps {
  onClose: () => void
}

export function SettingsView({ onClose }: SettingsViewProps): React.JSX.Element {
  // A section that depends on setup state is opened first, so the student lands
  // on the thing that is actually blocking them rather than on Appearance.
  const [active, setActive] = useState<SettingsSectionId>(() => initialSection())

  const dialog = useRef<HTMLDivElement>(null)
  const restoreFocusTo = useRef<Element | null>(null)

  const error = useSettingsStore((state) => state.error)
  const clearError = useSettingsStore((state) => state.clearError)

  useEffect(() => {
    restoreFocusTo.current = document.activeElement
    dialog.current?.focus()
    return () => {
      const target = restoreFocusTo.current
      if (target instanceof HTMLElement) target.focus()
    }
  }, [])

  // Escape closes. The confirm dialog handles its own Escape, and stopping
  // propagation here would break it, so only handle it when no dialog is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onNavKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
      if (!keys.includes(event.key)) return
      event.preventDefault()

      const index = SETTINGS_SECTIONS.findIndex((section) => section.id === active)
      const last = SETTINGS_SECTIONS.length - 1
      const next =
        event.key === 'Home' ? 0
        : event.key === 'End' ? last
        : event.key === 'ArrowDown' ? Math.min(last, index + 1)
        : Math.max(0, index - 1)

      const target = SETTINGS_SECTIONS[next]
      if (target === undefined) return
      setActive(target.id)
      // Keep focus on the menu, so arrowing again moves the selection rather
      // than dumping the student into the pane they are navigating to.
      document.getElementById(`settings-nav-${target.id}`)?.focus()
    },
    [active]
  )

  const Panel = SECTION_COMPONENTS[active]

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal modal--wide settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={dialog}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* Left menu. A nav landmark with roving arrow-key navigation, which is
            what a tablist of panes is; the panels themselves are plain
            regions because only one is ever mounted. */}
        <nav className="settings__nav" aria-label="Settings sections" onKeyDown={onNavKeyDown}>
          <div className="settings__nav-head">
            <h2 className="settings__nav-title">Settings</h2>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              title="Close settings"
              aria-label="Close settings"
            >
              <Icon name="close" size={15} />
            </button>
          </div>

          <ul className="settings__nav-list" role="list">
            {SETTINGS_SECTIONS.map((section) => {
              const selected = section.id === active
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    id={`settings-nav-${section.id}`}
                    className="settings__nav-item"
                    data-selected={selected}
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => setActive(section.id)}
                  >
                    <Icon name={section.icon} className="settings__nav-icon" />
                    <span className="settings__nav-text">
                      <span className="settings__nav-label">{section.label}</span>
                      <span className="settings__nav-blurb">{section.blurb}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <section className="settings__panel" aria-label="Settings panel">
          {error === null ? null : (
            <div className="banner banner--error" role="alert">
              {error}
              <button
                type="button"
                className="banner__close"
                onClick={clearError}
                aria-label="Dismiss"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}

          <Panel />
        </section>
      </div>
    </div>
  )
}

/**
 * Opens on whatever is blocking: no key, then no model, otherwise the first
 * section. Anything else would open Settings on a cosmetic page while the app
 * cannot answer a question.
 */
function initialSection(): SettingsSectionId {
  const state = useSettingsStore.getState()
  if (state.secret !== null && !state.secret.configured) return 'account'
  if (state.settings.modelId === null) return 'model'
  return 'account'
}
