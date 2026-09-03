import type { NamingResult, NamingRule } from '@shared/types'
import type { StorageService } from './storage'

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function globPatternToRegex(pattern: string): RegExp {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        const inner = pattern.slice(i + 1, end)
        out += `(${inner.split(',').map(escapeRegex).join('|')})`
        i = end
      } else {
        out += escapeRegex(ch)
      }
    } else {
      out += escapeRegex(ch)
    }
    i += 1
  }
  return new RegExp(`^${out}$`)
}

export function matchPattern(pattern: string, type: 'glob' | 'regex' | 'exact', name: string): boolean {
  if (type === 'regex') {
    try {
      return new RegExp(pattern).test(name)
    } catch {
      return false
    }
  }
  if (type === 'exact') return pattern === name
  try {
    return globPatternToRegex(pattern).test(name)
  } catch {
    return false
  }
}

export class NamingService {
  constructor(private readonly storage: StorageService) {}

  listRules(): NamingRule[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM branch_naming_rules ORDER BY priority ASC')
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      pattern: String(r.pattern),
      type: (r.type === 'regex' ? 'regex' : 'glob') as 'glob' | 'regex',
      mode: (r.mode === 'exclude' ? 'exclude' : 'allow') as 'allow' | 'exclude',
      description: String(r.description ?? ''),
      enabled: r.enabled === 1,
      priority: Number(r.priority)
    }))
  }

  validate(name: string, rules?: NamingRule[]): NamingResult {
    const list = rules ?? this.listRules()
    for (const rule of list.filter((r) => r.enabled)) {
      if (!matchPattern(rule.pattern, rule.type, name)) continue
      if (rule.mode === 'exclude') {
        return { status: 'excluded', ruleName: rule.name, reason: `Excluded by rule "${rule.name}".` }
      }
      return { status: 'valid', ruleName: rule.name, reason: `Matches rule "${rule.name}".` }
    }
    return {
      status: 'invalid',
      reason: 'Branch name does not match configured naming rules.'
    }
  }
}
