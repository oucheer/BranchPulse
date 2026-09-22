import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import type { Repository } from '@shared/types'
import { StorageService, parseStringArray } from '../electron/services/storage'

/**
 * 旧版本用单个可空 `repository_id` 表示范围，NULL 等于「全部仓库」。
 * 迁移必须一次性把它展开为迁移时存在的仓库 ID 快照；迁移完成后空数组
 * 只表示「没有仓库」，重复执行迁移也不得重新展开成全部仓库。
 */

let workDir: string
let file: string

async function seedLegacyDatabase(target: string): Promise<void> {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme TEXT NOT NULL DEFAULT 'dark',
      language TEXT NOT NULL DEFAULT 'zh',
      notifications_enabled INTEGER NOT NULL DEFAULT 1,
      tray_enabled INTEGER NOT NULL DEFAULT 1,
      launch_minimized INTEGER NOT NULL DEFAULT 0,
      start_with_windows INTEGER NOT NULL DEFAULT 0,
      fetch_policy TEXT NOT NULL DEFAULT 'auto',
      active_repository_id TEXT
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE scheduler_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_hours INTEGER NOT NULL DEFAULT 24,
      days_json TEXT,
      time TEXT,
      email_policy TEXT NOT NULL,
      fetch_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      repository_id TEXT
    );
    CREATE TABLE report_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      frequency TEXT NOT NULL,
      time TEXT,
      weekday INTEGER,
      day_of_month INTEGER,
      run_at TEXT,
      recipients TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      repository_id TEXT
    );
    CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      title TEXT,
      generated_at TEXT NOT NULL,
      period TEXT,
      format TEXT,
      path TEXT,
      summary_json TEXT,
      repository_id TEXT
    );
    CREATE TABLE monitoring_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      stale_threshold_days INTEGER NOT NULL,
      fetch_enabled INTEGER NOT NULL DEFAULT 1,
      naming_enabled INTEGER NOT NULL DEFAULT 1,
      email_policy TEXT NOT NULL,
      notification_enabled INTEGER NOT NULL DEFAULT 1,
      notify_target TEXT NOT NULL DEFAULT 'self'
    );
    CREATE TABLE whitelist (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      type TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      repository_id TEXT
    );
    INSERT INTO app_settings (id, theme, language, active_repository_id) VALUES (1, 'dark', 'zh', NULL);
    INSERT INTO repositories (id, name, path, created_at) VALUES
      ('repo-1', 'Alpha', 'gitlab://1', '2026-01-01T00:00:00.000Z'),
      ('repo-2', 'Beta', 'gitlab://2', '2026-01-02T00:00:00.000Z');
    INSERT INTO scheduler_jobs (id, name, kind, email_policy, created_at, repository_id)
      VALUES ('job-all', '全部仓库任务', 'interval', 'none', '2026-01-03T00:00:00.000Z', NULL);
    INSERT INTO report_schedules (id, name, frequency, time, recipients, created_at, repository_id)
      VALUES ('schedule-one', '单仓库报告', 'daily', '09:00', 'self', '2026-01-03T00:00:00.000Z', 'repo-2');
    INSERT INTO reports (id, title, generated_at, period, format, path, repository_id)
      VALUES ('report-all', '旧报告', '2026-01-04T00:00:00.000Z', 'manual', 'html', '', NULL);
    INSERT INTO monitoring_rules (id, enabled, stale_threshold_days, email_policy, notify_target)
      VALUES (1, 1, 45, 'none', 'self');
    INSERT INTO whitelist (id, pattern, type, note, created_at, repository_id)
      VALUES ('wl-template', 'release/*', 'glob', '发布分支', '2026-01-05T00:00:00.000Z', NULL);
  `)
  fs.writeFileSync(target, Buffer.from(db.export()))
  db.close()
}

async function open(): Promise<StorageService> {
  const storage = new StorageService(file)
  await storage.init()
  return storage
}

function selection(storage: StorageService): string[] {
  const row = storage.get<Record<string, unknown>>('SELECT selected_repository_ids_json FROM app_settings WHERE id = 1')
  return parseStringArray(row?.selected_repository_ids_json)
}

function idsFrom(storage: StorageService, table: string): string[] {
  return storage
    .all<Record<string, unknown>>(`SELECT repository_ids_json FROM ${table}`)
    .flatMap((row) => parseStringArray(row.repository_ids_json))
}

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-legacy-scope-'))
  file = path.join(workDir, 'legacy.db')
  await seedLegacyDatabase(file)
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('legacy scope migration', () => {
  it('expands the old null scope into a snapshot of the repositories that exist at migration time', async () => {
    const storage = await open()

    expect(selection(storage)).toEqual(['repo-1', 'repo-2'])
    expect(storage.all<Record<string, unknown>>('SELECT repository_ids_json FROM scheduler_jobs WHERE id = ?', ['job-all'])[0].repository_ids_json)
      .toBe(JSON.stringify(['repo-1', 'repo-2']))
    // 旧单仓库值只变成单元素数组，不会被扩大。
    expect(storage.all<Record<string, unknown>>('SELECT repository_ids_json FROM report_schedules WHERE id = ?', ['schedule-one'])[0].repository_ids_json)
      .toBe(JSON.stringify(['repo-2']))
    expect(storage.all<Record<string, unknown>>('SELECT repository_ids_json FROM reports WHERE id = ?', ['report-all'])[0].repository_ids_json)
      .toBe(JSON.stringify(['repo-1', 'repo-2']))
    storage.close()
  })

  it('gives every migrated repository its own monitoring, naming and protection configuration', async () => {
    const storage = await open()

    const monitoring = storage.all<Record<string, unknown>>(
      'SELECT repository_id, stale_threshold_days FROM monitoring_rules_repo ORDER BY repository_id'
    )
    expect(monitoring.map((row) => String(row.repository_id))).toEqual(['repo-1', 'repo-2'])
    // 全局阈值 45 天在迁移时复制为每个仓库的独立起点。
    expect(monitoring.every((row) => Number(row.stale_threshold_days) === 45)).toBe(true)

    for (const repositoryId of ['repo-1', 'repo-2']) {
      const whitelist = storage.all<Record<string, unknown>>(
        'SELECT id FROM whitelist WHERE repository_id = ?',
        [repositoryId]
      )
      expect(whitelist).toHaveLength(1)
      const naming = storage.all<Record<string, unknown>>(
        'SELECT id FROM branch_naming_rules WHERE repository_id = ?',
        [repositoryId]
      )
      expect(naming.length).toBeGreaterThan(0)
    }
    storage.close()
  })

  it('is idempotent and never re-expands an empty selection back to every repository', async () => {
    const first = await open()
    const firstRules = first.all<Record<string, unknown>>('SELECT id FROM branch_naming_rules WHERE repository_id = ?', ['repo-1'])
    const firstWhitelist = first.all<Record<string, unknown>>('SELECT id FROM whitelist WHERE repository_id = ?', ['repo-1'])
    // 用户主动清空勾选：这是「没有仓库」，不是「全部仓库」。
    first.update('app_settings', { selected_repository_ids_json: '[]' }, 'id = 1')
    first.update('scheduler_jobs', { repository_ids_json: '[]' }, 'id = ?', ['job-all'])
    first.close()

    const second = await open()
    expect(selection(second)).toEqual([])
    expect(second.all<Record<string, unknown>>('SELECT repository_ids_json FROM scheduler_jobs')[0].repository_ids_json).toBe('[]')
    expect(idsFrom(second, 'reports')).toEqual(['repo-1', 'repo-2'])
    expect(second.all<Record<string, unknown>>('SELECT id FROM branch_naming_rules WHERE repository_id = ?', ['repo-1']))
      .toEqual(firstRules)
    expect(second.all<Record<string, unknown>>('SELECT id FROM whitelist WHERE repository_id = ?', ['repo-1']))
      .toEqual(firstWhitelist)
    expect(second.all<Record<string, unknown>>('SELECT repository_id FROM monitoring_rules_repo')).toHaveLength(2)
    second.close()
  })
})

describe('repository removal cleanup', () => {
  function repository(id: string, name: string): Repository {
    return {
      id,
      name,
      path: `gitlab://${id}`,
      source: 'gitlab',
      remoteProjectPath: `group/${name}`,
      gitlabProjectId: 1,
      webUrl: `https://gitlab.example.com/group/${name}`,
      currentBranch: 'main',
      defaultBranch: 'main',
      remotes: [],
      lastFetchAt: null,
      lastScanAt: null,
      totalBranches: 0,
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  }

  async function withTwoRepositories(): Promise<{ storage: StorageService; reportFile: string; backupDir: string }> {
    const storage = await open()
    for (const repo of [repository('repo-1', 'Alpha'), repository('repo-2', 'Beta')]) {
      // 旧库种子里已经有这两个仓库，这里只在缺失时补建，避免主键冲突。
      if (!storage.get<Record<string, unknown>>('SELECT id FROM repositories WHERE id = ?', [repo.id])) {
        storage.insert('repositories', {
          id: repo.id,
          name: repo.name,
          path: repo.path,
          source: repo.source,
          gitlab_project_id: repo.gitlabProjectId,
          remote_project_path: repo.remoteProjectPath,
          web_url: repo.webUrl,
          created_at: repo.createdAt
        })
      }
      storage.ensureRepositoryConfiguration(repo.id)
      storage.insert('branches', {
        id: `branch-${repo.id}`,
        key: `${repo.id}|remote|feature/x`,
        repository_id: repo.id,
        name: 'feature/x',
        type: 'remote',
        data_json: '{}'
      })
      storage.insert('notification_history', {
        id: `note-${repo.id}`,
        dedup_key: `${repo.id}|feature/x|stale|stale`,
        repository_id: repo.id,
        repository_name: repo.name,
        branch: 'feature/x',
        type: 'stale',
        created_at: '2026-01-06T00:00:00.000Z'
      })
    }

    const reportFile = path.join(workDir, 'report-alpha.html')
    fs.writeFileSync(reportFile, '<html>alpha</html>', 'utf8')
    const backupDir = path.join(workDir, 'backup-alpha.git')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'HEAD'), 'ref', 'utf8')

    storage.insert('reports', {
      id: 'report-alpha',
      title: 'Alpha 报告',
      repository_ids_json: JSON.stringify(['repo-1']),
      generated_at: '2026-01-07T00:00:00.000Z',
      period: 'manual',
      format: 'html',
      path: reportFile,
      summary_json: '{}'
    })
    storage.insert('reports', {
      id: 'report-both',
      title: '两个仓库的报告',
      repository_ids_json: JSON.stringify(['repo-1', 'repo-2']),
      generated_at: '2026-01-08T00:00:00.000Z',
      period: 'manual',
      format: 'html',
      path: '',
      summary_json: '{}'
    })
    storage.insert('backup_records', {
      id: 'backup-alpha',
      repository_id: 'repo-1',
      repository_name: 'Alpha',
      path: backupDir,
      target_directory: workDir,
      remote_url: 'https://example.com/alpha.git',
      status: 'success',
      size_bytes: 3,
      created_at: '2026-01-09T00:00:00.000Z'
    })
    storage.insert('scheduler_jobs', {
      id: 'job-alpha-only',
      repository_id: 'repo-1',
      repository_ids_json: JSON.stringify(['repo-1']),
      name: 'Alpha 任务',
      kind: 'interval',
      enabled: 1,
      interval_hours: 24,
      interval_minutes: 1440,
      days_json: '[]',
      time: '09:00',
      email_policy: 'none',
      fetch_enabled: 1,
      notify_target: 'self',
      created_at: '2026-01-10T00:00:00.000Z'
    })
    storage.insert('scheduler_jobs', {
      id: 'job-both',
      repository_id: 'repo-1',
      repository_ids_json: JSON.stringify(['repo-1', 'repo-2']),
      name: '共享任务',
      kind: 'interval',
      enabled: 1,
      interval_hours: 24,
      interval_minutes: 1440,
      days_json: '[]',
      time: '09:00',
      email_policy: 'none',
      fetch_enabled: 1,
      notify_target: 'self',
      created_at: '2026-01-11T00:00:00.000Z'
    })
    storage.insert('scan_runs', {
      id: 'run-alpha',
      started_at: '2026-01-12T00:00:00.000Z',
      status: 'completed',
      trigger: 'manual'
    })
    storage.insert('scan_run_repositories', { run_id: 'run-alpha', repository_id: 'repo-1', branches: 1 })
    return { storage, reportFile, backupDir }
  }

  it('removes every trace of the deleted repository and keeps the others intact', async () => {
    const { storage, reportFile, backupDir } = await withTwoRepositories()
    storage.update('app_settings', { selected_repository_ids_json: JSON.stringify(['repo-1', 'repo-2']) }, 'id = 1')

    storage.removeRepositoryReferences('repo-1')

    expect(storage.all<Record<string, unknown>>('SELECT id FROM repositories').map((row) => String(row.id))).toEqual(['repo-2'])
    expect(selection(storage)).toEqual(['repo-2'])
    expect(storage.all<Record<string, unknown>>('SELECT id FROM branches').map((row) => String(row.id))).toEqual(['branch-repo-2'])
    expect(storage.all<Record<string, unknown>>('SELECT id FROM notification_history').map((row) => String(row.id))).toEqual(['note-repo-2'])
    expect(storage.all<Record<string, unknown>>('SELECT repository_id FROM monitoring_rules_repo')).toHaveLength(1)
    // 已删除仓库的规则行必须清空；保留的 NULL 行是迁移前的全局模板，运行时不再回退到它。
    expect(storage.all<Record<string, unknown>>('SELECT repository_id FROM branch_naming_rules WHERE repository_id = ?', ['repo-1'])).toEqual([])
    expect(storage.all<Record<string, unknown>>('SELECT repository_id FROM branch_naming_rules WHERE repository_id = ?', ['repo-2']).length).toBeGreaterThan(0)
    expect(storage.all<Record<string, unknown>>('SELECT repository_id FROM whitelist WHERE repository_id = ?', ['repo-1'])).toEqual([])
    expect(storage.all<Record<string, unknown>>('SELECT repository_id FROM whitelist WHERE repository_id = ?', ['repo-2']).length).toBeGreaterThan(0)
    expect(storage.get('SELECT 1 AS x FROM scan_runs WHERE id = ?', ['run-alpha'])).toBeUndefined()
    expect(storage.get('SELECT 1 AS x FROM scan_run_repositories WHERE run_id = ?', ['run-alpha'])).toBeUndefined()

    // 包含已删除仓库的报告记录与文件一并移除，避免旧报告继续泄漏。
    expect(storage.all<Record<string, unknown>>('SELECT id FROM reports').map((row) => String(row.id))).toEqual([])
    expect(fs.existsSync(reportFile)).toBe(false)
    expect(storage.all<Record<string, unknown>>('SELECT id FROM backup_records')).toEqual([])
    expect(fs.existsSync(backupDir)).toBe(false)

    // 只属于已删除仓库的任务删除；共享任务（含迁移快照展开的旧「全部仓库」任务）
    // 收缩为剩余的仓库。
    const jobs = storage.all<Record<string, unknown>>('SELECT id, repository_ids_json FROM scheduler_jobs ORDER BY id')
    expect(jobs.map((row) => String(row.id))).toEqual(['job-all', 'job-both'])
    expect(jobs.every((row) => JSON.stringify(parseStringArray(row.repository_ids_json)) === JSON.stringify(['repo-2']))).toBe(true)
    storage.close()
  })

  it('does not touch other repositories when the deleted one is not in any scope', async () => {
    const { storage } = await withTwoRepositories()
    const before = storage.all<Record<string, unknown>>('SELECT id FROM branches').length
    storage.removeRepositoryReferences('repo-unknown')
    expect(storage.all<Record<string, unknown>>('SELECT id FROM branches')).toHaveLength(before)
    storage.close()
  })
})
