/**
 * Local wheel resolution for the Pyodide sandbox.
 *
 * SECURITY: this module is the *only* place in the app that decides where
 * calculation packages come from. Its contract is deliberately narrow:
 *
 *   - every candidate is a **local directory**. There is no code path — env
 *     var, setting, or fallback — that resolves to an `http(s)` URL.
 *   - the directory is handed to Pyodide as `packageBaseUrl`. In Node,
 *     Pyodide derives `cdnUrl` from `packageBaseUrl` and reads wheels with
 *     `fs.readFile`, so a missing wheel raises ENOENT instead of silently
 *     downloading remote code. That is what makes "no remote code" (§7.2,
 *     §8) a property of the substrate rather than a promise.
 *
 * Because the npm `pyodide` package ships only the runtime (asm.js/wasm and
 * `python_stdlib.zip`) and *not* the scientific wheels, the wheels have to be
 * placed in a directory by `src/agent/dev/fetch-wheels.mjs` (a build-time step
 * that talks to the network; the app never does).
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

/**
 * Packages preloaded at startup so a student's first calculation is not a
 * download. `mpmath` is listed explicitly even though it is a `sympy`
 * dependency: it is a first-class numeric tool in its own right (§7.2) and
 * preloading it removes a resolution step from the hot path.
 */
export const PRELOAD_PACKAGES = ['sympy', 'numpy', 'mpmath'] as const

export type PreloadPackage = (typeof PRELOAD_PACKAGES)[number]

/** `pyodide` ships this in `dependencies`, so it is resolvable at run time. */
function resolvePyodideDir(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('pyodide'))
}

/** Appends a trailing separator so Pyodide's URL join does not drop a segment. */
function withTrailingSep(dir: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + '/'
}

/**
 * Ordered candidates for the bundled wheel directory. First existing one wins.
 *
 * Order rationale: an explicit operator override beats everything, then the
 * packaged `resources` location, then the repository-local directory used by
 * `npm run dev` and by `src/agent/dev/selfcheck.ts`.
 *
 * The repository-local candidate is resolved from `process.cwd()` rather than
 * from `import.meta.dirname` because the agent host is a *bundle*: after
 * `electron-vite build`, `import.meta.dirname` points into `out/main/`, where
 * `src/agent/dev/wheels` does not exist. `cwd` is the project root for both
 * `electron-vite dev` and the self-check. In a packaged app the candidate simply
 * does not exist and is skipped, so there is no production behaviour to
 * preserve here.
 */
export function wheelDirCandidates(): string[] {
  const candidates: string[] = []

  const override = process.env.ISHKAPON_PYODIDE_WHEELS
  if (override !== undefined && override.trim().length > 0) candidates.push(resolve(override))

  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(join(resourcesPath, 'pyodide-packages'))
  }

  // Dev: the directory `src/agent/dev/fetch-wheels.mjs` writes to by default.
  candidates.push(join(process.cwd(), 'src', 'agent', 'dev', 'wheels'))

  // Last resort: wheels dropped straight into the pyodide package dir.
  candidates.push(join(resolvePyodideDir(), 'packages'))

  return candidates.filter((dir) => isAbsolute(dir))
}

export interface WheelSource {
  /** Local directory to hand to Pyodide as `packageBaseUrl`. */
  readonly dir: string
  /** `true` when the directory exists. A missing directory is not fatal. */
  readonly exists: boolean
  /** Which candidate matched, for logging. */
  readonly candidate: string
}

/** Picks the first existing wheel directory, or reports the primary candidate. */
export function resolveWheelSource(): WheelSource {
  const candidates = wheelDirCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { dir: withTrailingSep(candidate), exists: true, candidate }
    }
  }
  const fallback = candidates[0]
  return {
    dir: withTrailingSep(fallback ?? join(process.cwd(), 'pyodide-packages')),
    exists: false,
    candidate: fallback ?? '(none)'
  }
}
