import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ExternalLink, FileCode2, GitCommitHorizontal, GitMerge, History } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import type { PersonalActivity } from '@shared/types'
import { readMyActivityMonths, saveMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'

const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee', local: 'Local' } as const

type TimelineEvent =
  | { kind: 'commit'; date: string; key: string; commit: PersonalActivity['commits'][number]; detail?: PersonalActivity['commitDetails'][number] }
  | { kind: 'merge-request'; date: string; key: string; mr: PersonalActivity['mergeRequests'][number] }

function localDay(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function monthLabel(value: string, zh: boolean): string {
  const [year, month] = value.split('-').map(Number)
  return zh ? `${year} 年 ${month} 月` : new Date(year, month - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
}

export default function MyTimeline(): JSX.Element {
  const role = useAppStore((state) => state.role)
  const session = useAppStore((state) => state.session)
  const language = useAppStore((state) => state.language)
  const zh = language === 'zh'
  const toast = useAppStore((state) => state.toast)
  const cache = useAppStore((state) => state.myActivityCache)
  const busy = useAppStore((state) => state.myActivityBusy)
  const loadMyActivity = useAppStore((state) => state.loadMyActivity)
  const navigate = useNavigate()
  const [months, setMonths] = useState(() => readMyActivityMonths(session))
  const cacheKey = `${session?.email.toLowerCase() ?? ''}|${session?.source ?? ''}|${session?.accountId ?? session?.username.toLowerCase() ?? ''}|${months}`
  const activity = cache[cacheKey]

  useEffect(() => {
    void loadMyActivity(months).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'))
  }, [loadMyActivity, months, session?.email, session?.source, toast])

  useEffect(() => saveMyActivityMonths(session, months), [months, session])

  const { dated, undatedReviews } = useMemo(() => {
    const details = new Map((activity?.commitDetails ?? []).map((detail) => [`${detail.repositoryId}:${detail.sha}`, detail]))
    const events: TimelineEvent[] = []
    const reviews: PersonalActivity['mergeRequests'] = []
    for (const commit of activity?.commits ?? []) {
      const date = localDay(commit.committedAt)
      if (!date) continue
      events.push({ kind: 'commit', date, key: `commit:${commit.repositoryId}:${commit.sha}`, commit, detail: details.get(`${commit.repositoryId}:${commit.sha}`) })
    }
    for (const mr of activity?.mergeRequests ?? []) {
      if (mr.role === 'reviewer') {
        reviews.push(mr)
        continue
      }
      const date = localDay(mr.createdAt)
      if (date) events.push({ kind: 'merge-request', date, key: `mr:${mr.repositoryId}:${mr.id}:${mr.role}`, mr })
    }
    events.sort((left, right) => right.date.localeCompare(left.date))
    reviews.sort((left, right) => left.repositoryName.localeCompare(right.repositoryName) || left.title.localeCompare(right.title))
    const groups = new Map<string, TimelineEvent[]>()
    for (const event of events) {
      const month = event.date.slice(0, 7)
      groups.set(month, [...(groups.get(month) ?? []), event])
    }
    return { dated: [...groups.entries()], undatedReviews: reviews }
  }, [activity])

  if (role !== 'user') return <div className="text-sm text-muted">{zh ? '此页面仅对普通用户开放。' : 'Available to regular users only.'}</div>

  const commitCount = activity?.commits.length ?? 0
  const authoredCount = activity?.mergeRequests.filter((mr) => mr.role === 'author').length ?? 0
  const reviewCount = activity?.mergeRequests.filter((mr) => mr.role === 'reviewer').length ?? 0

  return <div className="space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-canvas-fg"><History size={19} />{zh ? '我的研发时间线' : 'My Development Timeline'}</h1>
        <p className="mt-1 text-xs text-muted">{zh ? '按真实提交与合并请求记录回看研发经历' : 'A chronological view of recorded commits and merge requests'}</p>
      </div>
      <label className="text-xs text-muted">{zh ? '时间范围' : 'Time range'}
        <select value={months} onChange={(event) => setMonths(Number(event.target.value))} className="input ml-2">
          {[1, 3, 6, 12, 24, 36].map((value) => <option key={value} value={value}>{zh ? `最近 ${value} 个月` : `Last ${value} months`}</option>)}
        </select>
      </label>
    </header>

    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Card className="p-3"><div className="text-xs text-muted">{zh ? '提交' : 'Commits'}</div><div className="mt-1 text-xl font-semibold text-canvas-fg">{commitCount}</div></Card>
      <Card className="p-3"><div className="text-xs text-muted">{zh ? '代码新增 / 删除' : 'Lines added / removed'}</div><div className="mt-1 text-xl font-semibold text-canvas-fg"><span className="text-ok">+{activity?.stats.linesAdded ?? 0}</span> / <span className="text-danger">-{activity?.stats.linesRemoved ?? 0}</span></div></Card>
      <Card className="p-3"><div className="text-xs text-muted">{zh ? '发起 MR' : 'MRs opened'}</div><div className="mt-1 text-xl font-semibold text-canvas-fg">{authoredCount}</div></Card>
      <Card className="p-3"><div className="text-xs text-muted">{zh ? '参与评审' : 'Review participation'}</div><div className="mt-1 text-xl font-semibold text-canvas-fg">{reviewCount}</div></Card>
    </div>

    {busy && !activity ? <div className="py-10 text-center text-sm text-muted">{zh ? '正在读取研发记录…' : 'Loading activity…'}</div> : null}
    {!busy && dated.length === 0 && undatedReviews.length === 0 ? <Card className="p-8 text-center text-sm text-muted">{zh ? '所选时间范围内暂无可展示的研发记录。' : 'No activity records in this period.'}</Card> : null}

    <div className="space-y-7">
      {dated.map(([month, events]) => <section key={month}>
        <h2 className="mb-3 border-b border-line pb-2 text-sm font-semibold text-canvas-fg">{monthLabel(month, zh)} <span className="ml-2 font-normal text-muted">{events.length} {zh ? '条记录' : 'events'}</span></h2>
        <div className="space-y-4">
          {events.map((event) => <article key={event.key} className="relative grid grid-cols-[82px_minmax(0,1fr)] gap-3">
            <div className="pt-3 text-right text-xs text-muted">{event.date.slice(5)}</div>
            <div className="relative border-l border-line pl-4">
              <span className="absolute -left-[5px] top-4 h-2 w-2 rounded-full bg-primary" />
              {event.kind === 'commit' ? <Card className="p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2"><GitCommitHorizontal size={15} className="mt-0.5 shrink-0 text-primary" /><div className="min-w-0"><div className="break-words text-sm font-medium text-canvas-fg">{event.commit.subject || (zh ? '無提交说明' : 'Commit without a message')}</div><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted"><span>{event.commit.repositoryName}</span><span>{new Date(event.commit.committedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><Badge>{event.commit.shortSha}</Badge></div></div></div>
                  <div className="flex shrink-0 gap-2">
                    <button className="btn btn-secondary h-7 px-2 text-xs" onClick={() => navigate(`/my-activity/commit/${encodeURIComponent(event.commit.repositoryId)}/${encodeURIComponent(event.commit.sha)}`)}><FileCode2 size={13} />{zh ? '查看代码' : 'View code'}</button>
                    {event.commit.webUrl ? <a className="btn btn-ghost h-7 px-2 text-xs" href={event.commit.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{SOURCE_LABELS[event.commit.source]}</a> : null}
                  </div>
                </div>
                {event.detail ? <div className="mt-2 border-t border-line pt-2">
                  <div className="mb-1 text-xs text-muted"><span className="text-ok">+{event.detail.added}</span> / <span className="text-danger">-{event.detail.removed}</span> {zh ? '行' : 'lines'} · {event.detail.files.length} {zh ? '个文件' : 'files'}</div>
                  <div className="flex flex-wrap gap-1">{event.detail.files.slice(0, 8).map((file) => <span key={file.path} className="inline-flex max-w-full items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted"><FileCode2 size={11} /><span className="truncate">{file.path}</span></span>)}{event.detail.files.length > 8 ? <span className="text-[11px] text-muted">+{event.detail.files.length - 8}</span> : null}</div>
                </div> : <div className="mt-2 text-xs text-muted">{zh ? '代码差异未能读取' : 'Diff details are unavailable'}</div>}
              </Card> : <Card className="p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2"><GitMerge size={15} className="mt-0.5 shrink-0 text-secondary" /><div className="min-w-0"><div className="break-words text-sm font-medium text-canvas-fg">{event.mr.title}</div><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted"><span>{event.mr.repositoryName}</span><span>{event.mr.sourceBranch} → {event.mr.targetBranch}</span><Badge tone={event.mr.state === 'merged' ? 'ok' : event.mr.state === 'closed' ? 'default' : 'primary'}>{event.mr.state}</Badge></div></div></div>
                  {event.mr.webUrl ? <a className="btn btn-ghost h-7 shrink-0 px-2 text-xs" href={event.mr.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{SOURCE_LABELS[event.mr.source]}</a> : null}
                </div>
              </Card>}
            </div>
          </article>)}
        </div>
      </section>)}

      {undatedReviews.length > 0 ? <section>
        <h2 className="mb-3 border-b border-line pb-2 text-sm font-semibold text-canvas-fg">{zh ? '评审参与（平台未提供评审时间）' : 'Review participation (date not provided by forge)'} <span className="ml-2 font-normal text-muted">{undatedReviews.length}</span></h2>
        <div className="space-y-2">{undatedReviews.map((mr) => <Card key={`${mr.repositoryId}:${mr.id}`} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0"><div className="text-sm font-medium text-canvas-fg">{mr.title}</div><div className="mt-1 text-xs text-muted">{mr.repositoryName} · {mr.sourceBranch} → {mr.targetBranch}</div></div>
          {mr.webUrl ? <a href={mr.webUrl} target="_blank" rel="noreferrer" className="btn btn-ghost h-7 shrink-0 px-2 text-xs"><ExternalLink size={13} />{SOURCE_LABELS[mr.source]}</a> : null}
        </Card>)}</div>
      </section> : null}
    </div>

    {activity?.branches.length ? <section className="border-t border-line pt-4"><h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-canvas-fg"><CalendarDays size={15} />{zh ? '已收录的分支记录' : 'Tracked branch records'}</h2><div className="flex flex-wrap gap-2">{activity.branches.map((branch) => <Link key={`${branch.repositoryId}:${branch.type}:${branch.name}`} to={`/branches/${encodeURIComponent(branch.repositoryId)}/${encodeURIComponent(branch.type)}/${encodeURIComponent(branch.name)}`} className="rounded border border-line px-2 py-1 text-xs text-primary">{branch.repositoryName} / {branch.name}</Link>)}</div></section> : null}
  </div>
}
