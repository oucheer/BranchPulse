import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService } from '../src-node/services/gitlab'

/**
 * A self-hosted GitLab mounted behind a relative URL root (`external_url
 * 'http://git.corp.com/gitlab'`) is indistinguishable from an ordinary project
 * URL by shape alone: `http://host/gitlab/group/app` can mean either
 *
 *   - the project `gitlab/group/app` on an instance served from the origin, or
 *   - the project `group/app` on an instance served from `/gitlab`.
 *
 * Instead of guessing, the first reading is tried and the second is used only
 * when the API rejects it. Getting this wrong is what made "connect, then scan"
 * return nothing: every request hit `<origin>/api/v4/...` and 404'd.
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

describe('GitLabService.listProjects behind a relative URL root', () => {
  it('retries with the first segment as the instance root when the project lookup 404s', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      // Only the prefixed API exists; the origin-rooted one is what a naive
      // reading of the URL produces and it must be tried first, then abandoned.
      if (url.startsWith('http://git.corp.com/gitlab/api/v4/')) {
        return jsonResponse({ id: 7, path_with_namespace: 'group/app', web_url: 'http://git.corp.com/gitlab/group/app' })
      }
      return jsonResponse({ message: '404 Not Found' }, 404)
    })

    const projects = await service('http://git.corp.com/gitlab/group/app').listProjects({
      url: 'http://git.corp.com/gitlab/group/app',
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(projects).toHaveLength(1)
    expect(projects[0].pathWithNamespace).toBe('group/app')
    expect(calls[0]).toContain('http://git.corp.com/api/v4/projects/gitlab%2Fgroup%2Fapp')
    expect(calls[1]).toContain('http://git.corp.com/gitlab/api/v4/projects/group%2Fapp')
  })

  it('keeps the plain reading when it works, so an ordinary project is not redirected', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      return jsonResponse({ id: 9, path_with_namespace: 'group/app' })
    })

    const projects = await service('https://gitlab.example.com/group/app').listProjects({
      url: 'https://gitlab.example.com/group/app',
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(projects).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('https://gitlab.example.com/api/v4/projects/group%2Fapp')
  })

  it('still lists the whole instance when a service root is given', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      return jsonResponse([
        { id: 1, path_with_namespace: 'group/app', web_url: 'http://git.corp.com/gitlab/group/app' }
      ])
    })

    const projects = await service('http://git.corp.com/gitlab').listProjects({
      url: 'http://git.corp.com/gitlab',
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(projects.map((p) => p.pathWithNamespace)).toEqual(['group/app'])
    expect(calls[0]).toContain('http://git.corp.com/gitlab/api/v4/projects?')
  })

  it('reads the API base itself as a service root rather than a project', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input))
      return jsonResponse([])
    })

    const projects = await service('http://git.corp.com/gitlab/api/v4').listProjects({
      url: 'http://git.corp.com/gitlab/api/v4',
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(projects).toHaveLength(0)
    expect(calls[0]).toContain('http://git.corp.com/gitlab/api/v4/projects?')
  })
})
