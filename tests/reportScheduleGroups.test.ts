import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EmailGroup, ReportRecord } from '@shared/types'
import { ReportScheduleService } from '../src-node/services/reportSchedule'
import type { EmailService } from '../src-node/services/email'
import type { ReportService } from '../src-node/services/report'
import type { GroupService } from '../src-node/services/groups'
import type { StorageService } from '../src-node/services/storage'
import type { AuditService } from '../src-node/services/audit'

/**
 * 定时报告里的组名收件人：报告本体发给普通收件人，组名额外触发一封
 * 「只含该组组员分支」的邮件。两条路径必须互不污染。
 */

let workDir: string
let previousUserData: string | undefined

const GROUP: EmailGroup = {
  id: 'group-1',
  name: '支付组',
  recipients: 'payment@example.com',
  members: [{ name: '张三', email: 'zhangsan@example.com' }],
  createdAt: '2026-01-01T00:00:00.000Z'
}

function scheduleRow(recipients: string): Record<string, unknown> {
  return {
    id: 'schedule-1',
    name: '每日报告',
    repository_id: null,
    frequency: 'daily',
    time: '09:00',
    weekday: 1,
    day_of_month: 1,
    run_at: null,
    recipients,
    enabled: 1,
    last_run_at: null,
    // 已经到点，tick() 会立刻命中。
    next_run_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

interface Harness {
  service: ReportScheduleService
  reportEmails: string[][]
  groupEmails: Array<{ group: string; repositoryId: string | null | undefined }>
  auditRecords: Array<{ action: string; status?: string }>
}

function harness(recipients: string): Harness {
  const reportEmails: string[][] = []
  const groupEmails: Array<{ group: string; repositoryId: string | null | undefined }> = []
  const auditRecords: Array<{ action: string; status?: string }> = []

  const storage = {
    all: (query: string) => (query.includes('report_schedules') ? [scheduleRow(recipients)] : []),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn()
  } as unknown as StorageService

  const report = {
    generateReport: async (): Promise<ReportRecord> => {
      const file = path.join(workDir, 'report.html')
      fs.writeFileSync(file, '<html><body>report</body></html>', 'utf8')
      return {
        id: 'report-1',
        title: 'report',
        repositoryId: null,
        groupIds: [],
        generatedAt: '2026-09-17T00:00:00.000Z',
        period: 'daily',
        format: 'html',
        path: file,
        summary: {
          totalBranches: 0, validBranches: 0, invalidBranches: 0, excludedBranches: 0,
          compliancePercent: 0, active: 0, stale: 0,
          merged: 0, namingViolations: 0, cleanupCandidates: 0, protectedBranches: 0,
          whitelistedBranches: 0, averageHealth: 0, repositories: 0
        }
      }
    }
  } as unknown as ReportService

  const email = {
    getConfig: () => ({ enabled: true, selfEmail: 'owner@example.com', testRecipient: '', username: 'notify@example.com' }),
    listGroups: () => [GROUP],
    sendReportEmail: async (input: { to: string[] }): Promise<unknown> => {
      reportEmails.push(input.to)
      return { ok: true, message: 'sent', emailsSent: 1 }
    }
  } as unknown as EmailService

  const groups = {
    emailBranches: async (groupId: string, repositoryId?: string | null) => {
      groupEmails.push({ group: groupId, repositoryId })
      return { sent: 1, message: 'sent' }
    }
  } as unknown as GroupService

  const audit = {
    record: (action: string, _detail?: unknown, status?: string) => { auditRecords.push({ action, status }) }
  } as unknown as AuditService

  return {
    service: new ReportScheduleService(storage, report, email, audit, groups),
    reportEmails,
    groupEmails,
    auditRecords
  }
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-report-group-'))
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'profile')
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

/** tick() 是私有的定时入口，测试直接驱动它。 */
async function tick(service: ReportScheduleService): Promise<void> {
  await (service as unknown as { tick: () => Promise<void> }).tick()
}

describe('scheduled report with a group recipient', () => {
  it('sends the report to plain addresses and a scoped report to the group', async () => {
    const h = harness('支付组, boss@example.com')
    await tick(h.service)
    expect(h.reportEmails).toEqual([['boss@example.com']])
    expect(h.groupEmails).toEqual([{ group: 'group-1', repositoryId: null }])
    expect(h.auditRecords.some((item) => item.action === 'report_schedule_group_email_sent')).toBe(true)
  })

  it('does not default to the configured mailbox when only a group is selected', async () => {
    const h = harness('支付组')
    await tick(h.service)
    // 只勾组名时不该再给配置邮箱发一份整仓报告。
    expect(h.reportEmails).toHaveLength(0)
    expect(h.groupEmails).toHaveLength(1)
  })

  it('still defaults to the configured mailbox when nothing is selected', async () => {
    const h = harness('')
    await tick(h.service)
    expect(h.reportEmails).toEqual([['owner@example.com']])
    expect(h.groupEmails).toHaveLength(0)
  })

  it('records a skip instead of throwing when the group service is missing', async () => {
    const auditRecords: Array<{ action: string; status?: string }> = []
    const file = path.join(workDir, 'report.html')
    fs.writeFileSync(file, '<html></html>', 'utf8')
    const withoutGroups = new ReportScheduleService(
      { all: (query: string) => (query.includes('report_schedules') ? [scheduleRow('支付组')] : []), update: vi.fn(), insert: vi.fn(), delete: vi.fn() } as unknown as StorageService,
      {
        generateReport: async (): Promise<ReportRecord> => ({
          id: 'report-1', title: 'report', repositoryId: null, generatedAt: '2026-09-17T00:00:00.000Z',
          groupIds: [],
          period: 'daily', format: 'html', path: file,
          summary: {
            totalBranches: 0, validBranches: 0, invalidBranches: 0, excludedBranches: 0,
            compliancePercent: 0, active: 0, stale: 0,
            merged: 0, namingViolations: 0, cleanupCandidates: 0, protectedBranches: 0,
            whitelistedBranches: 0, averageHealth: 0, repositories: 0
          }
        })
      } as unknown as ReportService,
      {
        getConfig: () => ({ enabled: true, selfEmail: '', testRecipient: '', username: 'notify@example.com' }),
        listGroups: () => [GROUP],
        sendReportEmail: vi.fn()
      } as unknown as EmailService,
      { record: (action: string, _detail?: unknown, status?: string) => { auditRecords.push({ action, status }) } } as unknown as AuditService
    )
    await expect(tick(withoutGroups)).resolves.toBeUndefined()
    const skipped = auditRecords.find((item) => item.action === 'report_schedule_group_email_skipped')
    expect(skipped?.status).toBe('failure')
  })
})
