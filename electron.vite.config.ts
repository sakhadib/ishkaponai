import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
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
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
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
