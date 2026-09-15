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
import type { AuditService } from './audit'
import { newId } from '../utils/ids'

export class MonitoringService {
  onProgress: ((progress: ScanProgress) => void) | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly branchService: BranchService,
    private readonly repositoryService: RepositoryService,
    private readonly email: EmailService,
    private readonly audit: AuditService
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
      grace_period: summary.gracePeriod,
      grace_expired: summary.graceExpired,
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

  private thresholdHint(row?: Record<string, unknown> | null): string {
    const unitLabel = (unit: string): string => unit === 'weeks' ? '周' : unit === 'hours' ? '小时' : unit === 'minutes' ? '分钟' : '天'
    const staleValue = Number(row?.stale_threshold_days ?? 180)
    const graceValue = Number(row?.grace_period_days ?? 60)
    return `阈值 ${staleValue} ${unitLabel(String(row?.stale_threshold_unit ?? 'days'))} · 提醒窗口 ${graceValue} ${unitLabel(String(row?.grace_period_unit ?? 'days'))}`
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
    const globalDeletionDisabled = Number(this.storage.get<Record<string, unknown>>('SELECT deletion_disabled FROM app_settings WHERE id = 1')?.deletion_disabled ?? 0) === 1
    const autoDeleteEnabled = globalDeletionDisabled ? false : (options.autoDelete ?? Number(monitoringRow?.auto_delete_enabled ?? 0) === 1)
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

    const summary = this.summarize(allBranches, targets.length)
    addActivity(
      `Check complete: ${summary.branches} branches, ${summary.stale} stale, ${summary.graceExpired} grace expired, ${summary.namingInvalid} naming violations.`,
      'success'
    )

    const notifications: NotificationRecord[] = []
    if (notificationsEnabled) {
      const created = this.generateNotifications(allBranches)
      notifications.push(...created)
      if (created.length > 0) {
        addActivity(`${created.length} new notification${created.length === 1 ? '' : 's'} generated.`)
      }
    } else {
      addActivity('Notifications are disabled.', 'warn')
    }

    let deleted = 0
    if (autoDeleteEnabled) {
      deleted = await this.branchService.autoDeleteExpiredBranches(allBranches)
      if (deleted > 0) {
        addActivity(`Auto cleanup removed ${deleted} expired remote branch${deleted === 1 ? '' : 'es'}.`, 'success')
      } else {
        const graceExpiredCount = allBranches.filter((b) => b.graceExpired).length
        const whitelistedExpiredCount = allBranches.filter((b) => b.graceExpired && b.protection.whitelisted).length
        const gracePeriodCount = allBranches.filter((b) => b.state === 'grace_period').length
        const reason = whitelistedExpiredCount > 0
          ? `${whitelistedExpiredCount} grace-expired branch${whitelistedExpiredCount === 1 ? ' is' : 'es are'} protected by the whitelist`
          : graceExpiredCount === 0
            ? `no branches have passed the threshold plus grace period${gracePeriodCount > 0 ? ` (${gracePeriodCount} in grace period)` : ''}`
            : 'eligible branches are not available on the remote repository'
        addActivity(`Auto cleanup checked, but no branches were eligible: ${reason}.`, 'warn')
      }
    } else {
      addActivity('Auto cleanup is disabled; this was an inspection-only check.')
    }

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
          gracePeriod: summary.gracePeriod,
          graceExpired: summary.graceExpired,
          namingInvalid: summary.namingInvalid,
          merged: summary.merged,
          cleanupCandidates: summary.cleanupCandidates,
          repositories: targets.length,
          generatedAt: new Date().toISOString(),
          branches: allBranches.map(toEmailIssueRow),
          thresholdHint: this.thresholdHint(monitoringRow)
        }
        const cfg = this.email.getConfig()
        const selfAddress = cfg.selfEmail || cfg.testRecipient || cfg.username
        const targetRecipients: string[] = []
        if (parsedNotify.self && selfAddress) targetRecipients.push(selfAddress)
        if (parsedNotify.recipients) targetRecipients.push(...resolveRecipients(parsedNotify.recipients, groups))
        const uniqueRecipients = [...new Set(targetRecipients.filter(Boolean))]
        const result = await this.email.sendSummaryEmail(
          data,
          undefined,
          uniqueRecipients.length > 0 ? uniqueRecipients : undefined
        )
        if (result.ok) {
          emailsSent += result.emailsSent ?? 0
          addActivity('Summary email sent to self (1 email).', 'success')
        } else {
          addActivity(result.message, 'error')
        }
      } else {
        const rows: EmailIssueRow[] = allBranches
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
      repositories: targets.length,
      branches: summary.branches,
      active: summary.active,
      stale: summary.stale,
      gracePeriod: summary.gracePeriod,
      graceExpired: summary.graceExpired,
      merged: summary.merged,
      namingInvalid: summary.namingInvalid,
      cleanupCandidates: summary.cleanupCandidates,
      deleted,
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
      grace_period: run.gracePeriod,
      grace_expired: run.graceExpired,
      merged: run.merged,
      naming_invalid: run.namingInvalid,
      cleanup_candidates: run.cleanupCandidates,
      deleted: run.deleted,
      notifications: run.notifications,
      emails_sent: run.emailsSent,
      error: null,
      activity_json: JSON.stringify(activity)
    })
    for (const repositoryId of scannedRepositoryIds) {
      this.insertRepoScanSummary(runId, repositoryId, allBranches.filter((branch) => branch.repositoryId === repositoryId))
    }
    this.audit.record('monitoring_check', {
      trigger: run.trigger,
      repositories: run.repositories,
      branches: run.branches,
      stale: run.stale,
      namingInvalid: run.namingInvalid,
      merged: run.merged,
      deleted: run.deleted,
      notifications: run.notifications,
      emailsSent: run.emailsSent
    })
    this.emitProgress(runId, activity, {
      status: 'completed',
      branches: run.branches,
      stale: run.stale,
      gracePeriod: run.gracePeriod,
      graceExpired: run.graceExpired,
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
      gracePeriod: count((b) => b.state === 'grace_period'),
      graceExpired: count((b) => b.state === 'grace_expired'),
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
      if (branch.state === 'grace_expired') {
        candidates.push({
          type: 'grace_expired',
          state: branch.state,
          message: `${branch.displayName} 宽限期已过，已连续 ${branch.inactiveDays} 天未提交。`
        })
      } else if (branch.stale) {
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
      gracePeriod: summary.gracePeriod,
      graceExpired: summary.graceExpired,
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
