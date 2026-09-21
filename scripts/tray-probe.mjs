/**
 * Tray localization + quit probe (round 6 regression check).
 *
 * Two defects were reported together:
 *   1. the tray menu stayed English after the app was switched to Chinese;
 *   2. the tray Exit item could not close the app, because the window `close`
 *      handler called `event.preventDefault()` whenever the tray was enabled.
 *
 * The packaged build disables `EnableNodeCliInspectArguments`, so this runs
 * against the unfused dev runtime, which loads the same `out/main/index.js`.
 *
 * It attaches to the main-process inspector, wraps `Menu.buildFromTemplate` so
 * the *real* tray menu (with live click handlers) can be captured, drives the
 * language toggle through the renderer's own `saveSettings` IPC, and finally
 * invokes the Exit item's click handler the same way the tray would.
 *
 * Usage (start the app first):
 *   $env:GITMANAGER_USER_DATA_DIR=".tmp-gitmanager-tray6\userdata"
 *   node_modules\electron\dist\electron.exe . --inspect=9338 --remote-debugging-port=9339
 *   node scripts\tray-probe.mjs 9338 9339
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

// Capture every menu the app builds, with its live click handlers intact.
const hooked = await main.evaluate(`(() => {
  const require_ = process.getBuiltinModule('module').createRequire(process.execPath)
  const electron = require_('electron')
  globalThis.__bpProbe = { pid: process.pid, templates: [] }
  const original = electron.Menu.buildFromTemplate
  electron.Menu.buildFromTemplate = function (template) {
    const menu = original.call(this, template)
    globalThis.__bpProbe.templates.push({
      labels: template.filter((item) => item.label).map((item) => item.label),
      menu
    })
    if (globalThis.__bpProbe.templates.length > 20) globalThis.__bpProbe.templates.shift()
    return menu
  }
  return 'hooked'
})()`)
if (hooked !== 'hooked') throw new Error(`Failed to hook Menu.buildFromTemplate: ${hooked}`)

const probeLabels = () =>
  main.evaluate(
    'globalThis.__bpProbe.templates.length ? globalThis.__bpProbe.templates[globalThis.__bpProbe.templates.length - 1].labels : null'
  )

const saveLanguage = async (language) => {
  const saved = await renderer.evaluate(`(async () => {
    const current = await window.gitmanager.getSettings()
    const next = await window.gitmanager.saveSettings({ ...current, language: '${language}' })
    return next.language
  })()`)
  await sleep(1500)
  return saved
}

// Switch to English first so the Chinese assertions cannot pass by default.
const english = await saveLanguage('en')
const englishLabels = (await probeLabels()) ?? []
check('tray follows language=en', english === 'en' && englishLabels.includes('Exit'), JSON.stringify(englishLabels))

// The exact user-reported path: choose Chinese, the tray must stop being English.
const chinese = await saveLanguage('zh')
const chineseLabels = (await probeLabels()) ?? []
const expectedZh = ['打开仪表盘', '立即检查', '查看通知', '生成报告', '暂停监控', '恢复监控', '设置', '退出']
const missingZh = expectedZh.filter((label) => !chineseLabels.includes(label))
check('tray follows language=zh', chinese === 'zh' && missingZh.length === 0, JSON.stringify(chineseLabels))
const englishLeft = chineseLabels.filter((label) => /^[A-Za-z][A-Za-z ]*$/.test(label))
check('no English labels left in the Chinese tray', englishLeft.length === 0, JSON.stringify(englishLeft))

// With the tray enabled the window close button must hide, not quit.
const closeBehavior = await main.evaluate(`(() => {
  const require_ = process.getBuiltinModule('module').createRequire(process.execPath)
  const electron = require_('electron')
  const win = electron.BrowserWindow.getAllWindows()[0]
  if (!win) return 'no-window'
  win.show()
  win.close()
  return win.isDestroyed() ? 'destroyed' : 'hidden'
})()`)
check('close button hides the window while the tray is enabled', closeBehavior === 'hidden', closeBehavior)

// Finally, click the tray Exit item exactly like the tray does.
const pid = await main.evaluate('globalThis.__bpProbe.pid')
const exitClick = await main.evaluate(`(() => {
  const entries = globalThis.__bpProbe.templates
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index].menu.items.find((entry) => entry.label === '退出')
    if (item) {
      setTimeout(() => item.click(), 150)
      return 'clicked'
    }
  }
  return 'no-exit-item'
})()`)
check('Chinese tray exposes an Exit item', exitClick === 'clicked', exitClick)

// The main-process inspector keeps its own event loop alive, so detach before
// waiting; otherwise a healthy quit looks like a hang.
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
const elapsedMs = Date.now() - startedAt
check('tray Exit quits the app', !alive(), `pid ${pid}, took ${elapsedMs}ms`)

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nALL CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
