import { describe, expect, it, vi } from 'vitest'
import type { BranchSummary, EmailGroup, EmailPolicy, NotifyTarget, Repository } from '@shared/types'
import { MonitoringService } from '../src-node/services/monitoring'
import type { BranchService } from '../src-node/services/branch'
import type { EmailService, EmailSummaryData } from '../src-node/services/email'
import type { GroupService } from '../src-node/services/groups'
import type { RepositoryService } from '../src-node/services/repository'
import type { StorageService } from '../src-node/services/storage'
import type { AuditService } from '../src-node/services/audit'

/**
 * 监控检查里的组名收件人是**通知范围**，不是检查范围。
 *
 * 两种情况下用户希望选分组：
 *   1. 只检查分组内成员的分支 —— 走 RunCheckOptions.groupIds（「分组范围」）；
 *   2. 检查全部分支、只通知分组内成员 —— 走 notifyTarget 里的组名 token。
 *
 * 情况 2 里邮件内容必须是**本次检查的全部分支**。很容易在以后被顺手改回
 * 「按组过滤再发」，把组员看到的范围悄悄缩小，所以用测试锁住。
 */

function branch(name: string, creatorName: string, creatorEmail: string): BranchSummary {
  return {
    id: name,
    repositoryId: 'repo-1',
    repositoryName: 'demo',
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

const PAYMENT_GROUP: EmailGroup = {
  id: 'group-1',
  name: '支付组',
  recipients: 'payment@example.com',
  members: [{ name: '张三', email: 'zhangsan@example.com' }],
  createdAt: '2026-01-01T00:00:00.000Z'
}

function setup(notifyTarget: NotifyTarget, emailPolicy: EmailPolicy = 'none'): {
  service: MonitoringService
  summaries: EmailSummaryData[]
  groupCalls: EmailSummaryData[]
  activities: string[]
} {
  const branches = [branch('feature/login', '张三', 'zhangsan@example.com'), branch('bugfix/crash', '李四', 'lisi@example.com')]
  const summaries: EmailSummaryData[] = []
  const groupCalls: EmailSummaryData[] = []

  const storage = {
    get: (query: string) =>
      query.includes('monitoring_rules')
        ? { enabled: 1, email_policy: emailPolicy, notify_target: notifyTarget, notification_enabled: 0 }
        : undefined,
    all: () => [],
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  } as unknown as StorageService

  const branchService = { scanRepository: async () => branches } as unknown as BranchService
  const repository = { list: () => [{ id: 'repo-1', name: 'demo' } as Repository] } as unknown as RepositoryService
  const email = {
    getConfig: () => ({ enabled: true, selfEmail: 'owner@example.com', testRecipient: '', username: 'notify@example.com' }),
    listGroups: () => [PAYMENT_GROUP],
    sendSummaryEmail: async (data: EmailSummaryData, _config?: unknown, recipients?: string[]): Promise<unknown> => {
      summaries.push({ ...data, ...(recipients ? { thresholdHint: recipients.join('|') } : {}) })
      return { ok: true, message: 'sent', emailsSent: 1 }
    },
    // 「通知分支创始人」走创始人邮件，与分组邮件是两条独立路径。
    sendCreatorEmails: async (): Promise<unknown> => ({ ok: true, message: 'sent', emailsSent: 1 })
  } as unknown as EmailService
  const groups = {
    emailSummaryToGroup: async (_group: EmailGroup, data: EmailSummaryData) => {
      groupCalls.push(data)
      return { ok: true, message: 'sent', sent: 1 }
    }
  } as unknown as GroupService
  const audit = { record: vi.fn() } as unknown as AuditService

  const service = new MonitoringService(storage, branchService, repository, email, audit, groups)
  const activities: string[] = []
  service.onProgress = (progress) => { activities.push(...progress.activity.map((item) => item.message)) }
  return { service, summaries, groupCalls, activities }
}

describe('monitoring check with a group recipient', () => {
  it('sends the whole check result to the group members without narrowing the check', async () => {
    const { service, summaries, groupCalls } = setup('支付组')
    await service.runCheckNow({ bypassEnabledCheck: true })
    // 只勾组名时不发整仓汇总（收件人列表里没有普通邮箱），但组员要拿到全部 2 个分支。
    expect(summaries).toHaveLength(0)
    expect(groupCalls).toHaveLength(1)
    expect(groupCalls[0].total).toBe(2)
    expect(groupCalls[0].branches.map((item) => item.branch)).toEqual(['feature/login', 'bugfix/crash'])
  })

  it('keeps the plain address in the whole-repository summary and still mails the group', async () => {
    const { service, summaries, groupCalls } = setup('支付组, boss@example.com')
    await service.runCheckNow({ bypassEnabledCheck: true })
    expect(summaries).toHaveLength(1)
    // 汇总里只包含真实邮箱，组名不参与汇总收件人。
    expect(summaries[0].thresholdHint).toBe('boss@example.com')
    expect(groupCalls).toHaveLength(1)
  })

  it('still notifies self and expands the group when both are selected', async () => {
    const { service, summaries } = setup('self, 支付组')
    await service.runCheckNow({ bypassEnabledCheck: true })
    expect(summaries[0].thresholdHint).toBe('owner@example.com')
  })

  it('sends creator emails without touching group mail when only "notify creators" is selected', async () => {
    const { service, summaries, groupCalls } = setup('creator')
    await service.runCheckNow({ bypassEnabledCheck: true })
    expect(summaries).toHaveLength(0)
    expect(groupCalls).toHaveLength(0)
  })

  it('narrows the checked branches when a group scope is passed', async () => {
    const { service, summaries, groupCalls } = setup('支付组')
    await service.runCheckNow({ bypassEnabledCheck: true, groupIds: ['group-1'] })
    // 情况 1（分组范围）+ 情况 2（组名收件人）叠加：查这个组，也只发给这个组。
    expect(summaries).toHaveLength(0)
    expect(groupCalls).toHaveLength(1)
    expect(groupCalls[0].total).toBe(1)
    expect(groupCalls[0].branches.map((item) => item.branch)).toEqual(['feature/login'])
  })
})
