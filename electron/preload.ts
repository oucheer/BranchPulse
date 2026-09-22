import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BackupOptions,
  BranchApi,
  BranchCriteria,
  BranchSummary,
  GitLabConnectionConfig,
  EmailConfig,
  EmailGroup,
  ConfigExtras,
  MonitoringConfig,
  NamingRule,
  ProtectionEntry,
  ReportSchedule,
  RunCheckOptions,
  ScanProgress,
  SchedulerJob
} from '@shared/types'

const api: BranchApi = {
  init: () => ipcRenderer.invoke('gitmanager:init'),
  addGitLabRepository: (projectId: number, config?: GitLabConnectionConfig) =>
    ipcRenderer.invoke('gitmanager:addGitLabRepository', projectId, config),
  listGitLabProjects: (config?: GitLabConnectionConfig) => ipcRenderer.invoke('gitmanager:listGitLabProjects', config),
  testGitLabConnection: (config?: GitLabConnectionConfig) => ipcRenderer.invoke('gitmanager:testGitLabConnection', config),
  removeRepository: (id: string) => ipcRenderer.invoke('gitmanager:removeRepository', id),
  listRepositories: () => ipcRenderer.invoke('gitmanager:listRepositories'),
  scanRepository: (id: string, fetch?: boolean) => ipcRenderer.invoke('gitmanager:scanRepository', id, fetch),
  runCheckNow: (options: RunCheckOptions = {}) => ipcRenderer.invoke('gitmanager:runCheckNow', options),
  listBranches: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listBranches', repositoryIds),
  getBranch: (criteria: BranchCriteria, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:getBranch', criteria, repositoryIds),
  notifyBranch: (branch: BranchSummary) => ipcRenderer.invoke('gitmanager:notifyBranch', branch),
  notifyBranchesEmail: (branches: BranchSummary[]) => ipcRenderer.invoke('gitmanager:notifyBranchesEmail', branches),
  notifySelfEmail: (branches: BranchSummary[]) => ipcRenderer.invoke('gitmanager:notifySelfEmail', branches),

  listNamingRules: (repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:listNamingRules', repositoryId),
  saveNamingRule: (rule: Partial<NamingRule> & { id?: string }) => ipcRenderer.invoke('gitmanager:saveNamingRule', rule),
  deleteNamingRule: (id: string, repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:deleteNamingRule', id, repositoryId),
  reorderNamingRule: (id: string, direction: -1 | 1, repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:reorderNamingRule', id, direction, repositoryId),
  validateBranchName: (name: string, repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:validateBranchName', name, repositoryId),

  listWhitelist: (repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:listWhitelist', repositoryId),
  addWhitelist: (entry: Omit<ProtectionEntry, 'id' | 'createdAt'>) => ipcRenderer.invoke('gitmanager:addWhitelist', entry),
  removeWhitelist: (id: string, repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:removeWhitelist', id, repositoryId),
  listProtected: (repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:listProtected', repositoryId),
  addProtected: (entry: Omit<ProtectionEntry, 'id' | 'createdAt'>) => ipcRenderer.invoke('gitmanager:addProtected', entry),
  removeProtected: (id: string, repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:removeProtected', id, repositoryId),

  getMonitoring: (repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:getMonitoring', repositoryId),
  saveMonitoring: (config: MonitoringConfig, repositoryId?: string | null) => ipcRenderer.invoke('gitmanager:saveMonitoring', config, repositoryId),

  listEmailGroups: () => ipcRenderer.invoke('gitmanager:listEmailGroups'),
  saveEmailGroup: (group: Partial<EmailGroup> & { id?: string }) => ipcRenderer.invoke('gitmanager:saveEmailGroup', group),
  deleteEmailGroup: (id: string) => ipcRenderer.invoke('gitmanager:deleteEmailGroup', id),

  listJobs: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listJobs', repositoryIds),
  saveJob: (job: Partial<SchedulerJob> & { id?: string }, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:saveJob', job, repositoryIds),
  deleteJob: (id: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:deleteJob', id, repositoryIds),
  deleteAllJobs: (repositoryIds: string[]) => ipcRenderer.invoke('gitmanager:deleteAllJobs', repositoryIds),
  runSchedulerJob: (id: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:runSchedulerJob', id, repositoryIds),
  listRuns: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listRuns', repositoryIds),
  calendarRuns: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:calendarRuns', repositoryIds),

  listNotifications: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listNotifications', repositoryIds),
  markNotificationRead: (id: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:markNotificationRead', id, repositoryIds),
  clearNotifications: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:clearNotifications', repositoryIds),

  getEmailConfig: () => ipcRenderer.invoke('gitmanager:getEmailConfig'),
  saveEmailConfig: (config: EmailConfig & { password?: string }) => ipcRenderer.invoke('gitmanager:saveEmailConfig', config),
  testEmailConnection: (config?: EmailConfig) => ipcRenderer.invoke('gitmanager:testEmailConnection', config),
  sendTestEmail: (config?: EmailConfig) => ipcRenderer.invoke('gitmanager:sendTestEmail', config),

  listReports: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listReports', repositoryIds),
  generateReport: (period: string, format?: string, repositoryIds?: string[]) =>
    ipcRenderer.invoke('gitmanager:generateReport', period, format, repositoryIds),
  sendSelectedRepositoriesReport: (period: string, recipients?: string, repositoryIds?: string[]) =>
    ipcRenderer.invoke('gitmanager:sendSelectedRepositoriesReport', period, recipients, repositoryIds),
  exportReport: (id: string, format: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:exportReport', id, format, repositoryIds),
  deleteReport: (id: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:deleteReport', id, repositoryIds),
  openReportFolder: () => ipcRenderer.invoke('gitmanager:openReportFolder'),
  openReportFile: (id: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:openReportFile', id, repositoryIds),

  listReportSchedules: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listReportSchedules', repositoryIds),
  saveReportSchedule: (schedule: Partial<ReportSchedule> & { id?: string }, repositoryIds?: string[]) =>
    ipcRenderer.invoke('gitmanager:saveReportSchedule', schedule, repositoryIds),
  deleteReportSchedule: (id: string, repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:deleteReportSchedule', id, repositoryIds),

  listBackups: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listBackups', repositoryIds),
  startBackups: (options: BackupOptions) => ipcRenderer.invoke('gitmanager:startBackups', options),
  deleteBackup: (id: string) => ipcRenderer.invoke('gitmanager:deleteBackup', id),
  selectBackupFolder: () => ipcRenderer.invoke('gitmanager:selectBackupFolder'),
  openBackupFolder: (path: string) => ipcRenderer.invoke('gitmanager:openBackupFolder', path),

  listAudit: (repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:listAudit', repositoryIds),
  exportAuditLogs: (format: 'csv' | 'json' | 'txt', repositoryIds?: string[]) => ipcRenderer.invoke('gitmanager:exportAuditLogs', format, repositoryIds),
  getSettings: () => ipcRenderer.invoke('gitmanager:getSettings'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('gitmanager:saveSettings', settings),
  getAppVersion: () => ipcRenderer.invoke('gitmanager:getAppVersion'),
  exportConfig: (extras?: ConfigExtras) => ipcRenderer.invoke('gitmanager:exportConfig', extras),
  importConfig: (confirmReplace?: boolean) => ipcRenderer.invoke('gitmanager:importConfig', confirmReplace),
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_e: unknown, progress: ScanProgress): void => callback(progress)
    ipcRenderer.on('gitmanager:scan-progress', listener)
    return () => ipcRenderer.removeListener('gitmanager:scan-progress', listener)
  },
  onNavigate: (callback: (route: string) => void) => {
    const listener = (_e: unknown, route: string): void => callback(route)
    ipcRenderer.on('gitmanager:navigate', listener)
    return () => ipcRenderer.removeListener('gitmanager:navigate', listener)
  }
}

contextBridge.exposeInMainWorld('gitmanager', api)
