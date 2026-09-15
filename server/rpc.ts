import type { BranchPulseApi } from '../src-node/api'

/**
 * Methods the browser may invoke. Everything else is rejected, so adding a
 * public method requires an explicit decision here too.
 */
const EXPOSED_METHODS = [
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
  'beginDelete',
  'deleteBranch',
  'batchDelete',
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

const exposed = new Set<string>(EXPOSED_METHODS)

export function isExposedMethod(name: string): name is ExposedMethod {
  return exposed.has(name)
}

export function exposeMethods(): ExposedMethod[] {
  return [...EXPOSED_METHODS]
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export interface RpcResult {
  status: number
  body: unknown
}

/**
 * Invokes one renderer-facing method. Arguments arrive as a positional JSON
 * array, exactly matching the previous `ipcRenderer.invoke(channel, ...args)`
 * call sites, so no renderer code had to change.
 */
export async function invoke(api: BranchPulseApi, method: string, args: unknown[]): Promise<RpcResult> {
  if (!isExposedMethod(method)) {
    return { status: 404, body: { error: `Unknown method: ${method}` } }
  }
  const fn = (api as unknown as Record<string, unknown>)[method]
  if (typeof fn !== 'function') {
    return { status: 404, body: { error: `Method not implemented: ${method}` } }
  }
  try {
    const value = await (fn as (...a: unknown[]) => unknown).apply(api, args)
    return { status: 200, body: { result: value === undefined ? null : value } }
  } catch (err) {
    return { status: 500, body: { error: errorMessage(err) } }
  }
}
