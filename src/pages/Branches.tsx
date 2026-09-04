import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Eye, Filter, Search, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, ConfirmCheckbox, EmptyState, Modal, Ring } from '../components/ui'
import { stateLabel, stateTone, timeAgo } from '../lib/format'
import type { BranchSummary, DeleteAuthSession, BranchType } from '@shared/types'

type DeleteTarget = { criteria: { repositoryId: string; name: string; type: BranchType; remote?: string }; session: DeleteAuthSession }

export default function Branches(): JSX.Element {
  const branches = useAppStore((s) => s.branches)
  const repositories = useAppStore((s) => s.repositories)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const settings = useAppStore((s) => s.settings)
  const navigate = useNavigate()

  const [search, setSearch] = useState('')
  const [repoFilter, setRepoFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [loadingBranch, setLoadingBranch] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const filtered = useMemo(() => {
    let list = branches
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((b) => b.name.toLowerCase().includes(q) || b.displayName.toLowerCase().includes(q))
    }
    if (repoFilter) list = list.filter((b) => b.repositoryId === repoFilter)
    else if (activeRepositoryId) list = list.filter((b) => b.repositoryId === activeRepositoryId)
    if (stateFilter) list = list.filter((b) => b.state === stateFilter)
    if (typeFilter) list = list.filter((b) => b.type === typeFilter)
    return list
  }, [branches, search, repoFilter, stateFilter, typeFilter, activeRepositoryId])

  const states = ['active', 'stale', 'grace_period', 'grace_expired'] as const

  const handleNotify = async (branch: BranchSummary): Promise<void> => {
    try {
      const results = await window.branchpulse.notifyBranch(branch)
      toast(`${results.length} notification${results.length === 1 ? '' : 's'} generated`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleBeginDelete = async (branch: BranchSummary, type: BranchType): Promise<void> => {
    setConfirmed(false)
    try {
      const session = await window.branchpulse.beginDelete({
        repositoryId: branch.repositoryId,
        name: branch.name,
        type
      })
      if (!session.decision.allowed) {
        toast(session.decision.message, 'warn')
        return
      }
      setDeleteTarget({
        criteria: { repositoryId: branch.repositoryId, name: branch.name, type, remote: branch.remote },
        session
      })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (!deleteTarget || !confirmed) return
    setDeleting(true)
    try {
      const result = await window.branchpulse.deleteBranch({
        authorization: {
          authorized: true,
          targetType: deleteTarget.criteria.type,
          repositoryId: deleteTarget.criteria.repositoryId,
          branch: deleteTarget.criteria.name,
          confirmationToken: deleteTarget.session.token,
          confirmed: true
        },
        confirmationToken: deleteTarget.session.token
      })
      if (result.ok) {
        toast(result.message, 'success')
      } else {
        toast(result.message, 'error')
      }
      setDeleteTarget(null)
      setConfirmed(false)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{tr('branches')}</h1>
        <div className="text-xs text-muted">{filtered.length} / {branches.length} branches</div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-8"
            placeholder={tr('search') + '...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="input w-auto" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
          <option value="">{tr('repositories')}</option>
          {repositories.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select className="input w-auto" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">{tr('state')}</option>
          {states.map((s) => <option key={s} value={s}>{stateLabel(s, 'en')}</option>)}
        </select>
        <select className="input w-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{tr('type')}</option>
          <option value="remote">Remote</option>
        </select>
        <Filter size={14} className="text-muted" />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={tr('noBranches')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-normal text-muted">
                <th className="px-4 py-3 font-medium">{tr('branch')}</th>
                <th className="px-4 py-3 font-medium">{tr('repository')}</th>
                <th className="px-4 py-3 font-medium">{tr('type')}</th>
                <th className="px-4 py-3 font-medium">{tr('state')}</th>
                <th className="px-4 py-3 font-medium">{tr('inactiveDays')}</th>
                <th className="px-4 py-3 font-medium">{tr('health')}</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((branch) => {
                const isProtected = branch.protection.protected || branch.protection.isDefault || branch.protection.whitelisted
                return (
                  <tr key={`${branch.id}-${branch.type}`} className="border-b border-line/50 last:border-0 hover:bg-surface/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium text-canvas-fg">{branch.displayName}</span>
                        {branch.isHead ? <Badge tone="primary">HEAD</Badge> : null}
                        {branch.merged ? <Badge tone="info">{tr('merged')}</Badge> : null}
                        {branch.naming.status === 'invalid' ? <Badge tone="danger">invalid</Badge> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">{branch.repositoryName}</td>
                    <td className="px-4 py-3">
                      <Badge tone={branch.type === 'local' ? 'secondary' : 'default'}>{branch.type}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={stateTone(branch.state)}>{stateLabel(branch.state, 'en')}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted">{branch.inactiveDays}d</td>
                    <td className="px-4 py-3">
                      <Ring score={branch.health.score} size={32} stroke={3} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          className="btn px-2 py-1 text-[11px]"
                          onClick={() => navigate(`/branches/${branch.repositoryId}/${branch.type}/${encodeURIComponent(branch.name.replaceAll('/', '~'))}`)}
                        >
                          <Eye size={13} /> {tr('view')}
                        </button>
                        <button
                          className="btn px-2 py-1 text-[11px]"
                          onClick={() => void handleNotify(branch)}
                        >
                          <Bell size={13} /> {tr('notify')}
                        </button>
                        <button
                          className="btn border-danger/30 px-2 py-1 text-[11px] text-danger hover:border-danger hover:text-danger"
                          disabled={!branch.existsLocally || isProtected || settings.deletionDisabled}
                          onClick={() => void handleBeginDelete(branch, 'local')}
                          title={isProtected ? tr('deleteDisabled') : undefined}
                        >
                          <Trash2 size={13} className="text-danger" /> {tr('deleteLocal')}
                        </button>
                        <button
                          className="btn border-danger/30 px-2 py-1 text-[11px] text-danger hover:border-danger hover:text-danger"
                          disabled={!branch.existsRemotely || isProtected || settings.deletionDisabled}
                          onClick={() => void handleBeginDelete(branch, 'remote')}
                          title={isProtected ? tr('deleteDisabled') : undefined}
                        >
                          <Trash2 size={13} className="text-danger" /> {tr('deleteRemote')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={deleteTarget !== null}
        title={tr('confirmDelete')}
        onClose={() => { setDeleteTarget(null); setConfirmed(false) }}
        footer={
          <div className="flex gap-2">
            <button className="btn" onClick={() => { setDeleteTarget(null); setConfirmed(false) }}>{tr('cancel')}</button>
            <button
              className="btn text-danger"
              disabled={!confirmed || deleting}
              onClick={() => void handleConfirmDelete()}
            >
              {deleting ? '...' : tr('confirmDelete')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="text-sm text-muted">
            {tr('branch')}: <span className="font-mono font-semibold text-canvas-fg">{deleteTarget?.criteria.name}</span> ({deleteTarget?.criteria.type})
          </div>
          <ConfirmCheckbox
            label={tr('understand')}
            checked={confirmed}
            onChange={setConfirmed}
          />
        </div>
      </Modal>
    </div>
  )
}
