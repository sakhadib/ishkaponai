/**
 * The only place in the main process that talks to OpenRouter, and it does so
 * for exactly two reasons: validating a key the student pasted, and listing the
 * model catalog. No chat traffic goes through here — all model traffic
 * originates in the agent host (§5, §12.2).
 *
 * Plain `fetch` is used rather than the AI SDK provider: both operations are
 * single REST calls, and pulling `ai` / `@openrouter/ai-sdk-provider` into the
 * main bundle for them would add weight and an error surface for nothing.
 *
 * The API key is passed in as an argument and is never stored, logged, or
 * interpolated into an error message. Every error surfaced from this module is
 * written for the student to read.
 */
import type { ModelCatalogResult, ModelInfo } from '@shared/types'
import type { SetApiKeyResult } from '@shared/ipc'

/**
 * `GET /key` is authenticated, costs nothing, and returns the key's own record.
 * That makes it a cheap proof that a key is both syntactically accepted and
 * live — a `/models` request would succeed for anonymous callers too.
 */
const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key'

const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'

/** Network calls get a deadline; a hanging request must not wedge the UI. */
const REQUEST_TIMEOUT_MS = 15_000

/** Model catalogs change slowly; an hour keeps the selector fresh enough. */
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses OpenRouter's decimal-string prices into USD per million tokens. */
function readPricePerMillion(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1e6 : null
  if (typeof value !== 'string' || value.trim().length === 0) return null

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed * 1e6 : null
}

/**
 * Tool support is what makes a model usable at all (§7.5: the model is never
 * told about a capability that is not enforced), so models that do not
 * advertise it are filtered out entirely.
 *
 * OpenRouter exposes this two ways depending on model vintage, so both are
 * accepted: the `supported_parameters` array containing `tools`, and the
 * `architecture.tool_use` flag.
 */
function readSupportsTools(model: Record<string, unknown>): boolean {
  const parameters = model['supported_parameters']
  if (Array.isArray(parameters) && parameters.includes('tools')) return true

  const architecture = model['architecture']
  if (isRecord(architecture) && architecture['tool_use'] === true) return true

  return false
}

function toModelInfo(model: Record<string, unknown>): ModelInfo | null {
  const id = model['id']
  if (typeof id !== 'string' || id.length === 0) return null

  const pricing = isRecord(model['pricing']) ? model['pricing'] : {}

  return {
    id,
    name: typeof model['name'] === 'string' && model['name'].length > 0 ? model['name'] : id,
    contextLength:
      typeof model['context_length'] === 'number' && model['context_length'] > 0
        ? model['context_length']
        : 0,
    pricingPrompt: readPricePerMillion(pricing['prompt']),
    pricingCompletion: readPricePerMillion(pricing['completion']),
    supportsTools: readSupportsTools(model)
  }
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()

    let body: unknown = null
    try {
      body = text.length > 0 ? JSON.parse(text) : null
    } catch {
      // A non-JSON body is treated as "no useful payload" by the caller.
    }

    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

interface HttpResult {
  status: number
  body: unknown
}

function asHttpResult(value: unknown): HttpResult | null {
  if (!isRecord(value)) return null
  return { status: typeof value['status'] === 'number' ? value['status'] : 0, body: value['body'] }
}

/**
 * Free-tier detection for §9.3: `:free` suffixed slugs and the free model
 * router. The target user may have no credits, so these sort first.
 */
export function isFreeTierModel(id: string): boolean {
  return id.endsWith(':free') || id === 'openrouter/free'
}

/** Surfaces free-tier models first, then alphabetical for a stable list. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const freeA = isFreeTierModel(a.id)
    const freeB = isFreeTierModel(b.id)
    if (freeA !== freeB) return freeA ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

async function fetchModels(): Promise<ModelInfo[]> {
  const result = asHttpResult(
    await fetchJson(MODELS_ENDPOINT, { method: 'GET', headers: { accept: 'application/json' } })
  )

  if (!result || result.status !== 200) {
    throw new Error(`OpenRouter returned HTTP ${result?.status ?? 0} for the model list.`)
  }

  const data = isRecord(result.body) ? result.body['data'] : null
  if (!Array.isArray(data)) throw new Error('The model list response was not in the expected shape.')

  const models: ModelInfo[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const info = toModelInfo(entry)
    if (info && info.supportsTools) models.push(info)
  }

  if (models.length === 0) {
    // Better a known-good short list than an empty selector: a network blip or
    // an API shape change must never brick the app (§9.3).
    throw new Error('OpenRouter advertised no tool-capable models.')
  }

  return sortModels(models)
}

/**
 * Minimal offline catalog. Deliberately tiny: this is a last resort for the
 * first-run, no-network case, not a substitute for the real list. Every entry
 * is tool-capable, because a non-tool model cannot be an agent (§7.5).
 */
export const FALLBACK_MODELS: readonly ModelInfo[] = Object.freeze([
  {
    id: 'openrouter/free',
    name: 'OpenRouter Free Model Router',
    contextLength: 65_536,
    pricingPrompt: 0,
    pricingCompletion: 0,
    supportsTools: true
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Llama 3.3 70B Instruct (free)',
    contextLength: 131_072,
    pricingPrompt: 0,
    pricingCompletion: 0,
    supportsTools: true
  },
  {
    id: 'google/gemini-2.0-flash-exp:free',
    name: 'Gemini 2.0 Flash (free)',
    contextLength: 1_048_576,
    pricingPrompt: 0,
    pricingCompletion: 0,
    supportsTools: true
  },
  {
    id: 'deepseek/deepseek-chat-v3-0324:free',
    name: 'DeepSeek V3 0324 (free)',
    contextLength: 163_840,
    pricingPrompt: 0,
    pricingCompletion: 0,
    supportsTools: true
  },
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    contextLength: 200_000,
    pricingPrompt: 3,
    pricingCompletion: 15,
    supportsTools: true
  },
  {
    id: 'openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    contextLength: 1_047_576,
    pricingPrompt: 0.4,
    pricingCompletion: 1.6,
    supportsTools: true
  }
])

let cache: { at: number; models: ModelInfo[] } | null = null

/** De-duplicates concurrent callers so a cold start issues one request. */
let inFlight: Promise<ModelCatalogResult> | null = null

/**
 * The catalog, plus anything the student needs to know about how it was
 * obtained. The rationale is on `ModelCatalogResult` in shared/types.
 */
export type { ModelCatalogResult }

/**
 * Returns the tool-capable model catalog, from cache when fresh.
 *
 * @param forceRefresh Bypasses the TTL. Wired to the preload's
 *   `listModels(forceRefresh?)`, so the model picker can offer a refresh.
 */
export async function listModels(forceRefresh = false): Promise<ModelCatalogResult> {
  if (!forceRefresh && cache && Date.now() - cache.at < MODEL_CACHE_TTL_MS) {
    return { models: cache.models, notice: null }
  }

  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const models = await fetchModels()
      cache = { at: Date.now(), models }
      return { models, notice: null }
    } catch (error) {
      const reason = describeError(error)
      console.warn('[models] falling back to the bundled list:', reason)

      // A previously good catalog is better than the fallback, even if stale.
      if (cache) {
        return {
          models: cache.models,
          notice:
            `Showing the last catalog that loaded successfully, because OpenRouter could not be ` +
            `reached just now (${reason}). It may be out of date — press Refresh to try again.`
        }
      }
      return {
        models: [...FALLBACK_MODELS],
        notice:
          `Only a short built-in list is shown, because OpenRouter could not be reached ` +
          `(${reason}). Check your internet connection, then press Refresh. You can still enter a ` +
          `model ID by hand below.`
      }
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Looks up a cached model without hitting the network. */
export function findCachedModel(id: string): ModelInfo | undefined {
  return cache?.models.find((model) => model.id === id)
}

/** Drops the cache. Used by the dev self-check and by tests. */
export function resetModelCache(): void {
  cache = null
  inFlight = null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validates a pasted OpenRouter key with a single authenticated request.
 *
 * Returns a `SetApiKeyResult` whose `error` is safe to display. The key itself
 * is never echoed back in any branch, including the failure branches.
 */
export async function validateApiKey(key: string): Promise<SetApiKeyResult> {
  let result: HttpResult | null = null

  try {
    result = asHttpResult(
      await fetchJson(KEY_ENDPOINT, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' }
      })
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: 'OpenRouter did not respond in time. Try again.' }
    }
    return { ok: false, error: 'Could not reach OpenRouter. Check your internet connection.' }
  }

  if (!result) return { ok: false, error: 'OpenRouter returned an unreadable response.' }

  if (result.status === 200) return { ok: true }

  if (result.status === 401 || result.status === 403) {
    return { ok: false, error: 'OpenRouter rejected this key. Check it and try again.' }
  }

  if (result.status === 429) {
    return { ok: false, error: 'OpenRouter is rate-limiting this key. Wait a moment and retry.' }
  }

  return { ok: false, error: `OpenRouter returned an unexpected response (HTTP ${result.status}).` }
}
