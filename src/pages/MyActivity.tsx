import { useEffect, useMemo, useState } from 'react'
import {
  Activity, CalendarDays, FileCode, FileDiff, Flame, GitBranch, GitMerge,
  GitCommitHorizontal, Users
} from 'lucide-react'
import type { PersonalActivity } from '@shared/types'
import { readMyActivityMonths, saveMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'
import { Link, useNavigate } from 'react-router-dom'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee', local: 'Local' } as const

function ActivityChart({ labels, series, xLabel, yLabel }: {
  labels: string[]; series: Array<{ name: string; values: number[]; color: string }>; xLabel: string; yLabel: string
}): JSX.Element {
  const max = Math.max(1, ...series.flatMap((entry) => entry.values))
  return <div>
    <div className="mb-2 flex flex-wrap gap-3 text-xs text-muted">
      <span>{yLabel}</span>
      {series.map((entry) => <span key={entry.name} className="flex items-center gap-1"><span className={`h-2 w-2 ${entry.color}`} />{entry.name}</span>)}
    </div>
    <div className="flex gap-2">
      <div className="flex h-32 w-10 shrink-0 flex-col justify-between text-right text-[10px] text-muted"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex gap-2 border-b border-l border-line" style={{ minWidth: labels.length * 42 }}>
          {labels.map((label, index) => <div key={label} className="min-w-0 flex-1">
            <div className="relative h-32">
              <div className="absolute inset-x-0 top-0 flex h-4 items-center justify-center gap-0.5 overflow-visible">
                {series.map((entry) => {
                  const value = entry.values[index] ?? 0
                  return <span key={entry.name} className={`min-w-3 text-center text-[9px] font-medium leading-none ${value > 0 ? 'text-canvas-fg' : 'text-transparent'}`} aria-label={value > 0 ? `${label} ${entry.name}: ${value}` : undefined}>{value}</span>
                })}
              </div>
              <div className="absolute inset-x-0 bottom-0 flex h-28 items-end justify-center gap-0.5">
              {series.map((entry) => {
                const value = entry.values[index] ?? 0
                return <div key={entry.name} className="flex h-full w-3 flex-col justify-end" title={`${label} ${entry.name}: ${value}`}>
                  <div className={`w-full ${entry.color}`} style={{ height: `${(value / max) * 100}%`, minHeight: value > 0 ? 2 : 0 }} />
                </div>
              })}
              </div>
            </div>
          </div>)}
        </div>
        <div className="mt-1 flex gap-2" style={{ minWidth: labels.length * 42 }}>{labels.map((label) => <span key={label} className="flex-1 text-center text-[10px] text-muted">{label}</span>)}</div>
      </div>
    </div>
    <div className="mt-2 text-center text-xs text-muted">{xLabel}</div>
  </div>
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
  const [showBranches, setShowBranches] = useState(false)

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

  return (
    <div className="space-y-6">
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 2xl:grid-cols-8">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><GitCommitHorizontal size={14} /> {zh ? '提交次数' : 'Commits'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.commitCount ?? 0}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted">{zh ? '新增 / 删除行' : 'Added / Removed'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">
            <span className="text-ok">{stats?.linesAdded ?? 0}</span>
            <span className="mx-1 text-muted">/</span>
            <span className="text-danger">{stats?.linesRemoved ?? 0}</span>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><CalendarDays size={14} /> {zh ? '活跃天数' : 'Active days'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.activeDays ?? 0}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><Flame size={14} /> {zh ? '当前 / 最长连续' : 'Current / Longest streak'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">
            {stats?.currentStreak ?? 0}
            <span className="mx-1 text-muted">/</span>
            {stats?.longestStreak ?? 0}
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><GitBranch size={14} /> {zh ? '创建分支' : 'Branches'}</div>
          <button className="mt-1 text-xl font-bold text-primary underline decoration-dotted" onClick={() => setShowBranches(!showBranches)} aria-expanded={showBranches}>{stats?.branchCount ?? 0}</button>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted" title={zh ? '按当前分支命名规则统计：合规包含有效或已排除分支；不规范表示不符合规则。' : 'Based on branch naming rules: compliant includes valid or excluded branches; non-compliant branches do not match a rule.'}>{zh ? '命名合规 / 不规范' : 'Naming compliant / non-compliant'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">
            <span className="text-ok">{stats?.validBranches ?? 0}</span>
            <span className="mx-1 text-muted">/</span>
            <span className="text-danger">{stats?.invalidBranches ?? 0}</span>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><GitMerge size={14} /> {zh ? '发起 MR' : 'MRs authored'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.mrAuthored ?? 0}</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted"><Users size={14} /> {zh ? '参与评审' : 'MRs reviewed'}</div>
          <div className="mt-1 text-xl font-bold text-canvas-fg">{stats?.mrReviewed ?? 0}</div>
        </Card>
      </div>

      {showBranches ? <section className="space-y-2 border-y border-line py-4">
        <h2 className="text-sm font-semibold">{zh ? '创建的分支（当前已收录分支）' : 'Created branches (currently tracked)'}</h2>
        {data?.branches?.length ? data.branches.map((branch) => <Link key={`${branch.repositoryId}:${branch.type}:${branch.name}`} to={`/branches/${encodeURIComponent(branch.repositoryId)}/${encodeURIComponent(branch.type)}/${encodeURIComponent(branch.name)}`} className="flex flex-wrap justify-between gap-2 border-b border-line py-2 text-xs text-primary">
          <span>{branch.repositoryName} / {branch.name}</span><span className="text-muted">{branch.createdAt ? new Date(branch.createdAt).toLocaleString() : (zh ? '创建时间未知' : 'Unknown creation date')}</span>
        </Link>) : <div className="text-xs text-muted">{zh ? '暂无已收录分支' : 'No tracked branches'}</div>}
      </section> : null}
      {stats && stats.diffsFailed > 0 ? <div role="status" className="text-sm text-danger">{zh ? `${stats.diffsLoaded} 个提交差异已加载，${stats.diffsFailed} 个获取失败；代码行数及文件统计不完整。` : `${stats.diffsLoaded} diffs loaded, ${stats.diffsFailed} failed; line and file statistics are incomplete.`}</div> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 text-sm font-semibold text-canvas-fg">{zh ? '按月提交与分支' : 'Monthly commits and branches'}</div>
          <ActivityChart labels={stats?.months.map((m) => m.month) ?? []} xLabel={zh ? '月份' : 'Month'} yLabel={zh ? '数量（次 / 个）' : 'Count'} series={[
            { name: zh ? '提交' : 'Commits', color: 'bg-primary', values: stats?.months.map((m) => m.commits) ?? [] },
            { name: zh ? '分支' : 'Branches', color: 'bg-secondary', values: stats?.months.map((m) => m.branches) ?? [] }
          ]} />
        </Card>
        <Card className="p-5">
          <div className="mb-4 text-sm font-semibold text-canvas-fg">{zh ? '按月代码增删' : 'Monthly code changes'}</div>
          <ActivityChart labels={stats?.monthlyLines.map((m) => m.month) ?? []} xLabel={zh ? '月份' : 'Month'} yLabel={zh ? '代码行数（行）' : 'Lines'} series={[
            { name: zh ? '新增' : 'Added', color: 'bg-ok', values: stats?.monthlyLines.map((m) => m.added) ?? [] },
            { name: zh ? '删除' : 'Removed', color: 'bg-danger', values: stats?.monthlyLines.map((m) => m.removed) ?? [] }
          ]} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '按星期分布' : 'By weekday'}</div>
          <ActivityChart labels={zh ? WEEKDAY_LABELS : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']} xLabel={zh ? '星期（本地时间）' : 'Weekday (local time)'} yLabel={zh ? '提交次数' : 'Commits'} series={[{ name: zh ? '提交' : 'Commits', color: 'bg-primary', values: stats?.weekdays ?? [] }]} />
        </Card>
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '按小时分布' : 'By hour'}</div>
          <ActivityChart labels={Array.from({ length: 24 }, (_, hour) => `${hour}:00`)} xLabel={zh ? '小时（本地时间）' : 'Hour (local time)'} yLabel={zh ? '提交次数' : 'Commits'} series={[{ name: zh ? '提交' : 'Commits', color: 'bg-primary', values: stats?.hours ?? [] }]} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '我的提交' : 'My Commits'}</div>
          <div className="max-h-96 space-y-2 overflow-auto pr-1">
            {data?.commits.length === 0 ? <div className="text-xs text-muted">{zh ? '暂无提交记录' : 'No commits yet'}</div> : null}
            {data?.commits.map((c) => {
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
        </Card>

        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '我的合并请求' : 'My Merge Requests'}</div>
          <div className="max-h-96 space-y-2 overflow-auto pr-1">
            {data?.mergeRequests.length === 0 ? <div className="text-xs text-muted">{zh ? '暂无合并请求' : 'No merge requests'}</div> : null}
            {data?.mergeRequests.map((mr) => (
              <a key={`${mr.repositoryId}-${mr.id}-${mr.role}`} href={mr.webUrl ?? '#'} target="_blank" rel="noreferrer" className="block rounded-md border border-line bg-elevated px-3 py-2 hover:border-primary/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-canvas-fg">{mr.title}</span>
                  <Badge tone={mr.state === 'opened' ? 'primary' : mr.state === 'merged' ? 'ok' : 'default'}>{mr.state}</Badge>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                  <span className="truncate">{mr.repositoryName}</span>
                  <span>{mr.sourceBranch} → {mr.targetBranch}</span>
                  <span>{mr.role === 'author' ? (zh ? '发起' : 'Author') : (zh ? '待审' : 'Reviewer')}</span>
                </div>
              </a>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
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

    </div>
  )
}
