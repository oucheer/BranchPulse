import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitManagerApi } from '../src-node/api'
import { createServer, type GitManagerServer } from '../server/http'
import { reportsDir } from '../src-node/utils/paths'

let workDir: string
let staticDir: string
let profileDir: string
let previousUserData: string | undefined
let server: GitManagerServer | null = null
let base = ''

/** Minimal API stub: every member is replaced per test. */
function api(overrides: Partial<GitManagerApi> = {}): GitManagerApi {
  const fallback = async () => null
  return new Proxy(overrides as unknown as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : fallback)
  }) as unknown as GitManagerApi
}

async function start(overrides: Partial<GitManagerApi> = {}, withStatic = true): Promise<void> {
  server = createServer({ api: api(overrides), ...(withStatic ? { staticDir } : {}) })
  const address = await server.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-http-'))
  staticDir = path.join(workDir, 'renderer')
  profileDir = path.join(workDir, 'profile')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>')
  fs.writeFileSync(path.join(staticDir, 'app.js'), 'console.log(1)')
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = profileDir
})

afterEach(async () => {
  if (server) await server.close()
  server = null
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('GET /api/health', () => {
  it('reports the active data directories', async () => {
    await start()
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, string>
    expect(body.ok).toBe(true)
    expect(body.userDataDir).toBe(path.resolve(profileDir))
    expect(body.dataDir).toBe(path.join(path.resolve(profileDir), 'data'))
  })
})

describe('GET /api/fs/folders', () => {
  it('lists a directory and normalises the extension filter', async () => {
    const target = path.join(workDir, 'browse')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'report.JSON'), '{}')
    fs.writeFileSync(path.join(target, 'notes.txt'), 'x')

    await start()
    const query = new URLSearchParams({ path: target, files: '1', ext: ' .JSON , txt ' })
    const response = await fetch(`${base}/api/fs/folders?${query}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { files: { name: string }[]; path: string }
    expect(body.path).toBe(path.resolve(target))
    expect(body.files.map((file) => file.name)).toEqual(['notes.txt', 'report.JSON'])
  })

  it('omits files unless they are requested', async () => {
    const target = path.join(workDir, 'browse')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'notes.txt'), 'x')
    await start()
    const response = await fetch(`${base}/api/fs/folders?path=${encodeURIComponent(target)}`)
    const body = (await response.json()) as { files: unknown[] }
    expect(body.files).toEqual([])
  })

  it('answers with 400 for an unreadable directory instead of failing the request', async () => {
    await start()
    const response = await fetch(`${base}/api/fs/folders?path=${encodeURIComponent(path.join(workDir, 'missing'))}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('目录不存在或不可访问') })
  })
})

describe('GET /api/reports/:id/download', () => {
  function writeReport(name: string): string {
    const dir = reportsDir()
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'id,status\n1,active\n')
    return file
  }

  it('sends the file with a download disposition', async () => {
    const file = writeReport('report-1.csv')
    await start({
      listReports: async () => [{ id: 'report-1', path: file }],
      exportReport: async () => null as never
    } as unknown as Partial<GitManagerApi>)

    const response = await fetch(`${base}/api/reports/report-1/download`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(await response.text()).toContain('id,status')
  })

  it('answers 404 for an unknown report id', async () => {
    await start({ listReports: async () => [] } as unknown as Partial<GitManagerApi>)
    const response = await fetch(`${base}/api/reports/nope/download`)
    expect(response.status).toBe(404)
  })

  it('refuses to serve a file outside the reports directory', async () => {
    const outside = path.join(workDir, 'secret.txt')
    fs.writeFileSync(outside, 'top secret')
    await start({
      listReports: async () => [{ id: 'escape', path: outside }]
    } as unknown as Partial<GitManagerApi>)

    const response = await fetch(`${base}/api/reports/escape/download`)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('top secret')
  })
})

describe('unknown API endpoints', () => {
  it('answers JSON 404s for /api/*', async () => {
    await start()
    const response = await fetch(`${base}/api/definitely-not-real`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

describe('renderer assets', () => {
  it('serves index.html at the root', async () => {
    await start()
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('id="root"')
  })

  it('serves a hashed asset with its mime type', async () => {
    await start()
    const response = await fetch(`${base}/app.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
  })

  it('falls back to index.html for an unknown route so deep links survive a reload', async () => {
    await start()
    const response = await fetch(`${base}/reports`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="root"')
  })

  it('does not escape the static root', async () => {
    const outside = path.join(workDir, 'secret.txt')
    fs.writeFileSync(outside, 'top secret')
    await start()
    for (const target of ['/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt']) {
      const response = await fetch(`${base}${target}`)
      const text = await response.text()
      expect(text, target).not.toContain('top secret')
    }
  })
})
