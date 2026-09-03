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

  private load(table: string): ProtectionEntry[] {
    const rows = this.storage.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY created_at ASC`)
    return rows.map((r) => ({
      id: String(r.id),
      pattern: String(r.pattern),
      type: (r.type as ProtectionEntry['type']) ?? 'exact',
      note: String(r.note ?? ''),
      createdAt: String(r.created_at)
    }))
  }

  listWhitelist(): ProtectionEntry[] {
    return this.load('whitelist')
  }

  listProtected(): ProtectionEntry[] {
    return this.load('protected_branches')
  }

  addWhitelist(entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): ProtectionEntry[] {
    this.storage.insert('whitelist', {
      id: newId(),
      pattern: entry.pattern,
      type: entry.type,
      note: entry.note,
      created_at: nowIso()
    })
    return this.listWhitelist()
  }

  removeWhitelist(id: string): ProtectionEntry[] {
    this.storage.delete('whitelist', 'id = ?', [id])
    return this.listWhitelist()
  }

  addProtected(entry: Omit<ProtectionEntry, 'id' | 'createdAt'>): ProtectionEntry[] {
    this.storage.insert('protected_branches', {
      id: newId(),
      pattern: entry.pattern,
      type: entry.type,
      note: entry.note,
      created_at: nowIso()
    })
    return this.listProtected()
  }

  removeProtected(id: string): ProtectionEntry[] {
    this.storage.delete('protected_branches', 'id = ?', [id])
    return this.listProtected()
  }

  evaluate(name: string, isDefault: boolean): ProtectionResult {
    const whitelisted = this.listWhitelist().some((e) => matchPattern(e.pattern, e.type, name))
    const isProtected = this.listProtected().some((e) => matchPattern(e.pattern, e.type, name))
    const rules: string[] = []
    if (whitelisted) rules.push('whitelist')
    if (isDefault) rules.push('default')
    if (isProtected) rules.push('protected')
    return { whitelisted, isDefault, protected: isProtected, rules }
  }
}
