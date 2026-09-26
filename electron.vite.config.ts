import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

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
    plugins: [externalizeDepsPlugin()],
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
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production')
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
