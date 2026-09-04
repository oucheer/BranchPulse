import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BranchApi,
  BranchCriteria,
  BranchSummary,
  DeleteRequest,
  GitLabConnectionConfig,
  EmailConfig,
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
  addRepository: (path: string) => ipcRenderer.invoke('branchpulse:addRepository', path),
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
  beginDelete: (criteria: BranchCriteria) => ipcRenderer.invoke('branchpulse:beginDelete', criteria),
  deleteBranch: (request: DeleteRequest) => ipcRenderer.invoke('branchpulse:deleteBranch', request),
  batchDelete: (requests: DeleteRequest[]) => ipcRenderer.invoke('branchpulse:batchDelete', requests),

  listNamingRules: () => ipcRenderer.invoke('branchpulse:listNamingRules'),
  saveNamingRule: (rule: Partial<NamingRule> & { id?: string }) => ipcRenderer.invoke('branchpulse:saveNamingRule', rule),
  deleteNamingRule: (id: string) => ipcRenderer.invoke('branchpulse:deleteNamingRule', id),
  reorderNamingRule: (id: string, direction: -1 | 1) => ipcRenderer.invoke('branchpulse:reorderNamingRule', id, direction),
  validateBranchName: (name: string) => ipcRenderer.invoke('branchpulse:validateBranchName', name),

  listWhitelist: () => ipcRenderer.invoke('branchpulse:listWhitelist'),
  addWhitelist: (entry: Omit<ProtectionEntry, 'id' | 'createdAt'>) => ipcRenderer.invoke('branchpulse:addWhitelist', entry),
  removeWhitelist: (id: string) => ipcRenderer.invoke('branchpulse:removeWhitelist', id),
  listProtected: () => ipcRenderer.invoke('branchpulse:listProtected'),
  addProtected: (entry: Omit<ProtectionEntry, 'id' | 'createdAt'>) => ipcRenderer.invoke('branchpulse:addProtected', entry),
  removeProtected: (id: string) => ipcRenderer.invoke('branchpulse:removeProtected', id),

  getMonitoring: () => ipcRenderer.invoke('branchpulse:getMonitoring'),
  saveMonitoring: (config: MonitoringConfig) => ipcRenderer.invoke('branchpulse:saveMonitoring', config),

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
  createDemoRepository: () => ipcRenderer.invoke('branchpulse:createDemoRepository'),
  pickDirectory: () => ipcRenderer.invoke('branchpulse:pickDirectory'),
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_e: unknown, progress: ScanProgress): void => callback(progress)
    ipcRenderer.on('branchpulse:scan-progress', listener)
    return () => ipcRenderer.removeListener('branchpulse:scan-progress', listener)
  }
}

contextBridge.exposeInMainWorld('branchpulse', api)
