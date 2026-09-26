/**
 * Agent host entry point.
 *
 * Runs as an Electron `utilityProcess` (see `src/main/agent-host.ts`). It owns
 * everything that touches the model or executes code:
 *
 *   - the AI SDK 7 / OpenRouter client and the multi-step tool loop
 *   - the Pyodide (CPython/WASM) calculation sandbox — the *only* tool
 *   - context compaction
 *
 * Design constraints that are easy to break by accident:
 *
 *   1. This process has no filesystem or network access to offer the model.
 *      Pyodide runs with an in-memory VFS and `micropip` disabled, so the worst
 *      a hijacked model can do is produce a wrong answer. Do not add filesystem
 *      mounts, `micropip`, or any `child_process` usage.
 *   2. The OpenRouter API key arrives from the main process in memory. Never
 *      write it to disk, log it, or expose it to Pyodide.
 *   3. Everything user-visible is emitted as an `AgentEvent` and persisted by
 *      the main process. This process does not own the database.
 */
import { startAgentHost } from './host'

startAgentHost().catch((error: unknown) => {
  console.error('[agent] fatal error during startup:', error)
  process.exit(1)
})
