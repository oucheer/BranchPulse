import { describe, expect, it } from 'vitest'
import type { BranchSummary, EmailGroup } from '@shared/types'
import {
  branchBelongsToGroup,
  branchMatchesCreatorOption,
  creatorOptions,
  groupBranchStats,
  groupCoversCreator,
  groupMemberEmails,
  groupMemberNames,
  groupRecipients,
  parseGroupMembers,
  partitionRecipientTokens,
  serializeGroupMembers
} from '@shared/groups'

function branch(overrides: Partial<BranchSummary> & { name?: string } = {}): BranchSummary {
  return {
    id: overrides.name ?? 'b1',
    repositoryId: 'repo-1',
    repositoryName: 'demo',
    name: 'feature/login',
    displayName: 'feature/login',
    type: 'remote',
    existsLocally: false,
    existsRemotely: true,
    isHead: false,
    creator: { name: '张三', email: 'zhangsan@example.com', firstCommitAt: null, confidence: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastCommitAt: '2026-01-01T00:00:00.000Z',
    lastCommitSha: 'abc',
    lastAuthor: '张三',
    commitCount: 1,
    ahead: 0,
    behind: 0,
    merged: false,
    mergedInto: null,
    baseBranch: 'main',
    inactiveDays: 10,
    ageDays: 10,
    naming: { status: 'valid' },
    health: { score: 90, level: 'healthy', factors: [] },
    protection: { whitelisted: false, isDefault: false, protected: false, rules: [] },
    state: 'active',
    stale: false,
    gracePeriodDays: 60,
    thresholdDays: 180,
    thresholdUnit: 'days',
    graceExpired: false,
    cleanupCandidate: false,
    recentCommits: [],
    lastScannedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function group(overrides: Partial<EmailGroup> = {}): EmailGroup {
  return {
    id: 'group-1',
    name: '支付组',
    recipients: '',
    members: [
      { name: '张三', email: 'zhangsan@example.com' },
      { name: '李四', email: 'lisi@example.com' }
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('group member parsing', () => {
  it('accepts both a JSON string and an already parsed array', () => {
    const json = serializeGroupMembers([
      { name: ' 张三 ', email: 'zhangsan@example.com' },
      { name: '张三', email: 'zhangsan@example.com' }
    ])
    // 完全重复的组员只保留一条。
    expect(parseGroupMembers(json)).toEqual([{ name: '张三', email: 'zhangsan@example.com' }])
    expect(parseGroupMembers([{ name: '李四', email: 'lisi@example.com' }])).toEqual([
      { name: '李四', email: 'lisi@example.com' }
    ])
  })

  it('degrades to an empty list instead of throwing on garbage', () => {
    expect(parseGroupMembers('not json')).toEqual([])
    expect(parseGroupMembers({} as never)).toEqual([])
    expect(parseGroupMembers(null)).toEqual([])
    expect(parseGroupMembers('{"a":1}')).toEqual([])
  })

  it('drops entries that carry neither a name nor an address', () => {
    expect(parseGroupMembers([{ name: '', email: '   ' }, { name: '王五', email: '' }])).toEqual([
      { name: '王五', email: '' }
    ])
  })
})

describe('group recipients', () => {
  it('merges member addresses with the extra recipient list without duplicates', () => {
    const target = group({ recipients: 'zhangsan@example.com, team@example.com' })
    expect(groupRecipients(target)).toEqual(['zhangsan@example.com', 'lisi@example.com', 'team@example.com'])
  })

  it('lists member names for display', () => {
    expect(groupMemberNames(group())).toEqual(['张三', '李四'])
    expect(groupMemberEmails(group())).toEqual(['zhangsan@example.com', 'lisi@example.com'])
  })
})

describe('branch ownership rules', () => {
  it('matches a branch when the creator name hits a member', () => {
    expect(branchBelongsToGroup(group(), branch())).toBe(true)
  })

  it('matches a branch when only the creator address hits a member', () => {
    const creatorWithoutName = branch({ creator: { name: '', email: 'lisi@example.com', firstCommitAt: null, confidence: 'high' } })
    expect(branchBelongsToGroup(group(), creatorWithoutName)).toBe(true)
  })

  it('matches names case-insensitively but never fuzzily', () => {
    const upper = group({ members: [{ name: 'ZHANGSAN', email: '' }] })
    expect(groupCoversCreator(upper, { name: 'zhangsan', email: '' })).toBe(true)
    // 不模糊匹配：否则「张三」会连带命中「张三丰」。
    expect(groupCoversCreator(group(), { name: '张三丰', email: '' })).toBe(false)
  })

  it('does not claim branches whose creator is unrelated', () => {
    const other = branch({ creator: { name: '赵六', email: 'zhaoliu@example.com', firstCommitAt: null, confidence: 'high' } })
    expect(branchBelongsToGroup(group(), other)).toBe(false)
  })

  it('treats an empty group as owning nothing', () => {
    const empty = group({ members: [], recipients: '' })
    expect(branchBelongsToGroup(empty, branch())).toBe(false)
  })
})

describe('group branch stats', () => {
  it('counts lifecycle buckets and lists the creators it saw', () => {
    const stats = groupBranchStats([
      branch({ name: 'feature/a' }),
      branch({ name: 'feature/b', state: 'grace_period', stale: true, inactiveDays: 200 }),
      branch({ name: 'feature/c', state: 'grace_expired', stale: true, naming: { status: 'invalid' }, cleanupCandidate: true, creator: { name: '李四', email: 'lisi@example.com', firstCommitAt: null, confidence: 'high' } })
    ])
    expect(stats.total).toBe(3)
    expect(stats.active).toBe(1)
    expect(stats.stale).toBe(2)
    expect(stats.gracePeriod).toBe(1)
    expect(stats.graceExpired).toBe(1)
    expect(stats.namingInvalid).toBe(1)
    expect(stats.cleanupCandidates).toBe(1)
    // 按本地化排序（中文按拼音：李 < 张），不是插入顺序。
    expect(stats.creators).toEqual(['李四', '张三'])
  })

  it('ignores the Unknown placeholder when listing creators', () => {
    const stats = groupBranchStats([branch({ creator: { name: 'Unknown', email: '', firstCommitAt: null, confidence: 'unknown' } })])
    expect(stats.creators).toEqual([])
  })
})

describe('creator options for the people filter', () => {
  it('groups branches by creator and counts them', () => {
    const options = creatorOptions([branch({ name: 'a' }), branch({ name: 'b' }), branch({ name: 'c', creator: { name: '李四', email: 'lisi@example.com', firstCommitAt: null, confidence: 'high' } })])
    expect(options.map((option) => [option.name, option.branches])).toEqual([
      ['张三', 2],
      ['李四', 1]
    ])
  })

  it('matches a branch on either the name or the address', () => {
    const option = { name: '张三', email: 'zhangsan@example.com', branches: 1 }
    expect(branchMatchesCreatorOption(branch(), option)).toBe(true)
    expect(branchMatchesCreatorOption(branch({ creator: { name: '', email: 'zhangsan@example.com', firstCommitAt: null, confidence: 'high' } }), option)).toBe(true)
    expect(branchMatchesCreatorOption(branch({ creator: { name: '李四', email: 'lisi@example.com', firstCommitAt: null, confidence: 'high' } }), option)).toBe(false)
  })

  it('recovers a missing address from a later branch of the same person', () => {
    const options = creatorOptions([
      branch({ name: 'a', creator: { name: '张三', email: '', firstCommitAt: null, confidence: 'high' } }),
      branch({ name: 'b' })
    ])
    expect(options).toHaveLength(1)
    expect(options[0].email).toBe('zhangsan@example.com')
    expect(options[0].branches).toBe(2)
  })
})

describe('partitionRecipientTokens', () => {
  it('separates group names from plain addresses', () => {
    const result = partitionRecipientTokens('支付组, someone@example.com; 支付组', [group()])
    expect(result.matched.map((item) => item.id)).toEqual(['group-1'])
    expect(result.plain).toBe('someone@example.com')
  })

  it('drops the self/creator/both/none keywords, they are toggles instead', () => {
    const result = partitionRecipientTokens('self, creator, both, none, 支付组', [group()])
    expect(result.matched).toHaveLength(1)
    expect(result.plain).toBe('')
  })

  it('keeps an unknown token as a plain address', () => {
    const result = partitionRecipientTokens('未知组, a@b.com', [group()])
    expect(result.matched).toEqual([])
    expect(result.plain).toBe('未知组, a@b.com')
  })

  it('is case-insensitive about the group name', () => {
    const result = partitionRecipientTokens('PAYMENT', [group({ name: 'Payment' })])
    expect(result.matched).toHaveLength(1)
  })
})
