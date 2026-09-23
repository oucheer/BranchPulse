import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { BranchSummary, ReportRecord, ReportSummary, ScanRun } from '@shared/types'
import type { StorageService } from './storage'
import type { BranchService } from './branch'
import type { RepositoryService } from './repository'
import type { AuditService } from './audit'
import type { EmailReportPartition, EmailSummaryData } from './email'
import { buildPartitionedReportHtml, toEmailIssueRow } from './email'
import { newId } from '../utils/ids'
import { reportsDir } from '../utils/paths'

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** 报告是用户可见产物，状态与命名结果必须使用全局统一的中文术语，不能输出底层英文枚举。 */
const REPORT_STATE_LABELS: Record<string, string> = {
  active: '活跃',
  stale: '已停更'
}

const REPORT_NAMING_LABELS: Record<string, string> = {
  valid: '合规',
  invalid: '命名不规范',
  excluded: '豁免'
}

function reportStateLabel(state: string): string {
  return REPORT_STATE_LABELS[state] ?? state
}

function reportNamingLabel(status: string): string {
  return REPORT_NAMING_LABELS[status] ?? status
}

export class ReportService {
  constructor(
    private readonly storage: StorageService,
    private readonly branchService: BranchService,
    private readonly repositoryService: RepositoryService,
    private readonly audit: AuditService
  ) {}

  /**
   * 报告历史只显示「完全属于当前勾选范围」的记录：只要报告里包含一个未勾选
   * 的仓库，就不再展示，避免未勾选仓库的数据通过历史报告泄漏。
   */
  listReports(repositoryIds?: string[]): ReportRecord[] {
    const scope = repositoryIds === undefined ? this.storage.selectedRepositoryIds() : [...new Set(repositoryIds)]
    if (scope.length === 0) return []
    const allowed = new Set(scope)
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM reports ORDER BY generated_at DESC LIMIT 200')
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? 'GitManager Report'),
      repositoryIds: reportRepositoryIds(r),
      generatedAt: String(r.generated_at),
      period: String(r.period ?? ''),
      format: String(r.format ?? 'html'),
      path: String(r.path ?? ''),
      summary: safeJson<ReportSummary>(r.summary_json, emptySummary())
    })).filter((record) => record.repositoryIds.length > 0 && record.repositoryIds.every((id) => allowed.has(id)))
  }

  private buildSummary(branches: BranchSummary[], repositories: number): ReportSummary {
    const count = (fn: (b: BranchSummary) => boolean): number => branches.filter(fn).length
    const protectedCount = count((b) => b.protection.protected)
    const whitelistedCount = count((b) => b.protection.whitelisted)
    const valid = count((b) => b.naming.status === 'valid')
    const invalid = count((b) => b.naming.status === 'invalid')
    const excluded = count((b) => b.naming.status === 'excluded')
    const total = Math.max(1, branches.length)
    const scoredBranches = branches.filter((b) => !b.protection.isDefault && !/^(main|develop)$/i.test(b.name))
    const averageHealth = scoredBranches.length ? Math.round(scoredBranches.reduce((s, b) => s + b.health.score, 0) / scoredBranches.length) : (branches.length ? 100 : 0)
    return {
      totalBranches: branches.length,
      validBranches: valid,
      invalidBranches: invalid,
      excludedBranches: excluded,
      compliancePercent: Math.round(((valid + excluded) / total) * 100),
      active: count((b) => b.state === 'active'),
      stale: count((b) => b.stale),
      merged: count((b) => b.merged),
      namingViolations: invalid,
      cleanupCandidates: count((b) => b.cleanupCandidate),
      protectedBranches: protectedCount,
      whitelistedBranches: whitelistedCount,
      averageHealth,
      repositories
    }
  }

  /** 报告范围统一来自调用方传入的仓库集合；空集合永远表示「没有仓库」。 */
  resolveScope(repositoryIds?: string[]): string[] {
    const requested = repositoryIds ?? this.storage.selectedRepositoryIds()
    const existing = new Set(this.repositoryService.list().map((repo) => repo.id))
    return [...new Set(requested)].filter((id) => existing.has(id))
  }

  getSummaryEmailData(repositoryIds?: string[]): EmailSummaryData {
    const scope = new Set(this.resolveScope(repositoryIds))
    const branches = scope.size === 0 ? [] : this.branchService.listBranches([...scope])
    const count = (fn: (branch: BranchSummary) => boolean): number => branches.filter(fn).length
    return {
      total: branches.length,
      stale: count((branch) => branch.stale),
      namingInvalid: count((branch) => branch.naming.status === 'invalid'),
      merged: count((branch) => branch.merged),
      cleanupCandidates: count((branch) => branch.cleanupCandidate),
      repositories: scope.size,
      generatedAt: new Date().toISOString(),
      branches: branches.map(toEmailIssueRow)
    }
  }

  private recentRuns(scope: string[]): ScanRun[] {
    if (scope.length === 0) return []
    const allowed = new Set(scope)
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 400')
    const runs = rows.map((r) => ({
      id: String(r.id),
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string | null) ?? null,
      status: (r.status as ScanRun['status']) ?? 'completed',
      trigger: (r.trigger as ScanRun['trigger']) ?? 'manual',
      repositories: Number(r.repositories ?? 0),
      branches: Number(r.branches ?? 0),
      active: Number(r.active ?? 0),
      stale: Number(r.stale ?? 0),
      merged: Number(r.merged ?? 0),
      namingInvalid: Number(r.naming_invalid ?? 0),
      cleanupCandidates: Number(r.cleanup_candidates ?? 0),
      notifications: Number(r.notifications ?? 0),
      emailsSent: Number(r.emails_sent ?? 0),
      error: (r.error as string | null) ?? null,
      activity: safeJson<ScanRun['activity']>(r.activity_json, []),
      repositoryIds: [] as string[]
    }))
    const runIds = runs.map((run) => run.id)
    if (runIds.length === 0) return []
    const associations = this.storage.all<Record<string, unknown>>(
      `SELECT run_id, repository_id FROM scan_run_repositories WHERE run_id IN (${runIds.map(() => '?').join(',')})`,
      runIds
    )
    const byRun = new Map(runs.map((run) => [run.id, run]))
    for (const association of associations) {
      byRun.get(String(association.run_id))?.repositoryIds?.push(String(association.repository_id))
    }
    return runs
      .filter((run) => run.repositoryIds!.length > 0 && run.repositoryIds!.every((id) => allowed.has(id)))
      .slice(0, 30)
  }

  private notifications(scope: string[]): Array<Record<string, unknown>> {
    if (scope.length === 0) return []
    const allowed = new Set(scope)
    const rows = this.storage.all<Record<string, unknown>>(
      `SELECT * FROM notification_history WHERE repository_id IN (${scope.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 200`,
      scope
    )
    return rows.map((r) => ({
      repository: String(r.repository_name ?? ''),
      branch: String(r.branch ?? ''),
      type: String(r.type ?? ''),
      state: String(r.state ?? ''),
      message: String(r.message ?? ''),
      createdAt: String(r.created_at ?? '')
    })).filter(() => allowed.size > 0)
  }

  /**
   * 只按勾选的仓库生成报告。没有勾选任何仓库时直接失败，绝不回退成全部仓库。
   * 报告主体按仓库分区，每个仓库独立统计自己的分支，最后给出所选范围总汇总。
   */
  async generateReport(period: string, format = 'html', repositoryIds?: string[]): Promise<ReportRecord> {
    const scope = this.resolveScope(repositoryIds)
    if (scope.length === 0) throw new Error('未选择仓库：请先在仓库页勾选要汇总的仓库。')
    const repos = scope
      .map((id) => this.repositoryService.get(id))
      .filter((repo): repo is NonNullable<typeof repo> => Boolean(repo))
    const branches = this.branchService.listBranches(scope).map((branch) => ({
      ...branch,
      repositoryName: repos.find((repo) => repo.id === branch.repositoryId)?.name ?? branch.repositoryName
    }))
    const summary = this.buildSummary(branches, repos.length)
    const runs = this.recentRuns(scope)
    const notifications = this.notifications(scope)
    const title = `Git Branch Health Report - 勾选仓库 (${period})`
    const generatedAt = new Date().toISOString()
    const filename = `gitmanager-${period}-${generatedAt.slice(0, 19).replace(/[:T]/g, '-')}.${format}`
    const filePath = path.join(reportsDir(), filename)

    const safeFormat = (['html', 'csv'].includes(format) ? format : 'html') as string
    const partitions: EmailReportPartition[] = repos.map((repo) => {
      const repositoryBranches = branches.filter((branch) => branch.repositoryId === repo.id)
      return {
        repositoryId: repo.id,
        repositoryName: repo.name,
        data: {
          ...this.buildSummary(repositoryBranches, 1),
          // 复用邮件汇总结构：分区内的指标只统计本仓库分支。
          total: repositoryBranches.length,
          stale: repositoryBranches.filter((branch) => branch.stale).length,
          namingInvalid: repositoryBranches.filter((branch) => branch.naming.status === 'invalid').length,
          merged: repositoryBranches.filter((branch) => branch.merged).length,
          cleanupCandidates: repositoryBranches.filter((branch) => branch.cleanupCandidate).length,
          repositories: 1,
          generatedAt,
          branches: repositoryBranches.map(toEmailIssueRow),
          thresholdHint: `统计范围 ${period}`
        } as EmailSummaryData
      }
    })
    const overall: EmailSummaryData = {
      total: summary.totalBranches,
      stale: summary.stale,
      namingInvalid: summary.namingViolations,
      merged: summary.merged,
      cleanupCandidates: summary.cleanupCandidates,
      repositories: repos.length,
      generatedAt,
      branches: branches.map(toEmailIssueRow),
      thresholdHint: `统计范围 ${period}`
    }
    await this.writeFile(safeFormat, filePath, title, generatedAt, branches, partitions, overall)

    const record: ReportRecord = {
      id: newId(),
      title,
      repositoryIds: scope,
      generatedAt,
      period,
      format: safeFormat,
      path: filePath,
      summary
    }
    this.storage.insert('reports', {
      id: record.id,
      title,
      repository_id: scope[0] ?? null,
      repository_ids_json: JSON.stringify(scope),
      generated_at: generatedAt,
      period,
      format: safeFormat,
      path: filePath,
      summary_json: JSON.stringify(summary)
    })
    this.audit.record('report_generated', {
      period,
      format: safeFormat,
      branches: summary.totalBranches,
      repositoryIds: scope
    })
    return record
  }

  async exportReport(id: string, format: string, repositoryIds?: string[]): Promise<ReportRecord> {
    const report = this.listReports(repositoryIds).find((r) => r.id === id)
    if (!report) throw new Error('Report not found.')
    return this.generateReport(report.period, format, report.repositoryIds)
  }

  deleteReport(id: string, repositoryIds?: string[]): ReportRecord[] {
    const report = this.listReports(repositoryIds).find((r) => r.id === id)
    if (report) {
      try {
        if (report.path && fs.existsSync(report.path)) fs.unlinkSync(report.path)
      } catch (err) {
        this.audit.record('report_deleted', { id, error: err instanceof Error ? err.message : String(err) }, 'failure')
      }
    }
    this.storage.delete('reports', 'id = ?', [id])
    this.audit.record('report_deleted', { id })
    return this.listReports(repositoryIds)
  }

  async openReportFolder(): Promise<void> {
    const dir = reportsDir()
    await shell.openPath(dir)
  }

  async openReportFile(id: string, repositoryIds?: string[]): Promise<void> {
    const report = this.listReports(repositoryIds).find((r) => r.id === id)
    if (report?.path && fs.existsSync(report.path)) {
      shell.showItemInFolder(report.path)
      return
    }
    await shell.openPath(reportsDir())
  }

  private async writeFile(
    format: string,
    filePath: string,
    title: string,
    generatedAt: string,
    branches: BranchSummary[],
    partitions: EmailReportPartition[],
    overall: EmailSummaryData
  ): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (format === 'csv') {
      const header = [
        'repository', 'branch', 'type', 'state', 'inactive_days', 'age_days', 'last_commit', 'creator',
        'ahead', 'behind', 'merged', 'naming', 'health', 'whitelisted', 'default', 'protected', 'cleanup_candidate'
      ]
      const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`
      const lines = [header.map(esc).join(',')]
      for (const b of branches) {
        lines.push(
          [
            b.repositoryName, b.name, b.type, b.state, b.inactiveDays, b.ageDays, b.lastCommitAt, b.creator.name,
            b.ahead, b.behind, b.merged, b.naming.status, b.health.score,
            b.protection.whitelisted, b.protection.isDefault, b.protection.protected, b.cleanupCandidate
          ]
            .map(esc)
            .join(',')
        )
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8')
      return
    }
    fs.writeFileSync(
      filePath,
      buildPartitionedReportHtml({ title, generatedAt, partitions, overall }, 'zh'),
      'utf8'
    )
  }

}

/**
 * 报告行可能是新格式（repository_ids_json 数组），也可能是升级前的单仓库
 * 列。两种都读取，保证旧报告的归属判断不会错位。
 */
function reportRepositoryIds(row: Record<string, unknown>): string[] {
  if (row.repository_ids_json != null) {
    try {
      const parsed = JSON.parse(String(row.repository_ids_json))
      if (Array.isArray(parsed)) return [...new Set(parsed.map(String).filter(Boolean))]
    } catch {
      return []
    }
  }
  const legacy = String(row.repository_id ?? '').trim()
  return legacy ? [legacy] : []
}

function emptySummary(): ReportSummary {
  return {
    totalBranches: 0,
    validBranches: 0,
    invalidBranches: 0,
    excludedBranches: 0,
    compliancePercent: 0,
    active: 0,
    stale: 0,
    merged: 0,
    namingViolations: 0,
    cleanupCandidates: 0,
    protectedBranches: 0,
    whitelistedBranches: 0,
    averageHealth: 0,
    repositories: 0
  }
}
