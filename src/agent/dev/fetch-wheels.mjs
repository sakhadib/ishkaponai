#!/usr/bin/env node
/**
 * Build-time only: downloads the Pyodide scientific wheels into a local
 * directory that the agent host reads at run time.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `pyodide` npm package ships only the runtime — `pyodide.asm.wasm`,
 * `pyodide.asm.js`, `python_stdlib.zip` and `pyodide-lock.json`. The
 * scientific packages (`sympy`, `numpy`, `mpmath`) live in a *separate* release
 * artefact that the npm tarball does not include. So they have to be placed on
 * disk once, by a machine that has network access, and then shipped with the
 * app.
 *
 * SECURITY
 * --------
 * This is the *only* code in the project that talks to the network on behalf of
 * the calculation stack, and it runs on a developer or CI machine, never in the
 * app. The agent host sets `packageBaseUrl` to the resulting directory, so at
 * run time a missing wheel is an `ENOENT`, not a download.
 *
 * Every artefact's SHA-256 is verified against `pyodide-lock.json` — the lock
 * file that ships inside the `pyodide` package — so a tampered or
 * version-mismatched wheel cannot be installed silently.
 *
 * USAGE
 *   node src/agent/dev/fetch-wheels.mjs [--out <dir>] [--force]
 *
 * Default output is `src/agent/dev/wheels`, which is the third candidate
 * `src/agent/wheels.ts` probes, so `npm run dev` and the self-check work
 * immediately afterwards. For a packaged build, copy that directory to
 * `<resources>/pyodide-packages` (see the report on electron-builder.yml).
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Must match `PRELOAD_PACKAGES` in `src/agent/wheels.ts`. */
const WANTED = ['sympy', 'numpy', 'mpmath']

const here = dirname(fileURLToPath(import.meta.url))
const defaultOut = join(here, 'wheels')

const args = process.argv.slice(2)
const force = args.includes('--force')
const outIndex = args.indexOf('--out')
const outDir = resolve(outIndex === -1 ? defaultOut : (args[outIndex + 1] ?? defaultOut))

const require = createRequire(import.meta.url)
const pyodideDir = dirname(require.resolve('pyodide'))
const lockPath = join(pyodideDir, 'pyodide-lock.json')

if (!existsSync(lockPath)) {
  console.error(`pyodide-lock.json not found at ${lockPath}`)
  process.exit(1)
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const version = lock.info === undefined ? 'unknown' : String(lock.info.abi_version ?? 'unknown')
const base = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion()}/full/`

/**
 * The npm package version and the Pyodide release version are the same string in
 * practice, but they are distinct concepts; taking it from the lock file's
 * sibling `pyodide.mjs` is not possible without importing it, so it is read
 * from the package manifest, which is authoritative for the runtime we load.
 */
function pyodideVersion() {
  const manifest = JSON.parse(
    readFileSync(join(pyodideDir, 'package.json'), 'utf8')
  )
  return String(manifest.version)
}

/** Resolves the transitive closure of the wanted packages. */
function closure(names) {
  const seen = new Set()
  const queue = [...names]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const entry = lock.packages[name]
    if (entry === undefined) {
      throw new Error(`package "${name}" is not in pyodide-lock.json`)
    }
    for (const dep of entry.depends ?? []) queue.push(dep)
  }
  return [...seen]
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

mkdirSync(outDir, { recursive: true })
console.log(`pyodide lock abi: ${version}`)
console.log(`writing wheels to ${outDir}`)

let installed = 0
let skipped = 0
let totalBytes = 0

for (const name of closure(WANTED)) {
  const entry = lock.packages[name]
  const file = entry.file_name
  const target = join(outDir, file)

  if (existsSync(target) && !force) {
    const existing = createHash('sha256').update(readFileSync(target)).digest('hex')
    if (existing === entry.sha256) {
      console.log(`  ok       ${file} (cached)`)
      skipped += 1
      continue
    }
    console.log(`  refresh  ${file} (cached copy failed sha256)`)
  }

  process.stdout.write(`  download ${file} ... `)
  const bytes = await download(base + file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.sha256) {
    console.error(`FAILED\n  expected sha256 ${entry.sha256}\n  got      ${digest}`)
    process.exit(1)
  }
  writeFileSync(target, bytes)
  console.log(`${(bytes.length / 1024).toFixed(0)} KB, sha256 verified`)
  installed += 1
  totalBytes += bytes.length
}

// A marker the agent host logs can key off, and a human-readable note about why
// this directory must ship with the app.
writeFileSync(
  join(outDir, 'README.txt'),
  [
    'ISHKAPON Pyodide calculation wheels.',
    '',
    `pyodide npm package: ${pyodideVersion()}`,
    `lock abi_version:    ${version}`,
    `packages:            ${closure(WANTED).sort().join(', ')}`,
    '',
    'These files were fetched by src/agent/dev/fetch-wheels.mjs and their SHA-256',
    'digests verified against pyodide-lock.json.',
    '',
    'The agent host passes this directory to Pyodide as `packageBaseUrl`, which is',
    'what makes the sandbox offline: a missing wheel is an ENOENT, never a',
    'download. This directory must be unpacked alongside the app in a packaged',
    'build (electron-builder.yml: asarUnpack).',
    ''
  ].join('\n')
)

console.log(
  `done: ${installed} downloaded, ${skipped} cached, ${(totalBytes / 1024 / 1024).toFixed(1)} MB fetched`
)
