import { useEffect, useState } from 'react'
import { Activity, GitBranch, GitMerge, GitCommitHorizontal } from 'lucide-react'
import type { PersonalActivity } from '@shared/types'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card } from '../components/ui'

export default function MyActivity(): JSX.Element {
  const toast = useAppStore((s) => s.toast)
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const [months, setMonths] = useState<6 | 12>(6)
  const [data, setData] = useState<PersonalActivity | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void load(months)
  }, [months]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (range: 6 | 12): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.gitmanager.getMyActivity(range)
      setData(result)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const stats = data?.stats
  const maxMonth = Math.max(1, ...(stats?.months.map((m) => Math.max(m.commits, m.branches)) ?? [1]))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{zh ? '个人活动' : 'My Activity'}</h1>
          <p className="mt-0.5 text-xs text-muted">{zh ? '我的提交、合并请求与统计' : 'My commits, merge requests and statistics'}</p>
        </div>
        <div className="flex gap-2">
          {([6, 12] as const).map((value) => (
            <button
              key={value}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                months === value ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
              }`}
              onClick={() => setMonths(value)}
            >
              {value === 6 ? (zh ? '最近半年' : 'Last 6 months') : (zh ? '最近一年' : 'Last 12 months')}
            </button>
          ))}
          <button className="btn btn-primary" disabled={busy} onClick={() => void load(months)}>
            <Activity size={14} /> {zh ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted"><GitCommitHorizontal size={14} /> {zh ? '提交次数' : 'Commits'}</div>
          <div className="mt-1 text-2xl font-bold text-canvas-fg">{stats?.commitCount ?? 0}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">{zh ? '新增 / 删除行' : 'Added / Removed'}</div>
          <div className="mt-1 text-2xl font-bold text-canvas-fg">
            <span className="text-ok">{stats?.linesAdded ?? 0}</span>
            <span className="mx-1 text-muted">/</span>
            <span className="text-danger">{stats?.linesRemoved ?? 0}</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted"><GitBranch size={14} /> {zh ? '创建分支' : 'Branches'}</div>
          <div className="mt-1 text-2xl font-bold text-canvas-fg">{stats?.branchCount ?? 0}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted"><GitMerge size={14} /> {zh ? '合规 / 违规' : 'Valid / Invalid'}</div>
          <div className="mt-1 text-2xl font-bold text-canvas-fg">
            <span className="text-ok">{stats?.validBranches ?? 0}</span>
            <span className="mx-1 text-muted">/</span>
            <span className="text-danger">{stats?.invalidBranches ?? 0}</span>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="mb-4 text-sm font-semibold text-canvas-fg">{zh ? '按月分布' : 'Monthly Distribution'}</div>
        <div className="flex h-32 items-end gap-1.5">
          {stats?.months.map((m) => (
            <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full items-end justify-center gap-0.5">
                <div className="w-2 rounded-t bg-primary" style={{ height: `${(m.commits / maxMonth) * 100}%`, minHeight: m.commits ? 4 : 0 }} title={`${m.month}: ${m.commits}`} />
                <div className="w-2 rounded-t bg-secondary" style={{ height: `${(m.branches / maxMonth) * 100}%`, minHeight: m.branches ? 4 : 0 }} title={`${m.month}: ${m.branches}`} />
              </div>
              <span className="text-[9px] text-muted">{m.month.slice(5)}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '我的提交' : 'My Commits'}</div>
          <div className="max-h-80 space-y-2 overflow-auto pr-1">
            {data?.commits.length === 0 ? <div className="text-xs text-muted">{zh ? '暂无提交记录' : 'No commits yet'}</div> : null}
            {data?.commits.map((c) => (
              <a key={`${c.repositoryId}-${c.sha}`} href={c.webUrl ?? '#'} target="_blank" rel="noreferrer" className="block rounded-md border border-line bg-elevated px-3 py-2 hover:border-primary/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-canvas-fg">{c.subject}</span>
                  <Badge tone="default">{c.shortSha}</Badge>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                  <span className="truncate">{c.repositoryName}</span>
                  <span>{new Date(c.committedAt).toLocaleString()}</span>
                </div>
              </a>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 text-sm font-semibold text-canvas-fg">{zh ? '我的合并请求' : 'My Merge Requests'}</div>
          <div className="max-h-80 space-y-2 overflow-auto pr-1">
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
    </div>
  )
}
