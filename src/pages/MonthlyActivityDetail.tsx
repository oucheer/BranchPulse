import { ArrowLeft, ExternalLink, GitCommitHorizontal, GitBranch, GitMerge, FileDiff } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { PersonalActivity } from '@shared/types'
import { readMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'

const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee' } as const

function localMonth(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export default function MonthlyActivityDetail(): JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const language = useAppStore((state) => state.language)
  const session = useAppStore((state) => state.session)
  const selectedRepositoryIds = useAppStore((state) => state.selectedRepositoryIds)
  const cache = useAppStore((state) => state.myActivityCache)
  const load = useAppStore((state) => state.loadMyActivity)
  const kind = params.get('kind') === 'lines' ? 'lines' : 'commits'
  const month = params.get('month') ?? ''
  const months = Number(params.get('months')) || readMyActivityMonths(session)
  const range = params.get('start') && params.get('end') ? { start: params.get('start')!, end: params.get('end')! } : null
  const scope = selectedRepositoryIds.slice().sort().join(',')
  const key = `${session?.email.toLowerCase() ?? ''}|${session?.source ?? ''}|${session?.accountId ?? session?.username.toLowerCase() ?? ''}|${months}|${range ? `${range.start}|${range.end}` : ''}|${scope}`
  const data = cache[key]
  const commits = useMemo(() => data?.commits.filter((commit) => localMonth(commit.committedAt) === month) ?? [], [data, month])
  const mergeRequests = useMemo(() => data?.mergeRequests.filter((request) => localMonth(request.createdAt) === month) ?? [], [data, month])
  const details = useMemo(() => new Map((data?.commitDetails ?? []).map((detail) => [`${detail.repositoryId}:${detail.sha}`, detail])), [data])
  const zh = language === 'zh'

  useEffect(() => { void load(months, false, range) }, [load, months, range?.start, range?.end, scope])

  return <div className="space-y-4">
    <button className="btn btn-ghost" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/my-activity')}><ArrowLeft size={14} />{zh ? '返回个人活动' : 'Back to my activity'}</button>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-lg font-bold text-canvas-fg">{kind === 'lines' ? (zh ? '按月代码增删明细' : 'Monthly code change details') : (zh ? '按月提交明细' : 'Monthly commit details')}</h1><p className="mt-1 text-xs text-muted">{month} · {range ? `${range.start} 至 ${range.end}` : (zh ? `最近 ${months} 个月` : `Last ${months} months`)}</p></div>
      <div className="flex flex-wrap gap-2"><Badge tone="primary"><GitCommitHorizontal size={12} className="mr-1 inline" />{commits.length} {zh ? '提交' : 'commits'}</Badge><Badge tone="secondary"><GitMerge size={12} className="mr-1 inline" />{mergeRequests.length} MR</Badge></div>
    </div>
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg"><GitBranch size={15} />{zh ? '本月提交与合并请求' : 'Commits and merge requests for this month'}</div>
      <div className="max-h-[34rem] space-y-4 overflow-y-auto pr-1">
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-muted">{zh ? '提交' : 'Commits'}</h2>
        {commits.length ? commits.map((commit) => {
          const detail = details.get(`${commit.repositoryId}:${commit.sha}`)
          return <div key={`${commit.repositoryId}:${commit.sha}`} className="rounded-md border border-line bg-elevated px-3 py-2">
            <div className="flex items-center justify-between gap-2"><span className="truncate text-sm text-canvas-fg">{commit.subject}</span><Badge tone="default">{commit.shortSha}</Badge></div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"><span>{commit.repositoryName}</span><span>{new Date(commit.committedAt).toLocaleString()}</span>{detail ? <span><span className="text-ok">+{detail.added}</span> / <span className="text-danger">-{detail.removed}</span></span> : null}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"><GitBranch size={13} />{commit.branchNames?.length ? commit.branchNames.map((name) => <Badge key={name} tone="secondary">{name}</Badge>) : <span>{zh ? '未能从已收录分支中确认' : 'No tracked branch match'}</span>}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn btn-secondary h-7 px-2 text-xs" onClick={() => navigate(`/my-activity/commit/${encodeURIComponent(commit.repositoryId)}/${encodeURIComponent(commit.sha)}?months=${months}${range ? `&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}` : ''}`)}><FileDiff size={13} />{zh ? '查看代码' : 'View diff'}</button>
              {commit.webUrl ? <a className="btn btn-ghost h-7 px-2 text-xs" href={commit.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{zh ? `跳转 ${SOURCE_LABELS[commit.source]}` : `Open ${SOURCE_LABELS[commit.source]}`}</a> : null}
            </div>
          </div>
        }) : <div className="py-10 text-center text-xs text-muted">{zh ? '该月份没有可显示的提交明细' : 'No commit details for this month'}</div>}
        </section>
        <section className="space-y-2 border-t border-line pt-3">
          <h2 className="text-xs font-semibold text-muted">{zh ? '合并请求与评审' : 'Merge requests and reviews'}</h2>
          {mergeRequests.length ? mergeRequests.map((request) => <div key={`${request.repositoryId}:${request.id}:${request.role}`} className="flex items-center justify-between gap-3 rounded-md border border-line bg-elevated px-3 py-2">
            <div className="min-w-0"><div className="truncate text-sm text-canvas-fg">{request.title}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted"><span>{request.repositoryName}</span><span>{request.sourceBranch} → {request.targetBranch}</span><span>{request.role === 'author' ? (zh ? '发起' : 'Authored') : (zh ? '参与评审' : 'Reviewed')}</span><Badge tone={request.state === 'opened' ? 'primary' : request.state === 'merged' ? 'ok' : 'default'}>{request.state}</Badge></div></div>
            {request.webUrl ? <a className="btn btn-ghost h-7 shrink-0 px-2 text-xs" href={request.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{zh ? '打开' : 'Open'}</a> : null}
          </div>) : <div className="py-6 text-center text-xs text-muted">{zh ? '该月份没有可显示的合并请求' : 'No merge requests for this month'}</div>}
        </section>
      </div>
    </Card>
  </div>
}
