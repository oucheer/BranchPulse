import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditService } from '../electron/services/audit'
import type { EmailService } from '../electron/services/email'
import type { ReportService } from '../electron/services/report'
import type { StorageService } from '../electron/services/storage'
import { ReportScheduleService, resolveReportRecipients } from '../electron/services/reportSchedule'
import { resolveReportRepositoryId } from '../electron/services/report'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('all-repository reports', () => {
  it('uses the active repository only when the repository scope is omitted', () => {
    expect(resolveReportRepositoryId(undefined, 'active-repo')).toBe('active-repo')
    expect(resolveReportRepositoryId(null, 'active-repo')).toBeNull()
  })

  it('falls back to the configured self email only for an empty recipient selection', () => {
    const config = { selfEmail: 'self@example.com', testRecipient: '', username: '' }
    expect(resolveReportRecipients('', config)).toEqual(['self@example.com'])
    expect(resolveReportRecipients('none', config)).toEqual([])
  })

  it('generates and sends one report containing every repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmanager-all-repositories-'))
    tempDirs.push(dir)
    const reportPath = path.join(dir, 'all-repositories.html')
    fs.writeFileSync(reportPath, '<html>all repositories</html>', 'utf8')

    const generateAllRepositoriesReport = vi.fn().mockResolvedValue({
      id: 'all-report',
      title: 'Git Branch Health Report - 全部仓库 (manual)',
      repositoryId: null,
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
        repositories: 4
      }
    })
    const sendReportEmail = vi.fn().mockResolvedValue({
      ok: true,
      message: '报告邮件发送成功。',
      recipients: ['self@example.com'],
      emailsSent: 1
    })
    const auditRecord = vi.fn()

    const service = new ReportScheduleService(
      {} as StorageService,
      { generateAllRepositoriesReport } as unknown as ReportService,
      {
        getConfig: () => ({
          enabled: true,
          selfEmail: 'self@example.com',
          testRecipient: '',
          username: ''
        }),
        listGroups: () => [],
        sendReportEmail
      } as unknown as EmailService,
      { record: auditRecord } as unknown as AuditService
    )

    const result = await service.sendAllRepositoriesReport('manual', 'self')

    expect(generateAllRepositoriesReport).toHaveBeenCalledWith('manual', 'html')
    expect(sendReportEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ['self@example.com'],
      subject: expect.stringContaining('全部仓库'),
      attachmentPath: reportPath
    }))
    expect(auditRecord).toHaveBeenCalledWith(
      'report_all_repositories_sent',
      expect.objectContaining({ report: 'all-report', ok: true }),
      'success'
    )
    expect(result.ok).toBe(true)
  })
})
