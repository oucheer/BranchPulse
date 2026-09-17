import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BranchSummary, EmailGroup, EmailSendResult } from '@shared/types'
import { GroupService } from '../src-node/services/groups'
import { StorageService } from '../src-node/services/storage'
import { AuditService } from '../src-node/services/audit'
import type { BranchService } from '../src-node/services/branch'
import type { EmailService, EmailSummaryData } from '../src-node/services/email'

let workDir: string
let profileDir: string
let previousUserData: string | undefined
let storage: StorageService

/** 分支最小可用样本：只填 GroupService 真正读取的字段。 */
function branch(name: string, creatorName: string, creatorEmail: string, repositoryId = 'repo-1'): BranchSummary {
  return {
    id: name,
    repositoryId,
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
    inactiveDays: 30,
    ageDays: 30,
    naming: { status: 'valid' },
    health: { score: 88, level: 'healthy', factors: [] },
    protection: { whitelisted: false, isDefault: false, protected: false, rules: [] },
    state: 'active',
    stale: false,
    gracePeriodDays: 60,
    thresholdDays: 180,
    thresholdUnit: 'days',
    graceExpired: false,
    cleanupCandidate: false,
    recentCommits: [],
    lastScannedAt: '2026-01-01T00:00:00.000Z'
  }
}

const BRANCHES = [
  branch('feature/login', '张三', 'zhangsan@example.com'),
  branch('bugfix/crash', '李四', 'lisi@example.com'),
  branch('feature/other', '王五', 'wangwu@example.com'),
  branch('feature/foreign', '张三', 'zhangsan@example.com', 'repo-2')
]

function buildService(groups: EmailGroup[], sent: EmailSummaryData[]): {
  service: GroupService
  email: EmailService
} {
  const emailStub = {
    listGroups: () => groups,
    saveGroup: () => groups,
    deleteGroup: () => groups,
    getConfig: () => ({ enabled: true }),
    sendSummaryEmail: async (data: EmailSummaryData, _config?: unknown, recipients?: string[]): Promise<EmailSendResult> => {
      sent.push(data)
      return { ok: true, message: 'sent', emailsSent: 1, recipients }
    }
  } as unknown as EmailService
  const branchStub = { listBranches: () => BRANCHES } as unknown as BranchService
  const service = new GroupService(storage, branchStub, emailStub, new AuditService(storage))
  return { service, email: emailStub }
}

function group(overrides: Partial<EmailGroup> = {}): EmailGroup {
  return {
    id: 'group-1',
    name: '支付组',
    recipients: 'payment@example.com',
    members: [{ name: '张三', email: 'zhangsan@example.com' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-group-'))
  profileDir = path.join(workDir, 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  previousUserData = process.env.BRANCHPULSE_USER_DATA_DIR
  process.env.BRANCHPULSE_USER_DATA_DIR = profileDir
  storage = new StorageService(path.join(workDir, 'groups.db'))
  await storage.init()
})

afterEach(() => {
  storage.close()
  if (previousUserData === undefined) delete process.env.BRANCHPULSE_USER_DATA_DIR
  else process.env.BRANCHPULSE_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('GroupService branch ownership', () => {
  it('collects only the branches whose creator hits a member', () => {
    const { service } = buildService([group()], [])
    const { branches } = service.branchesFor('group-1')
    // repo-2 的 feature/foreign 同样由张三创建，组归属跨仓库成立。
    expect(branches.map((item) => item.name)).toEqual(['feature/login', 'feature/foreign'])
  })

  it('narrows the scope when a repository is selected', () => {
    const { service } = buildService([group()], [])
    expect(service.branchesFor('group-1', 'repo-2').branches.map((item) => item.name)).toEqual(['feature/foreign'])
  })

  it('reports stats per group', () => {
    const { service } = buildService([group()], [])
    const stats = service.statsFor('group-1')
    expect(stats.total).toBe(2)
    expect(stats.active).toBe(2)
    expect(stats.creators).toEqual(['张三'])
  })

  it('rejects an unknown group instead of silently returning nothing', () => {
    const { service } = buildService([group()], [])
    expect(() => service.branchesFor('missing')).toThrow(/不存在/)
  })
})

describe('GroupService export', () => {
  it('writes a CSV holding the group column and only that group’s branches', async () => {
    const { service } = buildService([group()], [])
    const record = await service.exportBranches('group-1', 'csv')
    expect(record.format).toBe('csv')
    expect(record.summary.totalBranches).toBe(2)
    const csv = fs.readFileSync(record.path, 'utf8')
    const lines = csv.split('\n')
    expect(lines[0]).toContain('group')
    expect(lines[0]).toContain('creator_email')
    expect(lines).toHaveLength(3)
    expect(lines.slice(1).every((line) => line.startsWith('"支付组"'))).toBe(true)
    expect(csv).toContain('feature/login')
    expect(csv).not.toContain('bugfix/crash')
    // 报告记录入库，用户能在报告页看到并再次下载。
    const row = storage.get<Record<string, unknown>>('SELECT * FROM reports WHERE id = ?', [record.id])
    expect(row?.period).toBe('组：支付组')
  })

  it('writes an HTML report in the shared report layout', async () => {
    const { service } = buildService([group()], [])
    const record = await service.exportBranches('group-1', 'html')
    expect(record.format).toBe('html')
    const html = fs.readFileSync(record.path, 'utf8')
    expect(html).toContain('分支健康报告')
    expect(html).toContain('支付组')
  })

  it('falls back to HTML for an unsupported format', async () => {
    const { service } = buildService([group()], [])
    const record = await service.exportBranches('group-1', 'pdf')
    expect(record.format).toBe('html')
  })

  it('still produces a report when the group owns no branch', async () => {
    const empty = group({ members: [{ name: '无人', email: 'nobody@example.com' }] })
    const { service } = buildService([empty], [])
    const record = await service.exportBranches('group-1', 'csv')
    expect(record.summary.totalBranches).toBe(0)
    expect(fs.readFileSync(record.path, 'utf8').split('\n')).toHaveLength(1)
  })
})

describe('GroupService emailing', () => {
  it('sends only that group’s branches to the members', async () => {
    const sent: EmailSummaryData[] = []
    const { service } = buildService([group()], sent)
    const result = await service.emailBranches('group-1')
    expect(result.sent).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].branches.map((row) => row.branch).sort()).toEqual(['feature/foreign', 'feature/login'])
    expect(sent[0].thresholdHint).toContain('支付组')
  })

  it('refuses to send when email sending is switched off', async () => {
    const blocked = new GroupService(
      storage,
      { listBranches: () => BRANCHES } as unknown as BranchService,
      {
        listGroups: () => [group()],
        getConfig: () => ({ enabled: false }),
        sendSummaryEmail: vi.fn()
      } as unknown as EmailService,
      new AuditService(storage)
    )
    const result = await blocked.emailBranches('group-1')
    expect(result.sent).toBe(0)
    expect(result.message).toContain('邮件发送未启用')
  })

  it('refuses to send when the group has no address at all', async () => {
    const sent: EmailSummaryData[] = []
    const bare = group({ recipients: '', members: [{ name: '张三', email: '' }] })
    const { service } = buildService([bare], sent)
    const result = await service.emailBranches('group-1')
    expect(result.sent).toBe(0)
    expect(result.message).toContain('没有配置收件邮箱')
    expect(sent).toHaveLength(0)
  })

  it('records the delivery in the audit log', async () => {
    const { service } = buildService([group()], [])
    await service.emailBranches('group-1')
    const row = storage.get<Record<string, unknown>>("SELECT * FROM audit_logs WHERE action = 'group_email_sent'")
    expect(row).toBeTruthy()
    expect(String(row?.detail_json)).toContain('支付组')
  })
})

describe('GroupService persistence', () => {
  it('round-trips members through the email_groups table', async () => {
    const email = {
      listGroups: () => [group()],
      saveGroup: () => [group()],
      deleteGroup: () => []
    } as unknown as EmailService
    const branchStub = { listBranches: () => BRANCHES } as unknown as BranchService
    const service = new GroupService(storage, branchStub, email, new AuditService(storage))
    expect(service.list()).toHaveLength(1)
    expect(service.save({ name: 'x', recipients: 'y@z.com' })).toHaveLength(1)
    // 删除走 EmailService（组数据仍存在 email_groups 表里）。
    expect(service.delete('group-1')).toEqual([])
  })
})
