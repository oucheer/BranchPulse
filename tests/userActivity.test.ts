import { describe, expect, it, vi } from 'vitest'
import { UserActivityService } from '../src-node/services/userActivity'
import type { Repository, UserSession } from '../shared/types'

class MemoryStorage {
  rows: Array<{ id: string; email: string; repository_id: string; kind: string; data_json: string }> = []
  all = vi.fn((_sql: string, params: unknown[] = []) => {
    const [email, kind] = params.map(String)
    return this.rows.filter((row) => row.email === email && row.kind === kind)
  })
  get = vi.fn((_sql: string, params: unknown[] = []) => {
    const [email, repositoryId, kind] = params.map(String)
    return this.rows.find((row) => row.email === email && row.repository_id === repositoryId && row.kind === kind)
  })
  insert = vi.fn((_table: string, row: Record<string, unknown>) => {
    const stored = { id: String(this.rows.length + 1), ...row } as MemoryStorage['rows'][number]
    this.rows.push(stored)
    return stored.id
  })
  update = vi.fn((_table: string, patch: Record<string, unknown>, _where: string, params: unknown[] = []) => {
    const row = this.rows.find((item) => item.id === String(params[0]))
    if (row) Object.assign(row, patch)
  })
  run = vi.fn()
}

const repository: Repository = {
  id: 'repo-1', name: 'sample', path: '', source: 'github', gitlabProjectId: 9,
  gitlabUrl: 'https://github.com/acme/sample', remoteProjectPath: 'acme/sample', webUrl: '',
  currentBranch: 'main', defaultBranch: 'main', remotes: [], lastFetchAt: null, lastScanAt: null,
  totalBranches: 0, createdAt: '2026-01-01T00:00:00.000Z'
}

const session: UserSession = {
  token: 'session', role: 'user', email: 'person@example.com', username: 'person', accountId: '42',
  source: 'github', gitlabUserId: 42, displayName: '', hasGitlabToken: true, gitlabToken: 'secret'
}

function makeService(storage: MemoryStorage, gitlab: Record<string, unknown>): UserActivityService {
  return new UserActivityService(
    storage as never,
    gitlab as never,
    { list: () => [repository] } as never,
    { listBranches: () => [] } as never,
    {} as never
  )
}

describe('personal activity cache behavior', () => {
  it('does not persist a failed commit request as empty and retries it', async () => {
    const listProjectCommits = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce([{
        id: 'abc123', short_id: 'abc123', title: 'change', committed_date: new Date().toISOString(), web_url: 'https://github.com/acme/sample/commit/abc123'
      }])
    const storage = new MemoryStorage()
    const service = makeService(storage, {
      listProjectCommits,
      commitDiffDetails: vi.fn().mockResolvedValue([{ path: 'src/a.ts', added: 2, removed: 1, patch: '+a\n-b' }]),
      listProjectMergeRequests: vi.fn().mockResolvedValue([])
    })

    const first = await service.getActivity(session, 6)
    expect(first.commits).toHaveLength(0)
    expect(storage.rows.some((row) => row.kind === 'commits:6m')).toBe(false)

    const second = await service.getActivity(session, 6)
    expect(second.commits).toHaveLength(1)
    expect(second.commitDetails[0]?.diffStatus).toBe('loaded')
    expect(second.stats.linesAdded).toBe(2)
    expect(second.stats.fileTypes).toEqual([{ type: 'ts', files: 1, added: 2, removed: 1 }])
    expect(second.stats.topFiles[0]).toMatchObject({ path: 'src/a.ts', commits: 1, added: 2, removed: 1 })
    expect(second.commitDetails[0].files[0].patch).toBe('+a\n-b')
    expect(listProjectCommits).toHaveBeenCalledTimes(2)
  })

  it('uses the requested full time window instead of a last-fetched cursor', async () => {
    const listProjectCommits = vi.fn().mockResolvedValue([])
    const service = makeService(new MemoryStorage(), {
      listProjectCommits,
      commitDiffDetails: vi.fn(),
      listProjectMergeRequests: vi.fn().mockResolvedValue([])
    })
    await service.getActivity(session, 6)
    await service.getActivity(session, 24)
    const shortWindow = String(listProjectCommits.mock.calls[0]?.[2])
    const longWindow = String(listProjectCommits.mock.calls[1]?.[2])
    expect(new Date(longWindow).getTime()).toBeLessThan(new Date(shortWindow).getTime())
  })

  it('retries failed diff lookups without persisting zero totals', async () => {
    const listProjectCommits = vi.fn().mockResolvedValue([{
      id: 'abc123', short_id: 'abc123', title: 'change', committed_date: new Date().toISOString()
    }])
    const commitDiffDetails = vi.fn()
      .mockRejectedValueOnce(new Error('diff unavailable'))
      .mockResolvedValueOnce([{ path: 'src/a.ts', added: 4, removed: 2 }])
    const storage = new MemoryStorage()
    const service = makeService(storage, { listProjectCommits, commitDiffDetails, listProjectMergeRequests: vi.fn().mockResolvedValue([]) })

    const first = await service.getActivity(session, 6)
    expect(first.commitDetails[0]?.diffStatus).toBe('failed')
    expect(storage.rows.some((row) => row.kind === 'commit_diffs:v2')).toBe(false)

    const second = await service.getActivity(session, 6)
    expect(second.commitDetails[0]?.diffStatus).toBe('loaded')
    expect(second.stats.linesAdded).toBe(4)
    expect(commitDiffDetails).toHaveBeenCalledTimes(2)
  })

  it('ignores legacy zero-only diff cache and fetches patches again', async () => {
    const storage = new MemoryStorage()
    storage.rows.push({ id: 'old', email: session.email, repository_id: repository.id, kind: 'commit_diffs', data_json: JSON.stringify([{ sha: 'abc123', added: 0, removed: 0, files: [] }]) })
    const commitDiffDetails = vi.fn().mockResolvedValue([{ path: 'a.ts', added: 1, removed: 0, patch: '+line' }])
    const service = makeService(storage, {
      listProjectCommits: vi.fn().mockResolvedValue([{ id: 'abc123', committed_date: new Date().toISOString() }]),
      commitDiffDetails, listProjectMergeRequests: vi.fn().mockResolvedValue([])
    })
    const result = await service.getActivity(session)
    expect(result.stats.linesAdded).toBe(1)
    expect(commitDiffDetails).toHaveBeenCalledOnce()
    await service.getActivity(session)
    expect(commitDiffDetails).toHaveBeenCalledOnce()
  })
})
