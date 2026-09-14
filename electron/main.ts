import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, Tray, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { StorageService } from './services/storage'
import { GitService } from './services/git'
import { RepositoryService } from './services/repository'
import { BranchService } from './services/branch'
import { NamingService } from './services/naming'
import { ProtectionService } from './services/protection'
import { HealthService } from './services/health'
import { DeletionPolicyEngine, DeletionTokenRegistry } from './services/deletion'
import { MonitoringService } from './services/monitoring'
import { EmailService } from './services/email'
import { SchedulerService } from './services/scheduler'
import { ReportService } from './services/report'
import { ReportScheduleService } from './services/reportSchedule'
import { AuditService } from './services/audit'
import { SettingsService } from './services/settings'
import { GitLabService } from './services/gitlab'
import { BackupService } from './services/backup'
import { registerIpc, type AppServices } from './ipc'
import { logger } from './utils/logger'
import { dataDir, dbFile, ensureDir } from './utils/paths'
import type { LanguageCode } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let services: AppServices | null = null
let isQuitting = false

interface TrayLabels {
  open: string
  runCheck: string
  notifications: string
  report: string
  pause: string
  resume: string
  settings: string
  exit: string
}

const TRAY_LABELS: Record<LanguageCode, TrayLabels> = {
  zh: {
    open: '打开仪表盘',
    runCheck: '立即检查',
    notifications: '查看通知',
    report: '生成报告',
    pause: '暂停监控',
    resume: '恢复监控',
    settings: '设置',
    exit: '退出'
  },
  en: {
    open: 'Open Dashboard',
    runCheck: 'Run Check Now',
    notifications: 'View Notifications',
    report: 'Generate Report',
    pause: 'Pause Monitoring',
    resume: 'Resume Monitoring',
    settings: 'Settings',
    exit: 'Exit'
  }
}

if (process.env.BRANCHPULSE_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.BRANCHPULSE_USER_DATA_DIR))
}

function iconPath(): string {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'icon.ico')
    if (fs.existsSync(packaged)) return packaged
    return path.join(app.getAppPath(), 'build', 'icon.ico')
  }
  const dev = path.join(app.getAppPath(), 'build', 'icon.ico')
  if (fs.existsSync(dev)) return dev
  return ''
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'BranchPulse',
    icon: iconPath(),
    backgroundColor: services?.settings.get().theme === 'dark' || (services?.settings.get().theme === 'system' && nativeTheme.shouldUseDarkColors) ? '#0b0d12' : '#f4f5f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => {
    if (services?.settings.get().launchMinimized) {
      win.hide()
    } else {
      win.show()
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    logger.error(`did-fail-load [${code}] ${desc} ${url} main=${isMain}`)
  })
  win.webContents.on('did-finish-load', () => {
    logger.info('did-finish-load')
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    logger.info(`console[${level}] ${sourceId}:${line}: ${message}`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('close', (event) => {
    if (!isQuitting && services?.settings.get().trayEnabled) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

function createTray(): void {
  const ip = iconPath()
  let image: Electron.NativeImage | null = null
  try {
    if (ip && fs.existsSync(ip)) {
      image = nativeImage.createFromPath(ip)
    }
    if (!image || image.isEmpty()) {
      logger.warn('Tray icon unavailable, tray disabled')
      return
    }
    tray = new Tray(image)
  } catch (err) {
    logger.error('Failed to create tray', err)
    return
  }
  tray.setToolTip('BranchPulse')
  const showWindow = (): void => {
    if (!mainWindow) mainWindow = createWindow()
    mainWindow.show()
    mainWindow.focus()
  }
  tray.setContextMenu(buildTrayMenu(showWindow))
  tray.on('double-click', showWindow)
}

function buildTrayMenu(showWindow: () => void): Electron.Menu {
  const language: LanguageCode = services?.settings.get().language ?? 'zh'
  const labels = TRAY_LABELS[language] ?? TRAY_LABELS.zh
  const openRoute = (route: string): void => {
    showWindow()
    mainWindow?.webContents.send('branchpulse:navigate', route)
  }
  return Menu.buildFromTemplate([
    { label: labels.open, click: () => openRoute('/') },
    {
      label: labels.runCheck,
      click: () => {
        void services?.monitoring.runCheckNow({ bypassEnabledCheck: true, trigger: 'manual' })
        openRoute('/monitoring')
      }
    },
    { label: labels.notifications, click: () => openRoute('/notifications') },
    {
      label: labels.report,
      click: () => {
        void services?.report.generateReport('on-demand', 'html')
        openRoute('/reports')
      }
    },
    { type: 'separator' },
    {
      label: labels.pause,
      click: () => {
        const job = services?.scheduler.listJobs().find((j) => j.enabled)
        if (job) services?.scheduler.saveJob({ ...job, enabled: false })
      }
    },
    {
      label: labels.resume,
      click: () => {
        const job = services?.scheduler.listJobs().find((j) => !j.enabled)
        if (job) services?.scheduler.saveJob({ ...job, enabled: true })
      }
    },
    { type: 'separator' },
    { label: labels.settings, click: () => openRoute('/settings') },
    { type: 'separator' },
    {
      label: labels.exit,
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
}

function refreshTrayMenu(): void {
  if (!tray) return
  const showWindow = (): void => {
    if (!mainWindow) mainWindow = createWindow()
    mainWindow.show()
    mainWindow.focus()
  }
  tray.setContextMenu(buildTrayMenu(showWindow))
}

/** Keep the tray icon in sync with the `trayEnabled` setting. */
function syncTray(): void {
  const enabled = services?.settings.get().trayEnabled ?? false
  if (enabled && !tray) {
    createTray()
    return
  }
  if (!enabled && tray) {
    tray.destroy()
    tray = null
  }
}

async function bootstrap(): Promise<void> {
  logger.init()
  app.setName('BranchPulse')
  app.setAppUserModelId('com.branchpulse.app')

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.branchpulse.app')
  }

  const storage = new StorageService(dbFile())
  await storage.init()
  const settings = new SettingsService(storage)
  const gitlab = new GitLabService(settings)
  const git = new GitService(() => settings.get().gitPath || 'git')
  const audit = new AuditService(storage)
  const repository = new RepositoryService(storage, git, audit, gitlab)
  const naming = new NamingService(storage)
  const protection = new ProtectionService(storage)
  const health = new HealthService()
  const branch = new BranchService(storage, git, repository, gitlab, naming, protection, health, audit, settings)
  const email = new EmailService(storage, audit)
  const monitoring = new MonitoringService(storage, branch, repository, email, audit)
  const scheduler = new SchedulerService(storage, monitoring, audit)
  const report = new ReportService(storage, branch, repository, audit)
  const reportSchedules = new ReportScheduleService(storage, report, email, audit)
  const deletionEngine = new DeletionPolicyEngine()
  const deletionTokens = new DeletionTokenRegistry()
  const backup = new BackupService(
    storage,
    repository,
    audit,
    () => settings.get().gitPath || 'git',
    () => ensureDir(path.join(dataDir(), 'backups'))
  )

  services = {
    storage, git, gitlab, repository, branch, naming, protection, deletionEngine, deletionTokens,
    monitoring, email, scheduler, report, reportSchedules, audit, settings, backup
  }

  registerIpc(services, () => {
    refreshTrayMenu()
    syncTray()
  })
  scheduler.start()
  reportSchedules.start()
  createWindow()
  syncTray()

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  logger.info(`BranchPulse started. Data: ${dataDir()}`)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('window-all-closed', () => {
    if (isQuitting) {
      app.quit()
      return
    }
    if (process.platform !== 'darwin' && !services?.settings.get().trayEnabled) {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    services?.storage.flush()
    services?.scheduler.stop()
    services?.reportSchedules.stop()
  })

  app.on('activate', () => {
    if (mainWindow) mainWindow.show()
  })

  void app.whenReady().then(bootstrap).catch((err) => {
    logger.error('BranchPulse failed to start', err)
    Notification.isSupported() &&
      new Notification({ title: 'BranchPulse', body: 'Failed to start. See logs for details.' }).show()
  })
}
