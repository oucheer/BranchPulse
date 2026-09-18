import type {
  ActivityItem,
  BranchSummary,
  EmailPolicy,
  NotificationRecord,
  NotifyTarget,
  NotificationType,
  RunCheckOptions,
  ScanProgress,
  ScanRun
} from '@shared/types'
import type { StorageService } from './storage'
import type { BranchService } from './branch'
import type { RepositoryService } from './repository'
import type { EmailService, EmailIssueRow, EmailSummaryData } from './email'
import { resolveRecipients, parseNotifyTarget, toEmailIssueRow } from './email'
import { partitionRecipientTokens, resolveGroupScope } from '@shared/groups'
import { groupCoversCreator } from '@shared/groups'
import type { EmailGroup } from '@shared/types'
import type { GroupService } from './groups'
import type { AuditService } from './audit'
import { newId } from '../utils/ids'
import { parseThresholdRules } from './branch'

export class MonitoringService {
  onProgress: ((progress: ScanProgress) => void) | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly branchService: BranchService,
    private readonly repositoryService: RepositoryService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly groups?: GroupService
  ) {}

  private emitProgress(runId: string, activity: ActivityItem[], summary?: ScanProgress['summary']): void {
    this.onProgress?.({ runId, activity: [...activity], summary })
  }

  private insertRepoScanSummary(runId: string, repositoryId: string, branches: BranchSummary[]): void {
    const summary = this.summarize(branches, 1)
    this.storage.insert('scan_run_repositories', {
      run_id: runId,
      repository_id: repositoryId,
      repositories: 1,
      branches: summary.branches,
      active: summary.active,
      stale: summary.stale,
      merged: summary.merged,
      naming_invalid: summary.namingInvalid,
      cleanup_candidates: summary.cleanupCandidates,
      health_avg: summary.healthAvg,
      health_best: summary.healthBest,
      health_worst: summary.healthWorst
    })
  }

  private readMonitoringRow(repositoryId?: string | null): Record<string, unknown> | null {
    if (repositoryId) {
      const row = this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId]) ?? null
      if (row) return row
    }
    return this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules WHERE id = 1') ?? null
  }

  /**
   * 汇总邮件 + 命中的分组邮件。
   *
   * 只有存在普通收件人（或「通知自己」）时才发整仓汇总；只勾组名时，组员只收到
   * 自己组的分支情况，不会被整仓汇总刷屏。
   */
  private async sendSummaryWithGroups(input: {
    groupTargets: EmailGroup[]
    data: EmailSummaryData
    recipients: string[]
    branches: BranchSummary[]
    addActivity: (message: string, level?: ActivityItem['level']) => void
  }): Promise<{ ok: boolean; message: string; sent: number }> {
    let sent = 0
    let ok = false
    let message = 'Email is disabled or no recipient is configured.'
    if (input.recipients.length > 0) {
      const result = await this.email.sendSummaryEmail(input.data, undefined, input.recipients)
      if (result.ok) {
        sent += result.emailsSent ?? 0
        ok = true
      } else {
        message = result.message
      }
    }
    for (const group of input.groupTargets) {
      if (!this.groups) {
        message = '分组邮件不可用：分组服务未初始化。'
        continue
      }
      const branches = input.branches.filter((branch) => groupCoversCreator(group, branch.creator))
      const result = await this.groups.emailGroup(group, branches)
      if (result.ok) {
        sent += result.sent
        ok = true
        input.addActivity('分组「' + group.name + '」邮件已发送（' + branches.length + ' 个分支）。', 'success')
      } else {
        message = result.message
        input.addActivity(result.message, 'error')
      }
    }
    return { ok, message, sent }
  }

  private thresholdHint(row?: Record<string, unknown> | null): string {
    const unitLabel = (unit: string): string => unit === 'weeks' ? '周' : unit === 'hours' ? '小时' : unit === 'minutes' ? '分钟' : '天'
    const staleValue = Number(row?.stale_threshold_days ?? 180)
    const base = `阈值 ${staleValue} ${unitLabel(String(row?.stale_threshold_unit ?? 'days'))}`
    const rules = parseThresholdRules(row?.threshold_rules)
    if (rules.length === 0) return base
    const detail = [...rules]
      .sort((a, b) => b.prefix.length - a.prefix.length)
      .map((rule) => `${rule.prefix} ${rule.value} ${unitLabel(rule.unit)}`)
      .join('、')
    return `${base}；按前缀覆盖：${detail}`
  }

  async runCheckNow(options: RunCheckOptions = {}): Promise<ScanRun> {
    const runId = newId()
    const startedAt = new Date().toISOString()
    const activity: ActivityItem[] = []
    const addActivity = (message: string, level: ActivityItem['level'] = 'info'): void => {
      activity.push({ at: new Date().toISOString(), message, level })
    }

    addActivity('Starting monitoring check.')
    this.emitProgress(runId, activity)

    const repos = this.repositoryService.list()
    const targets = options.repositoryIds?.length
      ? repos.filter((r) => options.repositoryIds?.includes(r.id))
      : repos
    if (targets.length === 0) {
      addActivity('No repositories configured. Add a repository to begin.', 'warn')
    }

    const monitoringRow = this.readMonitoringRow(options.repositoryIds?.length ? options.repositoryIds[0] : null)
    if (!options.bypassEnabledCheck && Number(monitoringRow?.enabled ?? 1) !== 1) {
      throw new Error('Monitoring is disabled. Turn monitoring on to run a check.')
    }
    const fetchEnabled = options.fetch ?? (monitoringRow?.fetch_enabled ?? 1) === 1
    const policy: EmailPolicy = options.emailPolicy ?? ((monitoringRow?.email_policy as EmailPolicy) ?? 'none')
    const notifyTarget: NotifyTarget = options.notifyTarget ?? ((monitoringRow?.notify_target as NotifyTarget) ?? 'self')
    const notificationsEnabled = (monitoringRow?.notification_enabled ?? 1) === 1

    const allBranches: BranchSummary[] = []
    const scannedRepositoryIds: string[] = []
    for (const repo of targets) {
      scannedRepositoryIds.push(repo.id)
      addActivity(`Scanning ${repo.name}...`)
      this.emitProgress(runId, activity)
      try {
        const branches = await this.branchService.scanRepository(repo.id, {
          fetch: fetchEnabled,
          progress: (message) => {
            addActivity(message)
            this.emitProgress(runId, activity)
          }
        })
        allBranches.push(...branches)
        addActivity(`${repo.name}: ${branches.length} branches analyzed.`, 'success')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        addActivity(`${repo.name}: ${message}`, 'error')
      }
      this.emitProgress(runId, activity)
    }

    // 「只检查分组」在汇总之前收窄分支集合：通知、汇总邮件、分组邮件、报告计数
    // 都读 allBranches，所以过滤只做一次，避免各出口各算一套。
    // 分组范围用同一个入口：选中的组全被删除时收窄成空集合并报警，不能退回整仓。
    const scope = resolveGroupScope(this.email.listGroups(), options.groupIds, allBranches)
    const scopeGroups = scope.groups
    const scopedBranches = scope.branches
    if (scope.missing) {
      addActivity('Selected groups no longer exist; nothing was checked.', 'error')
    } else if (scopeGroups.length) {
      addActivity(`Scope limited to group${scopeGroups.length === 1 ? '' : 's'}: ${scopeGroups.map((group) => group.name).join(', ')} (${scopedBranches.length} branches).`)
    }

    const scopedRepositoryCount = scopeGroups.length
      ? new Set(scopedBranches.map((branch) => branch.repositoryId)).size
      : targets.length
    const summary = this.summarize(scopedBranches, scopedRepositoryCount)
    addActivity(
      `Check complete: ${summary.branches} branches, ${summary.stale} stale, ${summary.namingInvalid} naming violations.`,
      'success'
    )

    const notifications: NotificationRecord[] = []
    if (notificationsEnabled) {
      const created = this.generateNotifications(scopedBranches)
      notifications.push(...created)
      if (created.length > 0) {
        addActivity(`${created.length} new notification${created.length === 1 ? '' : 's'} generated.`)
      }
    } else {
      addActivity('Notifications are disabled.', 'warn')
    }

    // Checks are inspection-only: nothing in this app deletes a remote branch.
    addActivity('This was an inspection-only check; GitManager never deletes branches.')

    let emailsSent = 0
    const delivery: Array<'summary' | 'creators'> = []
    const parsedNotify = parseNotifyTarget(typeof notifyTarget === 'string' ? notifyTarget : 'none')
    if (parsedNotify.self || parsedNotify.recipients) delivery.push('summary')
    if (parsedNotify.creator) delivery.push('creators')
    if (delivery.length === 0 && policy !== 'none') {
      if (policy === 'summary') delivery.push('summary')
      if (policy === 'creators') delivery.push('creators')
    }
    for (const deliveryKind of delivery) {
      const emailConfig = this.email.getConfig()
      const groups = this.email.listGroups()
      if (!emailConfig.enabled) {
        addActivity('Email policy requested but email is disabled.', 'warn')
        break
      }
      if (deliveryKind === 'summary') {
        const data: EmailSummaryData = {
          total: summary.branches,
          stale: summary.stale,
          namingInvalid: summary.namingInvalid,
          merged: summary.merged,
          cleanupCandidates: summary.cleanupCandidates,
          repositories: scopedRepositoryCount,
          generatedAt: new Date().toISOString(),
          branches: scopedBranches.map(toEmailIssueRow),
          thresholdHint: this.thresholdHint(monitoringRow)
        }
        const cfg = this.email.getConfig()
        const selfAddress = cfg.selfEmail || cfg.testRecipient || cfg.username
        const targetRecipients: string[] = []
        if (parsedNotify.self && selfAddress) targetRecipients.push(selfAddress)
        // 组名 token 不能混进汇总收件人：它表示「把这个组自己的分支情况发给组员」，
        // 混进来会让组员同时收到整仓汇总和分组邮件两封。
        const { matched: groupTargets, plain } = partitionRecipientTokens(parsedNotify.recipients, groups)
        if (plain) targetRecipients.push(...resolveRecipients(plain, []))
        const uniqueRecipients = [...new Set(targetRecipients.filter(Boolean))]
        const result = await this.sendSummaryWithGroups({
          groupTargets,
          data,
          recipients: uniqueRecipients,
          branches: scopedBranches,
          addActivity
        })
        if (result.ok) {
          emailsSent += result.sent
          addActivity('Summary email sent (' + result.sent + ' email' + (result.sent === 1 ? '' : 's') + ').', 'success')
        } else {
          addActivity(result.message, 'error')
        }
      } else {
        const rows: EmailIssueRow[] = scopedBranches
          .filter((b) => b.stale || b.naming.status === 'invalid' || b.cleanupCandidate)
          .map((b) => this.toIssueRow(b))
        const result = await this.email.sendCreatorEmails(rows, undefined, {
          thresholdHint: this.thresholdHint(monitoringRow)
        })
        if (result.ok) {
          emailsSent += result.emailsSent ?? 0
          addActivity(`${emailsSent} creator email${emailsSent === 1 ? '' : 's'} sent.`, 'success')
        } else {
          addActivity(result.message, 'error')
        }
      }
    }

    const finishedAt = new Date().toISOString()
    const run: ScanRun = {
      id: runId,
      startedAt,
      finishedAt,
      status: 'completed',
      trigger: options.trigger ?? 'manual',
      healthAvg: summary.healthAvg,
      healthBest: summary.healthBest,
      healthWorst: summary.healthWorst,
      repositories: scopedRepositoryCount,
      branches: summary.branches,
      active: summary.active,
      stale: summary.stale,
      merged: summary.merged,
      namingInvalid: summary.namingInvalid,
      cleanupCandidates: summary.cleanupCandidates,
      notifications: notifications.length,
      emailsSent,
      error: null,
      activity
    }
    this.storage.insert('scan_runs', {
      id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      status: run.status,
      trigger: run.trigger,
      health_avg: run.healthAvg ?? null,
      health_best: run.healthBest ?? null,
      health_worst: run.healthWorst ?? null,
      repositories: run.repositories,
      branches: run.branches,
      active: run.active,
      stale: run.stale,
      merged: run.merged,
      naming_invalid: run.namingInvalid,
      cleanup_candidates: run.cleanupCandidates,
      notifications: run.notifications,
      emails_sent: run.emailsSent,
      error: null,
      activity_json: JSON.stringify(activity)
    })
    for (const repositoryId of scannedRepositoryIds) {
      this.insertRepoScanSummary(runId, repositoryId, scopedBranches.filter((branch) => branch.repositoryId === repositoryId))
    }
    this.audit.record('monitoring_check', {
      trigger: run.trigger,
      repositories: run.repositories,
      branches: run.branches,
      stale: run.stale,
      namingInvalid: run.namingInvalid,
      merged: run.merged,
      notifications: run.notifications,
      emailsSent: run.emailsSent
    })
    this.emitProgress(runId, activity, {
      status: 'completed',
      branches: run.branches,
      stale: run.stale,
      merged: run.merged,
      namingInvalid: run.namingInvalid,
      cleanupCandidates: run.cleanupCandidates
    })
    return run
  }

  private summarize(branches: BranchSummary[], repositoryCount: number) {
    const count = (fn: (b: BranchSummary) => boolean): number => branches.filter(fn).length
    const scoredBranches = branches.filter((b) => !b.protection.isDefault && !/^(main|develop)$/i.test(b.name))
    const scores = scoredBranches.map((b) => b.health.score).filter((score) => Number.isFinite(score))
    const healthAvg = scores.length
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
      : null
    return {
      branches: branches.length,
      active: count((b) => b.state === 'active'),
      stale: count((b) => b.stale),
      merged: count((b) => b.merged),
      namingInvalid: count((b) => b.naming.status === 'invalid'),
      cleanupCandidates: count((b) => b.cleanupCandidate),
      repositories: repositoryCount,
      healthAvg,
      healthBest: scores.length ? Math.max(...scores) : null,
      healthWorst: scores.length ? Math.min(...scores) : null
    }
  }

  private generateNotifications(branches: BranchSummary[]): NotificationRecord[] {
    const created: NotificationRecord[] = []
    for (const branch of branches) {
      const candidates: Array<{ type: NotificationType; state: string; message: string }> = []
      if (branch.stale) {
        candidates.push({
          type: 'stale',
          state: branch.state,
          message: `${branch.displayName} 已停更，已连续 ${branch.inactiveDays} 天未提交。`
        })
      }
      if (branch.naming.status === 'invalid') {
        candidates.push({
          type: 'naming_violation',
          state: 'naming_invalid',
          message: `${branch.displayName} 命名不符合规范。`
        })
      }
      if (branch.cleanupCandidate) {
        candidates.push({
          type: 'cleanup_candidate',
          state: branch.state,
          message: `${branch.displayName} 是清理候选。`
        })
      }
      for (const candidate of candidates) {
        const dedupKey = `${branch.repositoryId}|${branch.name}|${candidate.type}|${candidate.state}`
        const existing = this.storage.get<Record<string, unknown>>('SELECT id FROM notification_history WHERE dedup_key = ?', [dedupKey])
        if (existing) continue
        const record: NotificationRecord = {
          id: newId(),
          repositoryId: branch.repositoryId,
          repositoryName: branch.repositoryName,
          branch: branch.displayName,
          type: candidate.type,
          state: candidate.state,
          message: candidate.message,
          createdAt: new Date().toISOString(),
          deliveredToDesktop: false,
          deliveredViaEmail: true,
          read: false
        }
        this.storage.insert('notification_history', {
          id: record.id,
          dedup_key: dedupKey,
          repository_id: branch.repositoryId,
          repository_name: branch.repositoryName,
          branch: record.branch,
          type: candidate.type,
          state: candidate.state,
          message: record.message,
          created_at: record.createdAt,
          email: 1,
          read: 0
        })
        created.push(record)
        void record
      }
    }
    return created
  }


  private toIssueRow(branch: BranchSummary): EmailIssueRow {
    return toEmailIssueRow(branch)
  }

  async notifyBranch(branch: BranchSummary): Promise<NotificationRecord[]> {
    return this.generateNotifications([branch])
  }

  async notifyBranchesEmail(branches: BranchSummary[]): Promise<{ sent: number; message: string }> {
    const rows = branches.map((b) => this.toIssueRow(b))
    const result = await this.email.sendCreatorEmails(rows)
    return { sent: result.emailsSent ?? 0, message: result.message }
  }

  async notifySelfEmail(branches: BranchSummary[]): Promise<{ sent: number; message: string }> {
    const summary = this.summarize(branches, 1)
    const data: EmailSummaryData = {
      total: summary.branches,
      stale: summary.stale,
      namingInvalid: summary.namingInvalid,
      merged: summary.merged,
      cleanupCandidates: summary.cleanupCandidates,
      repositories: 1,
      generatedAt: new Date().toISOString(),
      branches: branches.map(toEmailIssueRow),
      thresholdHint: this.thresholdHint(this.readMonitoringRow())
    }
    const result = await this.email.sendSummaryEmail(data)
    return { sent: result.emailsSent ?? 0, message: result.message }
  }

  listNotifications(): NotificationRecord[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM notification_history ORDER BY created_at DESC LIMIT 500')
    return rows.map((r) => ({
      id: String(r.id),
      repositoryId: String(r.repository_id ?? ''),
      repositoryName: String(r.repository_name ?? ''),
      branch: String(r.branch ?? ''),
      type: (r.type as NotificationRecord['type']) ?? 'stale',
      state: String(r.state ?? ''),
      message: String(r.message ?? ''),
      createdAt: String(r.created_at),
      deliveredToDesktop: Number(r.desktop ?? 0) === 1,
      deliveredViaEmail: Number(r.email ?? 0) === 1,
      read: Number(r.read ?? 0) === 1
    }))
  }

  markNotificationRead(id: string): NotificationRecord[] {
    this.storage.update('notification_history', { read: 1 }, 'id = ?', [id])
    return this.listNotifications()
  }

  clearNotifications(): void {
    this.storage.delete('notification_history', '1 = 1')
  }
}
