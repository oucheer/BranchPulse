import { describe, expect, it } from 'vitest'
import type { NamingRule } from '@shared/types'
import { baseNamingIssue, globPatternToRegex, matchPattern, NamingService } from '../src-node/services/naming'
import type { StorageService } from '../src-node/services/storage'

const service = new NamingService({} as StorageService)

function rule(overrides: Partial<NamingRule> & Pick<NamingRule, 'pattern' | 'type' | 'mode'>): NamingRule {
  return {
    id: 'rule-1',
    name: overrides.pattern,
    description: '',
    enabled: true,
    priority: 0,
    ...overrides
  }
}

describe('globPatternToRegex', () => {
  it('matches a single path segment with *', () => {
    const re = globPatternToRegex('feature/*')
    expect(re.test('feature/auth')).toBe(true)
    expect(re.test('feature/auth/nested')).toBe(false)
  })

  it('matches nested paths with **', () => {
    const re = globPatternToRegex('**/*.ts')
    expect(re.test('src/app/helpers.ts')).toBe(true)
  })

  it('matches a single non-slash character with ?', () => {
    const re = globPatternToRegex('release/?')
    expect(re.test('release/1')).toBe(true)
    expect(re.test('release/12')).toBe(false)
    expect(re.test('release/x/y')).toBe(false)
  })

  it('supports brace alternatives', () => {
    const re = globPatternToRegex('{bugfix,fix}/*')
    expect(re.test('bugfix/login')).toBe(true)
    expect(re.test('fix/login')).toBe(true)
    expect(re.test('feature/login')).toBe(false)
  })
})

describe('matchPattern', () => {
  it('matches exact names', () => {
    expect(matchPattern('main', 'exact', 'main')).toBe(true)
    expect(matchPattern('main', 'exact', 'main/foo')).toBe(false)
  })

  it('matches regex patterns and fails safe on invalid regex', () => {
    expect(matchPattern('^feature/', 'regex', 'feature/login')).toBe(true)
    expect(matchPattern('^feature/', 'regex', 'chore/login')).toBe(false)
    expect(matchPattern('([', 'regex', 'anything')).toBe(false)
  })

  it('matches glob patterns', () => {
    expect(matchPattern('hotfix/*', 'glob', 'hotfix/security')).toBe(true)
    expect(matchPattern('hotfix/*', 'glob', 'hotfix/a/security')).toBe(false)
  })
})

describe('NamingService.validate', () => {
  const allowFeature = rule({ id: 'allow-feature', name: 'Feature', pattern: 'feature/*', type: 'glob', mode: 'allow', priority: 10 })
  const excludeMain = rule({ id: 'exclude-main', name: 'Main', pattern: 'main', type: 'glob', mode: 'exclude', priority: 1 })

  it('returns valid when an allow rule matches', () => {
    const result = service.validate('feature/login', [allowFeature])
    expect(result.status).toBe('valid')
    expect(result.ruleName).toBe('Feature')
  })

  it('returns excluded when an exclude rule matches', () => {
    const result = service.validate('main', [excludeMain, allowFeature])
    expect(result.status).toBe('excluded')
    expect(result.ruleName).toBe('Main')
  })

  it('returns invalid when no rule matches', () => {
    const result = service.validate('random-name', [allowFeature])
    expect(result.status).toBe('invalid')
    expect(result.reason).toContain('不符合前缀规范')
    expect(result.reason).toContain('feature/bugfix/hotfix/release/chore/docs')
  })

  it('explains which rule patterns were available when nothing matched', () => {
    const result = service.validate('feature/login/page', [allowFeature])
    expect(result.status).toBe('invalid')
    expect(result.reason).toContain('未匹配任何启用规则')
    expect(result.reason).toContain('feature/*')
  })

  it('ignores disabled rules', () => {
    const disabled = { ...allowFeature, enabled: false }
    const result = service.validate('feature/login', [disabled])
    expect(result.status).toBe('invalid')
  })
})

describe('base naming rules', () => {
  it('returns the first structural issue in the required order', () => {
    expect(baseNamingIssue('feature//')).toBe('不能以 / 结尾')
    expect(baseNamingIssue('feature//x')).toBe('不能包含连续 /')
    expect(baseNamingIssue('a b')).toBe('不能包含空格')
    expect(baseNamingIssue('Feature/login')).toBe('必须使用小写字母')
    expect(baseNamingIssue('/feature/x')).toBe('不能以 / 或 - 开头')
    expect(baseNamingIssue('-feature/x')).toBe('不能以 / 或 - 开头')
    expect(baseNamingIssue('main2')).toBe('主分支必须直接为 main / develop')
    expect(baseNamingIssue('develop2')).toBe('主分支必须直接为 main / develop')
    expect(baseNamingIssue('main/foo')).toBe('主分支必须直接为 main / develop')
    expect(baseNamingIssue('feature')).toContain('缺少具体功能描述')
    expect(baseNamingIssue('feature/')).toBe('不能以 / 结尾')
    for (const name of ['xyz/foo', 'admin/config', 'fix/login', 'refactor/core', 'test/unit']) {
      expect(baseNamingIssue(name)).toContain('不在允许范围内')
      expect(baseNamingIssue(name)).toContain('feature/bugfix/hotfix/release/chore/docs')
    }
  })

  it('allows conventional branches and direct main/develop branches', () => {
    expect(baseNamingIssue('main')).toBeNull()
    expect(baseNamingIssue('develop')).toBeNull()
    expect(baseNamingIssue('feature/login')).toBeNull()
    expect(baseNamingIssue('hotfix/security')).toBeNull()
  })
})
