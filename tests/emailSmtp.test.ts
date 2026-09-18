import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageService } from '../src-node/services/storage'

/**
 * The mail transport is the risky part of the email service: it decides which
 * server, credentials and TLS mode a notification leaves through. These tests
 * stub nodemailer so the mapping from the Settings form to the SMTP options is
 * asserted without opening a socket.
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

function storage(config: Record<string, unknown> = {}): StorageService {
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
      enabled: 1,
      ...config
    }
  }
  return {
    get: (query: string) => {
      const table = Object.keys(rows).find((name) => query.includes(name))
      return table ? rows[table] : undefined
    }
  } as unknown as StorageService
}

function audit(): { records: Array<{ action: string; status?: string }>; record: (action: string, _detail?: unknown, status?: string) => void } {
  const records: Array<{ action: string; status?: string }> = []
  return { records, record: (action, _detail, status) => { records.push({ action, status }) } }
}

function service(config: Record<string, unknown> = {}): { service: InstanceType<typeof EmailService>; audit: ReturnType<typeof audit> } {
  const log = audit()
  return { service: new EmailService(storage(config), log as never), audit: log }
}

beforeEach(() => {
  mailer.transports = []
  mailer.messages = []
  mailer.verify = async () => undefined
  mailer.send = async () => undefined
})

describe('SMTP transport', () => {
  it('maps the saved configuration onto the transporter options', async () => {
    const { service: svc } = service()
    await svc.testConnection()
    expect(mailer.transports[0]).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'notify@example.com', pass: 'smtp-secret' }
    })
  })

  it('uses implicit TLS and no STARTTLS upgrade when secure is on', async () => {
    const { service: svc } = service({ secure: 1, tls: 1 })
    await svc.testConnection()
    expect(mailer.transports[0]).toMatchObject({ secure: true, requireTLS: false })
  })

  it('omits auth when the account has no username', async () => {
    const { service: svc } = service({ username: '' })
    await svc.testConnection()
    expect(mailer.transports[0].auth).toBeUndefined()
  })

  it('reports a missing server instead of opening a socket', async () => {
    const { service: svc, audit: log } = service({ server: '' })
    const result = await svc.testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('SMTP 服务器')
    expect(mailer.transports).toHaveLength(0)
    expect(log.records.at(-1)).toMatchObject({ action: 'email_connection_test', status: 'failure' })
  })

  it('surfaces a connection failure with the technical detail', async () => {
    mailer.verify = async () => { throw new Error('ECONNREFUSED 127.0.0.1:587') }
    const { service: svc, audit: log } = service()
    const result = await svc.testConnection()
    expect(result.ok).toBe(false)
    expect(result.technical).toContain('ECONNREFUSED')
    expect(log.records.at(-1)?.status).toBe('failure')
  })
})

describe('sending through the configured mailbox', () => {
  it('sends the test email to the test recipient from the configured address', async () => {
    const { service: svc } = service()
    const result = await svc.sendTestEmail()
    expect(result).toMatchObject({ ok: true, emailsSent: 1, recipients: ['owner@example.com'] })
    expect(mailer.messages[0]).toMatchObject({
      from: 'GitManager <notify@example.com>',
      to: ['owner@example.com']
    })
  })

  it('lets an unsaved configuration from the settings form be tested', async () => {
    const { service: svc } = service()
    const result = await svc.testConnection({ ...svc.getConfig(), server: 'smtp.other.test', password: 'typed-secret' })
    expect(result.ok).toBe(true)
    expect(mailer.transports[0]).toMatchObject({
      host: 'smtp.other.test',
      auth: { user: 'notify@example.com', pass: 'typed-secret' }
    })
  })

  it('falls back to the account username when no from address is set', async () => {
    const { service: svc } = service({ from_address: '' })
    await svc.sendTestEmail()
    expect(mailer.messages[0].from).toBe('notify@example.com')
  })

  it('refuses to send a summary while email is disabled', async () => {
    const { service: svc } = service({ enabled: 0 })
    const result = await svc.sendSummaryEmail({
      total: 0, stale: 0, gracePeriod: 0, graceExpired: 0, namingInvalid: 0, merged: 0,
      cleanupCandidates: 0, repositories: 0, generatedAt: new Date().toISOString(), branches: []
    })
    expect(result.ok).toBe(false)
    expect(mailer.messages).toHaveLength(0)
  })

  it('reuses one transport for a whole creator batch and skips invalid addresses', async () => {
    const { service: svc } = service()
    const rows = [
      { repository: 'demo', branch: 'feature/a', creator: '张三', creatorEmail: 'zhang@example.com', lastCommitDate: '-', inactiveDays: 90, gracePeriod: 60, namingStatus: 'valid', mergeStatus: 'not merged', healthScore: 50, state: 'stale' },
      { repository: 'demo', branch: 'feature/b', creator: '李四', creatorEmail: '', lastCommitDate: '-', inactiveDays: 90, gracePeriod: 60, namingStatus: 'valid', mergeStatus: 'not merged', healthScore: 50, state: 'stale' }
    ]
    const result = await svc.sendCreatorEmails(rows)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('李四')
    expect(mailer.transports).toHaveLength(1)
    expect(mailer.messages).toHaveLength(1)
  })
})
