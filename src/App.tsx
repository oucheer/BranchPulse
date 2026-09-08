import { useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { useAppStore } from './stores/appStore'
import { useEffectsEnabled } from './lib/effects'
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
  const effectsMode = useAppStore((s) => s.effectsMode)
  const effectsEnabled = useEffectsEnabled(effectsMode)
  const location = useLocation()
  const desktopAvailable = typeof window !== 'undefined' && Boolean(window.branchpulse)
  const [splashDone, setSplashDone] = useState(false)

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
    if (desktopAvailable) void refresh()
  }, [desktopAvailable, refresh])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', settings.backgroundTheme === 'dark')
    root.classList.toggle('light', settings.backgroundTheme === 'light')
    root.dataset.colorTheme = settings.colorTheme
    root.dataset.bgTheme = settings.backgroundTheme
  }, [settings.backgroundTheme, settings.colorTheme])

  useEffect(() => {
    if (!ready || splashDone) return
    const timer = window.setTimeout(() => setSplashDone(true), effectsEnabled ? 650 : 200)
    return () => window.clearTimeout(timer)
  }, [ready, splashDone, effectsEnabled])

  useEffect(() => {
    document.documentElement.style.colorScheme = settings.backgroundTheme
  }, [settings.backgroundTheme])

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
        {effectsEnabled ? (
          <>
            <div className="absolute inset-0">
              <ParticleText
                text="BranchPulse"
                duration={1400}
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
            <div className="text-4xl font-bold text-canvas-fg">BranchPulse</div>
            {!ready ? (
              <div className="mt-4 text-sm font-medium text-muted">Loading...</div>
            ) : null}
          </div>
        )}
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
      <div className="h-full overflow-auto">
        <Routes location={location}>
          {pages.map((p) => (
            <Route key={p.path} path={p.path} element={p.element} />
          ))}
        </Routes>
      </div>
      <Toasts />
    </Layout>
  )
}
