import { describe, expect, it } from 'vitest'
import { GitLabService } from '../src-node/services/gitlab'

const settings = {
  get: () => ({ gitlabUrl: 'https://gitlab.example.com/api/v4' }),
  getGitLabToken: () => 'token'
}
const service = new GitLabService(settings as never)

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('GitLabService.listBranchCreators', () => {
  it('verifies creator email through the account id when directory lookup is forbidden', async () => {
    const urls: string[] = []
    const fetchMock = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/projects/42/events?') || url.endsWith('/projects/42/events')) return jsonResponse([{
        action_name: 'pushed new',
        created_at: '2026-01-01T00:00:00Z',
        push_data: { action: 'created', ref_type: 'branch', ref: 'feature/pcie-band-crc' },
        author: { id: 7, name: '张三', username: 'zhangsan' }
      }])
      if (url === 'https://gitlab.example.com/api/v4/projects/42') return jsonResponse({ id: 42, path_with_namespace: 'team/app' })
      if (url.includes('/users?username=')) return new Response('forbidden', { status: 403 })
      if (url === 'https://gitlab.example.com/api/v4/users/7') {
        return jsonResponse({ id: 7, username: 'zhangsan', name: '张三', public_email: '' })
      }
      if (url.endsWith('/users/7/emails')) return new Response('forbidden', { status: 403 })
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }
    globalThis.fetch = fetchMock as typeof fetch
    const creators = await new GitLabService(settings as never).listBranchCreators(42)
    expect(creators.get('feature/pcie-band-crc')).toMatchObject({ username: 'zhangsan', name: '张三' })
    expect(urls).toContain('https://gitlab.example.com/api/v4/users/7')
  })

  it('reads the exact account private email when the profile hides it and the token is an admin', async () => {
    const privateService = new GitLabService(settings as never)
    const urls: string[] = []
    const fetchMock = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/projects/42/events')) return jsonResponse([{
        action_name: 'pushed new',
        created_at: '2026-01-01T00:00:00Z',
        push_data: { action: 'created', ref_type: 'branch', ref: 'feature/private' },
        author: { id: 7, name: '张三', username: 'zhangsan' }
      }])
      if (url === 'https://gitlab.example.com/api/v4/users/7') {
        return jsonResponse({ id: 7, username: 'zhangsan', name: '张三', public_email: '' })
      }
      if (url === 'https://gitlab.example.com/api/v4/users/7/emails') {
        return jsonResponse([{ id: 1, email: 'zhangsan@corp.example', confirmed_at: '2026-01-01T00:00:00Z' }])
      }
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }
    globalThis.fetch = fetchMock as typeof fetch
    const creators = await privateService.listBranchCreators(42)
    expect(creators.get('feature/private')).toMatchObject({
      email: 'zhangsan@corp.example',
      emailSource: 'account',
      username: 'zhangsan',
      accountId: '7',
      emailResolution: { status: 'verified-account' }
    })
    expect(urls).toContain('https://gitlab.example.com/api/v4/users/7/emails')
  })

  it('reports forbidden private email access instead of claiming the email is hidden', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/projects/42/events')) return jsonResponse([{
        action_name: 'pushed new',
        created_at: '2026-01-01T00:00:00Z',
        push_data: { action: 'created', ref_type: 'branch', ref: 'feature/private' },
        author: { id: 7, name: '张三', username: 'zhangsan' }
      }])
      if (url === 'https://gitlab.example.com/api/v4/users/7') {
        return jsonResponse({ id: 7, username: 'zhangsan', name: '张三', public_email: '' })
      }
      if (url.endsWith('/users/7/emails')) return new Response('forbidden', { status: 403 })
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch
    const creators = await service.listBranchCreators(42)
    expect(creators.get('feature/private')).toMatchObject({
      email: '',
      emailSource: '',
      username: 'zhangsan',
      accountId: '7',
      emailResolution: { status: 'account-lookup-forbidden', retryable: false }
    })
  })

  it('reports private email rate limiting as retryable', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/projects/42/events')) return jsonResponse([{
        action_name: 'pushed new',
        created_at: '2026-01-01T00:00:00Z',
        push_data: { action: 'created', ref_type: 'branch', ref: 'feature/rate-limited' },
        author: { id: 7, name: '张三', username: 'zhangsan' }
      }])
      if (url === 'https://gitlab.example.com/api/v4/users/7') {
        return jsonResponse({ id: 7, username: 'zhangsan', name: '张三', public_email: '' })
      }
      if (url.endsWith('/users/7/emails')) return new Response('rate limited', { status: 429 })
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch
    const creators = await new GitLabService(settings as never).listBranchCreators(42)
    expect(creators.get('feature/rate-limited')).toMatchObject({
      email: '',
      emailResolution: { status: 'account-lookup-rate-limited', retryable: true }
    })
  })

  it('reports private email server failures as retryable', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/projects/42/events')) return jsonResponse([{
        action_name: 'pushed new',
        created_at: '2026-01-01T00:00:00Z',
        push_data: { action: 'created', ref_type: 'branch', ref: 'feature/lookup-failed' },
        author: { id: 7, name: '张三', username: 'zhangsan' }
      }])
      if (url === 'https://gitlab.example.com/api/v4/users/7') {
        return jsonResponse({ id: 7, username: 'zhangsan', name: '张三', public_email: '' })
      }
      if (url.endsWith('/users/7/emails')) return new Response('server error', { status: 500 })
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch
    const creators = await new GitLabService(settings as never).listBranchCreators(42)
    expect(creators.get('feature/lookup-failed')).toMatchObject({
      email: '',
      emailResolution: { status: 'account-lookup-failed', retryable: true }
    })
  })

  it('keeps account-email-hidden only when the private email list is readable but empty', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/projects/42/events')) return jsonResponse([{
        action_name: 'pushed new',
        created_at: '2026-01-01T00:00:00Z',
        push_data: { action: 'created', ref_type: 'branch', ref: 'feature/empty' },
        author: { id: 7, name: '张三', username: 'zhangsan' }
      }])
      if (url === 'https://gitlab.example.com/api/v4/users/7') {
        return jsonResponse({ id: 7, username: 'zhangsan', name: '张三', public_email: '' })
      }
      if (url.endsWith('/users/7/emails')) return jsonResponse([])
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch
    const creators = await new GitLabService(settings as never).listBranchCreators(42)
    expect(creators.get('feature/empty')).toMatchObject({
      email: '',
      emailResolution: { status: 'account-email-hidden', retryable: false }
    })
  })
})

describe('GitLabService.resolveCreatorCommitEmail', () => {
  const config = {
    url: 'https://gitlab.example.com/api/v4',
    apiKey: 'token',
    provider: 'gitlab' as const,
    projectPath: 'team/app'
  }
  const commits = [{
    id: 'abc123',
    short_id: 'abc123',
    title: 'feat: first',
    message: 'feat: first',
    created_at: '2026-01-01T00:00:00Z',
    authored_date: '2026-01-01T00:00:00Z',
    committed_date: '2026-01-01T00:00:00Z',
    author_name: '张三',
    author_email: 'zhangsan@corp.example',
    committer_name: '张三',
    committer_email: 'zhangsan@corp.example',
    web_url: ''
  }]

  it('binds a project commit email to the exact creator username through GitLab GraphQL', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { username: 'zhangsan' },
          committer: { username: 'zhangsan' }
        } } } }
      })
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/pcie-band-crc',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      commits,
      config
    )

    expect(result).toMatchObject({ email: 'zhangsan@corp.example', resolution: { status: 'verified-commit' } })
    expect(urls[0]).toBe('https://gitlab.example.com/api/graphql')
  })

  it('still uses exact commit evidence when private email access is forbidden', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { id: 'gid://gitlab/User/7', username: 'zhangsan' },
          committer: { id: 'gid://gitlab/User/7', username: 'zhangsan' }
        } } } }
      })
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/forbidden-profile',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-lookup-forbidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      commits,
      config
    )

    expect(result).toMatchObject({ email: 'zhangsan@corp.example', resolution: { status: 'verified-commit' } })
  })

  it('finds a verified account commit when the branch itself has no commits', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/repository/commits?')) {
        if (url.includes('author=zhangsan') || url.includes('author_id=7')) {
          expect(url).not.toContain('ref_name=')
          return jsonResponse([])
        }
        // Exact-author matches were empty, so the resolver falls back to a
        // bounded project history and still validates each SHA through GraphQL.
        expect(url).not.toContain('author=')
        return jsonResponse(commits)
      }
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { username: 'zhangsan' },
          committer: { username: 'zhangsan_other' }
        } } } }
      })
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/empty-branch',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      [],
      config
    )

    expect(result).toMatchObject({ email: 'zhangsan@corp.example', resolution: { status: 'verified-commit' } })
    expect(urls[0]).toContain('/repository/commits?')
  })

  it('shares a verified account-wide commit result across branches', async () => {
    let graphqlCalls = 0
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/api/graphql')) {
        graphqlCalls += 1
        return jsonResponse({
          data: { project: { repository: { c0: {
            sha: 'abc123',
            author: { username: 'zhangsan' },
            committer: { username: '' }
          } } } }
        })
      }
      if (url.includes('/repository/commits?') && url.includes('author_id=7')) return jsonResponse(commits)
      if (url.includes('/repository/commits?') && url.includes('author=zhangsan')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch
    const sharedService = new GitLabService(settings as never)
    const creator = { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden' as const, retryable: false, checkedAt: '2026-01-01T00:00:00Z' } }

    const first = await sharedService.resolveCreatorCommitEmail(42, 'feature/first', creator, [], config)
    const second = await sharedService.resolveCreatorCommitEmail(42, 'feature/second', creator, [], config)

    expect(first.email).toBe('zhangsan@corp.example')
    expect(second).toEqual(first)
    expect(graphqlCalls).toBe(1)
  })

  it('keeps paging exact-author commits instead of stopping at the first 100', async () => {
    const urls: string[] = []
    const baseTime = Date.parse('2026-01-01T00:00:00Z')
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...commits[0],
      id: `first-${index}`,
      authored_date: new Date(baseTime + index * 1000).toISOString(),
      committed_date: new Date(baseTime + index * 1000).toISOString(),
      author_email: `first-${index}@corp.example`,
      committer_email: `first-${index}@corp.example`
    }))
    const secondPage = [
      {
        ...commits[0],
        id: 'unrelated-second-page',
        authored_date: new Date(baseTime - 2000).toISOString(),
        committed_date: new Date(baseTime - 2000).toISOString(),
        author_email: 'other@corp.example',
        committer_email: 'other@corp.example'
      },
      {
        ...commits[0],
        id: 'wanted-second-page',
        authored_date: new Date(baseTime - 1000).toISOString(),
        committed_date: new Date(baseTime - 1000).toISOString(),
        author_email: 'zhangsan@corp.example',
        committer_email: 'zhangsan@corp.example'
      }
    ]
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/api/graphql')) {
        const query = JSON.parse(String(init?.body ?? '{}')).query as string
        const aliases = [...query.matchAll(/c(\d+): commit\(ref: "([^"]+)"\)/g)]
        const data = Object.fromEntries(aliases.map(([, key, sha]) => [
          `c${key}`,
          {
            sha,
            author: { username: sha === 'wanted-second-page' ? 'zhangsan' : `someone-${key}` },
            committer: { username: sha === 'wanted-second-page' ? 'zhangsan' : `someone-${key}` }
          }
        ]))
        return jsonResponse({ data: { project: { repository: data } } })
      }
      if (url.includes('/repository/commits?') && (url.includes('author_id=7') || url.includes('author=zhangsan'))) {
        return jsonResponse(new URL(url).searchParams.get('page') === '1' ? firstPage : secondPage)
      }
      if (url.includes('/repository/commits?')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/far-history',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      [],
      config
    )

    expect(result.email).toBe('zhangsan@corp.example')
    expect(urls.some((url) => url.includes('author_id=7') && url.includes('page=2'))).toBe(true)
  })

  it('verifies GraphQL identities by account id even when the login changed', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { id: 'gid://gitlab/User/7', username: 'zhangsan-renamed' },
          committer: { id: 'gid://gitlab/User/8', username: 'someone-else' }
        } } } }
      })
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/account-id',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      commits,
      config
    )

    expect(result).toMatchObject({ email: 'zhangsan@corp.example', resolution: { status: 'verified-commit' } })
    expect(urls[0]).toBe('https://gitlab.example.com/api/graphql')
  })

  it('falls back to exact-author history when an older GitLab rejects author_id', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/repository/commits?') && url.includes('author_id=7')) {
        return new Response('unknown author_id', { status: 400 })
      }
      if (url.includes('/repository/commits?') && url.includes('author=zhangsan')) return jsonResponse(commits)
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { id: 'gid://gitlab/User/7', username: 'zhangsan' },
          committer: { username: '' }
        } } } }
      })
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/legacy-author-filter',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      [],
      config
    )

    expect(result.email).toBe('zhangsan@corp.example')
    expect(urls.some((url) => url.includes('author_id=7'))).toBe(true)
    expect(urls.some((url) => url.includes('author=zhangsan'))).toBe(true)
  })

  it('rejects a commit bound to a different account id with the same display login', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { id: 'gid://gitlab/User/99', username: 'zhangsan' },
          committer: { id: 'gid://gitlab/User/99', username: 'zhangsan' }
        } } } }
      })
      if (url.includes('/repository/commits?')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/id-collision',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      commits,
      config
    )

    expect(result.email).toBe('')
  })

  it('pages through more than 300 author commits', async () => {
    const urls: string[] = []
    const page = (offset: number) => Array.from({ length: 100 }, (_, index) => ({
      ...commits[0],
      id: `commit-${offset + index}`,
      authored_date: new Date(Date.parse('2026-01-01T00:00:00Z') - (offset + index) * 1000).toISOString(),
      committed_date: new Date(Date.parse('2026-01-01T00:00:00Z') - (offset + index) * 1000).toISOString()
    }))
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/api/graphql')) {
        const query = JSON.parse(String(init?.body ?? '{}')).query as string
        const aliases = [...query.matchAll(/c(\d+): commit\(ref: "([^"]+)"\)/g)]
        const data = Object.fromEntries(aliases.map(([, key, sha]) => [
          `c${key}`,
          {
            sha,
            author: { id: sha === 'commit-350' ? 'gid://gitlab/User/7' : 'gid://gitlab/User/99', username: sha === 'commit-350' ? 'zhangsan' : 'someone' },
            committer: { id: 'gid://gitlab/User/99', username: 'someone' }
          }
        ]))
        return jsonResponse({ data: { project: { repository: data } } })
      }
      if (url.includes('/repository/commits?') && url.includes('author_id=7')) {
        const pageNumber = Number(new URL(url).searchParams.get('page'))
        if (pageNumber <= 4) return jsonResponse(page((pageNumber - 1) * 100))
        return jsonResponse([])
      }
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/deep-history',
      { username: 'zhangsan', accountId: '7', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      [],
      config
    )

    expect(result.email).toBe('zhangsan@corp.example')
    expect(urls.some((url) => url.includes('author_id=7') && url.includes('page=4'))).toBe(true)
  })

  it('rejects a same-named commit bound to another username', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/api/graphql')) return jsonResponse({
        data: { project: { repository: { c0: {
          sha: 'abc123',
          author: { username: 'zhangsan_other' },
          committer: { username: 'zhangsan_other' }
        } } } }
      })
      if (url.includes('/repository/commits?')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/name-collision',
      { username: 'zhangsan', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      commits,
      config
    )

    expect(result).toMatchObject({ email: '', resolution: { status: 'account-email-hidden' } })
  })

  it('does not turn a GraphQL failure into unverified email evidence', async () => {
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/api/graphql')) return new Response('server error', { status: 500 })
      if (url.includes('/repository/commits?')) return new Response('server error', { status: 500 })
      throw new Error(`unexpected url ${url}`)
    }) as typeof fetch

    const result = await new GitLabService(settings as never).resolveCreatorCommitEmail(
      42,
      'feature/lookup-failure',
      { username: 'zhangsan', emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00Z' } },
      commits,
      config
    )

    expect(result.email).toBe('')
    expect(result.resolution).toMatchObject({ status: 'account-lookup-failed', retryable: true })
  })
})
