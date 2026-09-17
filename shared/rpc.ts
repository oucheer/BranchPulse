/**
 * Transport contract shared by the browser bridge and the HTTP server.
 *
 * Keeping the method list here means a new renderer-facing operation cannot be
 * added to only one side: the server rejects anything missing from the list and
 * the client bridge refuses to call it in the first place.
 */
export const EXPOSED_METHODS = [
  'init',
  'addGitLabRepository',
  'listGitLabProjects',
  'testGitLabConnection',
  'removeRepository',
  'listRepositories',
  'scanRepository',
  'runCheckNow',
  'listBranches',
  'getBranch',
  'notifyBranch',
  'notifyBranchesEmail',
  'notifySelfEmail',
  'listNamingRules',
  'saveNamingRule',
  'deleteNamingRule',
  'reorderNamingRule',
  'validateBranchName',
  'listWhitelist',
  'addWhitelist',
  'removeWhitelist',
  'listProtected',
  'addProtected',
  'removeProtected',
  'getMonitoring',
  'saveMonitoring',
  'listEmailGroups',
  'saveEmailGroup',
  'deleteEmailGroup',
  'exportGroupBranches',
  'emailGroupBranches',
  'listJobs',
  'saveJob',
  'deleteJob',
  'deleteAllJobs',
  'runSchedulerJob',
  'listRuns',
  'calendarRuns',
  'listNotifications',
  'markNotificationRead',
  'clearNotifications',
  'getEmailConfig',
  'saveEmailConfig',
  'testEmailConnection',
  'sendTestEmail',
  'listReports',
  'generateReport',
  'exportReport',
  'deleteReport',
  'openReportFolder',
  'openReportFile',
  'listReportSchedules',
  'saveReportSchedule',
  'deleteReportSchedule',
  'listBackups',
  'startBackup',
  'deleteBackup',
  'selectBackupFolder',
  'openBackupFolder',
  'listAudit',
  'exportAuditLogs',
  'getSettings',
  'saveSettings',
  'getAppVersion',
  'exportConfig',
  'importConfig'
] as const

export type ExposedMethod = (typeof EXPOSED_METHODS)[number]

/** Server-sent events the browser subscribes to. */
export const EVENT_NAMES = ['scan-progress', 'navigate'] as const

export type EventName = (typeof EVENT_NAMES)[number]

/** `<method>` part of `POST /api/rpc/<method>`. */
export const RPC_PREFIX = '/api/rpc/'

/** `GET /api/events` — SSE stream carrying `EVENT_NAMES`. */
export const EVENTS_PATH = '/api/events'

/** `GET /api/fs/folders` — directory listing behind the in-page folder picker. */
export const FOLDERS_PATH = '/api/fs/folders'

/** `GET /api/reports/<id>/download` — reads a generated report back to the browser. */
export function reportDownloadPath(id: string): string {
  return `/api/reports/${encodeURIComponent(id)}/download`
}
