import type { HealthFactor, HealthLevel, HealthResult } from '@shared/types'

export interface HealthInput {
  inactiveDays: number
  staleThresholdDays: number
  gracePeriodDays: number
  state: 'active' | 'stale' | 'grace_period' | 'grace_expired'
  namingStatus: 'valid' | 'invalid' | 'excluded'
  namingExempt?: boolean
  merged: boolean
  ahead: number
  behind: number
  whitelisted: boolean
  isDefault: boolean
  protected: boolean
  branchName: string
  baseBranch: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export class HealthService {
  compute(input: HealthInput): HealthResult {
    // 基准分支本身是评分参照物，保持满分且不参与停更、合并等生命周期扣分。
    const isBaselineBranch = input.isDefault || input.branchName === input.baseBranch || /^(main|develop)$/i.test(input.branchName)
    if (isBaselineBranch) {
      const factors: HealthFactor[] = [
        { label: '基准分支', score: 100, weight: 100, detail: '基准分支固定满分，不参与其他分支的计分规则' }
      ]
      return { score: 100, level: 'healthy', factors }
    }

    const factors: HealthFactor[] = []

    const activityWindow = Math.max(1, input.staleThresholdDays * 2)
    const activity = clamp(Math.round(30 * (1 - Math.min(1, input.inactiveDays / activityWindow))), 0, 30)
    factors.push({
      label: '活跃度',
      score: activity,
      weight: 30,
      detail: `最后提交距今 ${input.inactiveDays} 天`
    })

    const staleScore = input.state === 'active' ? 25 : input.state === 'stale' ? 8 : input.state === 'grace_period' ? 12 : 0
    factors.push({
      label: '停更风险',
      score: staleScore,
      weight: 25,
      detail:
        input.state === 'active'
          ? '未超过停更阈值'
          : input.state === 'grace_period'
            ? `已停更，处于 ${input.gracePeriodDays} 天提醒宽限期`
            : input.state === 'grace_expired'
              ? '提醒宽限期已结束'
              : '分支已停更'
    })

    const namingScore = input.namingExempt || input.namingStatus === 'valid' ? 20 : input.namingStatus === 'excluded' ? 16 : 0
    factors.push({
      label: '命名规范',
      score: namingScore,
      weight: 20,
      detail: input.namingExempt
        ? '默认分支不参与命名规范评分'
        : input.namingStatus === 'valid'
          ? '命名符合规则'
          : input.namingStatus === 'excluded'
            ? '未启用命名校验'
            : '命名不符合规则'
    })

    const mergeScore = input.merged ? 15 : 0
    factors.push({
      label: '合并状态',
      score: mergeScore,
      weight: 15,
      detail: input.merged ? '已合并到基准分支，无合并扣分' : '尚未合并到基准分支，扣分'
    })

    let divergence = 10
    if (input.behind > 100) divergence = 0
    else if (input.behind > 50) divergence = 3
    else if (input.behind > 20) divergence = 5
    else if (input.behind > 5) divergence = 7
    if (input.ahead > 200) divergence = Math.max(0, divergence - 2)
    factors.push({
      label: '分支差异',
      score: divergence,
      weight: 10,
      detail: `领先基准分支 ${input.ahead} 个提交，落后 ${input.behind} 个提交`
    })

    const score = clamp(Math.round(factors.reduce((sum, f) => sum + f.score, 0)), 0, 100)
    const level: HealthLevel = score >= 90 ? 'healthy' : score >= 70 ? 'good' : score >= 40 ? 'warning' : 'critical'
    return { score, level, factors }
  }
}
