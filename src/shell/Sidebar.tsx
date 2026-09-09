/**
 * Sidebar — Premium Developer Tool navigation.
 * Grouped sections, cursor proximity interaction, smooth active indicator.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity, Bell, CalendarClock, FileBarChart, FolderGit2,
  GitBranch, LayoutDashboard, ScrollText, Settings, ShieldCheck, Sparkles, Tags, GitMerge
} from 'lucide-react'
import { tr, useAppStore } from '../stores/appStore'
import { motion as motionToken, layout } from '../design-system/tokens'
import { isEffectOn, useEffectSettings } from '../lib/effects'
import DepthText from '../components/DepthText'

interface NavItem {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end?: boolean
}

interface NavSection {
  title: string
  items: NavItem[]
}

const sections: NavSection[] = [
  {
    title: 'WORKSPACE',
    items: [
      { to: '/', label: 'dashboard', icon: LayoutDashboard, end: true },
      { to: '/repositories', label: 'repositories', icon: FolderGit2 },
      { to: '/branches', label: 'branches', icon: GitBranch }
    ]
  },
  {
    title: 'GOVERNANCE',
    items: [
      { to: '/monitoring', label: 'monitoring', icon: Activity },
      { to: '/naming-rules', label: 'namingRules', icon: Tags },
      { to: '/whitelist', label: 'whitelist', icon: ShieldCheck }
    ]
  },
  {
    title: 'AUTOMATION',
    items: [
      { to: '/notifications', label: 'notifications', icon: Bell },
      { to: '/reports', label: 'reports', icon: FileBarChart },
      { to: '/scheduler', label: 'scheduler', icon: CalendarClock }
    ]
  },
  {
    title: 'SYSTEM',
    items: [
      { to: '/audit', label: 'auditLog', icon: ScrollText },
      { to: '/animation', label: 'animation', icon: Sparkles },
      { to: '/settings', label: 'settings', icon: Settings }
    ]
  }
]

const flatItems = sections.flatMap((s) => s.items)

export default function Sidebar(): JSX.Element {
  const language = useAppStore((s) => s.language)
  const notifications = useAppStore((s) => s.notifications)
  const scanning = useAppStore((s) => s.scanning)
  const effectSettings = useEffectSettings()
  const effectsEnabled = isEffectOn(effectSettings, 'depthText')
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const navRef = useRef<HTMLElement | null>(null)
  const [indicator, setIndicator] = useState({ top: 0, height: 0, visible: false })
  const [proximity, setProximity] = useState<Record<string, number>>({})
  const unread = notifications.filter((n) => !n.read).length

  const activeItem = flatItems.find((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))

  // Measure active item position for indicator
  useEffect(() => {
    if (!activeItem || !navRef.current) return
    const el = navRef.current.querySelector<HTMLButtonElement>(`[data-nav="${activeItem.to}"]`)
    if (!el) return
    setIndicator({ top: el.offsetTop, height: el.offsetHeight, visible: true })
  }, [activeItem, pathname])

  // Cursor proximity
  const onNavMouseMove = useCallback((e: React.MouseEvent) => {
    if (!navRef.current) return
    const navRect = navRef.current.getBoundingClientRect()
    const mouseY = e.clientY - navRect.top
    const next: Record<string, number> = {}
    navRef.current.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((el) => {
      const key = el.dataset.nav ?? ''
      const rect = el.getBoundingClientRect()
      const centerY = rect.top - navRect.top + rect.height / 2
      const dist = Math.abs(centerY - mouseY)
      // Proximity: 80–120px range, closest strongest
      const range = 100
      next[key] = dist > range ? 0 : 1 - dist / range
    })
    setProximity(next)
  }, [])

  const onNavMouseLeave = useCallback(() => setProximity({}), [])

  return (
    <aside
      className="relative z-10 flex flex-col overflow-hidden border-r border-line bg-surface"
      style={{ width: layout.sidebarWidth, minWidth: layout.sidebarWidth, maxWidth: layout.sidebarWidth, height: '100vh' }}
    >
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-primary to-secondary">
          <GitBranch size={15} className="text-white" />
        </div>
        {effectsEnabled ? (
          <DepthText
            text="BranchPulse"
            layers={12}
            depth={0.9}
            faceColor="rgb(var(--fg))"
            depthColor="rgb(var(--secondary))"
            tilt={6}
            smoothing={0.16}
            perspective={700}
            autoOrbit
            orbitSpeed={0.2}
            pointerTracking={false}
            fontSize="clamp(16px, 1.5vw, 21px)"
            fontWeight={800}
            shadow
          />
        ) : (
          <div className="text-sm font-bold text-canvas-fg">BranchPulse</div>
        )}
      </div>

      {/* Navigation */}
      <nav
        ref={navRef}
        className="relative flex-1 overflow-y-auto px-2 py-4"
        onMouseMove={onNavMouseMove}
        onMouseLeave={onNavMouseLeave}
      >
        {/* Active indicator rail */}
        <AnimatePresence>
          {indicator.visible ? (
            <motion.div
              className="absolute left-0 w-[3px] rounded-r-full bg-primary"
              initial={{ opacity: 0 }}
              animate={{ top: indicator.top, height: indicator.height, opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={motionToken.spring}
              style={{ marginLeft: 0 }}
            />
          ) : null}
        </AnimatePresence>

        {sections.map((section, sIdx) => (
          <div key={section.title} className={sIdx > 0 ? 'mt-5' : ''}>
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted opacity-60">
              {section.title}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon
                const active = activeItem?.to === item.to
                const p = proximity[item.to] ?? 0
                const iconScale = 1 + p * 0.05
                const textShift = p * 3
                const unreadBadge = item.to === '/notifications' && unread > 0
                return (
                  <button
                    key={item.to}
                    data-nav={item.to}
                    onClick={() => navigate(item.to)}
                    className={`relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                      active ? 'bg-primary/8 text-primary' : 'text-muted hover:text-canvas-fg'
                    }`}
                    style={{ paddingLeft: 12 + textShift }}
                  >
                    <Icon size={16} style={{ transform: `scale(${iconScale})`, transition: 'transform 150ms ease' }} />
                    <span className="flex-1 text-left">{tr(item.label)}</span>
                    {unreadBadge ? (
                      <span className="rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">{unread}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="shrink-0 border-t border-line p-3 text-[11px] text-muted">
        <div className="mb-1 flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${scanning ? 'animate-pulse bg-primary' : 'bg-ok'}`} />
          {language === 'zh' ? '监控服务' : 'Monitoring service'}
        </div>
        <div className="opacity-70">BranchPulse v0.1.0</div>
      </div>
    </aside>
  )
}
