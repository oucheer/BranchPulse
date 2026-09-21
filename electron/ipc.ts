import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { app } from 'electron'
import path from 'node:path'
import type {
  AppSettings,
  AuditEntry,
  AuditExportResult,
  BackupRecord,
  BranchCriteria,
  BranchSummary,
  DashboardSnapshot,
  EmailConfig,
  EmailGroup,
  EmailSendResult,
  ConfigExportResult,
  ConfigExtras,
  ConfigImportResult,
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
import type { MonitoringService } from './services/monitoring'
import type { EmailService } from './services/email'
import type { GitLabService } from './services/gitlab'
import type { SchedulerService } from './services/scheduler'
import type { ReportService } from './services/report'
import type { ReportScheduleService } from './services/reportSchedule'
import type { AuditService } from './services/audit'
import type { SettingsService } from './services/settings'
import type { BackupService } from './services/backup'
import type { ConfigPortService } from './services/configPort'

export interface AppServices {
  storage: StorageService
  git: GitService
  repository: RepositoryService
  branch: BranchService
  naming: NamingService
  protection: ProtectionService
  monitoring: MonitoringService
  email: EmailService
  gitlab: GitLabService
  scheduler: SchedulerService
  report: ReportService
  reportSchedules: ReportScheduleService
  audit: AuditService
  settings: SettingsService
  backup: BackupService
  configPort: ConfigPortService
}

function dateStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

function scanRunFromRow(row: Record<string, unknown>, repositoryIds?: string[]): ScanRun {
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
    notifications: Number(row.notifications ?? 0),
    emailsSent: Number(row.emails_sent ?? 0),
    error: (row.error as string | null) ?? null,
    activity,
    ...(repositoryIds ? { repositoryIds } : {})
  }
}

export function registerIpc(services: AppServices, onSettingsSaved?: (settings: AppSettings) => void): void {
  const { storage, gitlab, repository, branch, naming, protection, monitoring, email, scheduler, report, reportSchedules, audit, settings, backup, configPort } = services

  function listScanRuns(repositoryId?: string | null, limit = 50): ScanRun[] {
    const rows = repositoryId
      ? storage.all<Record<string, unknown>>(
        `SELECT sr.* FROM scan_runs sr
         WHERE EXISTS (
           SELECT 1 FROM scan_run_repositories srr
           WHERE srr.run_id = sr.id AND srr.repository_id = ?
         )
         ORDER BY sr.started_at DESC LIMIT ?`,
        [repositoryId, limit]
      )
      : storage.all<Record<string, unknown>>('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?', [limit])
    const runIds = rows.map((row) => String(row.id))
    const repositoryIdsByRun = new Map<string, string[]>()
    if (runIds.length > 0) {
      const associations = storage.all<Record<string, unknown>>(
        `SELECT run_id, repository_id FROM scan_run_repositories WHERE run_id IN (${runIds.map(() => '?').join(',')})`,
        runIds
      )
      for (const association of associations) {
        const runId = String(association.run_id)
        const repositoryIdForRun = String(association.repository_id)
        const current = repositoryIdsByRun.get(runId) ?? []
        current.push(repositoryIdForRun)
        repositoryIdsByRun.set(runId, current)
      }
    }
    return rows.map((row) => {
      const runId = String(row.id)
      return scanRunFromRow(row, repositoryIdsByRun.get(runId) ?? [])
    })
  }

  services.monitoring.onProgress = (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('branchpulse:scan-progress', progress)
    }
  }

  ipcMain.handle('branchpulse:init', async (): Promise<DashboardSnapshot> => {
    const currentSettings = settings.get()
    const activeRepositoryId = currentSettings.activeRepositoryId
    const scanRuns = listScanRuns(activeRepositoryId, 50)
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
      staleThresholdDays: Number(row?.stale_threshold_days ?? 180),
      gracePeriodDays: Number(row?.grace_period_days ?? 60),
      staleThresholdUnit: ((row?.stale_threshold_unit as MonitoringConfig['staleThresholdUnit']) ?? 'days'),
      gracePeriodUnit: ((row?.grace_period_unit as MonitoringConfig['gracePeriodUnit']) ?? 'days'),
      fetchEnabled: Number(row?.fetch_enabled ?? 1) === 1,
      namingEnabled: Number(row?.naming_enabled ?? 1) === 1,
      emailPolicy: ((row?.email_policy as MonitoringConfig['emailPolicy']) ?? 'none'),
      notificationEnabled: Number(row?.notification_enabled ?? 1) === 1,
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
  ipcMain.handle('branchpulse:deleteAllJobs', (): SchedulerJob[] => scheduler.deleteAllJobs())
  ipcMain.handle('branchpulse:runSchedulerJob', (_e, id: string): Promise<ScanRun> => scheduler.runSchedulerJob(id))
  ipcMain.handle('branchpulse:listRuns', (): ScanRun[] => {
    return listScanRuns(null, 100)
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
  ipcMain.handle('branchpulse:openReportFile', (_e, id: string): Promise<void> => report.openReportFile(id))

  ipcMain.handle('branchpulse:listReportSchedules', async (): Promise<ReportSchedule[]> => reportSchedules.list())
  ipcMain.handle('branchpulse:saveReportSchedule', async (_e, schedule: Partial<ReportSchedule> & { id?: string }): Promise<ReportSchedule[]> => reportSchedules.save(schedule))
  ipcMain.handle('branchpulse:deleteReportSchedule', async (_e, id: string): Promise<ReportSchedule[]> => reportSchedules.delete(id))

  ipcMain.handle('branchpulse:listBackups', (): BackupRecord[] => backup.list())
  ipcMain.handle('branchpulse:startBackup', (_e, options: { repositoryId?: string | null; folderPath?: string } = {}): Promise<BackupRecord> => {
    return backup.start(options)
  })
  ipcMain.handle('branchpulse:deleteBackup', (_e, id: string): void => backup.delete(id))
  ipcMain.handle('branchpulse:selectBackupFolder', async (): Promise<string> => {
    const selected = await dialog.showOpenDialog({
      title: 'Select backup folder',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    return selected.canceled || selected.filePaths.length === 0 ? '' : selected.filePaths[0]
  })
  ipcMain.handle('branchpulse:openBackupFolder', (_e, backupPath: string): Promise<string> => {
    const target = backupPath ? path.dirname(backupPath) : app.getPath('documents')
    return shell.openPath(target)
  })

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
  ipcMain.handle('branchpulse:exportConfig', async (_e, extras: ConfigExtras = {}): Promise<ConfigExportResult> => {
    try {
      const selected = await dialog.showSaveDialog({
        title: '导出 BranchPulse 配置',
        defaultPath: path.join(app.getPath('documents'), `branchpulse-config-${dateStamp()}.json`),
        filters: [{ name: 'BranchPulse 配置', extensions: ['json'] }]
      })
      if (selected.canceled || !selected.filePath) return { ok: false, path: '', sections: [] }
      const result = configPort.exportToFile(selected.filePath, extras)
      audit.record('config_exported', { path: result.path, sections: result.sections.length })
      return { ok: true, path: result.path, sections: result.sections }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit.record('config_export_failed', { error: message }, 'failure')
      return { ok: false, path: '', sections: [], error: message }
    }
  })
  ipcMain.handle('branchpulse:importConfig', async (_e, confirmReplace = true): Promise<ConfigImportResult> => {
    try {
      const selected = await dialog.showOpenDialog({
        title: '选择 BranchPulse 配置文件',
        defaultPath: app.getPath('documents'),
        properties: ['openFile'],
        filters: [{ name: 'BranchPulse 配置', extensions: ['json'] }]
      })
      if (selected.canceled || selected.filePaths.length === 0) {
        return { ok: false, path: '', applied: [], warnings: [] }
      }
      const filePath = selected.filePaths[0]
      if (confirmReplace) {
        const confirmation = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['取消', '覆盖导入'],
          defaultId: 0,
          cancelId: 0,
          title: '导入配置',
          message: '导入将覆盖当前的规则、设置、邮箱分组、监控配置和仓库连接信息。',
          detail: 'API Token、邮箱密码等敏感信息不会从配置文件写入，本机已保存的凭据保持不变。此操作无法撤销。'
        })
        if (confirmation.response !== 1) return { ok: false, path: filePath, applied: [], warnings: [] }
      }
      const summary = configPort.importFromFile(filePath)
      audit.record('config_imported', { path: filePath, applied: summary.applied.length, warnings: summary.warnings.length })
      onSettingsSaved?.(settings.get())
      return { ok: true, path: filePath, ...summary }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit.record('config_import_failed', { error: message }, 'failure')
      return { ok: false, path: '', applied: [], warnings: [], error: message }
    }
  })
  // The sidebar renders this, so the displayed version follows package.json /
  // the built exe instead of a hardcoded string that silently goes stale.
  ipcMain.handle('branchpulse:getAppVersion', (): string => app.getVersion())
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
        activeRepositoryId: saved.activeRepositoryId
      })
      onSettingsSaved?.(saved)
      return saved
    } catch (err) {
      audit.record('settings_save_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })

}
