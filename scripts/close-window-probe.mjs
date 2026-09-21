/**
 * Close-window behaviour probe (round 6 regression check).
 *
 * Two settings interact with window closing:
 *   - trayEnabled = true  -> closing the window hides it and the app keeps
 *                            running in the tray (tray Exit must still quit);
 *   - trayEnabled = false -> closing the window must actually end the process.
 *
 * This probe covers the second case: turn the tray off through the same IPC the
 * Settings page uses, close the window the way the title bar does, and assert
 * the process really exits.
 *
 * Usage (start the unfused dev runtime with the inspector enabled first, see
 * scripts/run-tray-probe.ps1):
 *   node scripts/close-window-probe.mjs 9338 9339
 */
const mainPort = process.argv[2] || '9338'
const rendererPort = process.argv[3] || '9339'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(port, type, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
      const target = targets.find((t) => t.type === type)
      if (target) {
        const socket = new WebSocket(target.webSocketDebuggerUrl)
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
        return { socket, send, evaluate }
      }
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`No ${type} debugger target on port ${port}: ${lastError?.message ?? 'timeout'}`)
}

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` -> ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const main = await connect(mainPort, 'node')
await main.send('Runtime.enable')
const renderer = await connect(rendererPort, 'page')

const pid = await main.evaluate('process.pid')

// Mirror the Settings page's own save path for the tray toggle.
const saved = await renderer.evaluate(`(async () => {
  const current = await window.gitmanager.getSettings()
  const next = await window.gitmanager.saveSettings({ ...current, trayEnabled: false })
  return next.trayEnabled
})()`)
check('turning the tray off is persisted', saved === false, String(saved))
await sleep(800)

// `win.close()` is asynchronous: it runs the close event and destroys the window
// on the next tick, so poll instead of asserting `isDestroyed()` immediately.
const closeRequest = await main.evaluate(`(() => {
  const require_ = process.getBuiltinModule('module').createRequire(process.execPath)
  const electron = require_('electron')
  const win = electron.BrowserWindow.getAllWindows()[0]
  if (!win) return 'no-window'
  win.show()
  win.close()
  return 'requested'
})()`)
check('a window was available to close', closeRequest === 'requested', closeRequest)

let windowClosed = false
const closeDeadline = Date.now() + 8_000
while (Date.now() < closeDeadline) {
  await sleep(200)
  try {
    const state = await main.evaluate(`(() => {
      const require_ = process.getBuiltinModule('module').createRequire(process.execPath)
      const electron = require_('electron')
      const win = electron.BrowserWindow.getAllWindows()[0]
      return win ? (win.isDestroyed() ? 'closed' : 'open') : 'closed'
    })()`)
    if (state === 'closed') {
      windowClosed = true
      break
    }
  } catch {
    // The process is going away, which also means the window is gone.
    windowClosed = true
    break
  }
}
check('with the tray off, closing the window actually closes it', windowClosed, String(windowClosed))

// Detach before waiting: an open inspector socket keeps the event loop alive.
try {
  await main.send('Runtime.disable')
} catch {}
try {
  main.socket.close()
} catch {}
try {
  renderer.socket.close()
} catch {}

const alive = () => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const startedAt = Date.now()
const deadline = startedAt + 20_000
while (Date.now() < deadline && alive()) await sleep(200)
check('with the tray off, the app exits after the last window closes', !alive(), `pid ${pid}, took ${Date.now() - startedAt}ms`)

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nALL CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
