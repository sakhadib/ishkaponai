import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

/** MathJax's own version, for the `PACKAGE_VERSION` define below. */
const MATHJAX_VERSION: string = createRequire(import.meta.url)('mathjax-full/package.json').version

/**
 * Emits `src/bootstrap.cjs` to `out/bootstrap.cjs`.
 *
 * This is not optional. `package.json` points `main` at the bootstrap, because
 * `app.requestSingleInstanceLock()` and `app.setAppUserModelId()` must run
 * before `ready` and ESM modules load too late to guarantee that. But
 * electron-vite only compiles the TypeScript entries, so without this plugin the
 * built `out/` has no `bootstrap.cjs` and Electron dies at startup with
 * "Cannot find .cjs file".
 *
 * Runs in dev as well as build, since `electron-vite dev` also launches Electron
 * against the same `out/` entry.
 */
function emitBootstrap(): Plugin {
  return {
    name: 'ishkapon:emit-bootstrap',
    buildStart() {
      const target = resolve('out/bootstrap.cjs')
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolve('src/bootstrap.cjs'), target)
    }
  }
}

/**
 * Two output module systems are in play, and that is forced rather than chosen:
 *
 * - `ai` (AI SDK 7) is ESM-only, so the main process and the agent host must be
 *   ESM. `package.json` sets `"type": "module"`, so `.js` is ESM.
 * - Sandboxed preload scripts cannot use ESM imports at all, so the preload is
 *   emitted as CommonJS with an explicit `.cjs` extension, which Node treats as
 *   CJS regardless of the `type` field.
 *
 * The main entry is a tiny CJS bootstrap (`src/bootstrap.cjs`) because ESM
 * modules load asynchronously, and `app.requestSingleInstanceLock()` and
 * `app.setAppUserModelId()` must run before the `ready` event.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), emitBootstrap()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      outDir: 'out/main',
      minify: false,
      rollupOptions: {
        // Two entries in one build: the main process and the agent host.
        // Shared code is split into `chunks/` and imported by both.
        input: {
          index: resolve('src/main/index.ts'),
          agent: resolve('src/agent/index.ts')
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      outDir: 'out/preload',
      minify: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
          extend: true
        }
      }
    }
  },

  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    define: {
      // KaTeX and Mermaid both branch on this to pick browser vs server paths.
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),

      /**
       * MathJax's version probe, and it is load-bearing rather than cosmetic.
       *
       * `mathjax-full/js/components/version.js` reads its own version like this:
       *
       *   export const VERSION = typeof PACKAGE_VERSION === 'undefined'
       *     ? (() => { const load = eval('require'); ... })()
       *     : PACKAGE_VERSION
       *
       * The `eval` branch is a Node path, it is **not** wrapped in try/catch, and
       * Rollup does not replace `PACKAGE_VERSION` on its own. Left undefined, the
       * minified comparison `typeof PACKAGE_VERSION > "u"` evaluates true, the
       * bundle calls `eval`, and the app's CSP — `script-src 'self'`, no
       * `unsafe-eval` (§12.2) — throws `EvalError` during module evaluation. That
       * takes down the whole renderer chunk, not just the equations.
       *
       * Defining the identifier makes Rollup fold the comparison to false, take
       * the literal branch, and drop the `eval` as dead code. Verified absent
       * from the built bundle afterwards.
       *
       * The identifier is MathJax's, and nothing else in the tree uses it.
       */
      PACKAGE_VERSION: JSON.stringify(MATHJAX_VERSION)
    },
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      // electron-vite leaves the renderer unminified by default; opt in so
      // packaged builds ship a minified bundle.
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    server: {
      port: 5173,
      strictPort: true
    }
  }
})
