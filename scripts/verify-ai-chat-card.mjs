import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { chromium } = await import(process.env.GITMANAGER_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.GITMANAGER_PLAYWRIGHT_MODULE).href : 'playwright')
const root = process.cwd()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-ai-'))
process.env.GITMANAGER_USER_DATA_DIR = path.join(temp, 'profile')
process.env.GITMANAGER_AI_ALLOW_PRIVATE_NETWORK = '1'
process.env.GITMANAGER_ENCRYPTION_KEY = 'ab'.repeat(32)
let browser
let child
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const model = http.createServer(async (req, res) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { body += chunk })
  await new Promise((resolve) => req.on('end', resolve))
  const wantsStream = /"stream"\s*:\s*true/.test(body)
  if (!wantsStream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  for (let index = 0; index < 18; index++) {
    const payload = { choices: [{ delta: { content: `长回复片段 ${index + 1}。包含用户、合并请求、仓库贡献与代码变化统计，用于验证日志滚动与自动吸底。` } }] }
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    await pause(60)
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

try {
  const runtimeEntry = path.join(root, 'server', 'services.ts')
  const seedBundle = path.join(temp, 'seed.cjs')
  await build({ entryPoints: [runtimeEntry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', outfile: seedBundle })
  process.env.GITMANAGER_USER_DATA_DIR = path.join(temp, 'profile')
  process.env.NODE_PATH = path.join(root, 'node_modules')
  require('node:module').Module._initPaths()
  const runtime = await require(seedBundle).bootstrap()
  await runtime.services.users.loginUser('one@example.com', { userId: 101, username: 'one', email: 'one@example.com', displayName: 'one', source: 'gitlab' }, 'seed-token')
  const sessions = runtime.services.storage.all('SELECT token, email FROM user_sessions')
  runtime.shutdown()
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`
  const port = Number(process.env.GITMANAGER_VERIFY_PORT ?? 4341)
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server/index.cjs'], { cwd: root, env: { ...process.env, GITMANAGER_PORT: String(port), GITMANAGER_HOST: '127.0.0.1' }, windowsHide: true, stdio: 'ignore' })
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
    if (i > 120) throw new Error('Server failed to start')
    await pause(250)
  }
  browser = await chromium.launch({ executablePath: process.env.GITMANAGER_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const context = await browser.newContext()
  await context.addInitScript((token) => sessionStorage.setItem('gitmanager:session-token', token), sessions[0].token)
  const page = await context.newPage()
  await page.goto(`${base}/#/my-ai`, { waitUntil: 'domcontentloaded' })
  await page.locator('main').waitFor()
  await page.waitForTimeout(600)

  const rpc = (method, args = []) => page.evaluate(async ({ method, args }) => {
    const response = await fetch(`/api/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('gitmanager:session-token')}` }, body: JSON.stringify(args) })
    return { status: response.status, body: await response.json() }
  }, { method, args })
  const saved = await rpc('savePersonalAiConfig', [{ baseUrl: modelUrl, model: 'internal', apiKey: 'secret-test' }])
  console.log('[ai-save]', saved)
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const connection = await rpc('testPersonalAiConnection')
  console.log('[ai-connection]', connection)
  assert.equal(connection.status, 200, JSON.stringify(connection.body))
  assert.equal(connection.body.result?.ok, true, JSON.stringify(connection.body))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('继续追问个人研发数据').waitFor()

  const metrics = () => page.evaluate(() => {
    const scroller = document.querySelector('main .overflow-y-auto')
    const card = scroller.parentElement
    const cardBox = card.getBoundingClientRect()
    const lastMessage = scroller.lastElementChild?.lastElementChild
    const lastBox = lastMessage?.getBoundingClientRect()
    return {
      cardHeight: cardBox.height,
      scrollerTop: scroller.getBoundingClientRect().top,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      atBottom: Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 4,
      lastBottom: lastBox?.bottom ?? null
    }
  })

  const input = page.getByPlaceholder('继续追问个人研发数据')
  const cardHeights = []
  const scrolled = []
  for (let i = 0; i < 4; i++) {
    await input.fill(`问题 ${i + 1}`)
    await input.press('Enter')
    // Wait for the assistant answer to finish before sending the next turn.
    await page.getByText(`问题 ${i + 1}`, { exact: true }).first().waitFor()
    await page.waitForTimeout(1500 + 18 * 70)
    const after = await metrics()
    cardHeights.push(after.cardHeight)
    scrolled.push(after.atBottom)
  }
  const final = await metrics()
  console.log('[ai-card]', { cardHeights, scrolled, final })
  const unique = new Set(cardHeights)
  assert.ok(unique.size <= 2, `card height changed too much: ${JSON.stringify(cardHeights)}`)
  const spread = Math.max(...cardHeights) - Math.min(...cardHeights)
  assert.ok(spread <= 2, `card height jitter ${spread}px: ${JSON.stringify(cardHeights)}`)
  assert.ok(final.scrollHeight > final.clientHeight + 8, `chat log should overflow and scroll: ${JSON.stringify(final)}`)
  assert.equal(final.atBottom, true, `newest message should be visible at the bottom: ${JSON.stringify(final)}`)
  console.log('[playwright] AI chat card keeps a fixed height, scrolls its logs, and pins the newest record')
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
  await new Promise((resolve) => model.close(resolve))
  fs.rmSync(temp, { recursive: true, force: true })
}
