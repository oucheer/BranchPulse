import type { HealthFactor, HealthLevel, HealthResult } from '@shared/types'

export interface HealthInput {
  inactiveDays: number
  staleThresholdDays: number
  gracePeriodDays: number
  state: 'active' | 'stale' | 'grace_period' | 'grace_expired'
  namingStatus: 'valid' | 'invalid' | 'excluded'
  merged: boolean
  ahead: number
  behind: number
  whitelisted: boolean
  isDefault: boolean
  protected: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export class HealthService {
  compute(input: HealthInput): HealthResult {
    const factors: HealthFactor[] = []

    const activityWindow = Math.max(1, input.staleThresholdDays * 2)
    const activity = clamp(Math.round(30 * (1 - Math.min(1, input.inactiveDays / activityWindow))), 0, 30)
    factors.push({
      label: 'Activity',
      score: activity,
      weight: 30,
      detail: `Last commit ${input.inactiveDays} days ago`
    })

    const staleScore = input.state === 'active' ? 25 : input.state === 'stale' ? 8 : input.state === 'grace_period' ? 12 : 0
    factors.push({
      label: 'Stale risk',
      score: staleScore,
      weight: 25,
      detail:
        input.state === 'active'
          ? 'Within stale threshold'
          : input.state === 'grace_period'
            ? `In grace period (${input.gracePeriodDays} days)`
            : input.state === 'grace_expired'
              ? 'Grace period expired'
              : 'Stale branch'
    })

    const namingScore = input.namingStatus === 'valid' ? 20 : input.namingStatus === 'excluded' ? 16 : 0
    factors.push({
      label: 'Naming',
      score: namingScore,
      weight: 20,
      detail: input.namingStatus === 'valid' ? 'Naming compliant' : input.namingStatus === 'excluded' ? 'Excluded from naming' : 'Naming violation'
    })

    const mergeScore = input.merged ? 0 : 15
    factors.push({
      label: 'Merge status',
      score: mergeScore,
      weight: 15,
      detail: input.merged ? 'Merged into base branch' : 'Not merged'
    })

    let divergence = 10
    if (input.behind > 100) divergence = 0
    else if (input.behind > 50) divergence = 3
    else if (input.behind > 20) divergence = 5
    else if (input.behind > 5) divergence = 7
    if (input.ahead > 200) divergence = Math.max(0, divergence - 2)
    factors.push({
      label: 'Divergence',
      score: divergence,
      weight: 10,
      detail: `${input.ahead} ahead, ${input.behind} behind base`
    })

    const score = clamp(Math.round(factors.reduce((sum, f) => sum + f.score, 0)), 0, 100)
    const level: HealthLevel = score >= 90 ? 'healthy' : score >= 70 ? 'good' : score >= 40 ? 'warning' : 'critical'
    return { score, level, factors }
  }
}
