import fs from 'node:fs'
import path from 'node:path'
import type { StorageService } from './storage'

/**
 * Config portability: export / import every user-configurable part of the app
 * so a fresh machine can be brought back to the exact same state.
 *
 * Deliberately excluded:
 * - secrets: `app_settings.gitlab_api_key`, `repositories.remote_api_key`,
 *   `email_config.password_encrypted` (never leave the machine)
 * - runtime data that is machine specific or not configuration:
 *   branches, snapshots, scan runs, notifications, audit logs, generated
 *   reports and backup records.
 */

const SENSITIVE_COLUMNS = new Set(['gitlab_api_key', 'remote_api_key', 'password_encrypted'])

export const CONFIG_BUNDLE_KIND = 'branchpulse-config'
export const CONFIG_BUNDLE_VERSION = 1

/** Single-row configuration tables (id = 1). */
const SINGLETON_TABLES = ['app_settings', 'monitoring_rules', 'email_config'] as const

/** Tables replaced wholesale on import. */
const COLLECTION_TABLES = [
  'monitoring_rules_repo',
  'branch_naming_rules',
  'whitelist',
  'protected_branches',
  'email_groups',
  'email_templates',
  'scheduler_jobs',
  'report_schedules',
  'repositories'
] as const

export interface ConfigExtras {
  /** Renderer-owned settings that live in localStorage (animation toggles). */
  effects?: Record<string, unknown>
  /** Explicit UI language selection, mirrors `app_settings.language`. */
  language?: string
}

export interface ConfigImportSummary {
  applied: string[]
  warnings: string[]
  effects?: Record<string, unknown>
  language?: string
  exportedAt?: string
}

interface ConfigBundle {
  app: 'BranchPulse'
  kind: typeof CONFIG_BUNDLE_KIND
  version: number
  exportedAt: string
  appVersion: string
  sections: {
    singletons: Record<string, Record<string, unknown> | null>
    collections: Record<string, Array<Record<string, unknown>>>
    extras?: ConfigExtras
  }
}

export class ConfigPortService {
  constructor(
    private readonly storage: StorageService,
    private readonly appVersion: () => string = () => ''
  ) {}

  exportToFile(targetPath: string, extras: ConfigExtras = {}): { path: string; sections: string[] } {
    const resolved = path.resolve(targetPath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const singletons: Record<string, Record<string, unknown> | null> = {}
    for (const table of SINGLETON_TABLES) singletons[table] = this.readSingleton(table)
    const collections: Record<string, Array<Record<string, unknown>>> = {}
    for (const table of COLLECTION_TABLES) collections[table] = this.readCollection(table)
    const bundle: ConfigBundle = {
      app: 'BranchPulse',
      kind: CONFIG_BUNDLE_KIND,
      version: CONFIG_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: this.appVersion(),
      sections: { singletons, collections, extras: sanitizeExtras(extras) }
    }
    fs.writeFileSync(resolved, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
    return {
      path: resolved,
      sections: [
        ...SINGLETON_TABLES.filter((table) => singletons[table] !== null),
        ...COLLECTION_TABLES.filter((table) => collections[table].length > 0)
      ]
    }
  }

  importFromFile(sourcePath: string): ConfigImportSummary {
    const resolved = path.resolve(sourcePath)
    if (!fs.existsSync(resolved)) throw new Error('配置文件不存在，请重新选择。')
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'))
    } catch {
      throw new Error('配置文件格式无效，无法解析 JSON。')
    }
    const bundle = parsed as Partial<ConfigBundle>
    if (!bundle || bundle.app !== 'BranchPulse' || bundle.kind !== CONFIG_BUNDLE_KIND) {
      throw new Error('这不是 BranchPulse 导出的配置文件。')
    }
    if (typeof bundle.version !== 'number' || bundle.version > CONFIG_BUNDLE_VERSION) {
      throw new Error(`配置文件版本不受支持：${String(bundle.version)}`)
    }
    const sections = bundle.sections
    if (!sections || typeof sections !== 'object') throw new Error('配置文件缺少配置内容。')

    const applied: string[] = []
    const warnings: string[] = []

    this.storage.transaction(() => {
      for (const table of SINGLETON_TABLES) {
        const row = sections.singletons?.[table]
        if (!row || typeof row !== 'object') continue
        this.writeSingleton(table, row)
        applied.push(table)
      }
    for (const table of COLLECTION_TABLES) {
        const rows = sections.collections?.[table]
        if (!Array.isArray(rows)) continue
        this.writeCollection(table, rows)
        applied.push(table)
      }
      warnings.push(...this.pruneOrphans())
    })

    for (const row of this.storage.all<Record<string, unknown>>('SELECT name, path, source FROM repositories')) {
      const source = String(row.source ?? 'local')
      const repoPath = String(row.path ?? '')
      if (source !== 'local' || !repoPath || repoPath.startsWith('local://')) continue
      if (!fs.existsSync(repoPath)) {
        warnings.push(`本地仓库「${String(row.name)}」的路径在本机不存在：${repoPath}`)
      }
    }

    return {
      applied,
      warnings,
      ...(sections.extras?.effects ? { effects: sections.extras.effects } : {}),
      ...(typeof sections.extras?.language === 'string' ? { language: sections.extras.language } : {}),
      ...(typeof bundle.exportedAt === 'string' ? { exportedAt: bundle.exportedAt } : {})
    }
  }

  /**
   * The bundle carries repository ids from the origin machine. Cached branches,
   * scheduled jobs and report schedules that point at repositories which no
   * longer exist would otherwise show up as blank rows, so drop them and tell
   * the user to rescan.
   */
  private pruneOrphans(): string[] {
    const warnings: string[] = []
    for (const table of ['branches', 'scheduler_jobs', 'report_schedules', 'monitoring_rules_repo'] as const) {
      if (this.orphanCount(table) === 0) continue
      this.storage.delete(table, `repository_id IS NOT NULL AND repository_id <> '' AND repository_id NOT IN (SELECT id FROM repositories)`)
      warnings.push(`已清理 ${table} 中指向不存在仓库的旧记录，请在仓库页重新扫描。`)
    }
    const active = this.storage.all<Record<string, unknown>>('SELECT active_repository_id FROM app_settings WHERE id = 1')[0]?.active_repository_id
    if (active) {
      const exists = this.storage.all<Record<string, unknown>>('SELECT id FROM repositories WHERE id = ?', [active])[0]
      if (!exists) {
        const fallback = this.storage.all<Record<string, unknown>>('SELECT id FROM repositories ORDER BY created_at ASC')[0]
        this.storage.update('app_settings', { active_repository_id: fallback ? String(fallback.id) : null }, 'id = 1')
        warnings.push('原当前仓库在本机不存在，已切换到第一个可用仓库。')
      }
    }
    return warnings
  }

  private orphanCount(table: string): number {
    const count = this.storage.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE repository_id IS NOT NULL AND repository_id <> '' AND repository_id NOT IN (SELECT id FROM repositories)`
    )[0]
    return Number(count?.n ?? 0)
  }

  private columnsOf(table: string): string[] {
    return this.storage
      .all<Record<string, unknown>>(`PRAGMA table_info(${table})`)
      .map((column) => String(column.name))
      .filter((name) => !SENSITIVE_COLUMNS.has(name))
  }

  private readSingleton(table: string): Record<string, unknown> | null {
    const columns = this.columnsOf(table)
    const row = this.storage.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = 1`)[0]
    if (!row) return null
    return pick(row, columns)
  }

  private readCollection(table: string): Array<Record<string, unknown>> {
    const columns = this.columnsOf(table)
    return this.storage
      .all<Record<string, unknown>>(`SELECT * FROM ${table}`)
      .map((row) => pick(row, columns))
  }

  /** Update the singleton row while keeping machine-local secrets intact. */
  private writeSingleton(table: string, row: Record<string, unknown>): void {
    const columns = this.columnsOf(table)
    const values = pick(row, columns)
    delete values.id
    if (table === 'app_settings') {
      // `gitlab_has_key` describes this machine's stored token, not the file's.
      const existing = this.storage.all<Record<string, unknown>>('SELECT gitlab_api_key FROM app_settings WHERE id = 1')[0]
      values.gitlab_has_key = String(existing?.gitlab_api_key ?? '') ? 1 : 0
    }
    if (Object.keys(values).length === 0) return
    const existing = this.storage.all<Record<string, unknown>>(`SELECT id FROM ${table} WHERE id = 1`)[0]
    if (existing) this.storage.update(table, values, 'id = 1')
    else this.storage.insert(table, { id: 1, ...values })
  }

  private writeCollection(table: string, rows: Array<Record<string, unknown>>): void {
    const columns = this.columnsOf(table)
    const preservedSecrets = new Map<string, string>()
    if (table === 'repositories') {
      for (const row of this.storage.all<Record<string, unknown>>('SELECT id, remote_api_key FROM repositories')) {
        const key = String(row.remote_api_key ?? '')
        if (key) preservedSecrets.set(String(row.id), key)
      }
    }
    this.storage.delete(table, '1 = 1')
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const values = pick(row, columns)
      if (Object.keys(values).length === 0) continue
      if (table === 'repositories') {
        const id = String(values.id ?? '')
        const preserved = id ? preservedSecrets.get(id) : undefined
        // Local API tokens never travel in the bundle; re-attach this machine's
        // token when the same repository id already exists here.
        values.remote_api_key = preserved ?? ''
      }
      this.storage.insert(table, values)
    }
  }
}

function pick(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) result[column] = row[column]
  }
  return result
}

const EFFECT_BOOLEAN_KEYS = [
  'enabled',
  'ambientBackground',
  'splashCursor',
  'clickSpark',
  'depthText',
  'particleSplash'
] as const

function sanitizeExtras(extras: ConfigExtras): ConfigExtras {
  const result: ConfigExtras = {}
  if (extras.effects && typeof extras.effects === 'object') {
    const effects: Record<string, unknown> = {}
    for (const key of EFFECT_BOOLEAN_KEYS) {
      const value = (extras.effects as Record<string, unknown>)[key]
      if (typeof value === 'boolean') effects[key] = value
    }
    result.effects = effects
  }
  if (extras.language === 'zh' || extras.language === 'en') result.language = extras.language
  return result
}
