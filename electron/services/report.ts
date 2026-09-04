import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import PDFDocument from 'pdfkit'
import type { BranchSummary, ReportRecord, ReportSummary, ScanRun } from '@shared/types'
import type { StorageService } from './storage'
import type { BranchService } from './branch'
import type { RepositoryService } from './repository'
import type { AuditService } from './audit'
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
    const averageHealth = branches.length ? Math.round(branches.reduce((s, b) => s + b.health.score, 0) / branches.length) : 0
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
    const filename = `branchpulse-${period}-${generatedAt.slice(0, 19).replace(/[:T]/g, '-')}.${format === 'pdf' ? 'pdf' : format}`
    const filePath = path.join(reportsDir(), filename)

    const safeFormat = (['html', 'csv', 'json', 'pdf', 'png'].includes(format) ? format : 'html') as string
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

  async openReportFolder(): Promise<void> {
    const dir = reportsDir()
    await shell.openPath(dir)
  }

  private async writeFile(
    format: string,
    filePath: string,
    title: string,
    generatedAt: string,
    period: string,
    summary: ReportSummary,
    branches: BranchSummary[],
    runs: ScanRun[],
    notifications: Array<Record<string, unknown>>
  ): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (format === 'json') {
      const data = { title, generatedAt, period, summary, branches, runs, notifications }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
      return
    }
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
    const html = this.renderHtml(title, generatedAt, period, summary, branches, runs, notifications)
    if (format === 'pdf') {
      await this.writePdf(filePath, title, generatedAt, period, summary, branches)
      return
    }
    if (format === 'png') {
      const png = await this.capturePng(html)
      fs.writeFileSync(filePath, png)
      return
    }
    fs.writeFileSync(filePath, html, 'utf8')
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
      ['陈旧分支', summary.stale],
      ['宽限期内', summary.gracePeriod],
      ['宽限到期', summary.graceExpired],
      ['命名违规', summary.namingViolations],
      ['清理候选', summary.cleanupCandidates]
    ]
      .map(([label, value]) => ({ label: String(label), value: String(value) }))

      .slice()
const rows = branches
      .slice()
      .slice(0, 120)
      .map(
        (b) => `<tr>
          <td>${escapeHtml(b.repositoryName)}</td>
          <td><code>${escapeHtml(b.name)}</code></td>
          <td>${b.type}</td>
          <td>${b.state}</td>
          <td>${b.inactiveDays}</td>
          <td>${b.merged ? 'Yes' : 'No'}</td>
          <td>${b.naming.status}</td>
          <td>${b.health.score}</td>
          <td>${b.cleanupCandidate ? 'Yes' : ''}</td>
        </tr>`
      )
      .join('')
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
  @media(max-width:900px){.hero,.layout{padding-left:24px;padding-right:24px}.layout{grid-template-columns:1fr}}
  </style>
  <script>const slides=document.querySelectorAll('.slide');let active=0;setInterval(()=>{slides[active].classList.remove('active');active=(active+1)%slides.length;slides[active].classList.add('active')},3600)</script>
  </head><body>
  <section class="hero"><div class="hero-content">
    <div class="eyebrow">BranchPulse Report</div>
    <h1>分支生命周期<br/>健康与巡检报告</h1>
    <div class="sub">报告基于 GitLab 远程仓库实时巡检数据生成，聚焦分支陈旧趋势、命名合规、清理候选与通知投递情况，帮助团队快速做出分支治理决策。</div>
    <div class="meta"><span class="pill">${escapeHtml(title)}</span><span class="pill">生成时间：${escapeHtml(new Date(generatedAt).toLocaleString('zh-CN'))}</span><span class="pill">统计范围：${escapeHtml(period)}</span></div>
  </div></section>
  <main class="layout">
    <section class="glass carousel"><div class="slides">${metricCarousel}</div>
      <div class="section"><h2>总览</h2><table><tbody>
        <tr><td>平均健康分</td><td>${summary.averageHealth}</td></tr><tr><td>命名合规率</td><td>${summary.compliancePercent}%</td></tr><tr><td>仓库数量</td><td>${summary.repositories}</td></tr><tr><td>保护分支</td><td>${summary.protectedBranches}</td></tr>
      </tbody></table></div>
    </section>
    <section class="glass">
      <div class="section"><h2>最近巡检</h2><table><thead><tr><th>时间</th><th>触发方式</th><th>状态</th><th>分支</th><th>陈旧</th><th>命名异常</th><th>通知</th></tr></thead><tbody>${runRows}</tbody></table></div>
      <div class="section"><h2>分支健康（低分优先）</h2><table><thead><tr><th>仓库</th><th>分支</th><th>状态</th><th>未活跃</th><th>命名</th><th>健康分</th><th>清理候选</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="section"><h2>通知投递记录</h2><table><thead><tr><th>分支</th><th>类型</th><th>状态</th><th>内容</th></tr></thead><tbody>${notificationRows}</tbody></table></div>
    </section>
  </main>
  </body></html>`
  }

  private async writePdf(
    filePath: string,
    title: string,
    generatedAt: string,
    period: string,
    summary: ReportSummary,
    branches: BranchSummary[]
  ): Promise<void> {
    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)
    doc.fillColor('#0b0d12').rect(0, 0, doc.page.width, doc.page.height).fill()
    doc.fillColor('#ff7a18').font('Helvetica-Bold').fontSize(26).text('BranchPulse', 48, 48)
    doc.fillColor('#e6e9f2').fontSize(14).text(title, 48, 86)
    doc.fillColor('#8a90a3').fontSize(10).text(`Generated ${new Date(generatedAt).toLocaleString()}  |  Period ${period}`, 48, 108)

    const items: Array<[string, number]> = [
      ['Total branches', summary.totalBranches],
      ['Active', summary.active],
      ['Stale', summary.stale],
      ['Grace period', summary.gracePeriod],
      ['Grace expired', summary.graceExpired],
      ['Merged', summary.merged],
      ['Naming violations', summary.namingViolations],
      ['Cleanup candidates', summary.cleanupCandidates]
    ]
    let y = 150
    doc.fillColor('#7c5cfc').fontSize(20).text(`${summary.averageHealth}`, 48, y)
    doc.fillColor('#e6e9f2').font('Helvetica-Bold').fontSize(11).text('Average Health', 48, y + 26)
    doc.fillColor('#8a90a3').font('Helvetica').fontSize(10).text(`Naming compliance ${summary.compliancePercent}%  |  ${summary.repositories} repositories`, 48, y + 46)
    y += 90
    for (const [label, value] of items) {
      doc.fillColor('#e6e9f2').fontSize(12).text(label, 48, y)
      doc.fillColor('#ff7a18').font('Helvetica-Bold').fontSize(18).text(String(value), 300, y - 2)
      y += 24
    }

    const sorted = branches.slice().sort((a, b) => a.health.score - b.health.score)
    if (sorted.length > 0) {
      doc.addPage().fillColor('#0b0d12').rect(0, 0, doc.page.width, doc.page.height).fill()
      doc.fillColor('#ff7a18').font('Helvetica-Bold').fontSize(14).text('Branch Health', 48, 48)
      doc.fillColor('#8a90a3').font('Helvetica').fontSize(9).text('Worst branches first', 48, 66)
      y = 92
      for (const b of sorted.slice(0, 60)) {
        if (y > doc.page.height - 70) {
          doc.addPage().fillColor('#0b0d12').rect(0, 0, doc.page.width, doc.page.height).fill()
          y = 48
        }
        doc.fillColor('#e6e9f2').font('Helvetica-Bold').fontSize(9).text(`${b.name}`, 48, y)
        doc.fillColor('#8a90a3').font('Helvetica').fontSize(8).text(
          `${b.repositoryName}  |  ${b.state}  |  ${b.inactiveDays}d inactive  |  naming ${b.naming.status}  |  health ${b.health.score}`,
          48,
          y + 12
        )
        y += 34
      }
    }
    doc.end()
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve())
      stream.on('error', reject)
    })
  }

  private async capturePng(html: string): Promise<Buffer> {
    const win = new BrowserWindow({
      show: false,
      width: 1240,
      height: 920,
      webPreferences: { sandbox: true, contextIsolation: true }
    })
    try {
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
      await win.loadURL(dataUrl)
      const image = await win.webContents.capturePage()
      return image.toPNG()
    } finally {
      win.destroy()
    }
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
