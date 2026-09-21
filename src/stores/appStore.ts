import { create } from 'zustand'
import type {
  AppSettings,
  AuditEntry,
  BranchSummary,
  BackupRecord,
  ConfigExportResult,
  ConfigImportResult,
  DashboardSnapshot,
  EmailConfig,
  EmailGroup,
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
import { persistEffectSettings, readEffectSettings, type EffectSettings } from '../lib/effects'
import { applyImportedEffectSettings, serializeEffectSettings } from '../lib/effects'
import { readStorage } from '../lib/legacyKeys'

const LANGUAGE_KEY = 'gitmanager:language'
const LEGACY_LANGUAGE_KEY = 'branchpulse:language'

interface Toast {
  id: number
  message: string
  level: 'info' | 'success' | 'warn' | 'error'
}

interface AppState {
  ready: boolean
  startupError: string | null
  appVersion: string
  language: Language
  effectSettings: EffectSettings
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
  backups: BackupRecord[]
  reportSchedules: ReportSchedule[]
  audit: AuditEntry[]
  namingRules: NamingRule[]
  whitelist: ProtectionEntry[]
  protected: ProtectionEntry[]
  emailConfig: EmailConfig | null
  emailGroups: EmailGroup[]
  scanning: boolean
  progress: ScanProgress | null
  toasts: Toast[]
  refresh: () => Promise<void>
  setLanguage: (language: Language) => void
  setEffectSettings: (partial: Partial<EffectSettings>) => void
  setActiveRepositoryId: (repositoryId: string | null) => Promise<void>
  exportConfig: () => Promise<ConfigExportResult>
  importConfig: () => Promise<ConfigImportResult>
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
  appVersion: '',
  language: (readStorage(LANGUAGE_KEY, LEGACY_LANGUAGE_KEY) as Language) || 'zh',
  effectSettings: readEffectSettings(),
  repositories: [],
  branches: [],
  scanRuns: [],
  notifications: [],
  activeRepositoryId: null,
  settings: {
    theme: 'dark',
    colorTheme: 'default',
    backgroundTheme: 'dark',
    language: 'zh',
    notificationsEnabled: true,
    trayEnabled: true,
    launchMinimized: false,
    startWithWindows: false,
    gitPath: '',
    fetchPolicy: 'auto',
    gitlabUrl: '',
    hasGitlabApiKey: false,
    activeRepositoryId: null
  },
  monitoring: {
    enabled: true,
    staleThresholdDays: 180,
    staleThresholdUnit: 'days' as const,
    fetchEnabled: true,
    namingEnabled: true,
    emailPolicy: 'none',
    notificationEnabled: true,
    notifyTarget: 'self'
  },
  jobs: [],
  calendarRuns: [],
  reports: [],
  backups: [],
  reportSchedules: [],
  audit: [],
  namingRules: [],
  whitelist: [],
  protected: [],
  emailConfig: null,
  emailGroups: [],
  scanning: false,
  progress: null,
  toasts: [],

  refresh: async () => {
    try {
      if (!window.gitmanager) {
        set({ startupError: 'GitManager desktop bridge is unavailable. Launch the installed app instead of opening this URL in a browser.' })
        return
      }
      const snapshot = await window.gitmanager.init()
      const activeId = snapshot.activeRepositoryId ?? snapshot.settings.activeRepositoryId ?? null
      const [jobs, calendarRuns, reports, reportSchedules, audit, namingRules, whitelist, protectedList, emailConfig, emailGroups, backups, appVersion] = await Promise.all([
        window.gitmanager.listJobs(),
        window.gitmanager.calendarRuns(),
        window.gitmanager.listReports(),
        window.gitmanager.listReportSchedules(),
        window.gitmanager.listAudit(),
        window.gitmanager.listNamingRules(activeId),
        window.gitmanager.listWhitelist(activeId),
        window.gitmanager.listProtected(activeId),
        window.gitmanager.getEmailConfig(),
        window.gitmanager.listEmailGroups(),
        window.gitmanager.listBackups(),
        window.gitmanager.getAppVersion()
      ])
      set({
        ready: true,
        appVersion: appVersion ?? '',
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
        backups,
        reportSchedules,
        audit,
        namingRules,
        whitelist,
        protected: protectedList,
        emailConfig,
        emailGroups
      })
      localStorage.setItem(LANGUAGE_KEY, snapshot.settings.language)
      set({ language: snapshot.settings.language })
    } catch (err) {
      set({ startupError: err instanceof Error ? err.message : String(err) })
    }
  },

  setLanguage: (language) => {
    localStorage.setItem(LANGUAGE_KEY, language)
    set({ language })
  },

  setEffectSettings: (partial) => {
    const next = { ...get().effectSettings, ...partial }
    persistEffectSettings(next)
    set({ effectSettings: next })
  },

  setActiveRepositoryId: async (repositoryId) => {
    const settings = get().settings
    const nextSettings = { ...settings, activeRepositoryId: repositoryId }
    set({ activeRepositoryId: repositoryId, settings: nextSettings })
    try {
      await window.gitmanager.saveSettings(nextSettings)
      await get().refresh()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'error')
    }
  },

  setScanning: (scanning) => set({ scanning }),
  setProgress: (progress) => set({ progress }),

  exportConfig: async () => {
    const result = await window.gitmanager.exportConfig({
      effects: { ...serializeEffectSettings() },
      language: get().language
    })
    return result
  },

  importConfig: async () => {
    const result = await window.gitmanager.importConfig(true)
    if (!result.ok) return result
    if (typeof result.language === 'string') {
      localStorage.setItem(LANGUAGE_KEY, result.language)
    }
    applyImportedEffectSettings(result.effects)
    await get().refresh()
    const settings = get().settings
    set({ language: settings.language })
    return result
  },

  toast: (message, level = 'info') => set((state) => pushToast(state, message, level)),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))

export function tr(key: string, fallback?: string): string {
  return t(useAppStore.getState().language, key, fallback)
}
