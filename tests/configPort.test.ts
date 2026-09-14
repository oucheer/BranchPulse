import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigPortService } from '../electron/services/configPort'
import { StorageService } from '../electron/services/storage'

let workDir: string
let source: StorageService
let port: ConfigPortService

async function openStorage(name: string): Promise<StorageService> {
  const storage = new StorageService(path.join(workDir, name))
  await storage.init()
  return storage
}

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-config-'))
  source = await openStorage('source.db')
  port = new ConfigPortService(source, () => '0.1.3')
})

afterEach(() => {
  source.close()
  fs.rmSync(workDir, { recursive: true, force: true })
})

function seedSource(): void {
  source.update('app_settings', { language: 'zh', theme: 'light', color_theme: 'ocean', gitlab_url: 'https://gitlab.example.com', gitlab_api_key: 'ENCRYPTED-TOKEN', gitlab_has_key: 1 }, 'id = 1')
  source.update('email_config', { self_email: 'me@example.com', server: 'smtp.example.com', password_encrypted: 'ENCRYPTED-PASSWORD', enabled: 1 }, 'id = 1')
  source.insert('email_groups', { id: 'group-1', name: '审核组', recipients: 'a@example.com,b@example.com', created_at: '2026-01-01T00:00:00.000Z' })
  source.insert('branch_naming_rules', { id: 'rule-1', name: 'feature/*', pattern: 'feature/*', type: 'glob', mode: 'allow', description: 'Feature', enabled: 1, priority: 5, repository_id: null })
  source.insert('whitelist', { id: 'wl-1', pattern: 'release/*', type: 'glob', note: '发布分支', created_at: '2026-01-01T00:00:00.000Z' })
  source.insert('monitoring_rules_repo', { repository_id: 'repo-1', enabled: 1, stale_threshold_days: 180, grace_period_days: 60, stale_threshold_unit: 'days', grace_period_unit: 'days', fetch_enabled: 1, naming_enabled: 1, email_policy: 'summary', notification_enabled: 1, auto_delete_enabled: 0, notify_target: 'both' })
  source.insert('scheduler_jobs', { id: 'job-1', name: '每晚检查', kind: 'interval', enabled: 1, interval_hours: 24, interval_minutes: 1440, days_json: '[]', time: '09:00', email_policy: 'summary', fetch_enabled: 1, auto_delete_enabled: 0, notify_target: 'self', created_at: '2026-01-01T00:00:00.000Z' })
  source.insert('repositories', { id: 'repo-1', name: 'demo', path: 'gitlab://1', source: 'gitlab', gitlab_project_id: 1, remote_project_path: 'group/demo', web_url: 'https://gitlab.example.com/group/demo', remote_api_key: 'ENCRYPTED-REPO-KEY', created_at: '2026-01-01T00:00:00.000Z' })
}

function exportedBundle(sections: string[]): Record<string, any> {
  const target = path.join(workDir, 'bundle.json')
  const result = port.exportToFile(target, { effects: { enabled: false, clickSpark: true }, language: 'zh' })
  expect(result.sections).toEqual(expect.arrayContaining(sections))
  return JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, any>
}

describe('config export', () => {
  it('never writes credentials into the bundle', () => {
    seedSource()
    const file = path.join(workDir, 'bundle-secrets.json')
    port.exportToFile(file, {})
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('ENCRYPTED-TOKEN')
    expect(raw).not.toContain('ENCRYPTED-PASSWORD')
    expect(raw).not.toContain('ENCRYPTED-REPO-KEY')
    expect(raw).not.toContain('gitlab_api_key')
    expect(raw).not.toContain('password_encrypted')
    expect(raw).not.toContain('remote_api_key')
  })

  it('captures rules, settings, mail groups, monitoring and repositories', () => {
    seedSource()
    const bundle = exportedBundle(['app_settings', 'monitoring_rules', 'branch_naming_rules', 'whitelist', 'email_groups', 'scheduler_jobs', 'repositories', 'monitoring_rules_repo'])
    expect(bundle.app).toBe('BranchPulse')
    expect(bundle.sections.extras).toEqual({ effects: { enabled: false, clickSpark: true }, language: 'zh' })
    expect(bundle.sections.singletons.app_settings.language).toBe('zh')
    expect(bundle.sections.singletons.email_config.self_email).toBe('me@example.com')
    expect(bundle.sections.collections.email_groups).toHaveLength(1)
    expect(bundle.sections.collections.scheduler_jobs[0].interval_minutes).toBe(1440)
    expect(bundle.sections.collections.repositories[0].remote_project_path).toBe('group/demo')
  })
})

describe('config import', () => {
  it('restores the exported state on a clean database', async () => {
    seedSource()
    const target = path.join(workDir, 'bundle.json')
    port.exportToFile(target, { effects: { enabled: false, clickAuto: true }, language: 'zh' })

    const fresh = await openStorage('target.db')
    const freshPort = new ConfigPortService(fresh, () => '0.1.3')
    const summary = freshPort.importFromFile(target)
    expect(summary.applied).toEqual(expect.arrayContaining(['app_settings', 'email_groups', 'branch_naming_rules', 'repositories']))

    const settings = fresh.all<Record<string, unknown>>('SELECT * FROM app_settings WHERE id = 1')[0]
    expect(String(settings.language)).toBe('zh')
    expect(String(settings.gitlab_url)).toBe('https://gitlab.example.com')
    expect(String(settings.color_theme)).toBe('ocean')
    const email = fresh.all<Record<string, unknown>>('SELECT * FROM email_config WHERE id = 1')[0]
    expect(String(email.self_email)).toBe('me@example.com')
    expect(email.password_encrypted ?? '').toBe('')
    const repos = fresh.all<Record<string, unknown>>('SELECT * FROM repositories')
    expect(repos).toHaveLength(1)
    expect(String(repos[0].remote_api_key)).toBe('')
    const jobs = fresh.all<Record<string, unknown>>('SELECT * FROM scheduler_jobs')
    expect(jobs).toHaveLength(1)
    expect(String(jobs[0].name)).toBe('每晚检查')
    fresh.close()
  })

  it('keeps local credentials that are not part of the bundle', async () => {
    seedSource()
    const target = path.join(workDir, 'bundle.json')
    port.exportToFile(target, {})

    const local = await openStorage('local.db')
    local.update('app_settings', { gitlab_api_key: 'LOCAL-TOKEN', gitlab_has_key: 1 }, 'id = 1')
    local.insert('repositories', { id: 'repo-1', name: 'demo', path: 'gitlab://1', source: 'gitlab', gitlab_project_id: 1, remote_project_path: 'group/demo', remote_api_key: 'LOCAL-REPO-KEY', created_at: '2026-01-01T00:00:00.000Z' })
    const localPort = new ConfigPortService(local, () => '0.1.3')
    localPort.importFromFile(target)

    const settings = local.all<Record<string, unknown>>('SELECT * FROM app_settings WHERE id = 1')[0]
    expect(String(settings.gitlab_api_key)).toBe('LOCAL-TOKEN')
    expect(Number(settings.gitlab_has_key)).toBe(1)
    const repo = local.all<Record<string, unknown>>('SELECT * FROM repositories')[0]
    expect(String(repo.remote_api_key)).toBe('LOCAL-REPO-KEY')
    local.close()
  })

  it('rejects files that were not produced by BranchPulse', () => {
    expect(() => port.importFromFile(path.join(workDir, 'missing.json'))).toThrow(/配置文件不存在/)
    const bogus = path.join(workDir, 'bogus.json')
    fs.writeFileSync(bogus, JSON.stringify({ app: 'Other' }))
    expect(() => port.importFromFile(bogus)).toThrow(/不是 BranchPulse/)
  })

  it('drops cached branches that point at repositories missing from the bundle', async () => {
    seedSource()
    const target = path.join(workDir, 'bundle.json')
    port.exportToFile(target, {})

    const local = await openStorage('orphan.db')
    local.insert('branches', { id: 'b1', key: 'old-repo|remote|feature/x', repository_id: 'old-repo', name: 'feature/x', type: 'remote', data_json: '{}' })
    const localPort = new ConfigPortService(local, () => '0.1.3')
    const summary = localPort.importFromFile(target)
    expect(local.all('SELECT * FROM branches')).toHaveLength(0)
    expect(summary.warnings.join(' ')).toContain('branches')
    local.close()
  })
})
