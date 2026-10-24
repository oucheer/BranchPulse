import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BranchSummary, Repository } from '@shared/types'
import { ReportService } from '../src-node/services/report'
import type { BranchService } from '../src-node/services/branch'
import type { RepositoryService } from '../src-node/services/repository'
import type { AuditService } from '../src-node/services/audit'

let workDir: string
let previousUserData: string | undefined

function branch(name: string, repositoryId: string): BranchSummary {
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
    naming: { status: name.includes('bad') ? 'invalid' : 'valid' },
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

const REPOS: Repository[] = ['repo-1', 'repo-2'].map((id) => ({
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
}))

const BRANCHES = [branch('feature/one', 'repo-1'), branch('feature/bad-name', 'repo-2')]

function buildService(): ReportService {
  const reportRows: Array<Record<string, unknown>> = []
  const storage = {
    all: (query: string) => (query.includes('reports') ? reportRows : []),
    insert: vi.fn((table: string, row: Record<string, unknown>) => {
      if (table === 'reports') reportRows.push(row)
    })
  } as unknown as import('../src-node/services/storage').StorageService
  return new ReportService(
    storage,
    { listBranches: () => BRANCHES } as unknown as BranchService,
    { list: () => REPOS } as unknown as RepositoryService,
    { record: vi.fn() } as unknown as AuditService
  )
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-report-partitions-'))
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'profile')
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('partitioned report files', () => {
  it('creates a compact email body beside the full HTML report', async () => {
    const service = buildService()
    const report = await service.generateReport('manual', 'html', undefined, ['repo-1', 'repo-2'])
    expect(report.emailPath).toBe(`${report.path}.email.html`)
    const full = fs.readFileSync(report.path, 'utf8')
    const email = fs.readFileSync(report.emailPath!, 'utf8')
    expect(full).toContain('仓库：repo-1')
    expect(full).toContain('仓库：repo-2')
    expect(full).toContain('管理总览')
    expect(email).toContain('仓库：repo-1')
    expect(email.length).toBeLessThan(full.length)
  })
})
