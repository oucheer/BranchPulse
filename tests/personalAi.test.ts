import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalAiService } from '../src-node/services/personalAi'
import { registerSecretBackend } from '../src-node/utils/secrets'
import type { UserSession } from '../shared/types'

const rows = new Map<string, { base_url: string; model: string; api_key_encrypted: string }>()
const conversations = new Map<string, Record<string, unknown>>()
const messages: Array<Record<string, unknown>> = []
const tasks = new Map<string, Record<string, unknown>>()
const storage = {
  run: vi.fn((_sql: string, params: unknown[]) => rows.set(String(params[0]), { base_url: String(params[1]), model: String(params[2]), api_key_encrypted: String(params[3]) })),
  get: vi.fn((sql: string, params: unknown[]) => {
    if (sql.includes('user_ai_config')) return rows.get(String(params[0]))
    if (sql.includes('user_ai_conversations')) {
      const conversation = conversations.get(String(params[1]))
      return conversation?.user_key === params[0] ? conversation : null
    }
    if (sql.includes('user_ai_tasks')) return tasks.get(String(params[1]))
    return undefined
  }),
  all: vi.fn((sql: string, params: unknown[]) => {
    if (sql.includes('user_ai_messages')) return messages.filter((item) => item.user_key === params[0] && item.conversation_id === params[1]).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    if (sql.includes('user_ai_conversations')) return [...conversations.values()].filter((item) => item.user_key === params[0])
    return []
  }),
  insert: vi.fn((table: string, record: Record<string, unknown>) => {
    if (table === 'user_ai_conversations') conversations.set(String(record.id), record)
    if (table === 'user_ai_messages') messages.push(record)
    if (table === 'user_ai_tasks') tasks.set(String(record.id), record)
  }),
  update: vi.fn((table: string, values: Record<string, unknown>, where: string, params: unknown[]) => {
    const map = table === 'user_ai_conversations' ? conversations : tasks
    const key = String(params[1])
    const record = map.get(key)
    if (record) Object.assign(record, values)
  }),
  delete: vi.fn((table: string, where: string, params: unknown[]) => {
    const owner = String(params[0]); const id = String(params[1])
    if (table === 'user_ai_conversations' && conversations.get(id)?.user_key === owner) conversations.delete(id)
    if (table === 'user_ai_messages') for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.user_key === owner && messages[i]?.conversation_id === id) messages.splice(i, 1)
  })
}
const activityService = { getActivity: vi.fn() }
const service = new PersonalAiService(storage as never, activityService as never)

const user = (email: string, accountId: string): UserSession => ({
  token: 'token', role: 'user', email, username: email, accountId, source: 'gitlab', gitlabUserId: Number(accountId),
  displayName: email, hasGitlabToken: true, gitlabToken: 'forge-token'
})

describe('PersonalAiService', () => {
  beforeEach(() => {
    rows.clear()
    conversations.clear()
    messages.splice(0)
    tasks.clear()
    vi.restoreAllMocks()
    storage.run.mockImplementation((_sql, params) => rows.set(String(params[0]), { base_url: String(params[1]), model: String(params[2]), api_key_encrypted: String(params[3]) }))
    storage.get.mockImplementation((sql, params) => {
      if (sql.includes('user_ai_config')) return rows.get(String(params[0]))
      if (sql.includes('user_ai_conversations')) {
        const conversation = conversations.get(String(params[1]))
        return conversation?.user_key === params[0] ? conversation : null
      }
      if (sql.includes('user_ai_tasks')) return tasks.get(String(params[1]))
      return undefined
    })
    registerSecretBackend({ isAvailable: () => true, encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.replace(/^encrypted:/, '') })
  })

  it('isolates per-user config and never returns the API key', () => {
    const first = service.saveConfig(user('one@example.com', '1'), { baseUrl: 'https://ai.example/v1', model: 'model-a', apiKey: 'secret-a' })
    const second = service.saveConfig(user('two@example.com', '2'), { baseUrl: 'https://ai.example/v1', model: 'model-b', apiKey: 'secret-b' })
    expect(first).toEqual({ baseUrl: 'https://ai.example/v1', model: 'model-a', hasApiKey: true })
    expect(second.model).toBe('model-b')
    expect(JSON.stringify(first)).not.toContain('secret-a')
    expect(rows.get('gitlab:1')?.api_key_encrypted).toBe('encrypted:secret-a')
  })

  it('rejects admin config access', () => {
    expect(() => service.getConfig({ ...user('', ''), role: 'admin' })).toThrow('普通用户')
  })

  it('requires a complete saved configuration before testing the provider', async () => {
    await expect(service.testConnection(user('one@example.com', '1'))).rejects.toThrow('请先配置 API URL、模型和密钥')
  })

  it('validates the OpenAI-compatible response during connection tests', async () => {
    service.saveConfig(user('one@example.com', '1'), { baseUrl: 'https://ai.example/v1', model: 'model-a', apiKey: 'secret-a' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }))
    await expect(service.testConnection(user('one@example.com', '1'))).resolves.toEqual({ ok: true, message: '模型服务连接成功。' })

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ result: 'OK' }), { status: 200 }))
    await expect(service.testConnection(user('one@example.com', '1'))).rejects.toThrow('返回格式不兼容')
  })

  it('does not store credentials if the encryption backend silently falls back to obfuscation', () => {
    registerSecretBackend({ isAvailable: () => true, encrypt: (value) => `plain:${value}`, decrypt: () => '' })
    expect(() => service.saveConfig(user('one@example.com', '1'), { baseUrl: 'https://ai.example/v1', model: 'model-a', apiKey: 'secret-a' })).toThrow('已取消保存')
    expect(rows.has('gitlab:1')).toBe(false)
  })

  it('persists a private conversation and completes its background task with sourced activity facts', async () => {
    service.saveConfig(user('one@example.com', '1'), { baseUrl: 'https://ai.example/v1', model: 'model-a', apiKey: 'secret-a' })
    activityService.getActivity.mockResolvedValue({
      commits: [{ subject: 'Kernel fix', committedAt: '2026-01-01', repositoryName: 'kernel', sha: 'omitted' }],
      mergeRequests: [], commitDetails: [{ files: [{ path: 'drivers/print.c', added: 3, removed: 1, patch: 'limited patch' }] }],
      stats: { activeDays: 1, commitCount: 1, mrAuthored: 0, mrReviewed: 0, byRepository: [] }, branches: []
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '事实：1 次提交。' } }] }), { status: 200 }))
    const conversation = service.createConversation(user('one@example.com', '1'))
    const task = service.startChat(user('one@example.com', '1'), conversation.id, '这周做了什么？', 1)
    await vi.waitFor(() => expect(service.getTask(user('one@example.com', '1'), task.id)?.status).toBe('complete'))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> }
    const context = JSON.parse(body.messages[0]!.content.split('个人数据：')[1]!) as { facts: { commitCount: number }; fileChanges: Array<{ path: string }> }
    expect(context.fileChanges.map((file) => file.path)).toContain('drivers/print.c')
    expect(context.facts.commitCount).toBe(1)
    expect(JSON.stringify(body)).not.toContain('forge-token')
    expect(JSON.stringify(body)).not.toContain('omitted')
    expect(service.listMessages(user('one@example.com', '1'), conversation.id)).toHaveLength(2)
    expect(() => service.listMessages(user('two@example.com', '2'), conversation.id)).toThrow('会话不存在')
  })
})
