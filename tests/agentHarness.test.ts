import { describe, expect, it, vi } from 'vitest'
import { AgentService, AGENT_TOOL_REGISTRY, isDisallowedAgentIntent } from '../electron/services/agent'
import type { GitLabUserDto } from '../electron/services/gitlab'

describe('Agent harness security boundary', () => {
  it('registers business queries and the controlled Git query tool', () => {
    expect(AGENT_TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      'search_users', 'list_repositories', 'list_branches', 'get_branch_detail',
      'get_commits', 'get_commit_detail', 'get_commit_diff', 'get_contribution_statistics', 'execute_git_command'
    ])
    expect(AGENT_TOOL_REGISTRY.every((tool) => tool.capability === 'READ')).toBe(true)
    expect(AGENT_TOOL_REGISTRY.every((tool) => (tool.schema as { additionalProperties?: boolean }).additionalProperties === false)).toBe(true)
  })

  it.each([
    '删除分支', '删除仓库', '删除 Commit', '删除 Tag', '删除报告', '修改分支', '修改仓库',
    '修改配置', '修改计划任务', '发送邮件', '运行 SQL query',
    'delete repository', 'modify branch', 'send an email', 'HTTP POST arbitrary endpoint'
  ])('denies destructive intent before tools: %s', (request) => {
    expect(isDisallowedAgentIntent(request)).toBe(true)
  })

  it.each(['统计本周提交', '列出当前分支', '总结这个 commit 的 diff'])('allows read-only intent: %s', (request) => {
    expect(isDisallowedAgentIntent(request)).toBe(false)
  })
})

describe('Agent repository credentials and contribution queries', () => {
  function fixture() {
    const repos = ['a', 'b'].map((id, index) => ({ id, name: id, source: 'gitlab', gitlabUrl: `https://${id}.example/team/app`, remoteProjectPath: 'team/app', gitlabProjectId: index + 1, defaultBranch: 'main' }))
    const gitlab = { listUsers: vi.fn().mockResolvedValue([{ id: 42, username: 'oucheer', name: 'Other display name', email: 'oucheer@example.com' }]), listCommits: vi.fn().mockResolvedValue([]), getCommit: vi.fn() }
    const service = new AgentService({} as never, { getGitLabToken: () => 'bad-global-token' } as never, { list: () => repos, getRemoteToken: (id: string) => `repo-token-${id}` } as never, gitlab as never, {} as never)
    const executor = service as unknown as { runTool(name: string, args: Record<string, unknown>, scope: string[], users?: Map<string, GitLabUserDto[]>): Promise<Record<string, unknown>> }
    return { gitlab, executor }
  }

  it('uses scoped repository credentials rather than global credentials for users', async () => {
    const { executor, gitlab } = fixture()
    const result = await executor.runTool('search_users', { keyword: 'oucheer', repository_ids: ['a', 'outside'] }, ['a', 'b'])
    expect(gitlab.listUsers).toHaveBeenCalledTimes(1)
    expect(gitlab.listUsers).toHaveBeenCalledWith('oucheer', expect.objectContaining({ apiKey: 'repo-token-a', url: 'https://a.example/team/app' }))
    expect(result.complete).toBe(true)
    expect(result.users).toEqual([expect.objectContaining({ id: 42, repository_id: 'a' })])
  })

  it('isolates a failed user endpoint from other repository results', async () => {
    const { executor, gitlab } = fixture()
    gitlab.listUsers.mockRejectedValueOnce(new Error('401 Bad credentials'))
    const result = await executor.runTool('search_users', { keyword: 'oucheer' }, ['a', 'b'])
    expect(result.complete).toBe(false)
    expect(result.users).toEqual([expect.objectContaining({ repository_id: 'b' })])
    expect(JSON.stringify(result)).not.toContain('repo-token')
  })

  it('resolves numeric IDs, scans subsequent pages, and retains repository identity', async () => {
    const { executor, gitlab } = fixture()
    const users = new Map<string, GitLabUserDto[]>()
    await executor.runTool('search_users', { keyword: 'oucheer' }, ['a'], users)
    const commit = (sha: string) => ({ id: sha, author_name: 'Different name', author_email: 'oucheer@example.com', committed_date: '2026-09-01T00:00:00Z', title: 'Change' })
    gitlab.listCommits.mockResolvedValueOnce(Array.from({ length: 100 }, () => commit('first'))).mockResolvedValueOnce([commit('second')])
    const result = await executor.runTool('get_commits', { author_ids: ['42'] }, ['a'], users)
    expect(result.commit_count).toBe(2)
    expect(result.complete).toBe(true)
    expect(result.commits).toEqual([expect.objectContaining({ sha: 'first', repository_id: 'a' }), expect.objectContaining({ sha: 'second', repository_id: 'a' })])
    expect(gitlab.listCommits).toHaveBeenNthCalledWith(2, 1, '', 2, 100, expect.objectContaining({ apiKey: 'repo-token-a' }))
    expect(gitlab.getCommit).not.toHaveBeenCalled()
  })

  it('does not report an unresolved ID or failed query as a complete zero total', async () => {
    const { executor, gitlab } = fixture()
    const result = await executor.runTool('get_commits', { author_ids: ['42'] }, ['a'])
    expect(result.complete).toBe(false)
    expect(gitlab.listCommits).not.toHaveBeenCalled()
    gitlab.listCommits.mockRejectedValueOnce(new Error('401'))
    const failed = await executor.runTool('get_commits', {}, ['a'])
    expect(failed.complete).toBe(false)
  })

  it('uses explicitly labelled author metadata when account search is unavailable', async () => {
    const { executor, gitlab } = fixture()
    const users = new Map<string, GitLabUserDto[]>()
    gitlab.listUsers.mockRejectedValueOnce(new Error('401'))
    gitlab.listCommits.mockResolvedValueOnce([{ id: 'sha', author_name: 'oucheer', author_email: 'dev@example.com', title: 'Change', committed_date: '2026-09-01T00:00:00Z' }])
    const result = await executor.runTool('search_users', { keyword: 'oucheer' }, ['a'], users)
    expect(result.users).toEqual([expect.objectContaining({ username: 'dev@example.com', identity_source: 'commit-author-metadata' })])
    expect((result.users as Record<string, unknown>[])[0].id).toBeUndefined()
    gitlab.listCommits.mockResolvedValueOnce([{ id: 'sha', author_name: 'oucheer', author_email: 'dev@example.com', title: 'Change', committed_date: '2026-09-01T00:00:00Z' }])
    expect((await executor.runTool('get_commits', { author_ids: ['dev@example.com'] }, ['a'], users)).commit_count).toBe(1)
  })
})

describe('Agent session deletion', () => {
  it('removes the owned session and its dependent records', () => {
    const storage = { get: vi.fn().mockReturnValue({ id: 's', user_id: 'local-user' }), all: vi.fn().mockImplementation((sql: string) => sql.includes('agent_runs') ? [{ id: 'r', status: 'completed' }] : []), delete: vi.fn() }
    const service = new AgentService(storage as never, {} as never, {} as never, {} as never, {} as never)
    service.deleteSession('s')
    expect(storage.delete.mock.calls.map((call) => call[0])).toEqual(['agent_tool_audit', 'agent_evidence', 'agent_runs', 'agent_messages', 'agent_sessions'])
  })
  it('rejects deletion of a running session', () => {
    const storage = { get: vi.fn().mockReturnValue({ id: 's' }), all: vi.fn().mockImplementation((sql: string) => sql.includes('agent_runs') ? [{ id: 'r', status: 'running' }] : []), delete: vi.fn() }
    const service = new AgentService(storage as never, {} as never, {} as never, {} as never, {} as never)
    expect(() => service.deleteSession('s')).toThrow()
    expect(storage.delete).not.toHaveBeenCalled()
  })
})
