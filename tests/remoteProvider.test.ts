import { describe, expect, it, vi } from 'vitest'

import { apiBaseUrl, detectRemoteProvider, isApiBaseUrl, pullRequestMatchesRole } from '../src-node/services/gitlab'

describe('remote providers', () => {
  it.each(['gitlab', 'github', 'gitee'] as const)('preserves %s commit patches and uses the correct endpoint', async (provider) => {
    const { GitLabService } = await import('../src-node/services/gitlab')
    const svc = new GitLabService({ get: () => ({}), getGitLabToken: () => 'token' } as never)
    const request = vi.fn().mockResolvedValue(provider === 'gitlab'
      ? [{ new_path: 'src/test.ts', diff: '@@ -1 +1 @@\n-old\n+new' }]
      : { files: [{ filename: 'src/test.ts', patch: '@@ -1 +1 @@\n-old\n+new' }] })
    Object.assign(svc, { projectRef: vi.fn().mockResolvedValue(provider === 'gitlab' ? '42' : 'team/app'), request })
    const files = await svc.commitDiffDetails(42, 'abc', { provider, url: `https://${provider}.com`, apiKey: 'token' })
    expect(files).toEqual([{ path: 'src/test.ts', added: 1, removed: 1, patch: '@@ -1 +1 @@\n-old\n+new' }])
    expect(request.mock.calls[0][0]).toBe(provider === 'gitlab'
      ? '/projects/42/repository/commits/abc/diff?per_page=100&page=1'
      : '/repos/team/app/commits/abc?per_page=100&page=1')
  })

  it.each(['gitlab', 'github', 'gitee'] as const)('loads a complete %s file at the requested commit', async (provider) => {
    const { GitLabService } = await import('../src-node/services/gitlab')
    const svc = new GitLabService({ get: () => ({}), getGitLabToken: () => 'token' } as never)
    const request = vi.fn().mockResolvedValue({ content: Buffer.from('line one\nline two').toString('base64'), encoding: 'base64' })
    Object.assign(svc, { projectRef: vi.fn().mockResolvedValue(provider === 'gitlab' ? '42' : 'team/app'), request })
    const content = await svc.getCommitFile(42, 'abc123', 'src/path with space.ts', { provider, url: `https://${provider}.com`, apiKey: 'token' })
    expect(content).toBe('line one\nline two')
    expect(request.mock.calls[0][0]).toBe(provider === 'gitlab'
      ? '/projects/42/repository/files/src%2Fpath%20with%20space.ts?ref=abc123'
      : '/repos/team/app/contents/src/path%20with%20space.ts?ref=abc123')
  })

  it('paginates GitLab changed files', async () => {
    const { GitLabService } = await import('../src-node/services/gitlab')
    const svc = new GitLabService({ get: () => ({}), getGitLabToken: () => 'token' } as never)
    const request = vi.fn().mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ new_path: `${i}.ts`, diff: '+line' })))
      .mockResolvedValueOnce([{ new_path: 'last.ts', diff: '-old' }])
    Object.assign(svc, { projectRef: vi.fn().mockResolvedValue('42'), request })
    const files = await svc.commitDiffDetails(42, 'abc', { provider: 'gitlab', url: 'https://gitlab.com', apiKey: 'token' })
    expect(files).toHaveLength(101)
    expect(request.mock.calls[1][0]).toContain('page=2')
  })
  it('assigns pull requests to exactly one role and accepts Gitee reviewer fields', () => {
    const authoredAndAssigned = { user: { id: 7, login: 'dev' }, assignees: [{ id: 7, login: 'dev' }] }
    expect(pullRequestMatchesRole(authoredAndAssigned, 'author', 7, 'dev')).toBe(true)
    expect(pullRequestMatchesRole(authoredAndAssigned, 'reviewer', 7, 'dev')).toBe(false)
    expect(pullRequestMatchesRole({ user: { id: 2 }, assignee: { id: 7 } }, 'reviewer', 7)).toBe(true)
    expect(pullRequestMatchesRole({ user: { id: 2 }, assignees: [{ username: 'dev' }] }, 'reviewer', -1, 'dev')).toBe(true)
  })

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
    const { GitLabService } = await import('../src-node/services/gitlab')
    const settings = { get: () => ({ gitlabUrl: '' }), getGitLabToken: () => 'tok' }
    const svc = new GitLabService(settings as never)
    // pathSegments is private but we can test via isProjectUrl/listProjects indirectly
    // Instead directly test that a .git URL does not blow up normalization
    expect(detectRemoteProvider('https://github.com/oucheer/git-test.git')).toBe('github')
    expect(apiBaseUrl('https://github.com/oucheer/git-test.git', 'github')).toBe('https://api.github.com')
  })

  it('GitHub/Gitee API paths use real slashes (not %2F)', async () => {
    const { GitLabService } = await import('../src-node/services/gitlab')
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

  it('tests GitHub and Gitee project addresses against the repository endpoint', async () => {
    const { GitLabService } = await import('../src-node/services/gitlab')
    const settings = { get: () => ({ gitlabUrl: '' }), getGitLabToken: () => 'tok' }
    const svc = new GitLabService(settings as never)

    const githubFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ full_name: 'acme/app', login: 'ignored' }), { status: 200 })
    )
    const github = await svc.testConnection({ url: 'https://github.com/acme/app.git', apiKey: 'tok' })
    expect(github.ok).toBe(true)
    expect(String(githubFetch.mock.calls[0][0])).toBe('https://api.github.com/repos/acme/app')

    const giteeFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ full_name: 'acme/app' }), { status: 200 })
    )
    const gitee = await svc.testConnection({ url: 'https://gitee.com/acme/app', apiKey: 'tok' })
    expect(gitee.ok).toBe(true)
    const giteeRequest = new URL(String(giteeFetch.mock.calls[0][0]))
    expect(`${giteeRequest.origin}${giteeRequest.pathname}`).toBe('https://gitee.com/api/v5/repos/acme/app')
    expect(giteeRequest.searchParams.get('access_token')).toBe('tok')
  })

  it('keeps forge login identities when mapping GitHub branch commits', async () => {
    const { GitLabService } = await import('../src-node/services/gitlab')
    const settings = { get: () => ({ gitlabUrl: '' }), getGitLabToken: () => 'tok' }
    const svc = new GitLabService(settings as never)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{
      name: 'main',
      protected: true,
      author: { login: 'octocat' },
      committer: { login: 'hubot' },
      commit: {
        sha: 'abc12345',
        message: 'initial',
        author: { name: 'Octo Cat', email: 'octo@example.com', date: '2026-01-01T00:00:00Z' }
      }
    }]), { status: 200 }))

    const [branch] = await svc.listBranches(7, {
      url: 'https://github.com/acme/app',
      projectPath: 'acme/app',
      apiKey: 'tok',
      provider: 'github'
    })

    expect(branch.commit.author_login).toBe('octocat')
    expect(branch.commit.committer_login).toBe('hubot')
  })
})

describe('report schedule timing', () => {
  const from = new Date('2026-09-04T10:30:00')
  const base = {
    id: 'schedule-1',
    name: 'report',
    repositoryIds: [],
    time: '09:00',
    weekday: 1,
    dayOfMonth: 1,
    runAt: null,
    recipients: '',
    groupIds: [],
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  it('computes daily, weekly, monthly, and one-shot schedules', async () => {
    const { computeNextReportRunAt } = await import('../src-node/services/reportSchedule')
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'daily' }, from) ?? '').getHours()).toBe(9)
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'weekly', weekday: 1 }, from) ?? '').getDate()).toBe(7)
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'monthly', dayOfMonth: 15 }, from) ?? '').getDate()).toBe(15)
    expect(computeNextReportRunAt({ ...base, frequency: 'once', runAt: '2026-09-03T09:00:00Z' }, from)).toBeNull()
  })
})
