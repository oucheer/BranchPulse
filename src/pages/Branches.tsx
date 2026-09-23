import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle, Bell, CheckCircle2, ChevronDown, Copy, Eye, GitBranch,
  FolderGit2, Mail, Maximize2, Minus, Plus, RefreshCw, Search, Shield, X, XCircle
} from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { matchPattern } from '../lib/protection'
import { Badge, Card, EmptyState } from '../components/ui'
import { stateLabel, stateTone, timeAgo } from '../lib/format'
import { motion as motionToken, shadow } from '../design-system/tokens'
import type { BranchSummary } from '@shared/types'

type IssueFilter = '' | 'stale' | 'invalid'

// The header row and every branch row share this exact column template, so the
// values under 分支创始人 / 类别 / 未提交 / 健康分 line up instead of drifting with
// the width of the neighbouring cell. Columns: checkbox · state dot · branch
// name · creator/email · category · idle days · health · protected · actions.
const ROW_GRID =
  'grid grid-cols-[0.875rem_0.375rem_minmax(0,1fr)_minmax(6rem,9rem)_4.5rem_4rem_2.75rem_2.5rem_6.75rem] items-center gap-2'

function matchesIssue(issue: Exclude<IssueFilter, ''>, branch: BranchSummary): boolean {
  if (issue === 'stale') return branch.stale
  return branch.naming.status === 'invalid'
}

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
  return 'rgb(var(--warn))'
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}

// ─── Branch Explorer Row ─────────────────────────────────────────────────────

function ExplorerRow({ b, selected, checked, onToggle, onSelect, onHover, onView, onNotify, protected_ }: {
  b: BranchSummary
  selected: boolean
  onSelect: () => void
  onHover: (v: boolean) => void
  onView: () => void
  onNotify: () => void
  protected_: boolean
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const cat = branchCategory(b.name)
  const sc = stateColor(b.state)
  const creatorName = b.creator.name && b.creator.name !== 'Unknown' ? b.creator.name : ''
  return (
    <div
      className={`group ${ROW_GRID} cursor-pointer border-b border-line/40 px-3 py-2 text-xs transition-colors last:border-0 ${
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
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono font-medium text-canvas-fg">{b.displayName}</span>
        {b.isHead ? <Badge tone="primary">HEAD</Badge> : null}
      </span>
      <span
        className="flex min-w-0 flex-col truncate text-[10px] leading-4 text-muted"
        title={[zh ? '分支创始人' : 'Branch creator', creatorName || '—', b.creator.email || (zh ? '邮箱未知' : 'Email unavailable')].join(' · ')}
      >
        <span className="truncate text-canvas-fg">{creatorName || '—'}</span>
        <span className="truncate font-mono">{b.creator.email || (zh ? '邮箱未知' : 'Email unavailable')}</span>
      </span>
      <span className="truncate text-[10px]" style={{ color: cat.color }}>{cat.label}</span>
      <span className="tabular-nums text-muted">{b.inactiveDays}d</span>
      <span
        className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
        style={{ background: `${sc}1A`, color: sc }}
      >
        {b.health.score}
      </span>
      <span className="flex items-center">{protected_ ? <Shield size={11} className="text-info" /> : null}</span>
      <div className="flex min-w-0 items-center gap-0.5">
        <button className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary/40 hover:text-primary" onClick={(e) => { e.stopPropagation(); onView() }} title={zh ? '查看' : 'View'}>
          <Eye size={11} /> {zh ? '查看' : 'View'}
        </button>
        <button className="rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-canvas-fg group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onNotify() }} title={zh ? '通知' : 'Notify'}><Bell size={12} /></button>
      </div>
    </div>
  )
}

// ─── Branch Details Drawer ──────────────────────────────────────────────────

function DetailsDrawer({ b, onClose, onNotify, protected_, loading }: {
  b: BranchSummary
  onClose: () => void
  onNotify: () => void
  protected_: boolean
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
      const result = await window.gitmanager.validateBranchName(b.name)
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
    { label: zh ? '分支创始人' : 'Creator', value: b.creator.name === 'Unknown' ? '—' : b.creator.name || '—' },
    { label: zh ? '分支创始人邮箱' : 'Creator email', value: b.creator.email || '—' },
    { label: zh ? '最后提交' : 'Last commit', value: formatDateTime(b.lastCommitAt) },
    { label: zh ? '最后提交哈希' : 'Commit SHA', value: b.lastCommitSha ? b.lastCommitSha.slice(0, 8) : '—' },
    { label: zh ? '最近提交人' : 'Last author', value: b.lastAuthor || '—' },
    { label: zh ? '创建时间' : 'Created', value: b.createdAt ? formatDateTime(b.createdAt) : '—' },
    { label: zh ? '提交数' : 'Commits', value: String(b.commitCount) },
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
            { label: zh ? '生命周期' : 'Lifecycle', ok: b.state === 'active', text: b.stale ? (zh ? `已停更 ${b.inactiveDays} 天` : `Inactive ${b.inactiveDays}d`) : stateLabel(b.state, language) }
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
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const whitelist = useAppStore((s) => s.whitelist)
  const protectedList = useAppStore((s) => s.protected)
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const zh = language === 'zh'

  const [search, setSearch] = useState('')
  // null = 查看全部勾选仓库；数组 = 只查看显式勾选的仓库（可多选，可为空）。
  const [repoFilterIds, setRepoFilterIds] = useState<string[] | null>(null)
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)
  const repoMenuRef = useRef<HTMLDivElement | null>(null)
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('')
  const [selectedBranch, setSelectedBranch] = useState<BranchSummary | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [hoveredBranch, setHoveredBranch] = useState<BranchSummary | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const noSelection = selectedRepositoryIds.length === 0
  const scopedRepositories = useMemo(
    () => repositories.filter((repository) => selectedRepositoryIds.includes(repository.id)),
    [repositories, selectedRepositoryIds]
  )
  // 勾选范围变化后，原来查看的仓库可能已不在范围内，必须摘掉，避免出现空白分区。
  useEffect(() => {
    setRepoFilterIds((prev) => {
      if (prev === null) return prev
      const next = prev.filter((id) => selectedRepositoryIds.includes(id))
      return next.length === prev.length ? prev : next
    })
  }, [selectedRepositoryIds])

  // 点击浮层外部关闭仓库多选面板。
  useEffect(() => {
    if (!repoMenuOpen) return
    const onClick = (event: MouseEvent): void => {
      if (repoMenuRef.current && !repoMenuRef.current.contains(event.target as Node)) setRepoMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [repoMenuOpen])

  const branchesInScope = useMemo(
    () => (noSelection ? [] : branches.filter((branch) => selectedRepositoryIds.includes(branch.repositoryId))),
    [branches, selectedRepositoryIds, noSelection]
  )
  // 先应用关键词与问题筛选（用于统计每个仓库的命中数量），再按仓库多选裁剪。
  const searchFiltered = useMemo(() => {
    let list = branchesInScope
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((b) => b.name.toLowerCase().includes(q) || b.displayName.toLowerCase().includes(q))
    }
    if (issueFilter) list = list.filter((b) => matchesIssue(issueFilter, b))
    return [...list].sort((a, b) => b.inactiveDays - a.inactiveDays)
  }, [branchesInScope, search, issueFilter])

  const filtered = useMemo(
    () => (repoFilterIds === null ? searchFiltered : searchFiltered.filter((b) => repoFilterIds.includes(b.repositoryId))),
    [searchFiltered, repoFilterIds]
  )

  /**
   * 多仓库时按仓库分区渲染：每个仓库有独立标题与分支列表，同名分支（两个仓库都有
   * `feature/x`）各自落在自己的分区里，绝不混排或合并计数。
   */
  const visibleRepositories = useMemo(
    () => (repoFilterIds === null
      ? scopedRepositories
      : scopedRepositories.filter((repository) => repoFilterIds.includes(repository.id))),
    [scopedRepositories, repoFilterIds]
  )
  const sections = useMemo(
    () => visibleRepositories.map((repository) => ({
      repository,
      branches: filtered.filter((branch) => branch.repositoryId === repository.id)
    })),
    [visibleRepositories, filtered]
  )

  const toggleRepoFilter = (id: string): void => {
    setRepoFilterIds((prev) => {
      const base = prev === null ? scopedRepositories.map((repository) => repository.id) : prev
      const next = base.includes(id) ? base.filter((entry) => entry !== id) : [...base, id]
      // 勾满全部仓库时回落成「全部勾选仓库」，保持默认态唯一。
      if (next.length === scopedRepositories.length) return null
      return next
    })
  }

  const attention = useMemo(() =>
    filtered
      .filter((b) => b.stale || b.naming.status === 'invalid')
      .sort((a, b) => b.inactiveDays - a.inactiveDays)
      .slice(0, 5),
    [filtered]
  )


  const branchKey = (b: BranchSummary): string => b.id + '-' + b.type
  const selectedBranches = branchesInScope.filter((b) => selectedIds.has(branchKey(b)))
  /**
   * 批量通知的数据源：勾选过分支时以勾选为准（可以跨仓库），否则用当前显示范围。
   * 单一仓库视图下就是该仓库的分支，多仓库视图下就是勾选仓库的全部分支。
   */
  const notifyTargets = selectedIds.size > 0 ? selectedBranches : filtered

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

  const applyIssueSelection = (issue: Exclude<IssueFilter, ''>): void => {
    setIssueFilter(current => (current === issue ? '' : issue))
    setSelectedIds(() => new Set(
      filtered
        .filter((b) => !isProtected(b) && matchesIssue(issue, b))
        .map(branchKey)
    ))
  }

  const notifyCreatorsBulk = async (pred: (b: BranchSummary) => boolean, label: string): Promise<void> => {
    if (!emailConfig?.enabled) { toast('邮件发送未启用，请先在设置中开启。', 'warn'); return }
    const targets = notifyTargets.filter(pred)
    if (targets.length === 0) { toast('没有符合条件的分支: ' + label, 'warn'); return }
    try {
      const r = await window.gitmanager.notifyBranchesEmail(targets)
      toast(r.message, r.sent > 0 ? 'success' : 'warn')
      void refresh()
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const notifySelfBulk = async (): Promise<void> => {
    if (!emailConfig?.enabled) { toast('邮件发送未启用，请先在设置中开启。', 'warn'); return }
    if (notifyTargets.length === 0) { toast('当前没有可通知的分支', 'warn'); return }
    try {
      const r = await window.gitmanager.notifySelfEmail(notifyTargets)
      toast(r.message, r.sent > 0 ? 'success' : 'warn')
      void refresh()
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const notifyStaleDisabled = issueFilter === 'invalid'
  const notifyInvalidDisabled = issueFilter === 'stale'

  const loadBranchDetails = async (branch: BranchSummary): Promise<void> => {
    setSelectedBranch(branch)
    setLoadingDetails(true)
    try {
      const detail = await window.gitmanager.getBranch({
        repositoryId: branch.repositoryId,
        name: branch.name,
        type: branch.type,
        remote: branch.remote
      }, selectedRepositoryIds)
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
    if (noSelection) { toast(zh ? '未选择仓库：请先勾选仓库' : 'No repository selected', 'warn'); return }
    setRefreshingAll(true)
    try {
      for (const repo of scopedRepositories) {
        await window.gitmanager.scanRepository(repo.id, true)
      }
      toast(zh ? `已刷新勾选的 ${scopedRepositories.length} 个仓库分支` : 'Selected repositories refreshed', 'success')
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRefreshingAll(false)
    }
  }

  const handleNotify = async (branch: BranchSummary): Promise<void> => {
    try {
      const results = await window.gitmanager.notifyBranch(branch)
      toast(`${results.length} ${zh ? '条通知已生成' : 'notifications generated'}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const isProtected = (b: BranchSummary): boolean => {
    const whitelisted = whitelist.some((entry) => matchPattern(entry.pattern, entry.type, b.name))
    const protectedByRule = protectedList.some((entry) => matchPattern(entry.pattern, entry.type, b.name))
    return b.protection.isDefault || b.protection.protected || b.protection.whitelisted || whitelisted || protectedByRule
  }

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
          disabled={refreshingAll || noSelection}
          title={noSelection ? (zh ? '未选择仓库：请先勾选仓库' : 'No repository selected') : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-primary/40 hover:text-canvas-fg disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshingAll ? 'animate-spin' : ''} />
          {zh ? '同步仓库' : 'Sync'}
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/* 按仓库查看：多选下拉，勾选哪几个仓库就只显示哪几个仓库的分支 */}
        <div ref={repoMenuRef} className="relative shrink-0">
          <button
            type="button"
            className="flex max-w-[18rem] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-canvas-fg transition-colors hover:border-primary/40 disabled:opacity-40"
            disabled={scopedRepositories.length === 0}
            onClick={() => setRepoMenuOpen((value) => !value)}
            title={zh ? '勾选要查看分支的仓库' : 'Pick the repositories to display'}
          >
            <FolderGit2 size={13} className="shrink-0 text-muted" />
            <span className="truncate">
              {repoFilterIds === null
                ? (zh ? `全部勾选仓库（${scopedRepositories.length}）` : `All selected (${scopedRepositories.length})`)
                : repoFilterIds.length === 0
                  ? (zh ? '未选择查看的仓库' : 'No repository picked')
                  : (zh ? `已选 ${repoFilterIds.length} 个仓库` : `${repoFilterIds.length} repositories`)}
            </span>
            <ChevronDown size={13} className="shrink-0 text-muted" />
          </button>
          {repoMenuOpen ? (
            <div className="absolute left-0 top-[calc(100%+0.375rem)] z-30 w-80 rounded-card border border-line bg-surface p-2 shadow-panel">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-xs font-medium text-muted">{zh ? '勾选要查看的仓库' : 'Repositories to display'}</span>
                <div className="flex gap-1">
                  <button className="btn px-2 py-0.5 text-[11px]" onClick={() => setRepoFilterIds(null)}>
                    {zh ? '全选' : 'All'}
                  </button>
                  <button className="btn px-2 py-0.5 text-[11px]" onClick={() => setRepoFilterIds([])}>
                    {zh ? '清空' : 'Clear'}
                  </button>
                </div>
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {scopedRepositories.map((repository) => {
                  const checked = repoFilterIds === null || repoFilterIds.includes(repository.id)
                  return (
                    <label
                      key={repository.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-canvas-fg transition-colors hover:bg-line/30"
                    >
                      <input
                        type="checkbox"
                        className="no-specular h-3.5 w-3.5 shrink-0 cursor-pointer accent-[rgb(var(--primary))]"
                        checked={checked}
                        onChange={() => toggleRepoFilter(repository.id)}
                      />
                      <span className="truncate" title={repository.name}>{repository.name}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted">
                        {branchesInScope.filter((branch) => branch.repositoryId === repository.id).length}
                      </span>
                    </label>
                  )
                })}
              </div>
              <div className="mt-2 border-t border-line px-1 pt-2 text-[11px] text-muted">
                {zh ? '每个仓库单独分区展示，同名分支互不覆盖。' : 'Each repository gets its own section.'}
              </div>
            </div>
          ) : null}
        </div>
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
        </div>
      </div>

      {noSelection ? (
        <div className="shrink-0 rounded-md border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">
          {zh
            ? '未选择仓库：请先在仓库页或顶栏勾选仓库，分支列表只显示勾选范围内的分支。'
            : 'No repository selected: choose repositories to scope the branch list.'}
        </div>
      ) : null}

      {/* Batch Actions Bar */}
      <Card className="shrink-0 border-danger/30 bg-danger/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={selectedIds.size > 0 ? 'text-sm font-semibold text-danger' : 'text-sm font-semibold text-muted'}>
              {selectedIds.size > 0
                ? (zh ? '已选中' : 'Selected') + ' ' + selectedIds.size + ' ' + (zh ? '个分支' : 'branches')
                : (zh ? '未选择分支' : 'No branches selected')}
            </span>
            <span className="text-xs text-muted">
              {selectedIds.size > 0
                ? (zh
                    ? `通知范围为已勾选的 ${selectedIds.size} 个分支（可跨仓库）`
                    : `Notifications cover the ${selectedIds.size} checked branches`)
                : (zh
                    ? `未勾选分支时，通知范围为当前显示的 ${notifyTargets.length} 个分支`
                    : `Without checked branches, notifications cover the ${notifyTargets.length} displayed branches`)}
            </span>
            <div className="flex-1" />
            <button
              className="btn text-xs"
              disabled={!emailConfig?.enabled || notifyTargets.length === 0}
              onClick={() => void notifySelfBulk()}
              title={zh ? '把当前通知范围内的分支汇总成一封邮件发给自己' : 'Send one summary email to self for the current scope'}
            >
              <Mail size={12} /> {zh ? '汇总通知给自己' : 'Notify self'}
            </button>
            <button
              className="btn text-xs"
              disabled={!emailConfig?.enabled || notifyStaleDisabled || notifyTargets.length === 0}
              onClick={() => void notifyCreatorsBulk((b) => b.stale, '已停更')}
              title={zh ? '通知当前范围内已停更分支的创始人（可跨仓库）' : 'Notify stale branch creators in the current scope'}
            >
              <Bell size={12} /> {zh ? '通知已停更分支创始人' : 'Notify stale creators'}
            </button>
            <button
              className="btn text-xs"
              disabled={!emailConfig?.enabled || notifyInvalidDisabled || notifyTargets.length === 0}
              onClick={() => void notifyCreatorsBulk((b) => b.naming.status === 'invalid', '命名不规范')}
              title={zh ? '通知当前范围内命名不规范分支的创始人（可跨仓库）' : 'Notify invalid-name branch creators in the current scope'}
            >
              <Bell size={12} /> {zh ? '通知命名不规范创始人' : 'Notify invalid creators'}
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
              <button
                className={`no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs transition-colors ${issueFilter === '' ? 'bg-primary/10 text-primary hover:border-primary/40' : 'text-muted hover:border-primary/40 hover:text-primary'}`}
                onClick={() => setIssueFilter('')}
              >{zh ? '所有分支' : 'All branches'}</button>
              {([
                { value: 'stale', label: zh ? '已停更' : 'Stale', tone: 'text-warn' },
                { value: 'invalid', label: zh ? '命名不规范' : 'Invalid name', tone: 'text-danger' }
              ] as const).map((item) => {
                const active = issueFilter === item.value
                return (
                  <button
                    key={item.value}
                    className={`no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs transition-colors ${active ? `${item.tone} ${item.tone === 'text-warn' ? 'bg-warn/10' : 'bg-danger/10'}` : `${item.tone} hover:border-line hover:text-canvas-fg`}`}
                    onClick={() => applyIssueSelection(item.value)}
                  >{item.label}</button>
                )
              })}
              <button className="no-specular flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted transition-colors hover:border-line hover:text-canvas-fg" onClick={clearSelection}>{zh ? '清空' : 'Clear'}</button>
            </div>
            <span className="text-[10px] text-muted">{filtered.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className={`${ROW_GRID} sticky top-0 z-10 border-b border-line bg-surface-elevated px-3 py-1.5 text-[10px] text-muted`}>
              <span aria-hidden="true" />
              <span className="text-[10px]" title={zh ? '状态颜色' : 'State color'}>●</span>
              <span className="truncate text-[10px]">{zh ? '分支名' : 'Branch'}</span>
              <span className="truncate text-[10px]" title={zh ? '分支创始人和邮箱' : 'Branch creator and email'}>{zh ? '创始人 / 邮箱' : 'Creator / Email'}</span>
              <span className="truncate text-[10px]" title={zh ? '类别标签' : 'Category tag'}>{zh ? '类别' : 'Type'}</span>
              <span className="truncate text-[10px]" title={zh ? '距最后一次提交的天数' : 'Days since last commit'}>{zh ? '未提交' : 'Idle'}</span>
              <span className="truncate text-[10px]" title={zh ? '健康度评分 (0-100)' : 'Health score (0-100)'}>{zh ? '健康分' : 'Score'}</span>
              <span className="truncate text-[10px]" title={zh ? '受保护分支标记' : 'Protected branch marker'}>{zh ? '保护' : 'Prot'}</span>
              <span className="truncate text-[10px]">{zh ? '操作' : 'Actions'}</span>
            </div>
            {filtered.length === 0 ? (
              <div className="py-10 text-center">
                <div className="text-sm text-muted">
                  {repoFilterIds !== null && repoFilterIds.length === 0
                    ? (zh ? '未选择查看的仓库' : 'No repository picked')
                    : (zh ? '没有找到分支' : 'No branches found')}
                </div>
                <div className="mt-1 text-xs text-muted opacity-60">
                  {repoFilterIds !== null && repoFilterIds.length === 0
                    ? (zh ? '请在上方下拉框中勾选要查看分支的仓库' : 'Pick repositories in the dropdown above')
                    : (zh ? '当前过滤条件下没有匹配的分支' : 'Try adjusting filters')}
                </div>
                <button
                  onClick={() => {
                    if (repoFilterIds !== null && repoFilterIds.length === 0) setRepoFilterIds(null)
                    else { setSearch(''); setIssueFilter('') }
                  }}
                  className="mt-3 text-xs font-medium text-primary hover:underline"
                >
                  {repoFilterIds !== null && repoFilterIds.length === 0
                    ? (zh ? '显示全部勾选仓库' : 'Show all selected repositories')
                    : (zh ? '清除筛选' : 'Clear Filters')}
                </button>
              </div>
            ) : (
              sections.map(({ repository, branches: sectionBranches }) => (
                <div key={repository.id}>
                  {/* 每个仓库独立分区：同名分支各自归属，绝不混排或合并计数 */}
                  {scopedRepositories.length > 1 ? (
                    <div className="flex items-center gap-2 border-b border-line bg-line/20 px-3 py-1.5">
                      <FolderGit2 size={12} className="shrink-0 text-primary" />
                      <span className="truncate text-xs font-semibold text-canvas-fg" title={repository.name}>{repository.name}</span>
                      {selectedRepositoryIds.includes(repository.id) ? null : (
                        <span className="shrink-0 rounded-full bg-warn/10 px-1.5 text-[10px] text-warn">
                          {zh ? '未勾选' : 'Not selected'}
                        </span>
                      )}
                      <span className="shrink-0 tabular-nums text-[10px] text-muted">{sectionBranches.length}</span>
                    </div>
                  ) : null}
                  {sectionBranches.slice(0, 200).map((b) => (
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
                      protected_={isProtected(b)}
                    />
                  ))}
                  {sectionBranches.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-muted">
                      {zh ? '该仓库在当前筛选下没有分支' : 'No branches in this repository for the current filters'}
                    </div>
                  ) : null}
                </div>
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
              protected_={isProtected(selectedBranch)}
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
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.stale ? 'bg-warn' : 'bg-danger'}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-canvas-fg">{b.displayName}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{b.inactiveDays}d</span>
                <span className={`shrink-0 text-xs font-medium ${b.naming.status === 'invalid' ? 'text-danger' : 'text-warn'}`}>
                    {b.naming.status === 'invalid' ? (zh ? '命名不规范' : 'Violation') : stateLabel(b.state, language)}
                </span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

    </div>
  )
}



