import { describe, expect, it, vi } from 'vitest'
import type { Repository, ScanProgress } from '@shared/types'
import { MonitoringService } from '../electron/services/monitoring'
import type { BranchService } from '../electron/services/branch'
import type { EmailService } from '../electron/services/email'
import type { RepositoryService } from '../electron/services/repository'
import type { StorageService } from '../electron/services/storage'
import type { AuditService } from '../electron/services/audit'

/**
 * A scan that could not reach the forge used to end as a `completed` run with
 * "0 branches", which is indistinguishable from a genuinely empty repository —
 * the reported symptom was "the repository was added but no branches showed up".
 * The reason now reaches `run.error` (persisted, shown in the UI) and the run is
 * only `completed` when at least one repository produced a result.
 */

function setup(scan: (id: string) => Promise<unknown[]>): {
  service: MonitoringService
  progress: ScanProgress[]
} {
  const repos = [
    { id: 'repo-1', name: 'alpha' },
    { id: 'repo-2', name: 'beta' }
  ] as Repository[]

  const storage = {
    get: (query: string) => (query.includes('monitoring_rules') ? { enabled: 1 } : undefined),
    all: () => [],
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    selectedRepositoryIds: () => ['repo-1', 'repo-2']
  } as unknown as StorageService

  const branchService = { scanRepository: (id: string) => scan(id) } as unknown as BranchService
  const repository = { list: () => repos } as unknown as RepositoryService
  const email = {
    getConfig: () => ({ enabled: false }),
    listGroups: () => [],
    sendSummaryEmail: async () => ({ ok: true, message: 'sent', emailsSent: 0 }),
    sendCreatorEmails: async () => ({ ok: true, message: 'sent', emailsSent: 0 })
  } as unknown as EmailService
  const audit = { record: vi.fn() } as unknown as AuditService

  const service = new MonitoringService(storage, branchService, repository, email, audit)
  const progress: ScanProgress[] = []
  service.onProgress = (item) => progress.push(item)
  return { service, progress }
}

describe('monitoring check with unreachable repositories', () => {
  it('reports the failure instead of a silent zero-branch success', async () => {
    const { service } = setup(async () => {
      throw new Error('Remote repository API 404 Not Found')
    })

    const run = await service.runCheckNow({ bypassEnabledCheck: true })

    expect(run.status).toBe('failed')
    expect(run.branches).toBe(0)
    expect(run.error).toContain('alpha')
    expect(run.error).toContain('Remote repository API 404 Not Found')
    expect(run.error).toContain('beta')
    // The reason is in the persisted activity log as well, so the run detail and
    // the log file both explain what happened.
    expect(run.activity.some((item) => item.level === 'error' && item.message.includes('404'))).toBe(true)
  })

  it('keeps the successful repositories and downgrades a partial failure to a warning', async () => {
    const { service } = setup(async (id) => {
      if (id === 'repo-2') throw new Error('API token 无效')
      return []
    })

    const run = await service.runCheckNow({ bypassEnabledCheck: true })

    expect(run.status).toBe('completed')
    expect(run.error).toContain('beta')
    expect(run.error).not.toContain('alpha')
  })

  it('leaves a fully successful run without an error', async () => {
    const { service } = setup(async () => [])

    const run = await service.runCheckNow({ bypassEnabledCheck: true })

    expect(run.status).toBe('completed')
    expect(run.error).toBeNull()
  })

  it('broadcasts the final status so the UI can stop spinning', async () => {
    const { service, progress } = setup(async () => {
      throw new Error('boom')
    })

    await service.runCheckNow({ bypassEnabledCheck: true })

    expect(progress.at(-1)?.summary?.status).toBe('failed')
  })
})
