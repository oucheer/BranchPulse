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
    { label: tr('inactiveDays'), value: `${branch.inactiveDays}d` },
    { label: 'Age', value: `${branch.ageDays}d` },
    { label: 'Commits', value: branch.commitCount },
    { label: 'Ahead / behind', value: `${branch.ahead} / ${branch.behind}` },
    { label: 'Created', value: timeAgo(branch.createdAt), sub: branch.creator.name }
  ]

  const protectionFacts = [
    { label: 'Whitelisted', value: branch.protection.whitelisted },
    { label: 'Default branch', value: branch.protection.isDefault },
    { label: 'Protected', value: branch.protection.protected }
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
              <span className="text-muted">Creator email</span>
              <span className="font-mono text-xs text-canvas-fg">{branch.creator.email || 'unknown'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('firstCommit')}</span>
              <span className="text-xs text-canvas-fg">
                {branch.createdAt ? new Date(branch.createdAt).toLocaleString() : 'unknown'}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('lastCommit')}</span>
              <span className="text-xs text-canvas-fg">
                {branch.lastCommitAt ? new Date(branch.lastCommitAt).toLocaleString() : 'unknown'}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">{tr('inactiveDays')}</span>
              <span className="text-xs text-canvas-fg">{branch.inactiveDays}d</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Confidence</span>
              <Badge tone={branch.creator.confidence === 'high' ? 'ok' : branch.creator.confidence === 'medium' ? 'warn' : 'default'}>
                {branch.creator.confidence}
              </Badge>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Base branch</span>
              <span className="font-mono text-xs text-canvas-fg">{branch.baseBranch}</span>
            </div>
            {branch.mergedInto ? (
              <div className="flex justify-between gap-3">
                <span className="text-muted">{tr('merged')} into</span>
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
              <span className="text-muted">Stale threshold</span>
              <span className="font-mono text-sm text-canvas-fg">{monitoring.staleThresholdDays}d</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Grace period</span>
              <span className="font-mono text-sm text-canvas-fg">{branch.gracePeriodDays}d</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Grace expired</span>
              <Badge tone={branch.graceExpired ? 'danger' : 'ok'}>{branch.graceExpired ? 'yes' : 'no'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Cleanup candidate</span>
              <Badge tone={branch.cleanupCandidate ? 'danger' : 'default'}>{branch.cleanupCandidate ? 'yes' : 'no'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">First commit</span>
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
              <span className="text-muted">Status</span>
              <Badge tone={branch.naming.status === 'valid' ? 'ok' : branch.naming.status === 'excluded' ? 'default' : 'danger'}>
                {branch.naming.status}
              </Badge>
            </div>
            {branch.naming.ruleName ? (
              <div className="flex items-center justify-between">
                <span className="text-muted">Rule</span>
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
                <div className={`text-lg font-bold ${f.value ? 'text-ok' : 'text-muted'}`}>{f.value ? 'ON' : 'OFF'}</div>
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
              <div className="py-6 text-center text-sm text-muted">No commits loaded</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
