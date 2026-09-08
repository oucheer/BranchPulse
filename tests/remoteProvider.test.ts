import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value).toString('base64'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { apiBaseUrl, detectRemoteProvider } from '../electron/services/gitlab'

describe('remote providers', () => {
  it('detects supported platforms from service URLs', () => {
    expect(detectRemoteProvider('https://gitlab.example.com')).toBe('gitlab')
    expect(detectRemoteProvider('https://github.com/acme/app')).toBe('github')
    expect(detectRemoteProvider('https://gitee.com/acme/app')).toBe('gitee')
    expect(detectRemoteProvider('https://unknown.example.com', 'gitee')).toBe('gitee')
  })

  it('builds API bases for service roots and project URLs', () => {
    expect(apiBaseUrl('https://gitlab.example.com', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://gitlab.example.com/group/app', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://github.com/acme/app', 'github')).toBe('https://api.github.com')
    expect(apiBaseUrl('https://gitee.com/acme/app', 'gitee')).toBe('https://gitee.com/api/v5')
  })

  it('accepts .git suffix in GitHub URLs', async () => {
    const { GitLabService } = await import('../electron/services/gitlab')
    const settings = { get: () => ({ gitlabUrl: '' }), getGitLabToken: () => 'tok' }
    const svc = new GitLabService(settings as never)
    // pathSegments is private but we can test via isProjectUrl/listProjects indirectly
    // Instead directly test that a .git URL does not blow up normalization
    expect(detectRemoteProvider('https://github.com/oucheer/git-test.git')).toBe('github')
    expect(apiBaseUrl('https://github.com/oucheer/git-test.git', 'github')).toBe('https://api.github.com')
  })

  it('GitHub/Gitee API paths use real slashes (not %2F)', async () => {
    const { GitLabService } = await import('../electron/services/gitlab')
    const settings = { get: () => ({ gitlabUrl: '' }), getGitLabToken: () => 'tok' }
    const svc = new GitLabService(settings as never)
    const { provider } = (svc as unknown as { resolve: (c?: unknown) => { provider: string } }).resolve({
      url: 'https://github.com/oucheer/git-test',
      apiKey: 'tok'
    })
    expect(provider).toBe('github')
    // private pathSegments should strip .git
    const segments = (svc as unknown as { pathSegments: (u: string) => string[] }).pathSegments('https://github.com/oucheer/git-test.git')
    expect(segments).toEqual(['oucheer', 'git-test'])
  })
})

describe('report schedule timing', () => {
  const from = new Date('2026-09-04T10:30:00')
  const base = {
    id: 'schedule-1',
    name: 'report',
    repositoryId: null,
    time: '09:00',
    weekday: 1,
    dayOfMonth: 1,
    runAt: null,
    recipients: '',
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  it('computes daily, weekly, monthly, and one-shot schedules', async () => {
    const { computeNextReportRunAt } = await import('../electron/services/reportSchedule')
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'daily' }, from) ?? '').getHours()).toBe(9)
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'weekly', weekday: 1 }, from) ?? '').getDate()).toBe(7)
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'monthly', dayOfMonth: 15 }, from) ?? '').getDate()).toBe(15)
    expect(computeNextReportRunAt({ ...base, frequency: 'once', runAt: '2026-09-03T09:00:00Z' }, from)).toBeNull()
  })
})