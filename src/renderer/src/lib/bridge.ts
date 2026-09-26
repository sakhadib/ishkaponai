/**
 * The single place the renderer touches `window.ishkapon`.
 *
 * Every call can reject — the main process may be mid-restart, the agent host
 * may be down, or a channel may be missing. Rather than let an unhandled
 * rejection kill a component, each helper turns a rejection into a readable
 * message. Callers that care can catch; callers that do not still get a
 * sensible `Error` and a visible error row in the UI.
 */
import type { IshkaponApi } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'

/**
 * `window.ishkapon` is absent when the preload script did not run, which means
 * the app is running outside Electron (a plain browser, or a test harness).
 * Failing loudly here beats a `TypeError: cannot read properties of undefined`
 * from somewhere deep in a component.
 */
export function bridge(): IshkaponApi {
  const api = window.ishkapon
  if (!api) {
    throw new Error(
      'The ISHKAPON bridge is unavailable. window.ishkapon is missing, which means the preload script did not run.'
    )
  }
  return api
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ishkapon)
}

function label(operation: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${operation} failed: ${detail}`
}

/**
 * Normalises an unknown throwable into an `Error` carrying a human-readable
 * message. Electron's `invoke` rejects with a string prefixed by the channel
 * name, which is unhelpful on its own, so the operation is named too.
 */
function asError(operation: string, error: unknown): Error {
  return new Error(label(operation, error))
}

/** Runs `fn` with the bridge, converting any rejection into a thrown `Error`. */
export async function call<T>(operation: string, fn: (api: IshkaponApi) => Promise<T>): Promise<T> {
  try {
    return await fn(bridge())
  } catch (error) {
    throw asError(operation, error)
  }
}

/**
 * Like {@link call}, but never throws. Returns `fallback` when the call
 * rejects, and records the reason so the UI can show it. Used for anything
 * that must not break the shell — loading the session list, for instance.
 */
export async function callQuiet<T>(
  operation: string,
  fn: (api: IshkaponApi) => Promise<T>,
  fallback: T,
  onError?: (error: Error) => void
): Promise<T> {
  try {
    return await fn(bridge())
  } catch (error) {
    onError?.(asError(operation, error))
    return fallback
  }
}

/**
 * Subscribes to agent events. Returns a no-op unsubscribe if the bridge is
 * missing, so callers can always use the result in a cleanup function.
 */
export function onAgentEvent(handler: (event: AgentEvent) => void): () => void {
  if (!hasBridge()) return () => undefined
  try {
    return bridge().onAgentEvent(handler)
  } catch {
    return () => undefined
  }
}
