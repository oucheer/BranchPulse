import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BranchSummary, EmailGroup, Repository } from '@shared/types'
import { ReportService } from '../src-node/services/report'
import type { BranchService } from '../src-node/services/branch'
import type { RepositoryService } from '../src-node/services/repository'
import type { GroupService } from '../src-node/services/groups'
import type { StorageService } from '../src-node/services/storage'
import type { AuditService } from '../src-node/services/audit'

/**
 * 报告的分组范围：`groupIds` 非空时只统计这些组（按分支创始人命中组员）
 * 覆盖的分支，并且这份范围要能落库，导出时不会退化成整仓报告。
 */

let workDir: string
let previousUserData: string | undefined

function branch(name: string, creatorName: string, creatorEmail: string, repositoryId = 'repo-1'): BranchSummary {
  return {
    id: `${repositoryId}:${name}`,
    repositoryId,
    repositoryName: repositoryId,
    name,
    displayName: name,
    type: 'remote',
    existsLocally: false,
    existsRemotely: true,
    isHead: false,
    creator: { name: creatorName, email: creatorEmail, firstCommitAt: null, confidence: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastCommitAt: '2026-01-01T00:00:00.000Z',
    lastCommitSha: 'sha',
    lastAuthor: creatorName,
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

const BRANCHES = [
  branch('feature/login', '张三', 'zhangsan@example.com'),
  branch('bugfix/crash', '李四', 'lisi@example.com'),
  branch('feature/foreign', '张三', 'zhangsan@example.com', 'repo-2')
]

const GROUP: EmailGroup = {
  id: 'group-1',
  name: '支付组',
  recipients: 'payment@example.com',
  members: [{ name: '张三', email: 'zhangsan@example.com' }],
  createdAt: '2026-01-01T00:00:00.000Z'
}

function repository(id: string): Repository {
  return {
    id,
    name: id,
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

const REPOS: Repository[] = [repository('repo-1'), repository('repo-2')]

function buildService(groups: EmailGroup[] = [GROUP]): {
  service: ReportService
  audits: Array<{ action: string; status?: string; detail: Record<string, unknown> }>
  storage: StorageService
} {
  const audits: Array<{ action: string; status?: string; detail: Record<string, unknown> }> = []
  // reports 表用内存数组模拟，导出时 listReports() 才能找回刚生成的记录。
  const reportRows: Array<Record<string, unknown>> = []
  const storage = {
    get: () => ({ active_repository_id: null }),
    all: (query: string) => (query.includes('reports') ? reportRows : []),
    insert: vi.fn((table: string, row: Record<string, unknown>) => {
      if (table === 'reports') reportRows.push(row)
    }),
    update: vi.fn(),
    delete: vi.fn()
  } as unknown as StorageService
  const service = new ReportService(
    storage,
    { listBranches: () => BRANCHES } as unknown as BranchService,
    { list: () => REPOS } as unknown as RepositoryService,
    {
      record: (action: string, detail: Record<string, unknown>, status?: string) =>
        audits.push({ action, detail, status })
    } as unknown as AuditService,
    { list: () => groups } as unknown as GroupService
  )
  return { service, audits, storage }
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-report-scope-'))
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'profile')
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('ReportService group scope', () => {
  it('counts only the branches owned by the selected groups', async () => {
    const { service } = buildService()
    const report = await service.generateReport('manual', 'csv', null, ['group-1'])
    expect(report.summary.totalBranches).toBe(2)
    expect(report.groupIds).toEqual(['group-1'])
    expect(report.title).toContain('支付组')
    const csv = fs.readFileSync(report.path, 'utf8')
    expect(csv).toContain('feature/login')
    expect(csv).not.toContain('bugfix/crash')
  })

  it('keeps the whole-repository scope when no group is selected', async () => {
    const { service, audits } = buildService()
    const report = await service.generateReport('manual', 'csv', null)
    expect(report.summary.totalBranches).toBe(3)
    expect(report.groupIds).toEqual([])
    expect(audits.some((item) => item.action === 'report_group_scope_missing')).toBe(false)
  })

  it('persists the resolved group ids so an export stays scoped', async () => {
    const { service, storage } = buildService()
    const report = await service.generateReport('manual', 'csv', null, ['group-1'])
    expect(storage.insert).toHaveBeenCalledWith('reports', expect.objectContaining({
      group_ids: JSON.stringify(['group-1'])
    }))
    const exported = await service.exportReport(report.id, 'html')
    expect(exported.groupIds).toEqual(['group-1'])
  })

  it('records a failure when every selected group id is unknown', async () => {
    const { service, audits } = buildService()
    const report = await service.generateReport('manual', 'csv', null, ['deleted-group'])
    // 分组不存在时不能静默退回整仓报告。
    expect(report.summary.totalBranches).toBe(0)
    expect(audits.some((item) => item.action === 'report_group_scope_missing' && item.status === 'failure')).toBe(true)
  })
})
