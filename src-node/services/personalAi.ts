import type { PersonalActivity, PersonalAiConfig, PersonalAiConfigDraft, PersonalAiConversation, PersonalAiMessage, PersonalAiTask, UserSession } from '@shared/types'
import type { StorageService } from './storage'
import type { UserActivityService } from './userActivity'
import { decryptSecret, encryptSecret, isSecretEncryptionAvailable } from '../utils/secrets'
import { newId } from '../utils/ids'
import { nowIso } from './storage'

interface StoredConfig { base_url: string; model: string; api_key_encrypted: string }

function userKey(session: UserSession): string {
  if (session.role !== 'user' || !session.email) throw new Error('AI 助手仅对已登录普通用户开放。')
  return `${session.source ?? ''}:${session.accountId ?? session.email.toLowerCase()}`
}

function safeBaseUrl(value: string): string {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (privateHost && process.env.GITMANAGER_AI_ALLOW_PRIVATE_NETWORK !== '1')) throw new Error('API URL 必须是有效的 HTTP(S) 地址。内网模型需由服务端设置 GITMANAGER_AI_ALLOW_PRIVATE_NETWORK=1。')
  return url.toString().replace(/\/$/, '')
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(normalized)) return normalized
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`
  return `${normalized}/v1/chat/completions`
}

function reportPrompt(activity: PersonalActivity, range: { start: string; end: string }): string {
  const facts = {
    range,
    commits: activity.commits.map(({ subject, committedAt, repositoryName }) => ({ subject, committedAt, repositoryName })),
    mergeRequests: activity.mergeRequests.map(({ title, state, role, repositoryName, sourceBranch, targetBranch }) => ({ title, state, role, repositoryName, sourceBranch, targetBranch })),
    fileChanges: activity.commitDetails.flatMap((detail) => detail.files.map(({ path, added, removed }) => ({ path, added, removed }))),
    repositoryStats: activity.stats.byRepository,
    stats: { activeDays: activity.stats.activeDays, mrAuthored: activity.stats.mrAuthored, mrReviewed: activity.stats.mrReviewed }
  }
  return `请基于以下 Git 活动数据生成中文研发复盘，结构包含工作内容归纳、按项目成果、主要修改模块、代码变化趋势、待继续事项、可直接用于周报/月报的文字。必须明确区分“数据事实”和“根据提交描述推断”；不能将代码行数等同工作量。没有证据的未完成事项必须说明无法从数据确认，不得臆测。只读分析。\n数据：${JSON.stringify(facts)}`
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_activity_stats',
      description: 'Read the user\'s personal activity summary computed by GitManager: commits, active days, monthly/weekday/hourly distributions, repositories, branches and merge-request roles.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_activity_commits',
      description: 'Read the user\'s personal commits within the selected activity range. Optional text query matches subject, repository name or short SHA.',
      parameters: {
        type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_activity_merge_requests',
      description: 'Read the user\'s merge requests within the selected activity range. Optional text query matches title, branch, repository, state or role.',
      parameters: {
        type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_activity_files',
      description: 'Read changed files and line totals from the user\'s commits, with a short read-only sample patch when the forge provided one. Optional text query matches file path.',
      parameters: {
        type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_activity_branches',
      description: 'Read branches currently tracked as created by the user. Optional text query matches branch or repository name.',
      parameters: {
        type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false
      }
    }
  }
] as const

function localIsoDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export class PersonalAiService {
  private readonly running = new Map<string, Promise<void>>()
  constructor(private readonly storage: StorageService, private readonly activityService: UserActivityService) {}

  listConversations(session: UserSession): PersonalAiConversation[] {
    const owner = userKey(session)
    return this.storage.all<Record<string, unknown>>('SELECT * FROM user_ai_conversations WHERE user_key = ? ORDER BY updated_at DESC', [owner]).map((row) => this.toConversation(row))
  }

  createConversation(session: UserSession): PersonalAiConversation {
    const owner = userKey(session)
    const now = nowIso()
    const id = newId()
    this.storage.insert('user_ai_conversations', { id, user_key: owner, title: '新对话', status: 'idle', created_at: now, updated_at: now })
    return { id, title: '新对话', status: 'idle', createdAt: now, updatedAt: now }
  }

  deleteConversation(session: UserSession, id: string): void {
    const owner = userKey(session)
    this.storage.delete('user_ai_messages', 'user_key = ? AND conversation_id = ?', [owner, id])
    this.storage.delete('user_ai_tasks', 'user_key = ? AND conversation_id = ?', [owner, id])
    this.storage.delete('user_ai_conversations', 'user_key = ? AND id = ?', [owner, id])
  }

  listMessages(session: UserSession, conversationId: string): PersonalAiMessage[] {
    const owner = userKey(session)
    if (!this.storage.get('SELECT id FROM user_ai_conversations WHERE user_key = ? AND id = ?', [owner, conversationId])) throw new Error('会话不存在或无权访问。')
    return this.storage.all<Record<string, unknown>>('SELECT * FROM user_ai_messages WHERE user_key = ? AND conversation_id = ? ORDER BY created_at, rowid', [owner, conversationId]).map((row) => ({
      id: String(row.id), role: row.role as PersonalAiMessage['role'], content: String(row.content), status: row.status as PersonalAiMessage['status'], createdAt: String(row.created_at)
    }))
  }

  startChat(session: UserSession, conversationId: string, question: string, months: number): PersonalAiTask {
    const owner = userKey(session)
    const conversation = this.storage.get<Record<string, unknown>>('SELECT * FROM user_ai_conversations WHERE user_key = ? AND id = ?', [owner, conversationId])
    if (!conversation) throw new Error('会话不存在或无权访问。')
    if (conversation.status === 'running') throw new Error('此会话仍有问题正在处理。')
    const clean = String(question ?? '').trim().slice(0, 4000)
    if (!clean) throw new Error('请输入问题。')
    const id = newId()
    const now = nowIso()
    this.storage.insert('user_ai_messages', { id: newId(), conversation_id: conversationId, user_key: owner, role: 'user', content: clean, status: 'complete', created_at: now })
    const task = { id, user_key: owner, conversation_id: conversationId, kind: 'chat', status: 'running', error: null, created_at: now, updated_at: now }
    this.storage.insert('user_ai_tasks', task)
    const title = conversation.title === '新对话' ? clean.slice(0, 48) : String(conversation.title)
    this.storage.update('user_ai_conversations', { title, status: 'running', updated_at: now }, 'user_key = ? AND id = ?', [owner, conversationId])
    const work = this.runChat(session, conversationId, id, clean, months).finally(() => this.running.delete(id))
    this.running.set(id, work)
    return this.toTask(task)
  }

  getTask(session: UserSession, id: string): PersonalAiTask | null {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM user_ai_tasks WHERE user_key = ? AND id = ?', [userKey(session), id])
    return row ? this.toTask(row) : null
  }

  getConfig(session: UserSession): PersonalAiConfig {
    const row = this.storage.get<StoredConfig>('SELECT base_url, model, api_key_encrypted FROM user_ai_config WHERE user_key = ?', [userKey(session)])
    return { baseUrl: row?.base_url ?? '', model: row?.model ?? '', hasApiKey: Boolean(row?.api_key_encrypted) }
  }

  saveConfig(session: UserSession, draft: PersonalAiConfigDraft): PersonalAiConfig {
    const key = userKey(session)
    const baseUrl = draft.baseUrl.trim() ? safeBaseUrl(draft.baseUrl.trim()) : ''
    const model = String(draft.model ?? '').trim().slice(0, 200)
    if (baseUrl && !model) throw new Error('请填写模型名称。')
    const previous = this.storage.get<StoredConfig>('SELECT base_url, model, api_key_encrypted FROM user_ai_config WHERE user_key = ?', [key])
    const apiKey = String(draft.apiKey ?? '').trim()
    if (apiKey && !isSecretEncryptionAvailable()) throw new Error('服务端加密不可用。Linux / Node 部署请设置 GITMANAGER_ENCRYPTION_KEY（64 位十六进制密钥）并重启服务，再保存 API 密钥。')
    const encrypted = apiKey ? encryptSecret(apiKey) : (previous?.api_key_encrypted ?? '')
    if (apiKey && encrypted.startsWith('plain:')) throw new Error('API 密钥未能加密，已取消保存。请检查服务端系统密钥库配置。')
    if (!baseUrl && !apiKey && !previous) return this.getConfig(session)
    this.storage.run(`INSERT INTO user_ai_config (user_key, base_url, model, api_key_encrypted) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, api_key_encrypted = excluded.api_key_encrypted`, [key, baseUrl, model, encrypted])
    return this.getConfig(session)
  }

  async testConnection(session: UserSession): Promise<{ ok: boolean; message: string }> {
    const config = this.loadCredentials(session)
    try {
      const response = await fetch(completionUrl(config.baseUrl), {
        method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }),
        signal: AbortSignal.timeout(30_000), redirect: 'error'
      })
      if (!response.ok) throw new Error(`模型服务连接失败（HTTP ${response.status}）。请检查 API URL、模型名称和 API Key。`)
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      if (typeof body.choices?.[0]?.message?.content !== 'string') throw new Error('服务已响应，但返回格式不兼容。请使用支持 OpenAI Chat Completions 的 API URL。')
      return { ok: true, message: '模型服务连接成功。' }
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith('模型服务连接失败') || err.message.startsWith('服务已响应'))) throw err
      throw new Error('无法连接模型服务。请检查公网 API URL、服务状态和网络连接。')
    }
  }

  private async runChat(session: UserSession, conversationId: string, taskId: string, question: string, months: number): Promise<void> {
    const owner = userKey(session)
    try {
      const config = this.loadCredentials(session)
      const activity = await this.activityService.getActivity(session, months)
      const history = this.storage.all<Record<string, unknown>>('SELECT role, content FROM user_ai_messages WHERE user_key = ? AND conversation_id = ? ORDER BY created_at, rowid', [owner, conversationId]).slice(-11, -1)
      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: '你是 GitManager 的只读个人研发数据分析助手。回答前优先使用提供的只读数据工具查询当前用户的 Git 活动，再用自然语言回答；不要使用固定标题或模板化段落。统计值必须来自工具返回的数据，不能估算或补齐；需要根据提交描述推断时明确说明是推断，不要把代码行数等同工作量。未知不等于0，工具没有覆盖的字段说明数据未提供。不能执行或建议通过本系统修改、删除仓库内容。' },
        ...history.filter((entry) => entry.role === 'user' || entry.role === 'assistant').map(({ role, content }) => ({ role: String(role), content: String(content).slice(0, 4000) })),
        { role: 'user', content: question }
      ]
      const answer = await this.agentLoop(config, messages, activity)
      this.storage.insert('user_ai_messages', { id: newId(), conversation_id: conversationId, user_key: owner, role: 'assistant', content: answer, status: 'complete', created_at: nowIso() })
      this.storage.update('user_ai_tasks', { status: 'complete', error: null, updated_at: nowIso() }, 'user_key = ? AND id = ?', [owner, taskId])
      this.storage.update('user_ai_conversations', { status: 'idle', updated_at: nowIso() }, 'user_key = ? AND id = ?', [owner, conversationId])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.storage.insert('user_ai_messages', { id: newId(), conversation_id: conversationId, user_key: owner, role: 'assistant', content: `本次请求失败：${message}`, status: 'failed', created_at: nowIso() })
      this.storage.update('user_ai_tasks', { status: 'failed', error: message.slice(0, 500), updated_at: nowIso() }, 'user_key = ? AND id = ?', [owner, taskId])
      this.storage.update('user_ai_conversations', { status: 'failed', updated_at: nowIso() }, 'user_key = ? AND id = ?', [owner, conversationId])
    }
  }

  async review(session: UserSession, months: number, selectedRange?: { start: string; end: string }): Promise<string> {
    const config = this.loadCredentials(session)
    const activity = await this.activityService.getActivity(session, months)
    const now = new Date()
    const defaultStart = localIsoDate(new Date(now.getFullYear(), now.getMonth() - months + 1, 1))
    const range = selectedRange && /^\d{4}-\d{2}-\d{2}$/.test(selectedRange.start) && /^\d{4}-\d{2}-\d{2}$/.test(selectedRange.end)
      && selectedRange.start <= selectedRange.end ? selectedRange : { start: defaultStart, end: localIsoDate(now) }
    return (await this.complete(config, [{ role: 'user', content: reportPrompt(activity, range) }])).content
  }

  private agentLoop(
    config: { baseUrl: string; model: string; apiKey: string },
    messages: Array<Record<string, unknown>>,
    activity: PersonalActivity
  ): Promise<string> {
    return this.runAgentLoop(config, messages, activity, 0)
  }

  private async runAgentLoop(
    config: { baseUrl: string; model: string; apiKey: string },
    messages: Array<Record<string, unknown>>,
    activity: PersonalActivity,
    round: number
  ): Promise<string> {
    if (round >= 5) return '这个问题需要的数据工具调用次数过多，请把问题拆小后再试。'
    const result = await this.complete(config, messages, AGENT_TOOLS)
    if (!result.toolCalls.length) return result.content
    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.rawToolCalls })
    for (const call of result.toolCalls) {
      let payload: unknown
      try {
        payload = this.runTool(call.name, call.arguments, activity)
      } catch (err) {
        payload = { error: err instanceof Error ? err.message : String(err) }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(payload) })
    }
    return this.runAgentLoop(config, messages, activity, round + 1)
  }

  private runTool(name: string, rawArguments: string, activity: PersonalActivity): unknown {
    const args = rawArguments ? JSON.parse(rawArguments) as Record<string, unknown> : {}
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200))
    const match = (value: string | undefined | null): boolean => query ? String(value ?? '').toLowerCase().includes(query) : true
    switch (name) {
      case 'get_activity_stats':
        return activity.stats
      case 'get_activity_commits':
        return {
          total: activity.commits.length,
          items: activity.commits
            .filter((commit) => match(commit.subject) || match(commit.repositoryName) || match(commit.shortSha))
            .slice(0, limit)
            .map(({ subject, committedAt, repositoryName, shortSha }) => ({ subject, committedAt, repositoryName, shortSha }))
        }
      case 'get_activity_merge_requests':
        return {
          total: activity.mergeRequests.length,
          items: activity.mergeRequests
            .filter((mr) => match(mr.title) || match(mr.repositoryName) || match(mr.sourceBranch) || match(mr.targetBranch) || match(mr.state))
            .slice(0, limit)
            .map(({ title, state, role, repositoryName, sourceBranch, targetBranch, createdAt }) => ({ title, state, role, repositoryName, sourceBranch, targetBranch, createdAt }))
        }
      case 'get_activity_files': {
        const fileMap = new Map<string, { path: string; commits: number; added: number; removed: number; samplePatch?: string }>()
        for (const detail of activity.commitDetails) {
          for (const file of detail.files) {
            if (!match(file.path)) continue
            const entry = fileMap.get(file.path) ?? { path: file.path, commits: 0, added: 0, removed: 0 }
            entry.commits += 1
            entry.added += file.added
            entry.removed += file.removed
            if (!entry.samplePatch && file.patch) entry.samplePatch = file.patch.slice(0, 300)
            fileMap.set(file.path, entry)
          }
        }
        return { total: fileMap.size, items: [...fileMap.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed)).slice(0, limit) }
      }
      case 'get_activity_branches':
        return {
          total: activity.branches.length,
          items: activity.branches
            .filter((branch) => match(branch.name) || match(branch.repositoryName))
            .slice(0, limit)
            .map(({ name, type, createdAt, repositoryName }) => ({ name, type, createdAt, repositoryName }))
        }
      default:
        throw new Error(`未知的数据工具：${name}`)
    }
  }

  private toConversation(row: Record<string, unknown>): PersonalAiConversation {
    return { id: String(row.id), title: String(row.title), status: row.status === 'running' || row.status === 'failed' ? row.status : 'idle', createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  private toTask(row: Record<string, unknown>): PersonalAiTask {
    return { id: String(row.id), conversationId: row.conversation_id ? String(row.conversation_id) : null, kind: 'chat', status: row.status === 'running' || row.status === 'failed' ? row.status : 'complete', error: row.error ? String(row.error) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  private loadCredentials(session: UserSession): { baseUrl: string; model: string; apiKey: string } {
    const row = this.storage.get<StoredConfig>('SELECT base_url, model, api_key_encrypted FROM user_ai_config WHERE user_key = ?', [userKey(session)])
    const baseUrl = row?.base_url ? safeBaseUrl(row.base_url) : ''
    const apiKey = decryptSecret(row?.api_key_encrypted)
    if (!baseUrl || !row?.model || !apiKey) throw new Error('请先配置 API URL、模型和密钥。')
    return { baseUrl, model: row.model, apiKey }
  }

  private async complete(
    config: { baseUrl: string; model: string; apiKey: string },
    messages: Array<Record<string, unknown>>,
    tools?: typeof AGENT_TOOLS
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; rawToolCalls: unknown }> {
    let response: Response
    try {
      response = await fetch(completionUrl(config.baseUrl), {
      method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, ...(tools ? { tools } : {}), temperature: 0.2 }), signal: AbortSignal.timeout(60_000), redirect: 'error'
      })
    } catch {
      throw new Error('无法连接模型服务。请确认 API URL（通常需要填写 https://域名 或 https://域名/v1）、服务状态和网络连接。')
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`AI 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
    }
    let body: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> }
    try { body = await response.json() as typeof body } catch { throw new Error('模型服务返回的不是有效 JSON。请检查 API URL 是否指向兼容接口。') }
    const message = body.choices?.[0]?.message
    const content = typeof message?.content === 'string' ? message.content.trim() : ''
    const rawToolCalls = Array.isArray(message?.tool_calls) ? message?.tool_calls : []
    const toolCalls = rawToolCalls.flatMap((entry) => {
      const call = entry as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
      if (call.type !== 'function' || !call.id || typeof call.function?.name !== 'string') return []
      return [{ id: String(call.id), name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}' }]
    })
    if (!content && !toolCalls.length) throw new Error('模型未返回有效内容。请确认模型名称有效且服务支持 Chat Completions。')
    return { content, toolCalls, rawToolCalls }
  }
}
