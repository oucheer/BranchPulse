/**
 * Version display probe.
 *
 * The sidebar footer used to hardcode `GitManager v0.1.1`, so the displayed
 * version never followed `package.json` and the shipped exe. This probe checks
 * that the running build reports the real version through IPC and renders it.
 *
 * Usage (start a build with --remote-debugging-port=9222 first):
 *   node scripts/version-probe.mjs [expected-version]
 */
const targetUrl = process.env.CDP_TARGET || 'http://127.0.0.1:9222/json/list'
const expected = process.argv[2] || null

const targets = await fetch(targetUrl).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('No renderer page found')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const handlers = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) handlers.reject(new Error(JSON.stringify(message.error)))
  else handlers.resolve(message.result)
})

const send = (method, params = {}) => {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Runtime.evaluate failed')
  }
  return result.result.value
}

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` -> ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

await evaluate("location.hash = '/'")
await new Promise((resolve) => setTimeout(resolve, 900))

const ipcVersion = await evaluate('window.gitmanager.getAppVersion()')
check('the main process reports a non-empty version', typeof ipcVersion === 'string' && ipcVersion.length > 0, ipcVersion)

if (expected) {
  check(`the reported version equals ${expected}`, ipcVersion === expected, ipcVersion)
}

const footer = await evaluate("document.querySelector('aside .border-t')?.innerText ?? null")
check('the sidebar footer renders the reported version', Boolean(footer && footer.includes(`v${ipcVersion}`)), JSON.stringify(footer))

const stale = await evaluate("document.body.innerText.includes('v0.1.1')")
check('the stale hardcoded v0.1.1 is gone', stale === false, String(stale))

socket.close()
console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nALL CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
