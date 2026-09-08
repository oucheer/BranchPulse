import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle, Bell, CheckCircle2, ChevronDown, Copy, Eye, GitBranch, GitMerge,
  Mail, Maximize2, Minus, Plus, RefreshCw, Search, Shield, Trash2, X, XCircle
} from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, ConfirmCheckbox, EmptyState, Modal } from '../components/ui'
import { stateLabel, stateTone, timeAgo } from '../lib/format'
import { motion as motionToken, shadow } from '../design-system/tokens'
import type { BranchSummary, DeleteAuthSession, BranchType } from '@shared/types'

type DeleteTarget = { criteria: { repositoryId: string; name: string; type: BranchType; remote?: string }; session: DeleteAuthSession }

// ─── Branch type classification ─────────────────────────────────────────────

function branchCategory(name: string): { label: string; color: string } {
  const n = name.toLowerCase()
  if (n === 'main' || n === 'master' || n === 'develop' || n.startsWith('origin/main') || n.startsWith('origin/master') || n.startsWith('origin/develop')) return { label: 'Main', color: 'rgb(var(--primary))' }
  if (n.includes('feature/')) return { label: 'Feature', color: 'rgb(var(--secondary))' }
  if (n.includes('fix/') || n.includes('bugfix/')) return { label: 'Fix', color: 'rgb(var(--danger))' }
  if (n.includes('hotfix/')) return { label: 'Hotfix', color: 'rgb(var(--danger))' }
  if (n.includes('release/')) return { label: 'Release', color: 'rgb(var(--info))' }
  return { label: 'Other', color: 'rgb(var(--muted))' }
}

function stateColor(state: string): string {
  if (state === 'active') return 'rgb(var(--ok))'
  if (state === 'grace_period') return 'rgb(var(--warn))'
  if (state === 'grace_expired') return 'rgb(var(--danger))'
  return 'rgb(var(--warn))'
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}

// ─── Branch Explorer Row ─────────────────────────────────────────────────────

function ExplorerRow({ b, selected, checked, onToggle, onSelect, onHover, onView, onNotify, onDelete, protected_, deletionDisabled }: {
  b: BranchSummary
  selected: boolean
  onSelect: () => void
  onHover: (v: boolean) => void
  onView: () => void
  onNotify: () => void
  onDelete: () => void
  protected_: boolean
  deletionDisabled: boolean
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const cat = branchCategory(b.name)
  const sc = stateColor(b.state)
  return (
    <div
      className={`group flex cursor-pointer items-center gap-2 border-b border-line/40 px-3 py-2 text-xs transition-colors last:border-0 ${
        selected ? 'bg-primary/5' : 'hover:bg-surface/60'
      }`}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <input
        type="checkbox"
        className="no-specular h-3.5 w-3.5 shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 accent-[rgb(var(--danger))]"
        checked={checked}
        disabled={protected_}
        title={protected_ ? (zh ? '白名单/受保护分支不可勾选' : 'Protected branches cannot be selected') : undefined}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
      />
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: sc }} />
      <span className="min-w-0 flex-1 truncate font-mono font-medium text-canvas-fg">{b.displayName}</span>
      {b.isHead ? <Badge tone="primary">HEAD</Badge> : null}
      {b.merged ? <GitMerge size={11} className="shrink-0 text-secondary" /> : null}
      <span className="shrink-0 text-[10px]" style={{ color: cat.color }}>{cat.label}</span>
      <span className="shrink-0 tabular-nums text-muted">{b.inactiveDays}d</span>
      <span
        className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
        style={{ background: `${sc}1A`, color: sc }}
      >
        {b.health.score}
      </span>
      {protected_ ? <Shield size={11} className="shrink-0 text-info" /> : null}
      <div className="flex shrink-0 items-center gap-0.5">
        <button className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-primary" onClick={(e) => { e.stopPropagation(); onView() }} title={zh ? '查看' : 'View'}>
          <Eye size={11} /> {zh ? '查看' : 'View'}
        </button>
        <button className="rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-canvas-fg group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onNotify() }} title={zh ? '通知' : 'Notify'}><Bell size={12} /></button>
        <button
          className="rounded p-0.5 text-muted hover:text-danger disabled:opacity-30"
          disabled={protected_ || deletionDisabled}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title={protected_ ? (zh ? '受保护' : 'Protected') : zh ? '删除远程' : 'Delete remote'}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Branch Details Drawer ──────────────────────────────────────────────────

function DetailsDrawer({ b, onClose, onNotify, onDeleteBegin, protected_, deletionDisabled, deleting, loading }: {
  b: BranchSummary
  onClose: () => void
  onNotify: () => void
  onDeleteBegin: () => void
  protected_: boolean
  deletionDisabled: boolean
  deleting: boolean
  loading: boolean
}): JSX.Element {
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const toast = useAppStore((s) => s.toast)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<{ ok: boolean; reason?: string } | null>(null)
  const cat = branchCategory(b.name)
  const sc = stateColor(b.state)

  const handleValidate = async (): Promise<void> => {
    setValidating(true)
    setValidation(null)
    try {
      const result = await window.branchpulse.validateBranchName(b.name)
      setValidation({ ok: result.status === 'valid' || result.status === 'excluded', reason: result.reason })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setValidating(false)
    }
  }

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(b.name)
    toast(zh ? '已复制分支名' : 'Branch name copied', 'success')
  }

  const detailRows: { label: string; value: string; tone?: string }[] = [
    { label: zh ? '仓库' : 'Repository', value: b.repositoryName },
    { label: zh ? '类型' : 'Type', value: b.type === 'local' ? (zh ? '本地' : 'Local') : (zh ? '远程' : 'Remote') },
    { label: zh ? '类别' : 'Category', value: cat.label },
    { label: zh ? '状态' : 'Status', value: stateLabel(b.state, language) },
    { label: zh ? '健康度' : 'Health', value: `${b.health.score} / 100` },
    { label: zh ? '创建人' : 'Creator', value: b.creator.name || '—' },
    { label: zh ? '创建人邮箱' : 'Creator email', value: b.creator.email || '—' },
    { label: zh ? '最后提交' : 'Last commit', value: formatDateTime(b.lastCommitAt) },
    { label: zh ? '最后提交哈希' : 'Commit SHA', value: b.lastCommitSha ? b.lastCommitSha.slice(0, 8) : '—' },
    { label: zh ? '最近提交人' : 'Last author', value: b.lastAuthor || '—' },
    { label: zh ? '创建时间' : 'Created', value: b.createdAt ? formatDateTime(b.createdAt) : '—' },
    { label: zh ? '提交数' : 'Commits', value: String(b.commitCount) },
    { label: zh ? '合并状态' : 'Merge', value: b.merged ? (zh ? `已合并 → ${b.mergedInto ?? ''}` : `Merged → ${b.mergedInto ?? ''}`) : (zh ? '未合并' : 'Not merged') },
    { label: zh ? '保护' : 'Protection', value: protected_ ? (zh ? '受保护' : 'Protected') : (zh ? '未保护' : 'Unprotected') }
  ]

  return (
    <motion.div
      className="flex h-full flex-col border-l border-line bg-surface"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: motionToken.normal.duration, ease: motionToken.normal.ease }}
      style={{ minWidth: 0, overflow: 'hidden' }}
    >
      <div className="flex items-start justify-between border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold text-canvas-fg">{b.displayName}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
            <span style={{ color: cat.color }}>{cat.label}</span>
            <span className="text-muted">·</span>
            <span style={{ color: sc }}>{stateLabel(b.state, language)}</span>
            <span className="text-muted">·</span>
            <span className="font-semibold tabular-nums" style={{ color: sc }}>{b.health.score}</span>
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 rounded p-1 text-muted hover:text-canvas-fg"><X size={14} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Governance */}
        <div className="mb-3 space-y-1.5">
          {[
            { label: zh ? '命名' : 'Naming', ok: b.naming.status === 'valid' || b.naming.status === 'excluded', text: b.naming.status === 'valid' ? (zh ? '合规' : 'Compliant') : b.naming.status === 'excluded' ? (zh ? '排除' : 'Excluded') : (zh ? '违规' : 'Violation') },
            { label: zh ? '保护' : 'Protection', ok: protected_, text: protected_ ? (zh ? '受保护' : 'Protected') : (zh ? '未保护' : 'Unprotected') },
            { label: zh ? '生命周期' : 'Lifecycle', ok: b.state === 'active', text: b.stale ? (zh ? `停更 ${b.inactiveDays} 天` : `Inactive ${b.inactiveDays}d`) : b.merged ? (zh ? '已合并' : 'Merged') : stateLabel(b.state, language) }
          ].map((g) => (
            <div key={g.label} className="flex items-center justify-between rounded-md border border-line px-2.5 py-1.5 text-xs">
              <span className="text-muted">{g.label}</span>
              <span className={`flex items-center gap-1 font-medium ${g.ok ? 'text-ok' : 'text-warn'}`}>
                {g.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {g.text}
              </span>
            </div>
          ))}
        </div>

        {/* Naming detail */}
        {b.naming.status === 'invalid' && b.naming.reason ? (
          <div className="mb-3 rounded-md border border-danger/20 bg-danger/5 px-2.5 py-2 text-[11px] text-danger">
            <div className="font-medium">{zh ? '违规原因' : 'Violation reason'}</div>
            <div className="mt-0.5 opacity-80">{b.naming.reason}</div>
          </div>
        ) : null}

        {/* Details grid */}
        <div className="space-y-1">
          {detailRows.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-xs">
              <span className="text-muted">{r.label}</span>
              <span className="max-w-[55%] truncate text-right text-canvas-fg">{r.value}</span>
            </div>
          ))}
        </div>

      {/* Actions */}
        {/* Recent commits */}
        <div className="mt-3 rounded-md border border-line p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-canvas-fg">{zh ? '最近提交' : 'Recent Commits'}</span>
            {loading ? <RefreshCw size={11} className="animate-spin text-primary" /> : null}
          </div>
          {loading && b.recentCommits.length === 0 ? (
            <div className="space-y-1.5">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-line/50" />)}
            </div>
          ) : b.recentCommits.length === 0 ? (
            <div className="text-[11px] text-muted">{zh ? '暂无提交记录' : 'No recent commits'}</div>
          ) : (
            <div className="space-y-1.5">
              {b.recentCommits.slice(0, 5).map((commit) => (
                <div key={commit.sha} className="rounded bg-surface-elevated px-2 py-1.5">
                  <div className="truncate text-[11px] text-canvas-fg">{commit.subject}</div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted">
                    <span className="truncate">{commit.authorName || '—'}{commit.authorEmail ? ' · ' + commit.authorEmail : ''}</span>
                    <span className="shrink-0 font-mono">{commit.shortSha || commit.sha.slice(0, 8)}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted">{formatDateTime(commit.committedAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-3">
        <button className="btn px-2 py-1 text-[11px]" onClick={() => void handleValidate()} disabled={validating}>
          {validating ? '...' : (zh ? '验证' : 'Validate')}
        </button>
        <button className="btn px-2 py-1 text-[11px]" onClick={handleCopy}>
          <Copy size={11} /> {zh ? '复制' : 'Copy'}
        </button>
        <button className="btn px-2 py-1 text-[11px]" onClick={onNotify}>
          <Bell size={11} /> {zh ? '通知' : 'Notify'}
        </button>
        <button
          className="btn border-danger/30 px-2 py-1 text-[11px] text-danger hover:border-danger hover:text-danger"
          disabled={protected_ || deletionDisabled || deleting}
          onClick={onDeleteBegin}
          title={protected_ ? tr('deleteDisabled') : undefined}
        >
          <Trash2 size={11} /> {zh ? '删除' : 'Delete'}
        </button>
      </div>
      {validation ? (
        <div className={`mx-4 mb-3 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${validation.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
          {validation.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          {validation.ok ? (zh ? '命名合规' : 'Naming compliant') : validation.reason ?? (zh ? '命名不合规' : 'Naming violation')}
        </div>
      ) : null}
    </motion.div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Branches(): JSX.Element {
  const branches = useAppStore((s) => s.branches)
  const repositories = useAppStore((s) => s.repositories)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const settings = useAppStore((s) => s.settings)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const zh = language === 'zh'

  const [search, setSearch] = useState('')
  const [repoFilter, setRepoFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [issueFilter, setIssueFilter] = useState('')
  const [selectedBranch, setSelectedBranch] = useState<BranchSummary | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [hoveredBranch, setHoveredBranch] = useState<BranchSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleteTargets, setBatchDeleteTargets] = useState<DeleteTarget[]>([])
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)

  const effectiveRepo = repoFilter || activeRepositoryId || ''
  const filtered = useMemo(() => {
    let list = branches
    if (effectiveRepo) list = list.filter((b) => b.repositoryId === effectiveRepo)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((b) => b.name.toLowerCase().includes(q) || b.displayName.toLowerCase().includes(q))
    }
    if (stateFilter) list = list.filter((b) => b.state === stateFilter)
    if (issueFilter === 'stale') list = list.filter((b) => b.stale)
    else if (issueFilter === 'grace_expired') list = list.filter((b) => b.state === 'grace_expired')
    else if (issueFilter === 'invalid') list = list.filter((b) => b.naming.status === 'invalid')
    else if (issueFilter === 'merged') list = list.filter((b) => b.merged)
    return [...list].sort((a, b) => b.inactiveDays - a.inactiveDays)
  }, [branches, search, effectiveRepo, stateFilter, issueFilter])

  const attention = useMemo(() =>
    filtered
      .filter((b) => b.stale || b.naming.status === 'invalid' || b.state === 'grace_expired')
      .sort((a, b) => b.inactiveDays - a.inactiveDays)
      .slice(0, 5),
    [filtered]
  )


  const branchKey = (b: BranchSummary): string => b.id + '-' + b.type
  const selectedBranches = branches.filter((b) => selectedIds.has(branchKey(b)))

  const toggleSelect = (b: BranchSummary): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(branchKey(b))) next.delete(branchKey(b))
      else next.add(branchKey(b))
      return next
    })
  }

  const selectAllVisible = (): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
        filtered.filter((b) => !isProtected(b)).forEach((b) => next.add(branchKey(b)))
      return next
    })
  }

  const selectByFilter = (pred: (b: BranchSummary) => boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
        filtered.filter((b) => !isProtected(b) && pred(b)).forEach((b) => next.add(branchKey(b)))
      return next
    })
  }

  const clearSelection = (): void => setSelectedIds(new Set())

  const notifyCreatorsBulk = async (pred: (b: BranchSummary) => boolean, label: string): Promise<void> => {
    if (!emailConfig?.enabled) { toast('邮件发送未启用，请先在设置中开启。', 'warn'); return }
    const targets = selectedBranches.filter(pred)
    if (targets.length === 0) { toast('没有符合条件的分支: ' + label, 'warn'); return }
    try {
      const r = await window.branchpulse.notifyBranchesEmail(targets)
      toast(r.message, r.sent > 0 ? 'success' : 'warn')
      void refresh()
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const notifySelfBulk = async (): Promise<void> => {
    if (!emailConfig?.enabled) { toast('邮件发送未启用，请先在设置中开启。', 'warn'); return }
    if (selectedBranches.length === 0) { toast('请先勾选分支', 'warn'); return }
    try {
      const r = await window.branchpulse.notifySelfEmail(selectedBranches)
      toast(r.message, r.sent > 0 ? 'success' : 'warn')
      void refresh()
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const openBatchDelete = async (): Promise<void> => {
    const targets = selectedBranches.filter((b) => !isProtected(b))
    if (targets.length === 0) { toast('没有可删除的选中分支（受保护分支已跳过）', 'warn'); return }
    const sessions: DeleteTarget[] = []
    for (const b of targets) {
      try {
        const session = await window.branchpulse.beginDelete({ repositoryId: b.repositoryId, name: b.name, type: 'remote' })
        if (session.decision.allowed && session.token) {
          sessions.push({ criteria: { repositoryId: b.repositoryId, name: b.name, type: 'remote', remote: b.remote }, session })
        }
      } catch { /* skip */ }
    }
    if (sessions.length === 0) { toast('预检失败，没有可删除的分支', 'error'); return }
    setBatchDeleteTargets(sessions)
    setBatchConfirm(false)
    setBatchDeleteOpen(true)
  }

  const confirmBatchDelete = async (): Promise<void> => {
    if (!batchConfirm) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    for (const t of batchDeleteTargets) {
      try {
        const r = await window.branchpulse.deleteBranch({
          authorization: { authorized: true, targetType: t.criteria.type, repositoryId: t.criteria.repositoryId, branch: t.criteria.name, confirmationToken: t.session.token, confirmed: true },
          confirmationToken: t.session.token
        })
        if (r.ok) ok += 1
        else fail += 1
      } catch { fail += 1 }
    }
    toast('删除完成：成功 ' + ok + '，失败 ' + fail, fail === 0 ? 'success' : 'warn')
    setBatchDeleteOpen(false)
    setSelectedIds(new Set())
    setBatchConfirm(false)
    void refresh()
    setBatchBusy(false)
  }

  const states = ['active', 'grace_period', 'grace_expired'] as const

  const loadBranchDetails = async (branch: BranchSummary): Promise<void> => {
    setSelectedBranch(branch)
    setLoadingDetails(true)
    try {
      const detail = await window.branchpulse.getBranch({
        repositoryId: branch.repositoryId,
        name: branch.name,
        type: branch.type,
        remote: branch.remote
      })
      if (detail) {
        setSelectedBranch((prev) => (prev?.repositoryId === detail.repositoryId && prev?.name === detail.name ? detail : prev))
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setLoadingDetails(false)
    }
  }

  const handleRefreshAll = async (): Promise<void> => {
    setRefreshingAll(true)
    try {
      for (const repo of repositories) {
        await window.branchpulse.scanRepository(repo.id, true)
      }
      toast(zh ? '已从远程仓库刷新所有分支' : 'All branches refreshed', 'success')
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRefreshingAll(false)
    }
  }

  const handleNotify = async (branch: BranchSummary): Promise<void> => {
    try {
      const results = await window.branchpulse.notifyBranch(branch)
      toast(`${results.length} ${zh ? '条通知已生成' : 'notifications generated'}`, 'success')
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
      toast(result.message, result.ok ? 'success' : 'error')
      setDeleteTarget(null)
      setConfirmed(false)
      setSelectedBranch(null)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setDeleting(false)
    }
  }

  const isProtected = (b: BranchSummary): boolean => b.protection.protected || b.protection.isDefault || b.protection.whitelisted

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('branches')}</h1>
          <p className="mt-0.5 text-xs text-muted">{zh ? '查看和管理仓库分支' : 'Visualize and manage repository branches'}</p>
        </div>
        <button
          onClick={() => void handleRefreshAll()}
          disabled={refreshingAll}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-primary/40 hover:text-canvas-fg disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshingAll ? 'animate-spin' : ''} />
          {zh ? '同步仓库' : 'Sync'}
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          value={effectiveRepo}
          onChange={(e) => setRepoFilter(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-canvas-fg outline-none transition-colors focus:border-primary/50"
        >
          <option value="">{zh ? '所有仓库' : 'All repositories'}</option>
          {repositories.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="relative flex-1 min-w-40" style={{ maxWidth: 280 }}>
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={zh ? '搜索分支...' : 'Search branches...'}
            className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-3 text-xs text-canvas-fg outline-none transition-colors placeholder:text-muted focus:border-primary/50"
          />
          {search ? (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-canvas-fg"><X size={12} /></button>
      ) : null}

      {/* Delete Modal */}
      <Modal
        open={deleteTarget !== null}
        title={tr('confirmDelete')}
        onClose={() => { setDeleteTarget(null); setConfirmed(false) }}
        footer={
          <div className="flex gap-2">
            <button className="btn" onClick={() => { setDeleteTarget(null); setConfirmed(false) }}>{tr('cancel')}</button>
            <button className="btn text-danger" disabled={!confirmed || deleting} onClick={() => void handleConfirmDelete()}>
              {deleting ? '...' : tr('confirmDelete')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="text-sm text-muted">
            {tr('branch')}: <span className="font-mono font-semibold text-canvas-fg">{deleteTarget?.criteria.name}</span> ({deleteTarget?.criteria.type})
          </div>
          <ConfirmCheckbox label={tr('understand')} checked={confirmed} onChange={setConfirmed} />
        </div>
      </Modal>

      {/* Batch Delete Modal */}
      <Modal
        open={batchDeleteOpen}
        title={zh ? '批量删除分支' : 'Batch Delete Branches'}
        onClose={() => { setBatchDeleteOpen(false); setBatchConfirm(false) }}
        footer={
          <div className="flex gap-2">
            <button className="btn" onClick={() => { setBatchDeleteOpen(false); setBatchConfirm(false) }}>{tr('cancel')}</button>
            <button
              className="btn border-danger/40 bg-danger text-white hover:opacity-90"
              disabled={!batchConfirm || batchBusy}
              onClick={() => void confirmBatchDelete()}
            >
              {batchBusy ? '...' : (zh ? '确认删除' : 'Delete')}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="text-sm font-semibold text-danger">
            {zh ? '即将删除以下' : 'About to delete'} {batchDeleteTargets.length} {zh ? '个远程分支：' : 'remote branches:'}
          </div>
          <div className="max-h-48 overflow-y-auto rounded-md border border-line px-3 py-2">
            {batchDeleteTargets.map((t) => (
              <div key={t.criteria.repositoryId + t.criteria.name} className="py-1 font-mono text-xs text-canvas-fg">
                {t.criteria.name}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">
            {zh ? '此操作不可恢复，受保护分支已自动跳过。请确认列表中的分支可以安全删除。' : 'This action cannot be undone. Protected branches are skipped automatically.'}
          </p>
          <ConfirmCheckbox label={tr('understand')} checked={batchConfirm} onChange={setBatchConfirm} />
        </div>
      </Modal>
    </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-canvas-fg outline-none transition-colors focus:border-primary/50"
        >
          <option value="">{zh ? '所有状态' : 'All states'}</option>
          {states.map((s) => <option key={s} value={s}>{stateLabel(s, language)}</option>)}
        </select>
        <select
          value={issueFilter}
          onChange={(e) => setIssueFilter(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-canvas-fg outline-none transition-colors focus:border-primary/50"
        >
          <option value="">{zh ? '所有问题' : 'All issues'}</option>
          <option value="stale">{zh ? '过期分支' : 'Stale branches'}</option>
          <option value="grace_expired">{zh ? '宽限到期' : 'Grace expired'}</option>
          <option value="invalid">{zh ? '命名不规范' : 'Invalid names'}</option>
          <option value="merged">{zh ? '已合并' : 'Merged'}</option>
        </select>
        <div className="text-xs tabular-nums text-muted">
          {filtered.length} / {branches.length} {zh ? '分支' : 'branches'}
        </div>
      </div>

      {/* Batch Actions Bar */}
        <Card className="shrink-0 border-danger/30 bg-danger/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={selectedIds.size > 0 ? 'text-sm font-semibold text-danger' : 'text-sm font-semibold text-muted'}>
              {selectedIds.size > 0
                ? (zh ? '已选中' : 'Selected') + ' ' + selectedIds.size + ' ' + (zh ? '个分支' : 'branches')
                : (zh ? '未选择分支' : 'No branches selected')}
            </span>
            <div className="flex-1" />
            <button
              className="btn text-xs"
              disabled={batchBusy || !emailConfig?.enabled}
              onClick={() => void notifySelfBulk()}
              title={zh ? '将选中分支信息汇总通知给自己' : 'Notify self with summary'}
            >
              <Mail size={12} /> {zh ? '汇总通知给自己' : 'Notify self'}
            </button>
            <button
              className="btn text-xs"
              disabled={batchBusy || !emailConfig?.enabled}
              onClick={() => void notifyCreatorsBulk((b) => b.stale, '过期')}
              title={zh ? '通知选中的过期分支创始人' : 'Notify stale branch creators'}
            >
              <Bell size={12} /> {zh ? '通知过期分支创始人' : 'Notify stale creators'}
            </button>
            <button
              className="btn text-xs"
              disabled={batchBusy || !emailConfig?.enabled}
              onClick={() => void notifyCreatorsBulk((b) => b.naming.status === 'invalid', '命名不规范')}
              title={zh ? '通知选中的命名不规范分支创始人' : 'Notify invalid-name branch creators'}
            >
              <Bell size={12} /> {zh ? '通知命名不规范创始人' : 'Notify invalid creators'}
            </button>
            <button
              className="btn border-danger/40 bg-danger/10 text-xs font-semibold text-danger hover:bg-danger/20"
              disabled={batchBusy || settings.deletionDisabled}
              onClick={() => void openBatchDelete()}
              title={zh ? '删除选中的分支' : 'Delete selected branches'}
            >
              <Trash2 size={12} /> {zh ? '一键删除' : 'Delete selected'}
            </button>
          </div>
        </Card>

      {/* Workspace: Explorer + Details */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
        <Card className="flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold text-canvas-fg">{zh ? '分支列表' : 'Branch Explorer'}</span>
            <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs">
              <span className="tabular-nums text-muted">{selectedIds.size} {zh ? '已选' : 'selected'}</span>
              <button className="no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-primary transition-colors hover:border-primary/40 hover:bg-primary/5" onClick={selectAllVisible}>{zh ? '全选' : 'All'}</button>
              <button className="no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-warn transition-colors hover:border-warn/40 hover:bg-warn/5" onClick={() => selectByFilter((b) => b.stale)}>{zh ? '过期分支' : 'Stale'}</button>
              <button className="no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-warn transition-colors hover:border-warn/40 hover:bg-warn/5" onClick={() => selectByFilter((b) => b.state === 'grace_expired')}>{zh ? '宽限到期' : 'Expired'}</button>
              <button className="no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-danger transition-colors hover:border-danger/40 hover:bg-danger/5" onClick={() => selectByFilter((b) => b.naming.status === 'invalid')}>{zh ? '命名不规范' : 'Invalid name'}</button>
              <button className="no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted transition-colors hover:border-line hover:text-canvas-fg" onClick={clearSelection}>{zh ? '清空' : 'Clear'}</button>
            </div>
            <span className="text-[10px] text-muted">{filtered.length}</span>
          </div>
          <div className="flex items-center gap-2 border-b border-line bg-surface-elevated/50 px-3 py-1.5 text-[10px] text-muted">
            <span className="shrink-0 text-[10px]" title={zh ? '状态颜色' : 'State color'}>●</span>
            <span className="min-w-0 flex-1 truncate text-[10px]">{zh ? '分支名' : 'Branch'}</span>
            <span className="shrink-0 text-[10px]" title={zh ? '类别标签' : 'Category tag'}>{zh ? '类别' : 'Type'}</span>
            <span className="shrink-0 text-[10px]" title={zh ? '距最后一次提交的天数' : 'Days since last commit'}>{zh ? '停更' : 'Idle'}</span>
            <span className="shrink-0 text-[10px]" title={zh ? '健康度评分 (0-100)' : 'Health score (0-100)'}>{zh ? '健康分' : 'Score'}</span>
            <span className="shrink-0 text-[10px]" title={zh ? '受保护分支标记' : 'Protected branch marker'}>{zh ? '保护' : 'Prot'}</span>
            <div className="flex shrink-0 items-center gap-0.5"><span className="text-[10px]">{zh ? '操作' : 'Actions'}</span></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-10 text-center">
                <div className="text-sm text-muted">{zh ? '没有找到分支' : 'No branches found'}</div>
                <div className="mt-1 text-xs text-muted opacity-60">{zh ? '当前过滤条件下没有匹配的分支' : 'Try adjusting filters'}</div>
                <button
                  onClick={() => { setSearch(''); setStateFilter(''); setIssueFilter('') }}
                  className="mt-3 text-xs font-medium text-primary hover:underline"
                >
                  {zh ? '清除筛选' : 'Clear Filters'}
                </button>
              </div>
            ) : (
              filtered.slice(0, 200).map((b) => (
                <ExplorerRow
                  key={`${b.id}-${b.type}`}
                  b={b}
                  selected={selectedBranch?.id === b.id}
                  checked={selectedIds.has(b.id + '-' + b.type)}
                  onToggle={() => toggleSelect(b)}
                  onSelect={() => navigate(`/branches/${b.repositoryId}/${b.type}/${encodeURIComponent(b.name.replaceAll('/', '~'))}`)}
                  onHover={(v) => setHoveredBranch(v ? b : null)}
                  onView={() => navigate(`/branches/${b.repositoryId}/${b.type}/${encodeURIComponent(b.name.replaceAll('/', '~'))}`)}
                  onNotify={() => void handleNotify(b)}
                  onDelete={() => void handleBeginDelete(b, 'remote')}
                  protected_={isProtected(b)}
                  deletionDisabled={settings.deletionDisabled}
                />
              ))
            )}
          </div>
        </Card>

        {/* Details Drawer */}
        <AnimatePresence mode="wait">
          {selectedBranch ? (
            <DetailsDrawer
              key={selectedBranch.id}
              b={selectedBranch}
              onClose={() => setSelectedBranch(null)}
              onNotify={() => void handleNotify(selectedBranch)}
              onDeleteBegin={() => void handleBeginDelete(selectedBranch, 'remote')}
              protected_={isProtected(selectedBranch)}
              deletionDisabled={settings.deletionDisabled}
              deleting={deleting}
              loading={loadingDetails}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {/* Attention */}
      {attention.length > 0 ? (
        <Card className="shrink-0 overflow-hidden p-4">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle size={14} className="text-warn" />
            <span className="text-sm font-semibold text-canvas-fg">{zh ? '需要关注' : 'Needs Attention'}</span>
            <span className="rounded-full bg-warn/10 px-1.5 text-[10px] font-semibold text-warn">{attention.length}</span>
          </div>
          <div className="max-h-32 space-y-1.5 overflow-y-auto pr-1">
            {attention.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelectedBranch(b)}
                className="flex w-full items-center gap-3 rounded-md border border-line px-3 py-2 text-left text-sm transition-colors hover:border-warn/40"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.state === 'grace_expired' ? 'bg-danger' : b.stale ? 'bg-warn' : 'bg-danger'}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-canvas-fg">{b.displayName}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{b.inactiveDays}d</span>
                <span className={`shrink-0 text-xs font-medium ${b.naming.status === 'invalid' ? 'text-danger' : 'text-warn'}`}>
                  {b.naming.status === 'invalid' ? (zh ? '命名违规' : 'Violation') : stateLabel(b.state, language)}
                </span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

    </div>
  )
}



