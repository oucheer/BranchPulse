import path from 'node:path'
import fs from 'node:fs'
import type {
  AppSettings,
  AuditEntry,
  AuditExportResult,
  BackupRecord,
  BranchCriteria,
  BranchSummary,
  DashboardSnapshot,
  EmailConfig,
  EmailConfigDraft,
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
  ScanProgress,
  ScanRun,
  SchedulerJob
} from '@shared/types'
import { exportAuditLogs } from './services/audit-export'
import type { StorageService } from './services/storage'
import type { GitService } from './services/git'
import type { RepositoryService } from './services/repository'
import { parseThresholdRules, serializeThresholdRules } from './services/branch'
import type { BranchService } from './services/branch'
import type { NamingService } from './services/naming'
import type { ProtectionService } from './services/protection'
import type { MonitoringService } from './services/monitoring'
import type { EmailService } from './services/email'
import type { GitLabService } from './services/gitlab'
import type { SchedulerService } from './services/scheduler'
import type { ReportService } from './services/report'
import type { ReportScheduleService } from './services/reportSchedule'
import type { GroupService } from './services/groups'
import type { AuditService } from './services/audit'
import type { SettingsService } from './services/settings'
import type { BackupService } from './services/backup'
import type { ConfigPortService } from './services/configPort'
import { dataDir, reportsDir, userDataDir, ensureDir } from './utils/paths'
import { listFolders, type FolderListing } from './utils/folders'
import { openPath } from './utils/open'

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
  groups: GroupService
  audit: AuditService
  settings: SettingsService
  backup: BackupService
  configPort: ConfigPortService
}

export interface GitManagerApiOptions {
  /** Version reported by `getAppVersion()`. */
  appVersion: () => string
  /** Pushed scan progress, wired to `webContents.send` or an SSE broadcast. */
  onProgress?: (progress: ScanProgress) => void
  /** Called after settings are persisted (tray rebuild in the desktop build). */
  onSettingsSaved?: (settings: AppSettings) => void
}

/**
 * Transport-agnostic implementation of every operation the renderer can call.
 *
 * The Electron IPC layer and the HTTP/SSE server both drive this object, so
 * behaviour cannot drift between the desktop and the web build.
 */
export interface GitManagerApi {
  setProgressSink(sink: (progress: ScanProgress) => void): void
  init(): Promise<DashboardSnapshot>
  addGitLabRepository(projectId: number, config?: GitLabConnectionConfig): Promise<Repository>
  listGitLabProjects(config?: GitLabConnectionConfig): Promise<GitLabProject[]>
  testGitLabConnection(config?: GitLabConnectionConfig): Promise<GitLabTestResult>
  removeRepository(id: string): Promise<Repository[]>
  listRepositories(): Promise<Repository[]>
  scanRepository(id: string, fetch?: boolean): Promise<ScanRun>
  runCheckNow(options?: RunCheckOptions): Promise<ScanRun>
  listBranches(): Promise<BranchSummary[]>
  getBranch(criteria: BranchCriteria): Promise<BranchSummary | null>
  notifyBranch(branch: BranchSummary): Promise<NotificationRecord[]>
  notifyBranchesEmail(branches: BranchSummary[]): Promise<{ sent: number; message: string }>
  notifySelfEmail(branches: BranchSummary[]): Promise<{ sent: number; message: string }>

  listNamingRules(repositoryId?: string | null): Promise<NamingRule[]>
  saveNamingRule(rule: Partial<NamingRule> & { id?: string }): Promise<NamingRule[]>
  deleteNamingRule(id: string, repositoryId?: string | null): Promise<NamingRule[]>
  reorderNamingRule(id: string, direction: -1 | 1, repositoryId?: string | null): Promise<NamingRule[]>
  validateBranchName(name: string, repositoryId?: string | null): Promise<NamingResult>

  listWhitelist(repositoryId?: string | null): Promise<ProtectionEntry[]>
  addWhitelist(entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): Promise<ProtectionEntry[]>
  removeWhitelist(id: string, repositoryId?: string | null): Promise<ProtectionEntry[]>
  listProtected(repositoryId?: string | null): Promise<ProtectionEntry[]>
  addProtected(entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): Promise<ProtectionEntry[]>
  removeProtected(id: string, repositoryId?: string | null): Promise<ProtectionEntry[]>

  getMonitoring(repositoryId?: string | null): Promise<MonitoringConfig>
  saveMonitoring(config: MonitoringConfig, repositoryId?: string | null): Promise<MonitoringConfig>

  listEmailGroups(): Promise<EmailGroup[]>
  saveEmailGroup(group: Partial<EmailGroup> & { id?: string }): Promise<EmailGroup[]>
  deleteEmailGroup(id: string): Promise<EmailGroup[]>
  exportGroupBranches(groupId: string, format: string, repositoryId?: string | null): Promise<ReportRecord>
  emailGroupBranches(groupId: string, repositoryId?: string | null): Promise<{ sent: number; message: string }>

  listJobs(): Promise<SchedulerJob[]>
  saveJob(job: Partial<SchedulerJob> & { id?: string }): Promise<SchedulerJob[]>
  deleteJob(id: string): Promise<SchedulerJob[]>
  deleteAllJobs(): Promise<SchedulerJob[]>
  runSchedulerJob(id: string): Promise<ScanRun>
  listRuns(): Promise<ScanRun[]>
  calendarRuns(): Promise<{ date: string; status: ScanRun['status']; runs: number }[]>

  listNotifications(): Promise<NotificationRecord[]>
  markNotificationRead(id: string): Promise<NotificationRecord[]>
  clearNotifications(): Promise<void>

  getEmailConfig(): Promise<EmailConfig>
  saveEmailConfig(config: EmailConfigDraft): Promise<EmailConfig>
  testEmailConnection(config?: EmailConfigDraft): Promise<EmailSendResult>
  sendTestEmail(config?: EmailConfigDraft): Promise<EmailSendResult>

  listReports(): Promise<ReportRecord[]>
  generateReport(period: string, format?: string, repositoryId?: string | null): Promise<ReportRecord>
  exportReport(id: string, format: string): Promise<ReportRecord>
  deleteReport(id: string): Promise<ReportRecord[]>
  openReportFolder(): Promise<void>
  openReportFile(id: string): Promise<void>

  listReportSchedules(): Promise<ReportSchedule[]>
  saveReportSchedule(schedule: Partial<ReportSchedule> & { id?: string }): Promise<ReportSchedule[]>
  deleteReportSchedule(id: string): Promise<ReportSchedule[]>

  listBackups(): Promise<BackupRecord[]>
  startBackup(options?: { repositoryId?: string | null; folderPath?: string }): Promise<BackupRecord>
  deleteBackup(id: string): Promise<void>
  selectBackupFolder(): Promise<string>
  openBackupFolder(backupPath: string): Promise<void>

  listAudit(): Promise<AuditEntry[]>
  exportAuditLogs(format: 'csv' | 'json' | 'txt', directory?: string): Promise<AuditExportResult>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  getAppVersion(): Promise<string>
  exportConfig(extras?: ConfigExtras, filePath?: string): Promise<ConfigExportResult>
  importConfig(target?: boolean | string): Promise<ConfigImportResult>
  onScanProgress(callback: (progress: ScanProgress) => void): () => void
  onNavigate(callback: (route: string) => void): () => void
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

export function createGitManagerApi(services: AppServices, options: GitManagerApiOptions): GitManagerApi {
  const { storage, gitlab, repository, branch, naming, protection, monitoring, email, scheduler, report, reportSchedules, groups, audit, settings, backup, configPort } = services

  let progressSink = options.onProgress ?? ((): void => {})

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
      thresholdRules: parseThresholdRules(row?.threshold_rules),
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
      threshold_rules: serializeThresholdRules(config.thresholdRules),
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
      gracePeriodUnit: config.gracePeriodUnit,
      thresholdRules: config.thresholdRules ?? []
    })
    return getMonitoring(repositoryId)
  }


  const api: GitManagerApi = {
    setProgressSink(sink) {
      progressSink = sink
    },

    async init(): Promise<DashboardSnapshot> {
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
    },

    addGitLabRepository: (projectId, config) =>
      repository.addGitLab(projectId, config).then((repo) => {
        audit.record('repository_added', { repository: repo.name, url: repo.webUrl })
        return repo
      }),
    listGitLabProjects: (config) => gitlab.listProjects(config),
    testGitLabConnection: (config) => gitlab.testConnection(config),
    removeRepository: async (id) => {
      const repo = repository.get(id)
      const next = repository.remove(id)
      audit.record('repository_removed', { repository: repo?.name ?? id })
      return next
    },
    listRepositories: async () => repository.list(),
    scanRepository: (id, fetch) =>
      monitoring.runCheckNow({ repositoryIds: [id], fetch, trigger: 'scan_repository', bypassEnabledCheck: true }).then((run) => {
        const repo = repository.get(id)
        audit.record('repository_scanned', { repository: repo?.name ?? id, branches: run.branches, stale: run.stale })
        return run
      }),
    async runCheckNow(options: RunCheckOptions = {}) {
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
    },
    listBranches: async () => branch.listBranches(),
    getBranch: (criteria) => branch.getBranch(criteria),
    notifyBranch: (bs) => monitoring.notifyBranch(bs),
    notifyBranchesEmail: (bs) => monitoring.notifyBranchesEmail(bs),
    notifySelfEmail: (bs) => monitoring.notifySelfEmail(bs),

    listNamingRules: async (repositoryId) => naming.listRules(repositoryId),
    saveNamingRule: async (rule) => {
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
    },
    deleteNamingRule: async (id, repositoryId) => {
      const removedRule = storage.get<Record<string, unknown>>('SELECT * FROM branch_naming_rules WHERE id = ?', [id])
      storage.delete('branch_naming_rules', 'id = ?', [id])
      audit.record('naming_rule_deleted', {
        id,
        name: String(removedRule?.name ?? ''),
        pattern: String(removedRule?.pattern ?? '')
      })
      return naming.listRules(repositoryId)
    },
    reorderNamingRule: async (id, direction, repositoryId) => {
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
    },
    validateBranchName: async (name, repositoryId) => naming.validate(name, naming.listRules(repositoryId)),

    listWhitelist: async (repositoryId) => protection.listWhitelist(repositoryId),
    addWhitelist: async (entry) => {
      audit.record('whitelist_added', { pattern: entry.pattern, type: entry.type, repositoryId: entry.repositoryId ?? null })
      return protection.addWhitelist(entry, entry.repositoryId ?? null)
    },
    removeWhitelist: async (id, repositoryId) => {
      const removed = storage.get<Record<string, unknown>>('SELECT * FROM whitelist WHERE id = ?', [id])
      audit.record('whitelist_removed', { id, pattern: String(removed?.pattern ?? '') })
      return protection.removeWhitelist(id, repositoryId)
    },
    listProtected: async (repositoryId) => protection.listProtected(repositoryId),
    addProtected: async (entry) => {
      audit.record('protected_added', { pattern: entry.pattern, type: entry.type, repositoryId: entry.repositoryId ?? null })
      return protection.addProtected(entry, entry.repositoryId ?? null)
    },
    removeProtected: async (id, repositoryId) => {
      const removed = storage.get<Record<string, unknown>>('SELECT * FROM protected_branches WHERE id = ?', [id])
      audit.record('protected_removed', { id, pattern: String(removed?.pattern ?? '') })
      return protection.removeProtected(id, repositoryId)
    },

    listEmailGroups: async () => email.listGroups(),
    saveEmailGroup: async (group) => email.saveGroup(group),
    deleteEmailGroup: async (id) => email.deleteGroup(id),
    exportGroupBranches: (groupId, format, repositoryId) => groups.exportBranches(groupId, format, repositoryId),
    emailGroupBranches: (groupId, repositoryId) => groups.emailBranches(groupId, repositoryId),

    getMonitoring: (repositoryId) => getMonitoring(repositoryId),
    saveMonitoring: (config, repositoryId) => saveMonitoring(config, repositoryId),

    listJobs: async () => scheduler.listJobs(),
    saveJob: async (job) => scheduler.saveJob(job),
    deleteJob: async (id) => scheduler.deleteJob(id),
    deleteAllJobs: async () => scheduler.deleteAllJobs(),
    runSchedulerJob: (id) => scheduler.runSchedulerJob(id),
    listRuns: async () => listScanRuns(null, 100),
    calendarRuns: async () => scheduler.calendarRuns(),

    listNotifications: async () => monitoring.listNotifications(),
    markNotificationRead: async (id) => {
      try {
        const notifications = monitoring.markNotificationRead(id)
        audit.record('notification_marked_read', { id })
        return notifications
      } catch (err) {
        audit.record('notification_mark_read_failed', { id, error: err instanceof Error ? err.message : String(err) }, 'failure')
        throw err
      }
    },
    clearNotifications: async () => {
      try {
        monitoring.clearNotifications()
        audit.record('notifications_cleared', { count: monitoring.listNotifications().length })
      } catch (err) {
        audit.record('notifications_clear_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
        throw err
      }
    },

    getEmailConfig: async () => email.getConfig(),
    saveEmailConfig: async (config) => {
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
    },
    testEmailConnection: (config) => email.testConnection(config),
    sendTestEmail: (config) => email.sendTestEmail(config),

    listReports: async () => report.listReports(),
    generateReport: (period, format, repositoryId) => report.generateReport(period, format, repositoryId),
    exportReport: (id, format) => report.exportReport(id, format),
    deleteReport: async (id) => report.deleteReport(id),
    openReportFolder: () => report.openReportFolder(),
    openReportFile: (id) => report.openReportFile(id),

    listReportSchedules: async () => reportSchedules.list(),
    saveReportSchedule: async (schedule) => reportSchedules.save(schedule),
    deleteReportSchedule: async (id) => reportSchedules.delete(id),

    listBackups: async () => backup.list(),
    startBackup: (backupOptions = {}) => backup.start(backupOptions),
    deleteBackup: async (id) => backup.delete(id),
    // The web build has no native directory dialog: the in-page folder picker
    // calls `/api/fs/folders` instead and uses this value as its start folder.
    selectBackupFolder: async () => ensureDir(path.join(dataDir(), 'backups')),
    openBackupFolder: async (backupPath) => {
      const target = backupPath ? path.dirname(backupPath) : dataDir()
      await openPath(target)
    },

    listAudit: async () => audit.list(),
    exportAuditLogs: async (format = 'csv', directory) => {
      const target = directory?.trim() || userDataDir()
      try {
        const result = await exportAuditLogs(audit, target, format)
        if (result.ok) audit.record('audit_exported', { path: result.path, count: result.count, format })
        else audit.record('audit_export_failed', { error: result.error, format }, 'failure')
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        audit.record('audit_export_failed', { error: message }, 'failure')
        return { ok: false, path: '', count: 0, error: message }
      }
    },

    getSettings: async () => settings.get(),
    exportConfig: async (extras = {}, filePath) => {
      const target = filePath?.trim() || path.join(dataDir(), `gitmanager-config-${dateStamp()}.json`)
      try {
        const result = configPort.exportToFile(target, extras)
        audit.record('config_exported', { path: result.path, sections: result.sections.length })
        return { ok: true, path: result.path, sections: result.sections }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        audit.record('config_export_failed', { error: message }, 'failure')
        return { ok: false, path: '', sections: [], error: message }
      }
    },
    // `target` is either the legacy "confirm replace" flag or the path picked in
    // the browser. The confirmation itself is a UI concern in the web build.
    importConfig: async (target) => {
      const filePath = typeof target === 'string' ? target : ''
      try {
        if (!filePath) return { ok: false, path: '', applied: [], warnings: [] }
        const summary = configPort.importFromFile(filePath)
        audit.record('config_imported', { path: filePath, applied: summary.applied.length, warnings: summary.warnings.length })
        options.onSettingsSaved?.(settings.get())
        return { ok: true, path: filePath, ...summary }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        audit.record('config_import_failed', { error: message }, 'failure')
        return { ok: false, path: filePath, applied: [], warnings: [], error: message }
      }
    },
    // The sidebar renders this, so the displayed version follows package.json /
    // the built bundle instead of a hardcoded string that silently goes stale.
    getAppVersion: async () => options.appVersion(),
    saveSettings: async (s) => {
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
        options.onSettingsSaved?.(saved)
        return saved
      } catch (err) {
        audit.record('settings_save_failed', { error: err instanceof Error ? err.message : String(err) }, 'failure')
        throw err
      }
    },

    onScanProgress: () => () => {},
    onNavigate: () => () => {}
  }

  monitoring.onProgress = (progress) => progressSink(progress)

  return api
}

/** Directory browser backing the in-page folder picker (web replacement for `dialog`). */
export function listFoldersForWeb(target: string, options?: { includeFiles?: boolean; extensions?: string[] }): FolderListing {
  return listFolders(target, options)
}

/** Resolves the directory a report file lives in, used by the download endpoint. */
export function reportsDirectory(): string {
  return ensureDir(reportsDir())
}

/** Reads a report file from disk for browser download. */
export function readReportFile(reportPath: string): { name: string; content: Buffer } | null {
  const resolved = path.resolve(reportPath)
  if (!resolved.startsWith(path.resolve(reportsDir()))) return null
  if (!fs.existsSync(resolved)) return null
  return { name: path.basename(resolved), content: fs.readFileSync(resolved) }
}
