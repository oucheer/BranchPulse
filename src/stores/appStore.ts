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
  ReportSchedule,
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
  activeRepositoryId: string | null
  settings: AppSettings
  monitoring: MonitoringConfig
  jobs: SchedulerJob[]
  calendarRuns: { date: string; status: ScanRun['status']; runs: number }[]
  reports: ReportRecord[]
  reportSchedules: ReportSchedule[]
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
  setActiveRepositoryId: (repositoryId: string | null) => Promise<void>
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
  activeRepositoryId: null,
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
    hasGitlabApiKey: false,
    activeRepositoryId: null,
    deletionDisabled: false
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
  reportSchedules: [],
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
      const [jobs, calendarRuns, reports, reportSchedules, audit, namingRules, whitelist, protectedList, emailConfig] = await Promise.all([
        window.branchpulse.listJobs(),
        window.branchpulse.calendarRuns(),
        window.branchpulse.listReports(),
        window.branchpulse.listReportSchedules(),
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
        activeRepositoryId: snapshot.activeRepositoryId ?? snapshot.settings.activeRepositoryId ?? null,
        settings: snapshot.settings,
        monitoring: snapshot.monitoring,
        jobs,
        calendarRuns,
        reports,
        reportSchedules,
        audit,
        namingRules,
        whitelist,
        protected: protectedList,
        emailConfig
      })
      localStorage.setItem('branchpulse:language', snapshot.settings.language)
      set({ language: snapshot.settings.language })
    } catch (err) {
      set({ startupError: err instanceof Error ? err.message : String(err) })
    }
  },

  setLanguage: (language) => {
    localStorage.setItem('branchpulse:language', language)
    set({ language })
  },

  setActiveRepositoryId: async (repositoryId) => {
    const settings = get().settings
    const nextSettings = { ...settings, activeRepositoryId: repositoryId }
    set({ activeRepositoryId: repositoryId, settings: nextSettings })
    try {
      await window.branchpulse.saveSettings(nextSettings)
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'error')
    }
  },

  setScanning: (scanning) => set({ scanning }),
  setProgress: (progress) => set({ progress }),

  toast: (message, level = 'info') => set((state) => pushToast(state, message, level)),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))

export function tr(key: string, fallback?: string): string {
  return t(useAppStore.getState().language, key, fallback)
}
