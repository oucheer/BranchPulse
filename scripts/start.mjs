import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.resolve(here, '..', 'dist', 'server', 'index.cjs')

// Node caches the timezone at startup, so `TZ` must be in the environment
// before the process boots. Spawning a child with the correct `TZ` guarantees
// this regardless of how the host OS is configured.
const env = { ...process.env, TZ: process.env.TZ || 'Asia/Shanghai' }

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env,
  windowsHide: true
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 0
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
