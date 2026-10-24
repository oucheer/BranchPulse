import { describe, expect, it, vi } from 'vitest'
import type { BranchSummary, EmailPolicy, Repository } from '@shared/types'
import { MonitoringService } from '../src-node/services/monitoring'
import type { BranchService } from '../src-node/services/branch'
import type { AuditService } from '../src-node/services/audit'
import type { EmailService, EmailSummaryData } from '../src-node/services/email'
import type { RepositoryService } from '../src-node/services/repository'
import type { StorageService } from '../src-node/services/storage'

function repository(id: string, name: string): Repository {
  return {
    id,
    name,
    path: `/repos/${id}`,
    source: 'gitlab',
    currentBranch: 'main',
    defaultBranch: 'main',
    remotes: [],
    lastFetchAt: null,
    lastScanAt: null,
    totalBranches: 1,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function branch(repositoryId: string, repositoryName: string, name: string): BranchSummary {
  return {
    id: `${repositoryId}:${name}`,
    repositoryId,
    repositoryName,
    name,
    displayName: name,
    type: 'remote',
    existsLocally: false,
    existsRemotely: true,
    isHead: false,
    creator: { name: '张三', email: 'zhangsan@example.com', emailSource: 'account', firstCommitAt: null, confidence: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastCommitAt: '2026-01-01T00:00:00.000Z',
    lastCommitSha: 'sha',
    lastAuthor: '张三',
    commitCount: 1,
    ahead: 0,
    behind: 0,
    merged: false,
    mergedInto: null,
    baseBranch: 'main',
    inactiveDays: 200,
    ageDays: 200,
    naming: { status: 'valid' },
    health: { score: 70, level: 'good', factors: [] },
    protection: { whitelisted: false, isDefault: false, protected: false, rules: [] },
    state: 'stale',
    stale: true,
    thresholdDays: 180,
    thresholdUnit: 'days',
    cleanupCandidate: false,
    recentCommits: [],
    lastScannedAt: '2026-01-01T00:00:00.000Z'
  }
}

interface MonitoringRow {
  enabled?: number
  fetch_enabled?: number
  notification_enabled?: number
  email_policy?: EmailPolicy
  notify_target?: string
  stale_threshold_days?: number
}

function setup(options: {
  selected?: string[]
  rows?: Record<string, MonitoringRow>
  policies?: Record<string, EmailPolicy>
} = {}): {
  service: MonitoringService
  scanRepository: ReturnType<typeof vi.fn>
  summaries: EmailSummaryData[]
  creatorCalls: unknown[]
} {
  const repos = [repository('repo-1', 'Alpha'), repository('repo-2', 'Beta')]
  const rows = options.rows ?? {}
  const policies = options.policies ?? {}
  const summaries: EmailSummaryData[] = []
  const creatorCalls: unknown[] = []
  const storage = {
    get: (query: string, params?: unknown[]) => {
      if (!query.includes('monitoring_rules_repo')) return undefined
      const id = String(params?.[0] ?? '')
      return {
        enabled: 1,
        fetch_enabled: 1,
        notification_enabled: 0,
        email_policy: policies[id] ?? 'none',
        notify_target: 'self',
        stale_threshold_days: 180,
        ...rows[id]
      }
    },
    selectedRepositoryIds: () => options.selected ?? ['repo-1', 'repo-2'],
    all: () => [],
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  } as unknown as StorageService
  const scanRepository = vi.fn(async (id: string) => {
    const repo = repos.find((item) => item.id === id)!
    return [branch(repo.id, repo.name, `feature/${repo.name.toLowerCase()}`)]
  })
  const email = {
    getConfig: () => ({ enabled: true, selfEmail: 'owner@example.com', testRecipient: '', username: 'owner@example.com' }),
    listGroups: () => [],
    sendSummaryEmail: async (data: EmailSummaryData) => {
      summaries.push(data)
      return { ok: true, message: 'sent', emailsSent: 1 }
    },
    sendCreatorEmails: async (rowsToSend: unknown) => {
      creatorCalls.push(rowsToSend)
      return { ok: true, message: 'sent', emailsSent: 1 }
    }
  } as unknown as EmailService
  const service = new MonitoringService(
    storage,
    { scanRepository } as unknown as BranchService,
    { list: () => repos, get: (id: string) => repos.find((repo) => repo.id === id) } as unknown as RepositoryService,
    email,
    { record: vi.fn() } as unknown as AuditService
  )
  return { service, scanRepository, summaries, creatorCalls }
}

describe('multi-repository monitoring', () => {
  it('scans every selected repository with its own fetch setting and labels mail rows', async () => {
    const { service, scanRepository, summaries } = setup({
      rows: {
        'repo-1': { fetch_enabled: 0, stale_threshold_days: 30 },
        'repo-2': { fetch_enabled: 1, stale_threshold_days: 180 }
      }
    })

    const run = await service.runCheckNow()

    expect(scanRepository).toHaveBeenCalledTimes(2)
    expect(scanRepository.mock.calls[0][1]).toMatchObject({ fetch: false })
    expect(scanRepository.mock.calls[1][1]).toMatchObject({ fetch: true })
    expect(run.repositoryIds).toEqual(['repo-1', 'repo-2'])
    expect(run.repositories).toBe(2)
    expect(run.branches).toBe(2)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].repositories).toBe(2)
    expect(summaries[0].branches.map((row) => row.repository)).toEqual(['Alpha', 'Beta'])
    expect(summaries[0].thresholdHint).toContain('Alpha')
    expect(summaries[0].thresholdHint).toContain('Beta')
  })

  it('does not let a disabled first repository block the second repository', async () => {
    const { service, scanRepository, summaries } = setup({
      rows: { 'repo-1': { enabled: 0 }, 'repo-2': { enabled: 1 } }
    })

    const run = await service.runCheckNow()

    expect(scanRepository).toHaveBeenCalledTimes(1)
    expect(scanRepository).toHaveBeenCalledWith('repo-2', expect.anything())
    expect(run.repositoryIds).toEqual(['repo-2'])
    expect(run.repositories).toBe(1)
    expect(run.branches).toBe(1)
    expect(summaries[0].branches.map((row) => row.repository)).toEqual(['Beta'])
  })

  it('never expands an explicitly empty selection to every repository', async () => {
    const { service, scanRepository } = setup({ selected: [] })

    const run = await service.runCheckNow()

    expect(scanRepository).not.toHaveBeenCalled()
    expect(run.repositoryIds).toEqual([])
    expect(run.repositories).toBe(0)
    expect(run.branches).toBe(0)
  })

  it('merges per-repository mail policies while sending one shared summary', async () => {
    const { service, summaries, creatorCalls } = setup({
      rows: {
        'repo-1': { notify_target: '' },
        'repo-2': { notify_target: '' }
      },
      policies: { 'repo-1': 'summary', 'repo-2': 'creators' }
    })

    await service.runCheckNow()

    expect(summaries).toHaveLength(1)
    expect(summaries[0].branches.map((row) => row.repository)).toEqual(['Alpha', 'Beta'])
    expect(creatorCalls).toHaveLength(1)
  })

  it('does not send mail for a single-repository scan even when a policy exists', async () => {
    const { service, summaries, creatorCalls } = setup({
      rows: { 'repo-1': { notify_target: 'self,creator' } },
      policies: { 'repo-1': 'summary' }
    })

    const run = await service.runCheckNow({
      repositoryIds: ['repo-1'],
      trigger: 'scan_repository',
      bypassEnabledCheck: true,
      emailPolicy: 'summary',
      notifyTarget: 'self,creator'
    })

    expect(run.repositoryIds).toEqual(['repo-1'])
    expect(summaries).toHaveLength(0)
    expect(creatorCalls).toHaveLength(0)
  })
})
