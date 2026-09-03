import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared/', import.meta.url))
    }
  }
})
