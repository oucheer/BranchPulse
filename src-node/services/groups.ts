import fs from 'node:fs'
import path from 'node:path'
import type { BranchSummary, EmailGroup, ReportRecord, ReportSummary } from '@shared/types'
import { branchBelongsToGroup, groupBranchStats, groupMemberNames, groupRecipients } from '@shared/groups'
import type { GroupBranchStats } from '@shared/groups'
import type { StorageService } from './storage'
import type { AuditService } from './audit'
import type { BranchService } from './branch'
import type { EmailService, EmailSummaryData } from './email'
import { buildBranchEmailHtml, toEmailIssueRow } from './email'
import { newId } from '../utils/ids'
import { reportsDir } from '../utils/paths'

/**
 * 分支组：把「人名 + 邮箱」配置成组，用它回答三个问题。
 *
 * 1. 这个组有哪些分支 —— 分支创始人命中组员（人名或邮箱）即归属该组；
 * 2. 组的分支数据能导出 —— `exportBranches()` 生成带 `group` 列的 HTML/CSV；
 * 3. 能把结果发给组员 —— `emailBranches()` 只发该组自己的分支。
 *
 * 持久化仍复用 `email_groups` 表（`members_json` 存组员），这样监控、定时调度、
 * 报告收件人里的组名 token 解析与设置页看到的是同一份数据。
 */
export class GroupService {
  constructor(
    private readonly storage: StorageService,
    private readonly branchService: BranchService,
    private readonly email: EmailService,
    private readonly audit: AuditService
  ) {}

  list(): EmailGroup[] {
    return this.email.listGroups()
  }

  save(group: Partial<EmailGroup> & { id?: string }): EmailGroup[] {
    return this.email.saveGroup(group)
  }

  delete(id: string): EmailGroup[] {
    return this.email.deleteGroup(id)
  }

  private find(groupId: string): EmailGroup {
    const group = this.list().find((item) => item.id === groupId)
    if (!group) throw new Error('分支组不存在，请刷新后重试。')
    return group
  }

  /** 该组的分支：创始人命中组员即为归属，可选按仓库范围收窄。 */
  branchesFor(groupId: string, repositoryId?: string | null): { group: EmailGroup; branches: BranchSummary[] } {
    const group = this.find(groupId)
    const all = this.branchService.listBranches()
      .filter((branch) => !repositoryId || branch.repositoryId === repositoryId)
    return { group, branches: all.filter((branch) => branchBelongsToGroup(group, branch)) }
  }

  private groupDisplay(group: EmailGroup): string {
    const names = groupMemberNames(group)
    return names.length > 0 ? `${group.name}（${names.join('、')}）` : group.name
  }

  private buildSummary(branches: BranchSummary[], repositories: number): ReportSummary {
    const count = (fn: (branch: BranchSummary) => boolean): number => branches.filter(fn).length
    const valid = count((b) => b.naming.status === 'valid')
    const excluded = count((b) => b.naming.status === 'excluded')
    const scored = branches.filter((b) => !b.protection.isDefault && !/^(main|develop)$/i.test(b.name))
    return {
      totalBranches: branches.length,
      validBranches: valid,
      invalidBranches: count((b) => b.naming.status === 'invalid'),
      excludedBranches: excluded,
      compliancePercent: Math.round(((valid + excluded) / Math.max(1, branches.length)) * 100),
      active: count((b) => b.state === 'active'),
      stale: count((b) => b.stale),
      merged: count((b) => b.merged),
      namingViolations: count((b) => b.naming.status === 'invalid'),
      cleanupCandidates: count((b) => b.cleanupCandidate),
      protectedBranches: count((b) => b.protection.protected),
      whitelistedBranches: count((b) => b.protection.whitelisted),
      averageHealth: scored.length ? Math.round(scored.reduce((sum, b) => sum + b.health.score, 0) / scored.length) : (branches.length ? 100 : 0),
      repositories
    }
  }

  private summaryData(group: EmailGroup, branches: BranchSummary[], repositories: number): EmailSummaryData {
    const summary = this.buildSummary(branches, repositories)
    return {
      total: summary.totalBranches,
      stale: summary.stale,
      namingInvalid: summary.namingViolations,
      merged: summary.merged,
      cleanupCandidates: summary.cleanupCandidates,
      repositories,
      generatedAt: new Date().toISOString(),
      branches: branches.map(toEmailIssueRow),
      scopeLabel: this.groupDisplay(group),
      thresholdHint: `统计范围：${this.groupDisplay(group)}（按分支创始人匹配组员）`
    }
  }

  /**
   * 导出组的分支数据。CSV 额外带 `group` 与 `creator_email` 列，HTML 走与邮件
   * 附件一致的版式（报告格式只保留 HTML / CSV 两种）。
   */
  async exportBranches(groupId: string, format = 'html', repositoryId?: string | null): Promise<ReportRecord> {
    const { group, branches } = this.branchesFor(groupId, repositoryId)
    const safeFormat = ['html', 'csv'].includes(format) ? format : 'html'
    const repositories = new Set(branches.map((branch) => branch.repositoryId)).size
    const generatedAt = new Date().toISOString()
    const periodLabel = `组：${group.name}`
    const title = `分支组报告 · ${group.name}`
    const filename = `gitmanager-group-${slug(group.name)}-${generatedAt.slice(0, 19).replace(/[:T]/g, '-')}.${safeFormat}`
    const filePath = path.join(reportsDir(), filename)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    const summary = this.buildSummary(branches, repositories)
    if (safeFormat === 'csv') {
      fs.writeFileSync(filePath, groupCsv(group, branches), 'utf8')
    } else {
      const data = this.summaryData(group, branches, repositories)
      data.generatedAt = generatedAt
      data.scopeLabel = group.name
      fs.writeFileSync(filePath, buildBranchEmailHtml(data, 'zh', 'report'), 'utf8')
    }

    const record: ReportRecord = {
      id: newId(),
      title,
      repositoryId: repositoryId ?? null,
      groupIds: [group.id],
      generatedAt,
      period: periodLabel,
      format: safeFormat,
      path: filePath,
      summary
    }
    this.storage.insert('reports', {
      id: record.id,
      title,
      repository_id: record.repositoryId,
      group_ids: JSON.stringify(record.groupIds),
      generated_at: generatedAt,
      period: periodLabel,
      format: safeFormat,
      path: filePath,
      summary_json: JSON.stringify(summary)
    })
    this.audit.record('group_report_generated', {
      group: group.name,
      groupId: group.id,
      format: safeFormat,
      branches: branches.length
    })
    return record
  }

  /** 把该组自己的分支情况发给组员；没有分支时也发一封，说明当前没有归属分支。 */
  async emailBranches(groupId: string, repositoryId?: string | null): Promise<{ sent: number; message: string }> {
    const { group, branches } = this.branchesFor(groupId, repositoryId)
    const recipients = groupRecipients(group)
    if (recipients.length === 0) {
      return { sent: 0, message: `分支组「${group.name}」没有配置收件邮箱，请先补全组员邮箱。` }
    }
    if (!this.email.getConfig().enabled) {
      return { sent: 0, message: '邮件发送未启用，请先在设置中开启。' }
    }
    const repositories = new Set(branches.map((branch) => branch.repositoryId)).size
    const data = this.summaryData(group, branches, repositories)
    const result = await this.email.sendSummaryEmail(data, undefined, recipients)
    this.audit.record(
      result.ok ? 'group_email_sent' : 'group_email_failed',
      { group: group.name, groupId: group.id, recipients: recipients.length, branches: branches.length, message: result.message },
      result.ok ? 'success' : 'failure'
    )
    if (!result.ok) return { sent: 0, message: result.message }
    return { sent: result.emailsSent ?? 1, message: `已把「${group.name}」的 ${branches.length} 个分支发给 ${recipients.length} 位组员。` }
  }

  /**
   * 监控 / 定时调度用：把**本次检查的完整结果**只发给这个组的组员。
   *
   * 这是「检查全部分支、只通知分组人员」那一半语义：数据由调用方传入且不按组收窄，
   * 这里只替换收件人。组与组之间分开调用是为了不让各组看到彼此的成员邮箱。
   */
  async emailSummaryToGroup(group: EmailGroup, data: EmailSummaryData): Promise<{ ok: boolean; message: string; sent: number }> {
    const recipients = groupRecipients(group)
    if (recipients.length === 0) return { ok: false, message: `分支组「${group.name}」没有配置收件邮箱。`, sent: 0 }
    const result = await this.email.sendSummaryEmail(data, undefined, recipients)
    return { ok: result.ok, message: result.message, sent: result.emailsSent ?? 0 }
  }

  /** 组的分支情况，供页面展示（分支数 + 状态分布 + 组内出现过的创始人）。 */
  statsFor(groupId: string, repositoryId?: string | null): GroupBranchStats & { branches: BranchSummary[] } {
    const { branches } = this.branchesFor(groupId, repositoryId)
    return { ...groupBranchStats(branches), branches }
  }
}

function groupCsv(group: EmailGroup, branches: BranchSummary[]): string {
  const header = [
    'group', 'repository', 'branch', 'type', 'state', 'inactive_days', 'creator', 'creator_email',
    'last_commit', 'naming', 'health', 'cleanup_candidate'
  ]
  const esc = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`
  const lines = [header.map(esc).join(',')]
  for (const branch of branches) {
    lines.push([
      group.name,
      branch.repositoryName,
      branch.displayName,
      branch.type,
      branch.state,
      branch.inactiveDays,
      branch.creator.name,
      branch.creator.email,
      branch.lastCommitAt ?? '',
      branch.naming.status,
      branch.health.score,
      branch.cleanupCandidate
    ].map(esc).join(','))
  }
  return lines.join('\n')
}

function slug(value: string): string {
  const ascii = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii || 'group'
}
