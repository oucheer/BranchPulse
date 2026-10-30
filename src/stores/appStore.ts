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
  SchedulerJob,
  UserRole,
  UserSession
} from '@shared/types'
import { t, type Language } from '../lib/i18n'
import { persistEffectSettings, readEffectSettings, type EffectSettings } from '../lib/effects'
import { applyImportedEffectSettings, serializeEffectSettings } from '../lib/effects'
import { readStorage } from '../lib/legacyKeys'

const LANGUAGE_KEY = 'gitmanager:language'
/** Language key used before the rename; read once and copied forward. */
const LEGACY_LANGUAGE_KEY = 'branchpulse:language'
/** Per-tab session token: same browser, different tabs, different identities. */
const SESSION_KEY = 'gitmanager:session-token'

interface Toast {
  id: number
  message: string
  level: 'info' | 'success' | 'warn' | 'error'
}

interface AppState {
  ready: boolean
  startupError: string | null
  session: UserSession | null
  role: UserRole | null
  myEmail: string
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
  restoreSession: () => Promise<UserSession | null>
  login: (username: string | null, password: string | null, email: string | null, gitlabToken?: string) => Promise<void>
  logout: () => Promise<void>
  setLanguage: (language: Language) => void
  setEffectSettings: (partial: Partial<EffectSettings>) => void
  setSelectedRepositoryIds: (repositoryIds: string[]) => Promise<void>
  toggleRepositorySelection: (repositoryId: string) => Promise<void>
  selectAllRepositories: () => Promise<void>
  clearRepositorySelection: () => Promise<void>
  exportConfig: (filePath?: string) => Promise<ConfigExportResult>
  importConfig: (filePath: string) => Promise<ConfigImportResult>
  setScanning: (scanning: boolean) => void
  setProgress: (progress: ScanProgress | null) => void
  toast: (message: string, level?: Toast['level']) => void
  dismissToast: (id: number) => void
}

let toastId = 0

/** Restores the per-tab session on page reload. Returns null when no token is stored. */
export function readSessionToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function pushToast(state: AppState, message: string, level: Toast['level'] = 'info'): AppState {
  const id = ++toastId
  const toasts = [...state.toasts, { id, message, level }].slice(-4)
  setTimeout(() => state.dismissToast(id), 5000)
  return { ...state, toasts }
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  startupError: null,
  session: null,
  role: null,
  myEmail: '',
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
    thresholdRules: [],
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
        set({ startupError: 'GitManager 后端不可用：请通过 npm run dev 或 npm start 启动服务后访问本页面。' })
        return
      }

      // The login screen only needs the public dashboard snapshot. A full
      // bootstrap before authentication hits protected endpoints, and each 401
      // reloads the page before the user can ever log in.
      if (!get().session) {
        const snapshot = await window.gitmanager.init()
        set({
          ready: true,
          appVersion: '',
          repositories: snapshot.repositories,
          branches: snapshot.branches,
          scanRuns: snapshot.scanRuns,
          notifications: snapshot.notifications,
          selectedRepositoryIds: snapshot.selectedRepositoryIds ?? snapshot.settings.selectedRepositoryIds ?? [],
          settings: snapshot.settings
        })
        localStorage.setItem(LANGUAGE_KEY, snapshot.settings.language)
        set({ language: snapshot.settings.language })
        return
      }

      const snapshot = await window.gitmanager.init()
      const selected = snapshot.selectedRepositoryIds ?? snapshot.settings.selectedRepositoryIds ?? []
      const [jobs, calendarRuns, reports, reportSchedules, audit, namingRules, whitelist, protectedList, emailConfig, emailGroups, backups, appVersion] = await Promise.all([
        window.gitmanager.listJobs(selected),
        window.gitmanager.calendarRuns(selected),
        window.gitmanager.listReports(selected),
        window.gitmanager.listReportSchedules(selected),
        window.gitmanager.listAudit(),
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
      // A refresh failure while the user is signed in must not throw away the
      // current dashboard; the caller shows a toast instead.
      if (!get().session) {
        set({ startupError: err instanceof Error ? err.message : String(err) })
      } else {
        throw err
      }
    }
  },

  /** Resolves the stored token into a live session after a page reload. */
  restoreSession: async () => {
    const token = readSessionToken()
    if (!token) return null
    try {
      const session = await window.gitmanager.getSession()
      if (!session) {
        sessionStorage.removeItem(SESSION_KEY)
        return null
      }
      set({ session, role: session.role, myEmail: session.email, ready: true })
      await get().refresh()
      return session
    } catch {
      sessionStorage.removeItem(SESSION_KEY)
      set({ session: null, role: null, myEmail: '', ready: false })
      return null
    }
  },

  login: async (username, password, email, gitlabToken) => {
    const session = await window.gitmanager.login(username, password, email, gitlabToken)
    // 每个标签页独立保存 token，同一浏览器的多个标签页互不影响。
    sessionStorage.setItem(SESSION_KEY, session.token)
    set({ session, role: session.role, myEmail: session.email, startupError: null })
    await get().refresh()
  },

  logout: async () => {
    try { await window.gitmanager.logout() } catch { /* token already gone */ }
    sessionStorage.removeItem(SESSION_KEY)
    // The app itself is still initialized; only the identity changes. Resetting
    // `ready` here would strand the tab on the root Loading screen because no
    // startup refresh runs after logout.
    set({ session: null, role: null, myEmail: '' })
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

  /** `filePath` comes from the in-page picker (the desktop build used a save dialog). */
  exportConfig: async (filePath?: string) => {
    const result = await window.gitmanager.exportConfig({
      effects: { ...serializeEffectSettings() },
      language: get().language
    }, filePath)
    return result
  },

  /**
   * `filePath` comes from the in-page picker. The desktop build confirmed the
   * overwrite with a native message box inside the main process; the web build
   * asks the page to confirm before calling this.
   */
  importConfig: async (filePath: string) => {
    const result = await window.gitmanager.importConfig(filePath)
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
