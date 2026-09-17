import { describe, expect, it } from 'vitest'
import type { BranchSummary, MonitoringConfig } from '@shared/types'
import {
  BranchService,
  effectiveThreshold,
  parseThresholdRules,
  serializeThresholdRules
} from '../src-node/services/branch'
import { HealthService } from '../src-node/services/health'
import { NamingService } from '../src-node/services/naming'
import { ProtectionService } from '../src-node/services/protection'

const REPO_ID = 'repo-1'
const DAY = 24 * 60 * 60 * 1000

function monitoring(overrides: Partial<MonitoringConfig> = {}): MonitoringConfig {
  return {
    enabled: true,
    staleThresholdDays: 180,
    staleThresholdUnit: 'days',
    gracePeriodDays: 60,
    gracePeriodUnit: 'days',
    thresholdRules: [],
    fetchEnabled: true,
    namingEnabled: true,
    emailPolicy: 'none',
    notificationEnabled: true,
    notifyTarget: 'self',
    ...overrides
  }
}

describe('effectiveThreshold', () => {
  const rules = [
    { prefix: 'release/', value: 180, unit: 'days' as const },
    { prefix: 'feature/', value: 60, unit: 'days' as const },
    { prefix: 'bugfix/', value: 30, unit: 'days' as const },
    { prefix: 'release/1.x/', value: 365, unit: 'days' as const }
  ]

  it('falls back to the global threshold when no prefix matches', () => {
    const result = effectiveThreshold(monitoring({ thresholdRules: rules }), 'chore/tidy')
    expect(result.hours).toBe(180 * 24)
    expect(result.unit).toBe('days')
  })

  it('applies the rule that matches the branch prefix', () => {
    expect(effectiveThreshold(monitoring({ thresholdRules: rules }), 'feature/login').hours).toBe(60 * 24)
    expect(effectiveThreshold(monitoring({ thresholdRules: rules }), 'bugfix/crash').hours).toBe(30 * 24)
    expect(effectiveThreshold(monitoring({ thresholdRules: rules }), 'release/2.0').hours).toBe(180 * 24)
  })

  it('prefers the most specific (longest) matching prefix', () => {
    expect(effectiveThreshold(monitoring({ thresholdRules: rules }), 'release/1.x/hotpatch').hours).toBe(365 * 24)
  })

  it('honours the unit of the matched rule', () => {
    const config = monitoring({
      staleThresholdDays: 180,
      staleThresholdUnit: 'days',
      thresholdRules: [{ prefix: 'hotfix/', value: 12, unit: 'hours' }]
    })
    const result = effectiveThreshold(config, 'hotfix/urgent')
    expect(result.hours).toBe(12)
    expect(result.value).toBe(12)
    expect(result.unit).toBe('hours')
  })

  it('uses the global threshold when no rules are configured', () => {
    expect(effectiveThreshold(monitoring(), 'feature/login').hours).toBe(180 * 24)
  })
})

describe('threshold rule storage', () => {
  it('round-trips valid rules', () => {
    const rules = [{ prefix: 'release/', value: 180, unit: 'days' as const }]
    expect(parseThresholdRules(serializeThresholdRules(rules))).toEqual(rules)
  })

  it('reads rules that arrive as an array instead of JSON text', () => {
    expect(parseThresholdRules([{ prefix: 'feature/', value: 60, unit: 'days' }])).toEqual([
      { prefix: 'feature/', value: 60, unit: 'days' }
    ])
  })

  it('drops malformed entries instead of throwing', () => {
    expect(parseThresholdRules('not json')).toEqual([])
    expect(parseThresholdRules(null)).toEqual([])
  })

  it('rejects empty prefixes, zero values and unknown units', () => {
    const raw = JSON.stringify([
      { prefix: '', value: 10, unit: 'days' },
      { prefix: 'x/', value: 0, unit: 'days' },
      { prefix: 'y/', value: 10, unit: 'months' }
    ])
    expect(parseThresholdRules(raw)).toEqual([])
  })
})

/** Minimal fake storage: only the queries that `BranchService.listBranches` issues. */
function fakeStorage(rules: string, rows: Array<Record<string, unknown>>): unknown {
  return {
    all: (query: string) => (query.includes('FROM branches') ? rows : []),
    get: (query: string) =>
      query.includes('monitoring_rules')
        ? {
            stale_threshold_days: 180,
            grace_period_days: 60,
            stale_threshold_unit: 'days',
            grace_period_unit: 'days',
            threshold_rules: rules
          }
        : undefined
  }
}

function cachedBranch(overrides: Partial<BranchSummary>): BranchSummary {
  const daysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
  return {
    id: 'branch-1',
    repositoryId: REPO_ID,
    repositoryName: '',
    name: 'feature/legacy',
    displayName: 'feature/legacy',
    type: 'remote',
    remote: 'origin',
    existsLocally: false,
    existsRemotely: true,
    isHead: false,
    creator: { name: '张三', email: 'zhang@example.com', firstCommitAt: daysAgo(400), confidence: 'high' },
    createdAt: daysAgo(400),
    lastCommitAt: daysAgo(400),
    lastCommitSha: 'abc',
    lastAuthor: '张三',
    commitCount: 3,
    ahead: 1,
    behind: 0,
    merged: false,
    mergedInto: null,
    baseBranch: 'main',
    inactiveDays: 400,
    ageDays: 400,
    naming: { status: 'valid' },
    health: { score: 100, level: 'healthy', factors: [] },
    protection: { whitelisted: false, isDefault: false, protected: false, rules: [] },
    state: 'active',
    stale: false,
    gracePeriodDays: 60,
    thresholdDays: 180,
    thresholdUnit: 'days',
    graceExpired: false,
    cleanupCandidate: false,
    recentCommits: [],
    lastScannedAt: daysAgo(0),
    ...overrides
  }
}

function idle(name: string, inactiveDays: number): BranchSummary {
  return cachedBranch({
    name,
    displayName: name,
    inactiveDays,
    lastCommitAt: new Date(Date.now() - inactiveDays * DAY).toISOString()
  })
}

function listWith(rules: string, branch: BranchSummary): BranchSummary {
  const storage = fakeStorage(rules, [{ data_json: JSON.stringify(branch), repository_id: REPO_ID }])
  const service = new BranchService(
    storage as never,
    {} as never,
    { list: () => [{ id: REPO_ID, name: 'demo' }] } as never,
    {} as never,
    new NamingService(storage as never),
    new ProtectionService(storage as never),
    new HealthService(),
    { record: () => undefined } as never,
    {} as never
  )
  return service.listBranches()[0]
}

describe('prefix thresholds drive the lifecycle state', () => {
  it('keeps a release branch active for 180 days while the global threshold is 60', () => {
    const rules = serializeThresholdRules([{ prefix: 'release/', value: 180, unit: 'days' }])
    const branch = listWith(rules, idle('release/2.0', 90))
    expect(branch.state).toBe('active')
    expect(branch.thresholdDays).toBe(180)
    expect(branch.thresholdUnit).toBe('days')
  })

  it('marks the same branch stale once it passes the rule threshold', () => {
    const rules = serializeThresholdRules([{ prefix: 'release/', value: 180, unit: 'days' }])
    const branch = listWith(rules, idle('release/2.0', 200))
    expect(branch.stale).toBe(true)
    expect(branch.thresholdDays).toBe(180)
  })

  it('shortens the window for prefixes configured with a smaller threshold', () => {
    const rules = serializeThresholdRules([{ prefix: 'bugfix/', value: 30, unit: 'days' }])
    const branch = listWith(rules, idle('bugfix/crash', 45))
    expect(branch.stale).toBe(true)
    expect(branch.state).toBe('grace_period')
    expect(branch.thresholdDays).toBe(30)
  })

  it('keeps the global threshold when no rule matches', () => {
    const rules = serializeThresholdRules([{ prefix: 'bugfix/', value: 30, unit: 'days' }])
    const branch = listWith(rules, idle('chore/tidy', 45))
    expect(branch.stale).toBe(false)
    expect(branch.state).toBe('active')
    expect(branch.thresholdDays).toBe(180)
  })
})
