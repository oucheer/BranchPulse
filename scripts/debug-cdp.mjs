const cdpUrl = process.env.CDP_TARGET || 'http://127.0.0.1:9224/json/list'
const targets = await fetch(cdpUrl).then(r => r.json())
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const logs = []

ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
  if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
    logs.push(message.params)
  }
}

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

function send(method, params = {}) {
  return new Promise(resolve => {
    const messageId = ++id
    ws.send(JSON.stringify({ id: messageId, method, params }))
    pending.set(messageId, resolve)
  })
}

await send('Runtime.enable')
const result = await send('Runtime.evaluate', {
  expression: `(() => ({
    hash: location.hash,
    h1: document.querySelector('h1')?.textContent.trim(),
    headings: [...document.querySelectorAll('h1')].map(e => e.textContent.trim()),
    mainHtml: document.querySelector('main')?.outerHTML.slice(0, 3000)
  }))()`,
  returnByValue: true
})

console.log(JSON.stringify({ state: result.result?.result?.value, logs }, null, 2))
ws.close()
