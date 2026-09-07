import fs from 'node:fs'
import path from 'node:path'
import type { AuditEntry, AuditExportResult } from '@shared/types'
import type { AuditService } from './audit'

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, '\\n')}"`
}

export async function exportAuditLogs(
  audit: AuditService,
  directory: string,
  format: 'csv' | 'json'
): Promise<AuditExportResult> {
  try {
    const entries = audit.listAll()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outputPath = path.join(directory, `branchpulse-audit-${stamp}.${format}`)
    fs.mkdirSync(directory, { recursive: true })

    if (format === 'json') {
      await fs.promises.writeFile(outputPath, JSON.stringify(entries, null, 2), 'utf8')
    } else {
      const header = ['time', 'action', 'result', 'detail']
      const rows = entries.map((entry) => [entry.at, entry.action, entry.result, JSON.stringify(entry.detail)])
      const content = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
      await fs.promises.writeFile(outputPath, content, 'utf8')
    }

    return { ok: true, path: outputPath, count: entries.length }
  } catch (err) {
    return {
      ok: false,
      path: '',
      count: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
