/**
 * The calculation sandbox: CPython compiled to WebAssembly.
 *
 * This is the only code-execution surface in ISHKAPON and therefore the only
 * thing standing between a hijacked model and the student's machine. Four
 * invariants are load-bearing and must not be relaxed:
 *
 *   1. NO REAL FILESYSTEM. The Pyodide filesystem is the in-memory MEMFS. The
 *      host filesystem is never mounted: `mountNodeFS` and `useNodeSockFS` are
 *      never referenced anywhere in this project, and `NODEFS` is not linked
 *      into the runtime, so the mount APIs have nothing to mount with.
 *      `open('/etc/passwd')` fails with FileNotFoundError.
 *   2. NO NETWORK. `packageBaseUrl` points at a local directory (see
 *      `wheels.ts`), so Pyodide resolves wheels with `fs.readFile` and a miss is
 *      an ENOENT, not a download. `micropip` is never loaded, so
 *      `import micropip` fails with ModuleNotFoundError. There is no setting
 *      that re-enables either.
 *   3. NO CHILD PROCESSES. This file spawns no process. Python's `subprocess`,
 *      `os.system` and `socket` are all absent from the runtime. The only thing
 *      spawned is one `worker_threads` thread, which holds nothing but the
 *      interpreter and a one-byte mailbox.
 *   4. THE API KEY IS NEVER IN REACH. The interpreter is constructed with an
 *      empty `env`, so Python can read none of this process's environment, and
 *      no key is ever placed in `globals`, a Python variable, or a file.
 *
 * WHY A WORKER THREAD
 * -------------------
 * Interruption is the whole reason. `runPython` is synchronous, so while a step
 * is running this thread's event loop is blocked: a `setTimeout` cannot fire, a
 * `stop` command cannot be read off the message port, and `checkInterrupt()`
 * cannot be called. Verified empirically — a `while True: pass` loop is
 * unkillable from the thread that is running it.
 *
 * So the interpreter lives on a worker thread, and this thread stays free to
 * (a) run the timeout, (b) read the `stop` command, and (c) write one byte into
 * a `SharedArrayBuffer`. CPython's own signal machinery polls that byte and
 * raises `KeyboardInterrupt` at the next bytecode boundary. Verified inside a
 * real Electron `utilityProcess`: main thread writes SIGINT, the worker's
 * in-progress `while True` loop dies with `KeyboardInterrupt`.
 *
 * A thread is not a process: no new PID, no stdio, no environment, and no host
 * handles beyond the mailbox byte. §8's "no child processes" still holds.
 *
 * ERRORS ARE DATA
 * ---------------
 * Nothing here throws at the caller. A failed step comes back as
 * `{ status: 'error', error: traceback }` so the model can read it and correct
 * itself on the next step (§7.2).
 */
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRELOAD_PACKAGES, resolveWheelSource } from './wheels'

/** Cap on captured stdout+stderr per step, per §7.2. */
const OUTPUT_LIMIT_BYTES = 64 * 1024

/** Visible marker appended when output is cut. The UI keys off this text. */
const TRUNCATION_MARKER =
  '\n... [truncated by ISHKAPON: this step produced more than 64 KB of output] ...'

/** Wall-clock ceiling for a single step, independent of `settings.pythonTimeoutMs`. */
const HARD_TIMEOUT_CEILING_MS = 10 * 60 * 1000

/** Sentinel written into the interrupt buffer to raise `KeyboardInterrupt`. */
const SIGINT = 2

/** How long to wait for the worker's first `ready` before declaring failure. */
const WORKER_BOOT_TIMEOUT_MS = 120_000

/**
 * How often the host re-checks the deadline and the Stop flag.
 *
 * Cheap because this thread is idle while a step runs: it is only servicing a
 * timer. 50 ms keeps the Stop button feeling immediate without measurable cost.
 */
const WATCHDOG_POLL_MS = 50

export interface SandboxLogger {
  (message: string): void
}

export interface SandboxRunOptions {
  /** Per-step wall-clock limit. Clamped to `[1s, 10min]`. */
  readonly timeoutMs: number
  /**
   * Consulted before a step starts. Returning `true` refuses the step outright.
   * Mid-step cancellation is driven by `signal`.
   */
  readonly shouldAbort: () => boolean
  /** Receives stdout chunks as CPython flushes them. */
  readonly onOutput?: (chunk: string) => void
  /** Aborting this signal interrupts the running step, not just the model call. */
  readonly signal?: AbortSignal
}

export type SandboxStatus = 'ok' | 'error' | 'timeout' | 'cancelled'

export interface SandboxResult {
  readonly status: SandboxStatus
  /** Captured stdout, capped, with stderr appended when present. */
  readonly stdout: string
  /** `repr()`-grade rendering of a trailing bare expression, else `null`. */
  readonly value: string | null
  /** Python exception text, or a host-generated explanation. Never thrown. */
  readonly error: string | null
  readonly durationMs: number
  readonly truncated: boolean
}

export interface SandboxStatusInfo {
  readonly ready: boolean
  readonly error: string | null
  readonly initMs: number | null
  readonly packagesReady: boolean
  readonly packagesMs: number | null
  readonly packagesError: string | null
  readonly packageBaseUrl: string
  readonly wheelsFound: boolean
  readonly pythonVersion: string | null
  readonly interruptSupported: boolean
  /** 'thread' when the interpreter is on a worker thread, 'local' if in-process. */
  readonly placement: 'thread' | 'unavailable'
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

/** Host -> worker. */
type Inbound =
  | { readonly kind: 'step'; readonly id: number; readonly code: string; readonly needPackages: boolean }
  | { readonly kind: 'load-packages' }
  | { readonly kind: 'reset' }

/** Worker -> host. */
type Outbound =
  | { readonly kind: 'ready'; readonly version: string; readonly packagesReady: boolean; readonly packagesError: string | null; readonly bootMs: number }
  | { readonly kind: 'out'; readonly id: number; readonly chunk: string }
  | { readonly kind: 'err'; readonly id: number; readonly chunk: string }
  | {
      readonly kind: 'done'
      readonly id: number
      readonly value: string | null
      readonly error: string | null
      readonly errorType: string | null
      readonly durationMs: number
    }
  | { readonly kind: 'packages'; readonly ready: boolean; readonly error: string | null; readonly ms: number }
  | { readonly kind: 'fatal'; readonly message: string }

interface PendingStep {
  readonly id: number
  resolve: (result: SandboxResult) => void
}

export class PythonSandbox {
  private readonly log: SandboxLogger
  private readonly wheelBaseUrl: string
  private readonly wheelsFound: boolean
  private readonly interruptSupported: boolean
  private readonly pyodideEntry: string
  private readonly pyodideIndexURL: string
  private readonly mailbox: SharedArrayBuffer
  private readonly mailboxView: Uint8Array

  private worker: Worker | null = null
  private boot: Promise<void> | null = null
  private bootFailure: string | null = null
  private initMs: number | null = null
  private packagesReady = false
  private packagesMs: number | null = null
  private packagesError: string | null = null
  private pythonVersion: string | null = null

  private stepCounter = 0
  private activeStep: PendingStep | null = null
  private stepCollector: OutputCollector | null = null
  private stepTimer: ReturnType<typeof setInterval> | null = null
  private stepAbortListener: (() => void) | null = null
  private stepStoppedByUser = false

  constructor(log: SandboxLogger = (message) => console.log(`[agent:sandbox] ${message}`)) {
    const source = resolveWheelSource()
    this.wheelBaseUrl = source.dir
    this.wheelsFound = source.exists
    this.log = log
    this.interruptSupported = typeof SharedArrayBuffer === 'function'
    this.mailbox = new SharedArrayBuffer(1)
    this.mailboxView = new Uint8Array(this.mailbox)

    // The ESM entry, not the CJS one: `require.resolve('pyodide')` returns
    // `pyodide.js`, and importing that as ESM yields a namespace with no
    // `loadPyodide` named export. The worker imports this URL directly.
    const require = createRequire(import.meta.url)
    this.pyodideEntry = pathToFileURL(require.resolve('pyodide/pyodide.mjs')).href
    this.pyodideIndexURL = dirname(require.resolve('pyodide/pyodide.mjs'))

    this.log(`wheel source: ${source.candidate} (exists: ${source.exists})`)
    this.log(`interrupts supported: ${this.interruptSupported}`)
  }

  /**
   * Boots the interpreter on the worker thread. Never rejects: a failure is
   * recorded and surfaced as a clear tool error, because an app that cannot
   * calculate should still be able to explain itself.
   */
  async init(): Promise<void> {
    if (this.worker !== null) return
    const started = Date.now()
    this.boot = this.spawn().catch((error: unknown) => {
      this.bootFailure = describe(error)
      this.log(`sandbox init failed: ${this.bootFailure}`)
    })
    await this.boot
    this.initMs = Date.now() - started
  }

  /**
   * Preloads the scientific stack so the first real calculation does not pay
   * for it. Safe to call repeatedly; a failure is remembered, not retried on
   * every step, so a broken wheel directory does not add 500 ms to every turn.
   */
  async warmUp(): Promise<void> {
    if (this.packagesReady || this.packagesError !== null) return
    const started = Date.now()
    try {
      await this.requestPackages()
      this.log(`packages ready in ${Date.now() - started} ms`)
    } catch (error) {
      this.packagesError = describe(error)
      this.log(`package preload failed after ${Date.now() - started} ms: ${this.packagesError}`)
    }
  }

  /**
   * Executes one step.
   *
   * `runPython` returns the value of a trailing bare expression, which is what
   * makes `9.81 * 2.5` yield a value with no `print`.
   */
  async run(code: string, options: SandboxRunOptions): Promise<SandboxResult> {
    const started = Date.now()

    if (this.worker === null) {
      return failure(
        this.bootFailure === null
          ? 'The Python sandbox is not running, so calculation is unavailable.'
          : `The Python sandbox could not start: ${this.bootFailure}`,
        started
      )
    }
    if (options.shouldAbort()) {
      return failure('Cancelled before the step started.', started)
    }

    this.stepCounter += 1
    const id = this.stepCounter
    const collector = createOutputCollector(options.onOutput)

    this.stepCollector = collector
    this.stepStoppedByUser = false

    // Clear any stale interrupt request so a previous abort cannot kill this
    // step, then arm the deadline and the Stop watch. Both live on this thread
    // precisely because this thread is not the one running the step — which is
    // the whole reason the interpreter is on a worker thread at all.
    this.mailboxView.fill(0)
    const deadline = Date.now() + clampTimeout(options.timeoutMs)
    this.stepTimer = setInterval(() => {
      if (this.mailboxView[0] !== 0) return
      const stopped = options.shouldAbort() || options.signal?.aborted === true
      if (stopped) {
        this.stepStoppedByUser = true
        this.interrupt()
        return
      }
      if (Date.now() > deadline) this.interrupt()
    }, WATCHDOG_POLL_MS)
    this.stepAbortListener = () => {
      this.stepStoppedByUser = true
      this.interrupt()
    }
    options.signal?.addEventListener('abort', this.stepAbortListener, { once: true })

    // The worker installs the scientific stack before running the step when it
    // is not already loaded, and reports a clear failure rather than letting a
    // ModuleNotFoundError reach the student looking like the model's mistake.
    const needPackages = !this.packagesReady
    this.packagesReady = false

    try {
      return await this.dispatch(id, { kind: 'step', id, code, needPackages })
    } catch (error) {
      return failure(describe(error), started)
    } finally {
      if (this.stepTimer !== null) clearInterval(this.stepTimer)
      if (this.stepAbortListener !== null) {
        options.signal?.removeEventListener('abort', this.stepAbortListener)
      }
      this.stepTimer = null
      this.stepAbortListener = null
      this.stepCollector = null
      this.mailboxView.fill(0)
    }
  }

  /**
   * Drops every trace of the previous conversation: a fresh interpreter with a
   * fresh `globals`, a fresh stdio collector, and freshly loaded packages.
   *
   * §7.2 requires a reset *between sessions* so a variable a model named in one
   * chat cannot influence another. Rather than scrubbing the existing
   * `globals` — where an imported module, a cached `sys.modules` entry, or a
   * `del` that fails would all leak — the interpreter is rebuilt from scratch.
   *
   * `force` also rebuilds a live interpreter. The host uses it after an
   * interrupted step, because a hard interrupt can leave CPython in a state
   * where the immediate recovery check passes but the next step misbehaves.
   */
  async reset(force = false): Promise<void> {
    if (this.worker === null && !force) {
      await this.init()
      return
    }
    const started = Date.now()
    this.clearStepState()
    this.packagesReady = false
    this.packagesMs = null
    this.packagesError = null
    this.pythonVersion = null

    const worker = this.worker
    if (worker === null) {
      // No live thread to rebuild inside; drop it and start a fresh one.
      this.teardown()
      await this.init()
      this.log(`interpreter reset in ${Date.now() - started} ms`)
      return
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WORKER_BOOT_TIMEOUT_MS)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.resetWaiters.add(waiter)
      worker.postMessage({ kind: 'reset' } satisfies Inbound)
    })
    this.log(`interpreter reset in ${Date.now() - started} ms`)
  }

  status(): SandboxStatusInfo {
    return {
      ready: this.worker !== null && this.bootFailure === null,
      error: this.bootFailure,
      initMs: this.initMs,
      packagesReady: this.packagesReady,
      packagesMs: this.packagesMs,
      packagesError: this.packagesError,
      packageBaseUrl: this.wheelBaseUrl,
      wheelsFound: this.wheelsFound,
      pythonVersion: this.pythonVersion,
      interruptSupported: this.interruptSupported,
      placement: this.worker === null ? 'unavailable' : 'thread'
    }
  }

  // -------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------

  /** Cancels any in-flight bookkeeping without touching the thread. */
  private clearStepState(): void {
    if (this.stepTimer !== null) clearInterval(this.stepTimer)
    this.stepTimer = null
    this.stepAbortListener = null
    this.stepCollector = null
    this.activeStep = null
    this.mailboxView.fill(0)
  }

  private teardown(): void {
    this.clearStepState()
    this.packagesReady = false
    this.packagesMs = null
    this.packagesError = null
    this.pythonVersion = null
    this.initMs = null
    this.resetWaiters.clear()
    const worker = this.worker
    this.worker = null
    if (worker !== null) void worker.terminate().catch(() => undefined)
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          entry: this.pyodideEntry,
          indexURL: this.pyodideIndexURL,
          packageBaseUrl: this.wheelBaseUrl,
          packages: [...PRELOAD_PACKAGES],
          mailbox: this.mailbox
        },
        // The turn loop owns the worker's lifetime; silence its streams so a
        // stray write can never reach the agent host's stdio.
        stdout: false,
        stderr: false
      })
      this.worker = worker

      let settled = false
      const bootTimer = setTimeout(() => {
        if (settled) return
        settled = true
        this.bootFailure = `the sandbox thread did not start within ${WORKER_BOOT_TIMEOUT_MS} ms`
        resolve()
      }, WORKER_BOOT_TIMEOUT_MS)

      worker.on('message', (raw: unknown) => {
        const message = raw as Outbound
        switch (message.kind) {
          case 'ready': {
            this.pythonVersion = message.version
            this.packagesReady = message.packagesReady
            this.packagesError = message.packagesError
            this.log(`interpreter up: Python ${message.version} in ${message.bootMs} ms`)
            this.resetWaiters.forEach((waiter) => waiter())
            this.resetWaiters.clear()
            if (!settled) {
              settled = true
              clearTimeout(bootTimer)
              resolve()
            }
            return
          }
          case 'out': {
            if (this.activeStep?.id === message.id) this.stepCollector?.writeOut(message.chunk)
            return
          }
          case 'err': {
            if (this.activeStep?.id === message.id) this.stepCollector?.writeErr(message.chunk)
            return
          }
          case 'done': {
            const pending = this.activeStep
            if (pending === null || pending.id !== message.id) return
            this.activeStep = null
            pending.resolve(this.assemble(pending.id, message))
            return
          }
          case 'packages': {
            this.packagesReady = message.ready
            this.packagesError = message.error
            this.packagesMs = message.ms
            this.packageWaiters.forEach((waiter) => waiter())
            this.packageWaiters.clear()
            return
          }
          case 'fatal': {
            this.log(`sandbox thread reported a fatal error: ${message.message}`)
            if (!settled) {
              settled = true
              clearTimeout(bootTimer)
              this.bootFailure = message.message
              resolve()
            }
            return
          }
          default: {
            this.log(`unrecognised sandbox message: ${JSON.stringify(message)}`)
          }
        }
      })

      worker.on('error', (error: Error) => {
        this.log(`sandbox thread error: ${error.message}`)
        if (!settled) {
          settled = true
          clearTimeout(bootTimer)
          this.bootFailure = error.message
          resolve()
        }
      })

      worker.on('exit', (code: number) => {
        this.log(`sandbox thread exited with code ${code}`)
        if (this.worker === worker) this.worker = null
        if (!settled) {
          settled = true
          clearTimeout(bootTimer)
          this.bootFailure = `the sandbox thread exited with code ${code}`
          resolve()
        }
      })
    })
  }

  private readonly packageWaiters = new Set<() => void>()
  private readonly resetWaiters = new Set<() => void>()

  /**
   * Asks the worker to install the scientific stack and waits for the verdict.
   *
   * `loadPackage` resolves rather than rejects when a wheel is missing, so the
   * worker's `errorCallback` is the only signal — without this, a missing wheel
   * surfaces later as a confusing `ModuleNotFoundError` inside the student's
   * step, looking like the model's mistake.
   */
  private async requestPackages(): Promise<void> {
    const worker = this.worker
    if (worker === null) throw new Error('the sandbox thread is not running')
    if (this.packagesReady) return

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.packageWaiters.delete(waiter)
        resolve()
      }, 120_000)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.packageWaiters.add(waiter)
      worker.postMessage({ kind: 'load-packages' } satisfies Inbound)
    })

    if (!this.packagesReady) {
      throw new Error(
        this.packagesError ?? `could not install ${PRELOAD_PACKAGES.join(', ')}`
      )
    }
  }

  private dispatch(
    id: number,
    message: Inbound
  ): Promise<SandboxResult> {
    const worker = this.worker
    if (worker === null) return Promise.reject(new Error('the sandbox thread is not running'))
    return new Promise<SandboxResult>((resolve) => {
      this.activeStep = { id, resolve }
      worker.postMessage(message)
    })
  }

  /** Builds the final result from the worker's verdict plus captured output. */
  private assemble(
    id: number,
    message: Extract<Outbound, { kind: 'done' }>
  ): SandboxResult {
    const finished = this.stepCollector?.finish() ?? { stdout: '', truncated: false }
    void id
    const error =
      message.error === null
        ? null
        : message.errorType === null || message.errorType.length === 0
          ? message.error
          : `${message.errorType}: ${message.error}`

    return {
      status: classify(message.error, this.stepStoppedByUser),
      stdout: finished.stdout,
      value: message.value,
      error,
      durationMs: message.durationMs,
      truncated: finished.truncated
    }
  }

  /**
   * The interrupt.
   *
   * One byte, written by this thread, read by CPython's signal machinery inside
   * the worker thread. No cross-thread call, no lock, nothing the sandbox can
   * observe as a capability it was handed.
   */
  private interrupt(): void {
    this.mailboxView.fill(SIGINT)
  }
}

// ---------------------------------------------------------------------------
// The sandbox thread
// ---------------------------------------------------------------------------

/**
 * Interpreter hardening, run once per interpreter, before any student code.
 *
 * Kept as a separate constant rather than inline in the worker string so the
 * exact Python that closes the escapes is reviewable in one place, and so it
 * can be read as Python rather than as a fragment of a JavaScript template
 * literal. Interpolated into the thread source below.
 *
 * WHY ANY OF THIS IS NEEDED
 * -------------------------
 * Pyodide is built for a browser, where the host has nothing to offer, so it
 * does not lock these down. This host is a full operating system, and all four
 * of these are real escapes. Each was demonstrated on Node 24.21 with pyodide
 * 0.29.5 before being closed, and each is re-checked by
 * `src/agent/dev/selfcheck.ts`:
 *
 *   1. NETWORK. The WASM build links SOCKFS, which Emscripten proxies to
 *      node:net under Node. `socket.gethostbyname('example.com')` returned a
 *      real address and `socket.create_connection(('example.com', 80))`
 *      connected. A module set to None in sys.modules raises ImportError on
 *      import, which also stops every stdlib client that reaches the network
 *      through it: http.client, urllib.request, ftplib, smtplib, asyncio,
 *      multiprocessing.
 *
 *   2. OS COMMANDS. Emscripten implements system() on top of the host shell:
 *      os.system('echo pwned > D:/tmp/escape.txt')
 *    created that file on the host filesystem. The rest of the exec/spawn
 *    family already fails with ENOSYS or ENOEXEC; system() is the exception.
 *
 *   3. NATIVE CODE. ctypes reaches libc directly, which is command execution by
 *    another route: ctypes.CDLL(None).system(b'echo pwned > ...') also created a
 *    host file. The `ctypes` module itself cannot be removed, because sympy
 *    imports `c_long` and `sizeof` from it at import time. What is removed is
 *    every route to a native library handle — CDLL, PyDLL, the platform
 *    loaders, `pythonapi` — so libc cannot be reached at all.
 *
 *   4. THE HOST `js` MODULE. With Pyodide's default, the `js` module *is* the
 *    worker's globalThis, so `from js import fetch` reached the host's network
 *    and `from js import require` reached the host's module system. Replacing
 *    the module with an empty one leaves `import js` working (nothing needs it)
 *    while every attribute lookup fails.
 *
 * Note what is deliberately *not* done: nothing is deleted from disk or from
 * memory. Only `sys.modules` entries and attributes of the `os`, `posix` and
 * `ctypes` module objects change.
 */
const HARDENING_PYTHON = [
  'import sys, os, posix, types',
  '',
  '# --- 4. The host `js` module -------------------------------------------',
  '# Replaced rather than emptied attribute-by-attribute: with Pyodide\'s',
  '# default this module *is* the worker thread\'s globalThis.',
  'sys.modules["js"] = types.ModuleType("js")',
  '',
  '# --- 1. Network --------------------------------------------------------',
  'for _ishkapon_name in (',
  '    "socket", "_socket", "ssl", "selectors",',
  '    "asyncio", "asyncore", "asynchat", "xmlrpc",',
  '):',
  '    sys.modules[_ishkapon_name] = None',
  '',
  '# --- 2. OS commands ----------------------------------------------------',
  'def _ishkapon_blocked(*_args, **_kwargs):',
  '    raise OSError(',
  '        5,',
  '        "ISHKAPON: operating-system commands and native libraries are not '
    + 'available in this sandbox",',
  '    )',
  'os.system = _ishkapon_blocked',
  'posix.system = _ishkapon_blocked',
  'if hasattr(os, "popen"):',
  '    os.popen = _ishkapon_blocked',
  '',
  '# --- 3. Native libraries -----------------------------------------------',
  '# ctypes itself stays importable: sympy does `from ctypes import c_long,',
  '# sizeof` at import time, and removing it breaks every symbolic calculation.',
  '# What goes is every way of obtaining a library handle.',
  'import ctypes',
  'ctypes.CDLL = _ishkapon_blocked',
  'ctypes.PyDLL = _ishkapon_blocked',
  'ctypes.WinDLL = _ishkapon_blocked',
  'if hasattr(ctypes, "cdll"):',
  '    ctypes.cdll.LoadLibrary = _ishkapon_blocked',
  'if hasattr(ctypes, "windll"):',
  '    ctypes.windll = _ishkapon_blocked',
  '    ctypes.windll.LoadLibrary = _ishkapon_blocked',
  'if hasattr(ctypes, "pydll"):',
  '    ctypes.pydll = _ishkapon_blocked',
  '    ctypes.pydll.LoadLibrary = _ishkapon_blocked',
  'if hasattr(ctypes, "pythonapi"):',
  '    ctypes.pythonapi = _ishkapon_blocked',
  'try:',
  '    import ctypes.util as _ishkapon_util',
  '    _ishkapon_util.find_library = lambda *_a, **_k: None',
  'except ImportError:',
  '    pass',
  'else:',
  '    del _ishkapon_util',
  '',
  'del _ishkapon_name, ctypes, types'
].join('\n')

/**
 * Source of the interpreter thread.
 *
 * Written as an inlined string rather than a separate module so the agent host
 * keeps exactly one rollup entry point — `electron.vite.config.ts` declares only
 * `index` and `agent`, and this file is not allowed to change it. The string is
 * the security boundary, so it is kept deliberately small: it loads Pyodide,
 * runs code, and reports results. Every policy decision (timeouts, the output
 * cap, error normalisation, the mailbox) lives in TypeScript on the host side,
 * where it can be read and tested.
 *
 * The thread receives its Pyodide module URL from the host rather than
 * resolving it itself, so there is exactly one place that knows where the
 * runtime lives.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { entry, indexURL, packageBaseUrl, packages, mailbox } = workerData

const view = new Uint8Array(mailbox)

/* Interpreter hardening, interpolated from HARDENING_PYTHON on the host side. */
const HARDENING = ${JSON.stringify(HARDENING_PYTHON)}

let pyodide = null

/**
 * Renders a runPython result for the host.
 *
 * 'pyproxyToStringRepr: true' makes PyProxy.toString() return Python's repr()
 * rather than str(), which is what ToolCall.resultValue is defined as and what
 * the model needs to read 'sqrt(2)' rather than '1.4142135623730951'.
 *
 * A PyProxy cannot be structured-cloned across the thread boundary, which is
 * why the rendering happens here rather than on the host.
 */
function render(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return String(raw)
  if (typeof raw === 'boolean') return raw ? 'True' : 'False'
  if (typeof raw === 'object' && raw[Symbol.toStringTag] === 'PyProxy') {
    try { return raw.toString() } catch { return null }
  }
  try { return JSON.stringify(raw) ?? null } catch { return null }
}

async function boot() {
  const startedAt = Date.now()
  const { loadPyodide } = await import(entry)
  pyodide = await loadPyodide({
    indexURL,
    // Local directory only. Pyodide derives its CDN URL from packageBaseUrl, so
    // a missing wheel is an ENOENT rather than a download: this is what makes
    // the sandbox offline, and there is no setting that changes it.
    packageBaseUrl,
    // No host environment leaks into the interpreter. This is what puts the
    // OpenRouter key out of reach of model-authored code.
    env: {},
    // '-q' suppresses the startup banner, which would otherwise land in the
    // first step's captured stdout.
    args: ['-q'],
    fullStdLib: false,
    pyproxyToStringRepr: true,
    // The 'js' module is replaced after boot rather than restricted here:
    // loadPackage itself needs JS intrinsics through it, so an empty
    // jsglobals breaks package installation. See HARDENING_PYTHON, step 4.
    stdout: () => {},
    stderr: () => {}
  })
  // Close the escapes that only exist because this host is an operating system
  // and not a browser. Must run before any model-authored code.
  pyodide.runPython(HARDENING)
  // Wire the mailbox before any student code can run.
  pyodide.setInterruptBuffer(new Uint8Array(mailbox))
  const version = String(pyodide.runPython('__import__("sys").version.split()[0]'))
  // Per-boot, not per-thread: a reset reuses the thread, and reporting the
  // thread's whole uptime as "boot time" would make a reset look like a 40 s
  // startup.
  return { version, bootMs: Date.now() - startedAt }
}

async function installPackages() {
  const started = Date.now()
  const problems = []
  await pyodide.loadPackage(packages, {
    messageCallback: () => {},
    // loadPackage resolves rather than rejects on failure, so this is the only
    // signal that a wheel did not install.
    errorCallback: (message) => { problems.push(message) }
  })
  const ms = Date.now() - started
  if (problems.length > 0) {
    const error = 'The scientific packages (' + packages.join(', ') +
      ') are not installed, so this step cannot run. Details: could not install ' +
      problems.length + ' package(s) from ' + packageBaseUrl + ': ' + problems.join('; ')
    parentPort.postMessage({ kind: 'packages', ready: false, error, ms })
    return false
  }
  parentPort.postMessage({ kind: 'packages', ready: true, error: null, ms })
  return true
}

function runStep(id, code) {
  view.fill(0)
  const started = Date.now()
  pyodide.setStdout({ batched: (chunk) => parentPort.postMessage({ kind: 'out', id, chunk }) })
  pyodide.setStderr({ batched: (chunk) => parentPort.postMessage({ kind: 'err', id, chunk }) })
  try {
    // A plain filename, not '<ishkapon-step>': Pyodide only registers the source
    // with linecache when the filename is not wrapped in angle brackets, and
    // that registration is what makes a traceback show the offending line. The
    // model needs to see which line failed, not just which exception.
    const value = pyodide.runPython(code, { filename: 'ishkapon_step.py' })
    parentPort.postMessage({
      kind: 'done', id, value: render(value), error: null, errorType: null,
      durationMs: Date.now() - started
    })
  } catch (error) {
    // PythonError carries the formatted Python traceback, including the
    // offending source line. That is the evidence the model needs to fix the
    // step, so it is returned as data rather than thrown.
    parentPort.postMessage({
      kind: 'done', id, value: null,
      error: error && error.message ? String(error.message) : String(error),
      errorType: error && typeof error.type === 'string' ? error.type : null,
      durationMs: Date.now() - started
    })
  } finally {
    // Drop the handlers so a late flush after the step cannot be attributed to
    // the next one.
    pyodide.setStdout({ batched: () => {} })
    pyodide.setStderr({ batched: () => {} })
  }
}

parentPort.on('message', async (message) => {
  try {
    if (message.kind === 'step') {
      if (message.needPackages && !(await installPackages())) {
        parentPort.postMessage({
          kind: 'done', id: message.id, value: null, error: 'missing-packages',
          errorType: 'SandboxUnavailable', durationMs: 0
        })
        return
      }
      runStep(message.id, message.code)
      return
    }
    if (message.kind === 'load-packages') {
      await installPackages()
      return
    }
    if (message.kind === 'reset') {
      // A fresh interpreter, not a scrubbed one: see PythonSandbox.reset. The
      // mailbox is re-bound to the same SharedArrayBuffer, so the host's
      // interrupt path keeps working across the reset.
      pyodide = null
      const booted = await boot()
      parentPort.postMessage({
        kind: 'ready', version: booted.version, packagesReady: false,
        packagesError: null, bootMs: booted.bootMs
      })
      await installPackages()
    }
  } catch (error) {
    parentPort.postMessage({
      kind: 'fatal',
      message: error && error.message ? String(error.message) : String(error)
    })
  }
})

boot()
  .then(async (booted) => {
    parentPort.postMessage({
      kind: 'ready', version: booted.version, packagesReady: false,
      packagesError: null, bootMs: booted.bootMs
    })
    // Preload eagerly. A 30-second first calculation reads to a student as a
    // broken app, and sympy is needed by nearly every problem in physics,
    // chemistry and mathematics.
    await installPackages()
  })
  .catch((error) => {
    parentPort.postMessage({
      kind: 'fatal',
      message: error && error.message ? String(error.message) : String(error)
    })
  })
`

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

interface FinishedOutput {
  readonly stdout: string
  readonly truncated: boolean
}

interface OutputCollector {
  readonly writeOut: (chunk: string) => void
  readonly writeErr: (chunk: string) => void
  finish: () => FinishedOutput
}

/**
 * Batched stdout/stderr capture with a hard byte cap.
 *
 * Once the cap is hit the buffers stop growing — an unbounded `print` loop would
 * otherwise be a memory-growth vector (§8) and would blow up the transcript.
 * Chunks are still streamed to the UI, but only up to the cap, so a runaway
 * `print` cannot flood the renderer either.
 */
function createOutputCollector(onOutput?: (chunk: string) => void): OutputCollector {
  let stdout = ''
  let stderr = ''
  let streamed = 0
  let truncated = false

  const writeOut = (chunk: string): void => {
    if (truncated) return
    const room = OUTPUT_LIMIT_BYTES - stdout.length
    const kept = chunk.length <= room ? chunk : chunk.slice(0, Math.max(0, room))
    stdout += kept
    if (kept.length < chunk.length) truncated = true

    if (onOutput !== undefined) {
      const streamRoom = OUTPUT_LIMIT_BYTES - streamed
      const toStream = kept.length <= streamRoom ? kept : kept.slice(0, Math.max(0, streamRoom))
      streamed += toStream.length
      if (toStream.length > 0) onOutput(toStream)
    }
  }

  const writeErr = (chunk: string): void => {
    if (truncated) return
    const room = OUTPUT_LIMIT_BYTES - stdout.length - stderr.length
    const kept = chunk.length <= room ? chunk : chunk.slice(0, Math.max(0, room))
    stderr += kept
    if (kept.length < chunk.length) truncated = true
  }

  return {
    writeOut,
    writeErr,
    finish: () => {
      if (truncated && !stdout.endsWith(TRUNCATION_MARKER)) stdout += TRUNCATION_MARKER
      const combined = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout
      return { stdout: combined, truncated }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turns the worker's error text into a status.
 *
 * A `KeyboardInterrupt` can only come from the mailbox, so it means the deadline
 * expired or the student pressed Stop. The two are told apart by the flag the
 * host sets when *it* was the one that asked for the interrupt — nothing inside
 * the sandbox can raise it, and nothing in the sandbox can clear it.
 */
function classify(error: string | null, stoppedByUser: boolean): SandboxStatus {
  if (error === null) return 'ok'
  if (!error.includes('KeyboardInterrupt')) return 'error'
  return stoppedByUser ? 'cancelled' : 'timeout'
}

function failure(message: string, started: number): SandboxResult {
  return {
    status: 'error',
    stdout: '',
    value: null,
    error: message,
    durationMs: Date.now() - started,
    truncated: false
  }
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 60_000
  return Math.min(Math.max(Math.floor(ms), 1_000), HARD_TIMEOUT_CEILING_MS)
}

/**
 * Normalises a thrown value into text a model can act on.
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return cleanTraceback(error.message)
  return cleanTraceback(String(error))
}

/**
 * Drops the emscripten frames Pyodide appends below every traceback. They are
 * noise for the model, and they would leak absolute host paths into a
 * transcript the student can read and copy.
 */
function cleanTraceback(message: string): string {
  const kept: string[] = []
  for (const line of message.split('\n')) {
    if (/^\s+at /.test(line)) continue
    if (line.includes('pyodide.asm.js')) continue
    if (line.startsWith('Traceback (most recent call last):') && kept.length === 0) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}
