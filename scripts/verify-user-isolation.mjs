import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { build } from 'esbuild'

// Set GITMANAGER_PLAYWRIGHT_MODULE to a Playwright installation outside this repo.
const require = createRequire(import.meta.url)
const { chromium } = await import(process.env.GITMANAGER_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.GITMANAGER_PLAYWRIGHT_MODULE).href : 'playwright')
const root = process.cwd()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-playwright-'))
process.env.GITMANAGER_USER_DATA_DIR = path.join(temp, 'profile')
process.env.GITMANAGER_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.GITMANAGER_AI_ALLOW_PRIVATE_NETWORK = '1'
let browser
let child
const model = http.createServer((req, res) => {
  req.resume()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: 'Verified private model answer.' } }] }))
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const seedBundle = path.join(temp, 'services.cjs')
  await build({ entryPoints: ['server/services.ts'], outfile: seedBundle, platform: 'node', format: 'cjs', bundle: true, packages: 'external', logLevel: 'silent' })
  // Resolve sql.js and other runtime dependencies from the application installation.
  process.env.NODE_PATH = path.join(root, 'node_modules')
  require('node:module').Module._initPaths()
  const runtime = await require(seedBundle).bootstrap()
  for (const id of ['one', 'two']) {
    await runtime.services.users.loginUser(`${id}@example.com`, { userId: id === 'one' ? 101 : 102, username: id, email: `${id}@example.com`, displayName: id, source: 'gitlab' }, 'seed-token')
  }
  const sessions = runtime.services.storage.all('SELECT token, email FROM user_sessions')
  runtime.shutdown()
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`
  const port = Number(process.env.GITMANAGER_VERIFY_PORT ?? 4337)
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server/index.cjs'], { cwd: root, env: { ...process.env, GITMANAGER_PORT: String(port), GITMANAGER_HOST: '127.0.0.1' }, windowsHide: true, stdio: 'ignore' })
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
    if (i > 120) throw new Error('Server failed to start')
    await pause(250)
  }
  browser = await chromium.launch({ executablePath: process.env.GITMANAGER_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage()
  await page.goto(base)
  await page.locator('form input[type=password]').waitFor()
  await page.locator('form input[type=password]').press('Enter')
  await page.getByText('请填写全部登录信息。', { exact: true }).waitFor()
  await page.locator('form input[type=password]').fill('pantum')
  await page.locator('form input[type=password]').press('Enter')
  await page.locator('main').waitFor()
  console.log('[playwright] Enter login and missing-field prompt passed')
  await page.close()
  const pages = []
  for (const session of sessions) {
    const context = await browser.newContext()
    await context.addInitScript((token) => sessionStorage.setItem('gitmanager:session-token', token), session.token)
    const userPage = await context.newPage()
    await userPage.goto(`${base}/#/my-ai`, { waitUntil: 'domcontentloaded' })
    await userPage.locator('main').waitFor()
    pages.push(userPage)
    assert.equal(await userPage.locator('a[href="#/notifications"]').count(), 0)
    assert.equal(await userPage.getByLabel('Notifications', { exact: true }).count(), 0)
  }
  const [first, second] = pages
  const rpc = (page, method, args = []) => page.evaluate(async ({ method, args }) => {
    const response = await fetch(`/api/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('gitmanager:session-token')}` }, body: JSON.stringify(args) })
    return { status: response.status, body: await response.json() }
  }, { method, args })
  assert.equal((await rpc(first, 'savePersonalAiConfig', [{ baseUrl: modelUrl, model: 'internal', apiKey: 'secret-test' }])).status, 200)
  const connection = await rpc(first, 'testPersonalAiConnection')
  assert.equal(connection.status, 200, JSON.stringify(connection.body))
  assert.equal(connection.body.result.ok, true)
  const conversation = (await rpc(first, 'createPersonalAiConversation')).body.result
  assert.equal((await rpc(second, 'getPersonalAiConfig')).body.result.hasApiKey, false)
  assert.ok((await rpc(second, 'listPersonalAiMessages', [conversation.id])).status >= 400)
  await first.reload({ waitUntil: 'domcontentloaded' })
  await first.getByPlaceholder('继续追问个人研发数据').waitFor()
  assert.equal((await rpc(first, 'getPersonalAiConfig')).body.result.hasApiKey, true)
  await first.getByPlaceholder('继续追问个人研发数据').fill('Hello')
  await first.getByPlaceholder('继续追问个人研发数据').press('Enter')
  await first.getByText('Verified private model answer.', { exact: true }).waitFor({ timeout: 30_000 })
  await first.goto(`${base}/#/branches`, { waitUntil: 'domcontentloaded' })
  await first.goto(`${base}/#/my-ai`, { waitUntil: 'domcontentloaded' })
  await first.getByText('Verified private model answer.', { exact: true }).waitFor()
  await second.goto(`${base}/#/notifications`, { waitUntil: 'domcontentloaded' })
  await second.waitForURL((url) => !url.hash.includes('/notifications'))
  assert.equal((await rpc(second, 'listNotifications')).status, 403)
  console.log('[playwright] Private API connection, Enter chat, navigation persistence, two-user isolation and notification redirect passed')
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
  await new Promise((resolve) => model.close(resolve))
  fs.rmSync(temp, { recursive: true, force: true })
}
