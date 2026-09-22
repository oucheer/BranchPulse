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
  selectedRepositoryIds: string[]
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
  setSelectedRepositoryIds: (repositoryIds: string[]) => Promise<void>
  toggleRepositorySelection: (repositoryId: string) => Promise<void>
  selectAllRepositories: () => Promise<void>
  clearRepositorySelection: () => Promise<void>
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
  selectedRepositoryIds: [],
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
    selectedRepositoryIds: []
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
      const selected = snapshot.selectedRepositoryIds ?? snapshot.settings.selectedRepositoryIds ?? []
      const [jobs, calendarRuns, reports, reportSchedules, audit, namingRules, whitelist, protectedList, emailConfig, emailGroups, backups, appVersion] = await Promise.all([
        window.gitmanager.listJobs(selected),
        window.gitmanager.calendarRuns(selected),
        window.gitmanager.listReports(selected),
        window.gitmanager.listReportSchedules(selected),
        window.gitmanager.listAudit(selected),
        window.gitmanager.listNamingRules(selected[0] ?? null),
        window.gitmanager.listWhitelist(selected[0] ?? null),
        window.gitmanager.listProtected(selected[0] ?? null),
        window.gitmanager.getEmailConfig(),
        window.gitmanager.listEmailGroups(),
        window.gitmanager.listBackups(selected),
        window.gitmanager.getAppVersion()
      ])
      set({
        ready: true,
        appVersion: appVersion ?? '',
        repositories: snapshot.repositories,
        branches: snapshot.branches,
        scanRuns: snapshot.scanRuns,
        notifications: snapshot.notifications,
        selectedRepositoryIds: selected,
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

  /**
   * 全局仓库勾选：所有仓库相关页面都从这里派生范围。空数组表示「没有仓库」，
   * 不再是「全部仓库」。
   */
  setSelectedRepositoryIds: async (repositoryIds) => {
    const next = [...new Set(repositoryIds)]
    const settings = get().settings
    const nextSettings = { ...settings, selectedRepositoryIds: next }
    set({ selectedRepositoryIds: next, settings: nextSettings })
    try {
      await window.gitmanager.saveSettings(nextSettings)
      await get().refresh()
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'error')
    }
  },

  toggleRepositorySelection: async (repositoryId) => {
    const current = get().selectedRepositoryIds
    await get().setSelectedRepositoryIds(
      current.includes(repositoryId) ? current.filter((id) => id !== repositoryId) : [...current, repositoryId]
    )
  },

  selectAllRepositories: async () => {
    await get().setSelectedRepositoryIds(get().repositories.map((repository) => repository.id))
  },

  clearRepositorySelection: async () => {
    await get().setSelectedRepositoryIds([])
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
