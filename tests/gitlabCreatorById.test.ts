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
      if (url.includes('/repository/branches')) return jsonResponse([])
      throw new Error(`unexpected url ${url}`)
    }
    globalThis.fetch = fetchMock as typeof fetch
    const creators = await service.listBranchCreators(42)
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

  it('keeps an identity-verified account hidden when private email access is forbidden', async () => {
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

  it('binds a branch commit email to the exact creator username through GitLab GraphQL', async () => {
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
      if (url.includes('/repository/commits?') && url.includes('author=zhangsan')) return jsonResponse([])
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
      if (url.includes('/repository/commits?') && url.includes('author=zhangsan')) return new Response('server error', { status: 500 })
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
    expect(result.resolution).toMatchObject({ status: 'account-email-hidden', retryable: true })
  })
})
