import type {
  ActivityItem,
  BranchSummary,
  EmailPolicy,
  NotificationRecord,
  Repository,
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
      merged: summary.merged,
      naming_invalid: summary.namingInvalid,
      cleanup_candidates: summary.cleanupCandidates,
      health_avg: summary.healthAvg,
      health_best: summary.healthBest,
      health_worst: summary.healthWorst
    })
  }

  private readMonitoringRow(repositoryId?: string | null): Record<string, unknown> | null {
    if (!repositoryId) return null
    return this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId]) ?? null
  }

  private thresholdHint(row?: Record<string, unknown> | null): string {
    const unitLabel = (unit: string): string => unit === 'weeks' ? '周' : unit === 'hours' ? '小时' : unit === 'minutes' ? '分钟' : '天'
    const staleValue = Number(row?.stale_threshold_days ?? 180)
    return `阈值 ${staleValue} ${unitLabel(String(row?.stale_threshold_unit ?? 'days'))}`
  }

  /**
   * One aggregated email covers every scanned repository, so the mail intent is
   * the union of the per-repository settings rather than the first repository's
   * value applied to all of them.
   */
  private mergeNotifyTargets(repos: Repository[], rowOf: (repositoryId: string) => Record<string, unknown> | null): string {
    const keywords = new Set<string>()
    const recipients: string[] = []
    for (const repo of repos) {
      const parsed = parseNotifyTarget(String(rowOf(repo.id)?.notify_target ?? 'self'))
      if (parsed.self) keywords.add('self')
      if (parsed.creator) keywords.add('creator')
      if (parsed.recipients) recipients.push(parsed.recipients)
    }
    const merged = [...keywords, ...recipients].join(', ')
    return merged || 'none'
  }

  private mergeEmailPolicies(repos: Repository[], rowOf: (repositoryId: string) => Record<string, unknown> | null): Set<EmailPolicy> {
    const merged = new Set<EmailPolicy>()
    for (const repo of repos) {
      const policy = String(rowOf(repo.id)?.email_policy ?? 'none') as EmailPolicy
      if (policy !== 'none') merged.add(policy)
    }
    return merged
  }

  /**
   * The stale threshold is per repository. A multi-repository email has to
   * either state the shared value or name each repository's own threshold
   * instead of quoting one repository's number for all of them.
   */
  private scopedThresholdHint(repos: Repository[], rowOf: (repositoryId: string) => Record<string, unknown> | null): string {
    if (repos.length === 0) return this.thresholdHint(null)
    if (repos.length === 1) return this.thresholdHint(rowOf(repos[0].id))
    const perRepo = repos.map((repo) => ({ name: repo.name, hint: this.thresholdHint(rowOf(repo.id)) }))
    const distinct = new Set(perRepo.map((item) => item.hint))
    if (distinct.size === 1) return this.thresholdHint(rowOf(repos[0].id))
    return perRepo.map((item) => `${item.name}：${item.hint}`).join('；')
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
    // An explicit empty array means "no repository selected" and must never
    // fall back to scanning every repository.
    const requestedIds = options.repositoryIds ?? this.storage.selectedRepositoryIds()
    const requested = repos.filter((r) => requestedIds.includes(r.id))
    if (requested.length === 0) {
      addActivity('未选择仓库：请先在仓库页勾选要检查的仓库。', 'warn')
    }

    // Every repository is gated by its own monitoring row. Reading the first
    // target's row for the whole check used to let one repository's settings
    // decide what happened to every other repository: a disabled first
    // repository aborted the run, and its fetch / mail settings were applied to
    // repositories that configured something else.
    const rowOf = (repositoryId: string): Record<string, unknown> | null => this.readMonitoringRow(repositoryId)
    let targets = requested
    if (!options.bypassEnabledCheck) {
      // A repository whose own monitoring switch is off is out of scope for a
      // scheduled or manual check; the run only fails when no repository in the
      // requested scope is monitored.
      targets = requested.filter((repo) => Number(rowOf(repo.id)?.enabled ?? 1) === 1)
      if (requested.length > 0 && targets.length === 0) {
        throw new Error('Monitoring is disabled. Turn monitoring on to run a check.')
      }
      for (const repo of requested) {
        if (targets.includes(repo)) continue
        addActivity(`${repo.name}：该仓库已关闭监控，本次检查跳过。`, 'warn')
      }
    }

    const allBranches: BranchSummary[] = []
    const scannedRepositoryIds: string[] = []
    const scannedRepos: Repository[] = []
    const failures: string[] = []
    for (const repo of targets) {
      scannedRepositoryIds.push(repo.id)
      const fetchEnabled = options.fetch ?? (rowOf(repo.id)?.fetch_enabled ?? 1) === 1
      addActivity(`Scanning ${repo.name}...`)
      this.emitProgress(runId, activity)
      try {
        const scannedBranches = await this.branchService.scanRepository(repo.id, {
          fetch: fetchEnabled,
          progress: (message) => {
            addActivity(message)
            this.emitProgress(runId, activity)
          }
        })
        const branches = scannedBranches.map((branch) => ({ ...branch, repositoryName: repo.name }))
        allBranches.push(...branches)
        scannedRepos.push(repo)
        addActivity(`${repo.name}: ${branches.length} branches analyzed.`, 'success')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const failure = `${repo.name}: ${message}`
        failures.push(failure)
        addActivity(failure, 'error')
      }
      this.emitProgress(runId, activity)
    }

    const summary = this.summarize(allBranches, targets.length)
    // A check that reached no repository at all is a failure, not a clean run
    // with zero branches: reporting "completed" hid the reason from the UI.
    const status: ScanRun['status'] = failures.length > 0 && failures.length === targets.length
      ? 'failed'
      : 'completed'
    addActivity(
      `Check complete: ${summary.branches} branches, ${summary.stale} stale, ${summary.namingInvalid} naming violations.`,
      'success'
    )
    if (failures.length > 0) {
      addActivity(
        `${failures.length} of ${targets.length} repositories could not be scanned.`,
        status === 'failed' ? 'error' : 'warn'
      )
    }

    const notifications: NotificationRecord[] = []
    // Notifications follow each repository's own switch: enabling them for one
    // repository must not enable them for every other selected repository.
    const notifyingRepos = options.trigger === 'scan_repository'
      ? []
      : targets.filter((repo) => Number(rowOf(repo.id)?.notification_enabled ?? 1) === 1)
    const notifyingIds = new Set(notifyingRepos.map((repo) => repo.id))
    const notifiableBranches = allBranches.filter((branch) => notifyingIds.has(branch.repositoryId))
    if (notifiableBranches.length > 0) {
      const created = this.generateNotifications(notifiableBranches)
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
    // Mail settings are merged across the selected repositories instead of
    // inheriting the first one: one aggregating email has to cover every
    // repository, so the union of the configured intents is what gets sent.
    const notifyTarget = options.notifyTarget ?? this.mergeNotifyTargets(scannedRepos, rowOf)
    const policy: Set<EmailPolicy> = options.emailPolicy ? new Set([options.emailPolicy]) : this.mergeEmailPolicies(scannedRepos, rowOf)
    const parsedNotify = parseNotifyTarget(typeof notifyTarget === 'string' ? notifyTarget : 'none')
    if (parsedNotify.self || parsedNotify.recipients) delivery.push('summary')
    if (parsedNotify.creator) delivery.push('creators')
    if (delivery.length === 0) {
      if (policy.has('summary')) delivery.push('summary')
      if (policy.has('creators')) delivery.push('creators')
    }
    const thresholdHint = this.scopedThresholdHint(scannedRepos, rowOf)
    for (const deliveryKind of options.trigger === 'scan_repository' ? [] : delivery) {
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
          repositories: targets.length,
          generatedAt: new Date().toISOString(),
          branches: allBranches.map(toEmailIssueRow),
          thresholdHint
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
          thresholdHint
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
      status,
      trigger: options.trigger ?? 'manual',
      healthAvg: summary.healthAvg,
      healthBest: summary.healthBest,
      healthWorst: summary.healthWorst,
      repositories: targets.length,
      branches: summary.branches,
      active: summary.active,
      stale: summary.stale,
      merged: summary.merged,
      namingInvalid: summary.namingInvalid,
      cleanupCandidates: summary.cleanupCandidates,
      notifications: notifications.length,
      emailsSent,
      error: failures.length > 0 ? failures.join(' | ') : null,
      activity,
      repositoryIds: [...scannedRepositoryIds]
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
      error: run.error,
      activity_json: JSON.stringify(activity)
    })
    for (const repositoryId of scannedRepositoryIds) {
      this.insertRepoScanSummary(runId, repositoryId, allBranches.filter((branch) => branch.repositoryId === repositoryId))
    }
    this.audit.record('monitoring_check', {
      trigger: run.trigger,
      repositoryIds: scannedRepositoryIds,
      repositories: run.repositories,
      branches: run.branches,
      stale: run.stale,
      namingInvalid: run.namingInvalid,
      merged: run.merged,
      notifications: run.notifications,
      emailsSent: run.emailsSent
    })
    this.emitProgress(runId, activity, {
      status: run.status,
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
    // The threshold quoted in the mail belongs to the repositories the branches
    // actually come from, not to whatever row happens to be first in the table.
    const repoIds = [...new Set(branches.map((branch) => branch.repositoryId))]
    const repos = repoIds
      .map((id) => this.repositoryService.get(id))
      .filter((repo): repo is Repository => Boolean(repo))
    const summary = this.summarize(branches, Math.max(repos.length, 1))
    const data: EmailSummaryData = {
      total: summary.branches,
      stale: summary.stale,
      namingInvalid: summary.namingInvalid,
      merged: summary.merged,
      cleanupCandidates: summary.cleanupCandidates,
      repositories: Math.max(repos.length, 1),
      generatedAt: new Date().toISOString(),
      branches: branches.map(toEmailIssueRow),
      thresholdHint: this.scopedThresholdHint(repos, (id) => this.readMonitoringRow(id))
    }
    const result = await this.email.sendSummaryEmail(data)
    return { sent: result.emailsSent ?? 0, message: result.message }
  }

  listNotifications(repositoryIds?: string[]): NotificationRecord[] {
    const scope = repositoryIds ?? this.storage.selectedRepositoryIds()
    if (scope.length === 0) return []
    const selected = new Set(scope)
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM notification_history ORDER BY created_at DESC LIMIT 500')
    return rows.filter((r) => selected.has(String(r.repository_id ?? ''))).map((r) => {
      const rawType = String(r.type ?? '')
      const type: NotificationRecord['type'] = rawType === 'naming_violation' || rawType === 'cleanup_candidate'
        ? rawType
        : 'stale'
      return {
        id: String(r.id),
        repositoryId: String(r.repository_id ?? ''),
        repositoryName: String(r.repository_name ?? ''),
        branch: String(r.branch ?? ''),
        type,
        state: type === 'stale' ? 'stale' : String(r.state ?? ''),
        message: String(r.message ?? '').replace(/宽限期|grace period/gi, '已停更'),
        createdAt: String(r.created_at),
        deliveredToDesktop: Number(r.desktop ?? 0) === 1,
        deliveredViaEmail: Number(r.email ?? 0) === 1,
        read: Number(r.read ?? 0) === 1
      }
    })
  }

  markNotificationRead(id: string, repositoryIds?: string[]): NotificationRecord[] {
    const visible = this.listNotifications(repositoryIds)
    if (!visible.some((record) => record.id === id)) {
      throw new Error('该通知不属于当前勾选的仓库。')
    }
    this.storage.update('notification_history', { read: 1 }, 'id = ?', [id])
    return this.listNotifications(repositoryIds)
  }

  clearNotifications(repositoryIds?: string[]): void {
    const scope = repositoryIds ?? this.storage.selectedRepositoryIds()
    if (scope.length === 0) return
    const placeholders = scope.map(() => '?').join(', ')
    this.storage.delete('notification_history', `repository_id IN (${placeholders})`, scope)
  }
}
