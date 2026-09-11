import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { BranchSummary, ReportRecord, ReportSummary, ScanRun } from '@shared/types'
import type { StorageService } from './storage'
import type { BranchService } from './branch'
import type { RepositoryService } from './repository'
import type { AuditService } from './audit'
import type { EmailSummaryData } from './email'
import { buildBranchEmailHtml, toEmailIssueRow } from './email'
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

export class ReportService {
  constructor(
    private readonly storage: StorageService,
    private readonly branchService: BranchService,
    private readonly repositoryService: RepositoryService,
    private readonly audit: AuditService
  ) {}

  listReports(): ReportRecord[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM reports ORDER BY generated_at DESC LIMIT 200')
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? 'BranchPulse Report'),
      repositoryId: (r.repository_id as string | null) ?? null,
      generatedAt: String(r.generated_at),
      period: String(r.period ?? ''),
      format: String(r.format ?? 'html'),
      path: String(r.path ?? ''),
      summary: safeJson<ReportSummary>(r.summary_json, emptySummary())
    }))
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
      gracePeriod: count((b) => b.state === 'grace_period'),
      graceExpired: count((b) => b.state === 'grace_expired'),
      merged: count((b) => b.merged),
      namingViolations: invalid,
      cleanupCandidates: count((b) => b.cleanupCandidate),
      protectedBranches: protectedCount,
      whitelistedBranches: whitelistedCount,
      averageHealth,
      repositories
    }
  }

  getSummaryEmailData(repositoryId?: string | null): EmailSummaryData {
    const resolvedRepositoryId = repositoryId ?? (this.storage.get<Record<string, unknown>>('SELECT active_repository_id FROM app_settings WHERE id = 1')?.active_repository_id as string | null) ?? null
    const branches = this.branchService.listBranches().filter((branch) => !resolvedRepositoryId || branch.repositoryId === resolvedRepositoryId)
    const count = (fn: (branch: BranchSummary) => boolean): number => branches.filter(fn).length
    return {
      total: branches.length,
      stale: count((branch) => branch.stale),
      gracePeriod: count((branch) => branch.state === 'grace_period'),
      graceExpired: count((branch) => branch.state === 'grace_expired'),
      namingInvalid: count((branch) => branch.naming.status === 'invalid'),
      merged: count((branch) => branch.merged),
      cleanupCandidates: count((branch) => branch.cleanupCandidate),
      repositories: new Set(branches.map((branch) => branch.repositoryId)).size,
      generatedAt: new Date().toISOString(),
      branches: branches.map(toEmailIssueRow)
    }
  }

  private recentRuns(repositoryId?: string | null): ScanRun[] {
    void repositoryId
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 30')
    return rows.map((r) => ({
      id: String(r.id),
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string | null) ?? null,
      status: (r.status as ScanRun['status']) ?? 'completed',
      trigger: (r.trigger as ScanRun['trigger']) ?? 'manual',
      repositories: Number(r.repositories ?? 0),
      branches: Number(r.branches ?? 0),
      active: Number(r.active ?? 0),
      stale: Number(r.stale ?? 0),
      gracePeriod: Number(r.grace_period ?? 0),
      graceExpired: Number(r.grace_expired ?? 0),
      merged: Number(r.merged ?? 0),
      namingInvalid: Number(r.naming_invalid ?? 0),
      cleanupCandidates: Number(r.cleanup_candidates ?? 0),
      deleted: Number(r.deleted ?? 0),
      notifications: Number(r.notifications ?? 0),
      emailsSent: Number(r.emails_sent ?? 0),
      error: (r.error as string | null) ?? null,
      activity: safeJson<ScanRun['activity']>(r.activity_json, [])
    }))
  }

  private notifications(repositoryId?: string | null): Array<Record<string, unknown>> {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM notification_history ORDER BY created_at DESC LIMIT 200')
    return rows.map((r) => ({
      repository: String(r.repository_name ?? ''),
      branch: String(r.branch ?? ''),
      type: String(r.type ?? ''),
      state: String(r.state ?? ''),
      message: String(r.message ?? ''),
      createdAt: String(r.created_at ?? '')
    }))
  }

  async generateReport(period: string, format = 'html', repositoryId?: string | null): Promise<ReportRecord> {
    const resolvedRepositoryId = repositoryId ?? (this.storage.get<Record<string, unknown>>('SELECT active_repository_id FROM app_settings WHERE id = 1')?.active_repository_id as string | null) ?? null
    const repos = this.repositoryService.list().filter((repo) => !resolvedRepositoryId || repo.id === resolvedRepositoryId)
    const branches = this.branchService.listBranches().filter((branch) => !resolvedRepositoryId || branch.repositoryId === resolvedRepositoryId)
    const summary = this.buildSummary(branches, repos.length)
    const runs = this.recentRuns(resolvedRepositoryId)
    const notifications = this.notifications(resolvedRepositoryId)
    const title = `Git Branch Health Report (${period})`
    const generatedAt = new Date().toISOString()
    const filename = `branchpulse-${period}-${generatedAt.slice(0, 19).replace(/[:T]/g, '-')}.${format}`
    const filePath = path.join(reportsDir(), filename)

    const safeFormat = (['html', 'csv'].includes(format) ? format : 'html') as string
    await this.writeFile(safeFormat, filePath, title, generatedAt, period, summary, branches, runs, notifications)

    const record: ReportRecord = {
      id: newId(),
      title,
      repositoryId: resolvedRepositoryId,
      generatedAt,
      period,
      format: safeFormat,
      path: filePath,
      summary
    }
    this.storage.insert('reports', {
      id: record.id,
      title,
      repository_id: resolvedRepositoryId,
      generated_at: generatedAt,
      period,
      format: safeFormat,
      path: filePath,
      summary_json: JSON.stringify(summary)
    })
    this.audit.record('report_generated', { period, format: safeFormat, branches: summary.totalBranches })
    return record
  }

  async exportReport(id: string, format: string): Promise<ReportRecord> {
    const report = this.listReports().find((r) => r.id === id)
    if (!report) throw new Error('Report not found.')
    return this.generateReport(report.period, format, report.repositoryId)
  }

  deleteReport(id: string): ReportRecord[] {
    const report = this.listReports().find((r) => r.id === id)
    if (report) {
      try {
        if (report.path && fs.existsSync(report.path)) fs.unlinkSync(report.path)
      } catch (err) {
        this.audit.record('report_deleted', { id, error: err instanceof Error ? err.message : String(err) }, 'failure')
      }
    }
    this.storage.delete('reports', 'id = ?', [id])
    this.audit.record('report_deleted', { id })
    return this.listReports()
  }

  async openReportFolder(): Promise<void> {
    const dir = reportsDir()
    await shell.openPath(dir)
  }

  async openReportFile(id: string): Promise<void> {
    const report = this.listReports().find((r) => r.id === id)
    if (report?.path && fs.existsSync(report.path)) {
      shell.showItemInFolder(report.path)
      return
    }
    await shell.openPath(reportsDir())
  }

  private async writeFile(
    format: string,
    filePath: string,
    _title: string,
    generatedAt: string,
    period: string,
    summary: ReportSummary,
    branches: BranchSummary[],
    runs: ScanRun[],
    notifications: Array<Record<string, unknown>>
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
    const data: EmailSummaryData = {
      total: summary.totalBranches,
      stale: summary.stale,
      gracePeriod: summary.gracePeriod,
      graceExpired: summary.graceExpired,
      namingInvalid: summary.namingViolations,
      merged: summary.merged,
      cleanupCandidates: summary.cleanupCandidates,
      repositories: summary.repositories,
      generatedAt,
      branches: branches.map(toEmailIssueRow),
      thresholdHint: `统计范围 ${period}`
    }
    fs.writeFileSync(filePath, buildBranchEmailHtml(data, 'zh', 'report'), 'utf8')
  }

  private renderHtml(
    title: string,
    generatedAt: string,
    period: string,
    summary: ReportSummary,
    branches: BranchSummary[],
    runs: ScanRun[],
    notifications: Array<Record<string, unknown>>
  ): string {
    const cardData = [
      ['分支总数', summary.totalBranches],
      ['活跃分支', summary.active],
      ['已停更分支', summary.stale],
      ['宽限期内', summary.gracePeriod],
      ['宽限期已过', summary.graceExpired],
      ['命名不规范', summary.namingViolations],
      ['清理候选', summary.cleanupCandidates]
    ]
      .map(([label, value]) => ({ label: String(label), value: String(value) }))

    const runRows = runs
      .slice(0, 12)
      .map(
        (r) => `<tr><td>${escapeHtml(new Date(r.startedAt).toLocaleString())}</td><td>${r.trigger}</td><td>${r.status}</td><td>${r.branches}</td><td>${r.stale}</td><td>${r.namingInvalid}</td><td>${r.notifications}</td></tr>`
      )
      .join('')
    const notificationRows = notifications
      .slice(0, 30)
      .map(
        (n) => `<tr><td>${escapeHtml(String(n.branch))}</td><td>${escapeHtml(String(n.type))}</td><td>${escapeHtml(String(n.state))}</td><td>${escapeHtml(String(n.message))}</td></tr>`
      )
      .join('')
    const metricCarousel = cardData
      .map((card, index) => `<article class="glass ${index === 0 ? 'active' : ''}"><span>${card.label}</span><strong>${card.value}</strong></article>`)
      .join('')
    const chartItems = [
      { label: '活跃', value: summary.active, color: '#16a34a' },
      { label: '已停更', value: summary.stale, color: '#f59e0b' },
      { label: '宽限期内', value: summary.gracePeriod, color: '#f97316' },
      { label: '宽限期已过', value: summary.graceExpired, color: '#dc2626' },
      { label: '命名不规范', value: summary.namingViolations, color: '#7c5cfc' },
      { label: '清理候选', value: summary.cleanupCandidates, color: '#e11d48' }
    ]
    const maxChartValue = Math.max(1, ...chartItems.map((item) => item.value))
    const chartRows = chartItems
      .map((item) => `
        <tr>
          <td class="chart-label">${escapeHtml(item.label)}</td>
          <td class="chart-cell"><div class="bar"><span style="width:${Math.round((item.value / maxChartValue) * 100)}%;background:${item.color}"></span></div></td>
          <td class="chart-value">${item.value}</td>
        </tr>`)
      .join('')
    const ring = (value: number, color: string, label: string): string => {
      const circumference = 2 * Math.PI * 52
      const offset = circumference * (1 - Math.min(100, Math.max(0, value)) / 100)
      return `
        <div class="ring">
          <svg viewBox="0 0 130 130" role="img" aria-label="${escapeHtml(label)}">
            <circle cx="65" cy="65" r="52" stroke="#edeff5" stroke-width="12" fill="none"></circle>
            <circle cx="65" cy="65" r="52" stroke="${color}" stroke-width="12" fill="none"
              stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 65 65)"></circle>
            <text x="65" y="60" text-anchor="middle" class="ring-value">${value}</text>
            <text x="65" y="80" text-anchor="middle" class="ring-label">${escapeHtml(label)}</text>
          </svg>
        </div>`
    }
    const rings = [
      ring(summary.averageHealth, '#16a34a', '平均健康分'),
      ring(summary.compliancePercent, '#7c5cfc', '命名合规率')
    ].join('')
    const trendData = runs.slice(0, 12).reverse()
    const trendMax = Math.max(1, ...trendData.map((run) => run.branches))
    const trendPoints = trendData
      .map((run, index) => `${24 + index * Math.max(1, 512 / Math.max(1, trendData.length - 1))},${164 - (run.branches / trendMax) * 136}`)
      .join(' ')
    const riskBranches = branches
      .filter((b) => b.stale || b.graceExpired || b.cleanupCandidate)
      .sort((a, b) => b.inactiveDays - a.inactiveDays)
      .slice(0, 120)
    const riskRows = riskBranches.length ? riskBranches.map((b) => `
      <tr>
        <td>${escapeHtml(b.repositoryName)}</td>
        <td><code>${escapeHtml(b.displayName)}</code></td>
        <td>${escapeHtml(b.creator.name)}</td>
        <td>${b.inactiveDays} 天</td>
        <td>${escapeHtml(new Date(b.lastCommitAt ?? b.lastScannedAt).toLocaleString('zh-CN'))}</td>
        <td><b class="${b.cleanupCandidate ? 'danger' : 'warn'}">${escapeHtml(b.state)}</b></td>
        <td>${b.cleanupCandidate ? '是' : '否'}</td>
      </tr>`).join('') : '<tr><td colspan="7">当前没有超过阈值或待清理的分支。</td></tr>'
    const detailRows = branches.slice(0, 500).map((b) => `
      <tr>
        <td>${escapeHtml(b.repositoryName)}</td>
        <td><code>${escapeHtml(b.displayName)}</code></td>
        <td>${escapeHtml(b.creator.name)}</td>
        <td>${b.commitCount}</td>
        <td>${b.inactiveDays} 天</td>
        <td>${escapeHtml(b.state)}</td>
        <td>${escapeHtml(b.naming.status)}</td>
        <td>${b.health.score}</td>
        <td>${b.protection.isDefault ? '默认' : b.protection.protected ? '保护' : '普通'}</td>
      </tr>`).join('')
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box;margin:0} body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#12141c;background:#f4f5f8}
  .hero{position:relative;overflow:hidden;padding:64px 56px;background:linear-gradient(135deg,#fff 0%,#f0f1f6 46%,#e8eaf2 100%)}
  .hero:before{content:"";position:absolute;inset:-40% -20% auto -20%;height:480px;background:radial-gradient(circle at 24% 34%,rgba(255,122,24,.16),transparent 26%),radial-gradient(circle at 68% 42%,rgba(124,92,252,.17),transparent 28%);filter:blur(34px)}
  .hero-content{position:relative;max-width:1200px;margin:auto}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#ff7a18;font-weight:700}
  h1{font-size:clamp(32px,4vw,52px);line-height:1.05;margin:14px 0 16px;letter-spacing:-.02em}.sub{max-width:760px;color:#5f6679;font-size:16px;line-height:1.7}
  .meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.pill{padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.72);border:1px solid #dde0ea;color:#5f6679;font-size:12px}
  .layout{display:grid;grid-template-columns:minmax(320px,.9fr) minmax(520px,1.1fr);gap:24px;max-width:1200px;margin:-48px auto 0;padding:0 56px 56px;position:relative}
  .glass{height:100%;border:1px solid rgba(255,255,255,.58);border-radius:16px;background:rgba(255,255,255,.72);backdrop-filter:blur(18px);box-shadow:0 20px 60px rgba(20,24,40,.10);padding:26px}
  .carousel{position:relative;min-height:196px}.slide{position:absolute;inset:0;opacity:0;transform:translateY(12px);transition:.55s ease;pointer-events:none}
  .slide.active{opacity:1;transform:none}.slide span{color:#5f6679;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .slide strong{display:block;font-size:54px;margin:12px 0 10px;color:#12141c}.slide p{color:#5f6679;font-size:14px;line-height:1.6}
  .section{margin-top:26px}.section h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#ff7a18;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#69707f;font-size:11px;text-transform:uppercase;padding:8px 8px;border-bottom:1px solid #e6e8ef}
  td{padding:9px 8px;border-bottom:1px solid #eef0f4;color:#3c4250}code{font-family:Consolas,monospace;color:#7c5cfc}
  .bar{height:10px;min-width:4px;border-radius:999px;background:#edeff5;overflow:hidden}.bar span{display:block;height:100%;border-radius:999px}
  .chart-label{width:130px;font-weight:600}.chart-cell{width:auto}.chart-value{width:54px;text-align:right;font-weight:700}
  .danger{color:#dc2626}.warn{color:#d97706}
  .ring-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:6px}
  .ring svg{display:block;width:100%;height:auto}.ring-value{fill:#12141c;font-size:24px;font-weight:800}.ring-label{fill:#69707f;font-size:10px;font-weight:650}
  .trend{width:100%;height:auto;border:1px solid #e6e8ef;border-radius:12px;background:#fff}
  @media(max-width:900px){.hero,.layout{padding-left:24px;padding-right:24px}.layout{grid-template-columns:1fr}}
  </style>
  <script>const slides=document.querySelectorAll('.slide');let active=0;setInterval(()=>{slides[active].classList.remove('active');active=(active+1)%slides.length;slides[active].classList.add('active')},3600)</script>
  </head><body>
  <section class="hero"><div class="hero-content">
    <div class="eyebrow">BranchPulse Report</div>
    <h1>分支生命周期<br/>健康与巡检报告</h1>
    <div class="sub">报告基于远程仓库平台实时巡检数据生成，聚焦已停更分支趋势、命名合规、清理候选与通知投递情况，帮助团队快速做出分支治理决策。</div>
    <div class="meta"><span class="pill">${escapeHtml(title)}</span><span class="pill">生成时间：${escapeHtml(new Date(generatedAt).toLocaleString('zh-CN'))}</span><span class="pill">统计范围：${escapeHtml(period)}</span></div>
  </div></section>
  <main class="layout">
    <section class="glass carousel"><div class="slides">${metricCarousel}</div>
      <div class="section"><h2>总览</h2><table><tbody>
        <tr><td>平均健康分</td><td>${summary.averageHealth}</td></tr><tr><td>命名合规率</td><td>${summary.compliancePercent}%</td></tr><tr><td>仓库数量</td><td>${summary.repositories}</td></tr><tr><td>保护分支</td><td>${summary.protectedBranches}</td></tr>
      </tbody></table></div>
    </section>
    <section class="glass">
      <div class="section"><h2>数据一览</h2><div class="ring-grid">${rings}</div></div>
      <div class="section"><h2>分支分布图</h2><table class="chart"><tbody>${chartRows}</tbody></table></div>
      <div class="section"><h2>巡检趋势</h2><svg class="trend" viewBox="0 0 560 180" role="img" aria-label="巡检分支数量趋势">
        <line x1="24" y1="164" x2="536" y2="164" stroke="#e6e8ef"></line>
        <polyline points="${trendPoints}" fill="none" stroke="#ff7a18" stroke-width="3" stroke-linecap="round"></polyline>
      </svg></div>
      <div class="section"><h2>超过阈值 / 需要处理</h2><table><thead><tr><th>仓库</th><th>分支</th><th>创建人</th><th>未提交</th><th>最近提交</th><th>状态</th><th>清理候选</th></tr></thead><tbody>${riskRows}</tbody></table></div>
    <div class="section"><h2>最近巡检</h2><table><thead><tr><th>时间</th><th>触发方式</th><th>状态</th><th>分支</th><th>已停更</th><th>命名不规范</th><th>通知</th></tr></thead><tbody>${runRows}</tbody></table></div>
      <div class="section"><h2>全部分支明细</h2><table><thead><tr><th>仓库</th><th>分支</th><th>创建人</th><th>提交数</th><th>未提交</th><th>状态</th><th>命名</th><th>健康分</th><th>保护状态</th></tr></thead><tbody>${detailRows}</tbody></table></div>
      <div class="section"><h2>通知投递记录</h2><table><thead><tr><th>分支</th><th>类型</th><th>状态</th><th>内容</th></tr></thead><tbody>${notificationRows}</tbody></table></div>
    </section>
  </main>
  </body></html>`
  }

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
    gracePeriod: 0,
    graceExpired: 0,
    merged: 0,
    namingViolations: 0,
    cleanupCandidates: 0,
    protectedBranches: 0,
    whitelistedBranches: 0,
    averageHealth: 0,
    repositories: 0
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
