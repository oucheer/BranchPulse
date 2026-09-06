import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BranchApi,
  BranchCriteria,
  BranchSummary,
  DeleteRequest,
  GitLabConnectionConfig,
  EmailConfig,
  EmailGroup,
  MonitoringConfig,
  NamingRule,
  ProtectionEntry,
  ReportSchedule,
  RunCheckOptions,
  ScanProgress,
  SchedulerJob
} from '@shared/types'

const api: BranchApi = {
  init: () => ipcRenderer.invoke('branchpulse:init'),
  addGitLabRepository: (projectId: number, config?: GitLabConnectionConfig) =>
    ipcRenderer.invoke('branchpulse:addGitLabRepository', projectId, config),
  listGitLabProjects: (config?: GitLabConnectionConfig) => ipcRenderer.invoke('branchpulse:listGitLabProjects', config),
  testGitLabConnection: (config?: GitLabConnectionConfig) => ipcRenderer.invoke('branchpulse:testGitLabConnection', config),
  removeRepository: (id: string) => ipcRenderer.invoke('branchpulse:removeRepository', id),
  listRepositories: () => ipcRenderer.invoke('branchpulse:listRepositories'),
  scanRepository: (id: string, fetch?: boolean) => ipcRenderer.invoke('branchpulse:scanRepository', id, fetch),
  runCheckNow: (options: RunCheckOptions = {}) => ipcRenderer.invoke('branchpulse:runCheckNow', options),
  listBranches: () => ipcRenderer.invoke('branchpulse:listBranches'),
  getBranch: (criteria: BranchCriteria) => ipcRenderer.invoke('branchpulse:getBranch', criteria),
  notifyBranch: (branch: BranchSummary) => ipcRenderer.invoke('branchpulse:notifyBranch', branch),
  notifyBranchesEmail: (branches: BranchSummary[]) => ipcRenderer.invoke('branchpulse:notifyBranchesEmail', branches),
  notifySelfEmail: (branches: BranchSummary[]) => ipcRenderer.invoke('branchpulse:notifySelfEmail', branches),
  beginDelete: (criteria: BranchCriteria) => ipcRenderer.invoke('branchpulse:beginDelete', criteria),
  deleteBranch: (request: DeleteRequest) => ipcRenderer.invoke('branchpulse:deleteBranch', request),
  batchDelete: (requests: DeleteRequest[]) => ipcRenderer.invoke('branchpulse:batchDelete', requests),

  listNamingRules: (repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:listNamingRules', repositoryId),
  saveNamingRule: (rule: Partial<NamingRule> & { id?: string }) => ipcRenderer.invoke('branchpulse:saveNamingRule', rule),
  deleteNamingRule: (id: string, repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:deleteNamingRule', id, repositoryId),
  reorderNamingRule: (id: string, direction: -1 | 1, repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:reorderNamingRule', id, direction, repositoryId),
  validateBranchName: (name: string, repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:validateBranchName', name, repositoryId),

  listWhitelist: (repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:listWhitelist', repositoryId),
  addWhitelist: (entry: Omit<ProtectionEntry, 'id' | 'createdAt'>) => ipcRenderer.invoke('branchpulse:addWhitelist', entry),
  removeWhitelist: (id: string, repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:removeWhitelist', id, repositoryId),
  listProtected: (repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:listProtected', repositoryId),
  addProtected: (entry: Omit<ProtectionEntry, 'id' | 'createdAt'>) => ipcRenderer.invoke('branchpulse:addProtected', entry),
  removeProtected: (id: string, repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:removeProtected', id, repositoryId),

  getMonitoring: (repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:getMonitoring', repositoryId),
  saveMonitoring: (config: MonitoringConfig, repositoryId?: string | null) => ipcRenderer.invoke('branchpulse:saveMonitoring', config, repositoryId),

  listEmailGroups: () => ipcRenderer.invoke('branchpulse:listEmailGroups'),
  saveEmailGroup: (group: Partial<EmailGroup> & { id?: string }) => ipcRenderer.invoke('branchpulse:saveEmailGroup', group),
  deleteEmailGroup: (id: string) => ipcRenderer.invoke('branchpulse:deleteEmailGroup', id),

  listJobs: () => ipcRenderer.invoke('branchpulse:listJobs'),
  saveJob: (job: Partial<SchedulerJob> & { id?: string }) => ipcRenderer.invoke('branchpulse:saveJob', job),
  deleteJob: (id: string) => ipcRenderer.invoke('branchpulse:deleteJob', id),
  runSchedulerJob: (id: string) => ipcRenderer.invoke('branchpulse:runSchedulerJob', id),
  listRuns: () => ipcRenderer.invoke('branchpulse:listRuns'),
  calendarRuns: () => ipcRenderer.invoke('branchpulse:calendarRuns'),

  listNotifications: () => ipcRenderer.invoke('branchpulse:listNotifications'),
  markNotificationRead: (id: string) => ipcRenderer.invoke('branchpulse:markNotificationRead', id),
  clearNotifications: () => ipcRenderer.invoke('branchpulse:clearNotifications'),

  getEmailConfig: () => ipcRenderer.invoke('branchpulse:getEmailConfig'),
  saveEmailConfig: (config: EmailConfig & { password?: string }) => ipcRenderer.invoke('branchpulse:saveEmailConfig', config),
  testEmailConnection: (config?: EmailConfig) => ipcRenderer.invoke('branchpulse:testEmailConnection', config),
  sendTestEmail: (config?: EmailConfig) => ipcRenderer.invoke('branchpulse:sendTestEmail', config),

  listReports: () => ipcRenderer.invoke('branchpulse:listReports'),
  generateReport: (period: string, format?: string, repositoryId?: string | null) =>
    ipcRenderer.invoke('branchpulse:generateReport', period, format, repositoryId),
  exportReport: (id: string, format: string) => ipcRenderer.invoke('branchpulse:exportReport', id, format),
  deleteReport: (id: string) => ipcRenderer.invoke('branchpulse:deleteReport', id),
  openReportFolder: () => ipcRenderer.invoke('branchpulse:openReportFolder'),

  listReportSchedules: () => ipcRenderer.invoke('branchpulse:listReportSchedules'),
  saveReportSchedule: (schedule: Partial<ReportSchedule> & { id?: string }) =>
    ipcRenderer.invoke('branchpulse:saveReportSchedule', schedule),
  deleteReportSchedule: (id: string) => ipcRenderer.invoke('branchpulse:deleteReportSchedule', id),

  listAudit: () => ipcRenderer.invoke('branchpulse:listAudit'),
  getSettings: () => ipcRenderer.invoke('branchpulse:getSettings'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('branchpulse:saveSettings', settings),
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_e: unknown, progress: ScanProgress): void => callback(progress)
    ipcRenderer.on('branchpulse:scan-progress', listener)
    return () => ipcRenderer.removeListener('branchpulse:scan-progress', listener)
  }
}

contextBridge.exposeInMainWorld('branchpulse', api)
