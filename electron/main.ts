import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, shell } from 'electron'
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
import { AuditService } from './services/audit'
import { SettingsService } from './services/settings'
import { GitLabService } from './services/gitlab'
import { registerIpc, type AppServices } from './ipc'
import { logger } from './utils/logger'
import { dataDir, dbFile } from './utils/paths'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let services: AppServices | null = null

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
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
    if (services?.settings.get().trayEnabled) {
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
  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: showWindow },
    {
      label: 'Run Check Now',
      click: () => {
        void services?.monitoring.runCheckNow({ trigger: 'manual' })
        showWindow()
      }
    },
    { label: 'View Notifications', click: showWindow },
    {
      label: 'Generate Report',
      click: () => {
        void services?.report.generateReport('on-demand', 'pdf')
        showWindow()
      }
    },
    { type: 'separator' },
    {
      label: 'Pause Monitoring',
      click: () => {
        const job = services?.scheduler.listJobs().find((j) => j.enabled)
        if (job) services?.scheduler.saveJob({ ...job, enabled: false })
      }
    },
    {
      label: 'Resume Monitoring',
      click: () => {
        const job = services?.scheduler.listJobs().find((j) => !j.enabled)
        if (job) services?.scheduler.saveJob({ ...job, enabled: true })
      }
    },
    { type: 'separator' },
    { label: 'Settings', click: showWindow },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', showWindow)
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
  const branch = new BranchService(storage, git, repository, gitlab, naming, protection, health, audit)
  const email = new EmailService(storage, audit)
  const monitoring = new MonitoringService(storage, branch, repository, email, audit)
  const scheduler = new SchedulerService(storage, monitoring, audit)
  const report = new ReportService(storage, branch, repository, audit)
  const deletionEngine = new DeletionPolicyEngine()
  const deletionTokens = new DeletionTokenRegistry()

  services = {
    storage, git, gitlab, repository, branch, naming, protection, deletionEngine, deletionTokens,
    monitoring, email, scheduler, report, audit, settings
  }

  registerIpc(services)
  scheduler.start()
  createWindow()
  createTray()

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
    if (process.platform !== 'darwin' && !services?.settings.get().trayEnabled) {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    services?.storage.flush()
    services?.scheduler.stop()
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
