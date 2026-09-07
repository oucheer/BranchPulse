const cdpUrl = process.env.CDP_TARGET || 'http://127.0.0.1:9223/json/list'
const targets = await fetch(cdpUrl).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('No renderer page found')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let messageId = 0
const pending = new Map()

ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
}

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

function send(method, params = {}) {
  const id = ++messageId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed')
  }
  return result.result.value
}

async function clickText(text) {
  return evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const all = [...document.querySelectorAll('button, a')]
    const el = all.find(x => x.innerText.trim() === wanted)
      || all.find(x => x.innerText.trim().includes(wanted))
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function clickLabel(text) {
  return evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const label = [...document.querySelectorAll('.label')]
      .find(el => el.textContent.trim() === wanted)
    if (!label) return false
    const control = label.parentElement.querySelector('input, select, textarea')
    if (!control) return false
    control.click()
    control.focus()
    return true
  })()`)
}

async function setNumber(index, value) {
  return evaluate(`(() => {
    const input = [...document.querySelectorAll('input[type=number]')][${index}]
    if (!input) throw new Error('Number input not found: ${index}')
    input.focus()
    if (!(input instanceof HTMLInputElement)) throw new Error('No focused input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
}

async function selectByIndex(index, value) {
  return evaluate(`(() => {
    const select = [...document.querySelectorAll('select')][${index}]
    if (!select) throw new Error('Select not found: ${index}')
    select.focus()
    if (!(select instanceof HTMLSelectElement)) throw new Error('No focused select')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, ${JSON.stringify(value)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return [...select.options].map(o => o.value)
  })()`)
}

async function toggleSetting(text) {
  return evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const row = [...document.querySelectorAll('div')].find(el => el.innerText.trim() === wanted)
      || [...document.querySelectorAll('div')].find(el => el.innerText.trim().includes(wanted))
    if (!row) return false
    const button = row.parentElement.querySelector('button')
    if (!button) return false
    button.click()
    return true
  })()`)
}

async function waitFor(predicateSource, label, timeout = 6000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeout) {
    last = await evaluate(`(${predicateSource})()`)
    if (last) return last
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Timeout waiting for ' + label + ': ' + JSON.stringify(last))
}

async function realClick(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!box) throw new Error('Click target not found: ' + selector)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

const pageHeadings = {
  '/': ['仪表盘', 'Dashboard'],
  '/repositories': ['仓库', 'Repositories'],
  '/branches': ['分支', 'Branches'],
  '/monitoring': ['监控', 'Monitoring'],
  '/notifications': ['通知', 'Notifications'],
  '/reports': ['报告', 'Reports'],
  '/scheduler': ['定时调度', 'Scheduler'],
  '/audit': ['审计日志', 'Audit Log'],
  '/settings': ['设置', 'Settings']
}

function headingPredicate(hash) {
  return `() => (${JSON.stringify(hash === '/' ? ['#/', ''] : ['#' + hash])}.includes(location.hash))
    && ${JSON.stringify(pageHeadings[hash])}.some(expected => (document.querySelector('h1')?.textContent.trim() || '').startsWith(expected))`
}

const pages = ['/', '/repositories', '/branches', '/monitoring', '/notifications', '/reports', '/scheduler', '/audit', '/settings']

const navigation = []
for (const hash of pages) {
  if (hash === '/') {
    await evaluate(`(() => {
      location.hash = '#/'
      return location.hash
    })()`)
  } else {
    await realClick(`button[data-nav="${hash}"]`)
  }
  await waitFor(headingPredicate(hash), hash)
  const state = await evaluate(`(() => ({
    hash: location.hash,
    heading: document.querySelector('h1')?.textContent.trim() || '',
    text: document.body.innerText.slice(0, 300),
    hasError: Boolean([...document.querySelectorAll('[class*="danger"], [class*="error"]')]
      .find(el => /failed|失败|error/i.test(el.textContent || '')))
  }))()`)
  navigation.push({ label: hash, ...state })
}

async function navigate(hash) {
  await realClick(`button[data-nav="${hash}"]`)
  await waitFor(headingPredicate(hash), hash)
  await new Promise(resolve => setTimeout(resolve, 500))
}

await navigate('/monitoring')
await waitFor('() => location.hash === "#/monitoring"', 'monitoring')
await waitFor('() => document.body.innerText.includes("未提交阈值") && document.querySelectorAll("select").length >= 2', 'monitoring form')
const monitoringBefore = await evaluate(`(() => ({
  activeRepositoryId: localStorage.getItem('branchpulse:activeRepositoryId'),
  text: document.body.innerText.slice(0, 800),
  thresholdOptions: [...document.querySelectorAll('.label')].find(el => el.textContent.includes('未提交阈值'))?.parentElement.querySelectorAll('select option').length || 0,
  unitOptions: [...document.querySelectorAll('.label')].find(el => el.textContent.includes('单位'))?.parentElement.querySelectorAll('select option').length || 0
}))()`)
const unitOptions = await selectByIndex(1, 'minutes')
await setNumber(0, 77)
await clickText('保存设置并生效')
await waitFor('() => Boolean([...document.querySelectorAll("[class*=success], [class*=ok], .toast")].length)', 'save toast')
await navigate('/repositories')
await new Promise(resolve => setTimeout(resolve, 700))
await navigate('/monitoring')
await new Promise(resolve => setTimeout(resolve, 700))
const monitoringAfter = await evaluate(`(() => ({
  body: document.body.innerText,
  inputs: [...document.querySelectorAll('input[type=number]')].map(i => i.value),
  selects: [...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.value))
}))()`)

await navigate('/scheduler')
await waitFor('() => location.hash === "#/scheduler"', 'scheduler')
await new Promise(resolve => setTimeout(resolve, 300))
const scheduler = await evaluate(`(() => ({
  text: document.body.innerText.slice(0, 800),
  intervalInput: [...document.querySelectorAll('input[type=number]')].map(i => ({ value: i.value, min: i.min }))
}))()`)

const schedulerCreate = await evaluate(`(() => {
  const button = document.querySelector('.btn-primary svg.lucide-plus')?.closest('button')
  if (!button) return { clicked: false, buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean) }
  button.click()
  return { clicked: true }
})()`)
await new Promise(resolve => setTimeout(resolve, 400))
const schedulerForm = await evaluate(`(() => ({
  intervalInput: [...document.querySelectorAll('input[type=number]')].map(i => ({ value: i.value, min: i.min })),
  selects: [...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.value)),
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)
}))()`)
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(el => /取消|Cancel/i.test(el.innerText.trim()))
  button?.click()
  return Boolean(button)
})()`)
await new Promise(resolve => setTimeout(resolve, 300))

await navigate('/audit')
await waitFor('() => location.hash === "#/audit"', 'audit')
await new Promise(resolve => setTimeout(resolve, 300))
const audit = await evaluate(`(() => ({
  text: document.body.innerText.slice(0, 1200),
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)
}))()`)

await navigate('/settings')
await waitFor('() => location.hash === "#/settings"', 'settings')
await new Promise(resolve => setTimeout(resolve, 300))
const emailBefore = await evaluate(`(() => {
  const label = [...document.querySelectorAll('div')]
    .find(el => el.children.length === 0 && el.textContent.trim() === '启用邮件通知')
  const row = label?.closest('.flex') || label?.parentElement?.parentElement
  const toggle = row?.querySelector('button')
  const wasChecked = toggle?.getAttribute('aria-checked') === 'true'
  if (toggle && !wasChecked) toggle.click()
  return { rowFound: Boolean(row), clicked: Boolean(toggle && !wasChecked), wasChecked, text: row?.innerText.slice(0, 100) || '' }
})()`)
if (!(await clickText('Save email config'))) {
  await clickText('保存邮件配置')
}
await waitFor('() => [...document.querySelectorAll("[class*=success], [class*=ok], .toast")].some(el => /OK|成功|Saved/.test(el.innerText))', 'email save toast', 10000)
await new Promise(resolve => setTimeout(resolve, 500))
await navigate('/notifications')
await waitFor('() => location.hash === "#/notifications"', 'notifications for reload')
await new Promise(resolve => setTimeout(resolve, 500))
await navigate('/settings')
await waitFor('() => location.hash === "#/settings"', 'settings for reload')
await new Promise(resolve => setTimeout(resolve, 500))
const emailAfter = await evaluate(`(() => ({
  body: document.body.innerText,
  enabledBadge: [...document.querySelectorAll('[class*=badge], span')].map(el => el.innerText.trim())
    .find(text => text === '已启用' || text === '未启用')
}))()`)

console.log(JSON.stringify({
  navigation,
  monitoringBefore,
  monitoringAfter,
  scheduler,
  schedulerCreate,
  schedulerForm,
  audit,
  emailBefore,
  emailAfter
}, null, 2))

ws.close()
