import { describe, expect, it } from 'vitest'
import type { BranchSummary } from '@shared/types'
import { BranchService, isBaselineBranch, resolveRemoteCreator } from '../src-node/services/branch'
import { HealthService } from '../src-node/services/health'
import { NamingService } from '../src-node/services/naming'
import { ProtectionService } from '../src-node/services/protection'

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

describe('resolveRemoteCreator', () => {
  const commit = (overrides: Record<string, unknown> = {}) => ({
    id: 'sha-1',
    short_id: 'sha-1',
    title: 'first',
    message: 'first',
    created_at: '2026-01-01T00:00:00.000Z',
    authored_date: '2026-01-01T00:00:00.000Z',
    committed_date: '2026-01-01T00:00:00.000Z',
    author_name: '李四',
    author_email: 'li@example.com',
    committer_name: '李四',
    committer_email: 'li@example.com',
    web_url: '',
    ...overrides
  })

  it('attributes the branch to its first own commit with high confidence', () => {
    const { creator } = resolveRemoteCreator(commit() as never, null)
    expect(creator.name).toBe('李四')
    expect(creator.email).toBe('li@example.com')
    expect(creator.confidence).toBe('high')
  })

  it('uses the forge creation event when the branch has no commits of its own', () => {
    const { creator } = resolveRemoteCreator(null, {
      name: '王五',
      email: 'wang@example.com',
      username: 'wangwu',
      createdAt: '2026-02-02T00:00:00.000Z',
      source: 'event'
    })
    expect(creator.name).toBe('王五')
    expect(creator.email).toBe('wang@example.com')
    expect(creator.firstCommitAt).toBe('2026-02-02T00:00:00.000Z')
    expect(creator.confidence).toBe('high')
  })

  it('keeps the creator name but downgrades confidence when the event has no public email', () => {
    // GitLab frequently returns an empty public_email, so the name is still
    // correct while mail delivery is not possible.
    const { creator } = resolveRemoteCreator(null, {
      name: '赵六',
      email: '',
      username: 'zhaoliu',
      createdAt: null,
      source: 'event'
    })
    expect(creator.name).toBe('赵六')
    expect(creator.email).toBe('')
    expect(creator.confidence).toBe('medium')
  })

  it('never invents a creator when there are no commits and no creation event', () => {
    // The reported bug: this used to return the base branch's last committer.
    const { creator } = resolveRemoteCreator(null, null)
    expect(creator.name).toBe('Unknown')
    expect(creator.email).toBe('')
    expect(creator.confidence).toBe('unknown')
  })

  it('prefers the first own commit over the creation event, because only the commit carries an email', () => {
    const { creator } = resolveRemoteCreator(commit({ author_email: 'real@example.com' }) as never, {
      name: '王五',
      email: '',
      username: 'wangwu',
      createdAt: null,
      source: 'event'
    })
    expect(creator.email).toBe('real@example.com')
    expect(creator.confidence).toBe('high')
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
