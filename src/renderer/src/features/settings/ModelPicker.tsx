/**
 * Model choice (spec §9.3).
 *
 * Free-tier models are listed first, because the target user may have no
 * credits and a pay-only list reads as "this app costs money". Context length
 * and per-million pricing are shown for the same reason: the student pays per
 * token, and an 8k model cannot host an agentic turn at all (§10.1).
 */
import type { ModelInfo } from '@shared/types'
import { formatPricePerMillion, formatTokens } from '@/lib/format'

/** `:free` variants and the `openrouter/free` router. */
export function isFreeTier(model: ModelInfo): boolean {
  return /:free$/i.test(model.id) || model.id.startsWith('openrouter/free')
}

export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    if (isFreeTier(a) !== isFreeTier(b)) return isFreeTier(a) ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** Below this, an agentic turn cannot fit (§10.1's 4096-token floor). */
export const SMALL_CONTEXT_FLOOR = 4096

export interface ModelPickerProps {
  models: ModelInfo[]
  selectedId: string | null
  loading: boolean
  notice: string | null
  onSelect: (id: string) => void
  onRefresh: () => void
  /** A slug typed by hand that is not in the catalog. */
  customId: string
  onCustomChange: (value: string) => void
  onCustomCommit: () => void
}

export function ModelPicker({
  models,
  selectedId,
  loading,
  notice,
  onSelect,
  onRefresh,
  customId,
  onCustomChange,
  onCustomCommit
}: ModelPickerProps): React.JSX.Element {
  const ordered = sortModels(models)
  const free = ordered.filter(isFreeTier)
  const paid = ordered.filter((model) => !isFreeTier(model))

  if (loading && models.length === 0) {
    return <p className="settings__loading">Loading the model list…</p>
  }

  if (models.length === 0) {
    return (
      <div className="settings__models-empty">
        <p>{notice ?? 'The model list is unavailable.'}</p>
        <div className="custom-model">
          <label className="field__label" htmlFor="custom-model">
            Enter a model ID manually
          </label>
          <div className="custom-model__row">
            <input
              id="custom-model"
              className="field__input"
              value={customId}
              onChange={(event) => onCustomChange(event.target.value)}
              placeholder="e.g. qwen/qwen3-235b-a22b:free"
            />
            <button
              type="button"
              className="btn"
              disabled={customId.trim() === ''}
              onClick={onCustomCommit}
            >
              Use
            </button>
          </div>
          <p className="field__hint">
            A model without tool support cannot run the calculation steps, so ISHKAPON will not
            work with it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="settings__models">
      {notice === null ? null : <p className="settings__notice">{notice}</p>}

      {free.length > 0 ? (
        <ModelGroup
          title="Free — no credits needed"
          models={free}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}

      {paid.length > 0 ? (
        <ModelGroup
          title="Paid — charged per token"
          models={paid}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}

      <details className="custom-model">
        <summary className="custom-model__summary">Enter a model ID manually</summary>
        <div className="custom-model__row">
          <input
            className="field__input"
            value={customId}
            onChange={(event) => onCustomChange(event.target.value)}
            placeholder="e.g. qwen/qwen3-235b-a22b:free"
            aria-label="Custom model ID"
          />
          <button
            type="button"
            className="btn"
            disabled={customId.trim() === ''}
            onClick={onCustomCommit}
          >
            Use
          </button>
        </div>
        <p className="field__hint">
          A model without tool support cannot run the calculation steps, so ISHKAPON will not work
          with it.
        </p>
      </details>

      <button type="button" className="btn btn--ghost" onClick={onRefresh}>
        Refresh the model list
      </button>
    </div>
  )
}

function ModelGroup({
  title,
  models,
  selectedId,
  onSelect
}: {
  title: string
  models: ModelInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <fieldset className="model-group">
      <legend className="model-group__legend">{title}</legend>
      {models.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          selected={model.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </fieldset>
  )
}

function ModelRow({
  model,
  selected,
  onSelect
}: {
  model: ModelInfo
  selected: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const small = model.contextLength > 0 && model.contextLength < SMALL_CONTEXT_FLOOR
  const price =
    model.pricingPrompt === 0 && model.pricingCompletion === 0
      ? 'free'
      : `${formatPricePerMillion(model.pricingPrompt)} in · ${formatPricePerMillion(model.pricingCompletion)} out`

  return (
    <label className="model-row" data-selected={selected} data-small={small}>
      <input
        type="radio"
        name="model"
        className="model-row__radio"
        checked={selected}
        onChange={() => onSelect(model.id)}
      />
      <span className="model-row__body">
        <span className="model-row__name">{model.name}</span>
        <span className="model-row__id">{model.id}</span>
        <span className="model-row__stats">
          <span title="Context window">{formatTokens(model.contextLength)} context</span>
          <span title="USD per million tokens">{price}</span>
          {model.supportsTools ? null : <span className="model-row__warn">no tool support</span>}
          {small ? (
            <span className="model-row__warn" title="Too small for a tool-calling turn">
              too small for agentic use
            </span>
          ) : null}
        </span>
      </span>
    </label>
  )
}
