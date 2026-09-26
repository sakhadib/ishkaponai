import { app } from 'electron'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

const DEFAULTS: WindowState = { width: 1180, height: 760, maximized: false }

const MIN_WIDTH = 940
const MIN_HEIGHT = 600

let cache: WindowState | null = null
let writeTimer: NodeJS.Timeout | null = null

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** Reads persisted window bounds, falling back to sensible defaults. */
export async function loadWindowState(): Promise<WindowState> {
  if (cache) return cache

  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)

    if (isWindowState(parsed)) {
      cache = parsed
      return cache
    }
  } catch {
    // No saved state yet, or the file is unreadable/corrupt. Use defaults.
  }

  cache = { ...DEFAULTS }
  return cache
}

/** Queues a debounced write so rapid resize/move events do not thrash the disk. */
export function saveWindowState(state: WindowState): void {
  cache = state

  if (writeTimer) clearTimeout(writeTimer)

  writeTimer = setTimeout(() => {
    writeTimer = null
    void persist(state)
  }, 400)
}

/** Flushes any pending write immediately. Called before the app quits. */
export async function flushWindowState(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  if (cache) await persist(cache)
}

async function persist(state: WindowState): Promise<void> {
  const target = statePath()

  try {
    await mkdir(dirname(target), { recursive: true })

    // Write to a temp file first so a crash mid-write cannot corrupt the state.
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, target)
  } catch (error) {
    console.error('[store] failed to persist window state:', error)
  }
}

function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    (candidate.x === undefined || typeof candidate.x === 'number') &&
    (candidate.y === undefined || typeof candidate.y === 'number') &&
    typeof candidate.maximized === 'boolean'
  )
}

export const WINDOW_BOUNDS = { MIN_WIDTH, MIN_HEIGHT }
