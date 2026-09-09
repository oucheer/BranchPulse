import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, GitCommitHorizontal, GitMerge, ShieldCheck, Tag, Timer, User } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Ring } from '../components/ui'
import type { BranchCriteria, BranchSummary } from '@shared/types'
import { stateLabel, stateTone, timeAgo } from '../lib/format'

export default function BranchDetail(): JSX.Element {
  const { repositoryId = '', type = 'local', name = '' } = useParams()
  const branches = useAppStore((s) => s.branches)
  const monitoring = useAppStore((s) => s.monitoring)
  const navigate = useNavigate()
  const decodedName = name.replaceAll('~', '/')

  const cachedBranch = useMemo(
    () => branches.find((b) => b.repositoryId === repositoryId && b.type === type && b.name === decodedName),
    [branches, repositoryId, type, decodedName]
  )
  const [branch, setBranch] = useState(cachedBranch)

  useEffect(() => {
    let active = true
    void window.branchpulse
      .getBranch({ repositoryId, type: type as BranchCriteria['type'], name: decodedName })
      .then((result) => {
        if (active) setBranch(result ?? undefined)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [repositoryId, type, decodedName])

  if (!branch) {
    return (
      <div className="space-y-4">
        <button className="btn" onClick={() => navigate(-1)}><ArrowLeft size={14} /> {tr('back')}</button>
        <EmptyState title={tr('noBranches')} />
      </div>
    )
  }

  const metrics = [
    { label: tr('lastCommit'), value: timeAgo(branch.lastCommitAt), sub: branch.lastAuthor },
    { label: tr('inactiveDays'), value: `${branch.inactiveDays} 天` },
    { label: '分支年龄', value: `${branch.ageDays} 天` },
    { label: '提交数量', value: branch.commitCount },
    { label: '领先/落后', value: `${branch.ahead} / ${branch.behind}` },
    { label: '创建时间', value: timeAgo(branch.createdAt), sub: branch.creator.name }
  ]

  const protectionFacts = [
    { label: '已加白名单', value: branch.protection.whitelisted },
    { label: '默认分支', value: branch.protection.isDefault },
    { label: '已保护', value: branch.protection.protected }
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button className="btn px-2" onClick={() => navigate(-1)}><ArrowLeft size={14} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-lg font-bold text-canvas-fg">{branch.displayName}</h1>
            <Badge tone={stateTone(branch.state)}>{stateLabel(branch.state, 'en')}</Badge>
            <Badge tone={branch.type === 'local' ? 'secondary' : 'default'}>{branch.type}</Badge>
            {branch.isHead ? <Badge tone="primary">HEAD</Badge> : null}
            {branch.merged ? <Badge tone="info">{tr('merged')}</Badge> : null}
          </div>
          <div className="mt-1 text-xs text-muted">{branch.repositoryName} · scanned {timeAgo(branch.lastScannedAt)}</div>
        </div>
        <Ring score={branch.health.score} size={64} stroke={6} label="health" />
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Tag size={15} className="text-primary" /> {tr('overview')}
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('creator')}</span>
              <span className="flex items-center gap-1.5 text-canvas-fg"><User size={13} /> {branch.creator.name}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">创建者邮箱</span>
              <span className="max-w-[60%] truncate text-right font-mono text-xs text-canvas-fg" title={branch.creator.email || '未知'}>{branch.creator.email || '未知'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('firstCommit')}</span>
              <span className="text-xs text-canvas-fg">
                {branch.createdAt ? new Date(branch.createdAt).toLocaleString() : '未知'}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('lastCommit')}</span>
              <span className="text-xs text-canvas-fg">
                {branch.lastCommitAt ? new Date(branch.lastCommitAt).toLocaleString() : '未知'}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('inactiveDays')}</span>
              <span className="text-xs text-canvas-fg">{branch.inactiveDays} 天</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">可信度</span>
              <Badge tone={branch.creator.confidence === 'high' ? 'ok' : branch.creator.confidence === 'medium' ? 'warn' : 'default'}>
                {branch.creator.confidence === 'high' ? '高' : branch.creator.confidence === 'medium' ? '中' : branch.creator.confidence === 'low' ? '低' : '未知'}
              </Badge>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">基准分支</span>
              <span className="font-mono text-xs text-canvas-fg">{branch.baseBranch}</span>
            </div>
            {branch.mergedInto ? (
              <div className="flex justify-between gap-3">
                <span className="text-muted">{tr('merged')}到</span>
                <span className="font-mono text-xs text-ok">{branch.mergedInto}</span>
              </div>
            ) : null}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <GitCommitHorizontal size={15} className="text-secondary" /> {tr('gitMetrics')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {metrics.map((m) => (
              <div key={m.label} className="rounded-md border border-line bg-elevated px-3 py-2.5">
                <div className="text-[11px] uppercase tracking-normal text-muted">{m.label}</div>
                <div className="mt-0.5 text-sm font-semibold text-canvas-fg">{m.value}</div>
                {m.sub ? <div className="truncate text-[11px] text-muted">{m.sub}</div> : null}
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Timer size={15} className="text-warn" /> {tr('lifecycle')}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted">停更阈值</span>
              <span className="font-mono text-sm text-canvas-fg">{monitoring.staleThresholdDays} 天</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">提醒宽限期</span>
              <span className="font-mono text-sm text-canvas-fg">{branch.gracePeriodDays} 天</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">宽限期已结束</span>
              <Badge tone={branch.graceExpired ? 'danger' : 'ok'}>{branch.graceExpired ? '是' : '否'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">可清理候选</span>
              <Badge tone={branch.cleanupCandidate ? 'danger' : 'default'}>{branch.cleanupCandidate ? '是' : '否'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">首次提交</span>
              <span className="flex items-center gap-1 text-xs text-canvas-fg"><CalendarDays size={12} /> {timeAgo(branch.createdAt)}</span>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Tag size={15} className="text-info" /> {tr('naming')}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted">状态</span>
              <Badge tone={branch.naming.status === 'valid' ? 'ok' : branch.naming.status === 'excluded' ? 'default' : 'danger'}>
                {branch.naming.status === 'valid' ? '有效' : branch.naming.status === 'excluded' ? '不校验' : '无效'}
              </Badge>
            </div>
            {branch.naming.ruleName ? (
              <div className="flex items-center justify-between">
                <span className="text-muted">规则</span>
                <span className="text-sm text-canvas-fg">{branch.naming.ruleName}</span>
              </div>
            ) : null}
            {branch.naming.reason ? (
              <div className="rounded-md border border-line bg-elevated px-3 py-2 text-xs text-muted">{branch.naming.reason}</div>
            ) : null}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <ShieldCheck size={15} className="text-ok" /> {tr('protection')}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {protectionFacts.map((f) => (
              <div key={f.label} className="rounded-md border border-line bg-elevated px-3 py-2.5 text-center">
                <div className={`text-lg font-bold ${f.value ? 'text-ok' : 'text-muted'}`}>{f.value ? '开' : '关'}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-normal text-muted">{f.label}</div>
              </div>
            ))}
          </div>
          {branch.protection.rules.length ? (
            <div className="mt-3 space-y-1">
              {branch.protection.rules.map((rule) => (
                <div key={rule} className="truncate rounded-md border border-line px-3 py-1.5 font-mono text-xs text-muted">{rule}</div>
              ))}
            </div>
          ) : null}
        </Card>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Tag size={15} className="text-warn" /> 健康度计分原因
          </div>
          <div className="space-y-3">
            {branch.health.factors.map((factor) => (
              <div key={factor.label} className="flex items-center justify-between rounded-md border border-line bg-elevated px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-canvas-fg">{factor.label}（{factor.score}/{factor.weight}）</div>
                  <div className="mt-0.5 text-xs text-muted">{factor.detail}</div>
                </div>
                <div className={`ml-3 shrink-0 text-sm font-semibold ${factor.score >= factor.weight ? 'text-ok' : factor.score > 0 ? 'text-warn' : 'text-danger'}`}>
                  {factor.score >= factor.weight ? '满分' : factor.score > 0 ? `-${factor.weight - factor.score}` : `-${factor.weight}`}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <GitMerge size={15} className="text-primary" /> {tr('recentCommits')}
          </div>
          <div className="space-y-1">
            {branch.recentCommits.length ? (
              branch.recentCommits.map((commit) => (
                <div key={commit.sha} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-line/20">
                  <span className="font-mono text-[11px] text-secondary">{commit.shortSha}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-canvas-fg">{commit.subject}</span>
                  <span className="hidden text-xs text-muted sm:block">{commit.authorName}</span>
                  <span className="text-xs text-muted">{timeAgo(commit.committedAt)}</span>
                </div>
              ))
            ) : (
              <div className="py-6 text-center text-sm text-muted">暂未加载提交记录</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
