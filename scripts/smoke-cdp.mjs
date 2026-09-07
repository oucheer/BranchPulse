const targetUrl = process.env.CDP_TARGET || 'http://127.0.0.1:9222/json/list'
const pages = ['/', '/repositories', '/branches', '/monitoring', '/notifications', '/reports', '/scheduler', '/audit', '/settings']

const targets = await fetch(targetUrl).then((r) => r.json())
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

for (const path of pages) {
  await evaluate(`location.hash = '${path}'`)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const value = await evaluate(`(() => ({
    path: location.hash,
    title: document.title,
    heading: document.querySelector('h1')?.textContent?.trim() || null,
    text: document.body.innerText.slice(0, 700),
    errors: [...document.querySelectorAll('[class*=danger], [class*=error]')].map((el) => el.textContent.trim()).filter(Boolean).slice(0, 5)
  }))()`)
  console.log(JSON.stringify(value, null, 2))
}

ws.close()
