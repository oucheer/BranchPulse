import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { app } from 'electron'
import path from 'node:path'
import type {
  AppSettings,
  AuditEntry,
  AuditExportResult,
  BackupRecord,
  BackupOptions,
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

  /**
   * A scan run is only visible when every repository it touched is inside the
   * current scope. Runs that also cover unselected repositories would leak
   * their branch statistics into this repository's view.
   */
  function listScanRuns(repositoryIds?: string[], limit = 50): ScanRun[] {
    const scope = repositoryIds ?? storage.selectedRepositoryIds()
    if (scope.length === 0) return []
    const selected = new Set(scope)
    const rows = storage.all<Record<string, unknown>>('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?', [limit])
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
    return rows
      .filter((row) => {
        const associated = repositoryIdsByRun.get(String(row.id)) ?? []
        return associated.length > 0 && associated.every((id) => selected.has(id))
      })
      .map((row) => scanRunFromRow(row, repositoryIdsByRun.get(String(row.id)) ?? []))
  }

  services.monitoring.onProgress = (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('gitmanager:scan-progress', progress)
    }
  }

  ipcMain.handle('gitmanager:init', async (): Promise<DashboardSnapshot> => {
    const selectedRepositoryIds = storage.selectedRepositoryIds()
    const scanRuns = listScanRuns(selectedRepositoryIds, 50)
    return {
      repositories: repository.list(),
      branches: branch.listBranches(selectedRepositoryIds),
      scanRuns,
      notifications: monitoring.listNotifications(selectedRepositoryIds),
      settings: settings.get(),
      monitoring: await getMonitoring(selectedRepositoryIds[0] ?? null),
      selectedRepositoryIds
    }
  })

  async function getMonitoring(repositoryId?: string | null): Promise<MonitoringConfig> {
    const row = repositoryId
      ? storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId])
      : undefined
    return {
      enabled: Number(row?.enabled ?? 1) === 1,
      staleThresholdDays: Number(row?.stale_threshold_days ?? 180),
      staleThresholdUnit: ((row?.stale_threshold_unit as MonitoringConfig['staleThresholdUnit']) ?? 'days'),
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
      stale_threshold_unit: config.staleThresholdUnit,
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
    }
    audit.record('monitoring_rules_updated', {
      repositoryId: repositoryId ?? null,
      enabled: config.enabled,
      staleThresholdDays: config.staleThresholdDays,
      staleThresholdUnit: config.staleThresholdUnit
    })
    return getMonitoring(repositoryId)
  }

  // --- IPC handlers ---

  ipcMain.handle('gitmanager:addGitLabRepository', (_e, projectId: number, config?: GitLabConnectionConfig): Promise<Repository> =>
    repository.addGitLab(projectId, config).then((repo) => {
      audit.record('repository_added', { repository: repo.name, url: repo.webUrl })
      return repo
    }))
  ipcMain.handle('gitmanager:listGitLabProjects', (_e, config?: GitLabConnectionConfig): Promise<GitLabProject[]> =>
    gitlab.listProjects(config))
  ipcMain.handle('gitmanager:testGitLabConnection', (_e, config?: GitLabConnectionConfig): Promise<GitLabTestResult> =>
    gitlab.testConnection(config))
  ipcMain.handle('gitmanager:removeRepository', (_e, id: string): Repository[] => {
    const repo = repository.get(id)
    const next = repository.remove(id)
    audit.record('repository_removed', { repository: repo?.name ?? id })
    return next
  })
  ipcMain.handle('gitmanager:listRepositories', (): Repository[] => repository.list())
  ipcMain.handle('gitmanager:scanRepository', (_e, id: string, fetch?: boolean): Promise<ScanRun> =>
    monitoring.runCheckNow({ repositoryIds: [id], fetch, trigger: 'scan_repository', bypassEnabledCheck: true }).then((run) => {
      const repo = repository.get(id)
      audit.record('repository_scanned', { repository: repo?.name ?? id, branches: run.branches, stale: run.stale })
      return run
    }))
  ipcMain.handle('gitmanager:runCheckNow', async (_e, options: RunCheckOptions = {}): Promise<ScanRun> => {
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
  ipcMain.handle('gitmanager:listBranches', (_e, repositoryIds?: string[]): BranchSummary[] => branch.listBranches(repositoryIds))
  ipcMain.handle('gitmanager:getBranch', (_e, criteria: BranchCriteria, repositoryIds?: string[]): Promise<BranchSummary | null> =>
    branch.getBranch(criteria, repositoryIds))
  ipcMain.handle('gitmanager:notifyBranch', (_e, bs: BranchSummary): Promise<NotificationRecord[]> => monitoring.notifyBranch(bs))
  ipcMain.handle('gitmanager:notifyBranchesEmail', (_e, bs: BranchSummary[]): Promise<{ sent: number; message: string }> => monitoring.notifyBranchesEmail(bs))
  ipcMain.handle('gitmanager:notifySelfEmail', (_e, bs: BranchSummary[]): Promise<{ sent: number; message: string }> => monitoring.notifySelfEmail(bs))
  ipcMain.handle('gitmanager:listNamingRules', (_e, repositoryId?: string | null): NamingRule[] => naming.listRules(repositoryId))
  ipcMain.handle('gitmanager:saveNamingRule', (_e, rule: Partial<NamingRule> & { id?: string }): NamingRule[] => {
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
  ipcMain.handle('gitmanager:deleteNamingRule', (_e, id: string, repositoryId?: string | null): NamingRule[] => {
    const removedRule = storage.get<Record<string, unknown>>('SELECT * FROM branch_naming_rules WHERE id = ?', [id])
    storage.delete('branch_naming_rules', 'id = ?', [id])
    audit.record('naming_rule_deleted', {
      id,
      name: String(removedRule?.name ?? ''),
      pattern: String(removedRule?.pattern ?? '')
    })
    return naming.listRules(repositoryId)
  })
  ipcMain.handle('gitmanager:reorderNamingRule', (_e, id: string, direction: -1 | 1, repositoryId?: string | null): NamingRule[] => {
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
  ipcMain.handle('gitmanager:validateBranchName', (_e, name: string, repositoryId?: string | null): NamingResult => naming.validate(name, naming.listRules(repositoryId)))

  ipcMain.handle('gitmanager:listWhitelist', (_e, repositoryId?: string | null): ProtectionEntry[] => protection.listWhitelist(repositoryId))
  ipcMain.handle('gitmanager:addWhitelist', (_e, entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): ProtectionEntry[] => {
    audit.record('whitelist_added', { pattern: entry.pattern, type: entry.type, repositoryId: entry.repositoryId ?? null })
    return protection.addWhitelist(entry, entry.repositoryId ?? null)
  })
  ipcMain.handle('gitmanager:removeWhitelist', (_e, id: string, repositoryId?: string | null): ProtectionEntry[] => {
    const removed = storage.get<Record<string, unknown>>('SELECT * FROM whitelist WHERE id = ?', [id])
    audit.record('whitelist_removed', { id, pattern: String(removed?.pattern ?? '') })
    return protection.removeWhitelist(id, repositoryId)
  })
  ipcMain.handle('gitmanager:listProtected', (_e, repositoryId?: string | null): ProtectionEntry[] => protection.listProtected(repositoryId))
  ipcMain.handle('gitmanager:addProtected', (_e, entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): ProtectionEntry[] => {
    audit.record('protected_added', { pattern: entry.pattern, type: entry.type, repositoryId: entry.repositoryId ?? null })
    return protection.addProtected(entry, entry.repositoryId ?? null)
  })
  ipcMain.handle('gitmanager:removeProtected', (_e, id: string, repositoryId?: string | null): ProtectionEntry[] => {
    const removed = storage.get<Record<string, unknown>>('SELECT * FROM protected_branches WHERE id = ?', [id])
    audit.record('protected_removed', { id, pattern: String(removed?.pattern ?? '') })
    return protection.removeProtected(id, repositoryId)
  })

  ipcMain.handle('gitmanager:listEmailGroups', (): EmailGroup[] => email.listGroups())
  ipcMain.handle('gitmanager:saveEmailGroup', (_e, group: Partial<EmailGroup> & { id?: string }): EmailGroup[] => email.saveGroup(group))
  ipcMain.handle('gitmanager:deleteEmailGroup', (_e, id: string): EmailGroup[] => email.deleteGroup(id))

  ipcMain.handle('gitmanager:getMonitoring', (_e, repositoryId?: string | null) => getMonitoring(repositoryId))
  ipcMain.handle('gitmanager:saveMonitoring', async (_e, config: MonitoringConfig, repositoryId?: string | null): Promise<MonitoringConfig> => saveMonitoring(config, repositoryId))

  ipcMain.handle('gitmanager:listJobs', (_e, repositoryIds?: string[]): SchedulerJob[] => scheduler.listJobs(repositoryIds))
  ipcMain.handle('gitmanager:saveJob', (_e, job: Partial<SchedulerJob> & { id?: string }, repositoryIds?: string[]): SchedulerJob[] =>
    scheduler.saveJob(job, repositoryIds))
  ipcMain.handle('gitmanager:deleteJob', (_e, id: string, repositoryIds?: string[]): SchedulerJob[] => scheduler.deleteJob(id, repositoryIds))
  ipcMain.handle('gitmanager:deleteAllJobs', (_e, repositoryIds: string[] = []): SchedulerJob[] => scheduler.deleteAllJobs(repositoryIds))
  ipcMain.handle('gitmanager:runSchedulerJob', (_e, id: string, repositoryIds?: string[]): Promise<ScanRun> =>
    scheduler.runSchedulerJob(id, repositoryIds))
  ipcMain.handle('gitmanager:listRuns', (_e, repositoryIds?: string[]): ScanRun[] => {
    return listScanRuns(repositoryIds, 100)
  })
  ipcMain.handle('gitmanager:calendarRuns', (_e, repositoryIds?: string[]): { date: string; status: ScanRun['status']; runs: number }[] =>
    scheduler.calendarRuns(repositoryIds))

  ipcMain.handle('gitmanager:listNotifications', (_e, repositoryIds?: string[]): NotificationRecord[] => monitoring.listNotifications(repositoryIds))
  ipcMain.handle('gitmanager:markNotificationRead', (_e, id: string, repositoryIds?: string[]): NotificationRecord[] => {
    try {
      const notifications = monitoring.markNotificationRead(id, repositoryIds)
      audit.record('notification_marked_read', { id })
      return notifications
    } catch (err) {
      audit.record('notification_mark_read_failed', { id, error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })
  ipcMain.handle('gitmanager:clearNotifications', (_e, repositoryIds?: string[]): void => {
    try {
      monitoring.clearNotifications(repositoryIds)
      audit.record('notifications_cleared', { repositoryIds: repositoryIds ?? storage.selectedRepositoryIds() })
    } catch (err) {
      audit.record('notifications_clear_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })

  ipcMain.handle('gitmanager:getEmailConfig', (): EmailConfig => email.getConfig())
  ipcMain.handle('gitmanager:saveEmailConfig', (_e, config: EmailConfig & { password?: string }): EmailConfig => {
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
  ipcMain.handle('gitmanager:testEmailConnection', (_e, config?: EmailConfig): Promise<EmailSendResult> => email.testConnection(config))
  ipcMain.handle('gitmanager:sendTestEmail', (_e, config?: EmailConfig): Promise<EmailSendResult> => email.sendTestEmail(config))

  ipcMain.handle('gitmanager:listReports', (_e, repositoryIds?: string[]): ReportRecord[] => report.listReports(repositoryIds))
  ipcMain.handle('gitmanager:generateReport', (_e, period: string, format?: string, repositoryIds?: string[]): Promise<ReportRecord> =>
    report.generateReport(period, format, repositoryIds))
  ipcMain.handle('gitmanager:sendSelectedRepositoriesReport', (_e, period: string, recipients?: string, repositoryIds?: string[]): Promise<EmailSendResult> =>
    reportSchedules.sendSelectedRepositoriesReport(period, recipients, repositoryIds))
  ipcMain.handle('gitmanager:exportReport', (_e, id: string, format: string, repositoryIds?: string[]): Promise<ReportRecord> =>
    report.exportReport(id, format, repositoryIds))
  ipcMain.handle('gitmanager:deleteReport', (_e, id: string, repositoryIds?: string[]): ReportRecord[] => report.deleteReport(id, repositoryIds))
  ipcMain.handle('gitmanager:openReportFolder', (): Promise<void> => report.openReportFolder())
  ipcMain.handle('gitmanager:openReportFile', (_e, id: string, repositoryIds?: string[]): Promise<void> => report.openReportFile(id, repositoryIds))

  ipcMain.handle('gitmanager:listReportSchedules', async (_e, repositoryIds?: string[]): Promise<ReportSchedule[]> => reportSchedules.list(repositoryIds))
  ipcMain.handle('gitmanager:saveReportSchedule', async (_e, schedule: Partial<ReportSchedule> & { id?: string }, repositoryIds?: string[]): Promise<ReportSchedule[]> =>
    reportSchedules.save(schedule, repositoryIds))
  ipcMain.handle('gitmanager:deleteReportSchedule', async (_e, id: string, repositoryIds?: string[]): Promise<ReportSchedule[]> =>
    reportSchedules.delete(id, repositoryIds))

  ipcMain.handle('gitmanager:listBackups', (_e, repositoryIds?: string[]): BackupRecord[] => backup.list(repositoryIds))
  ipcMain.handle('gitmanager:startBackups', (_e, options: BackupOptions = {}): Promise<BackupRecord[]> => backup.startBackups(options))
  ipcMain.handle('gitmanager:deleteBackup', (_e, id: string): void => backup.delete(id))
  ipcMain.handle('gitmanager:selectBackupFolder', async (): Promise<string> => {
    const selected = await dialog.showOpenDialog({
      title: 'Select backup folder',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    return selected.canceled || selected.filePaths.length === 0 ? '' : selected.filePaths[0]
  })
  ipcMain.handle('gitmanager:openBackupFolder', (_e, backupPath: string): Promise<string> => {
    const target = backupPath ? path.dirname(backupPath) : app.getPath('documents')
    return shell.openPath(target)
  })

  ipcMain.handle('gitmanager:listAudit', (_e, repositoryIds?: string[]): AuditEntry[] => audit.list(repositoryIds))
  ipcMain.handle('gitmanager:exportAuditLogs', async (_e, format: 'csv' | 'json' | 'txt' = 'csv', repositoryIds?: string[]): Promise<AuditExportResult> => {
    try {
      const selected = await dialog.showOpenDialog({
        title: 'Select audit export folder',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (selected.canceled || selected.filePaths.length === 0) {
        return { ok: false, path: '', count: 0 }
      }
      const result = await exportAuditLogs(audit, selected.filePaths[0], format, repositoryIds)
      if (result.ok) audit.record('audit_exported', { path: result.path, count: result.count, format })
      else audit.record('audit_export_failed', { error: result.error, format }, 'failure')
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit.record('audit_export_failed', { error: message }, 'failure')
      return { ok: false, path: '', count: 0, error: message }
    }
  })

  ipcMain.handle('gitmanager:getSettings', (): AppSettings => settings.get())
  ipcMain.handle('gitmanager:exportConfig', async (_e, extras: ConfigExtras = {}): Promise<ConfigExportResult> => {
    try {
      const selected = await dialog.showSaveDialog({
        title: '导出 GitManager 配置',
        defaultPath: path.join(app.getPath('documents'), `gitmanager-config-${dateStamp()}.json`),
        filters: [{ name: 'GitManager 配置', extensions: ['json'] }]
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
  ipcMain.handle('gitmanager:importConfig', async (_e, confirmReplace = true): Promise<ConfigImportResult> => {
    try {
      const selected = await dialog.showOpenDialog({
        title: '选择 GitManager 配置文件',
        defaultPath: app.getPath('documents'),
        properties: ['openFile'],
        filters: [{ name: 'GitManager 配置', extensions: ['json'] }]
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
  ipcMain.handle('gitmanager:getAppVersion', (): string => app.getVersion())
  ipcMain.handle('gitmanager:saveSettings', (_e, s: AppSettings): AppSettings => {
    try {
      const saved = settings.save(s)
      audit.record('settings_updated', {
        theme: saved.theme,
        language: saved.language,
        trayEnabled: saved.trayEnabled,
        launchMinimized: saved.launchMinimized,
        startWithWindows: saved.startWithWindows,
        gitPath: saved.gitPath,
        selectedRepositoryIds: saved.selectedRepositoryIds
      })
      onSettingsSaved?.(saved)
      return saved
    } catch (err) {
      audit.record('settings_save_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
      throw err
    }
  })

}
