import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Renderer build only.
 *
 * The backend (`src-node/`, `server/`) is a plain Node process bundled by
 * `scripts/build-server.mjs`, so it is no longer a Vite target.
 */
export default defineConfig({
  root: '.',
  // `build/` holds the generated brand icon; copying it as a static asset keeps
  // the browser tab icon identical to the former desktop window icon.
  publicDir: 'build',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared')
    }
  },
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html')
      }
    }
  }
})
