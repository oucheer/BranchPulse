import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditService } from '../electron/services/audit'
import { buildPartitionedReportHtml, collectCreatorAddresses, creatorNotificationSection, type EmailIssueRow } from '../electron/services/email'
import type { EmailService } from '../electron/services/email'
import type { ReportService } from '../electron/services/report'
import type { StorageService } from '../electron/services/storage'
import { ReportScheduleService, resolveReportRecipients } from '../electron/services/reportSchedule'

/**
 * 报告只发一封邮件：勾选仓库里的多个仓库、多个分支必须在同一封邮件里完成通知，
 * 创始人进密送，自己与邮箱分组（例如领导组）进收件人，绝不按仓库各发一封。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function issueRow(overrides: Partial<EmailIssueRow> = {}): EmailIssueRow {
  return {
    repository: 'alpha',
    branch: 'feature/a',
    creator: '张三',
    creatorEmail: 'zhang@example.com',
    lastCommitDate: '2026-05-01',
    lastCommitAt: '2026-05-01T00:00:00.000Z',
    inactiveDays: 200,
    namingStatus: 'valid',
    mergeStatus: 'unknown',
    healthScore: 30,
    state: 'stale',
    ...overrides
  }
}

function writeReportFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmanager-multi-repo-report-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'report.html')
  // 报告文件的结构与真实产物一致：白色卡片里有页脚分隔线。
  fs.writeFileSync(
    file,
    '<html><body><h2>报告</h2><hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px"><div>页脚</div></body></html>',
    'utf8'
  )
  return file
}

function service(options: {
  branches?: EmailIssueRow[]
  emailEnabled?: boolean
  groups?: Array<{ id: string; name: string; recipients: string }>
  selfEmail?: string
} = {}): {
  service: ReportScheduleService
  generateReport: ReturnType<typeof vi.fn>
  sendReportEmail: ReturnType<typeof vi.fn>
  auditRecord: ReturnType<typeof vi.fn>
} {
  const reportPath = writeReportFile()
  const generateReport = vi.fn().mockResolvedValue({
    id: 'report-1',
    title: 'Git Branch Health Report - 勾选仓库 (manual)',
    repositoryIds: ['repo-1', 'repo-2'],
    generatedAt: '2026-09-21T08:00:00.000Z',
    period: 'manual',
    format: 'html',
    path: reportPath,
    summary: {}
  })
  const sendReportEmail = vi
    .fn()
    .mockResolvedValue({ ok: true, message: '报告邮件发送成功。', recipients: ['self@example.com'], emailsSent: 1 })
  const auditRecord = vi.fn()
  const storage = {
    selectedRepositoryIds: () => ['repo-1', 'repo-2'],
    get: () => ({ language: 'zh' })
  } as unknown as StorageService
  const instance = new ReportScheduleService(
    storage,
    {
      generateReport,
      getSummaryEmailData: () => ({ branches: options.branches ?? [] })
    } as unknown as ReportService,
    {
      getConfig: () => ({
        enabled: options.emailEnabled ?? true,
        selfEmail: options.selfEmail ?? 'self@example.com',
        testRecipient: '',
        username: ''
      }),
      listGroups: () => (options.groups ?? []).map((group) => ({ createdAt: '', ...group })),
      sendReportEmail
    } as unknown as EmailService,
    { record: auditRecord } as unknown as AuditService
  )
  return { service: instance, generateReport, sendReportEmail, auditRecord }
}

describe('collectCreatorAddresses', () => {
  it('falls back to the last commit author email when the creator is unknown', () => {
    const result = collectCreatorAddresses([
      issueRow({ creator: 'Unknown', creatorEmail: '', lastAuthor: '李四', lastAuthorEmail: 'lisi@example.com' })
    ])
    expect(result.to).toEqual(['lisi@example.com'])
    expect(result.missing).toEqual([])
  })

  it('reports an unknown creator separately when the last author has no usable email', () => {
    const result = collectCreatorAddresses([
      issueRow({ creator: 'Unknown', creatorEmail: '', lastAuthor: '李四', lastAuthorEmail: '' })
    ])
    expect(result.to).toEqual([])
    expect(result.missing).toContain('李四（无法找到创始人）')
  })

  it('deduplicates creators across repositories and reports the ones without a usable address', () => {
    const rows = [
      issueRow({ repository: 'alpha', branch: 'feature/a', creatorEmail: 'zhang@example.com' }),
      issueRow({ repository: 'beta', branch: 'feature/b', creatorEmail: 'ZHANG@example.com' }),
      issueRow({ repository: 'beta', branch: 'feature/c', creator: '李四', creatorEmail: 'li@example.com' }),
      issueRow({ repository: 'alpha', branch: 'feature/d', creator: '王五', creatorEmail: '' }),
      issueRow({ repository: 'beta', branch: 'feature/e', creator: '王五', creatorEmail: 'not-an-email' })
    ]

    const { to, missing } = collectCreatorAddresses(rows)

    expect(to).toEqual(['zhang@example.com', 'li@example.com'])
    expect(missing).toEqual(['王五'])
  })
})

describe('resolveReportRecipients', () => {
  const config = {
    selfEmail: 'self@example.com',
    testRecipient: '',
    username: ''
  }

  it('merges several mail groups into one recipient list', () => {
    const groups = [
      { id: 'g1', name: 'leaders', recipients: 'boss@example.com, cto@example.com', createdAt: '' },
      { id: 'g2', name: 'qa', recipients: 'qa@example.com', createdAt: '' }
    ]
    expect(resolveReportRecipients('self, leaders, qa', config, groups)).toEqual([
      'self@example.com',
      'boss@example.com',
      'cto@example.com',
      'qa@example.com'
    ])
  })

  it('does not fall back to self when only the creator token is selected', () => {
    expect(resolveReportRecipients('creator', config)).toEqual([])
  })
})

describe('sendSelectedRepositoriesReport with creators and mail groups', () => {
  it('sends one email: creators in bcc, self and the leader group in to', async () => {
    const { service: reports, sendReportEmail, auditRecord } = service({
      groups: [{ id: 'g1', name: 'leaders', recipients: 'leaders@example.com' }],
      branches: [
        issueRow({ repository: 'alpha', creatorEmail: 'zhang@example.com' }),
        issueRow({ repository: 'beta', branch: 'feature/b', creatorEmail: 'li@example.com', namingStatus: 'invalid' }),
        issueRow({ repository: 'beta', branch: 'feature/c', creatorEmail: 'li@example.com', namingStatus: 'invalid' }),
        // 健康分支的创始人不应被拉进通知范围。
        issueRow({ repository: 'beta', branch: 'feature/ok', creatorEmail: 'healthy@example.com', state: 'active', namingStatus: 'valid' })
      ]
    })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'self, leaders, creator', ['repo-1', 'repo-2'])

    expect(sendReportEmail).toHaveBeenCalledTimes(1)
    expect(sendReportEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['self@example.com', 'leaders@example.com'],
        bcc: ['zhang@example.com', 'li@example.com']
      })
    )
    const html = sendReportEmail.mock.calls[0][0].html as string
    expect(html).toContain('分支创始人通知范围')
    expect(html).toContain('zhang@example.com')
    expect(html).not.toContain('healthy@example.com')
    expect(auditRecord).toHaveBeenCalledWith(
      'report_selected_repositories_sent',
      expect.objectContaining({ creatorRecipients: ['zhang@example.com', 'li@example.com'] }),
      'success'
    )
    expect(result.ok).toBe(true)
  })

  it('uses the creators themselves as the only recipients when nothing else is selected', async () => {
    const { service: reports, sendReportEmail } = service({
      branches: [issueRow({ creatorEmail: 'zhang@example.com' })]
    })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'creator', ['repo-1', 'repo-2'])

    expect(sendReportEmail).toHaveBeenCalledTimes(1)
    expect(sendReportEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['zhang@example.com'], bcc: [] })
    )
    expect(result.message).toContain('zhang@example.com')
  })

  it('fails with an explicit reason when every creator is missing an address', async () => {
    const { service: reports, sendReportEmail } = service({
      branches: [issueRow({ creator: '王五', creatorEmail: '' })]
    })

    const result = await reports.sendSelectedRepositoriesReport('manual', 'creator', ['repo-1', 'repo-2'])

    expect(result.ok).toBe(false)
    expect(result.message).toContain('王五')
    expect(sendReportEmail).not.toHaveBeenCalled()
  })

  it('does not collect creators when the creator token is not selected', async () => {
    const { service: reports, sendReportEmail } = service({
      branches: [issueRow({ creatorEmail: 'zhang@example.com' })]
    })

    await reports.sendSelectedRepositoriesReport('manual', 'self', ['repo-1', 'repo-2'])

    expect(sendReportEmail).toHaveBeenCalledWith(expect.objectContaining({ bcc: [] }))
  })
})

describe('creatorNotificationSection', () => {
  it('lists who was bcc-ed and who could not be reached', () => {
    const html = creatorNotificationSection(['a@example.com'], ['王五'], 'zh')
    expect(html).toContain('a@example.com')
    expect(html).toContain('王五')
  })

  it('renders nothing when there is no creator notification at all', () => {
    expect(creatorNotificationSection([], [], 'zh')).toBe('')
  })
})

describe('multi-repository report overview', () => {
  it('puts the portfolio overview and per-repository comparison before detailed sections', () => {
    const html = buildPartitionedReportHtml({
      title: '勾选仓库报告',
      generatedAt: '2026-09-23T00:00:00.000Z',
      partitions: [
        {
          repositoryId: 'repo-a',
          repositoryName: '仓库甲',
          data: {
            total: 8, stale: 2, namingInvalid: 1, merged: 0, cleanupCandidates: 1,
            repositories: 1, generatedAt: '2026-09-23T00:00:00.000Z', branches: []
          }
        },
        {
          repositoryId: 'repo-b',
          repositoryName: '仓库乙',
          data: {
            total: 4, stale: 1, namingInvalid: 0, merged: 0, cleanupCandidates: 1,
            repositories: 1, generatedAt: '2026-09-23T00:00:00.000Z', branches: []
          }
        }
      ],
      overall: {
        total: 12, stale: 3, namingInvalid: 1, merged: 0, cleanupCandidates: 2,
        repositories: 2, generatedAt: '2026-09-23T00:00:00.000Z', branches: []
      }
    }, 'zh')

    expect(html.indexOf('管理总览')).toBeLessThan(html.indexOf('仓库甲'))
    expect(html.indexOf('仓库乙')).toBeGreaterThan(html.indexOf('管理总览'))
    expect(html).toContain('各仓库已停更分支')
    expect(html.indexOf('总分支')).toBeLessThan(html.indexOf('仓库详细情况'))
    expect(html.indexOf('已停更占比')).toBeLessThan(html.indexOf('仓库详细情况'))
    expect(html).toContain('仓库详细情况')
  })
})
