import { describe, expect, it } from 'vitest'
import {
  buildBranchEmailHtml,
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
    expect(processingDeadlineNotice('zh', new Date(2026, 8, 14, 10, 0, 0))).toContain('请在 1 个月内或 2026年10月14号')
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
