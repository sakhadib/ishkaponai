/**
 * Model choice (spec §9.3).
 *
 * Two options, and only two, because that is the decision a student can actually
 * make:
 *
 *   1. **Free model** — OpenRouter's free router. Needs no credits, always
 *      available, never goes stale.
 *   2. **Any model** — the student pastes an id from openrouter.ai. They get the
 *      whole catalog, and they get the responsibility of knowing what they picked.
 *
 * An earlier version listed every tool-capable model in two scrolling sections.
 * It was worse in both directions: a student who wanted the free option had to
 * scroll past a hundred paid ones, and a student who wanted a specific model had
 * to go hunting for it in a list of a hundred and thirty. Naming the id directly
 * is faster for the second case and no slower for the first.
 *
 * ## Choosing "Any model" is not yet choosing a model
 *
 * The radio and the setting are deliberately separate. Picking "Any model"
 * reveals the id field and nothing else; the stored model stays the free router
 * until a real id is entered and accepted.
 *
 * That separation is not a nicety. The two were originally the same state, and
 * the consequence was a radio that could not be clicked: revealing the field
 * required committing a model id, and there is no id to commit on the way in, so
 * `onChange` had nothing to do and React put the radio straight back. The
 * control looked broken and no error said why. Which mode the student is *looking
 * at* is view state; which model *answers* is a setting, and only the second one
 * is worth persisting.
 *
 * The page also never blocks a paste it does not recognise. The catalog is a
 * cache of a list that changes hourly, and OpenRouter accepts ids the cache has
 * not seen. An unknown id is flagged, specifically, and still saved — and if it
 * really is wrong, the chat says so in plain words rather than failing quietly
 * (see `explainTurnError`).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { formatPricePerMillion, formatTokens } from '@/lib/format'
import { useDraftField } from '@/lib/useDraftField'

/** The free router. Fixed, free, and the default. */
export const FREE_MODEL_ID = 'openrouter/free'

/**
 * The shape check, mirroring `modelId` validation in the main process.
 *
 * `~` is OpenRouter's marker for a floating `-latest` alias
 * (`~anthropic/claude-sonnet-latest`, `~deepseek/deepseek-v4-flash-latest`).
 * It is part of the id, and dropping it produces "… is not a valid model ID" from
 * OpenRouter — a message that reads like a server fault and is in fact a typo the
 * student cannot see.
 */
const MODEL_ID_PATTERN = /^~?[\w.-]+\/[\w.:-]+$/

export function isValidModelId(id: string): boolean {
  return MODEL_ID_PATTERN.test(id.trim())
}

/** Below this, an agentic turn cannot fit (§10.1's 4096-token floor). */
export const SMALL_CONTEXT_FLOOR = 4096

export type ModelMode = 'free' | 'any'

/** The mode implied by a stored id. Anything that is not the router is "any". */
export function modeFor(modelId: string | null): ModelMode {
  return modelId === null || modelId === FREE_MODEL_ID ? 'free' : 'any'
}

export interface ModelPickerProps {
  models: readonly ModelInfo[]
  selectedId: string | null
  loading: boolean
  /** Set when the catalog on show is not the real one. See `ModelCatalogResult`. */
  notice: string | null
  onSelect: (id: string) => void
  onRefresh: () => void
}

export function ModelPicker({
  models,
  selectedId,
  loading,
  notice,
  onSelect,
  onRefresh
}: ModelPickerProps): React.JSX.Element {
  const current = selectedId ?? FREE_MODEL_ID

  // Which card is showing, as opposed to which model is stored. Seeded from the
  // stored id so a page opened on a custom model starts in the right place.
  const [mode, setMode] = useState<ModelMode>(() => modeFor(selectedId))

  // Re-sync when the setting changes underneath us — a commit from this field, or
  // a different session's settings arriving. Without this the card would keep
  // showing "Any model" after the student switched back to free elsewhere.
  const derived = modeFor(selectedId)
  useEffect(() => {
    setMode(derived)
  }, [derived])

  return (
    <div className="settings__models">
      {notice !== null ? <p className="settings__notice">{notice}</p> : null}

      <fieldset className="model-choice">
        <legend className="model-choice__legend">Which model answers your questions?</legend>

        <label className="model-choice__option">
          <input
            type="radio"
            name="model-mode"
            checked={mode === 'free'}
            onChange={() => {
              setMode('free')
              if (current !== FREE_MODEL_ID) onSelect(FREE_MODEL_ID)
            }}
          />
          <span className="model-choice__body">
            <span className="model-choice__name">Free model</span>
            <span className="model-choice__detail">
              OpenRouter&apos;s free router. No credits needed, and it never goes out of date.
            </span>
            <code className="model-choice__id">{FREE_MODEL_ID}</code>
          </span>
        </label>

        <label className="model-choice__option">
          <input
            type="radio"
            name="model-mode"
            checked={mode === 'any'}
            // Reveals the field and stops there. Committing a model here is what
            // made this radio unclickable — there is no id to commit on the way
            // in, so the change was discarded and the radio snapped back.
            onChange={() => setMode('any')}
          />
          <span className="model-choice__body">
            <span className="model-choice__name">Any model</span>
            <span className="model-choice__detail">
              Use any model on OpenRouter. You are billed per token, so a paid model costs money
              to ask.
            </span>
          </span>
        </label>
      </fieldset>

      {mode === 'any' ? (
        <ModelIdField
          models={models}
          // `useDraftField` is seeded with the stored id, so a page opened on a
          // custom model shows that id rather than an empty box. The free router
          // is not an id worth showing here: it belongs to the other card.
          selectedId={current === FREE_MODEL_ID ? '' : current}
          onSelect={onSelect}
        />
      ) : null}

      <div className="settings__catalog-foot">
        <p className="settings__count">
          {loading
            ? 'Checking OpenRouter’s model list…'
            : models.length > 0
              ? `OpenRouter lists ${models.length} model${models.length === 1 ? '' : 's'} that can call tools.`
              : 'OpenRouter’s model list has not been loaded.'}
        </p>
        <button
          type="button"
          className="btn btn--ghost settings__refresh"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The id field
// ---------------------------------------------------------------------------

/**
 * The typed-id field, with a live check against the cached catalog.
 *
 * The check is advisory and never blocks a save. It exists to catch the one
 * mistake that is otherwise invisible: a tilde dropped off the front of a
 * `-latest` alias, which OpenRouter rejects with a message that reads like a
 * server fault.
 */
function ModelIdField({
  models,
  selectedId,
  onSelect
}: {
  models: readonly ModelInfo[]
  selectedId: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)

  const field = useDraftField(selectedId, (raw) => {
    const id = raw.trim()
    if (id === '' || id === selectedId) return
    if (!isValidModelId(id)) {
      setProblem(
        'That is not shaped like a model ID. Copy it from the model’s page on ' +
          'openrouter.ai — it reads vendor/model-name, and the floating aliases start with a ~.'
      )
      return
    }
    setProblem(null)
    onSelect(id)
  })

  const typed = field.value.trim()
  const known = useMemo(
    () => models.find((model) => model.id === typed) ?? null,
    [models, typed]
  )

  return (
    <div className="field model-id">
      <label className="field__label" htmlFor="model-id-input">
        Model ID
      </label>

      <input
        id="model-id-input"
        className="field__input model-id__input"
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        onKeyDown={field.onKeyDown}
        placeholder="~deepseek/deepseek-v4-flash-latest"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />

      {problem !== null ? <p className="model-id__problem">{problem}</p> : null}

      {problem === null && typed === '' ? (
        <p className="field__hint">
          Open the model&apos;s page on <code>openrouter.ai/models</code> and copy the ID from it.
          Include the leading <code>~</code> if it has one — dropping it is the most common way to
          get this wrong.
        </p>
      ) : null}

      {problem === null && typed !== '' && known !== null ? (
        <p className="field__hint model-id__known">
          <strong>{known.name}</strong> · {formatTokens(known.contextLength)} context ·{' '}
          {formatPricePerMillion(known.pricingPrompt)} in ·{' '}
          {formatPricePerMillion(known.pricingCompletion)} out
          {known.contextLength > 0 && known.contextLength < SMALL_CONTEXT_FLOOR ? (
            <span className="model-id__warn">
              {' '}
              — too small a context window for a tool-calling turn.
            </span>
          ) : null}
        </p>
      ) : null}

      {problem === null && typed !== '' && known === null ? (
        <p className="field__hint model-id__unknown">
          {models.length > 0
            ? `Not among OpenRouter’s ${models.length} tool-calling models. If the ID is right it ` +
              'will still work — the list is a cache — but if it is a typo, the next question will ' +
              'say so.'
            : 'Could not check this against OpenRouter, so it is untested. The next question will ' +
              'say so if it is wrong.'}
        </p>
      ) : null}
    </div>
  )
}

