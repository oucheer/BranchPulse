import { describe, expect, it } from 'vitest'
import {
  buildBranchEmailHtml,
  creatorScenarioEmail,
  processingDeadlineNotice,
  type EmailIssueRow,
  type EmailSummaryData
} from '../electron/services/email'

const row: EmailIssueRow = {
  repository: 'demo',
  branch: 'feature/login/page',
  creator: '张三',
  creatorEmail: 'zhang@example.com',
  lastCommitDate: '2026-05-01',
  lastCommitAt: '2026-05-01T00:00:00.000Z',
  inactiveDays: 200,
  gracePeriod: 60,
  namingStatus: 'invalid',
  namingRuleName: 'Feature',
  namingReason: '前缀不在允许的前缀内',
  mergeStatus: 'unknown',
  healthScore: 30,
  state: 'grace_period',
  cleanupCandidate: false,
  whitelisted: false,
  protectedBranch: false
}

function summary(overrides: Partial<EmailSummaryData> = {}): EmailSummaryData {
  return {
    total: 1,
    stale: 1,
    gracePeriod: 1,
    graceExpired: 0,
    namingInvalid: 1,
    merged: 0,
    cleanupCandidates: 0,
    repositories: 1,
    generatedAt: '2026-09-14T00:00:00.000Z',
    branches: [row],
    ...overrides
  }
}

describe('processingDeadlineNotice', () => {
  it('gives a one-month deadline counted from the send date', () => {
    expect(processingDeadlineNotice('zh', new Date(2026, 8, 14, 10, 0, 0))).toContain('请在2026年10月14号（从邮件发送当天开始计算1个月的时间点）对分支不合规处进行处理。')
  })

  it('rolls December into the next year', () => {
    expect(processingDeadlineNotice('zh', new Date(2026, 11, 5, 10, 0, 0))).toContain('2027年01月05号')
  })

  it('clamps month-end days to the last day of the target month', () => {
    expect(processingDeadlineNotice('zh', new Date(2026, 0, 31, 10, 0, 0))).toContain('2026年02月28号')
  })

  it('appears in summary emails and generated report HTML', () => {
    expect(buildBranchEmailHtml(summary(), 'zh', 'summary')).toContain('对分支不合规处进行处理')
    expect(buildBranchEmailHtml(summary(), 'en', 'report')).toContain('within 1 month')
  })
})

describe('inspection-only creator emails', () => {
  it('never suggests deleting a branch and marks whitelisted branches as inspection only', () => {
    const idleWhitelisted = { ...row, state: 'stale', whitelisted: true }
    const zh = creatorScenarioEmail([idleWhitelisted], 'idle', 'zh')
    const en = creatorScenarioEmail([idleWhitelisted], 'idle', 'en')

    expect(zh.html).toContain('白名单分支，仅检查')
    expect(zh.html).not.toContain('删除')
    expect(zh.html).not.toContain('自动回收')
    expect(en.html).toContain('Whitelisted; inspection only')
    expect(en.html).not.toMatch(/delete/i)
  })
})

describe('branch report attachment layout', () => {
  const longBranch = 'feature/warehouse-inventory-realtime-synchronization-with-legacy-erp-integration-layer'

  function withBranches(rows: EmailIssueRow[]): EmailSummaryData {
    return summary({ total: rows.length, branches: rows })
  }

  it('renames the stale section to 已停更的分支', () => {
    const html = buildBranchEmailHtml(summary(), 'zh', 'summary')
    expect(html).toContain('已停更的分支')
    expect(html).not.toContain('需要处理的分支')
  })

  it('drops the repository column and groups rows under a repository heading instead', () => {
    const html = buildBranchEmailHtml(withBranches([row]), 'zh', 'report')
    expect(html).toContain('仓库：demo')
    const headers = (html.match(/<th[^>]*>([^<]*)<\/th>/g) ?? []).map((cell) => cell.replace(/<[^>]*>/g, ''))
    expect(headers.length).toBeGreaterThan(0)
    expect(headers).not.toContain('仓库')
  })

  it('keeps long branch names inside the card by wrapping them', () => {
    const html = buildBranchEmailHtml(withBranches([{ ...row, branch: longBranch }]), 'zh', 'report')
    expect(html).toContain('table-layout:fixed')
    expect(html).toContain('word-break:break-all')
    expect(html).toContain(longBranch)
  })
})
