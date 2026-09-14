/**
 * Language-switch regression check (round 6).
 *
 * Reported bug: after choosing Chinese in settings, pages that never read the
 * language state kept rendering English, and the tray menu stayed English too.
 *
 * This drives the *packaged* build through the real Settings UI: click the
 * language card, click `保存`, then walk every route. It deliberately does not
 * call the settings IPC directly, because the app store also has to react and a
 * direct IPC write would skip that path entirely.
 *
 * Usage (start a build with --remote-debugging-port=9222 first):
 *   node scripts/smoke-language.mjs
 */
const targetUrl = process.env.CDP_TARGET || 'http://127.0.0.1:9222/json/list'

const routes = [
  ['/', '仪表盘'],
  ['/repositories', '仓库'],
  ['/branches', '分支'],
  ['/monitoring', '监控'],
  ['/notifications', '通知'],
  ['/reports', '报告'],
  ['/scheduler', '定时调度'],
  ['/audit', '审计日志'],
  ['/settings', '设置']
]

const targets = await fetch(targetUrl).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('No renderer page found')

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const handlers = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) handlers.reject(new Error(message.error.message))
  else handlers.resolve(message.result)
})

await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  if (!ok) failures.push(name)
}

// Read the sidebar labels only, so the assertion is about navigation text and
// not about a specific page's content.
const navText = () =>
  evaluate(`(() => {
    const nav = document.querySelector('nav') || document.querySelector('aside') || document.body
    return nav.innerText
  })()`)

const visit = async (route) => {
  await evaluate(`(async () => {
    location.hash = '#${route}'
    await new Promise((resolve) => setTimeout(resolve, 400))
    return location.hash
  })()`)
  await sleep(750)
  return evaluate('document.body.innerText')
}

const clickByText = (text) =>
  evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((item) => item.textContent.trim() === ${JSON.stringify(text)})
    if (!button) return 'not-found'
    button.click()
    return 'clicked'
  })()`)

// Click through the real Settings UI, exactly like a user would.
const setLanguage = async (language) => {
  await visit('/settings')
  const picked = await clickByText(language === 'zh' ? '中文' : 'English')
  if (picked !== 'clicked') throw new Error(`language button (${language}): ${picked}`)
  await sleep(400)
  // The save button label follows the language currently rendered.
  const saveLabel = (await evaluate('window.branchpulse.getSettings().then((s) => s.language)')) === 'zh' ? '保存' : 'Save'
  const saved = await clickByText(saveLabel)
  if (saved !== 'clicked') throw new Error(`save button: ${saved}`)
  await sleep(1600)
  return evaluate('window.branchpulse.getSettings().then((s) => s.language)')
}

const ENGLISH_NAV = ['Dashboard', 'Repositories', 'Branches', 'Monitoring', 'Notifications', 'Reports', 'Scheduler', 'Audit', 'Settings']
const CHINESE_NAV = ['仪表盘', '仓库', '分支', '监控', '通知', '报告', '定时调度', '审计日志', '设置']

const enApplied = await setLanguage('en')
check('choosing English through the UI is applied', enApplied === 'en', String(enApplied))
const enNav = await navText()
const enMissing = ENGLISH_NAV.filter((word) => !enNav.includes(word))
check('English mode renders the English navigation', enMissing.length === 0, `missing ${JSON.stringify(enMissing)}`)

const zhApplied = await setLanguage('zh')
check('choosing Chinese through the UI is applied', zhApplied === 'zh', String(zhApplied))
const zhNav = await navText()
const zhMissing = CHINESE_NAV.filter((word) => !zhNav.includes(word))
const zhLeftovers = ENGLISH_NAV.filter((word) => zhNav.includes(word))
check('Chinese mode renders the Chinese navigation', zhMissing.length === 0, `missing ${JSON.stringify(zhMissing)}`)
check('no English navigation text survives the switch', zhLeftovers.length === 0, JSON.stringify(zhLeftovers))

// Walk every route in Chinese and make sure no page falls back to English.
const staleRoutes = []
for (const [route, heading] of routes) {
  const text = await visit(route)
  const leftovers = ENGLISH_NAV.filter((word) => text.includes(word))
  if (leftovers.length) staleRoutes.push(`${route}: ${leftovers.join(',')}`)
  if (!text.includes(heading)) staleRoutes.push(`${route}: missing heading ${heading}`)
}
check('every route stays Chinese after the switch', staleRoutes.length === 0, JSON.stringify(staleRoutes))

const persisted = await evaluate('window.branchpulse.getSettings().then((s) => s.language)')
check('language choice is persisted', persisted === 'zh', String(persisted))

try {
  socket.close()
} catch {}

console.log(failures.length ? `\nFAILED: ${failures.join(' | ')}` : '\nALL CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
