import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs, { type Database } from 'sql.js'
import { dbFile } from '../utils/paths'
import { newId, nowIso } from '../utils/ids'
import { logger } from '../utils/logger'

type Row = Record<string, unknown>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  gitlab_url TEXT,
  gitlab_project_id INTEGER,
  web_url TEXT,
  remote_project_path TEXT,
  remote_api_key TEXT,
  current_branch TEXT,
  default_branch TEXT,
  remotes_json TEXT,
  last_fetch_at TEXT,
  last_scan_at TEXT,
  total_branches INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_branches_repo ON branches (repository_id);
CREATE INDEX IF NOT EXISTS idx_branches_key ON branches (key);

CREATE TABLE IF NOT EXISTS branch_snapshots (
  key TEXT PRIMARY KEY,
  sha TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS branch_naming_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  type TEXT NOT NULL,
  mode TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  repository_id TEXT
);

CREATE TABLE IF NOT EXISTS monitoring_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  stale_threshold_days INTEGER NOT NULL,
  grace_period_days INTEGER NOT NULL,
  stale_threshold_unit TEXT NOT NULL DEFAULT 'days',
  grace_period_unit TEXT NOT NULL DEFAULT 'days',
  fetch_enabled INTEGER NOT NULL DEFAULT 1,
  naming_enabled INTEGER NOT NULL DEFAULT 1,
  email_policy TEXT NOT NULL,
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  auto_delete_enabled INTEGER NOT NULL DEFAULT 0,
  notify_target TEXT NOT NULL DEFAULT 'self'
);

CREATE TABLE IF NOT EXISTS scheduler_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  days_json TEXT,
  time TEXT,
  start_date TEXT,
  end_date TEXT,
  email_policy TEXT NOT NULL,
  fetch_enabled INTEGER NOT NULL DEFAULT 1,
  auto_delete_enabled INTEGER NOT NULL DEFAULT 0,
  notify_target TEXT NOT NULL DEFAULT 'self',
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  repository_id TEXT
);

CREATE TABLE IF NOT EXISTS notification_history (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  repository_id TEXT,
  repository_name TEXT,
  branch TEXT,
  type TEXT NOT NULL,
  state TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  desktop INTEGER NOT NULL DEFAULT 0,
  email INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server TEXT,
  port INTEGER,
  username TEXT,
  password_encrypted TEXT,
  from_address TEXT,
  secure INTEGER NOT NULL DEFAULT 1,
  tls INTEGER NOT NULL DEFAULT 0,
  test_recipient TEXT,
  enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  title TEXT,
  repository_id TEXT,
  generated_at TEXT NOT NULL,
  period TEXT,
  format TEXT,
  path TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repository_id TEXT,
  frequency TEXT NOT NULL,
  time TEXT,
  weekday INTEGER,
  day_of_month INTEGER,
  run_at TEXT,
  recipients TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_rules_repo (
  repository_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  stale_threshold_days INTEGER NOT NULL,
  grace_period_days INTEGER NOT NULL,
  stale_threshold_unit TEXT NOT NULL DEFAULT 'days',
  grace_period_unit TEXT NOT NULL DEFAULT 'days',
  fetch_enabled INTEGER NOT NULL DEFAULT 1,
  naming_enabled INTEGER NOT NULL DEFAULT 1,
  email_policy TEXT NOT NULL DEFAULT 'none',
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  auto_delete_enabled INTEGER NOT NULL DEFAULT 0,
  notify_target TEXT NOT NULL DEFAULT 'self'
);

CREATE TABLE IF NOT EXISTS email_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recipients TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  path TEXT NOT NULL,
  target_directory TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  status TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whitelist (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  repository_id TEXT
);

CREATE TABLE IF NOT EXISTS protected_branches (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  repository_id TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'dark',
  language TEXT NOT NULL DEFAULT 'zh',
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  tray_enabled INTEGER NOT NULL DEFAULT 1,
  launch_minimized INTEGER NOT NULL DEFAULT 0,
  start_with_windows INTEGER NOT NULL DEFAULT 0,
  git_path TEXT,
  fetch_policy TEXT NOT NULL DEFAULT 'auto',
  gitlab_url TEXT,
  gitlab_api_key TEXT,
  gitlab_has_key INTEGER NOT NULL DEFAULT 0,
  active_repository_id TEXT,
  deletion_disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  health_avg REAL,
  health_best REAL,
  health_worst REAL,
  repositories INTEGER NOT NULL DEFAULT 0,
  branches INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  grace_period INTEGER NOT NULL DEFAULT 0,
  grace_expired INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  naming_invalid INTEGER NOT NULL DEFAULT 0,
  cleanup_candidates INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  notifications INTEGER NOT NULL DEFAULT 0,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  activity_json TEXT
);

CREATE TABLE IF NOT EXISTS scan_run_repositories (
  run_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repositories INTEGER NOT NULL DEFAULT 1,
  branches INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  grace_period INTEGER NOT NULL DEFAULT 0,
  grace_expired INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  naming_invalid INTEGER NOT NULL DEFAULT 0,
  cleanup_candidates INTEGER NOT NULL DEFAULT 0,
  health_avg REAL,
  health_best REAL,
  health_worst REAL,
  PRIMARY KEY (run_id, repository_id)
);
`

function defaultNamingRules(): Array<Record<string, unknown>> {
  const rules: Array<Record<string, unknown>> = [
    { name: 'feature/*', pattern: 'feature/*', type: 'glob', mode: 'allow', description: 'Feature branches', priority: 10 },
    { name: 'bugfix/*', pattern: 'bugfix/*', type: 'glob', mode: 'allow', description: 'Bugfix branches', priority: 20 },
    { name: 'hotfix/*', pattern: 'hotfix/*', type: 'glob', mode: 'allow', description: 'Hotfix branches', priority: 40 },
    { name: 'release/*', pattern: 'release/*', type: 'glob', mode: 'allow', description: 'Release branches', priority: 50 },
    { name: 'docs/*', pattern: 'docs/*', type: 'glob', mode: 'allow', description: 'Documentation branches', priority: 70 },
    { name: 'chore/*', pattern: 'chore/*', type: 'glob', mode: 'allow', description: 'Chore branches', priority: 90 },
    {
      name: 'Conventional prefix',
      pattern: '^(feature|bugfix|hotfix|release|chore|docs)\\/[a-z0-9._-]+$',
      type: 'regex',
      mode: 'allow',
      description: 'Conventional branch naming',
      priority: 100
    }
  ]
  return rules
}

function defaultExcludeRules(): Array<Record<string, unknown>> {
  return [
    { name: 'main', pattern: 'main', type: 'exact', mode: 'exclude', description: 'Default branch', priority: 1 },
    { name: 'develop', pattern: 'develop', type: 'exact', mode: 'exclude', description: 'Integration branch', priority: 2 },
    { name: 'master', pattern: 'master', type: 'exact', mode: 'exclude', description: 'Legacy default branch', priority: 3 }
  ]
}

export class StorageService {
  private db: Database
  private file: string
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(file?: string) {
    this.file = file ?? dbFile()
    this.db = undefined as unknown as Database
  }

  async init(): Promise<void> {
    const require = createRequire(path.join(__dirname, 'index.js'))
    let wasmBinary: ArrayBuffer | null = null
    try {
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
      wasmBinary = fs.readFileSync(wasmPath) as unknown as ArrayBuffer
    } catch (err) {
      logger.warn(`sql.js wasm not resolved from node_modules: ${String(err)}`)
      const packagedWasmPath = path.join(__dirname, 'sql-wasm.wasm')
      if (fs.existsSync(packagedWasmPath)) {
        wasmBinary = fs.readFileSync(packagedWasmPath) as unknown as ArrayBuffer
        logger.info('Loaded sql.js wasm from packaged runtime.')
      }
    }
    const SQL = await initSqlJs({ wasmBinary: wasmBinary ?? undefined })
    if (fs.existsSync(this.file)) {
      const fileBuffer = fs.readFileSync(this.file)
      this.db = new SQL.Database(fileBuffer)
    } else {
      this.db = new SQL.Database()
    }
    this.db.run(SCHEMA)
    this.migrate()
    this.seed()
    this.save()
    logger.info(`Storage ready at ${this.file}`)
  }

  private migrate(): void {
    this.ensureColumn('repositories', 'source', "TEXT NOT NULL DEFAULT 'local'")
    this.ensureColumn('repositories', 'gitlab_url', 'TEXT')
    this.ensureColumn('repositories', 'gitlab_project_id', 'INTEGER')
    this.ensureColumn('repositories', 'web_url', 'TEXT')
    this.ensureColumn('repositories', 'remote_project_path', 'TEXT')
    this.ensureColumn('repositories', 'remote_api_key', 'TEXT')
    this.ensureColumn('monitoring_rules', 'enabled', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('monitoring_rules', 'stale_threshold_unit', `TEXT NOT NULL DEFAULT 'days'`)
    this.ensureColumn('monitoring_rules', 'grace_period_unit', `TEXT NOT NULL DEFAULT 'days'`)
    this.ensureColumn('monitoring_rules', 'auto_delete_enabled', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('monitoring_rules', 'notify_target', "TEXT NOT NULL DEFAULT 'self'")
    this.ensureColumn('scheduler_jobs', 'auto_delete_enabled', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('scheduler_jobs', 'notify_target', "TEXT NOT NULL DEFAULT 'self'")
    this.ensureColumn('scheduler_jobs', 'interval_minutes', 'INTEGER NOT NULL DEFAULT 1440')
    this.ensureColumn('scan_runs', 'deleted', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('scan_runs', 'health_avg', 'REAL')
    this.ensureColumn('scan_runs', 'health_best', 'REAL')
    this.ensureColumn('scan_runs', 'health_worst', 'REAL')
    this.db.run(`
      UPDATE scheduler_jobs
      SET interval_minutes = CAST(interval_hours * 60 AS INTEGER)
      WHERE interval_minutes = 1440
        AND interval_hours IS NOT NULL
        AND interval_hours <> 24
    `)
    this.ensureColumn('email_config', 'self_email', 'TEXT')
    this.ensureColumn('app_settings', 'gitlab_url', 'TEXT')
    this.ensureColumn('app_settings', 'gitlab_api_key', 'TEXT')
    this.ensureColumn('app_settings', 'gitlab_has_key', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('app_settings', 'active_repository_id', 'TEXT')
    this.ensureColumn('app_settings', 'deletion_disabled', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('app_settings', 'color_theme', "TEXT NOT NULL DEFAULT 'default'")
    this.ensureColumn('app_settings', 'background_theme', "TEXT NOT NULL DEFAULT 'dark'")
    this.ensureColumn('monitoring_rules_repo', 'enabled', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('monitoring_rules_repo', 'stale_threshold_unit', `TEXT NOT NULL DEFAULT 'days'`)
    this.ensureColumn('monitoring_rules_repo', 'grace_period_unit', `TEXT NOT NULL DEFAULT 'days'`)
    this.ensureColumn('monitoring_rules_repo', 'notification_enabled', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('reports', 'repository_id', 'TEXT')
    this.ensureColumn('report_schedules', 'next_run_at', 'TEXT')
    this.ensureColumn('branch_naming_rules', 'repository_id', 'TEXT')
    this.ensureColumn('scheduler_jobs', 'repository_id', 'TEXT')
    this.ensureColumn('whitelist', 'repository_id', 'TEXT')
    this.ensureColumn('protected_branches', 'repository_id', 'TEXT')
    this.run(`DELETE FROM whitelist WHERE rowid NOT IN (SELECT MIN(rowid) FROM whitelist GROUP BY pattern)`)
    this.run(`DELETE FROM protected_branches WHERE rowid NOT IN (SELECT MIN(rowid) FROM protected_branches GROUP BY pattern)`)
    this.run(`DELETE FROM branch_naming_rules WHERE name = pattern AND pattern IN ('fix/*', 'refactor/*', 'test/*') AND type = 'glob' AND mode = 'allow'`)
    this.run(`UPDATE branch_naming_rules SET pattern = '^(feature|bugfix|hotfix|release|chore|docs)\\/[a-z0-9._-]+$' WHERE name = 'Conventional prefix' AND pattern = '^(feature|bugfix|fix|hotfix|release|refactor|docs|test|chore)\\/[a-z0-9._-]+$'`)
    this.run(`UPDATE monitoring_rules SET stale_threshold_days = 180, grace_period_days = 60 WHERE stale_threshold_days = 14 AND grace_period_days = 7`)
    this.run(`UPDATE monitoring_rules_repo SET stale_threshold_days = 180, grace_period_days = 60 WHERE stale_threshold_days = 14 AND grace_period_days = 7`)
    this.run(`DELETE FROM whitelist WHERE pattern = 'whitelisted-feature' AND type = 'exact' AND note = 'Demo whitelisted branch'`)
    this.run(`DELETE FROM protected_branches WHERE pattern = 'hotfix/*' AND type = 'glob' AND note = 'Demo protected hotfix branches'`)
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const result = this.db.exec(`PRAGMA table_info(${table})`)
    const values = result[0]?.values ?? []
    const exists = values.some((row) => row[1] === column)
    if (!exists) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
      this.save()
    }
  }

  private seed(): void {
    this.run(`INSERT OR IGNORE INTO monitoring_rules (id, enabled, stale_threshold_days, grace_period_days, fetch_enabled, naming_enabled, email_policy, notification_enabled, auto_delete_enabled, notify_target)
      VALUES (1, 1, 180, 60, 1, 1, 'none', 1, 0, 'self')`)
    this.run(`INSERT OR IGNORE INTO app_settings (id, theme, language, notifications_enabled, tray_enabled, launch_minimized, start_with_windows, fetch_policy)
      VALUES (1, 'dark', 'zh', 1, 1, 0, 0, 'auto')`)
    this.run(`INSERT OR IGNORE INTO email_config (id, server, port, from_address, secure, tls, enabled)
      VALUES (1, '', 587, '', 1, 0, 0)`)
    const count = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM branch_naming_rules')?.n ?? 0
    if (count === 0) {
      for (const rule of [...defaultExcludeRules(), ...defaultNamingRules()]) {
        this.insert('branch_naming_rules', {
          id: newId(),
          ...rule,
          enabled: 1,
          description: String(rule.description ?? '')
        })
      }
    }
    const templateCount = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM email_templates')?.n ?? 0
    if (templateCount === 0) {
      const templates = [
        {
          kind: 'summary',
          subject: 'BranchPulse Monitoring Summary',
          body: [
            '{{total}} branches checked',
            '{{stale}} stale',
            '{{grace_period}} in grace period',
            '{{grace_expired}} grace expired',
            '{{naming_invalid}} naming violations',
            '{{merged}} merged',
            '{{cleanup_candidates}} cleanup candidates'
          ].join('\n')
        },
        {
          kind: 'stale',
          subject: 'BranchPulse: stale branch needs attention',
          body: [
            'Repository: {{repository}}',
            'Branch: {{branch}}',
            'Creator: {{creator}}',
            'Last commit: {{last_commit_date}}',
            'Inactive: {{inactive_days}} days',
            'Grace period: {{grace_period}} days',
            'Naming: {{naming_status}}',
            'Merge status: {{merge_status}}',
            'Health: {{health_score}}',
            'Recommended action: review and clean up.'
          ].join('\n')
        },
        {
          kind: 'grace_period',
          subject: 'BranchPulse: branch entered grace period',
          body: [
            'Repository: {{repository}}',
            'Branch: {{branch}}',
            'Creator: {{creator}}',
            'Inactive: {{inactive_days}} days',
            'Grace period: {{grace_period}} days',
            'Health: {{health_score}}'
          ].join('\n')
        },
        {
          kind: 'grace_expired',
          subject: 'BranchPulse: grace period expired',
          body: [
            'Repository: {{repository}}',
            'Branch: {{branch}}',
            'Creator: {{creator}}',
            'Inactive: {{inactive_days}} days',
            'Grace period expired.',
            'Recommended action: cleanup candidate.'
          ].join('\n')
        },
        {
          kind: 'naming_violation',
          subject: 'BranchPulse: naming violation detected',
          body: [
            'Repository: {{repository}}',
            'Branch: {{branch}}',
            'Creator: {{creator}}',
            'Naming status: {{naming_status}}',
            'Recommended action: rename the branch.'
          ].join('\n')
        },
        {
          kind: 'merged',
          subject: 'BranchPulse: merged branch found',
          body: [
            'Repository: {{repository}}',
            'Branch: {{branch}}',
            'Creator: {{creator}}',
            'Merge status: {{merge_status}}',
            'Recommended action: the branch is merged and can be removed after review.'
          ].join('\n')
        },
        {
          kind: 'cleanup_candidate',
          subject: 'BranchPulse: cleanup candidate',
          body: [
            'Repository: {{repository}}',
            'Branch: {{branch}}',
            'Creator: {{creator}}',
            'Inactive: {{inactive_days}} days',
            'Recommended action: review before cleanup.'
          ].join('\n')
        }
      ]
      for (const t of templates) {
        this.insert('email_templates', { id: newId(), kind: t.kind, subject: t.subject, body: t.body })
      }
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      const dir = path.dirname(this.file)
      fs.mkdirSync(dir, { recursive: true })
      const data = Buffer.from(this.db.export())
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, data)
      fs.renameSync(tmp, this.file)
    } catch (err) {
      logger.error('Failed to persist database', err)
    }
  }

  save(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 250)
  }

  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as never[])
      const rows: T[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never[])
    this.save()
  }

  insert(table: string, obj: Record<string, unknown>): string {
    const record = { ...obj }
    const tableCols = this.all<Record<string, unknown>>(`PRAGMA table_info(${table})`).map((c) => String(c.name))
    if (tableCols.includes('id') && !record.id) record.id = newId()
    const cols = Object.keys(record).filter((c) => tableCols.includes(c))
    const placeholders = cols.map(() => '?').join(', ')
    this.db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, cols.map((c) => record[c] as never))
    this.save()
    return String(record.id)
  }

  update(table: string, obj: Record<string, unknown>, where: string, whereParams: unknown[] = []): void {
    const cols = Object.keys(obj)
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    this.db.run(`UPDATE ${table} SET ${sets} WHERE ${where}`, [...cols.map((c) => obj[c]), ...whereParams] as never[])
    this.save()
  }

  upsert(table: string, obj: Record<string, unknown>, idColumn = 'id'): void {
    const id = String(obj[idColumn] ?? '')
    const existing = this.get(`SELECT 1 AS x FROM ${table} WHERE ${idColumn} = ?`, [id])
    if (existing) this.update(table, obj, `${idColumn} = ?`, [id])
    else this.insert(table, obj)
  }

  delete(table: string, where: string, params: unknown[] = []): void {
    this.db.run(`DELETE FROM ${table} WHERE ${where}`, params as never[])
    this.save()
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN')
    try {
      const result = fn()
      this.db.run('COMMIT')
      this.flush()
      return result
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
  }

  close(): void {
    try {
      this.flush()
      this.db.close()
    } catch {
      /* noop */
    }
  }
}

export function fromDb<T>(row: Record<string, unknown> | undefined, fields: string[]): T | undefined {
  if (!row) return undefined
  return fields.reduce<Record<string, unknown>>((acc, f) => {
    acc[f] = row[f]
    return acc
  }, {}) as T
}

export { nowIso }
