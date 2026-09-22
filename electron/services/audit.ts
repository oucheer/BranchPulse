import type { AuditEntry } from '@shared/types'
import type { StorageService } from './storage'
import { logger } from '../utils/logger'

export class AuditService {
  constructor(private readonly storage: StorageService) {}

  record(action: string, detail: Record<string, unknown>, result: 'success' | 'failure' = 'success'): void {
    this.storage.insert('audit_logs', {
      at: new Date().toISOString(),
      action,
      detail_json: JSON.stringify(detail),
      result
    })
    logger.info(`audit ${action} ${result}`)
  }

  list(repositoryIds?: string[]): AuditEntry[] {
    const scope = repositoryIds === undefined ? this.storage.selectedRepositoryIds() : [...new Set(repositoryIds)]
    if (scope.length === 0) return []
    const allowed = new Set(scope)
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM audit_logs ORDER BY at DESC LIMIT 2000')
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      action: String(r.action),
      detail: safeJson(r.detail_json),
      result: (r.result as 'success' | 'failure') ?? 'success'
    })).filter((entry) => {
      const ids = auditRepositoryIds(entry.detail)
      return ids.length === 0 || ids.every((id) => allowed.has(id))
    })
  }

  listAll(): AuditEntry[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM audit_logs ORDER BY at DESC')
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      action: String(r.action),
      detail: safeJson(r.detail_json),
      result: (r.result as 'success' | 'failure') ?? 'success'
    }))
  }
}

function auditRepositoryIds(detail: Record<string, unknown>): string[] {
  const ids = new Set<string>()
  const add = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) add(item)
    } else if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim())
    }
  }
  add(detail.repositoryId)
  add(detail.repositoryIds)

  const single = String(detail.repositoryId ?? '').trim()
  if (single) ids.add(single)
  return [...ids]
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}
