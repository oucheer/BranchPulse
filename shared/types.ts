export type BranchType = 'local' | 'remote'
export type BranchState = 'active' | 'stale' | 'grace_period' | 'grace_expired'
export type NamingStatus = 'valid' | 'invalid' | 'excluded'
export type HealthLevel = 'healthy' | 'good' | 'warning' | 'critical'
export type ScanStatus = 'idle' | 'running' | 'completed' | 'failed'
export type EmailPolicy = 'none' | 'summary' | 'creators'
export type NotifyTarget = 'none' | 'self' | 'creator' | 'both' | (string & {})
export type RepositorySource = 'local' | 'gitlab' | 'github' | 'gitee'
export type ThemeMode = 'dark' | 'light' | 'system'
export type ColorTheme = 'default' | 'ocean' | 'forest' | 'violet' | 'rose' | 'cyan'
export type BackgroundTheme = 'dark' | 'light'
export type LanguageCode = 'en' | 'zh'

export interface CreatorInfo {
  name: string
  email: string
  firstCommitAt: string | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
}

export interface NamingResult {
  status: NamingStatus
  ruleName?: string
  reason?: string
}

export interface HealthFactor {
  label: string
  score: number
  weight: number
  detail: string
}

export interface HealthResult {
  score: number
  level: HealthLevel
  factors: HealthFactor[]
}

export interface ProtectionInfo {
  whitelisted: boolean
  isDefault: boolean
  protected: boolean
  rules: string[]
}

export interface BranchCriteria {
  repositoryId: string
  name: string
  type: BranchType
  remote?: string
}

export interface BranchSummary {
  id: string
  repositoryId: string
  repositoryName: string
  name: string
  displayName: string
  type: BranchType
  remote?: string
  existsLocally: boolean
  existsRemotely: boolean
  isHead: boolean
  creator: CreatorInfo
  createdAt: string | null
  lastCommitAt: string | null
  lastCommitSha: string
  lastAuthor: string
  commitCount: number
  ahead: number
  behind: number
  merged: boolean
  mergedInto: string | null
  baseBranch: string
  inactiveDays: number
  ageDays: number
  naming: NamingResult
  health: HealthResult
  protection: ProtectionInfo
  state: BranchState
  stale: boolean
  gracePeriodDays: number
  graceExpired: boolean
  cleanupCandidate: boolean
  recentCommits: CommitInfo[]
  lastScannedAt: string
}

export interface CommitInfo {
  sha: string
  shortSha: string
  authorName: string
  authorEmail: string
  committedAt: string
  subject: string
}

export interface Repository {
  id: string
  name: string
  path: string
  remoteProjectPath?: string
  source: RepositorySource
  gitlabUrl?: string
  gitlabProjectId?: number
  webUrl?: string
  currentBranch: string
  defaultBranch: string
  remotes: string[]
  lastFetchAt: string | null
  lastScanAt: string | null
  totalBranches: number
  createdAt: string
}

export interface NamingRule {
  id: string
  repositoryId?: string | null
  name: string
  pattern: string
  type: 'glob' | 'regex'
  mode: 'allow' | 'exclude'
  description: string
  enabled: boolean
  priority: number
}

export interface ProtectionEntry {
  id: string
  repositoryId?: string | null
  pattern: string
  type: 'exact' | 'glob' | 'regex'
  note: string
  createdAt: string
}

export interface MonitoringConfig {
  enabled: boolean
  staleThresholdDays: number
  gracePeriodDays: number
  staleThresholdUnit: 'minutes' | 'hours' | 'days'
  gracePeriodUnit: 'minutes' | 'hours' | 'days'
  fetchEnabled: boolean
  namingEnabled: boolean
  emailPolicy: EmailPolicy
  notificationEnabled: boolean
  autoDeleteEnabled: boolean
  notifyTarget: NotifyTarget
}

export interface SchedulerJob {
  id: string
  repositoryId?: string | null
  name: string
  kind: 'interval' | 'calendar'
  enabled: boolean
  intervalMinutes: number
  daysOfWeek: number[]
  time: string
  startDate: string | null
  endDate: string | null
  emailPolicy: EmailPolicy
  fetchEnabled: boolean
  autoDeleteEnabled: boolean
  notifyTarget: NotifyTarget
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
}

export interface ActivityItem {
  at: string
  message: string
  level: 'info' | 'success' | 'warn' | 'error'
}

export interface ScanRun {
  id: string
  startedAt: string
  finishedAt: string | null
  status: ScanStatus
  trigger: 'manual' | 'scheduler' | 'scan_repository' | 'startup'
  repositories: number
  branches: number
  active: number
  stale: number
  gracePeriod: number
  graceExpired: number
  merged: number
  namingInvalid: number
  cleanupCandidates: number
  deleted: number
  notifications: number
  emailsSent: number
  error: string | null
  activity: ActivityItem[]
}

export type NotificationType =
  | 'stale'
  | 'grace_period'
  | 'grace_expired'
  | 'naming_violation'
  | 'merged'
  | 'cleanup_candidate'

export interface NotificationRecord {
  id: string
  repositoryId: string
  repositoryName: string
  branch: string
  type: NotificationType
  state: string
  message: string
  createdAt: string
  deliveredToDesktop: boolean
  deliveredViaEmail: boolean
  read: boolean
}

export interface EmailGroup {
  id: string
  name: string
  recipients: string
  createdAt: string
}

export interface EmailConfig {
  server: string
  port: number
  username: string
  hasPassword: boolean
  from: string
  secure: boolean
  tls: boolean
  testRecipient: string
  selfEmail: string
  enabled: boolean
}

export interface EmailSendResult {
  ok: boolean
  message: string
  technical?: string
  emailsSent?: number
  recipients?: string[]
}

export interface ReportSummary {
  totalBranches: number
  validBranches: number
  invalidBranches: number
  excludedBranches: number
  compliancePercent: number
  active: number
  stale: number
  gracePeriod: number
  graceExpired: number
  merged: number
  namingViolations: number
  cleanupCandidates: number
  protectedBranches: number
  whitelistedBranches: number
  averageHealth: number
  repositories: number
}

export interface ReportRecord {
  id: string
  title: string
  repositoryId: string | null
  generatedAt: string
  period: string
  format: string
  path: string
  summary: ReportSummary
}

export type ReportScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'once'

export interface ReportSchedule {
  id: string
  name: string
  repositoryId: string | null
  frequency: ReportScheduleFrequency
  time: string
  weekday: number
  dayOfMonth: number
  runAt: string | null
  recipients: string
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
}

export interface AuditEntry {
  id: string
  at: string
  action: string
  detail: Record<string, unknown>
  result: 'success' | 'failure'
}

export interface AuditExportResult {
  ok: boolean
  path: string
  count: number
  error?: string
}

export interface AppSettings {
  theme: ThemeMode
  colorTheme: ColorTheme
  backgroundTheme: BackgroundTheme
  language: LanguageCode
  notificationsEnabled: boolean
  trayEnabled: boolean
  launchMinimized: boolean
  startWithWindows: boolean
  gitPath: string
  fetchPolicy: 'auto' | 'manual'
  gitlabUrl: string
  gitlabApiKey?: string
  hasGitlabApiKey: boolean
  activeRepositoryId: string | null
  deletionDisabled: boolean
}

export interface DeleteAuthorization {
  authorized: boolean
  targetType: BranchType
  repositoryId: string
  branch: string
  confirmationToken: string
  confirmed: boolean
}

export type DeleteBlockCode =
  | 'WHITELIST'
  | 'DEFAULT_BRANCH'
  | 'PROTECTED_BRANCH'
  | 'USER_NOT_AUTHORIZED'
  | 'NOT_CONFIRMED'
  | 'TARGET_MISSING'
  | 'TOKEN_MISMATCH'
  | 'STALE_STATE'

export interface DeleteDecision {
  allowed: boolean
  code: DeleteBlockCode | null
  message: string
  checks: { name: string; passed: boolean; detail: string }[]
}

export interface DeleteRequest {
  authorization: DeleteAuthorization
  confirmationToken: string
  reason?: string
}

export interface DeleteAuthSession {
  token: string
  decision: DeleteDecision
  branch: BranchSummary | null
  expiresAt: number
}

export interface DeleteResult {
  branch: string
  targetType: BranchType
  ok: boolean
  message: string
  decision: DeleteDecision
}

export interface RunCheckOptions {
  bypassEnabledCheck?: boolean
  emailPolicy?: EmailPolicy
  notifyTarget?: NotifyTarget
  autoDelete?: boolean
  fetch?: boolean
  repositoryIds?: string[]
  trigger?: ScanRun['trigger']
}

export interface GitLabConnectionConfig {
  url?: string
  apiKey?: string
  projectPath?: string
  provider?: Exclude<RepositorySource, 'local'>
}

export interface GitLabProject {
  id: number
  name: string
  pathWithNamespace: string
  webUrl: string
  defaultBranch: string
  httpUrlToRepo: string
  avatarUrl: string | null
}

export interface GitLabTestResult {
  ok: boolean
  message: string
  version?: string
  technical?: string
}

export interface DashboardSnapshot {
  repositories: Repository[]
  branches: BranchSummary[]
  scanRuns: ScanRun[]
  notifications: NotificationRecord[]
  settings: AppSettings
  monitoring: MonitoringConfig
  activeRepositoryId: string | null
}

export interface ScanProgress {
  runId: string
  activity: ActivityItem[]
  summary?: Pick<
    ScanRun,
    | 'status'
    | 'branches'
    | 'stale'
    | 'gracePeriod'
    | 'graceExpired'
    | 'merged'
    | 'namingInvalid'
    | 'cleanupCandidates'
  >
}

export const DeleteBlockLabels: Record<DeleteBlockCode, string> = {
  WHITELIST: 'Branch is protected by whitelist.',
  DEFAULT_BRANCH: 'Default branch cannot be deleted.',
  PROTECTED_BRANCH: 'Branch is protected by a protection rule.',
  USER_NOT_AUTHORIZED: 'Explicit user authorization is required.',
  NOT_CONFIRMED: 'Deletion confirmation is required.',
  TARGET_MISSING: 'Branch target no longer exists.',
  TOKEN_MISMATCH: 'Confirmation token is invalid or expired.',
  STALE_STATE: 'Branch state changed since authorization.'
}

export interface BranchApi {
  init(): Promise<DashboardSnapshot>
  addGitLabRepository(projectId: number, config?: GitLabConnectionConfig): Promise<Repository>
  listGitLabProjects(config?: GitLabConnectionConfig): Promise<GitLabProject[]>
  testGitLabConnection(config?: GitLabConnectionConfig): Promise<GitLabTestResult>
  removeRepository(id: string): Promise<Repository[]>
  listRepositories(): Promise<Repository[]>
  scanRepository(id: string, fetch?: boolean): Promise<ScanRun>
  runCheckNow(options: RunCheckOptions): Promise<ScanRun>
  listBranches(): Promise<BranchSummary[]>
  getBranch(criteria: BranchCriteria): Promise<BranchSummary | null>
  notifyBranch(branch: BranchSummary): Promise<NotificationRecord[]>
  notifyBranchesEmail(branches: BranchSummary[]): Promise<{ sent: number; message: string }>
  notifySelfEmail(branches: BranchSummary[]): Promise<{ sent: number; message: string }>
  beginDelete(criteria: BranchCriteria): Promise<DeleteAuthSession>
  deleteBranch(request: DeleteRequest): Promise<DeleteResult>
  batchDelete(requests: DeleteRequest[]): Promise<DeleteResult[]>

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

  listJobs(): Promise<SchedulerJob[]>
  saveJob(job: Partial<SchedulerJob> & { id?: string }): Promise<SchedulerJob[]>
  deleteJob(id: string): Promise<SchedulerJob[]>
  runSchedulerJob(id: string): Promise<ScanRun>
  listRuns(): Promise<ScanRun[]>
  calendarRuns(): Promise<{ date: string; status: ScanStatus; runs: number }[]>

  listNotifications(): Promise<NotificationRecord[]>
  markNotificationRead(id: string): Promise<NotificationRecord[]>
  clearNotifications(): Promise<void>

  getEmailConfig(): Promise<EmailConfig>
  saveEmailConfig(config: EmailConfig & { password?: string }): Promise<EmailConfig>
  testEmailConnection(): Promise<EmailSendResult>
  sendTestEmail(): Promise<EmailSendResult>

  listReports(): Promise<ReportRecord[]>
  generateReport(period: string, format?: string, repositoryId?: string | null): Promise<ReportRecord>
  exportReport(id: string, format: string): Promise<ReportRecord>
  deleteReport(id: string): Promise<ReportRecord[]>
  openReportFolder(): Promise<void>
  listReportSchedules(): Promise<ReportSchedule[]>
  saveReportSchedule(schedule: Partial<ReportSchedule> & { id?: string }): Promise<ReportSchedule[]>
  deleteReportSchedule(id: string): Promise<ReportSchedule[]>

  listAudit(): Promise<AuditEntry[]>
  exportAuditLogs(format: 'csv' | 'json' | 'txt'): Promise<AuditExportResult>
  listEmailGroups(): Promise<EmailGroup[]>
  saveEmailGroup(group: Partial<EmailGroup> & { id?: string }): Promise<EmailGroup[]>
  deleteEmailGroup(id: string): Promise<EmailGroup[]>

  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  onScanProgress(callback: (progress: ScanProgress) => void): () => void
}

declare global {
  interface Window {
    branchpulse: BranchApi
  }
}
