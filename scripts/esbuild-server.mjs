import { build, context } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * esbuild settings shared by the dev runner and the production build.
 *
 * The backend is bundled to CommonJS on purpose: `src-node/utils/paths.ts`
 * probes `import.meta` and falls back to `__dirname`, and the sql.js wasm
 * lookup in `storage.ts` tries `__dirname` first. `sql.js` and `vite` stay
 * external — sql.js resolves its wasm asset from its own package directory,
 * and vite is only imported when the server runs in `--dev` mode.
 */
export const serverBuildOptions = {
  absWorkingDir: root,
  entryPoints: [path.join(root, 'server', 'index.ts')],
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  external: ['sql.js', 'vite'],
  alias: {
    '@shared': path.join(root, 'shared')
  },
  logOverride: {
    // Bundled as CJS, so the `import.meta` probe is empty and the `__dirname`
    // fallback takes over. That is expected, not a problem to report.
    'empty-import-meta': 'silent'
  }
}

export const SERVER_OUTFILE = path.join(root, 'dist', 'server', 'index.cjs')

export async function bundleServer(outfile = SERVER_OUTFILE) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await build({ ...serverBuildOptions, outfile })
  return outfile
}

/** `esbuild` watch context used by the dev runner to restart on backend edits. */
export async function watchServer(outfile, onRebuild) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  const ctx = await context({
    ...serverBuildOptions,
    outfile,
    plugins: [
      {
        name: 'gitmanager-restart',
        setup(buildApi) {
          buildApi.onEnd((result) => {
            if (result.errors.length === 0) onRebuild()
          })
        }
      }
    ]
  })
  await ctx.watch()
  return ctx
}

/** Keeps a wasm copy beside the bundle for deployments without `node_modules`. */
export function copySqlWasm(outfile = SERVER_OUTFILE) {
  try {
    const require = createRequire(path.join(root, 'package.json'))
    const wasm = require.resolve('sql.js/dist/sql-wasm.wasm')
    fs.copyFileSync(wasm, path.join(path.dirname(outfile), 'sql-wasm.wasm'))
  } catch {
    // The bundle resolves the wasm from `node_modules` at runtime; this copy is
    // only a fallback, so failing to place it is not fatal.
  }
}
