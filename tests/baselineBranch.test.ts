import { describe, expect, it } from 'vitest'
import type { BranchSummary } from '@shared/types'
import { backfillCachedCreatorEmail, BranchService, creatorEmailFromCommits, creatorEmailFromIdentityChain, isBaselineBranch, resolveRemoteCreator } from '../src-node/services/branch'
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
      if (query.includes('monitoring_rules')) return { stale_threshold_days: 180 }
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
    creator: { name: '张三', email: 'zhang@example.com', emailSource: 'account', firstCommitAt: LONG_AGO, confidence: 'high' },
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
    thresholdDays: 180,
    thresholdUnit: 'days',
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
    expect(main.cleanupCandidate).toBe(false)
  })

  it('keeps develop out of lifecycle scoring even when it is not the repository default branch', () => {
    const [develop] = branchService([row(cachedBranch({ name: 'develop', displayName: 'develop', baseBranch: 'main' }))]).listBranches()
    expect(develop.state).toBe('active')
    expect(develop.stale).toBe(false)
  })

  it('still marks an ordinary long-idle branch as stale so the fix does not mute real findings', () => {
    const [feature] = branchService([row(cachedBranch({}))]).listBranches()
    expect(feature.state).toBe('stale')
    expect(feature.stale).toBe(true)
    expect(feature.cleanupCandidate).toBe(true)
  })
})

describe('cached branch snapshots never invent creator emails', () => {
  it('clears an old creator email when the snapshot has no verified source', () => {
    const cached = cachedBranch({
      creator: { name: '张三', email: 'zhang@example.com', emailSource: '', firstCommitAt: LONG_AGO, confidence: 'high' },
      lastAuthor: '张三',
      lastAuthorEmail: 'zhang@example.com'
    })
    expect(backfillCachedCreatorEmail(cached).creator).toMatchObject({
      name: '张三',
      email: '',
      emailSource: '',
      confidence: 'medium'
    })
  })

  it('does not recover an address from a commit authored under the same name', () => {
    const cached = cachedBranch({
      creator: { name: '李四', email: '', emailSource: '', firstCommitAt: LONG_AGO, confidence: 'medium' },
      lastAuthor: '张三',
      lastAuthorEmail: 'zhang@example.com',
      recentCommits: [
        { sha: '1', shortSha: '1', authorName: '李四', authorEmail: 'li@example.com', committedAt: LONG_AGO, subject: 'init' },
        { sha: '2', shortSha: '2', authorName: '张三', authorEmail: 'zhang@example.com', committedAt: LONG_AGO, subject: 'update' }
      ]
    })
    expect(backfillCachedCreatorEmail(cached).creator.email).toBe('')
  })

  it('retains an address explicitly verified from the forge account', () => {
    const cached = cachedBranch({
      creator: {
        name: '张三',
        email: 'zhang@example.com',
        emailSource: 'account',
        emailResolution: { status: 'verified-account', retryable: false, checkedAt: LONG_AGO },
        firstCommitAt: LONG_AGO,
        confidence: 'high'
      }
    })
    expect(backfillCachedCreatorEmail(cached).creator).toMatchObject({
      email: 'zhang@example.com',
      emailSource: 'account',
      confidence: 'high'
    })
  })

  it('clears an account-marked address when the address itself is invalid', () => {
    const cached = cachedBranch({
      creator: { name: '张三', email: 'not-an-email', emailSource: 'account', firstCommitAt: LONG_AGO, confidence: 'high' }
    })
    expect(backfillCachedCreatorEmail(cached).creator).toMatchObject({
      name: '张三',
      email: '',
      emailSource: '',
      confidence: 'medium'
    })
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

  it('does not infer the creator from a branch-only commit', () => {
    const { creator } = resolveRemoteCreator(commit() as never, null)
    expect(creator).toMatchObject({ name: 'Unknown', email: '', emailSource: '', firstCommitAt: null, confidence: 'unknown' })
  })

  it('uses the forge creation event when the branch has no commits of its own', () => {
    const { creator } = resolveRemoteCreator(null, {
      name: '王五',
      email: 'wang@example.com',
      username: 'wangwu',
      accountId: '7',
      createdAt: '2026-02-02T00:00:00.000Z',
      source: 'event',
      emailSource: 'account',
      emailResolution: { status: 'verified-account', retryable: false, checkedAt: '2026-02-02T00:00:00.000Z' }
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
      accountId: '8',
      createdAt: null,
      source: 'event',
      emailSource: '',
      emailResolution: { status: 'account-email-hidden', retryable: false, checkedAt: '2026-01-01T00:00:00.000Z' }
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

  it('always prefers the Activity creation event over commit identities', () => {
    const { creator } = resolveRemoteCreator(commit({ author_email: 'real@example.com' }) as never, {
      name: '王五',
      email: '',
      username: 'wangwu',
      createdAt: null,
      source: 'event',
      emailSource: ''
    })
    expect(creator.email).toBe('')
    expect(creator.confidence).toBe('medium')
  })

  it('drops an account source when the address is invalid', () => {
    const { creator } = resolveRemoteCreator(null, {
      name: '王五',
      email: 'not-an-email',
      emailSource: 'account',
      username: 'wangwu',
      createdAt: null,
      source: 'event'
    })
    expect(creator).toMatchObject({
      name: '王五',
      email: '',
      emailSource: '',
      confidence: 'medium'
    })
  })
})

describe('creatorEmailFromCommits', () => {
  const event = {
    name: 'Octo Cat',
    email: '',
    username: 'octocat',
    createdAt: '2026-03-01T00:00:00.000Z',
    source: 'event' as const,
    emailSource: '' as const
  }

  it('accepts a commit email when the forge resolved it to the creator login', () => {
    const email = creatorEmailFromCommits(event, [{
      id: 'sha-1',
      short_id: 'sha-1',
      title: 'first',
      message: 'first',
      created_at: '2026-03-01T00:00:00.000Z',
      authored_date: '2026-03-01T00:00:00.000Z',
      committed_date: '2026-03-01T00:00:00.000Z',
      author_name: 'Octo Cat',
      author_email: 'octocat@example.com',
      author_login: 'octocat',
      committer_name: 'Octo Cat',
      committer_email: 'octocat@example.com',
      committer_login: 'octocat',
      web_url: ''
    }] as never)
    expect(email).toEqual({ email: 'octocat@example.com', source: 'commit' })
  })

  it('rejects a same-named commit from a different account', () => {
    const email = creatorEmailFromCommits(event, [{
      id: 'sha-1',
      short_id: 'sha-1',
      title: 'first',
      message: 'first',
      created_at: '2026-03-01T00:00:00.000Z',
      authored_date: '2026-03-01T00:00:00.000Z',
      committed_date: '2026-03-01T00:00:00.000Z',
      author_name: 'Octo Cat',
      author_email: 'stranger@example.com',
      author_login: 'stranger',
      committer_name: 'Octo Cat',
      committer_email: 'stranger@example.com',
      committer_login: 'stranger',
      web_url: ''
    }] as never)
    expect(email).toEqual({ email: '', source: '' })
  })

  it('rejects commits when the creation event has no username', () => {
    const email = creatorEmailFromCommits({ ...event, username: '' }, [{
      id: 'sha-1',
      short_id: 'sha-1',
      title: 'first',
      message: 'first',
      created_at: '2026-03-01T00:00:00.000Z',
      authored_date: '2026-03-01T00:00:00.000Z',
      committed_date: '2026-03-01T00:00:00.000Z',
      author_name: 'Octo Cat',
      author_email: 'octocat@example.com',
      committer_name: 'Octo Cat',
      committer_email: 'octocat@example.com',
      web_url: ''
    }] as never)
    expect(email).toEqual({ email: '', source: '' })
  })
})

describe('creatorEmailFromIdentityChain', () => {
  const event = {
    name: 'Octo Cat',
    email: '',
    username: 'octocat',
    createdAt: null,
    source: 'event' as const,
    emailSource: '' as const
  }

  it('rejects a legacy first-commit signature that is not platform evidence', () => {
    const result = creatorEmailFromIdentityChain(
      { name: 'Octo Cat', email: '', emailSource: '', firstCommitAt: null, confidence: 'medium' },
      event,
      {
        id: 'sha-1', short_id: 'sha-1', title: '', message: '', created_at: '', authored_date: '', committed_date: '',
        author_name: 'Octo Cat', author_email: 'octocat@example.com', committer_name: 'Octo Cat', committer_email: '', web_url: ''
      } as never,
      new Map()
    )
    expect(result).toEqual({ email: '', source: '' })
  })

  it('rejects a same-named first commit from a different login', () => {
    const result = creatorEmailFromIdentityChain(
      { name: 'Octo Cat', email: '', emailSource: '', firstCommitAt: null, confidence: 'medium' },
      event,
      {
        id: 'sha-1', short_id: 'sha-1', title: '', message: '', created_at: '', authored_date: '', committed_date: '',
        author_name: 'Octo Cat', author_email: 'stranger@example.com', author_login: 'stranger',
        committer_name: 'Octo Cat', committer_email: '', web_url: ''
      } as never,
      new Map()
    )
    expect(result).toEqual({ email: '', source: '' })
  })

  it('uses the verified account email from the last-author chain', () => {
    const result = creatorEmailFromIdentityChain(
      { name: 'Octo Cat', email: '', emailSource: '', firstCommitAt: null, confidence: 'medium' },
      event,
      null,
      new Map([['octocat', 'profile@example.com']])
    )
    expect(result).toEqual({
      email: 'profile@example.com',
      source: 'account',
      resolution: { status: 'verified-account', retryable: false, checkedAt: expect.any(String) }
    })
  })
})

describe('isBaselineBranch', () => {
  it('treats main and develop as baseline branches so they never join stale counting', () => {
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
