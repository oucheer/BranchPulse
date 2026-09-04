import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`card ${className}`}>{children}</div>
}

export function StatCard({ label, value, tone = 'default', icon }: { label: string; value: string | number; tone?: 'default' | 'ok' | 'warn' | 'danger' | 'primary' | 'secondary'; icon?: ReactNode }): JSX.Element {
  const toneClass = {
    default: 'text-muted',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
    primary: 'text-primary',
    secondary: 'text-secondary'
  }[tone]
  return (
    <div className="flex items-center justify-between rounded-card border border-line bg-surface px-4 py-3">
      <div>
        <div className="text-[11px] uppercase tracking-normal text-muted">{label}</div>
        <div className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</div>
      </div>
      {icon ? <div className={`text-muted ${toneClass}`}>{icon}</div> : null}
    </div>
  )
}

export function Ring({ score, size = 56, stroke = 5, label }: { score: number; size?: number; stroke?: number; label?: string }): JSX.Element {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference
  const color = score >= 90 ? '#34c77b' : score >= 70 ? '#f5a623' : score >= 40 ? '#f5a623' : '#ef5350'
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgb(var(--line))" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-bold" style={{ color, fontSize: size / 3.2 }}>{score}</div>
        {label ? <div className="text-[9px] text-muted leading-none">{label}</div> : null}
      </div>
    </div>
  )
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'danger' | 'primary' | 'secondary' | 'info' }): JSX.Element {
  const classes = {
    default: 'bg-line/40 text-muted',
    ok: 'bg-ok/10 text-ok',
    warn: 'bg-warn/10 text-warn',
    danger: 'bg-danger/10 text-danger',
    primary: 'bg-primary/10 text-primary',
    secondary: 'bg-secondary/10 text-secondary',
    info: 'bg-info/10 text-info'
  }[tone]
  return <span className={`chip ${classes}`}>{children}</span>
}

export function Modal({ open, title, onClose, children, footer, width = 480 }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="rounded-card border border-line bg-surface shadow-panel"
            style={{ width }}
            initial={{ scale: 0.96, y: 8, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.97, y: 6, opacity: 0 }}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <div className="text-sm font-semibold text-canvas-fg">{title}</div>
              <button className="rounded-md p-1 text-muted hover:bg-line/40 hover:text-canvas-fg" onClick={onClose} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4">{children}</div>
            {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function ConfirmCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-elevated px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[rgb(var(--primary))]"
      />
      <span className="text-sm text-muted">{label}</span>
    </label>
  )
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line bg-surface/40 px-6 py-14 text-center">
      <div className="mb-3 text-2xl font-bold text-canvas-fg">{title}</div>
      {description ? <div className="mb-4 max-w-md text-sm text-muted">{description}</div> : null}
      {action}
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${checked ? 'bg-primary' : 'bg-line'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

export function Toasts(): JSX.Element {
  const toasts = useAppStore((s) => s.toasts)
  const dismissToast = useAppStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={`pointer-events-auto rounded-card border px-4 py-3 text-sm shadow-panel ${
              toast.level === 'error'
                ? 'border-danger/40 bg-danger/10 text-danger'
                : toast.level === 'success'
                  ? 'border-ok/40 bg-ok/10 text-ok'
                  : toast.level === 'warn'
                    ? 'border-warn/40 bg-warn/10 text-warn'
                    : 'border-line bg-surface text-canvas-fg'
            }`}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
          >
            <div className="flex items-start justify-between gap-2">
              <div>{toast.message}</div>
              <button className="text-muted hover:text-canvas-fg" onClick={() => dismissToast(toast.id)}>
                <X size={14} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function usePolling(callback: () => Promise<void>, intervalMs: number, active = true): void {
  useEffect(() => {
    if (!active) return
    void callback()
    const timer = setInterval(() => void callback(), intervalMs)
    return () => clearInterval(timer)
  }, [callback, intervalMs, active])
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    setLoading(true)
    fn()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, loading, reload: () => setTick((v) => v + 1) }
}
