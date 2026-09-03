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

  list(): AuditEntry[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM audit_logs ORDER BY at DESC LIMIT 2000')
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      action: String(r.action),
      detail: safeJson(r.detail_json),
      result: (r.result as 'success' | 'failure') ?? 'success'
    }))
  }
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}
