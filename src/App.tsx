import { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from './stores/appStore'
import { isEffectOn, useEffectSettings } from './lib/effects'
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
import Backups from './pages/Backups'
import Scheduler from './pages/Scheduler'
import Audit from './pages/Audit'
import Animation from './pages/Animation'
import Settings from './pages/Settings'
import Email from './pages/Email'
import Login from './pages/Login'
import MyActivity from './pages/MyActivity'
import CommitDetails from './pages/CommitDetails'
import PersonalAi from './pages/PersonalAi'
import MyTimeline from './pages/MyTimeline'

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
  { path: '/backup', element: <Backups /> },
  { path: '/scheduler', element: <Scheduler /> },
  { path: '/audit', element: <Audit /> },
  { path: '/animation', element: <Animation /> },
  { path: '/settings', element: <Settings /> },
  { path: '/email', element: <Email /> },
  { path: '/my-activity', element: <MyActivity /> },
  { path: '/my-timeline', element: <MyTimeline /> },
  { path: '/my-ai', element: <PersonalAi /> },
  { path: '/my-activity/commit/:repositoryId/:sha', element: <CommitDetails /> },
  { path: '/login', element: <Login /> }
]

export default function App(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const startupError = useAppStore((s) => s.startupError)
  const session = useAppStore((s) => s.session)
  const role = useAppStore((s) => s.role)
  const refresh = useAppStore((s) => s.refresh)
  const restoreSession = useAppStore((s) => s.restoreSession)
  const settings = useAppStore((s) => s.settings)
  // `tr()` reads language from the store without subscribing, so the root subscribes
  // to it and remounts the route tree below; otherwise pages that never read
  // `language` directly keep rendering stale strings after a language switch.
  const language = useAppStore((s) => s.language)
  const effectSettings = useEffectSettings()
  const effectsEnabled = isEffectOn(effectSettings, 'ambientBackground')
  const splashParticlesEnabled = isEffectOn(effectSettings, 'particleSplash')
  const location = useLocation()
  const navigate = useNavigate()
  const [splashDone, setSplashDone] = useState(false)
  const [splashStartedAt] = useState(() => Date.now())
  const lastPathname = useRef(location.pathname)
  const restoredRoute = useRef(false)
  const routeIdentity = useRef('')

  useEffect(() => {
    if (!effectsEnabled) return
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
  }, [effectsEnabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const previous = lastPathname.current
    if (previous === location.pathname) return
    lastPathname.current = location.pathname
    if (!session || previous === '/login' || location.pathname === '/login') return
    void refresh()
  }, [location.pathname, refresh, session])

  useEffect(() => {
    void restoreSession()
  }, [restoreSession])

  useEffect(() => {
    if (!session || !ready || restoredRoute.current) return
    restoredRoute.current = true
    if (location.pathname !== '/') return
    try {
      const key = `gitmanager:last-route:${session.email.toLowerCase()}:${session.source ?? ''}:${session.accountId ?? session.username.toLowerCase()}`
      const saved = localStorage.getItem(key)
      const valid = saved !== null && pages.some((page) => page.path === saved && page.path !== '/login'
        && !(role === 'admin' && ['/my-activity', '/my-timeline', '/my-ai'].includes(page.path)))
      if (valid && saved !== '/') navigate(saved, { replace: true })
    } catch { /* storage may be unavailable */ }
  }, [session, ready, location.pathname, navigate, role])

  useEffect(() => {
    if (!session || location.pathname === '/login') return
    try {
      const identity = `${session.email.toLowerCase()}:${session.source ?? ''}:${session.accountId ?? session.username.toLowerCase()}`
      if (routeIdentity.current !== identity) {
        routeIdentity.current = identity
        return
      }
      const key = `gitmanager:last-route:${identity}`
      localStorage.setItem(key, location.pathname)
    } catch { /* storage may be unavailable */ }
  }, [session, location.pathname])

  useEffect(() => {
    return window.gitmanager.onNavigate((route) => navigate(route))
  }, [navigate])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', settings.backgroundTheme === 'dark')
    root.classList.toggle('light', settings.backgroundTheme === 'light')
    root.dataset.colorTheme = settings.colorTheme
    root.dataset.bgTheme = settings.backgroundTheme
  }, [settings.backgroundTheme, settings.colorTheme])

  useEffect(() => {
    if (!ready || splashDone) return
    const elapsed = Date.now() - splashStartedAt
    const remaining = Math.max(0, 2600 - elapsed)
    const timer = window.setTimeout(() => setSplashDone(true), remaining)
    return () => window.clearTimeout(timer)
  }, [ready, splashDone, splashStartedAt])

  useEffect(() => {
    document.documentElement.style.colorScheme = settings.backgroundTheme
  }, [settings.backgroundTheme])

  const showSplash = !splashDone
  if (showSplash && !startupError) {
    return (
      <div className="relative h-screen overflow-hidden bg-canvas">
        {effectsEnabled && splashParticlesEnabled ? (
          <>
            <div className="absolute inset-0">
              <ParticleText
                text="GitManager"
                duration={2600}
                onComplete={() => {
                  if (ready) setSplashDone(true)
                }}
              />
            </div>
            {!ready ? (
              <div className="pointer-events-none absolute inset-x-0 top-12 text-center">
                <div className="inline-block rounded-md border border-line bg-surface/70 px-2.5 py-1 text-xs font-medium text-muted">
                  Loading...
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="text-4xl font-bold text-canvas-fg">GitManager</div>
            {!ready ? (
              <div className="mt-4 text-sm font-medium text-muted">Loading...</div>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  if (startupError) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="text-center">
          <div className="mb-3 text-3xl font-bold text-primary">GitManager</div>
          <div className="text-sm text-danger">{startupError}</div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="text-center">
          <div className="mb-3 text-3xl font-bold text-primary">GitManager</div>
          <div className="text-sm text-muted">Loading...</div>
        </div>
      </div>
    )
  }

  if (!session) {
    // 未登录时只渲染登录页；其余路由一律重定向过去。
    return (
      <>
        <Routes key={language} location={location}>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <Toasts />
      </>
    )
  }

  // The login page belongs to the unauthenticated route tree. If an already
  // signed-in tab lands on /login, send it to the dashboard instead of
  // rendering the login card inside the main layout.
  if (location.pathname === '/login') {
    return <Navigate to="/" replace />
  }

  if (role === 'user' && location.pathname === '/notifications') return <Navigate to="/" replace />

  if (role === 'admin' && (location.pathname === '/my-activity' || location.pathname.startsWith('/my-activity/commit/') || location.pathname === '/my-timeline' || location.pathname === '/my-ai')) {
    return <Navigate to="/" replace />
  }

  return (
    <Layout>
      <div className="h-full overflow-auto">
        <Routes key={language} location={location}>
          {pages.map((p) => (
            <Route key={p.path} path={p.path} element={p.element} />
          ))}
        </Routes>
      </div>
      <Toasts />
    </Layout>
  )
}
