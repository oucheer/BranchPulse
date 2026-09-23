import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService, isTransientStatus } from '../electron/services/gitlab'

/**
 * 内网环境下「有的仓库能查到分支、有的为 0」的第二类原因在请求层：
 *
 *  - 反代偶发 429/5xx 或直接掐断连接，过去一次失败就把整个仓库判成不可读；
 *  - 反代把错误信封（JSON 对象）当 200 返回，过去被当成空列表，于是页面
 *    显示 0 个分支，看起来像没权限。
 *
 * 这里锁定：瞬时故障要重试并最终成功；真实 4xx 不重试；非列表响应必须抛错
 * （带页码），绝不静默变成 0 个分支。
 */

const GL_URL = 'https://gitlab.example.com/group/project'

function service(url = GL_URL, token = 'test-token') {
  const settings = {
    get: () => ({ gitlabUrl: url }),
    getGitLabToken: () => token
  }
  return new GitLabService(settings as never)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const branchRow = (name: string) => ({
  name,
  protected: false,
  default: name === 'main',
  merged: false,
  web_url: `https://gitlab.example.com/group/project/-/tree/${name}`,
  commit: { id: `${name}-tip`, short_id: name, title: 'x', created_at: '2026-01-01T00:00:00.000Z' }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isTransientStatus', () => {
  it('retries only the statuses that can succeed on a second attempt', () => {
    expect([408, 429, 500, 502, 503, 504].every(isTransientStatus)).toBe(true)
    expect([400, 401, 403, 404, 422].some(isTransientStatus)).toBe(false)
  })
})

describe('GitLabService transient failures', () => {
  it('retries a 5xx and returns the branches once the forge recovers', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ message: '502 Bad Gateway' }, 502)
      return jsonResponse([branchRow('main'), branchRow('feature/a')])
    })

    const branches = await service().listBranches(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })

    expect(branches.map((branch) => branch.name)).toEqual(['main', 'feature/a'])
    expect(calls).toBe(2)
  })

  it('retries a dropped connection instead of reporting an empty repository', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return jsonResponse([branchRow('main')])
    })

    const branches = await service().listBranches(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })

    expect(branches.map((branch) => branch.name)).toEqual(['main'])
    expect(calls).toBe(2)
  })

  it('does not retry a real 404 and reports the status', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      return jsonResponse({ message: '404 Project Not Found' }, 404)
    })

    await expect(
      service().listBranches(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    ).rejects.toThrow(/404 Project Not Found/)
    // A 404 is a real answer: retrying would only slow the scan down.
    expect(calls).toBe(1)
  })

  it('gives up after the retry budget and keeps the forge message', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      return jsonResponse({ message: '13:get remote references: exit status 128.' }, 500)
    })

    await expect(
      service().listBranches(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    ).rejects.toThrow(/13:get remote references/)
    expect(calls).toBe(3)
  })

  it('throws on a non-list body instead of silently scanning 0 branches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ message: 'gateway error envelope' })
    )

    await expect(
      service().listBranches(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    ).rejects.toThrow(/非列表数据/)
  })
})
