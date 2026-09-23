import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BranchSummary, Repository, SchedulerJob } from '@shared/types'
import type { AuditService } from '../electron/services/audit'
import { BranchService } from '../electron/services/branch'
import type { EmailService } from '../electron/services/email'
import { HealthService } from '../electron/services/health'
import { MonitoringService } from '../electron/services/monitoring'
import { NamingService } from '../electron/services/naming'
import { ProtectionService } from '../electron/services/protection'
import { ReportService } from '../electron/services/report'
import { ReportScheduleService } from '../electron/services/reportSchedule'
import { SchedulerService } from '../electron/services/scheduler'
import { StorageService } from '../electron/services/storage'

/**
 * 多仓库严格隔离：两个仓库可以存在同名分支，但分支列表、扫描统计、
 * 通知去重与报告分区都必须按仓库分别归属，绝不跨仓库合并。
 */

const REPO_A = 'repo-a'
const REPO_B = 'repo-b'
const SHARED_BRANCH = 'feature/shared'
const LONG_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()

let workDir: string
let storage: StorageService

function repository(id: string, name: string): Repository {
  return {
    id,
    name,
    path: `gitlab://${id}`,
    source: 'gitlab',
    remoteProjectPath: `group/${name}`,
    gitlabProjectId: id === REPO_A ? 1 : 2,
    webUrl: `https://gitlab.example.com/group/${name}`,
    currentBranch: 'main',
    defaultBranch: 'main',
    remotes: [],
    lastFetchAt: null,
    lastScanAt: null,
    totalBranches: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function repositoryService(): {
  list: () => Repository[]
  get: (id: string) => Repository | undefined
  getRemoteToken: () => string
  update: () => void
} {
  const repos = [repository(REPO_A, 'Alpha'), repository(REPO_B, 'Beta')]
  return {
    list: () => repos,
    get: (id: string) => repos.find((repo) => repo.id === id),
    getRemoteToken: () => 'token',
    update: () => undefined
  }
}

function branchSummary(overrides: Partial<BranchSummary>): BranchSummary {
  return {
    id: `branch-${overrides.repositoryId}-${overrides.name}`,
    repositoryId: REPO_A,
    repositoryName: '',
    name: 'feature/x',
    displayName: 'origin/feature/x',
    type: 'remote',
    remote: 'origin',
    existsLocally: false,
    existsRemotely: true,
    isHead: false,
    creator: { name: '张三', email: 'zhang@example.com', firstCommitAt: LONG_AGO, confidence: 'medium' },
    createdAt: LONG_AGO,
    lastCommitAt: LONG_AGO,
    lastCommitSha: 'abc',
    lastAuthor: '张三',
    commitCount: 3,
    ahead: 1,
    behind: 0,
    merged: false,
    mergedInto: null,
    baseBranch: 'main',
    inactiveDays: 400,
    ageDays: 400,
    naming: { status: 'valid' },
    health: { score: 100, level: 'healthy', factors: [] },
    protection: { whitelisted: false, isDefault: false, protected: false, rules: [] },
    state: 'active',
    stale: false,
    cleanupCandidate: false,
    recentCommits: [],
    lastScannedAt: LONG_AGO,
    ...overrides
  }
}

function cacheBranch(summary: BranchSummary): void {
  const type = summary.type
  const key = `${summary.repositoryId}|${type}|${summary.name}`
  storage.insert('branches', {
    id: `row-${key}`,
    key,
    repository_id: summary.repositoryId,
    name: summary.name,
    type,
    data_json: JSON.stringify(summary),
    last_scanned_at: LONG_AGO
  })
}

function branchService(): BranchService {
  return new BranchService(
    storage,
    {} as never,
    repositoryService() as never,
    {} as never,
    new NamingService(storage),
    new ProtectionService(storage),
    new HealthService(),
    { record: () => undefined } as never,
    {} as never
  )
}

function auditStub(): AuditService {
  return { record: vi.fn() } as unknown as AuditService
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-isolation-'))
  process.env.GITMANAGER_DATA_DIR = workDir
  storage = new StorageService(path.join(workDir, 'isolation.db'))
  await storage.init()
  for (const repo of [repository(REPO_A, 'Alpha'), repository(REPO_B, 'Beta')]) {
    storage.insert('repositories', {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      source: repo.source,
      gitlab_project_id: repo.gitlabProjectId,
      remote_project_path: repo.remoteProjectPath,
      web_url: repo.webUrl,
      created_at: repo.createdAt
    })
    storage.ensureRepositoryConfiguration(repo.id)
  }
  cacheBranch(branchSummary({ repositoryId: REPO_A, name: SHARED_BRANCH }))
  cacheBranch(branchSummary({ repositoryId: REPO_A, name: 'feature/alpha-only' }))
  // Beta 的分支 100 天未提交：低于默认 180 天阈值，因此不该因为 Alpha 的阈值而被判为已停更。
  cacheBranch(branchSummary({
    repositoryId: REPO_B,
    name: SHARED_BRANCH,
    lastCommitAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
    inactiveDays: 100
  }))
})

afterAll(() => {
  storage.close()
  delete process.env.GITMANAGER_DATA_DIR
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('branch isolation', () => {
  it('returns only the branches of the requested repository, even with identical names', () => {
    const service = branchService()
    const alpha = service.listBranches([REPO_A])
    const beta = service.listBranches([REPO_B])

    expect(alpha.map((branch) => branch.name).sort()).toEqual([SHARED_BRANCH, 'feature/alpha-only'].sort())
    expect(alpha.every((branch) => branch.repositoryId === REPO_A)).toBe(true)
    expect(alpha.every((branch) => branch.repositoryName === 'Alpha')).toBe(true)
    expect(beta.map((branch) => branch.name)).toEqual([SHARED_BRANCH])
    expect(beta[0].repositoryId).toBe(REPO_B)
    expect(beta[0].repositoryName).toBe('Beta')
  })

  it('never falls back to every repository when the selection is empty', () => {
    const service = branchService()
    storage.update('app_settings', { selected_repository_ids_json: '[]' }, 'id = 1')
    expect(service.listBranches()).toEqual([])
    expect(service.listBranches([])).toEqual([])
    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_A]) }, 'id = 1')
    expect(service.listBranches().map((branch) => branch.repositoryId)).toEqual([REPO_A, REPO_A])
  })

  it('refuses direct branch detail access outside the selected scope', async () => {
    const service = branchService()
    const criteria = { repositoryId: REPO_B, name: SHARED_BRANCH, type: 'remote' as const }
    await expect(service.getBranch(criteria, [])).resolves.toBeNull()
    await expect(service.getBranch(criteria, [REPO_A])).resolves.toBeNull()
    await expect(service.getBranch(criteria, [REPO_B])).resolves.toMatchObject({ repositoryId: REPO_B })
  })
})

describe('per-repository configurations', () => {
  it('initializes independent monitoring, naming and protection state for each repository', () => {
    const rulesOf = (repositoryId: string): number =>
      Number(storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM branch_naming_rules WHERE repository_id = ?', [repositoryId])?.n ?? 0)

    expect(storage.get('SELECT repository_id FROM monitoring_rules_repo WHERE repository_id = ?', [REPO_A])).toBeDefined()
    expect(storage.get('SELECT repository_id FROM monitoring_rules_repo WHERE repository_id = ?', [REPO_B])).toBeDefined()
    expect(rulesOf(REPO_A)).toBeGreaterThan(0)
    expect(rulesOf(REPO_B)).toBeGreaterThan(0)

    // 重复初始化不得产生重复规则或重复配置。
    const before = rulesOf(REPO_A)
    storage.ensureRepositoryConfiguration(REPO_A)
    storage.reconcileRepositoryConfigurations()
    expect(rulesOf(REPO_A)).toBe(before)
    expect(storage.all('SELECT repository_id FROM monitoring_rules_repo')).toHaveLength(2)
  })

  it('keeps per-repository thresholds independent', () => {
    storage.update('monitoring_rules_repo', { stale_threshold_days: 30 }, 'repository_id = ?', [REPO_A])
    const service = branchService()
    const alpha = service.listBranches([REPO_A])[0]
    const beta = service.listBranches([REPO_B])[0]

    // Alpha 的阈值被改成 30 天，400 天未提交即为已停更；Beta 仍是默认 180 天。
    expect(alpha.stale).toBe(true)
    expect(beta.stale).toBe(false)
    storage.update('monitoring_rules_repo', { stale_threshold_days: 180 }, 'repository_id = ?', [REPO_A])
  })
})

describe('notification isolation', () => {
  function monitoring(): MonitoringService {
    return new MonitoringService(
      storage,
      { scanRepository: async () => [], listBranches: () => [] } as never,
      repositoryService() as never,
      { getConfig: () => ({}), listGroups: () => [], sendSummaryEmail: vi.fn(), sendCreatorEmails: vi.fn() } as unknown as EmailService,
      auditStub()
    )
  }

  it('creates one notification per repository for the same branch name and scopes the list', async () => {
    const service = monitoring()
    await service.notifyBranch(branchSummary({ repositoryId: REPO_A, name: SHARED_BRANCH, stale: true, state: 'stale' }))
    await service.notifyBranch(branchSummary({ repositoryId: REPO_B, name: SHARED_BRANCH, stale: true, state: 'stale' }))
    // 同仓库同分支同状态重复上报必须去重。
    await service.notifyBranch(branchSummary({ repositoryId: REPO_A, name: SHARED_BRANCH, stale: true, state: 'stale' }))

    const alpha = service.listNotifications([REPO_A])
    const beta = service.listNotifications([REPO_B])

    expect(alpha).toHaveLength(1)
    expect(alpha[0].repositoryId).toBe(REPO_A)
    expect(beta).toHaveLength(1)
    expect(beta[0].repositoryId).toBe(REPO_B)
    expect(service.listNotifications([])).toEqual([])
    // 去重键必须带上仓库 id，否则两个仓库的同名分支会互相吞掉通知。
    expect(storage.all<{ dedup_key: string }>('SELECT dedup_key FROM notification_history').map((row) => row.dedup_key))
      .toEqual([`${REPO_A}|${SHARED_BRANCH}|stale|stale`, `${REPO_B}|${SHARED_BRANCH}|stale|stale`])
  })

  it('rejects marking a notification that belongs to another repository as read', () => {
    const service = monitoring()
    const betaNotification = service.listNotifications([REPO_B])[0]
    expect(() => service.markNotificationRead(betaNotification.id, [REPO_A])).toThrow('该通知不属于当前勾选的仓库。')
    expect(service.listNotifications([REPO_A])[0].read).toBe(false)
  })

  it('clears notifications for the selected repositories only', () => {
    const service = monitoring()
    service.clearNotifications([])
    expect(service.listNotifications([REPO_A])).toHaveLength(1)

    service.clearNotifications([REPO_A])
    expect(service.listNotifications([REPO_A])).toEqual([])
    expect(service.listNotifications([REPO_B])).toHaveLength(1)
  })
})

describe('scan run isolation', () => {
  it('records per-repository branch counts instead of one shared number', async () => {
    const branchesByRepository: Record<string, BranchSummary[]> = {
      [REPO_A]: [
        branchSummary({ repositoryId: REPO_A, name: SHARED_BRANCH }),
        branchSummary({ repositoryId: REPO_A, name: 'feature/alpha-only' })
      ],
      [REPO_B]: [branchSummary({ repositoryId: REPO_B, name: SHARED_BRANCH })]
    }
    const service = new MonitoringService(
      storage,
      {
        scanRepository: async (repositoryId: string) => branchesByRepository[repositoryId] ?? [],
        listBranches: () => []
      } as never,
      repositoryService() as never,
      { getConfig: () => ({}), listGroups: () => [], sendSummaryEmail: vi.fn(), sendCreatorEmails: vi.fn() } as unknown as EmailService,
      auditStub()
    )

    const run = await service.runCheckNow({
      repositoryIds: [REPO_A, REPO_B],
      emailPolicy: 'none',
      notifyTarget: 'none',
      fetch: false
    })

    const rows = storage.all<{ repository_id: string; branches: number }>(
      'SELECT repository_id, branches FROM scan_run_repositories WHERE run_id = ? ORDER BY repository_id',
      [run.id]
    )
    expect(rows).toEqual([
      { repository_id: REPO_A, branches: 2 },
      { repository_id: REPO_B, branches: 1 }
    ])
    expect(run.repositories).toBe(2)
    expect(run.branches).toBe(3)
  })

  it('scans nothing and reports the empty selection instead of every repository', async () => {
    const scanRepository = vi.fn(async () => [] as BranchSummary[])
    const service = new MonitoringService(
      storage,
      { scanRepository, listBranches: () => [] } as never,
      repositoryService() as never,
      { getConfig: () => ({}), listGroups: () => [], sendSummaryEmail: vi.fn(), sendCreatorEmails: vi.fn() } as unknown as EmailService,
      auditStub()
    )

    const run = await service.runCheckNow({ repositoryIds: [], emailPolicy: 'none', notifyTarget: 'none', fetch: false })

    expect(scanRepository).not.toHaveBeenCalled()
    expect(run.repositories).toBe(0)
    expect(run.branches).toBe(0)
    expect(run.activity.some((item) => item.message.includes('未选择仓库'))).toBe(true)
  })
})

describe('report partitioning', () => {
  it('keeps same-named branches in their own repository partition and never merges counts', async () => {
    const branches = [
      branchSummary({ repositoryId: REPO_A, repositoryName: 'Alpha', name: SHARED_BRANCH }),
      branchSummary({ repositoryId: REPO_A, repositoryName: 'Alpha', name: 'feature/alpha-only' }),
      branchSummary({ repositoryId: REPO_B, repositoryName: 'Beta', name: SHARED_BRANCH })
    ]
    const report = new ReportService(
      storage,
      { listBranches: (ids?: string[]) => branches.filter((branch) => (ids ?? []).includes(branch.repositoryId)) } as never,
      repositoryService() as never,
      auditStub()
    )

    const record = await report.generateReport('manual', 'html', [REPO_A, REPO_B])
    const html = fs.readFileSync(record.path, 'utf8')

    // 同名分支如果被合并统计，总数会变成 2。
    expect(record.summary.totalBranches).toBe(3)
    expect(record.summary.repositories).toBe(2)
    expect(record.repositoryIds).toEqual([REPO_A, REPO_B])
    // 每个仓库一个独立分区标题，总汇总另算；同名分支不得共享分区。
    expect(html.match(/>仓库：Alpha<\/h2>/g)).toHaveLength(1)
    expect(html.match(/>仓库：Beta<\/h2>/g)).toHaveLength(1)
    expect(html).toContain('管理总览')
    expect(html).toContain('总分支')
  })

  it('refuses to generate a report when nothing is selected', async () => {
    const report = new ReportService(storage, { listBranches: () => [] } as never, repositoryService() as never, auditStub())
    await expect(report.generateReport('manual', 'html', [])).rejects.toThrow('未选择仓库')
  })

  it('hides report history that reaches beyond the selected repositories', async () => {
    const report = new ReportService(storage, { listBranches: () => [] } as never, repositoryService() as never, auditStub())
    expect(report.listReports([REPO_A, REPO_B])).toHaveLength(1)
    expect(report.listReports([REPO_A])).toEqual([])
    expect(report.listReports([])).toEqual([])
  })
})

describe('scope snapshots', () => {
  it('keeps a scheduler job snapshot when the global selection changes', () => {
    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_A, REPO_B]) }, 'id = 1')
    const scheduler = new SchedulerService(storage, {} as never, auditStub())
    const [saved] = scheduler.saveJob({ name: '快照任务', repositoryIds: [REPO_A] }, [REPO_A, REPO_B])

    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_B]) }, 'id = 1')

    expect(scheduler.listJobs([REPO_B])).toEqual([])
    expect(scheduler.listJobs([REPO_A]).map((job) => job.id)).toEqual([saved.id])
    expect(scheduler.listJobs([REPO_A])[0].repositoryIds).toEqual([REPO_A])
    scheduler.deleteJob(saved.id, [REPO_A, REPO_B])
    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_A, REPO_B]) }, 'id = 1')
  })

  it('never scans anything for a job whose stored scope is empty', async () => {
    const storageStub = {
      all: () => [
        {
          id: 'job-empty',
          repository_id: null,
          repository_ids_json: '[]',
          name: 'empty',
          kind: 'interval',
          enabled: 1,
          interval_minutes: 60,
          days_json: '[]',
          time: '09:00',
          email_policy: 'none',
          fetch_enabled: 1,
          notify_target: 'self',
          created_at: '2026-01-01T00:00:00.000Z'
        }
      ],
      get: () => undefined,
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn()
    } as unknown as StorageService
    const runCheckNow = vi.fn()
    const scheduler = new SchedulerService(storageStub, { runCheckNow } as never, auditStub())

    await expect(scheduler.runSchedulerJob('job-empty')).rejects.toThrow('所选仓库均已关闭监控。')
    expect(runCheckNow).not.toHaveBeenCalled()
  })

  it('keeps a report schedule snapshot when the global selection changes', () => {
    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_A, REPO_B]) }, 'id = 1')
    const schedules = new ReportScheduleService(storage, {} as never, { listGroups: () => [] } as never, auditStub())
    schedules.save({ id: 'schedule-snapshot', name: '快照报告', repositoryIds: [REPO_B] }, [REPO_A, REPO_B])

    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_A]) }, 'id = 1')

    expect(schedules.list([REPO_A])).toEqual([])
    expect(schedules.list([REPO_B]).map((schedule) => schedule.repositoryIds)).toEqual([[REPO_B]])
    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify([REPO_A, REPO_B]) }, 'id = 1')
  })

  it('treats a job that reaches an unselected repository as read-only', () => {
    const scheduler = new SchedulerService(storage, {} as never, auditStub())
    const byName = (jobs: SchedulerJob[], name: string): SchedulerJob => {
      const match = jobs.find((job) => job.name === name)
      if (!match) throw new Error(`job ${name} was not saved`)
      return match
    }
    scheduler.saveJob({ name: 'Beta 任务', repositoryIds: [REPO_B] }, [REPO_A, REPO_B])
    const scopedToBeta = byName(scheduler.listJobs(), 'Beta 任务')
    scheduler.saveJob({ name: 'Alpha 任务', repositoryIds: [REPO_A] }, [REPO_A, REPO_B])
    const scopedToAlpha = byName(scheduler.listJobs(), 'Alpha 任务')

    expect(() => scheduler.saveJob({ id: scopedToBeta.id, name: '改范围' }, [REPO_A])).toThrow('只读')
    expect(() => scheduler.deleteJob(scopedToBeta.id, [REPO_A])).toThrow('只读')
    expect(scheduler.listJobs([REPO_B]).map((job) => job.id)).toEqual([scopedToBeta.id])
    // 一键清空只删除完全被勾选范围覆盖的任务，另一个仓库的任务必须留下。
    expect(() => scheduler.deleteAllJobs([REPO_B])).not.toThrow()
    expect(scheduler.listJobs([REPO_B])).toEqual([])
    expect(scheduler.listJobs([REPO_A]).map((job) => job.id)).toEqual([scopedToAlpha.id])
    scheduler.deleteJob(scopedToAlpha.id, [REPO_A, REPO_B])
  })
})
