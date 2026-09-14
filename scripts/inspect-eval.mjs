/**
 * Tiny helper: evaluate an expression in the Electron main process through the
 * `--inspect` port, then print the result. Useful for probing runtime state that
 * is not reachable from the renderer (tray menu, app lifecycle, fuses, settings).
 *
 * Usage:
 *   node scripts/inspect-eval.mjs "<js expression>" [port]
 */
const expression = process.argv[2]
const port = process.argv[3] || '9337'
if (!expression) throw new Error('Usage: node scripts/inspect-eval.mjs "<expression>" [port]')

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const node = targets.find((t) => t.type === 'node')
if (!node) throw new Error(`No main-process inspector target on port ${port}`)

const ws = new WebSocket(node.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

const id = 1
const result = await new Promise((resolve, reject) => {
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== id) return
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  })
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})

console.log(JSON.stringify(result, null, 2))
ws.close()
