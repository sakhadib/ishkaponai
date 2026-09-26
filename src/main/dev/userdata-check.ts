/**
 * Dev-only check that the development build and the installed build do not share
 * one data directory.
 *
 * Run it with plain Node after bundling:
 *
 *   node_modules/.bin/esbuild src/main/dev/userdata-check.ts \
 *     --bundle --platform=node --format=esm --target=node24 \
 *     --alias:@shared=./src/shared \
 *     --outfile=<tmp>/userdata-check.mjs
 *   node <tmp>/userdata-check.mjs
 *
 * ## The bug this guards
 *
 * Electron derives `userData` from `app.getPath('appData')` plus the app name,
 * and the two builds do not agree on the name. `electron-builder` writes
 * `productName: "ISHKAPON AI"` into the packaged app as the name `ISHKAPON-AI`;
 * a dev build reads `ishkapon-ai` from the repo's package.json. The two differ
 * only in case, so on a case-insensitive filesystem — NTFS, and APFS/HFS+ which
 * is the macOS default — they are **the same directory**.
 *
 * The symptom seen in the field was an OpenRouter key and a chat history
 * appearing in a freshly installed copy of the app. The key still *worked*, which
 * is what makes it conclusive rather than merely suspicious: Windows DPAPI is
 * scoped to the user account, not to the app, so either build can decrypt what
 * the other wrote. One `secrets` row, two readers.
 *
 * The quieter consequences matter more than that one. A schema migration run by
 * `npm run dev` lands in the database the installed build reads, so a dev build
 * can break a real student's install. The `usage_daily` ledger counts development
 * against a student's token totals, which makes the Usage page — a page whose
 * whole purpose is to be believed — quietly wrong. And both builds contend for
 * one single-instance lock file, so the second to launch quits as though it were
 * a duplicate.
 *
 * ## Why this reads the source instead of calling a function
 *
 * The decision lives in `src/bootstrap.cjs`, which is CommonJS, has side effects
 * by design, and is copied into the bundle verbatim rather than bundled — so it
 * cannot import a helper that a check could exercise. Behavioural testing would
 * need a mutable `electron` stub plus require-cache surgery to observe a
 * `setPath` call that happens before anything else runs.
 *
 * Asserting on the source text is the weaker tool and it is chosen knowingly.
 * What it buys is that it tests the *real* file rather than a copy of its
 * constant, so the two cannot drift apart, and it fails on each of the three
 * ways this can regress: the guard being removed, the directory being renamed
 * back into a collision, or the released build being redirected as well.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let checks = 0
let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
}

/**
 * The repository root, from the working directory rather than from
 * `import.meta.url`. This file is bundled to a temporary directory before being
 * run, so `import.meta.url` points at the temp directory and not at the source
 * tree. Every sibling check is invoked with relative `--alias:@shared=./src/shared`
 * paths, which already require the working directory to be the repository root, so
 * this adds no new constraint.
 */
const repoRoot = process.cwd()
const bootstrapPath = join(repoRoot, 'src', 'bootstrap.cjs')

/**
 * The bootstrap source with comments removed, so assertions are about code.
 *
 * This is not fussiness. The file's own header comment names
 * `app.requestSingleInstanceLock()` in prose, several hundred characters before
 * the real call, so a plain `indexOf` finds the documentation and cheerfully
 * reports that the lock is requested *before* the `userData` redirect — which is
 * the opposite of the truth, and would have sent someone to "fix" correct code.
 *
 * A small state machine rather than a regex, because a regex that strips `//`
 * comments also eats the `//` in a string like `'https://...'`, and a check that
 * quietly mangles its own input is the same failure mode as not having the check.
 */
function stripComments(source: string): string {
  let out = ''
  let quote: string | null = null
  let inLine = false
  let inBlock = false

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string
    const next = source[i + 1]

    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i += 1
      } else if (char === '\n') {
        out += char
      }
      continue
    }

    if (quote !== null) {
      out += char
      if (char === '\\') {
        // Copy the escaped character verbatim so an escaped quote does not end
        // the string early.
        const escaped = source[i + 1]
        if (escaped !== undefined) {
          out += escaped
          i += 1
        }
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '/' && next === '/') {
      inLine = true
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      i += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    }
    out += char
  }

  return out
}

const bootstrapSource = readFileSync(bootstrapPath, 'utf8')
const bootstrap = stripComments(bootstrapSource)

/** The directory name the dev build redirects `userData` to. */
function devDirName(): string | null {
  const match = bootstrap.match(
    /if \(!app\.isPackaged\) \{\s*app\.setPath\(\s*'userData',\s*join\(\s*app\.getPath\('appData'\),\s*'([^']+)'\s*\)\s*\)\s*\}/
  )
  return match?.[1] ?? null
}

/**
 * The names a packaged build could resolve, which is what `userData` is built
 * from.
 *
 * `electron-builder` normalises `productName` into the packaged `name` field:
 * everything that is not a letter or digit becomes a hyphen, then it is
 * upper-cased. "ISHKAPON AI" therefore ships as "ISHKAPON-AI".
 *
 * Read out of `electron-builder.yml` with a regex rather than a YAML parser on
 * purpose. `js-yaml` is present in `node_modules` but only as a transitive
 * dependency of electron-builder, and a check that quietly stops working the
 * next time that tree is reshuffled is worse than one that reads a single scalar
 * a little clumsily. `productName` is not in package.json at all — it lives in
 * the builder config, and looking in the wrong file is how this check first came
 * to believe the app had no name.
 *
 * The repo's own `name` is included too, so the check has something to compare
 * against even if `productName` is ever dropped, and so both are covered rather
 * than whichever happens to exist today.
 */
function packagedNames(): string[] {
  const found: string[] = []

  const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
  const product = yml.match(/^productName:\s*["']?([^"'\n#]+?)["']?\s*$/m)
  if (product?.[1]) {
    found.push(product[1].replace(/[^A-Za-z0-9]/g, '-').toUpperCase())
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    name?: string
    productName?: string
  }
  if (pkg.productName) found.push(pkg.productName)
  if (pkg.name) found.push(pkg.name)

  return found
}

const dev = devDirName()
const packaged = packagedNames()

check(
  'bootstrap.cjs redirects userData for the dev build',
  dev !== null,
  { found: dev, hint: 'the isPackaged guard or the setPath call changed shape' }
)

check(
  'a packaged app name could be derived to compare against',
  packaged.length > 0,
  { candidates: packaged, hint: 'neither productName in electron-builder.yml nor name in package.json' }
)

if (dev !== null && packaged.length > 0) {
  for (const candidate of packaged) {
    // The whole point. Case-folded, because that is the comparison the filesystem
    // performs: two names differing only in case are one directory on NTFS and on
    // an APFS/HFS+ volume, which is the macOS default, and two on ext4. A check
    // that compared them exactly would have passed while the bug was live.
    check(
      `dev dir "${dev}" does not collide with packaged name "${candidate}"`,
      dev.toLowerCase() !== candidate.toLowerCase(),
      { dev, candidate, collideUnderCaseFolding: dev.toLowerCase() === candidate.toLowerCase() }
    )

    // Belt and braces. The comparison above is about the *name*; this is about the
    // final path. They are separate risks — a future `appData` relocation could
    // reintroduce the collision even with distinct names.
    const devPath = join('/appData', dev)
    const packagedPath = join('/appData', candidate)
    check(
      `resolved paths differ under case folding for "${candidate}"`,
      devPath.toLowerCase() !== packagedPath.toLowerCase(),
      { dev: devPath, packaged: packagedPath }
    )
  }

  // The redirect must not touch a released build. `app.isPackaged` is true for an
  // MSI install, so a guard written the other way round, or a setPath left
  // outside the conditional, would move every student's data on upgrade.
  const guardIndex = bootstrap.indexOf('if (!app.isPackaged) {')
  const setPathIndex = bootstrap.indexOf("app.setPath('userData'")
  check(
    'the redirect sits inside the !isPackaged guard',
    guardIndex !== -1 && setPathIndex > guardIndex,
    { guardIndex, setPathIndex }
  )

  check(
    'the redirect happens before the single-instance lock is requested',
    setPathIndex !== -1 &&
      setPathIndex < bootstrap.indexOf('app.requestSingleInstanceLock()'),
    {
      setPathIndex,
      lockIndex: bootstrap.indexOf('app.requestSingleInstanceLock()'),
      why: 'the lock file lives under userData; redirecting afterwards would separate the databases but leave both builds contending for one lock'
    }
  )

  check(
    'the single-instance lock is still requested exactly once',
    bootstrap.split('app.requestSingleInstanceLock()').length - 1 === 1
  )
}

console.log(`\n  ${checks - failures}/${checks} checks passed.`)
if (failures > 0) {
  console.error(`  ${failures} check(s) failed.`)
  process.exitCode = 1
}
