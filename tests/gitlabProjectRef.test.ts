import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService, projectIdOrPath } from '../electron/services/gitlab'

function service(url: string, token = 'test-token') {
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GitLab project references', () => {
  it('uses the numeric project id for project-scoped API endpoints', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/repository/branches')) {
        return jsonResponse([{ name: 'main', default: true, protected: false, commit: {} }])
      }
      if (url.includes('/repository/commits')) return jsonResponse([])
      if (url.includes('/repository/compare')) return jsonResponse({ commits: [] })
      if (url.includes('/events')) return jsonResponse([])
      throw new Error(`Unexpected URL: ${url}`)
    })

    const config = {
      url: 'http://git.corp.com/group/app',
      projectPath: 'group/app',
      apiKey: 'test-token',
      provider: 'gitlab' as const
    }
    const svc = service(config.url)

    await svc.listBranches(7, config)
    await svc.listCommits(7, 'feature/x', 2, 50, config)
    await svc.compareCommits(7, 'main', 'feature/x', config)
    await svc.listBranchCreators(7, config)

    expect(calls.slice(0, 3)).toEqual([
      'http://git.corp.com/api/v4/projects/7/repository/branches?per_page=100&page=1',
      'http://git.corp.com/api/v4/projects/7/repository/commits?ref_name=feature%2Fx&per_page=50&page=2',
      'http://git.corp.com/api/v4/projects/7/repository/compare?from=main&to=feature%2Fx'
    ])
    expect(calls).toContain('http://git.corp.com/api/v4/projects/7/events?action=pushed&per_page=100&page=1')
    expect(calls).toContain('http://git.corp.com/api/v4/projects/7/events?per_page=100&page=1')
    expect(calls.every((url) => url.includes('/projects/7/'))).toBe(true)
    expect(calls.some((url) => url.includes('/projects/group%2Fapp'))).toBe(false)
  })

  it('keeps a relative URL root while using the numeric project id', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input))
      return jsonResponse([])
    })

    const config = {
      url: 'http://git.corp.com/gitlab/group/app',
      projectPath: 'group/app',
      apiKey: 'test-token',
      provider: 'gitlab' as const
    }
    await service(config.url).listBranches(7, config)

    expect(calls).toEqual([
      'http://git.corp.com/gitlab/api/v4/projects/7/repository/branches?per_page=100&page=1'
    ])
  })

  it('includes the forge response body in an API error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        { message: '13:get remote references: create git ls-remote: exit status 128.' },
        500,
        'Internal Server Error'
      )
    )

    await expect(
      service('http://git.corp.com/group/app').listBranches(7, {
        url: 'http://git.corp.com/group/app',
        projectPath: 'group/app',
        apiKey: 'test-token',
        provider: 'gitlab'
      })
    ).rejects.toThrow(
      'Remote repository API 500 Internal Server Error: 13:get remote references: create git ls-remote: exit status 128.'
    )
  })

  it('encodes a project path exactly once for the legacy path form', () => {
    expect(projectIdOrPath('group/app')).toBe('group%2Fapp')
    expect(projectIdOrPath(7)).toBe('7')
  })
})
