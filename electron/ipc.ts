import { BrowserWindow, dialog, ipcMain } from 'electron'
import { app } from 'electron'
import type {
  AppSettings,
  AuditEntry,
  AuditExportResult,
  BranchCriteria,
  BranchSummary,
  DashboardSnapshot,
  DeleteAuthSession,
  DeleteRequest,
  DeleteResult,
  EmailConfig,
  EmailGroup,
  EmailSendResult,
  GitLabConnectionConfig,
  GitLabProject,
  GitLabTestResult,
  MonitoringConfig,
  NamingResult,
  NamingRule,
  NotificationRecord,
  ProtectionEntry,
  ReportRecord,
  Repository,
  ReportSchedule,
  RunCheckOptions,
  ScanRun,
  SchedulerJob
} from '@shared/types'
import { exportAuditLogs } from './services/audit-export'
import type { StorageService } from './services/storage'
import type { GitService } from './services/git'
import type { RepositoryService } from './services/repository'
import type { BranchService } from './services/branch'
import type { NamingService } from './services/naming'
import type { ProtectionService } from './services/protection'
import type { DeletionPolicyEngine, DeletionTokenRegistry } from './services/deletion'
import type { MonitoringService } from './services/monitoring'
import type { EmailService } from './services/email'
import type { GitLabService } from './services/gitlab'
import type { SchedulerService } from './services/scheduler'
import type { ReportService } from './services/report'
import type { ReportScheduleService } from './services/reportSchedule'
import type { AuditService } from './services/audit'
import type { SettingsService } from './services/settings'

export interface AppServices {
  storage: StorageService
  git: GitService
  repository: RepositoryService
  branch: BranchService
  naming: NamingService
  protection: ProtectionService
  deletionEngine: DeletionPolicyEngine
  deletionTokens: DeletionTokenRegistry
  monitoring: MonitoringService
  email: EmailService
  gitlab: GitLabService
  scheduler: SchedulerService
  report: ReportService
  reportSchedules: ReportScheduleService
  audit: AuditService
  settings: SettingsService
}

function scanRunFromRow(row: Record<string, unknown>): ScanRun {
  let activity: ScanRun['activity'] = []
  try {
    activity = JSON.parse(String(row.activity_json ?? '[]'))
  } catch {
    activity = []
  }
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
    status: (row.status as ScanRun['status']) ?? 'completed',
    trigger: (row.trigger as ScanRun['trigger']) ?? 'manual',
    healthAvg: row.health_avg == null ? null : Number(row.health_avg),
    healthBest: row.health_best == null ? null : Number(row.health_best),
    healthWorst: row.health_worst == null ? null : Number(row.health_worst),
    repositories: Number(row.repositories ?? 0),
    branches: Number(row.branches ?? 0),
    active: Number(row.active ?? 0),
    stale: Number(row.stale ?? 0),
    gracePeriod: Number(row.grace_period ?? 0),
    graceExpired: Number(row.grace_expired ?? 0),
    merged: Number(row.merged ?? 0),
    namingInvalid: Number(row.naming_invalid ?? 0),
    cleanupCandidates: Number(row.cleanup_candidates ?? 0),
    deleted: Number(row.deleted ?? 0),
    notifications: Number(row.notifications ?? 0),
    emailsSent: Number(row.emails_sent ?? 0),
    error: (row.error as string | null) ?? null,
    activity
  }
}

export function registerIpc(services: AppServices): void {
  const { storage, gitlab, repository, branch, naming, protection, deletionEngine, deletionTokens, monitoring, email, scheduler, report, reportSchedules, audit, settings } = services

  services.monitoring.onProgress = (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('branchpulse:scan-progress', progress)
    }
  }

  ipcMain.handle('branchpulse:init', async (): Promise<DashboardSnapshot> => {
    const currentSettings = settings.get()
    const activeRepositoryId = currentSettings.activeRepositoryId
    const scanRuns = storage
      .all<Record<string, unknown>>('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 50')
      .map(scanRunFromRow)
    return {
      repositories: repository.list(),
      branches: branch.listBranches(),
      scanRuns,
      notifications: monitoring.listNotifications(),
      settings: settings.get(),
      monitoring: await getMonitoring(activeRepositoryId),
      activeRepositoryId
    }
  })

  async function getMonitoring(repositoryId?: string | null): Promise<MonitoringConfig> {
    const row = repositoryId
      ? (storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId])
        ?? storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules WHERE id = 1'))
      : storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules WHERE id = 1')
    return {
      enabled: Number(row?.enabled ?? 1) === 1,
      staleThresholdDays: Number(row?.stale_threshold_days ?? 14),
      gracePeriodDays: Number(row?.grace_period_days ?? 7),
      staleThresholdUnit: ((row?.stale_threshold_unit as MonitoringConfig['staleThresholdUnit']) ?? 'days'),
      gracePeriodUnit: ((row?.grace_period_unit as MonitoringConfig['gracePeriodUnit']) ?? 'days'),
      fetchEnabled: Number(row?.fetch_enabled ?? 1) === 1,
      namingEnabled: Number(row?.naming_enabled ?? 1) === 1,
      emailPolicy: ((row?.email_policy as MonitoringConfig['emailPolicy']) ?? 'none'),
      notificationEnabled: Number(row?.notification_enabled ?? 1) === 1,
      autoDeleteEnabled: Number(row?.auto_delete_enabled ?? 0) === 1,
      notifyTarget: ((row?.notify_target as MonitoringConfig['notifyTarget']) ?? 'self')
    }
  }

  async function saveMonitoring(config: MonitoringConfig, repositoryId?: string | null): Promise<MonitoringConfig> {
    const values = {
      enabled: config.enabled ? 1 : 0,
      stale_threshold_days: config.staleThresholdDays,
      grace_period_days: config.gracePeriodDays,
      stale_threshold_unit: config.staleThresholdUnit,
      grace_period_unit: config.gracePeriodUnit,
      fetch_enabled: config.fetchEnabled ? 1 : 0,
      naming_enabled: config.namingEnabled ? 1 : 0,
      email_policy: config.emailPolicy,
      notification_enabled: config.notificationEnabled ? 1 : 0,
      auto_delete_enabled: config.autoDeleteEnabled ? 1 : 0,
      notify_target: config.notifyTarget
    }
    if (repositoryId) {
      const existing = storage.get<Record<string, unknown>>('SELECT repository_id FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId])
      if (existing) {
        storage.update('monitoring_rules_repo', values, 'repository_id = ?', [repositoryId])
      } else {
        storage.insert('monitoring_rules_repo', { repository_id: repositoryId, ...values })
      }
    } else {
      storage.update('monitoring_rules', values, 'id = 1')
    }
    audit.record('monitoring_rules_updated', {
      repositoryId: repositoryId ?? null,
      enabled: config.enabled,
      staleThresholdDays: config.staleThresholdDays,
      gracePeriodDays: config.gracePeriodDays,
      staleThresholdUnit: config.staleThresholdUnit,
      gracePeriodUnit: config.gracePeriodUnit
    })
    return getMonitoring(repositoryId)
  }

  // --- beginDelete / deleteBranch local helpers (shared by single and batch) ---

  async function beginDeleteFor(criteria: BranchCriteria): Promise<DeleteAuthSession> {
    const branchSummary = await branch.getBranch(criteria)
    const target = branchSummary
      ? { existsLocally: branchSummary.existsLocally, existsRemotely: branchSummary.existsRemotely }
      : { existsLocally: false, existsRemotely: false }
    const protectionInfo = branchSummary?.protection ?? { whitelisted: false, isDefault: false, protected: false, rules: [] }
    const decision = deletionEngine.evaluate(
      { name: criteria.name, protection: protectionInfo, existsLocally: target.existsLocally, existsRemotely: target.existsRemotely },
      { authorized: false, targetType: criteria.type, repositoryId: criteria.repositoryId, branch: criteria.name, confirmationToken: '', confirmed: false },
      target
    )
    if (settings.get().deletionDisabled) {
      return {
        token: '',
        branch: branchSummary,
        expiresAt: 0,
        decision: { allowed: false, code: 'USER_NOT_AUTHORIZED', message: 'Branch deletion is globally disabled.', checks: [{ name: 'GLOBAL_DISABLED', passed: false, detail: 'Branch deletion is globally disabled.' }] }
      }
    }
    if (!branchSummary || !decision.allowed) {
      return { token: '', decision, branch: branchSummary, expiresAt: 0 }
    }
    const session = deletionTokens.create(criteria.repositoryId, criteria.name, criteria.type)
    return { token: session.token, decision, branch: branchSummary, expiresAt: session.expiresAt }
  }

  async function executeDelete(request: DeleteRequest): Promise<DeleteResult> {
    const auth = request.authorization
    const criteria: BranchCriteria = { repositoryId: auth.repositoryId, name: auth.branch, type: auth.targetType }
    if (settings.get().deletionDisabled) {
      const message = 'Branch deletion is globally disabled.'
      audit.record('branch_delete', { repository: auth.repositoryId, branch: auth.branch, targetType: auth.targetType, result: 'blocked', reason: 'global_deletion_disabled' }, 'failure')
      return {
        branch: auth.branch,
        targetType: auth.targetType,
        ok: false,
        message,
        decision: { allowed: false, code: 'USER_NOT_AUTHORIZED', message, checks: [{ name: 'GLOBAL_DISABLED', passed: false, detail: message }] }
      }
    }
    const failResult = (code: DeleteResult['decision']['code'], message: string, reason: string): DeleteResult => {
      const result: DeleteResult = {
        branch: auth.branch, targetType: auth.targetType, ok: false, message,
        decision: { allowed: false, code, message, checks: [{ name: code ?? 'error', passed: false, detail: message }] }
      }
      audit.record('branch_delete', { repository: auth.repositoryId, branch: auth.branch, targetType: auth.targetType, result: 'blocked', reason }, 'failure')
      return result
    }

    const tokenValid = deletionTokens.consume(request.confirmationToken, auth.repositoryId, auth.branch, auth.targetType)
    if (!tokenValid) return failResult('TOKEN_MISMATCH', 'Confirmation token is invalid or expired.', 'token_mismatch')

    const branchSummary = await branch.getBranch(criteria)
    if (!branchSummary) return failResult('TARGET_MISSING', 'Branch target no longer exists.', 'target_missing')

    const target = { existsLocally: branchSummary.existsLocally, existsRemotely: branchSummary.existsRemotely }
    const decision = deletionEngine.evaluate(
      { name: branchSummary.name, protection: branchSummary.protection, existsLocally: target.existsLocally, existsRemotely: target.existsRemotely },
      { authorized: true, targetType: auth.targetType, repositoryId: auth.repositoryId, branch: auth.branch, confirmationToken: request.confirmationToken, confirmed: true },
      target
    )
    if (!decision.allowed) {
      return failResult(decision.code, decision.message, decision.code ?? 'policy_blocked')
    }

    try {
      const repo = repository.get(auth.repositoryId)
      if (auth.targetType === 'local') {
        throw new Error('当前仅支持通过远程仓库 API 删除远程分支。')
      } else if (repo && repo.source !== 'local' && repo.gitlabProjectId) {
        await gitlab.deleteBranch(repo.gitlabProjectId, auth.branch, {
          provider: repo.source,
          url: repo.gitlabUrl,
          projectPath: repo.remoteProjectPath,
          ...(repository.getRemoteToken(repo.id) ? { apiKey: repository.getRemoteToken(repo.id) } : {})
        })
        branch.deleteRemoteRecord(criteria)
      } else if (repo && auth.targetType === 'remote') {
        throw new Error('远程仓库配置不完整，无法通过 API 删除分支。')
      } else {
        throw new Error('当前仅支持通过远程仓库 API 管理分支。')
      }
      audit.record('branch_delete', {
        repository: branchSummary.repositoryName, branch: auth.branch, targetType: auth.targetType, remote: branchSummary.remote,
        userAuthorization: true, reason: request.reason ?? 'user_request', result: 'deleted'
      })
      return { branch: auth.branch, targetType: auth.targetType, ok: true, message: `Branch ${auth.branch} (${auth.targetType}) deleted.`, decision }
    } catch (err) {
      const technical = err instanceof Error ? err.message : String(err)
      audit.record('branch_delete', { repository: branchSummary.repositoryName, branch: auth.branch, targetType: auth.targetType, result: 'failed', technical }, 'failure')
      return { branch: auth.branch, targetType: auth.targetType, ok: false, message: `Unable to delete ${auth.branch}.`, decision: { allowed: false, code: 'STALE_STATE', message: `Git operation failed: ${technical}`, checks: decision.checks } }
    }
  }

  // --- IPC handlers ---

  ipcMain.handle('branchpulse:addGitLabRepository', (_e, projectId: number, config?: GitLabConnectionConfig): Promise<Repository> =>
    repository.addGitLab(projectId, config).then((repo) => {
      audit.record('repository_added', { repository: repo.name, url: repo.webUrl })
      return repo
    }))
  ipcMain.handle('branchpulse:listGitLabProjects', (_e, config?: GitLabConnectionConfig): Promise<GitLabProject[]> =>
    gitlab.listProjects(config))
  ipcMain.handle('branchpulse:testGitLabConnection', (_e, config?: GitLabConnectionConfig): Promise<GitLabTestResult> =>
    gitlab.testConnection(config))
  ipcMain.handle('branchpulse:removeRepository', (_e, id: string): Repository[] => {
    const repo = repository.get(id)
    const next = repository.remove(id)
    audit.record('repository_removed', { repository: repo?.name ?? id })
    return next
  })
  ipcMain.handle('branchpulse:listRepositories', (): Repository[] => repository.list())
  ipcMain.handle('branchpulse:scanRepository', (_e, id: string, fetch?: boolean): Promise<ScanRun> =>
    monitoring.runCheckNow({ repositoryIds: [id], fetch, trigger: 'scan_repository', bypassEnabledCheck: true }).then((run) => {
      const repo = repository.get(id)
      audit.record('repository_scanned', { repository: repo?.name ?? id, branches: run.branches, stale: run.stale })
      return run
    }))
  ipcMain.handle('branchpulse:runCheckNow', async (_e, options: RunCheckOptions = {}): Promise<ScanRun> => {
    try {
      const run = await monitoring.runCheckNow(options)
      audit.record('check_requested', { trigger: options.trigger ?? 'manual', branches: run.branches, emailsSent: run.emailsSent })
      return run
    } catch (err) {
      audit.record('check_failed', {
        trigger: options.trigger ?? 'manual',
        error: err instanceof Error ? err.message : String(err)
      }, 'failure')
      throw err
    }
  })
  ipcMain.handle('branchpulse:listBranches', (): BranchSummary[] => branch.listBranches())
  ipcMain.handle('branchpulse:getBranch', (_e, criteria: BranchCriteria): Promise<BranchSummary | null> => branch.getBranch(criteria))
  ipcMain.handle('branchpulse:notifyBranch', (_e, bs: BranchSummary): Promise<NotificationRecord[]> => monitoring.notifyBranch(bs))
  ipcMain.handle('branchpulse:notifyBranchesEmail', (_e, bs: BranchSummary[]): Promise<{ sent: number; message: string }> => monitoring.notifyBranchesEmail(bs))
  ipcMain.handle('branchpulse:notifySelfEmail', (_e, bs: BranchSummary[]): Promise<{ sent: number; message: string }> => monitoring.notifySelfEmail(bs))
  ipcMain.handle('branchpulse:beginDelete', (_e, criteria: BranchCriteria): Promise<DeleteAuthSession> => beginDeleteFor(criteria))
  ipcMain.handle('branchpulse:deleteBranch', (_e, request: DeleteRequest): Promise<DeleteResult> => executeDelete(request))
  ipcMain.handle('branchpulse:batchDelete', (_e, requests: DeleteRequest[]): Promise<DeleteResult[]> => {
    return Promise.all(requests.map((r) => executeDelete(r)))
  })

  ipcMain.handle('branchpulse:listNamingRules', (_e, repositoryId?: string | null): NamingRule[] => naming.listRules(repositoryId))
  ipcMain.handle('branchpulse:saveNamingRule', (_e, rule: Partial<NamingRule> & { id?: string }): NamingRule[] => {
    const list = naming.listRules(rule.repositoryId ?? null)
    if (rule.id) {
      const idx = list.findIndex((r) => r.id === rule.id)
      if (idx >= 0) {
        const merged = { ...list[idx], ...rule }
        storage.update('branch_naming_rules', {
          name: merged.name, pattern: merged.pattern, type: merged.type, mode: merged.mode,
          description: merged.description, enabled: merged.enabled ? 1 : 0, priority: merged.priority,
          repository_id: merged.repositoryId ?? null
        }, 'id = ?', [rule.id])
      }
    } else {
      storage.insert('branch_naming_rules', {
        repository_id: rule.repositoryId ?? null,
        name: rule.name ?? 'Rule', pattern: rule.pattern ?? '', type: rule.type ?? 'glob', mode: rule.mode ?? 'allow',
        description: rule.description ?? '', enabled: rule.enabled !== false ? 1 : 0, priority: rule.priority ?? 50
      })
    }
    audit.record('naming_rule_saved', {
      id: rule.id,
      name: rule.name ?? 'Rule',
      pattern: rule.pattern ?? '',
      type: rule.type ?? 'glob',
      mode: rule.mode ?? 'allow',
      priority: rule.priority ?? 50,
      repositoryId: rule.repositoryId ?? null
    })
    return naming.listRules(rule.repositoryId ?? null)
  })
  ipcMain.handle('branchpulse:deleteNamingRule', (_e, id: string, repositoryId?: string | null): NamingRule[] => {
    const removedRule = storage.get<Record<string, unknown>>('SELECT * FROM branch_naming_rules WHERE id = ?', [id])
    storage.delete('branch_naming_rules', 'id = ?', [id])
    audit.record('naming_rule_deleted', {
      id,
      name: String(removedRule?.name ?? ''),
      pattern: String(removedRule?.pattern ?? '')
    })
    return naming.listRules(repositoryId)
  })
  ipcMain.handle('branchpulse:reorderNamingRule', (_e, id: string, direction: -1 | 1, repositoryId?: string | null): NamingRule[] => {
    const list = naming.listRules(repositoryId)
    const idx = list.findIndex((r) => r.id === id)
    if (idx < 0 || (direction === -1 && idx === 0) || (direction === 1 && idx === list.length - 1)) return list
    const swap = list[idx + direction]
    if (!swap) return list
    const tmp = list[idx].priority
    list[idx].priority = swap.priority
    swap.priority = tmp
    storage.update('branch_naming_rules', { priority: list[idx].priority }, 'id = ?', [list[idx].id])
    storage.update('branch_naming_rules', { priority: swap.priority }, 'id = ?', [swap.id])
    return naming.listRules(repositoryId)
  })
  ipcMain.handle('branchpulse:validateBranchName', (_e, name: string, repositoryId?: string | null): NamingResult => naming.validate(name, naming.listRules(repositoryId)))

  ipcMain.handle('branchpulse:listWhitelist', (_e, repositoryId?: string | null): ProtectionEntry[] => protection.listWhitelist(repositoryId))
  ipcMain.handle('branchpulse:addWhitelist', (_e, entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): ProtectionEntry[] => {
    audit.record('whitelist_added', { pattern: entry.pattern, type: entry.type, repositoryId: entry.repositoryId ?? null })
    return protection.addWhitelist(entry, entry.repositoryId ?? null)
  })
  ipcMain.handle('branchpulse:removeWhitelist', (_e, id: string, repositoryId?: string | null): ProtectionEntry[] => {
    const removed = storage.get<Record<string, unknown>>('SELECT * FROM whitelist WHERE id = ?', [id])
    audit.record('whitelist_removed', { id, pattern: String(removed?.pattern ?? '') })
    return protection.removeWhitelist(id, repositoryId)
  })
  ipcMain.handle('branchpulse:listProtected', (_e, repositoryId?: string | null): ProtectionEntry[] => protection.listProtected(repositoryId))
  ipcMain.handle('branchpulse:addProtected', (_e, entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): ProtectionEntry[] => {
    audit.record('protected_added', { pattern: entry.pattern, type: entry.type, repositoryId: entry.repositoryId ?? null })
    return protection.addProtected(entry, entry.repositoryId ?? null)
  })
  ipcMain.handle('branchpulse:removeProtected', (_e, id: string, repositoryId?: string | null): ProtectionEntry[] => {
    const removed = storage.get<Record<string, unknown>>('SELECT * FROM protected_branches WHERE id = ?', [id])
    audit.record('protected_removed', { id, pattern: String(removed?.pattern ?? '') })
    return protection.removeProtected(id, repositoryId)
  })

  ipcMain.handle('branchpulse:listEmailGroups', (): EmailGroup[] => email.listGroups())
  ipcMain.handle('branchpulse:saveEmailGroup', (_e, group: Partial<EmailGroup> & { id?: string }): EmailGroup[] => email.saveGroup(group))
  ipcMain.handle('branchpulse:deleteEmailGroup', (_e, id: string): EmailGroup[] => email.deleteGroup(id))

  ipcMain.handle('branchpulse:getMonitoring', (_e, repositoryId?: string | null) => getMonitoring(repositoryId))
  ipcMain.handle('branchpulse:saveMonitoring', async (_e, config: MonitoringConfig, repositoryId?: string | null): Promise<MonitoringConfig> => saveMonitoring(config, repositoryId))

  ipcMain.handle('branchpulse:listJobs', (): SchedulerJob[] => scheduler.listJobs())
  ipcMain.handle('branchpulse:saveJob', (_e, job: Partial<SchedulerJob> & { id?: string }): SchedulerJob[] => scheduler.saveJob(job))
  ipcMain.handle('branchpulse:deleteJob', (_e, id: string): SchedulerJob[] => scheduler.deleteJob(id))
  ipcMain.handle('branchpulse:runSchedulerJob', (_e, id: string): Promise<ScanRun> => scheduler.runSchedulerJob(id))
  ipcMain.handle('branchpulse:listRuns', (): ScanRun[] => {
    return storage.all<Record<string, unknown>>('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 100').map(scanRunFromRow)
  })
  ipcMain.handle('branchpulse:calendarRuns', (): { date: string; status: ScanRun['status']; runs: number }[] => scheduler.calendarRuns())

  ipcMain.handle('branchpulse:listNotifications', (): NotificationRecord[] => monitoring.listNotifications())
  ipcMain.handle('branchpulse:markNotificationRead', (_e, id: string): NotificationRecord[] => {
    try {
      const notifications = monitoring.markNotificationRead(id)
      audit.record('notification_marked_read', { id })
      return notifications
    } catch (err) {
      audit.record('notification_mark_read_failed', { id, error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })
  ipcMain.handle('branchpulse:clearNotifications', (): void => {
    try {
      monitoring.clearNotifications()
      audit.record('notifications_cleared', { count: monitoring.listNotifications().length })
    } catch (err) {
      audit.record('notifications_clear_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })

  ipcMain.handle('branchpulse:getEmailConfig', (): EmailConfig => email.getConfig())
  ipcMain.handle('branchpulse:saveEmailConfig', (_e, config: EmailConfig & { password?: string }): EmailConfig => {
    try {
      const saved = email.saveConfig(config)
      audit.record('email_config_updated', {
        enabled: saved.enabled,
        username: saved.username,
        selfEmail: saved.selfEmail,
        testRecipient: saved.testRecipient
      })
      return saved
    } catch (err) {
      audit.record('email_config_save_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })
  ipcMain.handle('branchpulse:testEmailConnection', (_e, config?: EmailConfig): Promise<EmailSendResult> => email.testConnection(config))
  ipcMain.handle('branchpulse:sendTestEmail', (_e, config?: EmailConfig): Promise<EmailSendResult> => email.sendTestEmail(config))

  ipcMain.handle('branchpulse:listReports', (): ReportRecord[] => report.listReports())
  ipcMain.handle('branchpulse:generateReport', (_e, period: string, format?: string, repositoryId?: string | null): Promise<ReportRecord> => report.generateReport(period, format, repositoryId))
  ipcMain.handle('branchpulse:exportReport', (_e, id: string, format: string): Promise<ReportRecord> => report.exportReport(id, format))
  ipcMain.handle('branchpulse:deleteReport', (_e, id: string): ReportRecord[] => report.deleteReport(id))
  ipcMain.handle('branchpulse:openReportFolder', (): Promise<void> => report.openReportFolder())

  ipcMain.handle('branchpulse:listReportSchedules', async (): Promise<ReportSchedule[]> => reportSchedules.list())
  ipcMain.handle('branchpulse:saveReportSchedule', async (_e, schedule: Partial<ReportSchedule> & { id?: string }): Promise<ReportSchedule[]> => reportSchedules.save(schedule))
  ipcMain.handle('branchpulse:deleteReportSchedule', async (_e, id: string): Promise<ReportSchedule[]> => reportSchedules.delete(id))

  ipcMain.handle('branchpulse:listAudit', (): AuditEntry[] => audit.list())
  ipcMain.handle('branchpulse:exportAuditLogs', async (_e, format: 'csv' | 'json' | 'txt' = 'csv'): Promise<AuditExportResult> => {
    try {
      const selected = await dialog.showOpenDialog({
        title: 'Select audit export folder',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (selected.canceled || selected.filePaths.length === 0) {
        return { ok: false, path: '', count: 0 }
      }
      const result = await exportAuditLogs(audit, selected.filePaths[0], format)
      if (result.ok) audit.record('audit_exported', { path: result.path, count: result.count, format })
      else audit.record('audit_export_failed', { error: result.error, format }, 'failure')
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit.record('audit_export_failed', { error: message }, 'failure')
      return { ok: false, path: '', count: 0, error: message }
    }
  })

  ipcMain.handle('branchpulse:getSettings', (): AppSettings => settings.get())
  ipcMain.handle('branchpulse:saveSettings', (_e, s: AppSettings): AppSettings => {
    try {
      const saved = settings.save(s)
      audit.record('settings_updated', {
        theme: saved.theme,
        language: saved.language,
        trayEnabled: saved.trayEnabled,
        launchMinimized: saved.launchMinimized,
        startWithWindows: saved.startWithWindows,
        gitPath: saved.gitPath,
        activeRepositoryId: saved.activeRepositoryId,
        deletionDisabled: saved.deletionDisabled
      })
      return saved
    } catch (err) {
      audit.record('settings_save_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })

}
