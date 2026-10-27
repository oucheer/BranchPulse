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
