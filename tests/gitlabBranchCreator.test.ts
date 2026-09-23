import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabService } from '../electron/services/gitlab'

/**
 * Locks in the branch-creation attribution contract:
 *
 *  - `compareCommits` preserves forge ordering for branch analysis. Commit
 *    authorship is not treated as proof of who created a branch.
 *  - `listBranchCreators` must read branch creation from GitLab project events
 *    (`push_data.action = 'created'`, `ref_type = 'branch'`), including the
 *    `commit_count: 0` case where a branch has no commits at all.
 *  - GitHub PushEvents whose `before` SHA is all zeroes identify newly created refs.
 */

const GL_URL = 'https://gitlab.example.com/group/project'
const GH_URL = 'https://github.com/octocat/Hello-World'

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

const commit = (id: string, name: string, date: string) => ({
  id,
  short_id: id.slice(0, 8),
  title: `commit ${id}`,
  message: `commit ${id}`,
  created_at: date,
  authored_date: date,
  committed_date: date,
  author_name: name,
  author_email: `${name}@example.com`,
  committer_name: name,
  committer_email: `${name}@example.com`,
  web_url: ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GitLabService.compareCommits', () => {
  it('calls the GitLab compare endpoint and preserves oldest-first order', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      // The compare URL also contains /projects/, so match it first.
      if (!url.includes('/repository/compare')) {
        return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
      }
      // Real GitLab compare shape: commits oldest-first, tip last.
      return jsonResponse({
        commit: commit('tip1111', 'tipauthor', '2026-03-03T00:00:00.000Z'),
        commits: [
          commit('first111', '分支创始人', '2026-01-01T00:00:00.000Z'),
          commit('second22', 'other', '2026-02-02T00:00:00.000Z')
        ]
      })
    })

    const svc = service(GL_URL)
    const result = await svc.compareCommits(42, 'main', 'feature/x', {
      url: GL_URL,
      apiKey: 'test-token',
      provider: 'gitlab'
    })

    expect(result.map((c) => c.id)).toEqual(['first111', 'second22'])
    expect(result[0].author_name).toBe('分支创始人')
    const compareCall = calls.find((c) => c.includes('/repository/compare'))
    expect(compareCall).toBeDefined()
    expect(compareCall).toContain('from=main')
    expect(compareCall).toContain('to=feature%2Fx')
  })

  it('maps the GitHub compare payload, which nests commits under commit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        status: 'ahead',
        ahead_by: 1,
        commits: [
          {
            sha: 'ghfirst1',
            html_url: 'https://github.com/x/y/commit/ghfirst1',
            commit: {
              message: 'feat: first',
              author: { name: 'GH Author', email: 'gh@example.com', date: '2026-01-05T00:00:00Z' }
            }
          }
        ]
      })
    )

    const svc = service(GH_URL)
    const result = await svc.compareCommits(0, 'main', 'feature/y', {
      url: GH_URL,
      apiKey: 'gh-token',
      provider: 'github'
    })
    expect(result).toHaveLength(1)
    expect(result[0].author_name).toBe('GH Author')
    expect(result[0].author_email).toBe('gh@example.com')
  })
})

describe('GitLabService.listBranchCreators', () => {
  it('reads branch creation from project events, including branches with no commits', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/users')) return jsonResponse([])
      if (url.includes('/projects/') && !url.includes('/events')) {
        return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
      }
      return jsonResponse([
        // A pure branch creation: no commits at all.
        {
          action_name: 'pushed new',
          author_username: 'zhangsan',
          author: { name: '张三', public_email: '' },
          created_at: '2026-03-01T10:00:00.000Z',
          push_data: { action: 'created', ref_type: 'branch', ref: 'feature/no-commits', commit_count: 0 }
        },
        // A branch created together with its first commit.
        {
          action_name: 'pushed new',
          author_username: 'lisi',
          author: { name: '李四', public_email: 'lisi@example.com' },
          created_at: '2026-03-02T10:00:00.000Z',
          push_data: { action: 'created', ref_type: 'branch', ref: 'feature/with-commit', commit_count: 1 }
        },
        // Ordinary pushes and tag creations must be ignored.
        {
          action_name: 'pushed to',
          author_username: 'wangwu',
          author: { name: '王五', public_email: 'w@example.com' },
          created_at: '2026-03-03T10:00:00.000Z',
          push_data: { action: 'pushed', ref_type: 'branch', ref: 'main', commit_count: 3 }
        },
        {
          action_name: 'pushed new',
          author_username: 'zhaoliu',
          author: { name: '赵六', public_email: 'z@example.com' },
          created_at: '2026-03-04T10:00:00.000Z',
          push_data: { action: 'created', ref_type: 'tag', ref: 'v1.0.0', commit_count: 0 }
        }
      ])
    })

    const svc = service(GL_URL)
    const creators = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })

    expect([...creators.keys()].sort()).toEqual(['feature/no-commits', 'feature/with-commit'])
    // The reported case: a branch created without committing still resolves.
    expect(creators.get('feature/no-commits')?.name).toBe('张三')
    // GitLab often hides the address; the name is still correct.
    expect(creators.get('feature/no-commits')?.email).toBe('')
    expect(creators.get('feature/with-commit')?.email).toBe('lisi@example.com')
    // Tags and plain pushes must not be mistaken for branch creation.
    expect(creators.has('main')).toBe(false)
    expect(creators.has('v1.0.0')).toBe(false)

    const eventsCall = calls.find((c) => c.includes('/events'))
    expect(eventsCall).toContain('action=pushed')
  })

  it('recovers a missing creator address from the forge profile', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/users')) {
        return jsonResponse([{ username: 'zhangsan', name: '张三', public_email: 'zhangsan@example.com' }])
      }
      if (url.includes('/events')) {
        return jsonResponse([
          {
            action_name: 'pushed new',
            author_username: 'zhangsan',
            author: { name: '张三', public_email: '' },
            created_at: '2026-03-01T10:00:00.000Z',
            push_data: { action: 'created', ref_type: 'branch', ref: 'feature/no-commits', commit_count: 0 }
          }
        ])
      }
      return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
    })

    const svc = service(GL_URL)
    const creators = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })

    expect(creators.get('feature/no-commits')?.email).toBe('zhangsan@example.com')
    // The profile is the only place GitLab exposes the account: the lookup must
    // target the event author, not the project.
    const usersCall = calls.find((c) => c.includes('/users'))
    expect(usersCall).toContain('/api/v4/users?username=zhangsan')
    // A creator that already has an address must not cost a lookup at all.
    expect(calls.filter((c) => c.includes('/users'))).toHaveLength(1)
  })

  it('accepts the account email field when public_email is hidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/users')) return jsonResponse([{ username: 'zhangsan', email: 'private@example.com' }])
      if (url.includes('/events')) {
        return jsonResponse([
          {
            action_name: 'pushed new',
            author_username: 'zhangsan',
            author: { name: '张三', public_email: '' },
            created_at: '2026-03-01T10:00:00.000Z',
            push_data: { action: 'created', ref_type: 'branch', ref: 'feature/no-commits', commit_count: 0 }
          }
        ])
      }
      return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
    })

    const svc = service(GL_URL)
    const creators = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    expect(creators.get('feature/no-commits')?.email).toBe('private@example.com')
  })

  it('accepts self-hosted event payloads with top-level author fields and ignored action filters', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/events')) {
        // Some older/self-hosted versions ignore action=pushed and expose the
        // actor outside the nested author object.
        if (url.includes('action=pushed')) return jsonResponse([{ action_name: 'pushed to' }])
        return jsonResponse([{
          action_name: 'pushed to',
          author_name: '内网用户',
          author_username: 'intranet-user',
          author_email: 'intranet@example.com',
          created_at: '2026-03-03T10:00:00.000Z',
          push_data: { action: 'created', ref_type: 'branch', ref: 'feature/intranet', commit_count: 0 }
        }])
      }
      return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
    })

    const svc = service(GL_URL)
    const creators = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })

    expect(creators.get('feature/intranet')?.name).toBe('内网用户')
    expect(creators.get('feature/intranet')?.email).toBe('intranet@example.com')
    expect(calls.some((url) => url.includes('/events?per_page=100') && !url.includes('action=pushed'))).toBe(true)
  })

  it('keeps the creator when the profile lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/users')) return new Response('nope', { status: 500 })
      if (url.includes('/events')) {
        return jsonResponse([
          {
            action_name: 'pushed new',
            author_username: 'zhangsan',
            author: { name: '张三', public_email: '' },
            created_at: '2026-03-01T10:00:00.000Z',
            push_data: { action: 'created', ref_type: 'branch', ref: 'feature/no-commits', commit_count: 0 }
          }
        ])
      }
      return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
    })

    const svc = service(GL_URL)
    const creators = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    expect(creators.get('feature/no-commits')?.name).toBe('张三')
    expect(creators.get('feature/no-commits')?.email).toBe('')
  })

  it('caches profile lookups per username within the process', async () => {
    let userCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/users')) {
        userCalls += 1
        return jsonResponse([{ username: 'zhangsan', public_email: 'zhangsan@example.com' }])
      }
      if (url.includes('/events')) {
        return jsonResponse([
          {
            action_name: 'pushed new',
            author_username: 'zhangsan',
            author: { name: '张三', public_email: '' },
            created_at: '2026-03-01T10:00:00.000Z',
            push_data: { action: 'created', ref_type: 'branch', ref: 'feature/no-commits', commit_count: 0 }
          },
          {
            action_name: 'pushed new',
            author_username: 'zhangsan',
            author: { name: '张三', public_email: '' },
            created_at: '2026-03-02T10:00:00.000Z',
            push_data: { action: 'created', ref_type: 'branch', ref: 'feature/other', commit_count: 0 }
          }
        ])
      }
      return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
    })

    const svc = service(GL_URL)
    const first = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    expect(first.get('feature/no-commits')?.email).toBe('zhangsan@example.com')
    expect(first.get('feature/other')?.email).toBe('zhangsan@example.com')
    expect(userCalls).toBe(1)

    const second = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    expect(second.get('feature/no-commits')?.email).toBe('zhangsan@example.com')
    expect(userCalls).toBe(1)
  })

  it('reads GitHub branch-creation push events and resolves the actor profile', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/events')) return jsonResponse([
        {
          type: 'PushEvent',
          actor: { login: 'octocat', name: 'Octo Cat' },
          created_at: '2026-03-04T10:00:00Z',
          payload: { ref: 'refs/heads/feature/ui', before: '0000000000000000000000000000000000000000' }
        },
        {
          type: 'PushEvent',
          actor: { login: 'other' },
          payload: { ref: 'refs/heads/main', before: 'abc123' }
        }
      ])
      if (url.includes('/users/octocat')) return jsonResponse({ name: 'Octocat Person', email: 'octo@example.com' })
      return jsonResponse({ id: 1, full_name: 'octocat/Hello-World' })
    })
    const svc = service(GH_URL)
    const creators = await svc.listBranchCreators(1, { url: GH_URL, apiKey: 't', provider: 'github' })
    expect([...creators.keys()]).toEqual(['feature/ui'])
    expect(creators.get('feature/ui')).toMatchObject({ name: 'Octocat Person', email: 'octo@example.com', username: 'octocat' })
    expect(calls.some((url) => url.includes('/repos/octocat/Hello-World/events'))).toBe(true)
  })

  it('degrades to an empty map when the events endpoint fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/events')) return new Response('nope', { status: 500 })
      return jsonResponse({ id: 42, path_with_namespace: 'group/project' })
    })
    const svc = service(GL_URL)
    const creators = await svc.listBranchCreators(42, { url: GL_URL, apiKey: 'test-token', provider: 'gitlab' })
    expect(creators.size).toBe(0)
  })
})
