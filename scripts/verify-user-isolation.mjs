import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

// Set GITMANAGER_PLAYWRIGHT_MODULE to a Playwright installation outside this repo.
const require = createRequire(import.meta.url)
const { chromium } = await import(process.env.GITMANAGER_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.GITMANAGER_PLAYWRIGHT_MODULE).href : 'playwright')
const root = process.cwd()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-playwright-'))
process.env.GITMANAGER_USER_DATA_DIR = path.join(temp, 'profile')
process.env.GITMANAGER_AI_ALLOW_PRIVATE_NETWORK = '1'
// Fixed fixture for the isolated test profile, never a deployment credential.
process.env.GITMANAGER_ENCRYPTION_KEY = 'ab'.repeat(32)
let browser
let child
const model = http.createServer((req, res) => {
  req.resume()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: 'Verified private model answer.' } }] }))
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const activityMonth = new Date().toISOString().slice(0, 7)
const commitSha = '0123456789abcdef0123456789abcdef01234567'
const activityFixture = {
  branches: [],
  commits: [{
    sha: commitSha,
    shortSha: commitSha.slice(0, 8),
    subject: 'Fixture activity commit',
    committedAt: `${activityMonth}-12T12:00:00.000Z`,
    repositoryId: 'branch-fixture',
    repositoryName: 'Branch verification',
    source: 'gitlab',
    webUrl: 'https://gitlab.example.test/group/project/-/commit/0123456789abcdef0123456789abcdef01234567',
    branchNames: ['feature/fixture-activity']
  }],
  mergeRequests: [{
    id: 42,
    iid: 42,
    title: 'Fixture merge request',
    state: 'opened',
    sourceBranch: 'feature/fixture-activity',
    targetBranch: 'main',
    createdAt: `${activityMonth}-13T12:00:00.000Z`,
    repositoryId: 'branch-fixture',
    repositoryName: 'Branch verification',
    source: 'gitlab',
    webUrl: 'https://gitlab.example.test/group/project/-/merge_requests/42',
    role: 'author'
  }],
  stats: {
    commitCount: 1,
    linesAdded: 8,
    linesRemoved: 3,
    netLines: 5,
    linesAddedByRepository: [{ repositoryId: 'branch-fixture', repositoryName: 'Branch verification', added: 8, removed: 3 }],
    branchCount: 1,
    validBranches: 1,
    invalidBranches: 0,
    repositoryCount: 1,
    months: [{ month: activityMonth, commits: 1, branches: 1 }],
    years: [],
    bySource: [],
    byRepository: [{ repositoryId: 'branch-fixture', repositoryName: 'Branch verification', source: 'gitlab', commits: 1, branches: 1, added: 8, removed: 3, activeDays: 1, mrAuthored: 1, mrReviewed: 0 }],
    activeDays: 1,
    activeWeeks: 1,
    averageCommitsPerActiveDay: 1,
    currentStreak: 1,
    longestStreak: 1,
    weekdays: Array(7).fill(0),
    hours: Array(24).fill(0),
    monthlyLines: [{ month: activityMonth, added: 8, removed: 3 }],
    fileTypes: [],
    topFiles: [],
    mrAuthored: 1,
    mrReviewed: 0,
    diffsLoaded: 1,
    diffsFailed: 0
  },
  commitDetails: [{
    sha: commitSha,
    repositoryId: 'branch-fixture',
    added: 8,
    removed: 3,
    diffStatus: 'loaded',
    files: [{ path: 'src/fixture.ts', added: 8, removed: 3, patch: '@@ -1 +1 @@\n-old\n+new' }]
  }]
}
try {
  const seedBundle = path.join(temp, 'services.cjs')
  await build({ entryPoints: ['server/services.ts'], outfile: seedBundle, platform: 'node', format: 'cjs', bundle: true, packages: 'external', logLevel: 'silent' })
  // Resolve sql.js and other runtime dependencies from the application installation.
  process.env.NODE_PATH = path.join(root, 'node_modules')
  require('node:module').Module._initPaths()
  const runtime = await require(seedBundle).bootstrap()
  const now = new Date().toISOString()
  runtime.services.storage.insert('repositories', { id: 'branch-fixture', name: 'Branch verification', path: '/branch-fixture', source: 'gitlab', created_at: now, total_branches: 205 })
  for (let index = 0; index < 205; index++) {
    const name = `feature/verified-${String(index).padStart(3, '0')}`
    const row = {
      id: `verified-${index}`, repositoryId: 'branch-fixture', repositoryName: 'Branch verification', name, displayName: name, type: 'local',
      existsLocally: true, existsRemotely: false, isHead: false,
      creator: { name: index === 0 ? 'one' : 'other', email: '', username: index === 0 ? 'one' : 'other', firstCommitAt: now, confidence: 'medium' },
      createdAt: now, lastCommitAt: now, lastCommitSha: 'fixture', lastAuthor: 'other', commitCount: 1, ahead: 0, behind: 0,
      merged: false, mergedInto: null, baseBranch: 'main', inactiveDays: 0, ageDays: 0, naming: { status: 'valid' },
      health: { score: 100, level: 'healthy', factors: [] }, protection: { whitelisted: false, isDefault: false, protected: false, rules: [] },
      state: 'active', stale: false, thresholdDays: 180, thresholdUnit: 'days', cleanupCandidate: false, recentCommits: []
    }
    runtime.services.storage.insert('branches', { id: row.id, key: `branch-fixture|local|${name}`, repository_id: 'branch-fixture', name, type: 'local', data_json: JSON.stringify(row) })
  }
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
  await first.evaluate(() => window.gitmanager.setMyRepositorySelection(['branch-fixture']))
  await first.reload({ waitUntil: 'domcontentloaded' })
  await first.goto(`${base}/#/branches`, { waitUntil: 'domcontentloaded' })
  await first.getByText('feature/verified-000', { exact: true }).first().waitFor()
  assert.equal(await first.getByText('feature/verified-204', { exact: true }).count(), 0)
  await first.getByRole('button', { name: '全部', exact: true }).click()
  await first.getByText('feature/verified-204', { exact: true }).first().waitFor()
  assert.equal(await first.locator('span.font-mono.font-medium').filter({ hasText: /^feature\/verified-/ }).count(), 205)
  await first.getByRole('button', { name: '我的', exact: true }).click()
  await first.getByRole('button', { name: '所有分支', exact: true }).click()
  await first.getByText('feature/verified-204', { exact: true }).first().waitFor()
  await first.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' })
  await first.getByRole('button', { name: '分支总数 1' }).waitFor()
  await first.getByRole('button', { name: '全部', exact: true }).click()
  await first.getByRole('button', { name: '分支总数 205' }).waitFor()
  assert.equal(await first.evaluate(() => window.gitmanager.listBranches().then((rows) => rows.length)), 205)
  console.log('[playwright] Mine/All branch scope, reset filters and more than 200 branch rows passed')
  const activityKey = 'one@example.com|gitlab|101|6||branch-fixture'
  await first.evaluate(({ activityKey, activityFixture }) => {
    localStorage.setItem('gitmanager:my-activity:v1', JSON.stringify({ [activityKey]: { savedAt: Date.now(), data: activityFixture } }))
    localStorage.setItem('gitmanager:effectSettings', JSON.stringify({ enabled: true, ambientBackground: false, splashCursor: false, clickSpark: false, depthText: false, particleSplash: false, ditherVeil: true }))
    window.dispatchEvent(new Event('gitmanager:effect-settings-change'))
  }, { activityKey, activityFixture })
  await first.reload({ waitUntil: 'domcontentloaded' })
  await first.goto(`${base}/#/my-activity`, { waitUntil: 'domcontentloaded' })
  await first.getByRole('heading', { name: '个人活动' }).waitFor()
  const monthlyCommits = first.getByRole('img', { name: '按月提交与分支' })
  await monthlyCommits.locator('rect.cursor-pointer').first().click()
  await first.getByRole('heading', { name: '按月提交明细' }).waitFor()
  assert.equal(new URL(await first.getByRole('link', { name: '跳转 GitLab' }).getAttribute('href')).hostname, 'gitlab.example.test')
  assert.equal(new URL(await first.getByRole('link', { name: '打开' }).getAttribute('href')).pathname, '/group/project/-/merge_requests/42')
  await first.getByRole('button', { name: '查看代码' }).click()
  await first.waitForURL(/\/my-activity\/commit\//)
  await first.getByText('src/fixture.ts', { exact: true }).waitFor()
  await first.goBack()
  await first.getByRole('heading', { name: '按月提交明细' }).waitFor()
  await first.getByRole('button', { name: '返回个人活动' }).click()
  await first.getByRole('heading', { name: '个人活动' }).waitFor()
  const monthlyLines = first.getByRole('img', { name: '按月代码增删' })
  await monthlyLines.locator('rect.cursor-pointer').first().click()
  await first.getByRole('heading', { name: '按月代码增删明细' }).waitFor()
  assert.equal(new URL(await first.getByRole('link', { name: '跳转 GitLab' }).getAttribute('href')).pathname, '/group/project/-/commit/0123456789abcdef0123456789abcdef01234567')
  await first.getByRole('button', { name: '返回个人活动' }).click()
  await first.getByRole('heading', { name: '个人活动' }).waitFor()
  await first.getByRole('button', { name: 'Branch verification' }).first().click()
  await first.getByRole('heading', { name: 'Branch verification' }).waitFor()
  assert.equal(new URL(await first.getByRole('link', { name: '跳转 GitLab' }).first().getAttribute('href')).hostname, 'gitlab.example.test')
  assert.equal(new URL(await first.getByRole('link', { name: '跳转 GitLab' }).nth(1).getAttribute('href')).pathname, '/group/project/-/merge_requests/42')
  await first.getByRole('button', { name: '查看代码' }).click()
  await first.waitForURL(/\/my-activity\/commit\//)
  await first.getByText('src/fixture.ts', { exact: true }).waitFor()
  await first.goBack()
  await first.getByRole('heading', { name: 'Branch verification' }).waitFor()
  const veilBounds = await first.locator('aside canvas[aria-hidden="true"]').evaluate((canvas) => {
    const host = canvas.parentElement
    const canvasRect = canvas.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const userRect = host.parentElement.getBoundingClientRect()
    let paintedPixels = -1
    let brightPixels = -1
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true })
      const data = context?.getImageData(0, 0, canvas.width, canvas.height).data
      if (data) {
        paintedPixels = 0
        brightPixels = 0
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] > 16 || data[index + 1] > 16 || data[index + 2] > 16) paintedPixels++
          if (data[index] > 100 || data[index + 1] > 100 || data[index + 2] > 100) brightPixels++
        }
      }
    } catch {
      paintedPixels = -1
    }
    return {
      width: hostRect.width,
      height: hostRect.height,
      contained: canvasRect.left >= hostRect.left && canvasRect.top >= hostRect.top
        && canvasRect.right <= hostRect.right && canvasRect.bottom <= hostRect.bottom,
      besideUser: hostRect.left >= userRect.left && hostRect.right <= userRect.right
        && hostRect.top >= userRect.top && hostRect.bottom <= userRect.bottom
      ,
      paintedPixels,
      brightPixels
    }
  })
  assert.ok(veilBounds.width > 0 && veilBounds.width <= 64 && veilBounds.height <= 40, JSON.stringify(veilBounds))
  assert.equal(veilBounds.contained, true, JSON.stringify(veilBounds))
  assert.equal(veilBounds.besideUser, true, JSON.stringify(veilBounds))
  assert.notEqual(veilBounds.paintedPixels, -1, JSON.stringify(veilBounds))
  assert.ok(veilBounds.paintedPixels > 0, JSON.stringify(veilBounds))
  assert.ok(veilBounds.brightPixels > 20, JSON.stringify(veilBounds))
  console.log('[playwright] Monthly/repository commit and MR links, code details, browser history, and bounded user-area veil passed')
  await first.goto(`${base}/#/my-ai`, { waitUntil: 'domcontentloaded' })
  const keyInput = first.getByPlaceholder('sk-...')
  await keyInput.fill('secret-test')
  await first.getByRole('button', { name: '显示密钥', exact: true }).click()
  assert.equal(await keyInput.getAttribute('type'), 'text')
  await first.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  assert.equal(await keyInput.getAttribute('type'), 'password')
  await first.getByLabel('API URL', { exact: true }).fill(modelUrl)
  await first.getByLabel('模型', { exact: true }).fill('internal')
  await first.getByRole('button', { name: '测试连接', exact: true }).click()
  await first.getByText('模型服务连接成功。', { exact: true }).waitFor()
  console.log('[playwright] Key visibility and testing the current draft passed')
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
