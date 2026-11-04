import { ArrowLeft, GitCommitHorizontal, GitBranch, FileDiff } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { PersonalActivity } from '@shared/types'
import { readMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'

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
  const scope = selectedRepositoryIds.slice().sort().join(',')
  const key = `${session?.email.toLowerCase() ?? ''}|${session?.source ?? ''}|${session?.accountId ?? session?.username.toLowerCase() ?? ''}|${months}|${scope}`
  const data = cache[key]
  const commits = useMemo(() => data?.commits.filter((commit) => localMonth(commit.committedAt) === month) ?? [], [data, month])
  const details = useMemo(() => new Map((data?.commitDetails ?? []).map((detail) => [`${detail.repositoryId}:${detail.sha}`, detail])), [data])
  const zh = language === 'zh'

  useEffect(() => { void load(months) }, [load, months, scope])

  return <div className="space-y-4">
    <button className="btn btn-ghost" onClick={() => navigate('/my-activity')}><ArrowLeft size={14} />{zh ? '返回个人活动' : 'Back to my activity'}</button>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-lg font-bold text-canvas-fg">{kind === 'lines' ? (zh ? '按月代码增删明细' : 'Monthly code change details') : (zh ? '按月提交明细' : 'Monthly commit details')}</h1><p className="mt-1 text-xs text-muted">{month} · {zh ? `最近 ${months} 个月` : `Last ${months} months`}</p></div>
      <Badge tone="primary"><GitCommitHorizontal size={12} className="mr-1 inline" />{commits.length} {zh ? '提交' : 'commits'}</Badge>
    </div>
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg"><GitBranch size={15} />{zh ? '本月仓库活动' : 'Repository activity for this month'}</div>
      <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
        {commits.length ? commits.map((commit) => {
          const detail = details.get(`${commit.repositoryId}:${commit.sha}`)
          return <div key={`${commit.repositoryId}:${commit.sha}`} className="rounded-md border border-line bg-elevated px-3 py-2">
            <div className="flex items-center justify-between gap-2"><span className="truncate text-sm text-canvas-fg">{commit.subject}</span><Badge tone="default">{commit.shortSha}</Badge></div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"><span>{commit.repositoryName}</span><span>{new Date(commit.committedAt).toLocaleString()}</span>{detail ? <span><span className="text-ok">+{detail.added}</span> / <span className="text-danger">-{detail.removed}</span></span> : null}</div>
            <button className="btn btn-secondary mt-2 h-7 px-2 text-xs" onClick={() => navigate(`/my-activity/commit/${encodeURIComponent(commit.repositoryId)}/${encodeURIComponent(commit.sha)}`)}><FileDiff size={13} />{zh ? '查看代码' : 'View diff'}</button>
          </div>
        }) : <div className="py-10 text-center text-xs text-muted">{zh ? '该月份没有可显示的提交明细' : 'No commit details for this month'}</div>}
      </div>
    </Card>
  </div>
}
