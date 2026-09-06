import { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, FolderGit2, GitBranch, GitMerge, Hourglass, Scale, ShieldCheck, Trash2, Network } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Card, StatCard, Badge } from '../components/ui'
import { timeAgo, stateLabel, stateTone, healthTone } from '../lib/format'
import type { BranchSummary } from '@shared/types'

const MAX_GRAPH_BRANCHES = 14

function statusToneClass(tone: string): string {
  if (tone === 'ok') return 'text-ok bg-ok/10 border-ok/20'
  if (tone === 'warn') return 'text-warn bg-warn/10 border-warn/20'
  if (tone === 'danger') return 'text-danger bg-danger/10 border-danger/20'
  return 'text-secondary bg-secondary/10 border-secondary/20'
}

function toneColor(tone: string): string {
  if (tone === 'ok') return 'rgb(var(--ok))'
  if (tone === 'warn') return 'rgb(var(--warn))'
  if (tone === 'danger') return 'rgb(var(--danger))'
  return 'rgb(var(--secondary))'
}

export default function Dashboard(): JSX.Element {
  const branches = useAppStore((s) => s.branches)
  const repositories = useAppStore((s) => s.repositories)
  const scanRuns = useAppStore((s) => s.scanRuns)
  const notifications = useAppStore((s) => s.notifications)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const monitoring = useAppStore((s) => s.monitoring)
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const [hovered, setHovered] = useState<string | null>(null)

  const visibleBranches = activeRepositoryId ? branches.filter((b) => b.repositoryId === activeRepositoryId) : branches
  const visibleNotifications = activeRepositoryId ? notifications.filter((n) => n.repositoryId === activeRepositoryId) : notifications
  const visibleScanRuns = activeRepositoryId ? scanRuns.filter((r) => r.repositories <= 1) : scanRuns

  const graphBranches = useMemo(() => {
    const filtered = visibleBranches.filter((b) => !b.merged || b.state !== 'grace_expired')
    const sorted = filtered.sort((a, b) => (a.inactiveDays ?? 9999) - (b.inactiveDays ?? 9999))
    return sorted.slice(0, MAX_GRAPH_BRANCHES)
  }, [visibleBranches])

  const baseBranch = graphBranches.find((b) => b.protection.isDefault)?.baseBranch ?? 'main'
  const count = useCallback((fn: (b: BranchSummary) => boolean) => visibleBranches.filter(fn).length, [visibleBranches])
  const avgHealth = visibleBranches.length ? Math.round(visibleBranches.reduce((s, b) => s + b.health.score, 0) / visibleBranches.length) : 0
  const validBranches = count((b) => b.naming.status === 'valid')
  const excludedBranches = count((b) => b.naming.status === 'excluded')
  const compliance = visibleBranches.length ? Math.round(((validBranches + excludedBranches) / visibleBranches.length) * 100) : 0
  const lastRun = visibleScanRuns.find((r) => r.status === 'completed')

  const handleBranchClick = (b: BranchSummary) => {
    navigate(`/branches/${b.repositoryId}/${b.type}/${encodeURIComponent(b.name.replaceAll('/', '~'))}`)
  }

  const graphRows = graphBranches.map((b, i) => ({ ...b, rowY: 28 + i * 38, tone: stateTone(b.state) }))
  const graphHeight = Math.max(80, graphRows.length * 38 + 44)

  const statusChips = [
    { key: 'active', label: tr('active'), value: count((b) => b.state === 'active'), tone: 'ok' },
    { key: 'stale', label: tr('stale'), value: count((b) => b.stale), tone: 'warn' },
    { key: 'grace', label: tr('gracePeriod'), value: count((b) => b.state === 'grace_period'), tone: 'warn' },
    { key: 'expired', label: tr('graceExpired'), value: count((b) => b.state === 'grace_expired'), tone: 'danger' },
    { key: 'merged', label: tr('merged'), value: count((b) => b.merged), tone: 'secondary' },
    { key: 'violation', label: tr('namingViolations'), value: count((b) => b.naming.status === 'invalid'), tone: 'danger' },
    { key: 'cleanup', label: tr('cleanupCandidates'), value: count((b) => b.cleanupCandidate), tone: 'danger' },
    { key: 'protected', label: tr('protectedBranches'), value: count((b) => b.protection.protected), tone: 'primary' }
  ]

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-canvas-fg">{tr('dashboard')}</h1>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            {lastRun ? <span>{tr('lastCheck')}: {timeAgo(lastRun.finishedAt)}</span> : null}
            <span className="h-2 w-2 rounded-full" style={{ background: monitoring.notificationEnabled ? 'rgb(var(--ok))' : 'rgb(var(--warn))' }} />
            <span className="tabular-nums">{monitoring.staleThresholdDays}d / {monitoring.gracePeriodDays}d</span>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label={tr('repositories')} value={activeRepositoryId ? 1 : repositories.length} icon={<FolderGit2 size={18} />} />
          <StatCard label={tr('totalBranches')} value={visibleBranches.length} icon={<GitBranch size={18} />} />
          <StatCard label={tr('averageHealth')} value={avgHealth} tone={avgHealth >= 70 ? 'ok' : avgHealth >= 40 ? 'warn' : 'danger'} icon={<Activity size={18} />} />
          <StatCard label={tr('namingCompliance')} value={`${compliance}%`} tone={compliance >= 90 ? 'ok' : compliance >= 70 ? 'warn' : 'danger'} icon={<Scale size={18} />} />
        </div>

        {/* Status chip strip */}
        <div className="flex flex-wrap gap-1.5">
          {statusChips.map((chip) => (
            <span
              key={chip.key}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-opacity duration-150 ${statusToneClass(chip.tone)}`}
            >
              {chip.label}
              <span className="ml-0.5 font-semibold">{chip.value}</span>
            </span>
          ))}
        </div>

        {/* Branch Graph */}
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Network size={15} className="text-primary" />
              <span className="text-sm font-semibold text-canvas-fg">{tr('branchGraph')}</span>
            </div>
            <button
              onClick={() => navigate('/branches')}
              className="text-xs font-medium text-primary transition-opacity hover:opacity-75"
            >
              {tr('viewAll')}
            </button>
          </div>
          {graphBranches.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted">{tr('noBranches')}</div>
          ) : (
            <div className="relative">
              <svg
                width="100%"
                height={graphHeight}
                viewBox={`0 0 560 ${graphHeight}`}
                preserveAspectRatio="xMinYMin meet"
                className="block"
                onMouseLeave={() => setHovered(null)}
              >
                {/* Trunk line */}
                <line x1="18" y1="8" x2="18" y2={graphHeight - 8} stroke="rgb(var(--line))" strokeWidth="2" strokeLinecap="round" />
                {/* Base branch node */}
                <circle cx="18" cy="14" r="5" fill="rgb(var(--primary))" />
                <text x="28" y="18" fontSize="11" fontWeight="600" fill="rgb(var(--primary))" fontFamily="JetBrains Mono, monospace">{baseBranch}</text>

                {graphRows.map((b, i) => {
                  const x1 = 18
                  const y1 = 14
                  const x2 = 240
                  const y2 = b.rowY
                  const midX = x1 + (x2 - x1) * 0.45
                  const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
                  const isActive = hovered === b.id
                  const isDimmed = hovered !== null && hovered !== b.id
                  return (
                    <g
                      key={b.id}
                      opacity={isDimmed ? 0.22 : 1}
                      style={{ transition: 'opacity 180ms ease' }}
                      onMouseEnter={() => setHovered(b.id)}
                      onClick={() => handleBranchClick(b)}
                      className="cursor-pointer"
                    >
                      <path
                        d={path}
                        fill="none"
                        stroke={toneColor(b.tone)}
                        strokeWidth={isActive ? 2.2 : 1.4}
                        strokeLinecap="round"
                        strokeDasharray="4 4"
                        opacity={isActive ? 1 : 0.7}
                        style={{ transition: 'stroke-width 150ms ease, opacity 150ms ease' }}
                      />
                      {/* Connection dot at trunk */}
                      <circle cx={x1} cy={y1} r={isActive ? 4 : 2.5} fill={toneColor(b.tone)} opacity={0.6} style={{ transition: 'r 150ms ease' }} />
                      {/* Tip node */}
                      <circle cx={x2 + 8} cy={y2} r={isActive ? 5 : 3.5} fill={toneColor(b.tone)} style={{ transition: 'r 150ms ease, fill 150ms ease' }} />
                      {/* Label */}
                      <text x={x2 + 18} y={y2 + 4} fontSize="11.5" fill={isActive ? 'rgb(var(--fg))' : 'rgb(var(--muted))'} fontFamily="JetBrains Mono, monospace" style={{ transition: 'fill 150ms ease' }}>
                        {b.displayName}
                      </text>
                      {/* Inactive days */}
                      <text x={x2 + 200} y={y2 + 4} fontSize="10" fill="rgb(var(--muted))" className="tabular-nums">
                        {b.inactiveDays}d
                      </text>
                      {/* Health pill */}
                      <rect x={x2 + 240} y={y2 - 9} width="26" height="16" rx="8" fill={toneColor(healthTone(b.health.level))} opacity={0.15} />
                      <text x={x2 + 253} y={y2 + 3} fontSize="9" fontWeight="600" textAnchor="middle" fill={toneColor(healthTone(b.health.level))} className="tabular-nums">
                        {b.health.score}
                      </text>
                      {/* State badge */}
                      <rect x={x2 + 276} y={y2 - 9} width="42" height="16" rx="8" fill={toneColor(b.tone)} opacity={0.12} />
                      <text x={x2 + 297} y={y2 + 3} fontSize="9" fontWeight="500" textAnchor="middle" fill={toneColor(b.tone)}>
                        {stateLabel(b.state, language)}
                      </text>
                    </g>
                  )
                })}
              </svg>
              {graphBranches.length < visibleBranches.length ? (
                <button
                  onClick={() => navigate('/branches')}
                  className="absolute bottom-2 left-4 text-[11px] font-medium text-muted transition-colors hover:text-primary"
                >
                  {tr('moreBranches').replace('N', String(visibleBranches.length - graphBranches.length))}
                </button>
              ) : null}
            </div>
          )}
        </Card>

        {/* Bottom: Repos + Notifications */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card className="p-4">
            <div className="mb-3 text-sm font-semibold text-canvas-fg">{tr('repositories')}</div>
            <div className="space-y-1.5">
              {(activeRepositoryId ? repositories.filter((r) => r.id === activeRepositoryId) : repositories).slice(0, 6).map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm transition-colors hover:border-primary/30">
                  <span className="text-canvas-fg">{r.name}</span>
                  <span className="tabular-nums text-muted">{r.totalBranches}</span>
                </div>
              ))}
              {(activeRepositoryId ? repositories.filter((r) => r.id === activeRepositoryId) : repositories).length === 0 ? (
                <div className="py-5 text-center text-sm text-muted">{tr('noRepositories')}</div>
              ) : null}
            </div>
          </Card>
          <Card className="p-4">
            <div className="mb-3 text-sm font-semibold text-canvas-fg">{tr('notifications')}</div>
            <div className="space-y-1.5">
              {visibleNotifications.slice(0, 6).map((n) => (
                <div key={n.id} className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <Badge tone={n.read ? 'default' : 'primary'}>{n.type}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-canvas-fg">{n.branch}</div>
                    <div className="text-xs text-muted">{n.message}</div>
                  </div>
                </div>
              ))}
              {visibleNotifications.length === 0 ? (
                <div className="py-5 text-center text-sm text-muted">{tr('noNotifications')}</div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}