import { ArrowLeft, ExternalLink, FileDiff, GitBranch, GitMerge, GitCommitHorizontal } from 'lucide-react'
import { useMemo, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { PersonalActivity } from '@shared/types'
import { readMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'

const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee' } as const

export default function RepositoryActivityDetail(): JSX.Element {
  const { repositoryId = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const language = useAppStore((state) => state.language)
  const session = useAppStore((state) => state.session)
  const selectedRepositoryIds = useAppStore((state) => state.selectedRepositoryIds)
  const cache = useAppStore((state) => state.myActivityCache)
  const load = useAppStore((state) => state.loadMyActivity)
  const months = Number(params.get('months')) || readMyActivityMonths(session)
  const range = params.get('start') && params.get('end') ? { start: params.get('start')!, end: params.get('end')! } : null
  const scope = selectedRepositoryIds.slice().sort().join(',')
  const key = `${session?.email.toLowerCase() ?? ''}|${session?.source ?? ''}|${session?.accountId ?? session?.username.toLowerCase() ?? ''}|${months}|${range ? `${range.start}|${range.end}` : ''}|${scope}`
  const data = cache[key]
  const repository = data?.stats.byRepository.find((entry) => entry.repositoryId === repositoryId)
  const commits = useMemo(() => data?.commits.filter((commit) => commit.repositoryId === repositoryId) ?? [], [data, repositoryId])
  const mergeRequests = useMemo(() => data?.mergeRequests.filter((mr) => mr.repositoryId === repositoryId) ?? [], [data, repositoryId])
  const zh = language === 'zh'

  useEffect(() => { void load(months, false, range) }, [load, months, range?.start, range?.end, scope])

  if (!data || !repository) {
    return <Card className="p-6"><div className="text-sm text-muted">{zh ? '正在加载仓库明细…' : 'Loading repository details...'}</div></Card>
  }

  return <div className="space-y-4">
    <button className="btn btn-ghost" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/my-activity')}><ArrowLeft size={14} />{zh ? '返回个人活动' : 'Back to my activity'}</button>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-lg font-bold text-canvas-fg">{repository.repositoryName}</h1><p className="mt-1 text-xs text-muted">{zh ? `最近 ${months} 个月的仓库贡献明细` : `Repository activity for the last ${months} months`}</p></div>
      <div className="flex gap-2"><Badge tone="primary"><GitCommitHorizontal size={12} className="mr-1 inline" />{repository.commits} {zh ? '提交' : 'commits'}</Badge><Badge tone="secondary"><GitMerge size={12} className="mr-1 inline" />{repository.mrAuthored + repository.mrReviewed} MR</Badge></div>
    </div>
    <div className="grid items-stretch gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr))]">
      <Card className="flex h-[30rem] min-h-0 flex-col p-5">
        <div className="mb-3 flex shrink-0 items-center gap-2 text-sm font-semibold text-canvas-fg"><GitCommitHorizontal size={15} />{zh ? `提交 (${commits.length})` : `Commits (${commits.length})`}</div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {commits.length ? commits.map((commit) => <div key={commit.sha} className="rounded-md border border-line bg-elevated px-3 py-2">
            <div className="break-words text-sm text-canvas-fg">{commit.subject}</div>
            <div className="mt-1 text-xs text-muted">{commit.shortSha} · {new Date(commit.committedAt).toLocaleString()}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn btn-secondary h-7 px-2 text-xs" onClick={() => navigate(`/my-activity/commit/${encodeURIComponent(commit.repositoryId)}/${encodeURIComponent(commit.sha)}?months=${months}${range ? `&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}` : ''}`)}><FileDiff size={13} />{zh ? '查看代码' : 'View diff'}</button>
              {commit.webUrl ? <a className="btn btn-ghost h-7 px-2 text-xs" href={commit.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{zh ? `跳转 ${SOURCE_LABELS[commit.source]}` : `Open ${SOURCE_LABELS[commit.source]}`}</a> : null}
            </div>
          </div>) : <div className="flex min-h-32 items-center justify-center text-xs text-muted">{zh ? '暂无提交' : 'No commits'}</div>}
        </div>
      </Card>
      <Card className="flex h-[30rem] min-h-0 flex-col p-5">
        <div className="mb-3 flex shrink-0 items-center gap-2 text-sm font-semibold text-canvas-fg"><GitMerge size={15} />{zh ? `合并请求与评审 (${mergeRequests.length})` : `Merge requests and reviews (${mergeRequests.length})`}</div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {mergeRequests.length ? mergeRequests.map((mr) => <div key={`${mr.id}:${mr.role}`} className="rounded-md border border-line bg-elevated px-3 py-2">
            <div className="flex items-center justify-between gap-2"><span className="truncate text-sm text-canvas-fg">{mr.title}</span><Badge tone={mr.state === 'opened' ? 'primary' : mr.state === 'merged' ? 'ok' : 'default'}>{mr.state}</Badge></div>
            <div className="mt-1 text-xs text-muted">{mr.sourceBranch} → {mr.targetBranch} · {mr.role === 'author' ? (zh ? '发起' : 'Authored') : (zh ? '参与评审' : 'Reviewed')}</div>
            {mr.webUrl ? <a className="btn btn-ghost mt-2 h-7 px-2 text-xs" href={mr.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{zh ? `跳转 ${SOURCE_LABELS[mr.source]}` : `Open ${SOURCE_LABELS[mr.source]}`}</a> : null}
          </div>) : <div className="flex min-h-32 items-center justify-center text-xs text-muted">{zh ? '暂无合并请求' : 'No merge requests'}</div>}
        </div>
      </Card>
    </div>
    <Card className="p-5"><div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg"><GitBranch size={15} />{zh ? '仓库统计' : 'Repository summary'}</div><div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4"><div><div className="text-xs text-muted">{zh ? '活跃天数' : 'Active days'}</div><div className="mt-1 text-lg font-semibold text-canvas-fg">{repository.activeDays}</div></div><div><div className="text-xs text-muted">{zh ? '代码新增' : 'Lines added'}</div><div className="mt-1 text-lg font-semibold text-ok">+{repository.added}</div></div><div><div className="text-xs text-muted">{zh ? '代码删除' : 'Lines removed'}</div><div className="mt-1 text-lg font-semibold text-danger">-{repository.removed}</div></div><div><div className="text-xs text-muted">{zh ? '分支' : 'Branches'}</div><div className="mt-1 text-lg font-semibold text-canvas-fg">{repository.branches}</div></div></div></Card>
  </div>
}
