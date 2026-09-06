/**
 * Layout — Application Shell orchestrator.
 * AeroShards (ambient) → Sidebar → Topbar → Main workspace.
 * Fixed sidebar + fixed topbar + scrollable workspace.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import AeroShards from './shell/AeroShards'
import Sidebar from './shell/Sidebar'
import Topbar from './shell/Topbar'
import CommandPalette from './shell/CommandPalette'
import { useAppStore } from './stores/appStore'
import { motion as motionToken } from './design-system/tokens'

export default function Layout({ children }: { children: ReactNode }): JSX.Element {
  const setScanning = useAppStore((s) => s.setScanning)
  const setProgress = useAppStore((s) => s.setProgress)
  const refresh = useAppStore((s) => s.refresh)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { pathname } = useLocation()

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
      <AeroShards />

      {/* Layer 3: Sidebar */}
      <Sidebar />

      {/* Layer 4: Topbar + Workspace */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="relative min-h-0 flex-1 overflow-auto p-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: motionToken.fast.duration, ease: motionToken.fast.ease }}
              className="h-full"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Layer 7: Command Palette */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}