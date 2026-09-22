import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditService } from '../electron/services/audit'
import type { EmailService } from '../electron/services/email'
import type { ReportService } from '../electron/services/report'
import type { StorageService } from '../electron/services/storage'
import { ReportScheduleService, resolveReportRecipients } from '../electron/services/reportSchedule'

/**
 * 报告只汇总「勾选仓库」：范围来自全局勾选或调用方显式传入的集合。
 * 空集合永远表示没有仓库，必须直接失败，绝不能回退成全部仓库。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeReportFile(content = '<html>selected repositories</html>'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmanager-selected-repositories-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'selected.html')
  fs.writeFileSync(file, content, 'utf8')
  return file
}

function service(options: {
  generateReport?: ReturnType<typeof vi.fn>
  sendReportEmail?: ReturnType<typeof vi.fn>
  auditRecord?: ReturnType<typeof vi.fn>
  selectedRepositoryIds?: string[]
  emailEnabled?: boolean
} = {}): {
  service: ReportScheduleService
  generateReport: ReturnType<typeof vi.fn>
  sendReportEmail: ReturnType<typeof vi.fn>
  auditRecord: ReturnType<typeof vi.fn>
} {
  const generateReport = options.generateReport ?? vi.fn()
  const sendReportEmail = options.sendReportEmail ?? vi.fn()
  const auditRecord = options.auditRecord ?? vi.fn()
  const storage = {
    selectedRepositoryIds: () => options.selectedRepositoryIds ?? []
  } as unknown as StorageService
  const instance = new ReportScheduleService(
    storage,
    { generateReport } as unknown as ReportService,
    {
      getConfig: () => ({
        enabled: options.emailEnabled ?? true,
        selfEmail: 'self@example.com',
        testRecipient: '',
        username: ''
      }),
      listGroups: () => [],
      sendReportEmail
    } as unknown as EmailService,
    { record: auditRecord } as unknown as AuditService
  )
  return { service: instance, generateReport, sendReportEmail, auditRecord }
}

describe('resolveReportRecipients', () => {
  it('falls back to the configured self email only for an empty recipient selection', () => {
    const config = { selfEmail: 'self@example.com', testRecipient: '', username: '' }
    expect(resolveReportRecipients('', config)).toEqual(['self@example.com'])
    expect(resolveReportRecipients('none', config)).toEqual([])
  })
})

describe('sendSelectedRepositoriesReport', () => {
  it('never sends anything when no repository is selected', async () => {
    const { service: reports, generateReport, sendReportEmail, auditRecord } = service({ selectedRepositoryIds: [] })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'self')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('未选择仓库')
    expect(generateReport).not.toHaveBeenCalled()
    expect(sendReportEmail).not.toHaveBeenCalled()
    expect(auditRecord).toHaveBeenCalledWith(
      'report_selected_repositories_sent',
      expect.objectContaining({ reason: 'no_repository_selected' }),
      'failure'
    )
  })

  it('treats an explicitly empty scope the same as an empty global selection', async () => {
    const { service: reports, generateReport, sendReportEmail } = service({ selectedRepositoryIds: ['repo-1'] })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'self', [])

    expect(result.ok).toBe(false)
    expect(generateReport).not.toHaveBeenCalled()
    expect(sendReportEmail).not.toHaveBeenCalled()
  })

  it('generates and sends one report for exactly the selected repositories', async () => {
    const reportPath = writeReportFile()
    const generateReport = vi.fn().mockResolvedValue({
      id: 'report-1',
      title: 'Git Branch Health Report - 勾选仓库 (manual)',
      repositoryIds: ['repo-1', 'repo-2'],
      generatedAt: '2026-09-21T08:00:00.000Z',
      period: 'manual',
      format: 'html',
      path: reportPath,
      summary: {
        totalBranches: 12,
        validBranches: 10,
        invalidBranches: 1,
        excludedBranches: 1,
        compliancePercent: 92,
        active: 9,
        stale: 3,
        merged: 0,
        namingViolations: 1,
        cleanupCandidates: 3,
        protectedBranches: 2,
        whitelistedBranches: 1,
        averageHealth: 86,
        repositories: 2
      }
    })
    const sendReportEmail = vi.fn().mockResolvedValue({
      ok: true,
      message: '报告邮件发送成功。',
      recipients: ['self@example.com'],
      emailsSent: 1
    })
    const { service: reports, auditRecord } = service({ generateReport, sendReportEmail })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'self', ['repo-1', 'repo-2'])

    expect(generateReport).toHaveBeenCalledWith('manual', 'html', ['repo-1', 'repo-2'])
    expect(sendReportEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['self@example.com'],
        subject: expect.stringContaining('勾选仓库'),
        attachmentPath: reportPath
      })
    )
    expect(auditRecord).toHaveBeenCalledWith(
      'report_selected_repositories_sent',
      expect.objectContaining({ report: 'report-1', repositoryIds: ['repo-1', 'repo-2'], ok: true }),
      'success'
    )
    expect(result.ok).toBe(true)
    expect(result.emailsSent).toBe(1)
  })

  it('reports a failure instead of sending when email delivery is disabled', async () => {
    const { service: reports, generateReport, sendReportEmail } = service({
      selectedRepositoryIds: ['repo-1'],
      emailEnabled: false
    })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'self')

    expect(result.ok).toBe(false)
    expect(generateReport).not.toHaveBeenCalled()
    expect(sendReportEmail).not.toHaveBeenCalled()
  })
})
