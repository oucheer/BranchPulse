import type { BranchState, HealthLevel } from '@shared/types'

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
      ? { active: '活跃', stale: '陈旧', grace_period: '宽限期', grace_expired: '宽限到期' }
      : { active: 'Active', stale: 'Stale', grace_period: 'Grace', grace_expired: 'Expired' }
  return labels[state] ?? state
}

export function healthTone(level: HealthLevel): 'ok' | 'warn' | 'danger' {
  if (level === 'healthy' || level === 'good') return 'ok'
  if (level === 'warning') return 'warn'
  return 'danger'
}

export function stateTone(state: BranchState): 'ok' | 'warn' | 'danger' | 'info' {
  if (state === 'active') return 'ok'
  if (state === 'grace_period') return 'warn'
  if (state === 'grace_expired') return 'danger'
  return 'warn'
}
