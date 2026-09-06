import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, FolderGit2, GitBranch, GitMerge, Hourglass, Scale, ShieldCheck, Trash2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { Card, StatCard, Ring, Badge } from '../components/ui'
import { tr } from '../stores/appStore'
import FlowingMenu from '../components/FlowingMenu'
import { timeAgo, stateLabel, stateTone, healthTone } from '../lib/format'
import type { BranchSummary } from '@shared/types'

export default function Dashboard(): JSX.Element {
  const branches = useAppStore((s) => s.branches)
  const repositories = useAppStore((s) => s.repositories)
  const scanRuns = useAppStore((s) => s.scanRuns)
  const notifications = useAppStore((s) => s.notifications)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const monitoring = useAppStore((s) => s.monitoring)
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()

  const visibleBranches = activeRepositoryId ? branches.filter((b) => b.repositoryId === activeRepositoryId) : branches
  const visibleNotifications = activeRepositoryId ? notifications.filter((n) => n.repositoryId === activeRepositoryId) : notifications
  const visibleScanRuns = activeRepositoryId ? scanRuns.filter((r) => r.repositories <= 1) : scanRuns
  const count = (fn: (b: BranchSummary) => boolean) => visibleBranches.filter(fn).length
  const avgHealth = visibleBranches.length ? Math.round(visibleBranches.reduce((s, b) => s + b.health.score, 0) / visibleBranches.length) : 0
  const validBranches = count((b) => b.naming.status === 'valid')
  const excludedBranches = count((b) => b.naming.status === 'excluded')
  const compliance = visibleBranches.length ? Math.round(((validBranches + excludedBranches) / visibleBranches.length) * 100) : 0
  const lastRun = visibleScanRuns.find((r) => r.status === 'completed')
  const unread = visibleNotifications.length

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{tr('dashboard')}</h1>
        <div className="flex items-center gap-3 text-xs text-muted">
          {lastRun ? (
            <>
              <span>{tr('lastCheck')}: {timeAgo(lastRun.finishedAt)}</span>
              <span>|</span>
              <span>{lastRun.branches} {tr('totalBranches').toLowerCase()}</span>
            </>
          ) : null}
          <span className={`h-2 w-2 rounded-full ${monitoring.notificationEnabled ? 'bg-ok' : 'bg-warn'}`} />
          <span>{monitoring.staleThresholdDays}d / {monitoring.gracePeriodDays}d</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label={tr('repositories')} value={activeRepositoryId ? 1 : repositories.length} icon={<FolderGit2 size={18} />} />
        <StatCard label={tr('totalBranches')} value={visibleBranches.length} icon={<GitBranch size={18} />} />
        <StatCard label={tr('averageHealth')} value={avgHealth} tone={avgHealth >= 70 ? 'ok' : avgHealth >= 40 ? 'warn' : 'danger'} icon={<Activity size={18} />} />
        <StatCard label={tr('namingCompliance')} value={`${compliance}%`} tone={compliance >= 90 ? 'ok' : compliance >= 70 ? 'warn' : 'danger'} icon={<Scale size={18} />} />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label={tr('active')} value={count((b) => b.state === 'active')} tone="ok" icon={<GitBranch size={18} />} />
        <StatCard label={tr('stale')} value={count((b) => b.stale)} tone="warn" icon={<Hourglass size={18} />} />
        <StatCard label={tr('gracePeriod')} value={count((b) => b.state === 'grace_period')} tone="warn" icon={<Hourglass size={18} />} />
        <StatCard label={tr('graceExpired')} value={count((b) => b.state === 'grace_expired')} tone="danger" icon={<AlertTriangle size={18} />} />
        <StatCard label={tr('merged')} value={count((b) => b.merged)} tone="secondary" icon={<GitMerge size={18} />} />
        <StatCard label={tr('namingViolations')} value={count((b) => b.naming.status === 'invalid')} tone="danger" icon={<Scale size={18} />} />
        <StatCard label={tr('cleanupCandidates')} value={count((b) => b.cleanupCandidate)} tone="danger" icon={<Trash2 size={18} />} />
        <StatCard label={tr('protectedBranches')} value={count((b) => b.protection.protected)} tone="primary" icon={<ShieldCheck size={18} />} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{tr('repositories')}</div>
          <div className="space-y-2">
            {(activeRepositoryId ? repositories.filter((r) => r.id === activeRepositoryId) : repositories).slice(0, 6).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
                <span className="text-canvas-fg">{r.name}</span>
                <span className="text-muted">{r.totalBranches} {tr('branches').toLowerCase()}</span>
              </div>
            ))}
            {(activeRepositoryId ? repositories.filter((r) => r.id === activeRepositoryId) : repositories).length === 0 ? (
              <div className="py-6 text-center text-sm text-muted">{tr('noRepositories')}</div>
            ) : null}
          </div>
        </Card>
        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{tr('notifications')}</div>
          <div className="space-y-2">
            {visibleNotifications.slice(0, 6).map((n) => (
              <div key={n.id} className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm">
                <Badge tone={n.read ? 'default' : 'primary'}>{n.type}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-canvas-fg">{n.branch}</div>
                  <div className="text-xs text-muted">{n.message}</div>
                </div>
              </div>
            ))}
            {visibleNotifications.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted">{tr('noNotifications')}</div>
            ) : null}
          </div>
        </Card>
      </div>
      </div>
      <aside className="hidden h-[calc(100vh-7.5rem)] xl:block">
        <FlowingMenu />
      </aside>
    </div>
  )
}
