/**
 * The OpenRouter client.
 *
 * The key arrives from the main process over the agent host's message port, in
 * memory, and is held here in a closure. It is never logged, never written to a
 * file, and never placed anywhere the sandbox can read it (§9.2, §12.2).
 *
 * The client is behind an interface so the whole turn pipeline — streaming,
 * event mapping, tool dispatch, cancellation — can be exercised without an API
 * key. `createOpenRouterChatModel` is the only place the real network is
 * touched; `selfcheck.ts` injects a scripted model instead.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ModelInfo } from '@shared/types'

/** Resolves a model id to a chat model. Injected in tests. */
export type ChatModelFactory = (modelId: string) => LanguageModel

/**
 * Cheap model used for compaction (§10.3).
 *
 * Overridable because OpenRouter's free tier rotates: pinning a slug that
 * disappears would turn a context-management feature into a turn failure, so
 * the caller is expected to pick something currently available.
 */
export const DEFAULT_COMPACTION_MODEL = 'openai/gpt-4o-mini'

/**
 * Builds a factory bound to one API key.
 *
 * A new provider instance is created per key change rather than mutating a
 * shared one, so a rotated key cannot leave a stale header on an in-flight
 * request.
 */
export function createOpenRouterChatModel(apiKey: string): ChatModelFactory {
  const provider = createOpenRouter({
    apiKey,
    // `strict` is OpenRouter's own documented compatibility level; the default
    // ('compatible') omits `streamOptions`, which loses the usage accounting
    // §13.6 requires in `turn.finished`.
    compatibility: 'strict',
    // Attribution so the student's own dashboard shows where the spend went.
    appName: 'ISHKAPON AI'
  })

  return (modelId: string): LanguageModel => provider.chat(modelId)
}

/** How the host obtains a model for a given id, including compaction. */
export interface ModelResolver {
  readonly chat: ChatModelFactory
  /** Slug used for the §10.3 summary call. */
  compactionModelId: string
}

export function createResolver(apiKey: string, compactionModelId?: string): ModelResolver {
  return {
    chat: createOpenRouterChatModel(apiKey),
    compactionModelId: compactionModelId ?? DEFAULT_COMPACTION_MODEL
  }
}

/**
 * Context length for a model.
 *
 * The agent host is not the component that fetches `/models` — main owns the
 * catalog and the cache — so when a slug is not in the catalog this falls back
 * to a conservative value. Guessing *high* would be the dangerous direction
 * (a request that the provider truncates or rejects); 16k is a widely available
 * baseline and keeps a small-context model from silently overflowing.
 */
export function contextLengthFor(modelId: string, catalog: readonly ModelInfo[]): number {
  const match = catalog.find((model) => model.id === modelId)
  if (match !== undefined && Number.isFinite(match.contextLength) && match.contextLength > 0) {
    return match.contextLength
  }
  return FALLBACK_CONTEXT_LENGTH
}

const FALLBACK_CONTEXT_LENGTH = 16_384
