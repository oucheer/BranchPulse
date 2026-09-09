/**
 * Layout — Application Shell orchestrator.
 * AeroShards (ambient) → Sidebar → Topbar → Main workspace.
 * Fixed sidebar + fixed topbar + scrollable workspace.
 */
import { useEffect, useState, type ReactNode } from 'react'
import AeroShards from './shell/AeroShards'
import MoltenMetal from './components/MoltenMetal'
import LightPillar from './components/LightPillar'
import SplashCursor from './components/SplashCursor'
import ClickSpark from './components/ClickSpark'
import Sidebar from './shell/Sidebar'
import Topbar from './shell/Topbar'
import CommandPalette from './shell/CommandPalette'
import { useAppStore } from './stores/appStore'
import { computeWebGLAvailable, isEffectOn, useEffectSettings } from './lib/effects'

/** Resolve the current --primary CSS variable into a canvas-friendly rgb() color. */
function resolveAccentColor(): string {
  if (typeof window === 'undefined') return '#ffffff'
  const value = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  return value ? `rgb(${value})` : '#ffffff'
}

function StaticBackdrop({ isDark }: { isDark: boolean }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
      style={{
        background: isDark
          ? 'linear-gradient(180deg, rgb(18 20 30 / 0.55), transparent 44%), linear-gradient(135deg, rgb(124 92 252 / 0.09), transparent 40%), linear-gradient(315deg, rgb(255 159 252 / 0.05), transparent 48%), #0b0d12'
          : 'linear-gradient(180deg, rgb(255 255 255 / 0.7), transparent 48%), linear-gradient(135deg, rgb(124 92 252 / 0.06), transparent 42%), linear-gradient(315deg, rgb(255 159 252 / 0.05), transparent 48%), #f4f5f8'
      }}
    />
  )
}

export default function Layout({ children }: { children: ReactNode }): JSX.Element {
  const setScanning = useAppStore((s) => s.setScanning)
  const setProgress = useAppStore((s) => s.setProgress)
  const refresh = useAppStore((s) => s.refresh)
  const effectSettings = useEffectSettings()
  const ambientEnabled = isEffectOn(effectSettings, 'ambientBackground') && computeWebGLAvailable()
  const splashCursorEnabled = isEffectOn(effectSettings, 'splashCursor') && computeWebGLAvailable()
  const clickSparkEnabled = isEffectOn(effectSettings, 'clickSpark')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [isDark, setIsDark] = useState(true)
  useEffect(() => {
    const checkDark = (): void => setIsDark(document.documentElement.classList.contains('dark'))
    checkDark()
    const observer = new MutationObserver(checkDark)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-color-theme'] })
    return () => observer.disconnect()
  }, [])
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
  return (
    <div className="relative flex h-screen bg-canvas text-muted">
      {/* Layer 1-2: Ambient background */}
      {ambientEnabled ? (
        <>
          <AeroShards />
          <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
            {isDark ? (
              <MoltenMetal
                color1="#5227FF"
                color2="#FF9FFC"
                color3="#ffffff"
                speed={0.35}
                scale={4}
                detail={3}
                glow={1.6}
                coreSize={0.1}
                swirl={1}
                fold={-0.2}
                blackPoint={0.05}
                brightness={1.3}
                colorMode="molten"
                grain={true}
                grainIntensity={0.05}
                mouseInteraction={false}
                opacity={0.16}
                backgroundColor={'#07090e'}
              />
            ) : (
              <div style={{ opacity: 0.35 }}>
                <LightPillar
                  topColor="#5227FF"
                  bottomColor="#FF9FFC"
                  intensity={1.0}
                  rotationSpeed={0.3}
                  glowAmount={0.005}
                  pillarWidth={3.0}
                  pillarHeight={0.4}
                  noiseIntensity={0.5}
                  pillarRotation={0}
                  interactive={true}
                  mixBlendMode="normal"
                  quality="low"
                  lightMode={true}
                />
              </div>
            )}
          </div>
          {/* Interactive fluid that follows the pointer and reacts to clicks */}
          {splashCursorEnabled ? (
            <SplashCursor
              DENSITY_DISSIPATION={3}
              VELOCITY_DISSIPATION={2.5}
              PRESSURE={0.5}
              CURL={1}
              SPLAT_RADIUS={0.05}
              SPLAT_FORCE={12500}
              COLOR_UPDATE_SPEED={7}
              RAINBOW_MODE
            />
          ) : null}
        </>
      ) : (
        <StaticBackdrop isDark={isDark} />
      )}
      {/* Layer 3: Sidebar */}
      <Sidebar />
      {/* Layer 4: Topbar + Workspace */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="relative min-h-0 flex-1 overflow-auto p-6">
          <div className="h-full">{children}</div>
        </main>
      </div>
      {/* Layer 7: Command Palette */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* Global click sparkles (above shell + splash, below nothing) */}
      {clickSparkEnabled ? (
        <ClickSpark sparkColor={resolveAccentColor()} sparkSize={9} sparkRadius={22} sparkCount={9} duration={420} />
      ) : null}
    </div>
  )
}
