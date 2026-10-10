import { safeStorage } from 'electron'
import type { AgentMessage, AgentPageContext, AgentRun, AgentRunStatus, AgentSession, AgentToolTrace, AiProviderConfig, Repository } from '@shared/types'
import type { StorageService } from './storage'
import type { SettingsService } from './settings'
import type { RepositoryService } from './repository'
import type { GitLabService, GitLabCommitDto, GitLabUserDto } from './gitlab'
import type { BranchService } from './branch'
import { newId, nowIso } from '../utils/ids'
import { executeAgentGitCommand } from './agentCommand'

const PLAIN_PREFIX = 'plain:'
const SYSTEM_PROMPT = `你是 GitManager 内置的 GitLab 数据分析 Agent。
允许业务查询和受控 Git 查询命令，不允许删除分支或破坏性操作，不允许通用 Shell、SQL。execute_git_command 只支持本地仓库，使用参数数组，不接受命令字符串。
所有实时事实必须通过只读工具获取，不得伪造用户、Commit、SHA、时间或统计。权限与 repository scope 由 Harness 决定；不得扩大范围。多仓库结果必须按 repository_id 隔离。
代码量展示 commits、additions、deletions、net_lines、files_changed，并说明 Merge Commit 默认计入、按仓库+SHA 去重。时间范围应明确；聚合优先使用统计工具，只有用户明确要求才读取 Diff。
查询用户必须先调用 search_users，再将真实 ID 用于 author_ids。用户接口不可用时可使用明确标注的提交作者元数据身份，其 author_ids 使用返回的 username，不能使用占位 ID 0。complete=false 或 truncated=true 时不得声称已获取总数或完整 SHA 列表；说明 coverage 中的缺失原因。未指定分支时 GitLab 查询所有分支。
连续追问继承会话上下文。先给结论，再说明范围与数据来源；不要返回原始 JSON。`

const TOOL_NAMES = ['search_users', 'list_repositories', 'list_branches', 'get_branch_detail', 'get_commits', 'get_commit_detail', 'get_commit_diff', 'get_contribution_statistics', 'execute_git_command'] as const
type ToolName = typeof TOOL_NAMES[number]
const stringField = { type: 'string' }
const stringArrayField = { type: 'array', items: { type: 'string' } }
const commonProps = { repository_ids: stringArrayField }
const schemas: Record<ToolName, Record<string, unknown>> = {
  execute_git_command: { type: 'object', properties: { ...commonProps, args: stringArrayField }, required: ['args'], additionalProperties: false },
  search_users: { type: 'object', properties: { ...commonProps, keyword: stringField }, required: ['keyword'], additionalProperties: false },
  list_repositories: { type: 'object', properties: { keyword: stringField, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  list_branches: { type: 'object', properties: { ...commonProps, keyword: stringField, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  get_branch_detail: { type: 'object', properties: { ...commonProps, branch: stringField }, required: ['branch'], additionalProperties: false },
  get_commits: { type: 'object', properties: { ...commonProps, branch: stringField, start_time: stringField, end_time: stringField, author_ids: stringArrayField, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  get_commit_detail: { type: 'object', properties: { ...commonProps, commit_sha: stringField }, required: ['commit_sha'], additionalProperties: false },
  get_commit_diff: { type: 'object', properties: { ...commonProps, commit_sha: stringField, include_diff: { type: 'boolean' } }, required: ['commit_sha'], additionalProperties: false },
  get_contribution_statistics: { type: 'object', properties: { ...commonProps, branch: stringField, start_time: stringField, end_time: stringField, author_ids: stringArrayField, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false }
}

export const AGENT_TOOL_REGISTRY = TOOL_NAMES.map((name) => ({ name, capability: 'READ' as const, scopeType: 'repository', maxResultSize: name === 'get_commit_diff' ? 24000 : 16000, schema: schemas[name] }))

export function isDisallowedAgentIntent(text: string): boolean {
  return /(?:删除|刪除).*(?:分支|仓库|Commit|Tag|报告)|修改(?:分支|仓库|配置|计划)|发送邮件|发邮件|运行脚本|执行脚本|delete\s+(?:branch|repository)|modify\s+branch|send\s+(?:an?\s+)?email|\bsql\b|arbitrary\s+http|http\s+(?:post|put|patch|delete)|git\s+branch\s+.*(?:-[dD]|--delete)|git\s+push\s+.*(?:--delete|\s:[^\s]+)/i.test(text)
}

interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; name?: string; tool_calls?: ToolCall[] }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ModelResponse { choices?: Array<{ message?: { role?: 'assistant'; content?: string | null; tool_calls?: ToolCall[] } }> }

export class AgentService {
  private readonly cancelledRuns = new Set<string>()
  constructor(
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly repositories: RepositoryService,
    private readonly gitlab: GitLabService,
    private readonly branches: BranchService
  ) {}

  private config(): AiProviderConfig & { apiKey: string } {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM ai_provider_config WHERE id = 1')
    const encrypted = String(row?.api_key_encrypted ?? '')
    return {
      providerType: 'openai-compatible',
      baseUrl: String(row?.base_url ?? ''), model: String(row?.model ?? ''),
      apiMode: (String(row?.api_mode ?? 'chat-completions') as AiProviderConfig['apiMode']),
      temperature: Number(row?.temperature ?? 0.2), maxTokens: Number(row?.max_tokens ?? 2000),
      timeoutMs: Number(row?.timeout_ms ?? 30000), enabled: Number(row?.enabled ?? 0) === 1,
      hasApiKey: Boolean(encrypted), apiKey: decryptSecret(encrypted)
    }
  }

  getProviderConfig(): AiProviderConfig { const { apiKey: _, ...config } = this.config(); return config }

  saveProviderConfig(input: AiProviderConfig & { apiKey?: string }): AiProviderConfig {
    const current = this.config()
    const apiKey = input.apiKey?.trim() ? encryptSecret(input.apiKey.trim()) : (current.hasApiKey ? undefined : '')
    this.storage.update('ai_provider_config', {
      provider_type: 'openai-compatible', base_url: input.baseUrl.trim().replace(/\/+$/, ''),
      ...(apiKey !== undefined ? { api_key_encrypted: apiKey } : {}), model: input.model.trim(),
      api_mode: input.apiMode, temperature: Math.max(0, Math.min(2, input.temperature)),
      max_tokens: Math.max(256, Math.min(16000, input.maxTokens)), timeout_ms: Math.max(3000, Math.min(120000, input.timeoutMs)),
      enabled: input.enabled ? 1 : 0
    }, 'id = 1')
    return this.getProviderConfig()
  }

  async testProvider(input?: AiProviderConfig & { apiKey?: string }): Promise<{ ok: boolean; message: string }> {
    const saved = this.config(); const config = input ? { ...saved, ...input, apiKey: input.apiKey?.trim() || saved.apiKey } : saved
    if (!config.baseUrl || !config.model || !config.apiKey) return { ok: false, message: '请配置 Base URL、Model 和 API Key。' }
    try { await this.requestModel(config, [{ role: 'system', content: 'Reply with OK.' }, { role: 'user', content: 'Connection test.' }], [], []) ; return { ok: true, message: 'AI Provider 连接成功。' } }
    catch (err) { return { ok: false, message: err instanceof Error ? err.message : String(err) } }
  }

  createSession(pageContext?: AgentPageContext): AgentSession {
    const id = newId(); const now = nowIso()
    this.storage.insert('agent_sessions', { id, user_id: 'local-user', title: '新会话', page_context_json: JSON.stringify(pageContext ?? null), created_at: now, updated_at: now })
    return { id, title: '新会话', pageContext, messages: [], updatedAt: now }
  }

  listSessions(): AgentSession[] { return this.storage.all<Record<string, unknown>>('SELECT * FROM agent_sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM agent_messages WHERE session_id = agent_sessions.id) ORDER BY updated_at DESC', ['local-user']).map((row) => this.session(row)) }
  deleteSession(id: string): void {
    if (!this.getSession(id)) throw new Error('Agent 会话不存在。')
    if (this.listRuns(id).some((run) => ['created', 'context_building', 'running'].includes(run.status))) throw new Error('会话正在运行，暂不能删除。')
    for (const run of this.listRuns(id)) {
      this.storage.delete('agent_tool_audit', 'run_id = ?', [run.id])
      this.storage.delete('agent_evidence', 'run_id = ?', [run.id])
    }
    this.storage.delete('agent_runs', 'session_id = ?', [id])
    this.storage.delete('agent_messages', 'session_id = ?', [id])
    this.storage.delete('agent_sessions', 'id = ? AND user_id = ?', [id, 'local-user'])
  }
  getSession(id: string): AgentSession | null { const row = this.storage.get<Record<string, unknown>>('SELECT * FROM agent_sessions WHERE id = ? AND user_id = ?', [id, 'local-user']); return row ? this.session(row) : null }
  listRuns(sessionId?: string): AgentRun[] { return this.storage.all<Record<string, unknown>>(`SELECT * FROM agent_runs WHERE user_id = ?${sessionId ? ' AND session_id = ?' : ''} ORDER BY created_at DESC`, sessionId ? ['local-user', sessionId] : ['local-user']).map(mapRun) }
  getRun(id: string): AgentRun | null { const row = this.storage.get<Record<string, unknown>>('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?', [id, 'local-user']); return row ? mapRun(row) : null }
  cancelRun(id: string): AgentRun | null {
    const current = this.getRun(id)
    if (!current || current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return current
    this.cancelledRuns.add(id)
    const now = nowIso()
    this.storage.update('agent_runs', { status: 'cancelled', completed_at: now, updated_at: now, error_code: 'RUN_CANCELLED' }, 'id = ?', [id])
    return this.getRun(id)
  }

  async sendMessage(sessionId: string, content: string, pageContext?: AgentPageContext): Promise<AgentMessage> {
    const runId = newId()
    try { return await this.executeMessage(sessionId, content, pageContext, runId) }
    catch (error) {
      const now = nowIso()
      const cancelled = this.cancelledRuns.has(runId)
      const errorCode = cancelled ? 'RUN_CANCELLED' : error instanceof Error && /超出.*限制/.test(error.message) ? 'RUN_LIMIT_EXCEEDED' : 'RUN_FAILED'
      this.storage.update('agent_runs', { status: cancelled ? 'cancelled' : 'failed', error_code: errorCode, completed_at: now, updated_at: now }, 'id = ?', [runId])
      throw error
    }
  }

  private async executeMessage(sessionId: string, content: string, pageContext: AgentPageContext | undefined, runId: string): Promise<AgentMessage> {
    const session = this.getSession(sessionId); if (!session) throw new Error('Agent 会话不存在。')
    const requestedScope = pageContext?.repositoryIds ?? session.pageContext?.repositoryIds
    const scope = [...new Set((requestedScope !== undefined ? requestedScope : this.settings.get().selectedRepositoryIds).filter(Boolean))]
    const runCreatedAt = nowIso()
    this.storage.insert('agent_runs', { id: runId, session_id: sessionId, user_id: 'local-user', status: 'created', scope_json: JSON.stringify(scope), created_at: runCreatedAt, updated_at: runCreatedAt })
    this.storage.insert('agent_messages', { id: newId(), session_id: sessionId, role: 'user', content, tool_traces_json: '[]', created_at: runCreatedAt })
    this.storage.update('agent_sessions', { page_context_json: JSON.stringify(pageContext ?? session.pageContext ?? null), updated_at: runCreatedAt, title: session.messages.length ? session.title : content.slice(0, 40) }, 'id = ?', [sessionId])
    if (isDisallowedAgentIntent(content)) throw new Error('请求涉及 Agent 不支持的写入或执行操作；未调用任何数据工具。')
    this.updateRun(runId, 'context_building')
    const messages: ChatMessage[] = [{ role: 'system', content: `${SYSTEM_PROMPT}\n当前 repositoryIds 范围：${JSON.stringify(scope)}\n当前页面上下文：${JSON.stringify(pageContext ?? session.pageContext ?? {})}` }]
    for (const item of session.messages) messages.push({ role: item.role, content: item.content })
    messages.push({ role: 'user', content })
    const traces: AgentToolTrace[] = []
    const resolvedUsers = new Map<string, GitLabUserDto[]>()
    let answer = ''
    this.updateRun(runId, 'running')
    let response = await this.requestModel(this.config(), messages, scope)
    let toolCalls = 0
    for (let round = 0; round < 6; round += 1) {
      const modelMessage = response.choices?.[0]?.message
      if (!modelMessage) throw new Error('AI Provider 返回了无效响应。')
      if (!modelMessage.tool_calls?.length) { answer = modelMessage.content ?? '没有足够数据支持该结论。'; break }
      if (round === 5 || toolCalls + modelMessage.tool_calls.length > 12) throw new Error('Agent Run 超出调用次数或链路深度限制。')
      messages.push({ role: 'assistant', content: modelMessage.content ?? '', tool_calls: modelMessage.tool_calls })
      for (const call of modelMessage.tool_calls) {
        if (this.cancelledRuns.has(runId)) throw new Error('Agent Run 已取消。')
        toolCalls += 1
        if (toolCalls > 12 || Date.now() - new Date(runCreatedAt).getTime() > 120000) throw new Error('Agent Run 超出调用次数或运行时长限制。')
        const started = Date.now(); const trace: AgentToolTrace = { id: call.id, toolName: call.function.name, status: 'running', arguments: parseObject(call.function.arguments), createdAt: nowIso() }; traces.push(trace)
        try { const rawResult = await this.runTool(call.function.name, trace.arguments, scope, resolvedUsers); const result = truncateResult(rawResult, AGENT_TOOL_REGISTRY.find((tool) => tool.name === call.function.name)?.maxResultSize ?? 16000); trace.status = 'success'; trace.durationMs = Date.now() - started; trace.resultSummary = summarize(result); this.recordToolAudit(runId, trace); messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) }) }
        catch (err) { trace.status = 'failed'; trace.durationMs = Date.now() - started; this.recordToolAudit(runId, trace); messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }) }
      }
      response = await this.requestModel(this.config(), messages, scope)
    }
    if (!answer) throw new Error('Agent Run 超出链路深度限制。')
    const message: AgentMessage = { id: newId(), role: 'assistant', content: answer, toolTraces: traces, createdAt: nowIso() }
    this.storage.insert('agent_messages', { id: message.id, session_id: sessionId, role: 'assistant', content: answer, tool_traces_json: JSON.stringify(traces), created_at: message.createdAt })
    this.storage.update('agent_sessions', { page_context_json: JSON.stringify(pageContext ?? session.pageContext ?? null), updated_at: message.createdAt, title: session.messages.length ? session.title : content.slice(0, 40) }, 'id = ?', [sessionId])
    this.storage.update('agent_runs', { status: 'completed', final_answer: answer, completed_at: message.createdAt, updated_at: message.createdAt }, 'id = ?', [runId])
    return message
  }

  private updateRun(id: string, status: AgentRunStatus): void { this.storage.update('agent_runs', { status, ...(status === 'running' ? { started_at: nowIso() } : {}), updated_at: nowIso() }, 'id = ?', [id]) }
  private recordToolAudit(runId: string, trace: AgentToolTrace): void {
    const safeArgs = Object.fromEntries(Object.entries(trace.arguments).filter(([key]) => !/token|key|password|email/i.test(key)).slice(0, 12))
    const result = trace.resultSummary ?? {}
    this.storage.insert('agent_tool_audit', { id: newId(), run_id: runId, tool_name: trace.toolName.slice(0, 80), arguments_summary: JSON.stringify(safeArgs).slice(0, 1000), scope_json: JSON.stringify(this.getRun(runId)?.scope ?? []), status: trace.status, duration_ms: trace.durationMs ?? 0, result_summary: JSON.stringify(result).slice(0, 1000), created_at: nowIso() })
    const addEvidence = (repositoryId: unknown, sha: unknown, reference: string, statistic?: Record<string, number | string | null>): void => {
      this.storage.insert('agent_evidence', { id: newId(), run_id: runId, repository_id: repositoryId ? String(repositoryId) : null, commit_sha: sha ? String(sha) : null, source: trace.toolName === 'list_repositories' || trace.toolName === 'list_branches' || trace.toolName === 'get_branch_detail' ? 'gitmanager-db' : 'gitlab', reference: reference.slice(0, 300), statistic_json: statistic ? JSON.stringify(statistic) : null, created_at: nowIso() })
    }
    const data = (result.data ?? result) as Record<string, unknown>
    const entries = Array.isArray(data) ? data : Array.isArray(data.commits) ? data.commits as unknown[] : Array.isArray(data.repositories) ? data.repositories as unknown[] : [data]
    for (const item of entries.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      addEvidence(row.repository_id, row.sha, String(row.web_url ?? row.commit_sha ?? row.sha ?? trace.toolName), {
        commit_count: typeof row.commit_count === 'number' ? row.commit_count : null,
        additions: typeof row.additions === 'number' ? row.additions : null,
        deletions: typeof row.deletions === 'number' ? row.deletions : null,
        files_changed: typeof row.files_changed === 'number' ? row.files_changed : null
      })
    }
  }

  private session(row: Record<string, unknown>): AgentSession {
    let context: AgentPageContext | undefined; try { context = JSON.parse(String(row.page_context_json ?? 'null')) ?? undefined } catch { context = undefined }
    const messages = this.storage.all<Record<string, unknown>>('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC', [String(row.id)]).map((item) => { let traces: AgentToolTrace[] = []; try { traces = JSON.parse(String(item.tool_traces_json ?? '[]')) } catch { /* empty */ } return { id: String(item.id), role: item.role as AgentMessage['role'], content: String(item.content), toolTraces: traces, createdAt: String(item.created_at) } })
    return { id: String(row.id), title: String(row.title), pageContext: context, messages, updatedAt: String(row.updated_at) }
  }

  private async requestModel(config: ReturnType<AgentService['config']>, messages: ChatMessage[], _scope: string[], tools = toolDefinitions()): Promise<ModelResponse> {
    if (!config.enabled || !config.baseUrl || !config.model || !config.apiKey) throw new Error('请先在设置中启用并配置 AI Agent。')
    const endpoint = config.apiMode === 'responses' ? `${config.baseUrl}/responses` : `${config.baseUrl}/chat/completions`
    const body = config.apiMode === 'responses'
      ? { model: config.model, input: messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'tool' ? 'user' : message.role, content: message.content })), instructions: messages.find((message) => message.role === 'system')?.content, ...(tools.length ? { tools: tools.map((tool) => { const fn = tool.function as Record<string, unknown>; return { type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters } }) } : {}), temperature: config.temperature, max_output_tokens: config.maxTokens }
      : { model: config.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), temperature: config.temperature, max_tokens: config.maxTokens }
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(config.timeoutMs), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`AI Provider 请求失败：HTTP ${response.status}`)
    const payload = await response.json() as Record<string, unknown>
    if (config.apiMode !== 'responses') return payload as ModelResponse
    const output = Array.isArray(payload.output) ? payload.output as Array<Record<string, unknown>> : []
    const text = output.flatMap((item) => Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []).map((item) => String(item.text ?? '')).join('')
    const toolCalls: ToolCall[] = output.filter((item) => item.type === 'function_call').map((item) => ({ id: String(item.call_id ?? item.id), type: 'function', function: { name: String(item.name), arguments: String(item.arguments ?? '{}') } }))
    return { choices: [{ message: { role: 'assistant', content: text || String(payload.output_text ?? ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] }
  }

  private async runTool(name: string, args: Record<string, unknown>, scope: string[], resolvedUsers = new Map<string, GitLabUserDto[]>()): Promise<unknown> {
    if (!TOOL_NAMES.includes(name as ToolName)) throw new Error('该操作不受支持。Agent 仅支持只读查询和报告。')
    if (Object.keys(args).some((key) => /^(user_?id|permissions?|is_?admin|admin|scope)$/i.test(key))) throw new Error('工具参数包含受保护的控制字段。')
    const definition = AGENT_TOOL_REGISTRY.find((tool) => tool.name === name)!
    if (!validateSchema(args, definition.schema)) throw new Error(`工具 ${name} 的参数不符合 Schema。`)
    const ids = (Array.isArray(args.repository_ids) ? args.repository_ids.map(String) : scope).filter((id) => scope.includes(id))
    let remainingDiffBudget = 24000
    if (name === 'list_repositories') return this.repositories.list().filter((repo) => scope.includes(repo.id)).filter((repo) => !args.keyword || repo.name.toLowerCase().includes(String(args.keyword).toLowerCase())).slice(0, Number(args.limit ?? 50))
    const repos = this.repositories.list().filter((repo) => ids.includes(repo.id))
    if (name === 'execute_git_command') {
      const results = await Promise.all(repos.map(async (repo) => {
        try { return { repository_id: repo.id, repository: repo.name, ...await executeAgentGitCommand(repo, args.args as string[]) } }
        catch (error) { return { repository_id: repo.id, repository: repo.name, error: error instanceof Error ? error.message : String(error) } }
      }))
      return { command: args.args, results, complete: results.every((result) => !('error' in result)) }
    }
    if (name === 'list_branches') return this.branches.listBranches(ids).filter((item) => !args.keyword || item.name.toLowerCase().includes(String(args.keyword).toLowerCase())).slice(0, Number(args.limit ?? 200)).map((item) => ({ repository_id: item.repositoryId, repository: item.repositoryName, branch: item.name, state: item.state, last_commit_at: item.lastCommitAt, last_commit_sha: item.lastCommitSha }))
    if (name === 'search_users') {
      const users: Array<Omit<GitLabUserDto, 'id'> & { id?: number; repository_id: string; identity_source?: string }> = []
      const unavailable: Array<{ repository_id: string; reason: string }> = []
      for (const repo of repos) {
        if (!this.canQuery(repo)) { unavailable.push({ repository_id: repo.id, reason: '没有可用的远程 API 数据源。' }); continue }
        try {
          const found = await this.gitlab.listUsers(String(args.keyword), this.connection(repo))
          const previous = resolvedUsers.get(repo.id) ?? []
          resolvedUsers.set(repo.id, [...new Map([...previous, ...found].map((user) => [user.id, user])).values()])
          users.push(...found.map((user) => ({ ...user, repository_id: repo.id })))
        } catch (error) {
          const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined
          // Some GitLab installations restrict /users while still allowing
          // project commit reads. Infer an author identity from commit metadata
          // without claiming it is a verified GitLab account.
          try {
            const keyword = String(args.keyword).trim().toLowerCase()
            const commits = await this.gitlab.listCommits(repo.gitlabProjectId!, '', 1, 100, this.connection(repo))
            const matches = commits.filter((commit) => [commit.author_name, commit.author_email, commit.author_login].some((value) => String(value ?? '').toLowerCase().includes(keyword)))
            const inferred = [...new Map(matches.map((commit) => [`${commit.author_email}:${commit.author_name}`, { id: 0, username: commit.author_login || commit.author_email || commit.author_name, name: commit.author_name, email: commit.author_email || undefined }])).values()]
            if (inferred.length) {
              const previous = resolvedUsers.get(repo.id) ?? []
              resolvedUsers.set(repo.id, [...previous, ...inferred])
              users.push(...inferred.map(({ id: _, ...user }) => ({ ...user, repository_id: repo.id, identity_source: 'commit-author-metadata' })))
              unavailable.push({ repository_id: repo.id, reason: `用户接口不可用${status ? `（HTTP ${status}）` : ''}，已使用提交作者元数据匹配，不能视为已验证的 GitLab 用户。` })
              continue
            }
          } catch { /* preserve the original unavailable result */ }
          unavailable.push({ repository_id: repo.id, reason: `用户搜索失败${status ? `（HTTP ${status}）` : ''}，请检查该仓库的 Token、权限和平台地址；用户查询权限可能不同于提交读取权限。` })
        }
      }
      return { users, unavailable, source: 'repository remote API', complete: unavailable.length === 0 }
    }
    if (name === 'get_branch_detail') return repos.map((repo) => ({ repository_id: repo.id, repository: repo.name, branch: this.branches.getBranch({ repositoryId: repo.id, name: String(args.branch), type: 'remote' }, [repo.id]) }))
    if (name === 'get_commits' || name === 'get_contribution_statistics') {
      const rows: Array<Record<string, unknown>> = []
      const coverage: Array<Record<string, unknown>> = []
      for (const repo of repos) {
        if (!this.canQuery(repo)) { coverage.push({ repository_id: repo.id, complete: false, reason: '没有可用的远程 API 数据源。' }); continue }
        const config = this.connection(repo)
        const authorIds = Array.isArray(args.author_ids) ? args.author_ids.map(String) : []
const identities = authorIds.map((id) => (resolvedUsers.get(repo.id) ?? []).find((user) => (user.id > 0 && String(user.id) === id) || user.username === id || user.email === id))
        if (identities.some((user) => !user)) { coverage.push({ repository_id: repo.id, complete: false, reason: '请先通过 search_users 在该仓库连接中解析 author_ids，不能将数字 ID 直接与提交作者姓名比较。' }); continue }
        const commits: GitLabCommitDto[] = []
        let complete = false
        let queryFailed = false
        for (let page = 1; page <= 50; page += 1) {
          try {
            const batch = await this.gitlab.listCommits(repo.gitlabProjectId!, String(args.branch ?? (repo.source === 'gitlab' ? '' : repo.defaultBranch)), page, 100, config)
            commits.push(...batch)
            if (batch.length < 100) { complete = true; break }
          } catch { queryFailed = true; break }
        }
        coverage.push({ repository_id: repo.id, complete, branch: args.branch ?? (repo.source === 'gitlab' ? 'all branches' : repo.defaultBranch), scanned_commit_count: commits.length, ...(queryFailed ? { reason: '提交 API 请求失败，结果不完整。' } : !complete ? { reason: '达到 5000 条扫描上限，不能视为总数。' } : {}) })
        const filtered = commits.filter((commit) => inRange(commit, args.start_time, args.end_time) && (!identities.length || identities.some((user) => user && authorMatchesUser(commit, user))))
        for (const commit of filtered) {
          const detail: Record<string, unknown> = name === 'get_contribution_statistics' ? await this.gitlab.getCommit(repo.gitlabProjectId!, commit.id, config).catch(() => ({} as Record<string, unknown>)) : {}
          const stats = detail.stats as Record<string, unknown> | undefined
          const parents = Array.isArray(detail.parent_ids) ? detail.parent_ids : []
          rows.push({ repository_id: repo.id, repository: repo.name, sha: commit.id, author: commit.author_name, author_id: commit.author_login, committed_at: commit.committed_date, subject: commit.title, is_merge: parents.length > 1, additions: numeric(stats?.additions), deletions: numeric(stats?.deletions), files_changed: numeric(stats?.files_changed) })
        }
      }
      const unique = [...new Map(rows.map((row) => [`${row.repository_id}:${row.sha}`, row])).values()]
      if (name === 'get_commits') {
        const limit = Number(args.limit ?? 500)
        return { commits: unique.slice(0, limit), commit_count: unique.length, complete: coverage.every((item) => item.complete === true), truncated: unique.length > limit, coverage, author_matching: 'Git 作者元数据与已解析用户的公开邮箱、用户名或姓名匹配；GitLab 提交不提供可靠的用户 ID 归属。', deduplication: 'repository_id + commit SHA', merge_commits_included: true }
      }
      const haveStats = unique.filter((row) => typeof row.additions === 'number' && typeof row.deletions === 'number')
      const fileStats = unique.filter((row) => typeof row.files_changed === 'number')
      return { coverage, complete: coverage.every((item) => item.complete === true), repositories: repos.map((repo) => ({ repository_id: repo.id, repository: repo.name })), commit_count: unique.length, additions: haveStats.length === unique.length ? haveStats.reduce((sum, row) => sum + Number(row.additions), 0) : null, deletions: haveStats.length === unique.length ? haveStats.reduce((sum, row) => sum + Number(row.deletions), 0) : null, net_lines: haveStats.length === unique.length ? haveStats.reduce((sum, row) => sum + Number(row.additions) - Number(row.deletions), 0) : null, files_changed: fileStats.length === unique.length ? fileStats.reduce((sum, row) => sum + Number(row.files_changed), 0) : null, unavailable_commit_count: unique.length - haveStats.length, merge_commits_included: true, deduplication: 'repository_id + commit SHA', commits: unique }
    }
    if (name === 'get_commit_detail' || name === 'get_commit_diff') {
      const output: unknown[] = []
      for (const repo of repos) {
        if (!this.canQuery(repo)) continue
        const config = this.connection(repo); const sha = String(args.commit_sha)
        const availableCommits = await this.gitlab.listCommits(repo.gitlabProjectId!, String(args.branch ?? repo.defaultBranch), 1, 500, config).catch(() => [])
        if (!availableCommits.some((commit) => commit.id === sha)) continue
        if (name === 'get_commit_detail') output.push({ repository_id: repo.id, repository: repo.name, commit: await this.gitlab.getCommit(repo.gitlabProjectId!, sha, config) })
        else {
          const files = await this.gitlab.getCommitDiff(repo.gitlabProjectId!, sha, config)
          output.push({ repository_id: repo.id, repository: repo.name, files: files.slice(0, 200).map((file) => { const diff = String(file.diff ?? ''); const included = args.include_diff === true ? diff.slice(0, Math.max(0, remainingDiffBudget)) : ''; remainingDiffBudget -= included.length; return { old_path: file.old_path, new_path: file.new_path, additions: (diff.match(/^\+(?!\+)/gm) ?? []).length, deletions: (diff.match(/^-(?!--)/gm) ?? []).length, ...(args.include_diff === true ? { diff: included } : {}) } }) })
        }
      }
      return output
    }
    throw new Error('该操作不受支持。')
  }

  private canQuery(repo: Repository): boolean { return repo.source !== 'local' && repo.gitlabProjectId != null }
  private connection(repo: Repository) { return { url: repo.gitlabUrl, projectPath: repo.remoteProjectPath, provider: repo.source as Exclude<Repository['source'], 'local'>, apiKey: this.repositories.getRemoteToken(repo.id) || this.settings.getGitLabToken() } as const }
}

function inRange(commit: GitLabCommitDto, start: unknown, end: unknown): boolean { const time = new Date(commit.committed_date || commit.authored_date || commit.created_at).getTime(); return (!start || time >= new Date(String(start)).getTime()) && (!end || time <= new Date(String(end)).getTime()) }
function parseObject(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} } }
function summarize(value: unknown): Record<string, unknown> { if (Array.isArray(value)) return { count: value.length }; if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'diff' && key !== 'content').slice(0, 12)); return { value } }
function toolDefinitions(): Array<Record<string, unknown>> { return AGENT_TOOL_REGISTRY.map((tool) => ({ type: 'function', function: { name: tool.name, description: `Read-only GitManager data query: ${tool.name}`, parameters: tool.schema } })) }
function validateSchema(value: Record<string, unknown>, schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const required = schema.required as string[] | undefined
  if (!properties || Object.keys(value).some((key) => !(key in properties))) return false
  if (required?.some((key) => value[key] === undefined)) return false
  for (const [key, item] of Object.entries(value)) {
    const rule = properties[key]
    if (rule.type === 'string' && typeof item !== 'string') return false
    if (rule.type === 'boolean' && typeof item !== 'boolean') return false
    if (rule.type === 'integer' && (!Number.isInteger(item) || Number(item) < Number(rule.minimum) || Number(item) > Number(rule.maximum))) return false
    if (rule.type === 'array' && (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))) return false
  }
  return true
}
function truncateResult(value: unknown, maxCharacters: number): unknown {
  const serialized = JSON.stringify(value)
  if (serialized.length <= maxCharacters) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.commits)) {
      const output = { ...record, commits: record.commits.map((entry) => { const row = entry as Record<string, unknown>; return { repository_id: row.repository_id, sha: row.sha } }), truncated: true }
      while (output.commits.length && JSON.stringify(output).length > maxCharacters) output.commits.pop()
      if (JSON.stringify(output).length <= maxCharacters) return output
    }
  }
  return { truncated: true, preview: serialized.slice(0, Math.max(0, maxCharacters - 40)) }
}
function numeric(value: unknown): number | null { const result = Number(value); return value == null || !Number.isFinite(result) ? null : result }
function authorMatchesUser(commit: GitLabCommitDto, user: GitLabUserDto): boolean {
  const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase()
  if (user.email && commit.author_email) return normalize(user.email) === normalize(commit.author_email)
  return (Boolean(commit.author_login) && normalize(commit.author_login) === normalize(user.username)) || [user.username, user.name].some((name) => Boolean(name) && normalize(name) === normalize(commit.author_name))
}
function mapRun(row: Record<string, unknown>): AgentRun { let scope: string[] = []; try { scope = JSON.parse(String(row.scope_json ?? '[]')) } catch { scope = [] } return { id: String(row.id), sessionId: String(row.session_id), status: row.status as AgentRunStatus, scope, startedAt: row.started_at ? String(row.started_at) : undefined, completedAt: row.completed_at ? String(row.completed_at) : undefined, errorCode: row.error_code ? String(row.error_code) : undefined, finalAnswer: row.final_answer ? String(row.final_answer) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) } }
function encryptSecret(value: string): string { return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : PLAIN_PREFIX + Buffer.from(value).toString('base64') }
function decryptSecret(value: string): string { if (!value) return ''; if (value.startsWith(PLAIN_PREFIX)) return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString(); try { return safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { return '' } }
