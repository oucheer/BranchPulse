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

const allowedPrefixes = new Set(['feature', 'bugfix', 'hotfix', 'release', 'chore', 'docs'])

export function baseNamingIssue(name: string): string | null {
  if (name.endsWith('/')) return '不能以 / 结尾'
  if (name.includes('//')) return '不能包含连续 /'
  if (/\s/.test(name)) return '不能包含空格'
  if (/[A-Z]/.test(name)) return '必须使用小写字母'
  if (name.startsWith('/') || name.startsWith('-')) return '不能以 / 或 - 开头'
  if (/^(main|develop)(?:\/|[^a-z])/.test(name)) {
    return '主分支必须直接为 main / develop'
  }
  if (name === 'main' || name === 'develop') return null

  const separatorIndex = name.indexOf('/')
  if (separatorIndex === -1) {
    return allowedPrefixes.has(name) ? '缺少具体功能描述' : '不符合前缀规范'
  }

  const prefix = name.slice(0, separatorIndex)
  const description = name.slice(separatorIndex + 1)
  if (!description) return '缺少具体功能描述'
  if (!allowedPrefixes.has(prefix)) return '前缀不在允许的前缀内'
  return null
}

export class NamingService {
  constructor(private readonly storage: StorageService) {}

  listRules(repositoryId?: string | null): NamingRule[] {
    const scoped = repositoryId !== undefined
    const rows = scoped && repositoryId
      ? this.storage.all<Record<string, unknown>>('SELECT * FROM branch_naming_rules WHERE repository_id = ? OR repository_id IS NULL ORDER BY priority ASC', [repositoryId])
      : this.storage.all<Record<string, unknown>>('SELECT * FROM branch_naming_rules ORDER BY priority ASC')
    return rows.map((r) => ({
      id: String(r.id),
      repositoryId: (r.repository_id as string | null) ?? null,
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
    const baseIssue = baseNamingIssue(name)
    if (!baseIssue && (name === 'main' || name === 'develop')) {
      const explicit = list.find((rule) => rule.enabled && matchPattern(rule.pattern, rule.type, name))
      if (explicit) {
        return explicit.mode === 'exclude'
          ? { status: 'excluded', ruleName: explicit.name, reason: `由规则「${explicit.name}」排除` }
          : { status: 'valid', ruleName: explicit.name, reason: `符合规则「${explicit.name}」` }
      }
      return { status: 'valid', reason: '默认分支不参与命名规范校验' }
    }
    for (const rule of list.filter((r) => r.enabled && !baseIssue)) {
      if (!matchPattern(rule.pattern, rule.type, name)) continue
      if (rule.mode === 'exclude') {
        return { status: 'excluded', ruleName: rule.name, reason: `由规则「${rule.name}」排除` }
      }
      return { status: 'valid', ruleName: rule.name, reason: `符合规则「${rule.name}」` }
    }
    if (baseIssue) {
      return { status: 'invalid', reason: baseIssue }
    }
    return {
      status: 'invalid',
      reason: '不符合前缀规范'
    }
  }
}
