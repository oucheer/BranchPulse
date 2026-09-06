import { useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useAppStore } from './stores/appStore'
import { Toasts } from './components/ui'
import ParticleText from './components/ParticleText'
import Layout from './Layout'
import Dashboard from './pages/Dashboard'
import Repositories from './pages/Repositories'
import Branches from './pages/Branches'
import BranchDetail from './pages/BranchDetail'
import Monitoring from './pages/Monitoring'
import NamingRules from './pages/NamingRules'
import Whitelist from './pages/Whitelist'
import Notifications from './pages/Notifications'
import Reports from './pages/Reports'
import Scheduler from './pages/Scheduler'
import Audit from './pages/Audit'
import Settings from './pages/Settings'

const pages = [
  { path: '/', element: <Dashboard /> },
  { path: '/repositories', element: <Repositories /> },
  { path: '/branches', element: <Branches /> },
  { path: '/branches/:repositoryId/:type/:name', element: <BranchDetail /> },
  { path: '/monitoring', element: <Monitoring /> },
  { path: '/naming-rules', element: <NamingRules /> },
  { path: '/whitelist', element: <Whitelist /> },
  { path: '/notifications', element: <Notifications /> },
  { path: '/reports', element: <Reports /> },
  { path: '/scheduler', element: <Scheduler /> },
  { path: '/audit', element: <Audit /> },
  { path: '/settings', element: <Settings /> }
]

export default function App(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const startupError = useAppStore((s) => s.startupError)
  const refresh = useAppStore((s) => s.refresh)
  const settings = useAppStore((s) => s.settings)
  const location = useLocation()
  const desktopAvailable = typeof window !== 'undefined' && Boolean(window.branchpulse)
  const [splashDone, setSplashDone] = useState(false)
  const [splashStartedAt] = useState(() => Date.now())

  useEffect(() => {
    const onPointerMove = (e: PointerEvent): void => {
      document.querySelectorAll<HTMLElement>('.btn').forEach((el) => {
        const rect = el.getBoundingClientRect()
        const x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 100
        const y = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 100
        el.style.setProperty('--specular-x', x + '%')
        el.style.setProperty('--specular-y', y + '%')
      })
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    return () => window.removeEventListener('pointermove', onPointerMove)
  }, [])

  useEffect(() => {
    if (!ready || splashDone) return
    const elapsed = Date.now() - splashStartedAt
    const remaining = Math.max(0, 2600 - elapsed)
    const timer = window.setTimeout(() => setSplashDone(true), remaining)
    return () => window.clearTimeout(timer)
  }, [ready, splashDone, splashStartedAt])

  useEffect(() => {
  if (desktopAvailable) void refresh()
  }, [desktopAvailable, refresh])

  useEffect(() => {
    const root = document.documentElement
    const resolvedTheme = settings.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : settings.theme
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.classList.toggle('light', resolvedTheme === 'light')
  }, [settings.theme])

  useEffect(() => {
    document.documentElement.style.colorScheme = settings.theme === 'system' ? '' : settings.theme
  }, [settings.theme])

  useEffect(() => {
    if (!ready || splashDone) return
    const elapsed = Date.now() - splashStartedAt
    const remaining = Math.max(0, 2600 - elapsed)
    const timer = window.setTimeout(() => setSplashDone(true), remaining)
    return () => window.clearTimeout(timer)
  }, [ready, splashDone, splashStartedAt])

  if (!desktopAvailable) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="text-center">
          <div className="mb-3 text-3xl font-bold text-primary">BranchPulse</div>
          <div className="text-sm text-muted">
            BranchPulse is a desktop application. Launch the installed app instead of opening this URL in a browser.
          </div>
        </div>
      </div>
    )
  }

  const showSplash = !splashDone
  if (showSplash && !startupError) {
    return (
      <div className="relative h-screen overflow-hidden bg-canvas">
        <div className="absolute inset-0">
          <ParticleText text="BranchPulse" onComplete={() => setSplashDone(true)} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-8 text-center">
          <div className="text-sm font-medium text-canvas-fg">Git branch lifecycle intelligence</div>
        </div>
      </div>
    )
  }

  if (startupError) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="text-center">
          <div className="mb-3 text-3xl font-bold text-primary">BranchPulse</div>
          <div className="text-sm text-danger">{startupError}</div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="text-center">
          <div className="mb-3 text-3xl font-bold text-primary">BranchPulse</div>
          <div className="text-sm text-muted">Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <Layout>
      <AnimatePresence mode="wait">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className="h-full overflow-auto"
        >
          <Routes location={location}>
            {pages.map((p) => (
              <Route key={p.path} path={p.path} element={p.element} />
            ))}
          </Routes>
        </motion.div>
      </AnimatePresence>
      <Toasts />
    </Layout>
  )
}
