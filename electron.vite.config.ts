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
    root: resolve('src/renderer'),
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
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
