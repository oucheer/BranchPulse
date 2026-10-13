import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageService } from '../src-node/services/storage'
import { buildBranchEmailHtml, type EmailIssueRow } from '../src-node/services/email'

/**
 * The last-author fallback decides who receives a notification when the
 * branch creator cannot be resolved. These tests stub nodemailer so the
 * recipient selection is asserted without opening a socket.
 */
const mailer = vi.hoisted(() => ({
  transports: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  verify: async (): Promise<void> => undefined,
  send: async (_message: Record<string, unknown>): Promise<void> => undefined
}))

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      mailer.transports.push(options)
      return {
        verify: () => mailer.verify(),
        sendMail: async (message: Record<string, unknown>) => {
          await mailer.send(message)
          mailer.messages.push(message)
        },
        close: () => undefined
      }
    }
  }
}))

const { EmailService } = await import('../src-node/services/email')

function encode(value: string): string {
  return 'plain:' + Buffer.from(value, 'utf8').toString('base64')
}

function storage(): StorageService {
  const rows: Record<string, Record<string, unknown>> = {
    app_settings: { language: 'zh' },
    email_config: {
      server: 'smtp.example.com',
      port: 587,
      username: 'notify@example.com',
      password_encrypted: encode('smtp-secret'),
      from_address: 'GitManager <notify@example.com>',
      secure: 0,
      tls: 1,
      test_recipient: 'owner@example.com',
      self_email: 'owner@example.com',
      enabled: 1
    }
  }
  return {
    get: (query: string) => {
      const table = Object.keys(rows).find((name) => query.includes(name))
      return table ? rows[table] : undefined
    }
  } as unknown as StorageService
}

function service(): InstanceType<typeof EmailService> {
  return new EmailService(storage(), { record: () => undefined } as never)
}

function row(overrides: Partial<EmailIssueRow>): EmailIssueRow {
  return {
    repository: 'demo',
    branch: 'feature/a',
    creator: 'Unknown',
    creatorEmail: '',
    lastCommitDate: '-',
    inactiveDays: 90,
    namingStatus: 'valid',
    mergeStatus: 'not merged',
    healthScore: 50,
    state: 'stale',
    ...overrides
  }
}

beforeEach(() => {
  mailer.transports = []
  mailer.messages = []
})

describe('last-author notification fallback', () => {
  it('notifies the last author when the creator is unknown', async () => {
    const svc = service()
    const result = await svc.sendCreatorEmails([
      row({ lastAuthor: '王五', lastAuthorEmail: 'wangwu@example.com' })
    ])
    expect(result.ok).toBe(true)
    expect(result.emailsSent).toBe(1)
    expect(mailer.messages[0]?.to).toEqual(['wangwu@example.com'])
  })

  it('skips the branch when neither creator nor last author has an email', async () => {
    const svc = service()
    const result = await svc.sendCreatorEmails([
      row({ lastAuthor: '王五', lastAuthorEmail: '' })
    ])
    expect(result.ok).toBe(false)
    expect(result.emailsSent).toBe(0)
    expect(result.message).toContain('王五')
    expect(mailer.messages).toHaveLength(0)
  })

  it('marks unverified creators in the summary email', () => {
    const html = buildBranchEmailHtml({
      total: 1,
      stale: 1,
      namingInvalid: 0,
      merged: 0,
      cleanupCandidates: 0,
      repositories: 1,
      generatedAt: new Date().toISOString(),
      branches: [row({ lastAuthor: '王五' })]
    }, 'zh')
    expect(html).toContain('最后提交人，待确认创始人')
    expect(html).toContain('分支创始人需要确认')
    expect(html).toContain('王五')
  })
})
