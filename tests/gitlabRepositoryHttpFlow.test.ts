import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrap, type BootstrapResult } from '../server/services'
import { createServer, type GitManagerServer } from '../server/http'

const project = {
  id: 7,
  name: 'app',
  path_with_namespace: 'group/app',
  web_url: 'http://git.corp.com/group/app',
  default_branch: 'main'
}

let workDir: string
let staticDir: string
let previousUserData: string | undefined
let gitlabServer: http.Server | null = null
let appServer: GitManagerServer | null = null
let runtime: BootstrapResult | null = null
let gitlabBase = ''
let appBase = ''
let gitlabCalls: string[] = []

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

async function startGitLabMock(): Promise<void> {
  gitlabCalls = []
  gitlabServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    gitlabCalls.push(`${url.pathname}${url.search}`)

    if (url.pathname === '/api/v4/projects') {
      sendJson(res, [project])
      return
    }
    if (url.pathname === '/api/v4/projects/7') {
      sendJson(res, project)
      return
    }
    if (url.pathname.includes('/projects/group%2Fapp')) {
      sendJson(res, { message: 'encoded project path is not supported' }, 500)
      return
    }
    sendJson(res, { message: 'not found' }, 404)
  })
  await new Promise<void>((resolve) => gitlabServer!.listen(0, '127.0.0.1', resolve))
  const address = gitlabServer.address()
  if (!address || typeof address === 'string') throw new Error('mock GitLab did not bind')
  gitlabBase = `http://127.0.0.1:${address.port}`
}

async function rpc(method: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(`${appBase}/api/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args)
  })
  const payload = (await response.json()) as { result?: unknown; error?: string }
  expect(response.ok, payload.error).toBe(true)
  return payload.result
}

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-gitlab-http-'))
  staticDir = path.join(workDir, 'renderer')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>')
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'profile')
  await startGitLabMock()
  runtime = await bootstrap()
  appServer = createServer({ api: runtime.api, staticDir })
  const address = await appServer.listen(0, '127.0.0.1')
  appBase = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (appServer) await appServer.close()
  appServer = null
  runtime?.shutdown()
  runtime = null
  if (gitlabServer) await new Promise<void>((resolve) => gitlabServer!.close(() => resolve()))
  gitlabServer = null
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('GitLab repository HTTP flow', () => {
  it('adds a listed project by numeric id when encoded paths return 500', async () => {
    const config = { url: gitlabBase, apiKey: 'test-token', provider: 'gitlab' }
    const projects = await rpc('listGitLabProjects', [config]) as Array<{ id: number; pathWithNamespace: string }>
    expect(projects.map((item) => item.pathWithNamespace)).toEqual(['group/app'])

    const repository = await rpc('addGitLabRepository', [projects[0].id, config]) as { id: string; gitlabProjectId: number }
    expect(repository.gitlabProjectId).toBe(7)

    const repositories = await rpc('listRepositories', []) as Array<{ id: string }>
    expect(repositories.map((item) => item.id)).toContain(repository.id)
    expect(gitlabCalls.some((call) => call.includes('/projects/group%2Fapp'))).toBe(false)
  }, 20_000)
})
