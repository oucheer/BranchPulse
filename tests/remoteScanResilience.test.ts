import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BranchSummary, Repository } from '@shared/types'
import type { AuditService } from '../electron/services/audit'
import { BranchService } from '../electron/services/branch'
import type { EmailService } from '../electron/services/email'
import type { GitLabCommitDto } from '../electron/services/gitlab'
import { HealthService } from '../electron/services/health'
import { MonitoringService } from '../electron/services/monitoring'
import { NamingService } from '../electron/services/naming'
import { ProtectionService } from '../electron/services/protection'
import { StorageService } from '../electron/services/storage'

/**
 * 内网实例的远程 API 会偶发抖动：个别分支的 commits / compare 请求超时或报 5xx。
 * 过去的批处理用 `Promise.all`，一个分支失败会让整批 reject，整个仓库因此变成
 * “0 个分支”，看起来就像没权限。这里锁定两条契约：
 *
 *  1. 单个分支失败只跳过该分支，成功分支必须照常入库；
 *  2. 全部分支都失败时抛错（带原因），由上层记为该仓库扫描失败，绝不静默变成 0。
 *
 * 以及监控门控的逐仓隔离：fetch / 通知开关只能作用于自己的仓库。
 */

const REPO_A = 'repo-alpha'
const REPO_B = 'repo-beta'
const REPO_CREATOR_TEST = 'repo-creator-test'

let workDir: string
let storage: StorageService

function repository(id: string, name: string): Repository {
  return {
    id,
    name,
    path: `gitlab://${id}`,
    source: 'gitlab',
    gitlabUrl: 'https://gitlab.example.com',
    remoteProjectPath: `group/${name}`,
    gitlabProjectId: id === REPO_A ? 1 : 2,
    webUrl: `https://gitlab.example.com/group/${name}`,
    currentBranch: 'main',
    defaultBranch: 'main',
    remotes: ['origin'],
    lastFetchAt: null,
    lastScanAt: null,
    totalBranches: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function repositoryService(repositoryId = REPO_A, update = vi.fn()): {
  list: () => Repository[]
  get: (id: string) => Repository | undefined
  getRemoteToken: () => string
  update: typeof update
} {
  const repos = [repository(REPO_A, 'Alpha'), repository(REPO_B, 'Beta'), repository(REPO_CREATOR_TEST, 'Creator Test')]
  return {
    list: () => repos,
    get: (id: string) => repos.find((repo) => repo.id === id),
    getRemoteToken: () => 'token',
    update
  }
}

function remoteCommit(id: string, daysAgo: number): GitLabCommitDto {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  return {
    id,
    short_id: id.slice(0, 8),
    title: `commit ${id}`,
    message: `commit ${id}`,
    created_at: date,
    authored_date: date,
    committed_date: date,
    author_name: '张三',
    author_email: 'zhang@example.com',
    committer_name: '张三',
    committer_email: 'zhang@example.com',
    web_url: ''
  }
}

/** Remote branch list as the forge returns it: `main` plus the given branches. */
function branchDto(name: string): {
  name: string
  protected: boolean
  default: boolean
  merged: boolean
  developers_can_push: boolean
  developers_can_merge: boolean
  can_push: boolean
  web_url: string
  commit: ReturnType<typeof remoteCommit>
} {
  return {
    name,
    protected: false,
    default: name === 'main',
    merged: false,
    developers_can_push: false,
    developers_can_merge: false,
    can_push: false,
    web_url: '',
    commit: remoteCommit(`${name}-tip`, 400)
  }
}

/**
 * Forge stub whose per-branch commit/compare calls fail for `failing` refs, the
 * way a flaky intranet proxy fails a subset of the analysis requests.
 */
function gitlabStub(branchNames: string[], failing: Set<string>): {
  listBranches: () => Promise<ReturnType<typeof branchDto>[]>
  listBranchCreators: () => Promise<Map<string, never>>
  listCommits: (projectId: number, ref: string) => Promise<GitLabCommitDto[]>
  compareCommits: (projectId: number, base: string, ref: string) => Promise<GitLabCommitDto[]>
  fail: (ref: string) => never
} {
  const fail = (ref: string): never => {
    throw new Error(`Remote repository API 500 Internal Server Error: ${ref}`)
  }
  return {
    listBranches: async () => branchNames.map((name) => branchDto(name)),
    listBranchCreators: async () => new Map<string, never>(),
    listCommits: async (_projectId, ref) => {
      if (failing.has(ref)) fail(ref)
      return [remoteCommit(`${ref}-tip`, 400)]
    },
    compareCommits: async (_projectId, _base, ref) => {
      if (failing.has(ref)) fail(ref)
      return [remoteCommit(`${ref}-first`, 400)]
    },
    fail
  }
}

function branchService(gitlab: ReturnType<typeof gitlabStub>, repositoryId = REPO_A): BranchService {
  return new BranchService(
    storage,
    {} as never,
    repositoryService(repositoryId) as never,
    gitlab as never,
    new NamingService(storage),
    new ProtectionService(storage),
    new HealthService(),
    { record: () => undefined } as never,
    { getGitLabToken: () => 'token' } as never
  )
}

function auditStub(): AuditService {
  return { record: vi.fn() } as unknown as AuditService
}

function branchSummary(overrides: Partial<BranchSummary>): BranchSummary {
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
  return {
    id: `branch-${overrides.repositoryId}-${overrides.name}`,
    repositoryId: REPO_A,
    repositoryName: '',
    name: 'feature/x',
    displayName: 'feature/x',
    type: 'remote',
    remote: 'origin',
    existsLocally: false,
    existsRemotely: true,
    isHead: false,
    creator: { name: '张三', email: 'zhang@example.com', firstCommitAt: longAgo, confidence: 'medium' },
    createdAt: longAgo,
    lastCommitAt: longAgo,
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
    lastScannedAt: longAgo,
    ...overrides
  }
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-scan-resilience-'))
  process.env.GITMANAGER_DATA_DIR = workDir
  storage = new StorageService(path.join(workDir, 'resilience.db'))
  await storage.init()
  for (const repo of [repository(REPO_A, 'Alpha'), repository(REPO_B, 'Beta'), repository(REPO_CREATOR_TEST, 'Creator Test')]) {
    storage.insert('repositories', {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      source: repo.source,
      gitlab_url: repo.gitlabUrl,
      gitlab_project_id: repo.gitlabProjectId,
      remote_project_path: repo.remoteProjectPath,
      web_url: repo.webUrl,
      created_at: repo.createdAt
    })
    storage.ensureRepositoryConfiguration(repo.id)
  }
})

afterAll(() => {
  storage.close()
  delete process.env.GITMANAGER_DATA_DIR
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('intranet branch analysis tolerates a flaky subset', () => {
  it('keeps the creator unknown when forge events are unavailable', async () => {
    const gitlab = gitlabStub(['main', 'feature/known'], new Set())
    gitlab.listCommits = async (_projectId, ref) => [
      { ...remoteCommit(`${ref}-tip`, 10), author_name: '', author_email: '', author_login: 'remote-account' }
    ]
    gitlab.compareCommits = async (_projectId, _base, ref) => [
      { ...remoteCommit(`${ref}-first`, 30), author_name: '', author_email: '', author_login: 'remote-account' }
    ]

    const service = branchService(gitlab, REPO_CREATOR_TEST)
    const result = await service.scanRepository(REPO_CREATOR_TEST)
    expect(result.find((branch) => branch.name === 'feature/known')?.creator).toMatchObject({
      name: 'Unknown',
      confidence: 'unknown'
    })
    expect(result.find((branch) => branch.name === 'feature/known')?.lastAuthor).toBe('remote-account')
    expect(result.find((branch) => branch.name === 'main')?.creator).toMatchObject({
      name: 'Unknown',
      confidence: 'unknown'
    })

    const stored = storage.get<{ data_json: string }>(
      'SELECT data_json FROM branches WHERE key = ?',
      [`${REPO_CREATOR_TEST}|remote|feature/known`]
    )
    expect(JSON.parse(stored!.data_json).creator.name).toBe('Unknown')
    expect(service.listBranches([REPO_CREATOR_TEST]).find((branch) => branch.name === 'feature/known')?.creator.name)
      .toBe('Unknown')
  })

  it('rejects a partial scan when one branch fails', async () => {
    const gitlab = gitlabStub(['main', 'feature/ok', 'feature/flaky'], new Set(['feature/flaky']))
    const progress: string[] = []
    await expect(branchService(gitlab).scanRepository(REPO_A, { progress: (message) => progress.push(message) }))
      .rejects.toThrow(/1 个分支分析失败/)

    expect(progress.some((message) => message.includes('1 个分支分析失败'))).toBe(true)
    expect(progress.some((message) => message.includes('feature/flaky'))).toBe(true)
  })

  it('does not replace the cached snapshot with a partial result', async () => {
    const gitlab = gitlabStub(['main', 'feature/ok', 'feature/flaky'], new Set(['feature/flaky']))
    await expect(branchService(gitlab).scanRepository(REPO_A)).rejects.toThrow()

    const rows = storage.all<{ name: string }>(
      'SELECT name FROM branches WHERE repository_id = ? ORDER BY name',
      [REPO_A]
    )
    expect(rows).toEqual([])
  })

  it('re-analyzes cached remote branches from the previous creator-cache version', async () => {
    const key = `${REPO_A}|remote|feature/cached`
    const cached = branchSummary({
      repositoryId: REPO_A,
      repositoryName: 'Alpha',
      name: 'feature/cached',
      displayName: 'feature/cached',
      creator: { name: 'Unknown', email: '', firstCommitAt: null, confidence: 'unknown' },
      lastCommitSha: 'feature/cached-tip'
    })
    storage.insert('branches', {
      id: 'cached-branch',
      key,
      repository_id: REPO_A,
      name: 'feature/cached',
      type: 'remote',
      data_json: JSON.stringify(cached),
      last_scanned_at: new Date().toISOString()
    })
    storage.insert('branch_snapshots', {
      key,
      sha: `v8|feature/cached-tip|unknown|`,
      updated_at: new Date().toISOString()
    })

    const result = await branchService(gitlabStub(['feature/cached'], new Set())).scanRepository(REPO_A)

    expect(result[0].creator).toMatchObject({ name: 'Unknown', email: '', confidence: 'unknown' })
    const row = storage.get<{ data_json: string }>('SELECT data_json FROM branches WHERE key = ?', [key])
    expect(JSON.parse(row!.data_json).creator.name).toBe('Unknown')
  })

  it('still fails loudly when every branch fails, so the run records a reason', async () => {
    const gitlab = gitlabStub(['main', 'feature/ok'], new Set(['main', 'feature/ok']))

    await expect(branchService(gitlab).scanRepository(REPO_A)).rejects.toThrow(/全部分析失败/)
  })
})

describe('monitoring gates are applied per repository', () => {
  function monitoring(): MonitoringService {
    return new MonitoringService(
      storage,
      {
        scanRepository: async (repositoryId: string) => [
          branchSummary({ repositoryId, name: 'feature/stale', stale: true, state: 'stale' })
        ],
        listBranches: () => []
      } as never,
      repositoryService() as never,
      {
        getConfig: () => ({ enabled: false }),
        listGroups: () => [],
        sendSummaryEmail: vi.fn(),
        sendCreatorEmails: vi.fn()
      } as unknown as EmailService,
      auditStub()
    )
  }

  beforeEach(() => {
    storage.run('DELETE FROM notification_history')
    for (const id of [REPO_A, REPO_B]) {
      storage.update(
        'monitoring_rules_repo',
        { enabled: 1, fetch_enabled: 1, notification_enabled: 1, email_policy: 'none', notify_target: 'none' },
        'repository_id = ?',
        [id]
      )
    }
  })

  it('never lets one repository disable or silence another', async () => {
    // Alpha 关闭通知（其余保持开启），Beta 保持通知。
    storage.update('monitoring_rules_repo', { notification_enabled: 0 }, 'repository_id = ?', [REPO_A])

    const run = await monitoring().runCheckNow({ repositoryIds: [REPO_A, REPO_B] })

    const rows = storage.all<{ repository_id: string }>('SELECT repository_id FROM notification_history')
    expect(run.status).toBe('completed')
    // Beta 的通知必须存在，Alpha 的必须不存在——过去两者都由第一个仓库的开关决定。
    expect(rows.map((row) => row.repository_id)).toEqual([REPO_B])
  })

  it('uses each repository fetch switch when no explicit override is given', async () => {
    storage.update('monitoring_rules_repo', { fetch_enabled: 0 }, 'repository_id = ?', [REPO_A])
    const fetchFlags: Array<{ id: string; fetch: boolean | undefined }> = []
    const service = new MonitoringService(
      storage,
      {
        scanRepository: async (repositoryId: string, options: { fetch?: boolean } = {}) => {
          fetchFlags.push({ id: repositoryId, fetch: options.fetch })
          return []
        },
        listBranches: () => []
      } as never,
      repositoryService() as never,
      { getConfig: () => ({ enabled: false }), listGroups: () => [] } as unknown as EmailService,
      auditStub()
    )

    await service.runCheckNow({ repositoryIds: [REPO_A, REPO_B] })

    expect(fetchFlags).toEqual([
      { id: REPO_A, fetch: false },
      { id: REPO_B, fetch: true }
    ])
  })

  it('skips a disabled repository instead of aborting the whole check', async () => {
    storage.update('monitoring_rules_repo', { enabled: 0 }, 'repository_id = ?', [REPO_B])
    const scanned: string[] = []
    const service = new MonitoringService(
      storage,
      {
        scanRepository: async (repositoryId: string) => {
          scanned.push(repositoryId)
          return []
        },
        listBranches: () => []
      } as never,
      repositoryService() as never,
      { getConfig: () => ({ enabled: false }), listGroups: () => [] } as unknown as EmailService,
      auditStub()
    )

    const run = await service.runCheckNow({ repositoryIds: [REPO_A, REPO_B] })

    expect(scanned).toEqual([REPO_A])
    expect(run.status).toBe('completed')
    expect(run.activity.some((item) => item.level === 'warn' && item.message.includes('Beta'))).toBe(true)
  })

  it('still refuses to start when every requested repository has monitoring off', async () => {
    for (const id of [REPO_A, REPO_B]) {
      storage.update('monitoring_rules_repo', { enabled: 0 }, 'repository_id = ?', [id])
    }

    await expect(monitoring().runCheckNow({ repositoryIds: [REPO_A, REPO_B] })).rejects.toThrow('Monitoring is disabled')
  })
})
