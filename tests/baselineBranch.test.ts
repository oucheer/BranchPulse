import { describe, expect, it } from 'vitest'
import type { BranchSummary } from '@shared/types'
import { BranchService, isBaselineBranch } from '../electron/services/branch'
import { HealthService } from '../electron/services/health'
import { NamingService } from '../electron/services/naming'
import { ProtectionService } from '../electron/services/protection'

const REPO_ID = 'repo-1'
const LONG_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()

/** 最小 fake storage：只实现 BranchService.listBranches 会走到的查询。 */
function fakeStorage(rows: Array<Record<string, unknown>>): unknown {
  return {
    all: (query: string) => (query.includes('FROM branches') ? rows : []),
    get: (query: string) => {
      if (query.includes('monitoring_rules')) return { stale_threshold_days: 180, grace_period_days: 60 }
      return undefined
    }
  }
}

function cachedBranch(overrides: Partial<BranchSummary>): BranchSummary {
  return {
    id: 'branch-1',
    repositoryId: REPO_ID,
    repositoryName: '',
    name: 'feature/legacy',
    displayName: 'feature/legacy',
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
    gracePeriodDays: 60,
    graceExpired: false,
    cleanupCandidate: false,
    recentCommits: [],
    lastScannedAt: LONG_AGO,
    ...overrides
  }
}

function branchService(rows: Array<Record<string, unknown>>): BranchService {
  const storage = fakeStorage(rows)
  return new BranchService(
    storage as never,
    {} as never,
    { list: () => [{ id: REPO_ID, name: 'demo' }] } as never,
    {} as never,
    new NamingService(storage as never),
    new ProtectionService(storage as never),
    new HealthService(),
    { record: () => undefined } as never,
    {} as never
  )
}

function row(branch: BranchSummary): Record<string, unknown> {
  return { data_json: JSON.stringify(branch), repository_id: REPO_ID }
}

describe('baseline branches stay out of lifecycle scoring', () => {
  it('keeps main active even after 400 inactive days, so it leaves stale and cleanup lists', () => {
    const [main] = branchService([row(cachedBranch({ name: 'main', displayName: 'main', baseBranch: 'main' }))]).listBranches()
    expect(main.state).toBe('active')
    expect(main.stale).toBe(false)
    expect(main.graceExpired).toBe(false)
    expect(main.cleanupCandidate).toBe(false)
  })

  it('keeps develop out of lifecycle scoring even when it is not the repository default branch', () => {
    const [develop] = branchService([row(cachedBranch({ name: 'develop', displayName: 'develop', baseBranch: 'main' }))]).listBranches()
    expect(develop.state).toBe('active')
    expect(develop.stale).toBe(false)
  })

  it('still marks an ordinary long-idle branch as stale so the fix does not mute real findings', () => {
    const [feature] = branchService([row(cachedBranch({}))]).listBranches()
    expect(feature.state).toBe('grace_expired')
    expect(feature.stale).toBe(true)
    expect(feature.cleanupCandidate).toBe(true)
  })
})

describe('isBaselineBranch', () => {
  it('treats main and develop as baseline branches so they never join stale or grace-period counting', () => {
    expect(isBaselineBranch('main', 'main')).toBe(true)
    expect(isBaselineBranch('develop', 'main')).toBe(true)
    expect(isBaselineBranch('Main', 'main')).toBe(true)
    expect(isBaselineBranch('DEVELOP', 'main')).toBe(true)
  })

  it('treats the repository default branch as baseline even when it is not main or develop', () => {
    expect(isBaselineBranch('trunk', 'trunk')).toBe(true)
    expect(isBaselineBranch('release/1.x', 'release/1.x')).toBe(true)
  })

  it('keeps ordinary feature branches eligible for lifecycle scoring', () => {
    expect(isBaselineBranch('feature/login', 'main')).toBe(false)
    expect(isBaselineBranch('maintenance/patch', 'main')).toBe(false)
    expect(isBaselineBranch('feature/login', null)).toBe(false)
  })
})
