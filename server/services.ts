import fs from 'node:fs'
import path from 'node:path'
import { StorageService } from '../src-node/services/storage'
import { GitService } from '../src-node/services/git'
import { RepositoryService } from '../src-node/services/repository'
import { BranchService } from '../src-node/services/branch'
import { NamingService } from '../src-node/services/naming'
import { ProtectionService } from '../src-node/services/protection'
import { HealthService } from '../src-node/services/health'
import { MonitoringService } from '../src-node/services/monitoring'
import { EmailService } from '../src-node/services/email'
import { SchedulerService } from '../src-node/services/scheduler'
import { ReportService } from '../src-node/services/report'
import { ReportScheduleService } from '../src-node/services/reportSchedule'
import { AuditService } from '../src-node/services/audit'
import { SettingsService } from '../src-node/services/settings'
import { GitLabService } from '../src-node/services/gitlab'
import { BackupService } from '../src-node/services/backup'
import { ConfigPortService } from '../src-node/services/configPort'
import { createBranchPulseApi, type AppServices, type BranchPulseApi } from '../src-node/api'
import { logger } from '../src-node/utils/logger'
import { appRoot, dataDir, dbFile, ensureDir } from '../src-node/utils/paths'

export interface BootstrapOptions {
  /** Pushed scan progress, wired to the SSE broadcast by the HTTP layer. */
  onProgress?: (progress: import('@shared/types').ScanProgress) => void
  onSettingsSaved?: (settings: import('@shared/types').AppSettings) => void
}

export interface BootstrapResult {
  services: AppServices
  api: BranchPulseApi
  appVersion: string
  /** Stops the scheduler and flushes pending writes. */
  shutdown: () => void
}

function readAppVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Builds the full service graph. Identical wiring to the former Electron main
 * process minus the window/tray/single-instance concerns.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  logger.init()

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
  const backup = new BackupService(
    storage,
    repository,
    audit,
    () => settings.get().gitPath || 'git',
    () => ensureDir(path.join(dataDir(), 'backups'))
  )
  const appVersion = readAppVersion()
  const configPort = new ConfigPortService(storage, () => appVersion)

  const services: AppServices = {
    storage, git, gitlab, repository, branch, naming, protection,
    monitoring, email, scheduler, report, reportSchedules, audit, settings, backup, configPort
  }

  const api = createBranchPulseApi(services, {
    appVersion: () => appVersion,
    onProgress: options.onProgress,
    onSettingsSaved: options.onSettingsSaved
  })

  scheduler.start()
  reportSchedules.start()
  logger.info(`BranchPulse web backend started. Data: ${dataDir()}`)

  return {
    services,
    api,
    appVersion,
    shutdown: () => {
      scheduler.stop()
      reportSchedules.stop()
      storage.flush()
    }
  }
}
