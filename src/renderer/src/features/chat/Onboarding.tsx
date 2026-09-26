/**
 * The empty state (spec §4.1).
 *
 * Its one job is to explain what the app does and, when the app cannot chat
 * yet, to make the missing step unmissable. Free-tier models are named
 * explicitly, because the target user often has no credits.
 */
import { useSettingsStore } from '@/store/settingsStore'
import { useUiStore } from '@/store/uiStore'

export interface OnboardingProps {
  /** True when a conversation is already open, so this is a hint, not a pitch. */
  compact: boolean
}

export function Onboarding({ compact }: OnboardingProps): React.JSX.Element {
  const secret = useSettingsStore((state) => state.secret)
  const settings = useSettingsStore((state) => state.settings)
  const setView = useUiStore((state) => state.setView)

  const keyMissing = secret !== null && !secret.configured
  const modelMissing = settings.modelId === null

  const blocking = keyMissing || modelMissing

  return (
    <div className="onboarding">
      {!compact ? (
        <>
          <h1 className="onboarding__title">ISHKAPON</h1>
          <p className="onboarding__lead">
            A step-by-step problem solver for physics, chemistry, and mathematics. Write the
            problem in Bangla or English — the mathematics always stays in Latin script.
          </p>

          <ul className="onboarding__points">
            <li>
              <strong>The model never calculates from memory.</strong> Every number in an answer
              comes from code that ran in front of you, and you can read it.
            </li>
            <li>
              <strong>You see the working.</strong> Each Python step appears as a card with its
              code, its output, and the value it returned.
            </li>
            <li>
              <strong>Nothing is hidden.</strong> ISHKAPON cannot read your files, browse the web,
              or run system commands. If an answer needs something you did not give it, it will say
              so instead of guessing.
            </li>
          </ul>
        </>
      ) : null}

      {keyMissing ? (
        <div className="onboarding__cta">
          <h2 className="onboarding__cta-title">An API key is needed first</h2>
          <p className="onboarding__cta-body">
            ISHKAPON talks to OpenRouter using your own key. The key is stored encrypted by the
            operating system and is never shown to the app again after you save it.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => setView('settings')}>
            Open Settings
          </button>
        </div>
      ) : null}

      {modelMissing && !keyMissing ? (
        <div className="onboarding__cta">
          <h2 className="onboarding__cta-title">Choose a model</h2>
          <p className="onboarding__cta-body">
            Any model that can call tools will work. Free models are listed first, so you can try
            ISHKAPON without any credits.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => setView('settings')}>
            Choose a model
          </button>
        </div>
      ) : null}

      {blocking ? null : (
        <p className="onboarding__ready">
          {compact ? 'Ask a problem and the working will appear here, step by step.' : 'Ready. Ask a problem below.'}
        </p>
      )}
    </div>
  )
}
