import { useEffect, useId, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Activity, CalendarDays, Download, FileCode, FileDiff, GitMerge, GitBranch, FileText
} from 'lucide-react'
import type { PersonalActivity } from '@shared/types'
import { readMyActivityMonths, saveMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'
import { Link, useNavigate } from 'react-router-dom'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const ALL_BRANCHES = (branch: NonNullable<PersonalActivity['branches']>[number]) => true
const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee', local: 'Local' } as const

function downloadReview(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function buildReview(data: PersonalActivity, months: number, zh: boolean): string {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1)
  const range = `${start.toLocaleDateString()} - ${now.toLocaleDateString()}`
  const topPaths = data.stats.topFiles.slice(0, 8)
  const projects = data.stats.byRepository
  const commitLines = data.commits.slice(0, 30).map((commit) => `- ${commit.committedAt.slice(0, 10)} | ${commit.repositoryName} | ${commit.subject}`)
  const mrLines = data.mergeRequests.slice(0, 30).map((mr) => `- ${mr.repositoryName} | ${mr.title} | ${mr.state} | ${mr.role}`)
  const projectLines = projects.map((repo) => `- ${repo.repositoryName}: ${repo.commits} commits, ${repo.activeDays} active days, +${repo.added}/-${repo.removed} lines, ${repo.mrAuthored} authored MRs, ${repo.mrReviewed} reviewed MRs`)
  const fileLines = topPaths.map((file) => `- ${file.path}: ${file.commits} commits, +${file.added}/-${file.removed}`)
  const lines = [
    `# ${zh ? '个人研发活动复盘' : 'Personal development review'}`, '',
    `> ${zh ? '统计范围' : 'Range'}: ${range} (${months} ${zh ? '个月' : 'months'})`, '',
    `## ${zh ? '工作概览（数据事实）' : 'Overview (verified data)'}`,
    `- ${zh ? '提交' : 'Commits'}: ${data.commits.length}`,
    `- ${zh ? '活跃天数' : 'Active days'}: ${data.stats.activeDays}`,
    `- ${zh ? '合并请求' : 'Merge requests'}: ${data.mergeRequests.length} (${zh ? '发起' : 'authored'} ${data.stats.mrAuthored}, ${zh ? '评审参与' : 'reviewed'} ${data.stats.mrReviewed})`,
    `- ${zh ? '代码变化' : 'Code changes'}: +${data.stats.linesAdded} / -${data.stats.linesRemoved} (${zh ? '仅为变更规模，不代表工作量' : 'change volume only, not effort'})`,
    `- ${zh ? '覆盖仓库' : 'Repositories'}: ${data.stats.repositoryCount}`, '',
    `## ${zh ? '按项目成果（数据事实）' : 'By project (verified data)'}`,
    ...(projectLines.length ? projectLines : [`- ${zh ? '该时间范围无仓库活动记录' : 'No repository activity in this range'}`]), '',
    `## ${zh ? '主要修改文件（数据事实）' : 'Files changed (verified data)'}`,
    ...(fileLines.length ? fileLines : [`- ${zh ? '文件级差异数据未获取到' : 'File-level diff data unavailable'}`]), '',
    `## ${zh ? '提交记录' : 'Commit records'}`,
    ...(commitLines.length ? commitLines : [`- ${zh ? '无提交记录' : 'No commits'}`]), '',
    `## ${zh ? '合并请求记录' : 'Merge request records'}`,
    ...(mrLines.length ? mrLines : [`- ${zh ? '无合并请求记录' : 'No merge requests'}`]), '',
    `## ${zh ? '尚未完成事项' : 'Open work'}`,
    `- ${zh ? 'Git 活动数据不能可靠判断事项是否完成；请结合未合并 MR 与项目计划人工确认。' : 'Git activity alone cannot establish completion; review open MRs and project plans.'}`, '',
    `## ${zh ? '工作内容归纳（基于提交描述的整理，不是独立验证的事实）' : 'Narrative (organized from commit descriptions, not independently verified)'}`,
    `- ${data.commits.slice(0, 12).map((commit) => commit.subject).filter(Boolean).join('；') || (zh ? '暂无足够提交描述供归纳。' : 'Not enough commit descriptions to summarize.')}`,
    '', `> ${zh ? '本报告直接汇总已获取的 Git 记录；代码行数不用于推断投入或工作量。' : 'This report summarizes fetched Git records; line counts are not used as a proxy for effort.'}`
  ]
  return lines.join('\n')
}

function reviewHtml(markdown: string): string {
  const html = markdown.split('\n').map((line) => {
    if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`
    if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`
    if (line.startsWith('> ')) return `<blockquote>${escapeHtml(line.slice(2))}</blockquote>`
    if (line.startsWith('- ')) return `<li>${escapeHtml(line.slice(2))}</li>`
    return line ? `<p>${escapeHtml(line)}</p>` : ''
  }).join('\n').replace(/(?:<li>.*<\/li>\n?)+/g, (list) => `<ul>${list}</ul>`)
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>个人研发复盘</title><style>body{max-width:900px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui;color:#20242a}h1,h2{line-height:1.3}li{margin:.3em 0}blockquote{border-left:3px solid #1683d8;padding-left:12px;color:#555}</style><body>${html}</body></html>`
}

function localMonth(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

type ActivitySeries = { name: string; values: number[]; color: string; axis?: 'left' | 'right' }

function smoothChartPath(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return ''
  let path = `M ${points[0]!.x} ${points[0]!.y}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const midX = (previous.x + current.x) / 2
    path += ` C ${midX} ${previous.y}, ${midX} ${current.y}, ${current.x} ${current.y}`
  }
  return path
}

function ActivityChart({ title, labels, series, xLabel, yLabel, zh, onSelect }: {
  title: string; labels: string[]; series: ActivitySeries[]; xLabel: string; yLabel: string; zh: boolean; onSelect?: (label: string, index: number) => void
}): JSX.Element {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [hidden, setHidden] = useState<string[]>([])
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [hoverSeries, setHoverSeries] = useState<string | null>(null)
  const count = labels.length
  const visible = series.filter((entry) => !hidden.includes(entry.name))
  const width = 600
  const height = 196
  const padX = 46
  const padTop = 30
  const padBottom = 32
  const leftMax = Math.max(1, ...series.filter((entry) => entry.axis !== 'right').flatMap((entry) => entry.values))
  const rightMax = Math.max(1, ...series.filter((entry) => entry.axis === 'right').flatMap((entry) => entry.values))
  const pointX = (index: number) => count <= 1 ? width / 2 : padX + (index / (count - 1)) * (width - padX * 2)
  const pointY = (value: number, axis: 'left' | 'right') => height - padBottom - (value / (axis === 'right' ? rightMax : leftMax)) * (height - padTop - padBottom)
  const total = (entry: ActivitySeries) => entry.values.reduce((sum, value) => sum + value, 0)
  const headlineSeries = visible[0]
  const headlineValue = headlineSeries ? (hoverIndex === null ? total(headlineSeries) : headlineSeries.values[hoverIndex] ?? 0) : 0
  const activeLabel = hoverIndex === null ? null : labels[hoverIndex] ?? null
  const dimmed = (name: string) => hoverSeries !== null && hoverSeries !== name
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-canvas-fg">{title}</div>
          <div className="mt-0.5 text-[10px] text-muted">{yLabel}</div>
        </div>
        <div className="flex gap-1.5 pt-1" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
          <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
          <span className="h-2 w-2 rounded-full bg-[#28c840]" />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] text-muted">{activeLabel ?? (zh ? '总计' : 'Total')}</div>
          <div className="text-2xl font-semibold leading-tight text-canvas-fg">{headlineValue}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {series.map((entry) => {
            const off = hidden.includes(entry.name)
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => setHidden((current) => current.includes(entry.name) ? current.filter((name) => name !== entry.name) : [...current, entry.name])}
                onMouseEnter={() => setHoverSeries(entry.name)}
                onMouseLeave={() => setHoverSeries(null)}
                className={`flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10px] transition-all ${off ? 'opacity-40' : 'bg-elevated text-canvas-fg hover:border-primary/40'}`}
                title={off ? (zh ? '点击显示' : 'Click to show') : (zh ? '点击隐藏' : 'Click to hide')}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                <span>{entry.name}</span>
                <b className="font-semibold">{hoverIndex === null ? total(entry) : entry.values[hoverIndex] ?? 0}</b>
              </button>
            )
          })}
        </div>
      </div>
      <div className="mt-4 text-muted">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full overflow-visible" role="img" aria-label={title} onMouseLeave={() => setHoverIndex(null)}>
          <defs>
            {series.map((entry) => (
              <linearGradient key={entry.name} id={`${gradientId}-${entry.name}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={entry.color} stopOpacity="0.32" />
                <stop offset="100%" stopColor={entry.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {[0, 0.5, 1].map((fraction) => {
            const y = padTop + fraction * (height - padTop - padBottom)
            const leftValue = Math.round(leftMax * (1 - fraction))
            const hasRight = series.some((entry) => entry.axis === 'right')
            return (
              <g key={fraction}>
                <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="currentColor" opacity={fraction === 1 ? 0.22 : 0.12} />
                <text x={padX - 8} y={y + 3} textAnchor="end" fontSize="9" fill="currentColor" opacity="0.65">{leftValue}</text>
                {hasRight ? <text x={width - padX + 8} y={y + 3} fontSize="9" fill="currentColor" opacity="0.65">{Math.round(rightMax * (1 - fraction))}</text> : null}
              </g>
            )
          })}
          {hoverIndex !== null ? <line x1={pointX(hoverIndex)} y1={padTop - 8} x2={pointX(hoverIndex)} y2={height - padBottom} stroke="#0788ff" strokeDasharray="3 4" opacity="0.45" /> : null}
          {count === 0 ? <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="12" fill="currentColor" opacity="0.5">{zh ? '暂无数据' : 'No data'}</text> : null}
          {visible.map((entry) => {
            const axis = entry.axis ?? 'left'
            const points = labels.map((_, index) => ({ x: pointX(index), y: pointY(entry.values[index] ?? 0, axis) }))
            const line = smoothChartPath(points)
            const last = points[points.length - 1]
            const first = points[0]
            const area = last && first ? `${line} L ${last.x} ${height - padBottom} L ${first.x} ${height - padBottom} Z` : ''
            return (
              <g key={entry.name} style={{ transition: 'opacity .2s ease' }} opacity={dimmed(entry.name) ? 0.22 : 1}>
                {area ? <motion.path d={area} fill={`url(#${gradientId}-${entry.name})`} initial={{ opacity: 0 }} animate={{ opacity: dimmed(entry.name) ? 0.1 : 1 }} transition={{ duration: 0.6, ease: 'easeOut' }} /> : null}
                {line ? <motion.path d={line} fill="none" stroke={entry.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: 'easeOut' }} /> : null}
                {points.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.x}
                    cy={point.y}
                    r={hoverIndex === index ? 4.5 : 2.5}
                    fill={entry.color}
                    stroke="white"
                    strokeWidth={hoverIndex === index ? 2 : 0}
                    style={{ transition: 'r .15s ease' }}
                  />
                ))}
                {count <= 8 ? points.map((point, index) => (
                  <text key={`label-${index}`} x={point.x} y={point.y - 10} textAnchor="middle" fontSize="10" fill="currentColor" opacity={hoverIndex === null || hoverIndex === index ? 0.85 : 0.3}>
                    {entry.values[index] ?? 0}
                  </text>
                )) : null}
              </g>
            )
          })}
          {labels.map((label, index) => {
            const band = count > 1 ? (width - padX * 2) / (count - 1) : width
            const x = Math.max(0, pointX(index) - band / 2)
            return (
              <g key={label}>
                <text x={pointX(index)} y={height - 10} textAnchor="middle" fontSize="9" fill="currentColor" opacity={hoverIndex === index ? 0.95 : 0.6}>{label}</text>
                <rect
                  x={x}
                  y={padTop - 12}
                  width={band}
                  height={height - padTop - padBottom + 24}
                  fill="transparent"
                  className={onSelect ? 'cursor-pointer' : undefined}
                  onMouseEnter={() => setHoverIndex(index)}
                  onClick={() => onSelect?.(label, index)}
                />
              </g>
            )
          })}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted">
        <span>{zh ? '左轴 / 右轴为对应序列刻度' : 'Left / right axes scale their series'}</span>
        <span>{xLabel}{onSelect ? (zh ? ' · 点击图表下钻明细' : ' · Click to drill down') : ''}</span>
      </div>
    </Card>
  )
}

function ActivityLineChart({ values, onSelect, zh }: { values: number[]; onSelect: (index: number) => void; zh: boolean }): JSX.Element {
  const [period, setPeriod] = useState<24 | 12 | 6>(24)
  const [active, setActive] = useState<number | null>(null)
  const start = 24 - period
  const visible = values.slice(start)
  const max = Math.max(1, ...visible)
  const points = visible.map((value, index) => ({ x: 14 + (index / Math.max(visible.length - 1, 1)) * 272, y: 88 - (value / max) * 70, value }))
  const smooth = smoothChartPath(points)
  const selected = active === null ? null : points[active]
  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: 'easeOut' }}>
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-canvas-fg">{zh ? '按小时提交趋势' : 'Commit activity by hour'}</div>
        <div className="mt-0.5 text-[10px] text-muted">{zh ? '本地时间' : 'Local time'}</div>
      </div>
      <div className="flex gap-1 rounded-full border border-line bg-elevated p-0.5">{([6, 12, 24] as const).map((hours) => <button key={hours} className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${period === hours ? 'bg-surface text-canvas-fg shadow-sm' : 'text-muted hover:text-canvas-fg'}`} onClick={() => { setPeriod(hours); setActive(null) }}>{hours === 24 ? (zh ? '24时' : '24h') : `${hours}${zh ? '时' : 'h'}`}</button>)}</div>
    </div>
    <div className="flex items-end justify-between gap-3">
      <motion.div key={selected ? `${active}` : 'total'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <div className="text-2xl font-bold leading-none text-canvas-fg">{selected?.value ?? visible.reduce((sum, value) => sum + value, 0)}<span className="ml-1 text-xs font-normal text-muted">{zh ? '次' : 'commits'}</span></div>
        <div className="mt-1 text-[11px] text-primary">{selected ? `${start + (active ?? 0)}:00` : (zh ? '所选时段总计' : 'Selected period total')}</div>
      </motion.div>
      <span className="text-[10px] text-muted">{zh ? '提交次数' : 'Commits'}</span>
    </div>
    <div className="mt-4 h-28">
      <svg viewBox="0 0 300 96" className="h-full w-full overflow-visible" role="img" aria-label={zh ? '按小时提交趋势' : 'Commits by hour'} onMouseLeave={() => setActive(null)}>
        <defs><linearGradient id="activityLine" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stopColor="#79caff" /><stop offset="100%" stopColor="#0788ff" /></linearGradient></defs>
        <line x1="14" y1="90" x2="286" y2="90" stroke="currentColor" opacity=".1" strokeDasharray="4 4" />
        <motion.path d={smooth} fill="none" stroke="url(#activityLine)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: 'easeInOut' }} />
        {points.map((point, index) => <g key={index} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => onSelect(start + index)} tabIndex={0} role="button" aria-label={`${start + index}:00 ${point.value}`} className="cursor-pointer">
          <circle cx={point.x} cy={point.y} r="10" fill="transparent" />
          {active === index ? <motion.circle initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.18 }} style={{ originX: `${point.x}px`, originY: `${point.y}px` }} cx={point.x} cy={point.y} r="5" fill="#0788ff" stroke="white" strokeWidth="2" /> : null}
          {index === points.length - 1 && active === null ? <motion.circle cx={point.x} cy={point.y} r="4" fill="#0788ff" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.05, duration: 0.2 }} /> : null}
        </g>)}
      </svg>
    </div>
    <div className="mt-2 flex justify-between text-[10px] text-muted"><span>{start}:00</span><span>{start + Math.floor(period / 2)}:00</span><span>23:00</span></div>
  </motion.div>
}

export default function MyActivity(): JSX.Element {
  const toast = useAppStore((s) => s.toast)
  const language = useAppStore((s) => s.language)
  const session = useAppStore((s) => s.session)
  const activityCache = useAppStore((s) => s.myActivityCache)
  const busy = useAppStore((s) => s.myActivityBusy)
  const loadMyActivity = useAppStore((s) => s.loadMyActivity)
  const navigate = useNavigate()
  const zh = language === 'zh'
  const [months, setMonths] = useState<number>(() => readMyActivityMonths(session))
  const cacheKey = `${session?.email.toLowerCase() ?? ''}|${session?.source ?? ''}|${session?.accountId ?? session?.username.toLowerCase() ?? ''}|${months}`
  const data = activityCache[cacheKey] ?? null
  const [mrTab, setMrTab] = useState<'authored' | 'pending' | 'participated' | 'done'>('authored')
  const [drilldown, setDrilldown] = useState<'all' | 'commits' | 'mergeRequests' | null>(null)
  const [review, setReview] = useState('')
  const [commitFilter, setCommitFilter] = useState<(commit: PersonalActivity['commits'][number]) => boolean>(() => () => true)
  const [showBranches, setShowBranches] = useState(false)
  const [branchFilter, setBranchFilter] = useState<(branch: NonNullable<PersonalActivity['branches']>[number]) => boolean>(() => ALL_BRANCHES)
  const showCommits = (filter?: (commit: PersonalActivity['commits'][number]) => boolean): void => {
    setCommitFilter(() => filter ?? (() => true))
    setDrilldown('commits')
  }

  useEffect(() => {
    void loadMyActivity(months).catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
  }, [months, session?.email, session?.source, loadMyActivity, toast])

  useEffect(() => {
    saveMyActivityMonths(session, months)
  }, [months, session])

  const stats = data?.stats
  const detailBySha = useMemo(() => {
    const map = new Map<string, PersonalActivity['commitDetails'][number]>()
    for (const detail of data?.commitDetails ?? []) {
      map.set(`${detail.repositoryId}:${detail.sha}`, detail)
    }
    return map
  }, [data])
  // Keep every chart visible when activity data exists so sparse months and
  // quiet weekdays still provide context instead of silently disappearing.
  const showMonthlyCommits = Boolean(stats)
  const showMonthlyLines = Boolean(stats)
  const showWeekdays = Boolean(stats)
  const showHours = Boolean(stats)
  const visibleMergeRequests = (data?.mergeRequests ?? []).filter((mr) => {
    const done = ['merged', 'closed'].includes(mr.state.toLowerCase())
    if (mrTab === 'done') return done
    if (done) return false
    if (mrTab === 'authored') return mr.role === 'author'
    if (mrTab === 'pending') return mr.role === 'pending-reviewer'
    return mr.role === 'reviewer'
  })
  const filteredCommits = (data?.commits ?? []).filter(commitFilter)
  const filteredBranches = (data?.branches ?? []).filter(branchFilter)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{zh ? '个人活动' : 'My Activity'}</h1>
          <p className="mt-0.5 text-xs text-muted">{zh ? '提交、代码增删、分支与多维复盘' : 'Commits, code changes, branches and review stats'}</p>
        </div>
        <div className="flex gap-2">
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="rounded-md border border-line bg-elevated px-3 py-1.5 text-sm text-canvas-fg outline-none transition-colors focus:border-primary/50"
            title={zh ? '选择统计时间范围' : 'Choose activity range'}
          >
            {[1, 3, 6, 12, 24, 36].map((value) => (
              <option key={value} value={value}>
                {value === 1 ? (zh ? '最近 1 个月' : 'Last 1 month')
                  : value === 3 ? (zh ? '最近 3 个月' : 'Last 3 months')
                  : value === 6 ? (zh ? '最近半年' : 'Last 6 months')
                  : value === 12 ? (zh ? '最近一年' : 'Last 12 months')
                  : value === 24 ? (zh ? '最近两年' : 'Last 24 months')
                  : (zh ? '最近三年' : 'Last 36 months')}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy} onClick={() => void loadMyActivity(months, true).catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))}>
            <Activity size={14} /> {zh ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <button className="text-left" onClick={() => setShowBranches(!showBranches)} aria-label={zh ? '查看创建的分支' : 'Show created branches'}><Card className={`p-3 ${showBranches ? 'border-primary' : ''}`}>
          <div className="flex items-center gap-2 text-xs text-muted"><GitBranch size={14} /> {zh ? '创建分支' : 'Branches'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.branchCount ?? 0}</div>
        </Card></button>
        <button className="text-left" onClick={() => showCommits()} aria-label={zh ? '查看提交明细' : 'Show commits'}><Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><CalendarDays size={14} /> {zh ? '活跃天数' : 'Active days'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.activeDays ?? 0}</div>
        </Card></button>
        <button className="text-left" onClick={() => showCommits((commit) => Boolean(detailBySha.get(`${commit.repositoryId}:${commit.sha}`)))}><Card className="p-3">
          <div className="text-xs text-muted">{zh ? '代码净变化' : 'Net code change'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.netLines ?? 0}<span className="ml-1 text-xs font-normal text-muted">(+{stats?.linesAdded ?? 0} / -{stats?.linesRemoved ?? 0})</span></div>
        </Card></button>
        <button className="text-left" onClick={() => { setMrTab('authored'); setDrilldown(drilldown === 'mergeRequests' ? null : 'mergeRequests') }}><Card className={`p-3 ${drilldown === 'mergeRequests' ? 'border-primary' : ''}`}>
          <div className="flex items-center gap-2 text-xs text-muted"><GitMerge size={14} /> {zh ? '合并请求数' : 'Merge requests'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{data?.mergeRequests.length ?? 0}</div>
        </Card></button>
      </div>

      {showBranches ? <section className="space-y-2 border-b border-line pb-4">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{zh ? '创建的分支（当前已收录分支）' : 'Created branches (currently tracked)'}</h2>{branchFilter !== ALL_BRANCHES ? <button className="text-xs text-primary" onClick={() => setBranchFilter(() => ALL_BRANCHES)}>{zh ? '清除筛选' : 'Clear filter'}</button> : null}</div>
        {filteredBranches.length ? filteredBranches.map((branch) => <Link key={`${branch.repositoryId}:${branch.type}:${branch.name}`} to={`/branches/${encodeURIComponent(branch.repositoryId)}/${encodeURIComponent(branch.type)}/${encodeURIComponent(branch.name)}`} className="flex flex-wrap justify-between gap-2 border-b border-line py-2 text-xs text-primary">
          <span>{branch.repositoryName} / {branch.name}</span><span className="text-muted">{branch.createdAt ? new Date(branch.createdAt).toLocaleString() : (zh ? '创建时间未知' : 'Unknown creation date')}</span>
        </Link>) : <div className="text-xs text-muted">{zh ? '暂无已收录分支' : 'No tracked branches'}</div>}
      </section> : null}
      {stats && stats.diffsFailed > 0 ? <div role="status" className="text-sm text-danger">{zh ? `${stats.diffsLoaded} 个提交差异已加载，${stats.diffsFailed} 个获取失败；代码行数及文件统计不完整。` : `${stats.diffsLoaded} diffs loaded, ${stats.diffsFailed} failed; line and file statistics are incomplete.`}</div> : null}

      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr))]">
        {showMonthlyCommits ? <ActivityChart
          title={zh ? '按月提交与分支' : 'Monthly commits and branches'}
          zh={zh}
          labels={stats?.months.map((m) => m.month) ?? []}
          xLabel={zh ? '月份' : 'Month'}
          yLabel={zh ? '数量（次 / 个）' : 'Count'}
          onSelect={(month: string) => { setBranchFilter(() => (branch: NonNullable<PersonalActivity['branches']>[number]) => localMonth(branch.createdAt ?? '') === month); setShowBranches(true); setDrilldown('commits'); setCommitFilter(() => (commit: PersonalActivity['commits'][number]) => localMonth(commit.committedAt) === month) }}
          series={[
            { name: zh ? '提交' : 'Commits', color: 'rgb(var(--primary))', values: stats?.months.map((m) => m.commits) ?? [] },
            { name: zh ? '分支' : 'Branches', color: 'rgb(var(--secondary))', values: stats?.months.map((m) => m.branches) ?? [] }
          ]}
        /> : null}
        {showMonthlyLines ? <ActivityChart
          title={zh ? '按月代码增删' : 'Monthly code changes'}
          zh={zh}
          labels={stats?.monthlyLines.map((m) => m.month) ?? []}
          xLabel={zh ? '月份' : 'Month'}
          yLabel={zh ? '代码行数（行）' : 'Lines'}
          onSelect={(month) => showCommits((commit) => localMonth(commit.committedAt) === month && Boolean(detailBySha.get(`${commit.repositoryId}:${commit.sha}`)))}
          series={[
            { name: zh ? '新增' : 'Added', color: 'rgb(var(--ok))', values: stats?.monthlyLines.map((m) => m.added) ?? [] },
            { name: zh ? '删除' : 'Removed', color: 'rgb(var(--danger))', values: stats?.monthlyLines.map((m) => m.removed) ?? [] }
          ]}
        /> : null}
      </div>

      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr))]">
        {showWeekdays ? <ActivityChart
          title={zh ? '按星期分布' : 'By weekday'}
          zh={zh}
          labels={zh ? WEEKDAY_LABELS : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']}
          xLabel={zh ? '星期（本地时间）' : 'Weekday (local time)'}
          yLabel={zh ? '提交次数' : 'Commits'}
          onSelect={(_, index) => showCommits((commit) => new Date(commit.committedAt).getDay() === index)}
          series={[{ name: zh ? '提交' : 'Commits', color: 'rgb(var(--primary))', values: stats?.weekdays ?? [] }]}
        /> : null}
        {showHours ? <Card className="p-4">
          <ActivityLineChart values={stats?.hours ?? []} zh={zh} onSelect={(hour) => showCommits((commit) => new Date(commit.committedAt).getHours() === hour)} />
        </Card> : null}
      </div>

      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr))]">
        {drilldown !== 'mergeRequests' ? <Card className="p-5">
          <div className="mb-3 flex items-center justify-between text-sm font-semibold text-canvas-fg"><span>{zh ? '我的提交' : 'My Commits'}{drilldown === 'commits' ? ` (${filteredCommits.length})` : ''}</span>{drilldown ? <button className="text-xs text-primary" onClick={() => { setDrilldown(null); setCommitFilter(() => () => true) }}>{zh ? '清除筛选' : 'Clear filter'}</button> : null}</div>
          <div className="max-h-96 space-y-2 overflow-auto pr-1">
            {filteredCommits.length === 0 ? <div className="text-xs text-muted">{zh ? '没有符合条件的提交' : 'No matching commits'}</div> : null}
            {filteredCommits.map((c) => {
              const detail = detailBySha.get(`${c.repositoryId}:${c.sha}`)
              return (
                <div key={`${c.repositoryId}-${c.sha}`} className="rounded-md border border-line bg-elevated px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-canvas-fg">{c.subject}</span>
                    <Badge tone="default">{c.shortSha}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span className="truncate">{c.repositoryName}</span>
                    <span>{new Date(c.committedAt).toLocaleString()}</span>
                    {detail ? (
                      <span>
                        <span className="text-ok">+{detail.added}</span>
                        <span className="mx-1">/</span>
                        <span className="text-danger">-{detail.removed}</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button className="btn btn-secondary h-7 px-2 text-xs" onClick={() => navigate(`/my-activity/commit/${encodeURIComponent(c.repositoryId)}/${encodeURIComponent(c.sha)}`)}>
                      <FileDiff size={13} /> {zh ? '查看代码' : 'View diff'}
                    </button>
                    {c.webUrl ? (
                      <a className="btn btn-ghost h-7 px-2 text-xs" href={c.webUrl} target="_blank" rel="noreferrer">
                        {zh ? `跳转 ${SOURCE_LABELS[c.source]}` : `Open ${SOURCE_LABELS[c.source]}`}
                      </a>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </Card> : null}

        {drilldown !== 'commits' ? <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '合并请求与评审中心' : 'Merge requests and reviews'}</div>
          <div className="mb-3 flex flex-wrap gap-1 border-b border-line">{([
            ['authored', zh ? '我发起的' : 'Authored'], ['pending', zh ? '待我评审的' : 'Pending my review'], ['participated', zh ? '我参与的（平台标记评审）' : 'Reviewed by me'], ['done', zh ? '已完成' : 'Completed']
          ] as const).map(([key, label]) => <button key={key} className={`border-b-2 px-2 py-2 text-xs ${mrTab === key ? 'border-primary text-primary' : 'border-transparent text-muted'}`} onClick={() => setMrTab(key)}>{label}</button>)}</div>
          <div className="max-h-96 space-y-2 overflow-auto pr-1">
            {visibleMergeRequests.length === 0 ? <div className="py-2 text-xs text-muted">{mrTab === 'pending' ? (zh ? '平台未提供明确的待评审人数据，暂时没有可确认的记录。' : 'The forge does not provide explicit pending-reviewer data.') : (zh ? '暂无合并请求' : 'No merge requests')}</div> : null}
            {visibleMergeRequests.map((mr) => (
              <a key={`${mr.repositoryId}-${mr.id}-${mr.role}`} href={mr.webUrl ?? '#'} target="_blank" rel="noreferrer" className="block rounded-md border border-line bg-elevated px-3 py-2 hover:border-primary/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-canvas-fg">{mr.title}</span>
                  <Badge tone={mr.state === 'opened' ? 'primary' : mr.state === 'merged' ? 'ok' : 'default'}>{mr.state}</Badge>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                  <span className="truncate">{mr.repositoryName}</span>
                  <span>{mr.sourceBranch} → {mr.targetBranch}</span>
                  <span>{mr.role === 'author' ? (zh ? '发起' : 'Author') : (zh ? '参与评审' : 'Reviewer')}</span>
                </div>
              </a>
            ))}
          </div>
        </Card> : null}
      </div>

      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr))]">
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '年度复盘' : 'Yearly review'}</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="text-muted"><tr>
                <th className="pb-2 font-medium">{zh ? '年份' : 'Year'}</th>
                <th className="pb-2 font-medium">{zh ? '提交' : 'Commits'}</th>
                <th className="pb-2 font-medium">{zh ? '活跃日' : 'Days'}</th>
                <th className="pb-2 font-medium">{zh ? '分支' : 'Branches'}</th>
                <th className="pb-2 font-medium">+ / -</th>
                <th className="pb-2 font-medium">MR</th>
              </tr></thead>
              <tbody>{stats?.years.map((year) => (
                <tr key={year.year} className="border-t border-line text-canvas-fg">
                  <td className="py-2">{year.year}</td><td>{year.commits}</td><td>{year.activeDays}</td><td>{year.branches}</td>
                  <td><span className="text-ok">+{year.added}</span> / <span className="text-danger">-{year.removed}</span></td>
                  <td>{year.mrAuthored} / {year.mrReviewed}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '平台贡献' : 'By platform'}</div>
          <div className="space-y-2">
            {stats?.bySource.map((entry) => (
              <div key={entry.source} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 text-xs">
                <span className="font-medium text-canvas-fg">{SOURCE_LABELS[entry.source]}</span>
                <span className="text-muted">{entry.commits} {zh ? '提交' : 'commits'} · {entry.branches} {zh ? '分支' : 'branches'} · {entry.mrAuthored}/{entry.mrReviewed} MR</span>
                <span><span className="text-ok">+{entry.added}</span> / <span className="text-danger">-{entry.removed}</span></span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '仓库贡献' : 'By repository'}</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-xs">
            <thead className="text-muted"><tr>
              <th className="pb-2 font-medium">{zh ? '仓库' : 'Repository'}</th><th className="pb-2 font-medium">{zh ? '平台' : 'Platform'}</th>
              <th className="pb-2 font-medium">{zh ? '提交 / 分支' : 'Commits / branches'}</th><th className="pb-2 font-medium">{zh ? '活跃日' : 'Active days'}</th>
              <th className="pb-2 font-medium">+ / -</th><th className="pb-2 font-medium">MR</th>
            </tr></thead>
            <tbody>{stats?.byRepository.map((entry) => (
              <tr key={entry.repositoryId} className="border-t border-line text-canvas-fg">
                <td className="max-w-64 truncate py-2" title={entry.repositoryName}>{entry.repositoryName}</td><td>{SOURCE_LABELS[entry.source]}</td>
                <td>{entry.commits} / {entry.branches}</td><td>{entry.activeDays}</td>
                <td><span className="text-ok">+{entry.added}</span> / <span className="text-danger">-{entry.removed}</span></td>
                <td>{entry.mrAuthored} / {entry.mrReviewed}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr))]">
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg"><FileCode size={14} /> {zh ? '文件类型分布' : 'File types'}</div>
          <div className="space-y-2">
            {stats?.fileTypes.length === 0 ? <div className="text-xs text-muted">{zh ? '暂无数据' : 'No data'}</div> : null}
            {stats?.fileTypes.slice(0, 10).map((entry) => (
              <div key={entry.type} className="flex items-center justify-between rounded-md border border-line bg-elevated px-3 py-1.5 text-xs">
                <span className="truncate text-canvas-fg">{entry.type}</span>
                <span className="text-muted">
                  {entry.files} · <span className="text-ok">+{entry.added}</span> / <span className="text-danger">-{entry.removed}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg"><FileDiff size={14} /> {zh ? '高频修改文件' : 'Top files'}</div>
          <div className="space-y-2">
            {stats?.topFiles.length === 0 ? <div className="text-xs text-muted">{zh ? '暂无数据' : 'No data'}</div> : null}
            {stats?.topFiles.map((entry) => (
              <div key={entry.path} className="flex items-center justify-between rounded-md border border-line bg-elevated px-3 py-1.5 text-xs">
                <span className="truncate text-canvas-fg">{entry.path}</span>
                <span className="text-muted">
                  {entry.commits} · <span className="text-ok">+{entry.added}</span> / <span className="text-danger">-{entry.removed}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="self-start p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="flex items-center gap-2 text-sm font-semibold text-canvas-fg"><FileText size={15} />{zh ? '研发复盘报告' : 'Development review report'}</h2><p className="mt-1 text-xs text-muted">{zh ? '直接整合当前已加载的个人活动数据；事实和描述性归纳分开展示，无需配置 AI。' : 'Built from loaded activity data; facts are separated from narrative and no AI setup is required.'}</p></div>
          <div className="flex gap-2"><button className="btn btn-secondary" disabled={!data} onClick={() => setReview(buildReview(data!, months, zh))}>{zh ? '生成复盘' : 'Generate review'}</button>{review ? <><button className="btn btn-ghost" onClick={() => downloadReview('personal-development-review.md', 'text/markdown;charset=utf-8', review)}><Download size={14} />Markdown</button><button className="btn btn-ghost" onClick={() => downloadReview('personal-development-review.html', 'text/html;charset=utf-8', reviewHtml(review))}><Download size={14} />HTML</button></> : null}</div>
        </div>
        {review ? <pre className="mt-4 max-h-[520px] overflow-auto whitespace-pre-wrap border-t border-line pt-4 font-sans text-sm text-canvas-fg">{review}</pre> : null}
      </Card>

    </div>
  )
}
