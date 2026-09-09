import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertTriangle, CheckCircle2, FolderGit2, GitBranch, RefreshCw, Scale, Info
} from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Card } from '../components/ui'
import { timeAgo, stateLabel } from '../lib/format'
import { motion as motionToken, shadow } from '../design-system/tokens'
import type { BranchSummary, ScanRun } from '@shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function healthLabel(score: number, lang: string): string {
  if (score >= 80) return lang === 'zh' ? '健康' : 'Healthy'
  if (score >= 60) return lang === 'zh' ? '关注' : 'Attention'
  if (score >= 40) return lang === 'zh' ? '警告' : 'Warning'
  return lang === 'zh' ? '严重' : 'Critical'
}

function healthColor(score: number): string {
  if (score >= 80) return 'rgb(var(--ok))'
  if (score >= 60) return 'rgb(var(--warn))'
  if (score >= 40) return 'rgb(var(--warn))'
  return 'rgb(var(--danger))'
}

function localDayKey(value: string | Date): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function CountUp({ value, duration = 0.6 }: { value: number; duration?: number }): JSX.Element {
  const [display, setDisplay] = useState(0)
  const prev = useRef(0)
  useEffect(() => {
    const start = prev.current
    const diff = value - start
    if (diff === 0) { setDisplay(value); return }
    const startTime = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const t = Math.min((now - startTime) / (duration * 1000), 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(Math.round(start + diff * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
      else prev.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{display}</>
}

function Donut({ segments, size = 80, stroke = 9, center }: { segments: { label: string; value: number; color: string }[]; size?: number; stroke?: number; center?: React.ReactNode }): JSX.Element {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--line))" strokeWidth={stroke} opacity={0.3} />
        {total > 0 && segments.map((seg, i) => {
          const frac = seg.value / total
          const dash = frac * c
          const el = (
            <circle
              key={i}
              cx={size / 2} cy={size / 2} r={r}
              fill="none" stroke={seg.color} strokeWidth={stroke}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          )
          offset += dash
          return el
        })}
      </svg>
      {center ? <div className="absolute inset-0 flex flex-col items-center justify-center">{center}</div> : null}
    </div>
  )
}

function Sparkline({ data, color, height = 40 }: { data: Array<number | null>; color: string; height?: number }): JSX.Element {
  const numeric = data.filter((value): value is number => value != null)
  const w = 100
  const max = Math.max(...numeric, 1)
  let path = ''
  const dots: Array<{ x: number; y: number }> = []
  let penDown = false
  data.forEach((value, index) => {
    if (value == null) {
      penDown = false
      return
    }
    const x = ((index + 0.5) / data.length) * w
    const y = height - 4 - (Math.max(0, value) / max) * (height - 8)
    dots.push({ x, y })
    path += penDown ? ` L${x.toFixed(2)},${y.toFixed(2)}` : ` M${x.toFixed(2)},${y.toFixed(2)}`
    penDown = true
  })
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block">
      <line x1="0" y1={height - 4} x2={w} y2={height - 4} stroke="rgb(var(--line))" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
      {path ? (
        <motion.path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
        />
      ) : null}
      {dots.map((dot, index) => (
        <circle key={index} cx={dot.x} cy={dot.y} r="2" fill={color} />
      ))}
    </svg>
  )
}

function MiniBars({
  data,
  color,
  height = 44,
  emptyLabel,
  maxValue,
  labels = []
}: {
  data: Array<number | null>
  color: string
  height?: number
  emptyLabel?: string
  maxValue?: number
  labels?: string[]
}): JSX.Element {
  const numeric = data.filter((value): value is number => value != null)
  const max = maxValue ?? Math.max(...numeric, 1)
  if (numeric.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-line/70 text-[10px] text-muted" style={{ height }}>
        {emptyLabel ?? '--'}
      </div>
    )
  }
  return (
    <div className="flex gap-1" style={{ height }}>
      {data.map((value, index) => (
        <div key={index} className="group relative flex flex-1 flex-col justify-end">
          {value == null ? null : (
            <>
              <motion.div
                className="mx-auto w-full max-w-[14px] rounded-t-sm opacity-80 transition-opacity group-hover:opacity-100"
                style={{ background: color }}
                initial={{ height: 0 }}
                animate={{ height: Math.max(2, (Math.max(0, value) / max) * (height - 8)) }}
                transition={{ delay: index * 0.04, duration: 0.45, ease: 'easeOut' }}
              />
              {labels[index] ? (
                <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-canvas-fg opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  {labels[index]}: {value}
                </div>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Mini Chart Components ──────────────────────────────────────────────────

function ActivityChart({ branches }: { branches: BranchSummary[] }): JSX.Element {
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const contributors = useMemo(() => {
    const dayKeys = new Set<string>()
    for (let i = 0; i < 7; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      dayKeys.add(localDayKey(d))
    }
    const seenCommits = new Set<string>()
    const byAuthor = new Map<string, { name: string; count: number }>()
    for (const branch of branches) {
      for (const commit of branch.recentCommits) {
        if (!dayKeys.has(localDayKey(commit.committedAt))) continue
        const commitKey = commit.sha || `${branch.id}:${commit.committedAt}:${commit.subject}`
        if (seenCommits.has(commitKey)) continue
        seenCommits.add(commitKey)
        const name = commit.authorName || commit.authorEmail || (zh ? '未知' : 'Unknown')
        const key = (commit.authorEmail || commit.authorName || name).toLowerCase()
        const current = byAuthor.get(key) ?? { name, count: 0 }
        current.count += 1
        byAuthor.set(key, current)
      }
    }
    return [...byAuthor.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 7)
  }, [branches, zh])
  const max = Math.max(...contributors.map((c) => c.count), 1)
  const yTicks = [max, Math.ceil(max / 2), 0]
  return (
    <Card className="flex h-full flex-col p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-canvas-fg">{zh ? '分支活跃度' : 'Branch Activity'}</div>
        <div className="text-[10px] text-muted">{zh ? '近 7 天 Top 7' : 'Last 7 days Top 7'}</div>
      </div>
      {contributors.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-line/70 text-xs text-muted">
          {zh ? '近 7 天暂无提交' : 'No commits in last 7 days'}
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <div className="flex min-h-[76px] flex-1 gap-1.5">
            <div className="flex w-6 shrink-0 flex-col items-end justify-between pb-[3px] text-[9px] tabular-nums leading-none text-muted opacity-70">
              {yTicks.map((tick) => <span key={tick}>{tick}</span>)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="relative h-full min-h-[64px] border-b border-line/60">
                <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line/40" />
                <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-line/40" />
                <Sparkline data={contributors.map((c) => c.count)} color="rgb(var(--primary))" height={64} />
                <div className="absolute inset-0 flex">
                  {contributors.map((c) => (
                    <div key={c.name} className="group relative flex-1">
                      <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-canvas-fg opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                        {c.name}: {c.count}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-1 flex text-[9px] text-muted opacity-70">
            {contributors.map((c) => (
              <div key={c.name} className="min-w-0 flex-1 truncate px-0.5 text-center" title={c.name}>{c.name}</div>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[9px] text-muted opacity-70">
            <span>{zh ? 'X 轴：提交人' : 'X axis: committer'}</span>
            <span>{zh ? 'Y 轴：提交数量' : 'Y axis: commit count'}</span>
          </div>
        </div>
      )}
    </Card>
  )
}

function HealthTrendCard({ branches, current }: { branches: BranchSummary[]; runs: ScanRun[]; current: number }): JSX.Element {
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const [hoveredRisk, setHoveredRisk] = useState<string | null>(null)
  const [riskFilter, setRiskFilter] = useState<string | null>(null)
  const snapshot = useMemo(() => ({
    average: current,
    best: branches.length ? Math.max(...branches.map((b) => b.health.score)) : 0,
    worst: branches.length ? Math.min(...branches.map((b) => b.health.score)) : 0,
    active: branches.filter((b) => b.state === 'active').length,
    stale: branches.filter((b) => b.stale).length,
    expired: branches.filter((b) => b.state === 'grace_expired').length,
    invalid: branches.filter((b) => b.naming.status === 'invalid').length,
    total: branches.length
  }), [branches, current])
  const riskPoints = useMemo(() => branches
    .map((branch) => {
      const risk = clampScore(100 - branch.health.score)
      const categories = [
        branch.state === 'active' ? 'active' : null,
        // 停更是大类，包含已到宽限期的分支。
        branch.stale ? 'stale' : null,
        branch.state === 'grace_expired' ? 'expired' : null,
        branch.naming.status === 'invalid' ? 'naming' : null
      ].filter(Boolean) as string[]
      return {
        id: branch.id,
        name: branch.displayName,
        risk,
        categories,
        inactiveDays: Math.max(0, branch.inactiveDays),
        color: risk >= 60 ? 'rgb(var(--danger))' : risk >= 30 ? 'rgb(var(--warn))' : 'rgb(var(--ok))'
      }
    })
    .sort((a, b) => b.risk - a.risk || b.inactiveDays - a.inactiveDays), [branches])
  const maxInactiveDays = Math.max(14, ...riskPoints.map((p) => p.inactiveDays))
  const selectedPoints = riskFilter === null
    ? riskPoints
    : riskPoints.filter((p) => p.categories.includes(riskFilter))
  const positionFor = (point: typeof riskPoints[number], duplicateIndex = 0) => {
    const baseLeft = 4 + (point.inactiveDays / maxInactiveDays) * 92
    const baseBottom = 4 + (point.risk / 100) * 92
    // 完全相同的健康分和停更天数会互相遮住；用固定网格偏移保证每个分支点都可见。
    const duplicateOffsets = [
      [0, 0], [1, 0], [-1, 0],
      [0, 1], [1, 1], [-1, 1],
      [0, -1], [1, -1], [-1, -1]
    ]
    const [offsetX, offsetY] = duplicateOffsets[duplicateIndex % duplicateOffsets.length]
    const edgeX = baseLeft >= 80 ? -1 : 1
    const edgeY = baseBottom >= 80 ? -1 : 1
    const left = Math.min(98, Math.max(2, baseLeft + offsetX * 3.2 * edgeX))
    const bottom = Math.min(98, Math.max(2, baseBottom + offsetY * 3.8 * edgeY))
    return { left: `${left}%`, bottom: `${bottom}%` }
  }

  const hoveredPointIndex = hoveredRisk ? selectedPoints.findIndex((p) => p.id === hoveredRisk) : -1
  const labelPoint = hoveredPointIndex >= 0 ? selectedPoints[hoveredPointIndex] : null
  const labelPosition = labelPoint ? positionFor(labelPoint, hoveredPointIndex) : { left: '0%', bottom: '0%' }


  const hasBranches = snapshot.total > 0
  const metrics: Array<{ label: string; value: number | string; tone: string; key: string }> = [
    { label: zh ? '平均健康' : 'Average', value: hasBranches ? snapshot.average : '--', tone: hasBranches ? healthColor(snapshot.average) : 'rgb(var(--muted))', key: 'all' },
    { label: zh ? '最佳' : 'Best', value: hasBranches ? snapshot.best : '--', tone: hasBranches ? 'rgb(var(--ok))' : 'rgb(var(--muted))', key: 'best' },
    { label: zh ? '最差' : 'Worst', value: hasBranches ? snapshot.worst : '--', tone: hasBranches ? healthColor(snapshot.worst) : 'rgb(var(--muted))', key: 'worst' },
    { label: zh ? '分支总数' : 'Branches', value: snapshot.total, tone: 'rgb(var(--info))', key: 'total' },
    { label: zh ? '活跃' : 'Active', value: snapshot.active, tone: 'rgb(var(--ok))', key: 'active' },
    { label: zh ? '停更' : 'Stale', value: snapshot.stale, tone: 'rgb(var(--warn))', key: 'stale' },
    { label: zh ? '到期' : 'Expired', value: snapshot.expired, tone: 'rgb(var(--danger))', key: 'expired' },
    { label: zh ? '命名违规' : 'Naming', value: snapshot.invalid, tone: 'rgb(var(--danger))', key: 'naming' }
  ]
  return (
    <Card className="flex h-full flex-col p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-canvas-fg">{zh ? '分支风险分布' : 'Branch Risk Distribution'}</div>
        <div className="text-[10px] text-muted">
          {riskFilter === null ? (zh ? '全部类型' : 'All types') : (zh ? '点击其他分类切换' : 'Click another type to switch')}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {metrics.map((metric) => {
          const selectable = ['all', 'active', 'stale', 'expired', 'naming'].includes(metric.key)
          const selected = riskFilter === (metric.key === 'all' ? null : metric.key)
          return (
            <button
              key={metric.key}
              type="button"
              disabled={!selectable}
              onClick={() => selectable && setRiskFilter((current) => metric.key === 'all' ? null : current === metric.key ? null : metric.key)}
              className={`rounded-md border px-2 py-1.5 text-left transition-colors ${
                !selectable ? 'cursor-default border-line bg-surface-elevated opacity-85' :
                selected ? 'border-primary/50 bg-primary/10' : 'border-line bg-surface-elevated hover:border-primary/30'
              }`}
            >
              <div className="truncate text-[10px] text-muted">{metric.label}</div>
              <div className="mt-0.5 text-sm font-bold tabular-nums" style={{ color: metric.tone }}>{metric.value}</div>
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex flex-1 flex-col">
        {selectedPoints.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line/70 text-xs text-muted">
            {zh ? '当前筛选暂无分支' : 'No branches in this filter'}
          </div>
        ) : (
          <>
            <div className="relative min-h-[180px] flex-1 overflow-hidden rounded-lg border border-line bg-surface-elevated">
              <div className="absolute inset-0 grid grid-cols-3 grid-rows-2">
                <div className="border-r border-b border-line/50 bg-ok/5" />
                <div className="border-r border-b border-line/50 bg-warn/5" />
                <div className="border-b border-line/50 bg-danger/5" />
                <div className="border-r border-line/50 bg-ok/5" />
                <div className="border-r border-line/50 bg-warn/5" />
                <div className="bg-danger/5" />
              </div>
              <span className="absolute left-1.5 top-1.5 text-[9px] text-muted opacity-70">{zh ? '高' : 'High'}</span>
              <span className="absolute bottom-1.5 left-1.5 text-[9px] text-muted opacity-70">{zh ? '低' : 'Low'}</span>
              {labelPoint ? (
                <div
                  className="pointer-events-none absolute z-10 max-w-[220px] rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-lg"
                  style={{
                    left: `clamp(104px, ${labelPosition.left}, calc(100% - 104px))`,
                    bottom: `calc(${labelPosition.bottom} + 12px)`,
                    transform: 'translateX(-50%)'
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: labelPoint.color }} />
                    <span className="truncate text-xs font-semibold text-canvas-fg">{labelPoint.name}</span>
                  </div>
                  <div className="mt-0.5 whitespace-nowrap text-[10px] text-muted">
                    {zh ? '风险' : 'Risk'}: {labelPoint.risk} | {labelPoint.inactiveDays}{zh ? '天未更新' : 'd inactive'}
                  </div>
                </div>
              ) : null}
              {selectedPoints.map((point, pointIndex) => {
                const position = positionFor(point, pointIndex)
                return (
                  <button
                    key={point.id}
                    type="button"
                    className="absolute h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-surface shadow-sm transition-transform hover:scale-125"
                    style={{ left: position.left, bottom: position.bottom, background: point.color }}
                    onMouseEnter={() => setHoveredRisk(point.id)}
                    onMouseLeave={() => setHoveredRisk((currentId) => currentId === point.id ? null : currentId)}
                    aria-label={`${point.name}: ${point.risk}, ${point.inactiveDays}d`}
                  />
                )
              })}
            </div>
            <div className="mt-1 flex justify-between text-[9px] text-muted opacity-70">
              <span>{zh ? '最近' : 'Recent'}</span>
              <span>{zh ? '久未活动' : 'Long inactive'}</span>
            </div>
            <div className="mt-1 text-center text-[9px] text-muted opacity-70">
              {zh ? '最近活动时间' : 'Last activity time'}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}


// ─── Main ────────────────────────────────────────────────────────────────────

export default function Dashboard(): JSX.Element {
  const branches = useAppStore((s) => s.branches)
  const repositories = useAppStore((s) => s.repositories)
  const scanRuns = useAppStore((s) => s.scanRuns)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const language = useAppStore((s) => s.language)
  const refresh = useAppStore((s) => s.refresh)
  const toast = useAppStore((s) => s.toast)
  const navigate = useNavigate()
  const zh = language === 'zh'
  const [refreshing, setRefreshing] = useState(false)

  const visibleBranches = activeRepositoryId ? branches.filter((b) => b.repositoryId === activeRepositoryId) : branches
  const visibleScanRuns = useMemo(
    () => (activeRepositoryId ? scanRuns.filter((r) => r.repositoryIds?.includes(activeRepositoryId)) : scanRuns).sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt)),
    [scanRuns, activeRepositoryId]
  )
  const completedRuns = useMemo(() => visibleScanRuns.filter((r) => r.status === 'completed'), [visibleScanRuns])
  const lastRun = visibleScanRuns[0]
  const scoredBranches = visibleBranches.filter((b) => !b.protection.isDefault && !/^(main|develop)$/i.test(b.name))
  const avgHealth = scoredBranches.length ? Math.round(scoredBranches.reduce((s, b) => s + b.health.score, 0) / scoredBranches.length) : (visibleBranches.length ? 100 : 0)
  const count = useCallback((fn: (b: BranchSummary) => boolean) => visibleBranches.filter(fn).length, [visibleBranches])
  const validBranches = count((b) => b.naming.status === 'valid')
  const excludedBranches = count((b) => b.naming.status === 'excluded')
  const violations = count((b) => b.naming.status === 'invalid')
  const compliance = visibleBranches.length ? Math.round(((validBranches + excludedBranches) / visibleBranches.length) * 100) : 0
  const staleCount = count((b) => b.stale)
  const activeCount = count((b) => b.state === 'active')
  const mergedCount = count((b) => b.merged)
  const protectedCount = count((b) => b.protection.protected)
  const expiredCount = count((b) => b.state === 'grace_expired')
  const graceCount = count((b) => b.state === 'grace_period')

  const statusDistribution = [
    { label: zh ? '活跃' : 'Active', value: activeCount, color: 'rgb(var(--ok))' },
    { label: zh ? '宽限' : 'Grace', value: graceCount, color: 'rgb(var(--warn))' },
    { label: zh ? '到期' : 'Expired', value: expiredCount, color: 'rgb(var(--danger))' },
    { label: zh ? '合并' : 'Merged', value: mergedCount, color: 'rgb(var(--secondary))' }
  ].filter((x) => x.value > 0)

  const alerts = useMemo(() => {
    const list: { severity: 'warn' | 'danger' | 'info'; title: string; desc: string; to: string }[] = []
    if (violations > 0) list.push({ severity: 'danger', title: `${violations} ${zh ? '命名违规' : 'Naming Violations'}`, desc: zh ? '分支命名不符合规则' : 'Branches fail naming rules', to: '/naming-rules' })
    if (staleCount > 0) list.push({ severity: 'warn', title: `${staleCount} ${zh ? '已停更分支' : 'Stale Branches'}`, desc: zh ? '超过阈值未更新' : 'Beyond stale threshold', to: '/branches' })
    if (expiredCount > 0) list.push({ severity: 'danger', title: `${expiredCount} ${zh ? '宽限到期' : 'Grace Expired'}`, desc: zh ? '需要处理' : 'Requires action', to: '/branches' })
    if (!lastRun) list.push({ severity: 'info', title: zh ? '仓库未巡检' : 'Repository Not Scanned', desc: zh ? '运行第一次巡检' : 'Run first inspection', to: '/monitoring' })
    return list
  }, [violations, staleCount, expiredCount, lastRun, zh])

  const attention = useMemo(() =>
    visibleBranches
      .filter((b) => b.stale || b.naming.status === 'invalid' || b.state === 'grace_expired')
      .sort((a, b) => b.inactiveDays - a.inactiveDays)
      .slice(0, 5),
    [visibleBranches]
  )

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refresh()
    } catch {
      toast(zh ? '无法刷新仪表盘' : 'Unable to refresh dashboard', 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const compactMetrics = [
    { label: tr('repositories'), value: repositories.length, icon: FolderGit2, to: '/repositories', tone: 'text-muted' },
    { label: tr('totalBranches'), value: visibleBranches.length, icon: GitBranch, to: '/branches', tone: 'text-muted' },
    { label: tr('namingCompliance'), value: `${compliance}%`, icon: Scale, to: '/naming-rules', tone: compliance >= 90 ? 'text-ok' : compliance >= 70 ? 'text-warn' : 'text-danger' },
  ]

  return (
    <div className="space-y-3">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('dashboard')}</h1>
          <p className="mt-0.5 text-xs text-muted">{zh ? '监控和管理您的 Git 仓库与分支健康状态' : 'Monitor and manage your Git repositories and branch health'}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          {lastRun ? (
            <div className="flex items-center gap-1.5">
              <span>{tr('lastCheck')}: {timeAgo(lastRun.finishedAt)}</span>
              <span className={`h-1.5 w-1.5 rounded-full ${lastRun.status === 'completed' ? 'bg-ok' : lastRun.status === 'failed' ? 'bg-danger' : 'bg-warn'}`} />
              <span className={lastRun.status === 'completed' ? 'text-ok' : lastRun.status === 'failed' ? 'text-danger' : 'text-warn'}>
                {lastRun.status === 'completed' ? (zh ? '正常' : 'OK') : lastRun.status}
              </span>
            </div>
          ) : null}
          <button
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-canvas-fg disabled:opacity-40"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            {zh ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ─── Layer 1: Health Summary ───────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {/* Primary Health Card */}
        <motion.div
          className="col-span-2 flex items-center gap-5 rounded-card border border-line bg-surface p-4 md:col-span-2"
          style={{ boxShadow: shadow.md }}
          whileHover={{ translateY: -1 }}
          transition={{ duration: 0.15 }}
        >
          <div className="relative inline-flex items-center justify-center" style={{ width: 84, height: 84 }}>
            <svg width="84" height="84" className="-rotate-90">
              <circle cx="42" cy="42" r="36" fill="none" stroke="rgb(var(--line))" strokeWidth="7" opacity={0.4} />
              <motion.circle
                cx="42" cy="42" r="36"
                fill="none"
                stroke={healthColor(avgHealth)}
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 36}
                initial={{ strokeDashoffset: 2 * Math.PI * 36 }}
                animate={{ strokeDashoffset: 2 * Math.PI * 36 * (1 - avgHealth / 100) }}
                transition={{ duration: 0.7, ease: 'easeOut' }}
              />
            </svg>
            <div className="absolute text-center">
              <div className="text-2xl font-bold tabular-nums" style={{ color: healthColor(avgHealth) }}>
                <CountUp value={avgHealth} />
              </div>
              <div className="text-[9px] text-muted opacity-70">/100</div>
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{zh ? '整体健康度' : 'Overall Health'}</div>
            <div className="mt-0.5 text-lg font-semibold" style={{ color: healthColor(avgHealth) }}>{healthLabel(avgHealth, language)}</div>
            <div className="mt-0.5 text-[10px] text-muted">{zh ? '基于分支健康评分平均值' : 'Average of branch health scores'}</div>
          </div>
        </motion.div>

        {/* Compact Metrics */}
        {compactMetrics.map((m, i) => {
          const Icon = m.icon
          return (
            <motion.button
              key={m.label}
              onClick={() => navigate(m.to)}
              className="flex flex-col justify-between rounded-card border border-line bg-surface p-3.5 text-left transition-colors hover:border-primary/30"
              style={{ boxShadow: shadow.sm }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i, duration: motionToken.fast.duration }}
              whileHover={{ translateY: -1 }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{m.label}</span>
                <Icon size={15} className={`${m.tone} opacity-60`} />
              </div>
              <div className={`mt-1.5 text-xl font-bold tabular-nums ${m.tone}`}>
                {typeof m.value === 'number' ? <CountUp value={m.value} /> : m.value}
              </div>
            </motion.button>
          )
        })}
      </div>

      {/* ─── Status Summary Bar ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5" style={{ boxShadow: shadow.sm }}>
        {[
          { label: tr('active'), value: activeCount, color: 'rgb(var(--ok))' },
          { label: tr('gracePeriod'), value: graceCount, color: 'rgb(var(--warn))' },
          { label: tr('graceExpired'), value: expiredCount, color: 'rgb(var(--danger))' },
          { label: tr('merged'), value: mergedCount, color: 'rgb(var(--secondary))' },
          { label: tr('namingViolations'), value: violations, color: 'rgb(var(--danger))' },
          { label: tr('protectedBranches'), value: protectedCount, color: 'rgb(var(--info))' }
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            <span className="text-muted">{s.label}</span>
            <span className="font-semibold tabular-nums text-canvas-fg">{s.value}</span>
          </div>
        ))}
      </div>

      {/* ─── Layer 2: Activity rail + Health Trend ──────────────── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {/* Left rail: Activity → Naming Compliance → Status Distribution */}
        <div className="flex h-full min-w-0 flex-col gap-3 md:col-span-1">
          <div className="w-full">
            <ActivityChart branches={visibleBranches} />
          </div>

          {/* Compliance Donut */}
          <Card className="p-3.5">
            <div className="mb-2 text-sm font-semibold text-canvas-fg">{tr('namingCompliance')}</div>
            <div className="flex items-center gap-3">
              <Donut
                size={76} stroke={8}
                segments={[
                  { label: 'valid', value: validBranches + excludedBranches, color: 'rgb(var(--ok))' },
                  { label: 'invalid', value: violations, color: 'rgb(var(--danger))' }
                ]}
                center={
                  <div className="text-center">
                    <div className="text-sm font-bold tabular-nums text-canvas-fg">{compliance}%</div>
                  </div>
                }
              />
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-ok" />
                  <span className="text-muted">{zh ? '合规' : 'Compliant'}</span>
                  <span className="ml-auto font-semibold tabular-nums">{validBranches + excludedBranches}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-danger" />
                  <span className="text-muted">{zh ? '违规' : 'Violations'}</span>
                  <span className="ml-auto font-semibold tabular-nums">{violations}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-info" />
                  <span className="text-muted">{zh ? '排除' : 'Excluded'}</span>
                  <span className="ml-auto font-semibold tabular-nums">{excludedBranches}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* Status Distribution Donut */}
          <Card className="p-3.5">
            <div className="mb-2 text-sm font-semibold text-canvas-fg">{zh ? '分支状态分布' : 'Branch Status'}</div>
            {statusDistribution.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-xs text-muted">{tr('noBranches')}</div>
            ) : (
              <div className="flex items-center gap-3">
                <Donut
                  size={76} stroke={8}
                  segments={statusDistribution}
                  center={
                    <div className="text-center">
                      <div className="text-sm font-bold tabular-nums text-canvas-fg">{visibleBranches.length}</div>
                      <div className="text-[8px] text-muted">{zh ? '总数' : 'Total'}</div>
                    </div>
                  }
                />
                <div className="flex-1 space-y-1 text-xs">
                  {statusDistribution.map((s) => (
                    <div key={s.label} className="flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                      <span className="truncate text-muted">{s.label}</span>
                      <span className="ml-auto font-semibold tabular-nums">{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Health Trend */}
        <div className="h-full md:col-span-2">
          <HealthTrendCard branches={visibleBranches} runs={completedRuns} current={avgHealth} />
        </div>
      </div>

      {/* ─── Recent Inspections + Attention Required ───────────── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {/* Recent Inspections */}
        <Card className={`order-2 p-3.5 ${attention.length > 0 ? '' : 'md:col-span-2 xl:col-span-3'}`}>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-canvas-fg">{zh ? '最近巡检' : 'Recent Inspections'}</div>
            <button onClick={() => navigate('/monitoring')} className="text-[10px] font-medium text-primary hover:underline">{tr('viewAll')}</button>
          </div>
          {visibleScanRuns.length === 0 ? (
            <div className="py-5 text-center text-xs text-muted">{zh ? '暂无巡检记录' : 'No inspections yet'}</div>
          ) : (
            <div className="space-y-1.5">
              {visibleScanRuns.slice(0, 3).map((r) => (
                <div key={r.id} className="flex items-center gap-2.5 rounded-md border border-line px-2.5 py-1.5 text-xs">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.status === 'completed' ? 'bg-ok' : r.status === 'failed' ? 'bg-danger' : 'bg-warn'}`} />
                  <span className="tabular-nums text-muted">{new Date(r.finishedAt ?? r.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="truncate text-canvas-fg">{r.branches} {zh ? '分支' : 'branches'}</span>
                  {r.namingInvalid > 0 ? <span className="ml-auto shrink-0 font-medium text-danger">{r.namingInvalid} {zh ? '违规' : 'issues'}</span> : <span className="ml-auto shrink-0 text-ok">✓</span>}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Attention Required */}
        {attention.length > 0 ? (
          <Card className="order-1 p-3.5 md:col-span-1 xl:col-span-2">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle size={15} className="text-warn" />
              <span className="text-sm font-semibold text-canvas-fg">{zh ? '需要关注' : 'Attention Required'}</span>
              <span className="rounded-full bg-warn/10 px-1.5 text-[10px] font-semibold text-warn">{attention.length}</span>
            </div>
            <div className="max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
              {attention.map((b) => (
                <button
                  key={b.id}
                  onClick={() => navigate(`/branches/${b.repositoryId}/${b.type}/${encodeURIComponent(b.name.replaceAll('/', '~'))}`)}
                  className="flex w-full items-center gap-3 rounded-md border border-line px-3 py-2 text-left text-sm transition-colors hover:border-warn/40"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.state === 'grace_expired' ? 'bg-danger' : b.stale ? 'bg-warn' : 'bg-danger'}`} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-canvas-fg">{b.displayName}</span>
                  <span className="shrink-0 text-xs text-muted">{b.inactiveDays}d</span>
                  <span className={`shrink-0 text-xs font-medium ${b.naming.status === 'invalid' ? 'text-danger' : b.state === 'grace_expired' ? 'text-danger' : 'text-warn'}`}>
                    {b.naming.status === 'invalid' ? (zh ? '命名违规' : 'Violation') : stateLabel(b.state, language)}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      {/* ─── Active Alerts ──────────────────────────────────────── */}
      <div>
        <Card className="p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <Info size={15} className="text-info" />
            <span className="text-sm font-semibold text-canvas-fg">{zh ? '活跃提醒' : 'Active Alerts'}</span>
          </div>
          {alerts.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-ok/20 bg-ok/5 px-3 py-2 text-xs text-ok">
              <CheckCircle2 size={14} />
              <span>{zh ? '一切正常，无需处理。' : 'Everything looks good.'}</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {alerts.map((a, i) => (
                <button
                  key={i}
                  onClick={() => navigate(a.to)}
                  className={`flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors ${
                    a.severity === 'danger' ? 'border-danger/20 bg-danger/5 hover:border-danger/40' :
                    a.severity === 'warn' ? 'border-warn/20 bg-warn/5 hover:border-warn/40' :
                    'border-info/20 bg-info/5 hover:border-info/40'
                  }`}
                >
                  {a.severity === 'danger' ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" /> :
                   a.severity === 'warn' ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" /> :
                   <Info size={14} className="mt-0.5 shrink-0 text-info" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-canvas-fg">{a.title}</div>
                    <div className="text-[10px] text-muted">{a.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

      </div>

      {/* ─── Repository Overview (compact, only if repo exists) ── */}
      {(activeRepositoryId ? repositories.filter((r) => r.id === activeRepositoryId) : repositories).length > 0 ? (
        <Card className="p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-canvas-fg">{tr('repositories')}</div>
            <button onClick={() => navigate('/repositories')} className="text-[10px] font-medium text-primary hover:underline">{tr('viewAll')}</button>
          </div>
          <div className="space-y-1.5">
            {(activeRepositoryId ? repositories.filter((r) => r.id === activeRepositoryId) : repositories).slice(0, 4).map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm">
                <FolderGit2 size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-canvas-fg">{r.name}</span>
                <span className="shrink-0 text-xs uppercase text-muted opacity-70">{r.source}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{r.totalBranches} {zh ? '分支' : 'br'}</span>
                {r.lastScanAt ? <span className="shrink-0 text-[10px] text-muted opacity-60">{timeAgo(r.lastScanAt)}</span> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}
