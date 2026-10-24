import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageService } from '../src-node/services/storage'
import {
  buildBranchEmailHtml,
  collectCreatorAddresses,
  creatorNotificationSection,
  groupCreatorRecipients,
  resolveCreatorRecipient,
  type EmailIssueRow
} from '../src-node/services/email'

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

function serviceWithAudit(): {
  service: InstanceType<typeof EmailService>
  records: Array<{ action: string; detail: Record<string, unknown> }>
} {
  const records: Array<{ action: string; detail: Record<string, unknown> }> = []
  return {
    service: new EmailService(storage(), {
      record: (action: string, detail: Record<string, unknown>) => records.push({ action, detail })
    } as never),
    records
  }
}

function row(overrides: Partial<EmailIssueRow>): EmailIssueRow {
  return {
    repository: 'demo',
    branch: 'feature/a',
    creator: 'Unknown',
    creatorEmail: '',
    creatorEmailSource: '',
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
  it('notifies the last author when the creator is unverified', async () => {
    const svc = service()
    const result = await svc.sendCreatorEmails([
      row({
        creator: '张三',
        creatorEmail: 'untrusted@example.com',
        lastAuthor: '王五',
        lastAuthorEmail: 'wangwu@example.com'
      })
    ])
    expect(result.ok).toBe(true)
    expect(result.emailsSent).toBe(1)
    expect(mailer.messages[0]?.to).toEqual(['wangwu@example.com'])
    expect(result.message).toContain('改发给最后提交人')
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

  it('prefers a verified creator address over the last author', () => {
    const decision = resolveCreatorRecipient(row({
      creator: '张三',
      creatorEmail: 'creator@example.com',
      creatorEmailSource: 'account',
      lastAuthor: '王五',
      lastAuthorEmail: 'last@example.com'
    }))
    expect(decision).toEqual({
      kind: 'creator',
      address: 'creator@example.com',
      reason: 'verified-creator'
    })
  })

  it('ignores a lingering creator address without account provenance', () => {
    const decision = resolveCreatorRecipient(row({
      creator: '张三',
      creatorEmail: 'wrong-person@example.com',
      creatorEmailSource: '',
      lastAuthor: '王五',
      lastAuthorEmail: 'last@example.com'
    }))
    expect(decision).toEqual({
      kind: 'last-author',
      address: 'last@example.com',
      reason: 'creator-email-unverified-last-author-fallback'
    })
  })

  it('skips when the creator is unverified and the last-author address is invalid', () => {
    const decision = resolveCreatorRecipient(row({
      creator: '张三',
      creatorEmail: 'still-untrusted@example.com',
      creatorEmailSource: '',
      lastAuthor: '王五',
      lastAuthorEmail: 'not-an-email'
    }))
    expect(decision).toEqual({
      kind: 'missing',
      address: '',
      reason: 'no-valid-recipient-email'
    })
  })

  it('classifies a shared address as a verified creator when any matching row proves it', () => {
    const grouped = groupCreatorRecipients([
      row({
        branch: 'feature/fallback',
        creator: '李四',
        creatorEmail: '',
        lastAuthor: '张三',
        lastAuthorEmail: 'shared@example.com'
      }),
      row({
        branch: 'feature/verified',
        creator: '张三',
        creatorEmail: 'Shared@Example.com',
        creatorEmailSource: 'account'
      })
    ])
    expect(grouped.groups).toHaveLength(1)
    expect(grouped.groups[0]).toMatchObject({ kind: 'creator', address: 'shared@example.com' })
    expect(grouped.groups[0].rows).toHaveLength(2)
  })

  it('keeps collected recipients and actual creator sends consistent', async () => {
    const rows = [
      row({
        branch: 'feature/verified',
        creatorEmail: 'creator@example.com',
        creatorEmailSource: 'account'
      }),
      row({
        branch: 'feature/fallback',
        creator: '李四',
        creatorEmail: 'unverified@example.com',
        creatorEmailSource: '',
        lastAuthor: '王五',
        lastAuthorEmail: 'fallback@example.com'
      }),
      row({
        branch: 'feature/skipped',
        creator: '赵六',
        creatorEmail: '',
        lastAuthor: '无邮箱',
        lastAuthorEmail: ''
      })
    ]
    const collected = collectCreatorAddresses(rows)
    const svc = service()
    const result = await svc.sendCreatorEmails(rows)
    expect(collected.to).toEqual(['creator@example.com', 'fallback@example.com'])
    expect(collected.verifiedCreatorRecipients).toEqual(['creator@example.com'])
    expect(collected.fallbackRecipients).toEqual(['fallback@example.com'])
    expect(collected.skipped).toHaveLength(1)
    expect(result.recipients).toEqual(collected.to)
    expect(mailer.messages.map((message) => message.to)).toEqual([
      ['creator@example.com'],
      ['fallback@example.com']
    ])
  })

  it('audits verified, fallback and skipped recipient plans', async () => {
    const { service: svc, records } = serviceWithAudit()
    await svc.sendCreatorEmails([
      row({
        branch: 'feature/verified',
        creatorEmail: 'creator@example.com',
        creatorEmailSource: 'account'
      }),
      row({
        branch: 'feature/fallback',
        creator: '李四',
        creatorEmail: '',
        lastAuthor: '王五',
        lastAuthorEmail: 'fallback@example.com'
      }),
      row({
        branch: 'feature/skipped',
        creator: '赵六',
        creatorEmail: '',
        lastAuthor: '无邮箱',
        lastAuthorEmail: ''
      })
    ])
    const sentAudit = records.find((record) => record.action === 'email_creator_sent')
    expect(sentAudit?.detail).toMatchObject({
      verifiedCreatorRecipients: ['creator@example.com'],
      fallbackRecipients: ['fallback@example.com'],
      recipientPlan: [
        expect.objectContaining({ kind: 'creator', address: 'creator@example.com' }),
        expect.objectContaining({ kind: 'last-author', address: 'fallback@example.com' })
      ]
    })
    expect(sentAudit?.detail.skippedReasons).toEqual([
      '赵六（创始人邮箱无法确认，最后提交人无有效邮箱）'
    ])
  })

  it('states verified creators, fallbacks and skips in the report notification section', () => {
    const html = creatorNotificationSection(
      ['creator@example.com'],
      ['赵六（创始人邮箱无法确认，最后提交人无有效邮箱）'],
      'zh',
      ['fallback@example.com']
    )
    expect(html).toContain('平台账号已验证创始人收件人（1）')
    expect(html).toContain('最后提交人回退收件人（1')
    expect(html).toContain('已跳过并记录原因')
    expect(html).toContain('creator@example.com')
    expect(html).toContain('fallback@example.com')
  })
})
