import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService } from '../electron/services/gitlab'

/**
 * The "connect, then add" flow submits the same connection config twice: first
 * for `listProjects`, then again for `getProject` when the user adds a project.
 * For an instance behind a relative URL root the first call only finds the
 * project after retrying with the prefix (`/gitlab`), so the second call has to
 * rediscover the same prefix — the config never carries `projectPath`.
 */

function service(url: string, token = 'test-token') {
  const settings = {
    get: () => ({ gitlabUrl: url }),
    getGitLabToken: () => token
  }
  return new GitLabService(settings as never)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('adding a project on an instance behind a relative URL root', () => {
  it('resolves the project again with the same prefix when it is added', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      // Only `/gitlab/api/v4/...` exists; the origin-rooted reading 404s.
      if (!url.startsWith('http://git.corp.com/gitlab/api/v4/')) {
        return jsonResponse({ message: '404 Not Found' }, 404)
      }
      return jsonResponse({
        id: 7,
        path_with_namespace: 'group/app',
        web_url: 'http://git.corp.com/gitlab/group/app',
        default_branch: 'main'
      })
    })

    const config = { url: 'http://git.corp.com/gitlab/group/app', apiKey: 'test-token', provider: 'gitlab' as const }
    const svc = service(config.url)
    const projects = await svc.listProjects(config)
    expect(projects.map((p) => p.pathWithNamespace)).toEqual(['group/app'])

    calls.length = 0
    const project = await svc.getProject(projects[0].id, config)

    expect(project.pathWithNamespace).toBe('group/app')
    expect(calls.every((url) => url.startsWith('http://git.corp.com/gitlab/api/v4/'))).toBe(true)
  })

  it('adds the project on a cold cache too, by retrying with the prefixed API', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (!url.startsWith('http://git.corp.com/gitlab/api/v4/')) {
        return jsonResponse({ message: '404 Not Found' }, 404)
      }
      return jsonResponse({ id: 7, path_with_namespace: 'group/app', default_branch: 'main' })
    })

    const svc = service('http://git.corp.com/gitlab/group/app')
    const project = await svc.getProject(7, {
      url: 'http://git.corp.com/gitlab/group/app',
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(project.pathWithNamespace).toBe('group/app')
    expect(calls[0]).toContain('http://git.corp.com/api/v4/projects/7')
    expect(calls[1]).toContain('http://git.corp.com/gitlab/api/v4/projects/7')
  })

  it('does not retry for an ordinary origin-rooted project', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input))
      return jsonResponse({ id: 7, path_with_namespace: 'group/app', default_branch: 'main' })
    })

    await service('https://gitlab.example.com/group/app').getProject(7, {
      url: 'https://gitlab.example.com/group/app',
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('https://gitlab.example.com/api/v4/projects/7')
  })

  it('surfaces the original error when the prefixed retry fails as well', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      // A 403 is not a path problem, so the retry cannot help and the message
      // must describe the request the user's address maps to.
      return jsonResponse({ message: '403 Forbidden' }, 403)
    })

    await expect(
      service('http://git.corp.com/gitlab/group/app').getProject(7, {
        url: 'http://git.corp.com/gitlab/group/app',
        apiKey: 'test-token',
        provider: 'gitlab'
      })
    ).rejects.toThrow(/403/)

    expect(calls).toHaveLength(2)
  })

  it('does not retry when the URL has no room for a relative root', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input))
      return jsonResponse({ message: '404 Not Found' }, 404)
    })

    await expect(
      service('http://git.corp.com/gitlab').getProject(7, {
        url: 'http://git.corp.com/gitlab',
        apiKey: 'test-token',
        provider: 'gitlab'
      })
    ).rejects.toThrow(/404/)

    expect(calls).toHaveLength(1)
  })
})
