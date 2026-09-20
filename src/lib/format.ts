import type { BranchState, HealthLevel, ScanRun } from '@shared/types'

/**
 * Toast text and tone for a finished scan.
 *
 * A run can succeed for some repositories and fail for others, and a failure
 * used to be reported as a plain "0 branches": an unreachable or misconfigured
 * forge looked exactly like an empty repository. The failure reason is now the
 * headline, with the branch count as context.
 */
export function describeScanRun(run: ScanRun, language: 'en' | 'zh' = 'zh'): {
  message: string
  level: 'success' | 'warn' | 'error'
} {
  const zh = language === 'zh'
  if (run.error) {
    // Several repositories can fail at once; the toast stays short and the full
    // list is on the monitoring page and in the run's activity log.
    const first = run.error.split(' | ')[0]
    return {
      message: zh ? `扫描失败：${first}` : `Scan failed: ${first}`,
      level: run.branches > 0 ? 'warn' : 'error'
    }
  }
  return {
    message: zh ? `扫描完成，共 ${run.branches} 个分支` : `Scan complete: ${run.branches} branches`,
    level: 'success'
  }
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never'
  const then = new Date(iso).getTime()
  const diff = Math.max(0, now - then)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export function stateLabel(state: BranchState, language: 'en' | 'zh'): string {
  const labels: Record<BranchState, string> =
    language === 'zh'
      ? { active: '活跃', stale: '已停更' }
      : { active: 'Active', stale: 'Stale' }
  return labels[state] ?? state
}

export function healthTone(level: HealthLevel): 'ok' | 'warn' | 'danger' {
  if (level === 'healthy' || level === 'good') return 'ok'
  if (level === 'warning') return 'warn'
  return 'danger'
}

export function stateTone(state: BranchState): 'ok' | 'warn' | 'danger' | 'info' {
  if (state === 'active') return 'ok'
  return 'warn'
}
