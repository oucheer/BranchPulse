import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Web smoke test.
 *
 * Boots the built backend against an isolated data directory on its own port,
 * drives a headless Chromium over CDP and walks every route. This replaces the
 * old Electron smoke pair (`run-smoke.ps1` + `smoke-cdp.mjs`): there is no
 * single-instance lock any more, but the isolated `BRANCHPULSE_USER_DATA_DIR`
 * guarantee still matters so a smoke run never touches the real profile.
 *
 * Usage: npm run build && npm run smoke
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.BRANCHPULSE_SMOKE_PORT ?? 4319)
const CDP_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
const SERVER_ENTRY = path.join(root, 'dist', 'server', 'index.cjs')
const RENDERER_ENTRY = path.join(root, 'dist', 'renderer', 'index.html')

const ROUTES = [
  ['/', '仪表盘'],
  ['/repositories', '仓库'],
  ['/branches', '分支'],
  ['/monitoring', '监控'],
  ['/naming-rules', '命名规则'],
  ['/whitelist', '白名单'],
  ['/notifications', '通知'],
  ['/reports', '报告'],
  ['/backup', '备份'],
  ['/scheduler', '定时'],
  ['/audit', '审计'],
  ['/animation', '动画'],
  ['/settings', '设置']
]

/** Terms that must never reach user-visible copy. */
const BANNED_TERMS = ['已合并', '过期', '到期', '陈旧']

const browserCandidates = [
  process.env.BRANCHPULSE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

function findBrowser() {
  for (const candidate of browserCandidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`No Chromium browser found. Set BRANCHPULSE_BROWSER to one of: ${browserCandidates.join(', ')}`)
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

async function waitForHealth() {
  return waitFor(async () => {
    const response = await fetch(`${BASE}/api/health`)
    if (!response.ok) return null
    return response.json()
  }, 'the backend health endpoint')
}

function launchServer(userDataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      BRANCHPULSE_PORT: String(PORT),
      BRANCHPULSE_HOST: '127.0.0.1',
      BRANCHPULSE_USER_DATA_DIR: userDataDir
    }
  })
  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))
  child.on('exit', (code) => log.push(`[server exited code=${code ?? 'null'}]`))
  return { child, log }
}

function launchBrowser(browser, profileDir) {
  return spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--window-size=1440,900',
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
}

async function connectCdp() {
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
    return list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl) ?? null
  }, 'the CDP page target')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let messageId = 0
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('CDP socket failed to open'))
  })

  function send(method, params = {}) {
    const id = ++messageId
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed')
    }
    return result.result.value
  }

  return { socket, send, evaluate }
}

async function main() {
  if (!fs.existsSync(SERVER_ENTRY) || !fs.existsSync(RENDERER_ENTRY)) {
    throw new Error('Build output missing. Run `npm run build` before the smoke test.')
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-smoke-'))
  const userDataDir = path.join(workDir, 'userdata')
  const profileDir = path.join(workDir, 'browser')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })

  const browser = findBrowser()
  const { child: server, log } = launchServer(userDataDir)
  let browserProcess = null
  const failures = []

  try {
    const health = await waitForHealth()
    console.log(`[smoke] backend ready on ${BASE} (data: ${health.dataDir})`)

    const indexResponse = await fetch(`${BASE}/`)
    const html = await indexResponse.text()
    const assetPath = /src="([^"]+\.js)"/.exec(html)?.[1]
    if (indexResponse.status !== 200 || !assetPath) {
      throw new Error(`Built renderer index.html is not served correctly (HTTP ${indexResponse.status}).`)
    }
    const assetResponse = await fetch(`${BASE}${assetPath}`)
    if (!assetResponse.ok) {
      throw new Error(`Renderer bundle ${assetPath} returned HTTP ${assetResponse.status}.`)
    }
    console.log(`[smoke] renderer bundle served: ${assetPath}`)

    const initResponse = await fetch(`${BASE}/api/rpc/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]'
    })
    const initBody = await initResponse.json()
    if (!initResponse.ok || initBody.error || !initBody.result?.settings) {
      throw new Error(`POST /api/rpc/init failed: ${JSON.stringify(initBody).slice(0, 200)}`)
    }
    console.log('[smoke] rpc bridge answered init')

    const unknownResponse = await fetch(`${BASE}/api/rpc/definitelyNotAMethod`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]'
    })
    if (unknownResponse.status !== 404) {
      failures.push(`Unknown RPC method returned HTTP ${unknownResponse.status} instead of 404.`)
    }

    browserProcess = launchBrowser(browser, profileDir)
    const { socket, send, evaluate } = await connectCdp()
    await send('Page.enable')
    await send('Runtime.enable')

    await send('Page.navigate', { url: `${BASE}/` })
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('h1')) || Boolean(document.querySelector('.text-danger'))`),
      'the app shell to render'
    )

    for (const [route, expected] of ROUTES) {
      await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const state = await evaluate(`(() => {
        const main = document.querySelector('main') ?? document.body
        return {
          hash: location.hash,
          heading: document.querySelector('h1')?.textContent?.trim() ?? null,
          text: (main.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 400),
          body: document.body.innerText ?? ''
        }
      })()`)
      const problems = []
      if (!state.heading) {
        problems.push('no <h1>')
      } else if (!state.heading.includes(expected)) {
        problems.push(`heading "${state.heading}" does not contain "${expected}"`)
      }
      // Empty-state pages legitimately render very little text, so this only
      // guards against a blank screen.
      if ((state.text ?? '').length < 5) problems.push('empty main content')
      if (/BranchPulse 后端不可用/.test(state.body)) problems.push('backend unavailable banner')
      for (const term of BANNED_TERMS) {
        if (state.text.includes(term)) problems.push(`banned term ${term}`)
      }
      if (route === '/monitoring' && (state.body.match(/发送邮件通知/g)?.length ?? 0) > 0) {
        problems.push('monitoring page exposes a standalone 发送邮件通知 switch')
      }
      if (problems.length > 0) {
        failures.push(`${route} (${expected}): ${problems.join('; ')}`)
        console.log(`[smoke] FAIL ${route} -> ${problems.join('; ')}`)
      } else {
        console.log(`[smoke] OK   ${route} -> ${state.heading}`)
      }
    }

    const events = await evaluate(`(async () => {
      const controller = new AbortController()
      const response = await fetch('/api/events', { signal: controller.signal })
      const reader = response.body.getReader()
      const chunk = await reader.read()
      controller.abort()
      return response.ok && new TextDecoder().decode(chunk.value).includes('connected')
    })()`)
    if (!events) failures.push('SSE stream /api/events did not deliver the initial frame.')

    socket.close()
  } finally {
    if (browserProcess) browserProcess.kill()
    server.kill()
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      // The browser may still hold a handle on its profile; a leftover temp
      // directory is not worth failing the smoke run over.
    }
  }

  if (failures.length > 0) {
    console.error('\n[smoke] failures:')
    for (const failure of failures) console.error(` - ${failure}`)
    console.error('\n[smoke] server log tail:')
    console.error(log.join('').slice(-2000))
    process.exit(1)
  }
  console.log('\n[smoke] all routes rendered with expected terminology.')
}

await main().catch((err) => {
  console.error(`[smoke] ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
