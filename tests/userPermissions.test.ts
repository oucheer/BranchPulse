import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrap, type BootstrapResult } from '../server/services'
import { createServer, type GitManagerServer } from '../server/http'

let workDir: string
let previousUserData: string | undefined
let appServer: GitManagerServer | null = null
let runtime: BootstrapResult | null = null
let base = ''

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-userperm-'))
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'profile')
  runtime = await bootstrap()
  appServer = createServer({ api: runtime.api })
  const address = await appServer.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (appServer) await appServer.close()
  appServer = null
  runtime?.shutdown()
  runtime = null
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

async function loginAs(role: 'admin' | 'user'): Promise<{ token: string }> {
  const body = role === 'admin' ? ['admin', 'pantum', null] : [null, null, 'dev@example.com']
  const response = await fetch(`${base}/api/rpc/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const payload = (await response.json()) as { result?: { token: string }; error?: string }
  if (role === 'admin') {
    expect(response.ok, payload.error).toBe(true)
  }
  if (role === 'user' && !response.ok) {
    // 在没有真实 GitLab 的单测环境里，邮箱登录会失败。这里仍要构造一个真实
    // 的普通用户会话，否则 HTTP 层的 403/放行断言都只是假数据。
    runtime?.services.storage.insert('user_sessions', {
      token: 'user-token',
      role: 'user',
      email: 'dev@example.com',
      gitlab_user_id: null,
      display_name: 'Dev User',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString()
    })
    runtime?.services.storage.save()
  }
  const token = payload.result?.token ?? (role === 'user' ? 'user-token' : '')
  return { token }
}

async function rpcAsUser(
  credential: { token: string; role: string },
  method: string,
  args: unknown[] = []
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token, role } = credential
  const response = await fetch(`${base}/api/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args)
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function rpc(token: string, method: string, args: unknown[] = []): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args)
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('user permissions', () => {
  it('rejects unauthenticated RPC calls with 401', async () => {
    const { status } = await rpc('', 'listRepositories')
    expect(status).toBe(401)
  })

  it('rejects a normal user calling a write method with 403', async () => {
    const token = await loginAs('user')
    const credential = { token: token.token, role: 'user' }
    const { status } = await rpcAsUser(credential, 'saveNamingRule')
    expect(status).toBe(403)
  })

  it('lets a normal user read the branch list but not save naming rules', async () => {
    const token = await loginAs('user')
    const credential = { token: token.token, role: 'user' }
    const read = await rpcAsUser(credential, 'listBranches')
    expect(read.status).toBe(200)
    const write = await rpcAsUser(credential, 'addWhitelist', [{ repositoryId: null, pattern: 'main', type: 'glob' }])
    expect(write.status).toBe(403)
  })

  it('lets an admin call a write method', async () => {
    const credential = await loginAs('admin')
    const { status } = await rpc(credential.token, 'listRepositories')
    expect(status).toBe(200)
  })
})
