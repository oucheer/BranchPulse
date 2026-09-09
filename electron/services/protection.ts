import type { ProtectionEntry } from '@shared/types'
import type { StorageService } from './storage'
import { matchPattern } from './naming'
import { newId, nowIso } from '../utils/ids'

export type ProtectionResult = {
  whitelisted: boolean
  isDefault: boolean
  protected: boolean
  rules: string[]
}

export class ProtectionService {
  constructor(private readonly storage: StorageService) {}

  private entryExists(table: string, repositoryId: string | null, pattern: string): boolean {
    return this.storage.get(
      `SELECT 1 AS x FROM ${table} WHERE pattern = ? AND (repository_id = ? OR (repository_id IS NULL AND ? IS NULL))`,
      [pattern, repositoryId, repositoryId]
    ) !== undefined
  }

  private load(table: string, repositoryId?: string | null): ProtectionEntry[] {
    const scoped = repositoryId !== undefined
    const rows = this.storage.all<Record<string, unknown>>(
      scoped && repositoryId
        ? `SELECT * FROM ${table} WHERE repository_id = ? OR repository_id IS NULL ORDER BY created_at ASC`
        : `SELECT * FROM ${table} ORDER BY created_at ASC`,
      scoped && repositoryId ? [repositoryId] : []
    )
    return rows.map((r) => ({
      id: String(r.id),
      pattern: String(r.pattern),
      type: (r.type as ProtectionEntry['type']) ?? 'exact',
      note: String(r.note ?? ''),
      createdAt: String(r.created_at),
      repositoryId: (r.repository_id as string | null) ?? null
    }))
  }

  listWhitelist(repositoryId?: string | null): ProtectionEntry[] {
    return this.load('whitelist', repositoryId)
  }

  listProtected(repositoryId?: string | null): ProtectionEntry[] {
    return this.load('protected_branches', repositoryId)
  }

  addWhitelist(entry: Omit<ProtectionEntry, 'id' | 'createdAt'>, repositoryId?: string | null): ProtectionEntry[] {
    if (this.entryExists('whitelist', repositoryId ?? null, entry.pattern)) {
      return this.listWhitelist(repositoryId)
    }
    this.storage.insert('whitelist', {
      id: newId(),
      repository_id: repositoryId ?? null,
      pattern: entry.pattern,
      type: entry.type,
      note: entry.note,
      created_at: nowIso()
    })
    return this.listWhitelist(repositoryId)
  }

  removeWhitelist(id: string, repositoryId?: string | null): ProtectionEntry[] {
    this.storage.delete('whitelist', 'id = ?', [id])
    return this.listWhitelist(repositoryId)
  }

  addProtected(entry: Omit<ProtectionEntry, 'id' | 'createdAt'>, repositoryId?: string | null): ProtectionEntry[] {
    if (this.entryExists('protected_branches', repositoryId ?? null, entry.pattern)) {
      return this.listProtected(repositoryId)
    }
    this.storage.insert('protected_branches', {
      id: newId(),
      repository_id: repositoryId ?? null,
      pattern: entry.pattern,
      type: entry.type,
      note: entry.note,
      created_at: nowIso()
    })
    return this.listProtected(repositoryId)
  }

  removeProtected(id: string, repositoryId?: string | null): ProtectionEntry[] {
    this.storage.delete('protected_branches', 'id = ?', [id])
    return this.listProtected(repositoryId)
  }

  evaluate(name: string, isDefault: boolean, repositoryId?: string | null): ProtectionResult {
    const whitelisted = this.listWhitelist(repositoryId).some((e) => matchPattern(e.pattern, e.type, name))
    const isProtected = this.listProtected(repositoryId).some((e) => matchPattern(e.pattern, e.type, name))
    const rules: string[] = []
    if (whitelisted) rules.push('whitelist')
    if (isDefault) rules.push('default')
    if (isProtected) rules.push('protected')
    return { whitelisted, isDefault, protected: isProtected, rules }
  }
}
