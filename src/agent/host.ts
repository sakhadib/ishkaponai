/**
 * Placeholder — replaced by the agent-host implementation.
 *
 * Present only so the build graph is complete before that work lands.
 */
export async function startAgentHost(): Promise<void> {
  process.parentPort.on('message', (event: { data: unknown }) => {
    console.log('[agent] placeholder received', event.data)
  })
  process.parentPort.postMessage({ type: 'ready' })
}
