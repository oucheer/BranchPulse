import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EmailIssueRow } from '../src-node/services/email'
import { ReportScheduleService } from '../src-node/services/reportSchedule'
import type { EmailService } from '../src-node/services/email'
import type { ReportService } from '../src-node/services/report'
import type { StorageService } from '../src-node/services/storage'
import type { AuditService } from '../src-node/services/audit'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function row(partial: Partial<EmailIssueRow>): EmailIssueRow {
  return {
    repository: 'repo-1',
    branch: 'feature/login',
    creator: '张三',
    creatorEmail: 'zhangsan@example.com',
    creatorEmailSource: 'account',
    lastAuthor: '张三',
    lastAuthorEmail: '',
    lastCommitDate: '2026-01-01',
    inactiveDays: 30,
    namingStatus: 'valid',
    mergeStatus: 'unmerged',
    healthScore: 70,
    state: 'stale',
    cleanupCandidate: false,
    ...partial
  }
}

function service(options: {
  recipients?: EmailIssueRow[]
  emailEnabled?: boolean
} = {}): {
  reports: ReportScheduleService
  sendReportEmail: ReturnType<typeof vi.fn>
  auditRecord: ReturnType<typeof vi.fn>
} {
  const sendReportEmail = vi.fn().mockResolvedValue({
    ok: true,
    message: '报告邮件发送成功。',
    recipients: ['self@example.com'],
    emailsSent: 1
  })
  const auditRecord = vi.fn()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-selected-'))
  tempDirs.push(dir)
  const reportFile = path.join(dir, 'report.html')
  fs.writeFileSync(reportFile, '<html>report</html>', 'utf8')
  const report = {
    generateReport: vi.fn().mockResolvedValue({
      id: 'report-1',
      path: reportFile,
      generatedAt: '2026-09-21T08:00:00.000Z'
    }),
    getSummaryEmailData: vi.fn().mockReturnValue({ branches: options.recipients ?? [] })
  } as unknown as ReportService
  const email = {
    getConfig: () => ({
      enabled: options.emailEnabled ?? true,
      selfEmail: 'self@example.com',
      testRecipient: '',
      username: ''
    }),
    listGroups: () => [],
    sendReportEmail
  } as unknown as EmailService
  const reports = new ReportScheduleService(
    { readEmailLang: () => 'zh' } as unknown as StorageService,
    report,
    email,
    { record: auditRecord } as unknown as AuditService
  )
  return { reports, sendReportEmail, auditRecord }
}

describe('sendSelectedRepositoriesReport', () => {
  it('fails before generating when no repository is selected', async () => {
    const { reports, sendReportEmail, auditRecord } = service()
    const result = await reports.sendSelectedRepositoriesReport('manual', 'self', [])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未选择仓库')
    expect(sendReportEmail).not.toHaveBeenCalled()
    expect(auditRecord).toHaveBeenCalledWith(
      'report_selected_repositories_sent',
      expect.objectContaining({ reason: 'no_repository_selected' }),
      'failure'
    )
  })

  it('does not send when email delivery is disabled', async () => {
    const { reports, sendReportEmail } = service({ emailEnabled: false })
    const result = await reports.sendSelectedRepositoriesReport('manual', 'self', ['repo-1'])
    expect(result.ok).toBe(false)
    expect(sendReportEmail).not.toHaveBeenCalled()
  })

  it('sends one summary email and puts creators in recipients', async () => {
    const { reports, sendReportEmail } = service({
      recipients: [
        row({ creatorEmail: 'zhangsan@example.com' }),
        row({ branch: 'feature/bad', namingStatus: 'invalid', creatorEmail: 'lisi@example.com' })
      ]
    })
    const result = await reports.sendSelectedRepositoriesReport('manual', 'self creator', ['repo-1'])
    expect(result.ok).toBe(true)
    expect(sendReportEmail).toHaveBeenCalledTimes(1)
    expect(sendReportEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ['self@example.com', 'lisi@example.com', 'zhangsan@example.com'],
      subject: expect.stringContaining('分支健康汇总')
    }))
  })

  it('uses creators as recipients when only creator notification is selected', async () => {
    const { reports, sendReportEmail } = service({ recipients: [row({})] })
    await reports.sendSelectedRepositoriesReport('manual', 'creator', ['repo-1'])
    expect(sendReportEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ['zhangsan@example.com']
    }))
  })
})
