import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService, isTransientStatus } from '../src-node/services/gitlab'

const GL_URL = 'https://gitlab.example.com/group/project'

function service(url = GL_URL, token = 'test-token'): GitLabService {
  const settings = {
    get: () => ({ gitlabUrl: url }),
    getGitLabToken: () => token
  }
  return new GitLabService(settings as never)
}

function jsonResponse(body: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' }
  })
}

const branchRow = (name: string): Record<string, unknown> => ({
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
  it('retries only statuses that may recover', () => {
    expect([408, 429, 500, 502, 503, 504].every(isTransientStatus)).toBe(true)
    expect([400, 401, 403, 404, 422].some(isTransientStatus)).toBe(false)
  })
})

describe('GitLab request resilience', () => {
  it('retries an internal-server error and returns branches after recovery', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ message: '500 Internal Server Error' }, 500, 'Internal Server Error')
      return jsonResponse([branchRow('main'), branchRow('feature/a')])
    })

    const branches = await service().listBranches(42, {
      url: GL_URL,
      apiKey: 'test-token',
      provider: 'gitlab'
    })

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

    const branches = await service().listBranches(42, {
      url: GL_URL,
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(branches.map((branch) => branch.name)).toEqual(['main'])
    expect(calls).toBe(2)
  })

  it('does not retry a real 404', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      return jsonResponse({ message: '404 Project Not Found' }, 404, 'Not Found')
    })

    await expect(service().listBranches(42, {
      url: GL_URL,
      apiKey: 'test-token',
      provider: 'gitlab'
    })).rejects.toThrow(/404 Project Not Found/)
    expect(calls).toBe(1)
  })

  it('gives up after the retry budget and keeps the forge message', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      return jsonResponse({ message: '13:get remote references: exit status 128.' }, 500, 'Internal Server Error')
    })

    await expect(service().listBranches(42, {
      url: GL_URL,
      apiKey: 'test-token',
      provider: 'gitlab'
    })).rejects.toThrow(/13:get remote references/)
    expect(calls).toBe(3)
  })

  it('rejects a non-list success response instead of showing zero branches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ message: 'gateway error envelope' })
    )

    await expect(service().listBranches(42, {
      url: GL_URL,
      apiKey: 'test-token',
      provider: 'gitlab'
    })).rejects.toThrow(/非列表数据/)
  })
})
