import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  Bell,
  CalendarClock,
  FileBarChart,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Tags,
  Command
} from 'lucide-react'
import LiquidLines from './components/LiquidLines'
import { tr, useAppStore } from './stores/appStore'

const nav: { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean }[] = [
  { to: '/', label: 'dashboard', icon: LayoutDashboard, end: true },
  { to: '/repositories', label: 'repositories', icon: FolderGit2 },
  { to: '/branches', label: 'branches', icon: GitBranch },
  { to: '/monitoring', label: 'monitoring', icon: Activity },
  { to: '/naming-rules', label: 'namingRules', icon: Tags },
  { to: '/whitelist', label: 'whitelist', icon: ShieldCheck },
  { to: '/notifications', label: 'notifications', icon: Bell },
  { to: '/reports', label: 'reports', icon: FileBarChart },
  { to: '/scheduler', label: 'scheduler', icon: CalendarClock },
  { to: '/audit', label: 'auditLog', icon: ScrollText },
  { to: '/settings', label: 'settings', icon: Settings }
]

const commands = [
  { label: 'Run Check Now', action: 'runCheck', icon: Activity },
  { label: 'Generate Report', action: 'report', icon: FileBarChart },
  { label: 'Open Scheduler', action: 'nav:/scheduler', icon: CalendarClock },
  { label: 'Open Naming Rules', action: 'nav:/naming-rules', icon: Tags },
  { label: 'Open Whitelist', action: 'nav:/whitelist', icon: ShieldCheck },
  { label: 'Open Audit Log', action: 'nav:/audit', icon: ScrollText },
  { label: 'Open Settings', action: 'nav:/settings', icon: Settings }
]

export default function Layout({ children }: { children: ReactNode }): JSX.Element {
  const language = useAppStore((s) => s.language)
  const notifications = useAppStore((s) => s.notifications)
  const unread = notifications.filter((n) => !n.read).length
  const scanning = useAppStore((s) => s.scanning)
  const setScanning = useAppStore((s) => s.setScanning)
  const setProgress = useAppStore((s) => s.setProgress)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const unsub = window.branchpulse.onScanProgress((progress) => {
      setProgress(progress)
      if (progress.summary?.status === 'completed') {
        setScanning(false)
        void refresh()
        setTimeout(() => setProgress(null), 2500)
      }
    })
    return () => unsub()
  }, [refresh, setProgress, setScanning])

  const runCommand = async (action: string): Promise<void> => {
    setPaletteOpen(false)
    setQuery('')
    if (action.startsWith('nav:')) {
      navigate(action.slice(4))
      return
    }
    if (action === 'runCheck') {
      setScanning(true)
      try {
        const run = await window.branchpulse.runCheckNow({ trigger: 'manual' })
        toast(`Check complete: ${run.branches} branches analyzed`, 'success')
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        setScanning(false)
        void refresh()
      }
    } else if (action === 'report') {
      try {
        await window.branchpulse.generateReport('on-demand', 'html')
        toast('Report generated', 'success')
        void refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    }
  }

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="flex h-screen bg-canvas text-muted">
      <LiquidLines />
      <aside
        className="relative z-10 flex flex-col overflow-hidden border-r border-line bg-surface"
        style={{ width: 240, minWidth: 240, maxWidth: 240, height: '100vh' }}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-primary to-secondary">
            <GitBranch size={15} className="text-white" />
          </div>
          <div className="text-sm font-bold text-canvas-fg">BranchPulse</div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-4">
          <div className="space-y-1">
            {nav.map((item) => {
              const Icon = item.icon
              const active = item.end ? pathname === item.to : pathname.startsWith(item.to)
              return (
                <button
                  key={item.to}
                  onClick={() => navigate(item.to)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm ${
                    active ? 'bg-primary/10 text-primary' : 'text-muted'
                  }`}
                >
                  <Icon size={16} />
                  <span className="flex-1 text-left">{tr(item.label)}</span>
                  {item.to === '/notifications' && unread > 0 ? (
                    <span className="rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">{unread}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </nav>
        <div className="border-t border-line p-3 text-[11px] text-muted">
          <div className="mb-1 flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${scanning ? 'animate-pulse bg-primary' : 'bg-ok'}`} />
            {language === 'zh' ? '监控服务' : 'Monitoring service'}
          </div>
          <div className="opacity-70">BranchPulse v0.1.0</div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-5 backdrop-blur">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex w-72 items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-muted hover:border-primary/40"
          >
            <Search size={14} />
            <span>{language === 'zh' ? '搜索与命令...' : 'Search and commands...'}</span>
            <span className="ml-auto flex items-center gap-0.5 rounded border border-line px-1 text-[10px]">Ctrl K</span>
          </button>
          <div className="ml-auto flex items-center gap-2">
            {scanning ? (
              <span className="chip bg-primary/10 text-primary">
                <Activity size={12} className="animate-spin" /> {tr('running')}
              </span>
            ) : null}
            <button className="btn btn-ghost px-2" onClick={() => navigate('/notifications')} aria-label="Notifications">
              <Bell size={16} />
              {unread > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-danger" /> : null}
            </button>
          </div>
        </header>
        <main className="relative z-10 min-h-0 flex-1 overflow-auto p-6">{children}</main>
      </div>

      <AnimatePresence>
        {paletteOpen ? (
          <motion.div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-28"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPaletteOpen(false)}
          >
            <motion.div
              className="w-[480px] overflow-hidden rounded-card border border-line bg-surface shadow-panel"
              initial={{ y: -8, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -8, opacity: 0, scale: 0.98 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <Command size={16} className="text-muted" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && filtered[0]) void runCommand(filtered[0].action)
                  }}
                  className="flex-1 bg-transparent text-sm text-canvas-fg outline-none placeholder:text-muted"
                  placeholder={language === 'zh' ? '输入命令...' : 'Type a command...'}
                />
              </div>
              <div className="max-h-72 overflow-y-auto p-2">
                {filtered.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => void runCommand(c.action)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted hover:bg-line/30 hover:text-canvas-fg"
                  >
                    <c.icon size={15} />
                    {c.label}
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
