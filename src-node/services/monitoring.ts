import type {
  ActivityItem,
  BranchSummary,
  EmailPolicy,
  NotificationRecord,
  NotifyTarget,
  NotificationType,
  Repository,
  RunCheckOptions,
  ScanProgress,
  ScanRun
} from '@shared/types'
import type { StorageService } from './storage'
import type { BranchService } from './branch'
import type { RepositoryService } from './repository'
import type { EmailService, EmailIssueRow, EmailSummaryData } from './email'
import { resolveRecipients, parseNotifyTarget, toEmailIssueRow } from './email'
import { isMonitoredBranch } from './branch'
import { partitionRecipientTokens, resolveGroupScope } from '@shared/groups'
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
    if (!repositoryId) return null
    return this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId]) ?? null
  }

  /**
   * 汇总邮件 + 命中的分组收件人。
   *
   * 收件人里的组名是「通知范围」，不是「检查范围」：邮件内容仍是本次检查的全部分支，
   * 只是把收件人换成该组的组员。要收窄检查范围请在「分组范围」里选组——那时数据
   * 已先按组过滤，两者可以叠加：只查这个组、也只通知这个组。
   *
   * 每个组单独发一封（而不是把所有组员并到一个收件人列表），避免组与组之间互相
   * 看到对方成员邮箱。
   */
  private async sendSummaryWithGroups(input: {
    groupTargets: EmailGroup[]
    data: EmailSummaryData
    recipients: string[]
    allowDefaultRecipient: boolean
    addActivity: (message: string, level?: ActivityItem['level']) => void
  }): Promise<{ ok: boolean; message: string; sent: number }> {
    let sent = 0
    let ok = false
    let message = 'Email is disabled or no recipient is configured.'
    if (input.recipients.length > 0 || (input.allowDefaultRecipient && input.groupTargets.length === 0)) {
      const result = await this.email.sendSummaryEmail(
        input.data,
        undefined,
        input.recipients.length > 0 ? input.recipients : undefined
      )
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
      const result = await this.groups.emailSummaryToGroup(group, input.data)
      if (result.ok) {
        sent += result.sent
        ok = true
        input.addActivity('分组「' + group.name + '」邮件已发送（' + input.data.total + ' 个分支）。', 'success')
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

  /** Merge the per-repository mail intent because one email covers every scanned repository. */
  private mergeNotifyTargets(repos: Repository[], rowOf: (repositoryId: string) => Record<string, unknown> | null): NotifyTarget {
    const keywords = new Set<string>()
    const recipients: string[] = []
    for (const repo of repos) {
      const parsed = parseNotifyTarget(String(rowOf(repo.id)?.notify_target ?? 'self'))
      if (parsed.self) keywords.add('self')
      if (parsed.creator) keywords.add('creator')
      if (parsed.recipients) recipients.push(parsed.recipients)
    }
    return [...keywords, ...recipients].join(', ') || 'none'
  }

  private mergeEmailPolicies(repos: Repository[], rowOf: (repositoryId: string) => Record<string, unknown> | null): Set<EmailPolicy> {
    const merged = new Set<EmailPolicy>()
    for (const repo of repos) {
      const policy = String(rowOf(repo.id)?.email_policy ?? 'none') as EmailPolicy
      if (policy !== 'none') merged.add(policy)
    }
    return merged
  }

  /** State the shared threshold or name each repository's own threshold. */
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
    // An explicit empty array means "nothing selected" and must not mean "all repositories".
    const requestedIds = options.repositoryIds ?? this.storage.selectedRepositoryIds()
    const requested = repos.filter((repo) => requestedIds.includes(repo.id))
    if (requested.length === 0) {
      addActivity('未选择仓库：请先在仓库页勾选要检查的仓库。', 'warn')
    }

    // Every repository is gated by its own monitoring row. The first repository
    // must not decide fetch, notifications or mail delivery for all the others.
    const rowOf = (repositoryId: string): Record<string, unknown> | null => this.readMonitoringRow(repositoryId)
    let targets = requested
    if (!options.bypassEnabledCheck) {
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
    // Per-repository scan failures. They are collected rather than thrown so one
    // unreachable repository cannot abort the checks of the others, but they must
    // still surface: a scan that fetched nothing used to be reported as a clean
    // run with "0 branches", which hid an unreachable or misconfigured forge.
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
    // A run is only `failed` when it produced nothing at all; a partial failure
    // keeps the successful results and reports the rest through `error`.
    const status: ScanRun['status'] = failures.length > 0 && failures.length === targets.length ? 'failed' : 'completed'
    if (failures.length > 0) {
      addActivity(
        `${failures.length} of ${targets.length} repositories could not be scanned.`,
        status === 'failed' ? 'error' : 'warn'
      )
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
    const notifyingRepos = options.trigger === 'scan_repository'
      ? []
      : targets.filter((repo) => Number(rowOf(repo.id)?.notification_enabled ?? 1) === 1)
    const notifyingIds = new Set(notifyingRepos.map((repo) => repo.id))
    const notifiableBranches = scopedBranches.filter((branch) => notifyingIds.has(branch.repositoryId) && isMonitoredBranch(branch.name))
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
    const notifyTarget = options.notifyTarget ?? this.mergeNotifyTargets(scannedRepos, rowOf)
    const policy = options.emailPolicy ? new Set<EmailPolicy>([options.emailPolicy]) : this.mergeEmailPolicies(scannedRepos, rowOf)
    const parsedNotify = parseNotifyTarget(typeof notifyTarget === 'string' ? notifyTarget : 'none')
    if (parsedNotify.self || parsedNotify.recipients) delivery.push('summary')
    if (parsedNotify.creator) delivery.push('creators')
    if (delivery.length === 0) {
      if (policy.has('summary')) delivery.push('summary')
      if (policy.has('creators')) delivery.push('creators')
    }
    const thresholdHint = this.scopedThresholdHint(scannedRepos, rowOf)
    for (const deliveryKind of options.trigger === 'scan_repository' ? [] : delivery) {
      // A partial scan would publish a branch count that depends on which
      // repositories happened to answer. Skip delivery and surface the failure
      // instead of mailing inconsistent totals.
      if (failures.length > 0) {
        addActivity('Email skipped because one or more repositories failed to scan.', 'warn')
        break
      }
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
          branches: scopedBranches.filter((branch) => isMonitoredBranch(branch.name)).map(toEmailIssueRow),
          thresholdHint
        }
        const cfg = this.email.getConfig()
        const selfAddress = cfg.selfEmail || cfg.testRecipient || cfg.username
        const targetRecipients: string[] = []
        if (parsedNotify.self && selfAddress) targetRecipients.push(selfAddress)
        // 组名 token 不能混进普通收件人列表：它表示「把本次检查结果发给这个组的组员」，
        // 由 sendSummaryWithGroups 单独按组发信（见该方法注释）。
        const { matched: groupTargets, plain } = partitionRecipientTokens(parsedNotify.recipients, groups)
        if (plain) targetRecipients.push(...resolveRecipients(plain, []))
        const uniqueRecipients = [...new Set(targetRecipients.filter(Boolean))]
        const result = await this.sendSummaryWithGroups({
          groupTargets,
          data,
          recipients: uniqueRecipients,
          allowDefaultRecipient: deliveryKind === 'summary'
            && policy.has('summary')
            && !parsedNotify.self
            && !parsedNotify.recipients,
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
          .filter((b) => isMonitoredBranch(b.name))
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
      repositories: scopedRepositoryCount,
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
    const scoredBranches = branches.filter((b) => !b.protection.isDefault && !/^(main|develop)$/i.test(b.name) && b.name !== 'develop_XC')
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
    const rows = branches.filter((b) => isMonitoredBranch(b.name)).map((b) => this.toIssueRow(b))
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
    const hasStale = branches.some((b) => b.stale)
    const hasNaming = branches.some((b) => b.naming.status === 'invalid')
    const data: EmailSummaryData = {
      total: summary.branches,
      stale: summary.stale,
      namingInvalid: summary.namingInvalid,
      merged: summary.merged,
      cleanupCandidates: summary.cleanupCandidates,
      repositories: Math.max(repos.length, 1),
      generatedAt: new Date().toISOString(),
      branches: branches.filter((b) => isMonitoredBranch(b.name)).map(toEmailIssueRow),
      thresholdHint: this.scopedThresholdHint(repos, (id) => this.readMonitoringRow(id)),
      sections: { stale: hasStale, naming: hasNaming }
    }
    const result = await this.email.sendSummaryEmail(data)
    return { sent: result.emailsSent ?? 0, message: result.message }
  }

  listNotifications(repositoryIds?: string[]): NotificationRecord[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM notification_history ORDER BY created_at DESC LIMIT 500')
    const mapped = rows.map((r) => ({
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
    return repositoryIds === undefined ? mapped : mapped.filter((r) => repositoryIds.includes(r.repositoryId))
  }

  markNotificationRead(id: string, repositoryIds?: string[]): NotificationRecord[] {
    const target = this.listNotifications(repositoryIds).find((row) => row.id === id)
    if (!target) return this.listNotifications(repositoryIds)
    this.storage.update('notification_history', { read: 1 }, 'id = ?', [id])
    return this.listNotifications(repositoryIds)
  }

  clearNotifications(repositoryIds?: string[]): void {
    const ids = this.listNotifications(repositoryIds).map((row) => row.id)
    if (ids.length === 0) return
    this.storage.delete(`notification_history`, `id IN (${ids.map(() => '?').join(',')})`, ids)
  }
}
