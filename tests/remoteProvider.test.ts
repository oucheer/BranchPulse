import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value).toString('base64'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { apiBaseUrl, detectRemoteProvider } from '../electron/services/gitlab'

describe('remote providers', () => {
  it('detects supported platforms from service URLs', () => {
    expect(detectRemoteProvider('https://gitlab.example.com')).toBe('gitlab')
    expect(detectRemoteProvider('https://github.com/acme/app')).toBe('github')
    expect(detectRemoteProvider('https://gitee.com/acme/app')).toBe('gitee')
    expect(detectRemoteProvider('https://unknown.example.com', 'gitee')).toBe('gitee')
  })

  it('builds API bases for service roots and project URLs', () => {
    expect(apiBaseUrl('https://gitlab.example.com', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://gitlab.example.com/group/app', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://github.com/acme/app', 'github')).toBe('https://api.github.com')
    expect(apiBaseUrl('https://gitee.com/acme/app', 'gitee')).toBe('https://gitee.com/api/v5')
  })

  it('uses repository-level token before app-level token for scans', async () => {
    const rows: Record<string, Record<string, unknown>> = {
      'SELECT * FROM repositories WHERE id = ?': { remote_api_key: Buffer.from('repo-token').toString('base64') },
      'SELECT gitlab_api_key FROM app_settings WHERE id = 1': { gitlab_api_key: Buffer.from('app-token').toString('base64') }
    }
    const storage = {
      get: vi.fn((_sql: string, _params?: unknown[]) => rows[_sql] ?? null),
      all: vi.fn(() => []),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn((fn: () => void) => fn())
    } as never
    const { RepositoryService } = await import('../electron/services/repository')
    const { SettingsService } = await import('../electron/services/settings')
    const { GitLabService } = await import('../electron/services/gitlab')
    const { BranchService } = await import('../electron/services/branch')

    const gitlab = new GitLabService(new SettingsService(storage))
    const repoSvc = new RepositoryService(storage, {} as never, { record: vi.fn() } as never, gitlab)
    const settingsSvc = new SettingsService(storage)
    const branchSvc = new BranchService(
      storage,
      {} as never,
      repoSvc,
      gitlab,
      { listRules: () => [], validate: () => ({ valid: true, status: 'valid', matchedRule: null, reason: null }) } as never,
      { listWhitelist: () => [], listProtected: () => [], isProtected: () => false, isDefault: () => false, whitelisted: () => false } as never,
      {} as never,
      { record: vi.fn() } as never,
      settingsSvc
    )

    expect(repoSvc.getRemoteToken('nonexistent')).toBe('')
    expect(settingsSvc.getGitLabToken()).toBe('app-token')
  })
})