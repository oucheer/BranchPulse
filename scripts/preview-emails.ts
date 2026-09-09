import fs from 'node:fs'
import path from 'node:path'
import { buildBranchEmailHtml, EmailService, type EmailIssueRow, type EmailSummaryData } from '../electron/services/email'

type PreviewLang = 'zh' | 'en'

const outDir = path.resolve(process.cwd(), 'out', 'email-previews')
fs.mkdirSync(outDir, { recursive: true })

function rows(lang: PreviewLang): EmailIssueRow[] {
  const reason = lang === 'zh' ? '缺少 feature/ 前缀' : 'Missing feature/ prefix'
  const merged = lang === 'zh' ? 'merged' : 'merged'
  const notMerged = lang === 'zh' ? 'not merged' : 'not merged'
  return [
    {
      repository: 'payment-service',
      branch: 'feat/payment-retry',
      creator: lang === 'zh' ? '张伟' : 'Wei Zhang',
      creatorEmail: 'wei.zhang@example.com',
      lastCommitDate: '2026-09-08 16:24',
      lastCommitAt: '2026-09-08T16:24:00Z',
      inactiveDays: 1,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: notMerged,
      healthScore: 92,
      state: 'active',
      cleanupCandidate: false
    },
    {
      repository: 'payment-service',
      branch: 'checkout-retry',
      creator: lang === 'zh' ? '张伟' : 'Wei Zhang',
      creatorEmail: 'wei.zhang@example.com',
      lastCommitDate: '2026-08-06 10:38',
      lastCommitAt: '2026-08-06T10:38:00Z',
      inactiveDays: 34,
      gracePeriod: 7,
      namingStatus: 'invalid',
      namingRuleName: 'feature/*',
      namingReason: reason,
      mergeStatus: notMerged,
      healthScore: 64,
      state: 'stale',
      cleanupCandidate: true
    },
    {
      repository: 'payment-service',
      branch: 'feat/legacy-checkout',
      creator: lang === 'zh' ? '张伟' : 'Wei Zhang',
      creatorEmail: 'wei.zhang@example.com',
      lastCommitDate: '2026-08-12 18:05',
      lastCommitAt: '2026-08-12T18:05:00Z',
      inactiveDays: 28,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: notMerged,
      healthScore: 58,
      state: 'stale',
      cleanupCandidate: true
    },
    {
      repository: 'inventory-service',
      branch: 'chore/update-dependencies',
      creator: lang === 'zh' ? '李娜' : 'Na Li',
      creatorEmail: 'na.li@example.com',
      lastCommitDate: '2026-08-26 09:12',
      lastCommitAt: '2026-08-26T09:12:00Z',
      inactiveDays: 14,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: notMerged,
      healthScore: 75,
      state: 'grace_period',
      cleanupCandidate: false
    },
    {
      repository: 'inventory-service',
      branch: 'bugfix/stock-sync',
      creator: lang === 'zh' ? '李娜' : 'Na Li',
      creatorEmail: 'na.li@example.com',
      lastCommitDate: '2026-07-18 20:47',
      lastCommitAt: '2026-07-18T20:47:00Z',
      inactiveDays: 53,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: notMerged,
      healthScore: 42,
      state: 'grace_expired',
      cleanupCandidate: true
    },
    {
      repository: 'payment-service',
      branch: 'release/v2.3.0',
      creator: lang === 'zh' ? '王强' : 'Qiang Wang',
      creatorEmail: 'qiang.wang@example.com',
      lastCommitDate: '2026-09-01 11:30',
      lastCommitAt: '2026-09-01T11:30:00Z',
      inactiveDays: 8,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: merged,
      healthScore: 88,
      state: 'active',
      cleanupCandidate: false
    },
    {
      repository: 'inventory-service',
      branch: 'feat/warehouse-map',
      creator: lang === 'zh' ? '王强' : 'Qiang Wang',
      creatorEmail: 'qiang.wang@example.com',
      lastCommitDate: '2026-09-07 14:10',
      lastCommitAt: '2026-09-07T14:10:00Z',
      inactiveDays: 2,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: notMerged,
      healthScore: 95,
      state: 'active',
      cleanupCandidate: false
    },
    {
      repository: 'inventory-service',
      branch: 'docs/api-notes',
      creator: lang === 'zh' ? '李娜' : 'Na Li',
      creatorEmail: 'na.li@example.com',
      lastCommitDate: '2026-08-29 17:55',
      lastCommitAt: '2026-08-29T17:55:00Z',
      inactiveDays: 11,
      gracePeriod: 7,
      namingStatus: 'valid',
      mergeStatus: notMerged,
      healthScore: 80,
      state: 'grace_period',
      cleanupCandidate: false
    }
  ]
}

function summaryData(lang: PreviewLang): EmailSummaryData {
  const branchRows = rows(lang)
  return {
    total: branchRows.length,
    stale: branchRows.filter((row) => row.state === 'stale').length,
    gracePeriod: branchRows.filter((row) => row.state === 'grace_period').length,
    graceExpired: branchRows.filter((row) => row.state === 'grace_expired').length,
    namingInvalid: branchRows.filter((row) => row.namingStatus === 'invalid').length,
    merged: 1,
    cleanupCandidates: branchRows.filter((row) => row.cleanupCandidate).length,
    repositories: new Set(branchRows.map((row) => row.repository)).size,
    generatedAt: new Date().toISOString(),
    branches: branchRows
  }
}

function write(name: string, html: string): void {
  const file = path.join(outDir, name)
  fs.writeFileSync(file, html, 'utf8')
  console.log(file)
}

function fakeStorage(lang: PreviewLang): any {
  return {
    get: (query: string) => {
      if (query.includes('app_settings')) return { language: lang }
      if (query.includes('email_config')) {
        return {
          enabled: 1,
          self_email: 'owner@example.com',
          test_recipient: 'owner@example.com',
          username: 'owner@example.com'
        }
      }
      return {}
    }
  }
}

async function creatorEmail(lang: PreviewLang): Promise<string> {
  const service = new EmailService(fakeStorage(lang), { record: () => {} } as any)
  const htmlBodies: string[] = []
  ;(service as any).runOutlookScript = async (_script: string, payload?: { htmlBody?: string }) => {
    htmlBodies.push(payload?.htmlBody ?? '')
    return 'OK'
  }
  const issueRows = rows(lang).filter((row) => row.creatorEmail === 'wei.zhang@example.com' && row.state !== 'active')
  const result = await service.sendCreatorEmails(issueRows)
  if (!result.ok) throw new Error(`Preview creator email failed: ${result.message}`)
  return htmlBodies[0] ?? ''
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString()
  for (const lang of ['zh', 'en'] as const) {
    write(`summary-${lang}.html`, buildBranchEmailHtml(summaryData(lang), lang, 'summary'))
    write(`report-${lang}.html`, buildBranchEmailHtml(summaryData(lang), lang, 'report'))
    write(`creator-${lang}.html`, await creatorEmail(lang))
  }

  const links = ['summary-zh.html', 'summary-en.html', 'report-zh.html', 'report-en.html', 'creator-zh.html', 'creator-en.html']
    .map((name) => `<li><a href="${name}">${name}</a></li>`)
    .join('')
  write('index.html', `<!doctype html><meta charset="utf-8"><h1>BranchPulse email previews</h1><ul>${links}</ul><p>Generated at ${generatedAt}</p>`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
