import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value).toString('base64'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { apiBaseUrl, detectRemoteProvider, isApiBaseUrl } from '../electron/services/gitlab'

describe('remote providers', () => {
  it('detects supported platforms from service URLs', () => {
    expect(detectRemoteProvider('https://gitlab.example.com')).toBe('gitlab')
    expect(detectRemoteProvider('https://github.com/acme/app')).toBe('github')
    expect(detectRemoteProvider('https://gitee.com/acme/app')).toBe('gitee')
    expect(detectRemoteProvider('https://unknown.example.com', 'gitee')).toBe('gitee')
  })

  it('builds API bases for service roots and project URLs', () => {
    expect(apiBaseUrl('https://gitlab.example.com', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('http://10.0.0.5:8080', 'gitlab')).toBe('http://10.0.0.5:8080/api/v4')
    expect(apiBaseUrl('https://gitlab.example.com/group/app', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://github.com/acme/app', 'github')).toBe('https://api.github.com')
    expect(apiBaseUrl('https://gitee.com/acme/app', 'gitee')).toBe('https://gitee.com/api/v5')
  })

  /**
   * Self-hosted GitLab is often mounted under a relative URL root
   * (`external_url 'http://host/gitlab'`), so its API lives at
   * `<relative-root>/api/v4` rather than at the origin. Dropping that prefix
   * turned every scan into an HTML 404, which the UI then reported as
   * "scanned 0 branches".
   */
  it('keeps the relative URL root of a self-hosted instance', () => {
    expect(apiBaseUrl('http://git.corp.com/gitlab', 'gitlab')).toBe('http://git.corp.com/gitlab/api/v4')
    // A project URL only reveals the root once the project path is subtracted.
    expect(apiBaseUrl('http://git.corp.com/gitlab/group/app', 'gitlab', 'group/app'))
      .toBe('http://git.corp.com/gitlab/api/v4')
    // Without the project path a single segment is still taken as the root…
    expect(apiBaseUrl('http://git.corp.com/gitlab', 'gitlab')).toBe('http://git.corp.com/gitlab/api/v4')
    // …while a bare namespace URL is assumed to be served from the origin.
    expect(apiBaseUrl('https://gitlab.example.com/group/app', 'gitlab'))
      .toBe('https://gitlab.example.com/api/v4')
  })

  it('leaves gitlab.com at the origin, where its API actually lives', () => {
    expect(apiBaseUrl('https://gitlab.com', 'gitlab')).toBe('https://gitlab.com/api/v4')
    expect(apiBaseUrl('https://www.gitlab.com', 'gitlab')).toBe('https://www.gitlab.com/api/v4')
  })

  it('accepts an API base the user typed explicitly', () => {
    expect(apiBaseUrl('http://git.corp.com/gitlab/api/v4', 'gitlab')).toBe('http://git.corp.com/gitlab/api/v4')
    expect(apiBaseUrl('http://git.corp.com/gitlab/api', 'gitlab')).toBe('http://git.corp.com/gitlab/api/v4')
    expect(isApiBaseUrl('http://host/gitlab/api/v4')).toBe(true)
    expect(isApiBaseUrl('http://host/api/v4')).toBe(true)
  })

  it('does not mistake a project path for an API base', () => {
    expect(isApiBaseUrl('http://host/gitlab')).toBe(false)
    expect(isApiBaseUrl('http://host/group/app')).toBe(false)
    // `<namespace>/api` is a project whose last segment happens to be "api", so
    // only the versioned `.../api/v4` form counts as an API base. `.../api` is
    // still handled by `apiBaseUrl`, which appends the version.
    expect(isApiBaseUrl('http://host/gitlab/api')).toBe(false)
    expect(isApiBaseUrl('http://host/group/api')).toBe(false)
    expect(isApiBaseUrl('http://host/group/app/api/v4')).toBe(false)
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
    repositoryIds: ['repo-1'],
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
