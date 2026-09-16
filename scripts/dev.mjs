import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleServer, SERVER_OUTFILE, watchServer } from './esbuild-server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Single-command dev runner.
 *
 * The backend is bundled by esbuild and executed as a plain Node process; in
 * `--dev` mode that process embeds the Vite dev server in middleware mode, so
 * the renderer, the RPC endpoints and the SSE stream all share one origin.
 * Renderer edits are handled by Vite HMR; backend edits rebuild the bundle and
 * restart the process.
 */
let child = null
let restarting = false

function start() {
  child = spawn(process.execPath, [SERVER_OUTFILE, '--dev'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  })
  child.on('exit', (code, signal) => {
    if (restarting) return
    console.log(`[dev] backend exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
    process.exit(code ?? 0)
  })
}

async function restart() {
  restarting = true
  const previous = child
  if (previous && previous.exitCode === null) {
    await new Promise((resolve) => {
      previous.once('exit', resolve)
      previous.kill()
    })
  }
  restarting = false
  console.log('[dev] backend rebuilt, restarting')
  start()
}

await bundleServer()
start()

const watcher = await watchServer(SERVER_OUTFILE, () => {
  void restart()
})

function shutdown() {
  void watcher.dispose()
  if (child && child.exitCode === null) child.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
