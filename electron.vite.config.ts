import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@domain': resolve('src/domain'),
        '@core': resolve('src/core'),
        '@data': resolve('src/data'),
        '@services': resolve('src/services'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/electron/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/electron/preload/index.ts') } }
    }
  },
  renderer: {
    // The dev server can only serve files under its root, so the root must
    // contain the renderer entry HTML and all UI source. Rolling up a
    // ../ui/main.tsx entry works in `build` but 404s in `dev`.
    root: resolve('src/ui'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@ui': resolve('src/ui'),
        '@shared': resolve('src/shared'),
        '@domain': resolve('src/domain'),
        '@core': resolve('src/core')
      }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/ui/index.html') } }
    }
  }
})
