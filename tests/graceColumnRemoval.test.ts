import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { StorageService } from '../electron/services/storage'

/**
 * 宽限期功能整体移除后，旧库里的遗留列必须由 `storage.migrate()` 一次性丢弃。
 * 这里用一个带旧列的真实 sql.js 数据库跑一遍 init()，而不是只检查 SCHEMA 文本。
 */

let workDir: string

async function seedLegacyDatabase(file: string): Promise<void> {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE monitoring_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      stale_threshold_days INTEGER NOT NULL,
      stale_threshold_unit TEXT NOT NULL DEFAULT 'days',
      grace_period_days INTEGER NOT NULL,
      grace_period_unit TEXT NOT NULL DEFAULT 'days',
      fetch_enabled INTEGER NOT NULL DEFAULT 1,
      naming_enabled INTEGER NOT NULL DEFAULT 1,
      email_policy TEXT NOT NULL,
      notification_enabled INTEGER NOT NULL DEFAULT 1,
      notify_target TEXT NOT NULL DEFAULT 'self'
    );
    CREATE TABLE monitoring_rules_repo (
      repository_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      stale_threshold_days INTEGER NOT NULL,
      grace_period_days INTEGER NOT NULL,
      grace_period_unit TEXT NOT NULL DEFAULT 'days'
    );
    CREATE TABLE scan_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      branches INTEGER NOT NULL DEFAULT 0,
      grace_period INTEGER NOT NULL DEFAULT 0,
      grace_expired INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE scan_run_repositories (
      run_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      branches INTEGER NOT NULL DEFAULT 0,
      grace_period INTEGER NOT NULL DEFAULT 0,
      grace_expired INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE email_templates (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL
    );
    INSERT INTO monitoring_rules (id, enabled, stale_threshold_days, grace_period_days, email_policy)
      VALUES (1, 1, 90, 60, 'none');
    INSERT INTO scan_runs (id, started_at, status, trigger, branches, grace_period, grace_expired)
      VALUES ('run-1', '2026-01-01T00:00:00.000Z', 'completed', 'manual', 7, 2, 1);
    INSERT INTO email_templates (id, kind, subject, body) VALUES
      ('t-summary', 'summary', 'GitManager Monitoring Summary', '{{total}} branches checked'),
      ('t-grace', 'grace_period', 'BranchPulse: branch entered grace period', 'Grace period: {{grace_period}} days'),
      ('t-grace-expired', 'grace_expired', 'BranchPulse: grace period expired', 'Grace period expired.');
  `)
  fs.writeFileSync(file, Buffer.from(db.export()))
  db.close()
}

function columns(storage: StorageService, table: string): string[] {
  const rows = (storage as unknown as { db: { exec: (sql: string) => Array<{ values: unknown[][] }> } }).db
    .exec(`PRAGMA table_info(${table})`)[0]?.values ?? []
  return rows.map((row) => String(row[1]))
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-grace-drop-'))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('grace period column removal', () => {
  it('drops every leftover grace column and keeps the remaining data', async () => {
    const file = path.join(workDir, 'legacy.db')
    await seedLegacyDatabase(file)
    const storage = new StorageService(file)
    await storage.init()

    for (const [table, column] of [
      ['monitoring_rules', 'grace_period_days'],
      ['monitoring_rules', 'grace_period_unit'],
      ['monitoring_rules_repo', 'grace_period_days'],
      ['monitoring_rules_repo', 'grace_period_unit'],
      ['scan_runs', 'grace_period'],
      ['scan_runs', 'grace_expired'],
      ['scan_run_repositories', 'grace_period'],
      ['scan_run_repositories', 'grace_expired']
    ]) {
      expect(columns(storage, table), `${table}.${column}`).not.toContain(column)
    }
    // 用户自己改过的阈值不能被迁移顺手覆盖，非宽限期数据必须留下。
    expect(storage.get<Record<string, unknown>>('SELECT stale_threshold_days FROM monitoring_rules WHERE id = 1')?.stale_threshold_days).toBe(90)
    expect(storage.get<Record<string, unknown>>('SELECT COUNT(*) AS n FROM scan_runs')?.n).toBe(1)
    // 旧库残留的宽限期模板行同样要清掉，正常模板不能受牵连。
    expect(storage.all<Record<string, unknown>>('SELECT kind FROM email_templates ORDER BY kind').map((row) => row.kind)).toEqual(['summary'])
    storage.close()
  })

  it('is idempotent: a second init on the same file still succeeds', async () => {
    const file = path.join(workDir, 'legacy.db')
    await seedLegacyDatabase(file)
    const first = new StorageService(file)
    await first.init()
    first.close()

    const second = new StorageService(file)
    await second.init()
    expect(columns(second, 'scan_runs')).not.toContain('grace_expired')
    second.close()
  })
})
