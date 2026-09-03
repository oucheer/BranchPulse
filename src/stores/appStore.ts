import { create } from 'zustand'
import type {
  AppSettings,
  AuditEntry,
  BranchSummary,
  DashboardSnapshot,
  EmailConfig,
  MonitoringConfig,
  NamingRule,
  NotificationRecord,
  ProtectionEntry,
  ReportRecord,
  Repository,
  ScanProgress,
  ScanRun,
  SchedulerJob
} from '@shared/types'
import { t, type Language } from '../lib/i18n'

interface Toast {
  id: number
  message: string
  level: 'info' | 'success' | 'warn' | 'error'
}

interface AppState {
  ready: boolean
  startupError: string | null
  language: Language
  repositories: Repository[]
  branches: BranchSummary[]
  scanRuns: ScanRun[]
  notifications: NotificationRecord[]
  settings: AppSettings
  monitoring: MonitoringConfig
  jobs: SchedulerJob[]
  calendarRuns: { date: string; status: ScanRun['status']; runs: number }[]
  reports: ReportRecord[]
  audit: AuditEntry[]
  namingRules: NamingRule[]
  whitelist: ProtectionEntry[]
  protected: ProtectionEntry[]
  emailConfig: EmailConfig | null
  scanning: boolean
  progress: ScanProgress | null
  toasts: Toast[]
  refresh: () => Promise<void>
  setLanguage: (language: Language) => void
  setScanning: (scanning: boolean) => void
  setProgress: (progress: ScanProgress | null) => void
  toast: (message: string, level?: Toast['level']) => void
  dismissToast: (id: number) => void
}

let toastId = 0

function pushToast(state: AppState, message: string, level: Toast['level'] = 'info'): AppState {
  const id = ++toastId
  const toasts = [...state.toasts, { id, message, level }].slice(-4)
  setTimeout(() => state.dismissToast(id), 5000)
  return { ...state, toasts }
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  startupError: null,
  language: (localStorage.getItem('branchpulse:language') as Language) || 'en',
  repositories: [],
  branches: [],
  scanRuns: [],
  notifications: [],
  settings: {
    theme: 'dark',
    language: 'en',
    notificationsEnabled: true,
    trayEnabled: true,
    launchMinimized: false,
    startWithWindows: false,
    gitPath: '',
    fetchPolicy: 'auto',
    gitlabUrl: '',
    hasGitlabApiKey: false
  },
  monitoring: {
    staleThresholdDays: 14,
    gracePeriodDays: 7,
    fetchEnabled: true,
    namingEnabled: true,
    emailPolicy: 'none',
    notificationEnabled: true,
    autoDeleteEnabled: false,
    notifyTarget: 'self'
  },
  jobs: [],
  calendarRuns: [],
  reports: [],
  audit: [],
  namingRules: [],
  whitelist: [],
  protected: [],
  emailConfig: null,
  scanning: false,
  progress: null,
  toasts: [],

  refresh: async () => {
    try {
      if (!window.branchpulse) {
        set({ startupError: 'BranchPulse desktop bridge is unavailable. Launch the installed app instead of opening this URL in a browser.' })
        return
      }
      const snapshot = await window.branchpulse.init()
      const [jobs, calendarRuns, reports, audit, namingRules, whitelist, protectedList, emailConfig] = await Promise.all([
        window.branchpulse.listJobs(),
        window.branchpulse.calendarRuns(),
        window.branchpulse.listReports(),
        window.branchpulse.listAudit(),
        window.branchpulse.listNamingRules(),
        window.branchpulse.listWhitelist(),
        window.branchpulse.listProtected(),
        window.branchpulse.getEmailConfig()
      ])
      set({
        ready: true,
        repositories: snapshot.repositories,
        branches: snapshot.branches,
        scanRuns: snapshot.scanRuns,
        notifications: snapshot.notifications,
        settings: snapshot.settings,
        monitoring: snapshot.monitoring,
        jobs,
        calendarRuns,
        reports,
        audit,
        namingRules,
        whitelist,
        protected: protectedList,
        emailConfig
      })
    } catch (err) {
      set({ startupError: err instanceof Error ? err.message : String(err) })
    }
  },

  setLanguage: (language) => {
    localStorage.setItem('branchpulse:language', language)
    set({ language })
  },

  setScanning: (scanning) => set({ scanning }),
  setProgress: (progress) => set({ progress }),

  toast: (message, level = 'info') => set((state) => pushToast(state, message, level)),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))

export function tr(key: string, fallback?: string): string {
  return t(useAppStore.getState().language, key, fallback)
}
