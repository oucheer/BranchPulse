/**
 * Topbar — Clean command center search + notifications.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Activity, Check, ChevronDown, FolderGit2, Search } from 'lucide-react'
import { tr, useAppStore } from '../stores/appStore'
import { layout, shadow } from '../design-system/tokens'

export default function Topbar({ onOpenPalette }: { onOpenPalette: () => void }): JSX.Element {
  const language = useAppStore((s) => s.language)
  const notifications = useAppStore((s) => s.notifications)
  const scanning = useAppStore((s) => s.scanning)
  const repositories = useAppStore((s) => s.repositories)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const toggleRepositorySelection = useAppStore((s) => s.toggleRepositorySelection)
  const selectAllRepositories = useAppStore((s) => s.selectAllRepositories)
  const clearRepositorySelection = useAppStore((s) => s.clearRepositorySelection)
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const unread = notifications.filter((n) => !n.read).length
  const zh = language === 'zh'

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <header
      className="relative z-10 flex shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-5 backdrop-blur-sm"
      style={{ height: layout.topbarHeight }}
    >
      <button
        onClick={onOpenPalette}
        className="flex w-80 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-muted transition-all duration-150 hover:border-primary/40 hover:shadow-sm focus:border-primary/50 focus:outline-none"
        style={{ boxShadow: shadow.sm }}
      >
        <Search size={14} />
        <span>{language === 'zh' ? '搜索与命令...' : 'Search and commands...'}</span>
        <span className="ml-auto flex items-center gap-0.5 rounded border border-line px-1.5 text-[10px]">Ctrl K</span>
      </button>
      <div className="ml-auto flex items-center gap-2">
        <div ref={panelRef} className="relative flex min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" style={{ boxShadow: shadow.sm }}>
          <FolderGit2 size={14} className="shrink-0 text-muted" />
          <button
            className="flex max-w-[13rem] cursor-pointer items-center gap-1 bg-transparent text-sm text-canvas-fg outline-none disabled:cursor-default disabled:text-muted"
            disabled={repositories.length === 0}
            onClick={() => setOpen((value) => !value)}
            aria-label={zh ? '选择仓库范围' : 'Select repository scope'}
          >
            <span className="truncate">
              {repositories.length === 0
                ? (zh ? '暂无仓库' : 'No repositories')
                : selectedRepositoryIds.length === 0
                  ? (zh ? '未选择仓库' : 'No repositories selected')
                  : (zh ? `已选 ${selectedRepositoryIds.length} 个仓库` : `${selectedRepositoryIds.length} selected`)}
            </span>
            <ChevronDown size={13} className="shrink-0 text-muted" />
          </button>
          {open ? (
            <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-72 rounded-card border border-line bg-surface p-2 shadow-panel">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-xs font-medium text-muted">{zh ? '勾选仓库范围' : 'Repository scope'}</span>
                <div className="flex gap-1">
                  <button className="btn px-2 py-0.5 text-[11px]" onClick={() => void selectAllRepositories()} disabled={repositories.length === 0}>
                    {zh ? '全选' : 'All'}
                  </button>
                  <button className="btn px-2 py-0.5 text-[11px]" onClick={() => void clearRepositorySelection()} disabled={selectedRepositoryIds.length === 0}>
                    {zh ? '清空' : 'Clear'}
                  </button>
                </div>
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {repositories.map((repo) => {
                  const checked = selectedRepositoryIds.includes(repo.id)
                  return (
                    <button
                      key={repo.id}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-canvas-fg transition-colors hover:bg-line/30"
                      onClick={() => void toggleRepositorySelection(repo.id)}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-primary bg-primary text-white' : 'border-line'}`}>
                        {checked ? <Check size={11} /> : null}
                      </span>
                      <span className="truncate">{repo.name}</span>
                    </button>
                  )
                })}
              </div>
              <div className="mt-2 border-t border-line px-1 pt-2 text-[11px] text-muted">
                {zh ? '所有页面仅显示勾选仓库的数据。' : 'Every page shows only the selected repositories.'}
              </div>
            </div>
          ) : null}
        </div>
        {scanning ? (
          <span className="chip bg-primary/10 text-primary">
            <Activity size={12} className="animate-spin" /> {tr('running')}
          </span>
        ) : null}
        <button className="relative rounded-md p-1.5 text-muted transition-colors hover:bg-line/40 hover:text-canvas-fg" onClick={() => navigate('/notifications')} aria-label="Notifications">
          <Bell size={16} />
          {unread > 0 ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" /> : null}
        </button>
      </div>
    </header>
  )
}
