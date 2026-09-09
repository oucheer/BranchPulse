/**
 * Topbar — Clean command center search + notifications.
 */
import { useNavigate } from 'react-router-dom'
import { Bell, Activity, FolderGit2, Search } from 'lucide-react'
import { tr, useAppStore } from '../stores/appStore'
import { layout, shadow } from '../design-system/tokens'

export default function Topbar({ onOpenPalette }: { onOpenPalette: () => void }): JSX.Element {
  const language = useAppStore((s) => s.language)
  const notifications = useAppStore((s) => s.notifications)
  const scanning = useAppStore((s) => s.scanning)
  const repositories = useAppStore((s) => s.repositories)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const setActiveRepositoryId = useAppStore((s) => s.setActiveRepositoryId)
  const navigate = useNavigate()
  const unread = notifications.filter((n) => !n.read).length

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
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm" style={{ boxShadow: shadow.sm }}>
          <FolderGit2 size={14} className="shrink-0 text-muted" />
          <select
            className="max-w-[11rem] cursor-pointer bg-transparent text-sm text-canvas-fg outline-none"
            value={activeRepositoryId ?? ''}
            disabled={repositories.length === 0}
            onChange={(event) => void setActiveRepositoryId(event.target.value || null)}
            aria-label={language === 'zh' ? '切换仓库' : 'Switch repository'}
          >
            <option value="">{language === 'zh' ? '全部仓库' : 'All repositories'}</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.name}</option>
            ))}
          </select>
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
