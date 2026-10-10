import { describe, expect, it, vi } from 'vitest'
import { validateAgentGitArgs } from '../electron/services/agentCommand'

describe('controlled Agent Git commands', () => {
  it.each([['status', '--short'], ['log', '--all', '--oneline'], ['branch', '--list'], ['show', '--stat', 'abcdef123']])('allows query %j', (...args) => {
    expect(() => validateAgentGitArgs(args)).not.toThrow()
  })
  it.each([['branch', '-D', 'main'], ['branch', '--delete', 'main'], ['push', 'origin', ':main'], ['push', '--delete', 'main'], ['update-ref', '-d', 'refs/heads/main'], ['log', '--output=secret'], ['-c', 'alias.x=!cmd', 'x'], ['branch', 'new-branch'], ['show', '--ext-diff'], ['status', '; rm -rf .']])('rejects dangerous command %j', (...args) => {
    expect(() => validateAgentGitArgs(args)).toThrow()
  })
})

describe('Agent command result isolation', () => {
  it('keeps one failed repository from hiding another result', async () => {
    vi.resetModules()
    const execute = vi.fn()
      .mockResolvedValueOnce({ source: 'local-git', output: 'clean', truncated: false })
      .mockRejectedValueOnce(new Error('Git 查询命令失败或超时。'))
    vi.doMock('../electron/services/agentCommand', () => ({ executeAgentGitCommand: execute }))
    const { AgentService } = await import('../electron/services/agent')
    const repos = ['a', 'b'].map((id) => ({ id, name: id, source: 'local', path: `/${id}` }))
    const service = new AgentService({} as never, {} as never, { list: () => repos } as never, {} as never, {} as never)
    const result = await (service as unknown as { runTool(name: string, args: Record<string, unknown>, scope: string[]): Promise<Record<string, unknown>> }).runTool('execute_git_command', { args: ['status', '--short'] }, ['a', 'b'])
    expect(result.complete).toBe(false)
    expect(result.results).toEqual([
      expect.objectContaining({ repository_id: 'a', output: 'clean' }),
      expect.objectContaining({ repository_id: 'b', error: 'Git 查询命令失败或超时。' })
    ])
  })
})
