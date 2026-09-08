/**
 * CommandPalette — Grouped, keyboard-navigable, fluid open/close.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity, Bell, CalendarClock, FileBarChart, FolderGit2, GitBranch,
  LayoutDashboard, ScrollText, Settings, ShieldCheck, Tags, Command, Plus
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { motion as motionToken, shadow, radius } from '../design-system/tokens'

interface PaletteItem {
  id: string
  group: string
  label: string
  icon: typeof LayoutDashboard
  action: string
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function CommandPalette({ open, onClose }: Props): JSX.Element | null {
  const navigate = useNavigate()
  const setScanning = useAppStore((s) => s.setScanning)
  const setProgress = useAppStore((s) => s.setProgress)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const language = useAppStore((s) => s.language)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const items: PaletteItem[] = useMemo(() => {
    const zh = language === 'zh'
    return [
      // Navigation
      { id: 'nav-dash', group: zh ? '导航' : 'Navigation', label: zh ? '打开仪表盘' : 'Open Dashboard', icon: LayoutDashboard, action: 'nav:/' },
      { id: 'nav-repos', group: zh ? '导航' : 'Navigation', label: zh ? '打开仓库' : 'Open Repositories', icon: FolderGit2, action: 'nav:/repositories' },
      { id: 'nav-branches', group: zh ? '导航' : 'Navigation', label: zh ? '打开分支' : 'Open Branches', icon: GitBranch, action: 'nav:/branches' },
      // Actions
      { id: 'act-run', group: zh ? '操作' : 'Actions', label: zh ? '立即巡检' : 'Run Inspection', icon: Activity, action: 'runCheck' },
      { id: 'act-report', group: zh ? '操作' : 'Actions', label: zh ? '生成报告' : 'Generate Report', icon: FileBarChart, action: 'report' },
      { id: 'nav-naming', group: zh ? '操作' : 'Actions', label: zh ? '打开命名规则' : 'Open Naming Rules', icon: Tags, action: 'nav:/naming-rules' },
      { id: 'nav-whitelist', group: zh ? '操作' : 'Actions', label: zh ? '打开白名单' : 'Open Whitelist', icon: ShieldCheck, action: 'nav:/whitelist' },
      { id: 'nav-scheduler', group: zh ? '操作' : 'Actions', label: zh ? '打开定时调度' : 'Open Scheduler', icon: CalendarClock, action: 'nav:/scheduler' },
      // Settings
      { id: 'nav-audit', group: zh ? '系统' : 'System', label: zh ? '打开审计日志' : 'Open Audit Log', icon: ScrollText, action: 'nav:/audit' },
      { id: 'nav-settings', group: zh ? '系统' : 'System', label: zh ? '打开设置' : 'Open Settings', icon: Settings, action: 'nav:/settings' }
    ]
  }, [language])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return items
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
  }, [items, query])

  // Grouped display
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteItem[]>()
    for (const item of filtered) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return Array.from(map.entries())
  }, [filtered])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  const runAction = async (action: string): Promise<void> => {
    onClose()
    if (action.startsWith('nav:')) {
      navigate(action.slice(4))
      return
    }
    if (action === 'runCheck') {
      setScanning(true)
      try {
        const run = await window.branchpulse.runCheckNow({ bypassEnabledCheck: true, trigger: 'manual' })
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

  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter' && filtered[selected]) {
      e.preventDefault()
      void runAction(filtered[selected].action)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  useEffect(() => {
    // Scroll selected into view
    const el = listRef.current?.querySelector(`[data-idx="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-28"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: motionToken.normal.duration }}
          onClick={onClose}
        >
          <motion.div
            className="w-[480px] overflow-hidden border border-line bg-surface"
            style={{ borderRadius: radius.dialog, boxShadow: shadow.xl }}
            initial={{ opacity: 0, scale: 0.96, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 3 }}
            transition={{ duration: motionToken.normal.duration, ease: motionToken.normal.ease }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Input */}
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Command size={15} className="text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                className="flex-1 bg-transparent text-sm text-canvas-fg outline-none placeholder:text-muted"
                placeholder={language === 'zh' ? '搜索 BranchPulse...' : 'Search BranchPulse...'}
              />
            </div>
            {/* Results */}
            <div ref={listRef} className="max-h-72 overflow-y-auto p-1.5">
              {grouped.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted">{language === 'zh' ? '没有匹配结果' : 'No results'}</div>
              ) : (
                grouped.map(([group, groupItems]) => (
                  <div key={group} className="mb-1">
                    <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted opacity-60">{group}</div>
                    {groupItems.map((item) => {
                      const globalIdx = filtered.indexOf(item)
                      const Icon = item.icon
                      const isActive = globalIdx === selected
                      return (
                        <button
                          key={item.id}
                          data-idx={globalIdx}
                          onClick={() => void runAction(item.action)}
                          onMouseEnter={() => setSelected(globalIdx)}
                          className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                            isActive ? 'bg-primary/10 text-primary' : 'text-muted'
                          }`}
                        >
                          <Icon size={15} />
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
            {/* Footer hint */}
            <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[10px] text-muted opacity-70">
              <span>↑↓ {language === 'zh' ? '选择' : 'Navigate'}</span>
              <span>↵ {language === 'zh' ? '执行' : 'Run'}</span>
              <span>Esc {language === 'zh' ? '关闭' : 'Close'}</span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
