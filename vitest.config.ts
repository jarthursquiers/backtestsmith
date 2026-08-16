import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@domain': resolve('src/domain'),
      '@core': resolve('src/core'),
      '@data': resolve('src/data'),
      '@services': resolve('src/services'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false
  }
})
