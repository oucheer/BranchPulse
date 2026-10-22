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
      return new RegExp(pattern, 'u').test(name)
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

const allowedPrefixes = new Set(['feature', 'bugfix', 'hotfix', 'release'])

const prefixHint = `允许的前缀为 ${[...allowedPrefixes].join('/')}，需形如 a/b_c（例如 feature/login_page、bugfix/123456）`

const bodyPattern = /^[A-Za-z0-9][A-Za-z0-9_.]*$/

export function baseNamingIssue(name: string): string | null {
  if (name.endsWith('/')) return '不能以 / 结尾'
  if (name.includes('//')) return '不能包含连续 /'
  if (/\s/.test(name)) return '不能包含空格'
  if (/[^\x00-\x7F]/.test(name)) return '禁止中文或非 ASCII 字符'
  if (name.startsWith('/') || name.startsWith('-')) return '不能以 / 或 - 开头'
  if (name !== 'main' && name.startsWith('main')) {
    return 'main 为长期分支，禁止带后缀，必须直接为 main'
  }
  if (name !== 'develop' && name.startsWith('develop')) {
    if (/^develop_[A-Za-z0-9][A-Za-z0-9_.]*$/.test(name)) return null
    return 'develop 只能为 develop 或特殊临时形式 develop_XX（_ 后以字母或数字开头，可含字母、数字、_、.），不允许带 /'
  }
  if (name === 'main' || name === 'develop') return null

  const separatorIndex = name.indexOf('/')
  if (separatorIndex === -1) {
    if (allowedPrefixes.has(name)) return `缺少具体功能描述，${prefixHint}`
    return `不符合前缀规范：${prefixHint}`
  }

  const prefix = name.slice(0, separatorIndex)
  const description = name.slice(separatorIndex + 1)
  if (!description) return `缺少具体功能描述，${prefixHint}`
  if (!allowedPrefixes.has(prefix)) return `前缀「${prefix}」不在允许范围内：${prefixHint}`
  if (prefix === 'release') {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(description)) {
      return 'release 分支 b 必须为完整项目名（项目编号），仅项目名可带 -，其余可含字母、数字、_、.'
    }
  } else if (!bodyPattern.test(description)) {
    return 'b/c 必须以大写字母、小写字母或数字开头，后续可含大小写字母、数字、_、.'
  }
  if (/^\d+$/.test(description) && prefix !== 'bugfix' && prefix !== 'hotfix') {
    return '禁止过于随意的命名（如纯数字 123 或工程师名字），请使用有业务含义的描述'
  }
  if (prefix !== 'release' && /^(?:v|V)?\d+(?:\.\d+)+/.test(description)) {
    return '禁止拉取版本分支：版本号命名仅用于 release 分支（如 release/LP-7265V1R1）'
  }
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
    const patterns = list
      .filter((rule) => rule.enabled && rule.mode === 'allow')
      .map((rule) => rule.pattern)
    const ruleHint = patterns.length
      ? `当前启用的规则模式：${[...new Set(patterns)].slice(0, 6).join('、')}`
      : '当前没有启用任何命名规则'
    return {
      status: 'invalid',
      reason: `基础格式正确，但未匹配任何启用规则。${ruleHint}；中文分支名需要额外的 regex / unicode 规则`
    }
  }
}
