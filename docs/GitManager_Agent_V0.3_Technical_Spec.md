# GitManager Agent V0.3 技术规格

> 版本：V0.3
> 定位：GitManager 内置的 GitLab 数据查询、分析与报告生成 Agent
> 核心原则：Tool-first、**绝对只读**、权限继承、可追溯、页面上下文感知

> **🔴 红线安全标准（最高优先级，必须长期保持）**
> GitManager Agent **只能读取数据和产出报告，不具备任何删除权限**。
> Agent 从架构、Tool Registry、API、Service、权限模型到运行时均**不得提供、注册、暴露或转发任何删除能力**，包括但不限于删除 Repository、删除 Branch、删除 Commit、删除 Tag、删除报告、删除配置、批量删除或调用可间接触发删除的接口。
> Agent 同时不具备修改 GitLab 业务数据、修改 Branch、修改 Repository、修改系统配置、修改 Monitoring/Schedule、发送通知等写操作权限。
> “产出报告”仅指生成/展示报告内容或统计结果，不代表 Agent 获得业务数据写入、修改或删除权限。
> 任何未来版本也不得通过 Agent 放开删除能力；如业务系统本身存在删除功能，仍必须沿用 GitManager 原有的人工确认和业务权限链路，Agent 不得参与授权或代执行。

---

## 1. 版本目标

V0.3 的目标不是做一个通用聊天机器人，而是在现有 GitLab 分支管理应用中增加一个**业务 Agent 层**，让用户使用自然语言查询现有系统与 GitLab 中的数据。

### 1.1 V0.3 必须支持

- 配置 OpenAI-compatible AI API：Base URL、API Key、Model、API 模式等。
- Agent Chat：支持多轮连续对话。
- Agent Tool Calling：由模型选择并调用 GitManager 提供的业务工具。
- 查询 Repository、User、Branch、Commit、Commit Diff、贡献统计。
- 支持自然语言时间范围解析。
- 支持当前页面上下文，包括当前仓库、分支、筛选条件等。
- 多仓库查询必须保持 Repository 隔离，不能把同名 Branch 当成同一 Branch。
- Agent 查询必须继承当前登录用户的业务权限。
- 展示 Agent 的工具调用过程摘要，便于验证答案来源。
- V0.3 **绝对只读**：只允许读取业务数据、分析数据和生成报告；Agent 不具备任何删除或修改业务数据的权限。

### 1.2 V0.3 非目标

- 不做自主删除分支。
- 不做自动发送邮件。
- 不做自动修改 Schedule/Monitoring 配置。
- 不做无限制 SQL Agent。
- 不把全部 Commit/Diff 当作向量知识库。

---

# 1A. Agent 红线安全标准（必须写入产品与开发规范）

本节优先级高于本文其他所有 Agent 功能定义。发生冲突时，以本节为准。

## 1A.1 能力范围

```text
Agent
 ├── 读取 ✅
 └── 产出报告 ✅

Agent
 ├── 删除 ❌ 永久禁止
 ├── 修改 ❌
 ├── 写入 GitLab 业务数据 ❌
 ├── 修改配置 ❌
 ├── 执行命令 ❌
 └── 发起不可控副作用操作 ❌
```

## 1A.2 架构约束

Agent Runtime 只能连接到：

```text
Read-only Business Services
       +
Report Generation Service
       +
Knowledge Retriever
       +
LLM Gateway
```

不得连接到：

```text
Delete Service
Mutation Service
Admin Write API
Shell Executor
Arbitrary SQL Executor
```

## 1A.3 安全原则

> **“没有 Tool ≠ 权限关闭；在 Agent 架构中，删除能力必须根本不存在。”**

因此设计、代码评审、测试、打包发布和后续迭代均必须检查：

- Agent Tool Registry 中不存在删除能力。
- Agent 专用接口不存在删除 endpoint。
- Agent Service 不持有执行删除操作所需的业务凭据。
- LLM 即使生成删除意图，也只能得到“该操作不受支持”的结果，不得进入执行阶段。
- 所有 Agent 相关自动化测试必须包含删除隔离测试。

## 1A.4 产品文案

Agent 页面应明确展示：

```text
AI Agent
只读查询 · 数据分析 · 报告生成
Agent 不具备任何删除权限
```

---

# 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         GitManager UI                         │
│                                                              │
│ Repository / Branch / Reports / Monitoring / Audit / Agent  │
└──────────────────────────────┬───────────────────────────────┘
                               │ Chat + Page Context
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                       Agent Runtime                           │
│                                                              │
│  Session Manager → Context Builder → LLM Gateway              │
│                                      │                       │
│                              Tool Orchestrator                │
└────────────────────────────────┬─────────────────────────────┘
                                 │
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                   ▼
      ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
      │ Knowledge KB │    │ GitManager    │    │ Permission   │
      │              │    │ Tool Layer    │    │ Service      │
      │ app rules    │    │              │    │              │
      │ data schema  │    │ user/repo/   │    │ user scope   │
      │ terminology  │    │ branch/      │    │ repo access  │
      └──────────────┘    │ commit/...   │    └──────────────┘
                          └──────┬───────┘
                                 │
                   ┌─────────────┼─────────────┐
                   ▼             ▼             ▼
               App DB        GitLab API     Local Git
```

### 2.1 数据职责划分

| 数据类型 | 来源 | Agent 获取方式 |
|---|---|---|
| GitManager 业务规则 | Knowledge Base | RAG / 文档检索 |
| Repository 元数据 | App DB / GitLab | Tool |
| User 信息 | App DB / GitLab | Tool |
| Branch 状态 | GitLab / App cache | Tool |
| Commit | GitLab API / Git | Tool |
| Commit Diff | GitLab API / Git | Tool |
| 贡献统计 | Tool 聚合 | Tool + Agent 解释 |
| 当前页面选择 | 前端上下文 | Session Context |
| 权限 | 现有权限系统 | Permission Service |

**原则：实时业务事实走 Tool，静态规则走 Knowledge Base。**

---

# 3. Agent Runtime

## 3.1 核心组件

### Agent Session Manager

负责：

- 创建/恢复会话。
- 保存用户消息与 Agent 消息。
- 保存当前查询 Scope。
- 保存 Tool Call 摘要。
- 控制上下文长度。

### Context Builder

将以下信息合并到一次模型请求中：

```json
{
  "user": {
    "id": "current-user",
    "display_name": "当前用户"
  },
  "page_context": {
    "page": "branches",
    "repository_ids": ["repo-a", "repo-b"],
    "branch": "feature/print",
    "filters": {}
  },
  "permissions": {
    "repository_ids": ["repo-a", "repo-b"]
  },
  "conversation": [],
  "knowledge_context": []
}
```

### LLM Gateway

统一封装 AI Provider：

```text
OpenAI-compatible / Responses / Chat Completions
                 ↓
             LLM Gateway
                 ↓
       Provider Adapter Interface
```

推荐接口：

```ts
interface LlmProvider {
  chat(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
  validateConnection(): Promise<ConnectionTestResult>;
}
```

### Tool Orchestrator

负责：

1. 校验模型返回的 Tool Name。
2. 校验参数 schema。
3. 注入当前用户权限。
4. 调用对应业务 Service。
5. 裁剪 Tool 返回内容。
6. 将结果回传给 LLM。
7. 写入 Agent Tool Audit。

---

# 4. AI Provider 配置

## 4.1 配置项

```ts
interface AiProviderConfig {
  id: string;
  providerType: 'openai-compatible';
  baseUrl: string;
  apiKeyEncrypted: string;
  model: string;
  apiMode: 'responses' | 'chat-completions';
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  enabled: boolean;
}
```

## 4.2 UI 配置

建议路径：

```text
Settings
└── AI Agent
```

页面字段：

- Provider
- Base URL
- API Key
- Model
- API Mode
- Temperature
- Max Tokens
- Timeout
- Test Connection
- Save

API Key 必须服务端加密存储，前端只显示掩码，不返回明文。

---

# 5. Tool Schema

V0.3 建议先固定 8 个只读工具。

## 5.1 search_users

用途：把自然语言人名、用户名、邮箱映射到 GitLab User。

```json
{
  "name": "search_users",
  "description": "Search accessible GitLab users by display name, username or email.",
  "input_schema": {
    "type": "object",
    "properties": {
      "keyword": {"type": "string"},
      "limit": {"type": "integer", "minimum": 1, "maximum": 20}
    },
    "required": ["keyword"]
  }
}
```

返回：

```json
{
  "users": [
    {
      "id": "123",
      "username": "zhangsan",
      "display_name": "张三",
      "email_masked": "z***@example.com"
    }
  ]
}
```

---

## 5.2 list_repositories

```json
{
  "name": "list_repositories",
  "description": "List repositories accessible to the current user, optionally restricted to current scope.",
  "input_schema": {
    "type": "object",
    "properties": {
      "keyword": {"type": "string"},
      "repository_ids": {
        "type": "array",
        "items": {"type": "string"}
      },
      "limit": {"type": "integer", "minimum": 1, "maximum": 50}
    }
  }
}
```

---

## 5.3 list_branches

```json
{
  "name": "list_branches",
  "description": "List branches for one or more repositories without merging same-named branches across repositories.",
  "input_schema": {
    "type": "object",
    "properties": {
      "repository_ids": {
        "type": "array",
        "items": {"type": "string"}
      },
      "keyword": {"type": "string"},
      "stale_days": {"type": "integer", "minimum": 0},
      "limit": {"type": "integer", "minimum": 1, "maximum": 200}
    },
    "required": ["repository_ids"]
  }
}
```

---

## 5.4 get_branch_detail

```json
{
  "name": "get_branch_detail",
  "description": "Get detailed information for a specific branch.",
  "input_schema": {
    "type": "object",
    "properties": {
      "repository_id": {"type": "string"},
      "branch": {"type": "string"}
    },
    "required": ["repository_id", "branch"]
  }
}
```

返回：

```json
{
  "repository_id": "repo-a",
  "branch": "feature/print",
  "last_commit": {
    "sha": "a91f2e3...",
    "author": "张三",
    "committed_at": "2026-09-27T09:32:11Z"
  },
  "age_days": 2
}
```

---

## 5.5 get_commits

核心查询工具。

```json
{
  "name": "get_commits",
  "description": "Query commits for accessible repositories and optional branch/author/time constraints.",
  "input_schema": {
    "type": "object",
    "properties": {
      "repository_ids": {
        "type": "array",
        "items": {"type": "string"}
      },
      "branch": {"type": "string"},
      "author_ids": {
        "type": "array",
        "items": {"type": "string"}
      },
      "start_time": {"type": "string", "format": "date-time"},
      "end_time": {"type": "string", "format": "date-time"},
      "include_stats": {"type": "boolean"},
      "limit": {"type": "integer", "minimum": 1, "maximum": 500}
    },
    "required": ["start_time", "end_time"]
  }
}
```

注意：多仓库返回必须保留 `repository_id`，绝不能只返回 branch name + commit。

---

## 5.6 get_commit_detail

```json
{
  "name": "get_commit_detail",
  "description": "Get commit metadata and file statistics for a specific commit.",
  "input_schema": {
    "type": "object",
    "properties": {
      "repository_id": {"type": "string"},
      "commit_sha": {"type": "string"},
      "include_files": {"type": "boolean"}
    },
    "required": ["repository_id", "commit_sha"]
  }
}
```

---

## 5.7 get_commit_diff

```json
{
  "name": "get_commit_diff",
  "description": "Get the diff for a specific commit so the Agent can summarize actual code changes.",
  "input_schema": {
    "type": "object",
    "properties": {
      "repository_id": {"type": "string"},
      "commit_sha": {"type": "string"},
      "max_diff_chars": {"type": "integer", "minimum": 1000, "maximum": 200000}
    },
    "required": ["repository_id", "commit_sha"]
  }
}
```

Diff 超长时 Tool 层优先返回文件级统计，并允许 Agent 对单文件进一步查询；避免一次把超大 Diff 塞给模型。

---

## 5.8 get_contribution_statistics

```json
{
  "name": "get_contribution_statistics",
  "description": "Aggregate contribution statistics by user/repository/time range.",
  "input_schema": {
    "type": "object",
    "properties": {
      "repository_ids": {
        "type": "array",
        "items": {"type": "string"}
      },
      "author_ids": {
        "type": "array",
        "items": {"type": "string"}
      },
      "start_time": {"type": "string", "format": "date-time"},
      "end_time": {"type": "string", "format": "date-time"},
      "group_by": {
        "type": "string",
        "enum": ["user", "repository", "day", "branch"]
      }
    },
    "required": ["start_time", "end_time"]
  }
}
```

统一返回：

```json
{
  "commit_count": 32,
  "additions": 6240,
  "deletions": 2180,
  "net_lines": 4060,
  "files_changed": 86,
  "groups": []
}
```

---

# 6. Tool 统一执行协议

每次 Tool Call 都必须建立统一 envelope：

```json
{
  "tool_call_id": "tc_001",
  "tool_name": "get_commits",
  "request": {},
  "actor": {
    "user_id": "current-user"
  },
  "scope": {
    "repository_ids": ["repo-a"]
  },
  "result": {},
  "status": "success",
  "duration_ms": 231
}
```

Tool 层负责注入：

- 当前用户 ID
- 权限范围
- Repository Scope
- 时间范围规范化
- 最大返回量
- 脱敏策略

这样 LLM 本身无法绕过权限。

---

# 7. Knowledge Base 设计

建议目录：

```text
knowledge/
├── gitmanager-overview.md
├── repository.md
├── branch.md
├── user.md
├── commit.md
├── monitoring.md
├── reports.md
├── notifications.md
├── audit.md
├── permissions.md
└── terminology.md
```

知识库内容主要描述：

- GitManager 的业务定义。
- 字段含义。
- Repository/Branch/Commit 的关系。
- Monitoring 与 Grace Period 规则。
- Report 业务规则。
- 通知规则。
- 权限模型。
- 常见业务术语。

不要把以下内容长期作为 RAG 主数据：

- 每一条 Commit。
- 大体量 Diff。
- 每日动态 Branch 状态。
- 会持续变化的实时统计。

这些数据由 Tool 实时取得。

---

# 8. Session 与上下文模型

## 8.1 Agent Session

```ts
interface AgentSession {
  id: string;
  userId: string;
  title: string;
  pageContext?: PageContext;
  createdAt: string;
  updatedAt: string;
}
```

## 8.2 Page Context

```ts
interface PageContext {
  page: 'dashboard' | 'repositories' | 'branches' | 'reports' | 'monitoring' | 'audit';
  repositoryIds?: string[];
  branch?: string;
  filters?: Record<string, unknown>;
}
```

## 8.3 Message

```ts
interface AgentMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: string;
}
```

## 8.4 Tool Audit

```ts
interface AgentToolCall {
  id: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'success' | 'failed';
  durationMs?: number;
  createdAt: string;
}
```

---

# 9. 前端目录结构

以 React + TypeScript + Vite 为例：

```text
src/
├── app/
│   ├── router/
│   ├── providers/
│   └── store/
│
├── features/
│   ├── repositories/
│   ├── branches/
│   ├── reports/
│   ├── monitoring/
│   ├── audit/
│   └── agent/
│       ├── components/
│       │   ├── AgentPanel.tsx
│       │   ├── AgentHeader.tsx
│       │   ├── AgentMessageList.tsx
│       │   ├── AgentMessage.tsx
│       │   ├── AgentComposer.tsx
│       │   ├── ToolCallTrace.tsx
│       │   ├── CitationList.tsx
│       │   ├── DataTableCard.tsx
│       │   ├── CommitSummaryCard.tsx
│       │   └── ContributionSummaryCard.tsx
│       ├── hooks/
│       │   ├── useAgentSession.ts
│       │   ├── useAgentStream.ts
│       │   └── useAgentContext.ts
│       ├── services/
│       │   └── agentApi.ts
│       ├── types/
│       │   └── agent.ts
│       └── utils/
│           └── renderAgentResult.ts
│
├── pages/
├── components/
├── services/
│   ├── api.ts
│   └── auth.ts
└── styles/
```

### Agent UI 建议

默认采用右侧抽屉/Panel：

```text
主业务页面                         Agent
┌────────────────────────────┐   ┌───────────────────┐
│ Repository / Branch        │   │ GitManager Agent  │
│                            │   │                   │
│                            │   │ conversation     │
│                            │   │                   │
│                            │   │ tool trace        │
│                            │   │                   │
│                            │   │ ┌───────────────┐ │
│                            │   │ │ Ask Agent...  │ │
│                            │   │ └───────────────┘ │
└────────────────────────────┘   └───────────────────┘
```

---

# 10. 后端目录结构

```text
server/
├── modules/
│   ├── repository/
│   ├── branch/
│   ├── user/
│   ├── commit/
│   ├── report/
│   ├── monitoring/
│   ├── audit/
│   │
│   └── agent/
│       ├── controller/
│       │   └── AgentController
│       ├── application/
│       │   ├── AgentService
│       │   ├── AgentSessionService
│       │   ├── AgentContextService
│       │   └── AgentToolService
│       ├── domain/
│       │   ├── AgentSession
│       │   ├── AgentMessage
│       │   ├── AgentToolCall
│       │   └── AgentProviderConfig
│       ├── tools/
│       │   ├── SearchUsersTool
│       │   ├── ListRepositoriesTool
│       │   ├── ListBranchesTool
│       │   ├── GetBranchDetailTool
│       │   ├── GetCommitsTool
│       │   ├── GetCommitDetailTool
│       │   ├── GetCommitDiffTool
│       │   └── GetContributionStatisticsTool
│       ├── llm/
│       │   ├── LlmGateway
│       │   ├── OpenAICompatibleProvider
│       │   └── ToolCallParser
│       ├── knowledge/
│       │   ├── KnowledgeRetriever
│       │   └── KnowledgeIndexer
│       └── security/
│           ├── AgentPermissionGuard
│           └── SensitiveDataFilter
│
├── integrations/
│   ├── gitlab/
│   └── git/
│
├── repositories/
├── database/
└── shared/
```

---

# 11. API 设计

## 11.1 Agent Session

```http
POST /api/agent/sessions
GET  /api/agent/sessions
GET  /api/agent/sessions/:sessionId
DELETE /api/agent/sessions/:sessionId
```

创建 Session 时可以带当前页面上下文：

```json
{
  "pageContext": {
    "page": "branches",
    "repositoryIds": ["repo-a", "repo-b"],
    "branch": "feature/print"
  }
}
```

## 11.2 Chat

推荐流式接口：

```http
POST /api/agent/sessions/:sessionId/messages
Accept: text/event-stream
```

请求：

```json
{
  "content": "统计张三9月10日的提交",
  "pageContext": {
    "page": "branches",
    "repositoryIds": ["repo-a", "repo-b"]
  }
}
```

SSE 事件建议：

```text
event: message.delta
event: tool.start
event: tool.result
event: message.delta
event: message.completed
event: error
```

---

# 12. Agent 调用流程

## 12.1 典型查询：统计某人的某天提交

用户：

> 统计张三 2026 年 9 月 10 日提交了哪些代码。

流程：

```text
用户消息
   │
   ▼
Agent API
   │
   ▼
Context Builder
   │
   ├── 当前用户
   ├── 当前 Repository Scope
   ├── 当前页面
   └── 历史对话
   │
   ▼
LLM
   │
   ├── 判断需要查 User
   ▼
search_users("张三")
   │
   ▼
返回 user_id
   │
   ▼
LLM
   │
   ▼
get_commits(
  author_ids=[user_id],
  start_time="2026-09-10T00:00:00",
  end_time="2026-09-10T23:59:59"
)
   │
   ▼
Tool 返回 Commit 列表
   │
   ▼
LLM 判断是否需要 Diff
   │
   ├── 简单统计 → 直接汇总
   │
   └── “哪些代码” → get_commit_detail / get_commit_diff
   │
   ▼
结构化答案
```

---

# 13. 时间范围处理

Agent 必须把自然语言转成明确时间。

例如：

```text
“9月10日”
↓
2026-09-10 00:00:00
至
2026-09-10 23:59:59
```

```text
“上周”
↓
明确计算 start/end
↓
在回答中展示具体日期
```

时区不能依赖模型猜测，应使用系统配置中的 timezone，并在后端统一转换为 UTC 查询。

---

# 14. “代码量”的统一定义

所有贡献统计都建议统一展示：

```text
Commits
Additions
Deletions
Net Lines
Files Changed
```

计算：

```text
net_lines = additions - deletions
```

注意：代码量不等价于工作量，也不能单独用于评价开发人员贡献。

---

# 15. 权限与安全

## 15.1 Agent 权限红线

### 最高优先级安全规则

```text
Agent = READ + REPORT ONLY

READ
 ├─ Repository
 ├─ User
 ├─ Branch
 ├─ Commit
 ├─ Commit Detail
 ├─ Commit Diff
 ├─ Monitoring Result
 ├─ Audit Log
 └─ Contribution Statistics

REPORT
 └─ 基于读取结果生成/展示分析报告

DENY（永久禁止）
 ├─ Delete Repository
 ├─ Delete Branch
 ├─ Delete Commit
 ├─ Delete Tag
 ├─ Delete Report
 ├─ Delete Configuration
 ├─ Modify Repository
 ├─ Modify Branch
 ├─ Modify GitLab Data
 ├─ Modify Schedule / Monitoring
 ├─ Send Notification / Email
 └─ 任何间接触发上述操作的 Tool / API
```

这不是“默认关闭”的功能，而是 **Agent 永不拥有的权限边界**。

## 15.2 权限链

```text
Current User
    ↓
Existing GitManager Permission Service
    ↓
Agent Permission Guard
    ↓
Read-only Tool Registry
    ↓
Read-only Business Service
    ↓
GitLab/App Data
```

LLM 不允许自己决定权限。即使模型返回一个不存在或未注册的删除/修改 Tool Name，Tool Orchestrator 也必须直接拒绝。

### 三层强制拦截

1. **Tool Registry 层**：删除/修改类 Tool 根本不注册。
2. **Permission Guard 层**：仅允许 `READ` 和 `REPORT` 能力。
3. **Service/API 层**：Agent 专用 Service Account / execution context 不具备业务写权限；对删除类 endpoint 直接拒绝。

因此，即使 Agent Prompt 被注入、模型误判、Tool 参数异常，也不能产生删除行为。

## 15.3 Sensitive Data

默认避免向模型发送：

- API Key
- 密码
- GitLab Access Token
- 完整用户隐私信息
- 不必要的邮箱明文
- 用户无权限的数据

## 15.4 Tool 能力标签

所有 Agent Tool 必须声明能力等级：

```ts
type AgentCapability = 'READ' | 'REPORT';
```

V0.3 允许：

```text
READ   ✅
REPORT ✅
WRITE  ❌
DELETE ❌
```

不存在 `DELETE` Tool，也不存在可以通过参数切换成 DELETE 的通用 Tool。

## 15.5 Report 边界

“产出报告”仅表示：

```text
读取真实数据
   ↓
统计 / 分析
   ↓
生成报告内容
   ↓
在 Agent UI 中展示
```

报告生成不得获得：

- 删除权限
- 修改 GitLab 数据权限
- 修改 Branch/Repository 权限
- 修改系统配置权限
- 自动发送邮件权限

如果未来需要把报告保存到数据库，也应由 GitManager 原有 Report Service 以明确的、非破坏性的“报告产出”能力实现，而不是开放通用写权限。

---

# 16. 可追溯性

每条 Agent 答案应能够回溯到：

```text
User Message
 ↓
LLM Request
 ↓
Tool Calls
 ↓
Tool Results
 ↓
Final Answer
```

UI 中可显示：

```text
▾ 数据来源
  Repository: repo-a
  User: 张三
  Time: 2026-09-10

  Tools used:
  ✓ search_users
  ✓ get_commits
  ✓ get_commit_detail
```

不要求把完整 Tool JSON 展示给普通用户，但后台必须记录。

---

# 17. 典型对话示例

## 示例 A：单日提交

用户：

> 张三9月10日提交了多少代码？

Agent：

> 查询范围：2026-09-10，当前可访问仓库。
>
> 张三共提交 6 次，新增 1,842 行，删除 637 行，修改 31 个文件，净变化 +1,205 行。
>
> 需要查看具体 Commit 时，可继续指定“改动最大的提交”。

---

## 示例 B：连续追问

用户：

> 哪个提交改动最大？

Agent：

> `a91f2e3` 改动最大：新增 235 行，删除 48 行，涉及 7 个文件。

用户：

> 它主要改了什么？

Agent：

> 我读取了该 Commit 的实际 Diff。主要修改集中在打印机状态解析模块，包括 ……

---

## 示例 C：多仓库

用户：

> 张三这个月一共提交多少？

Agent：

> 当前查询覆盖 3 个仓库：repo-a、repo-b、repo-c。
>
> 合计 87 次 Commit，新增 12,420 行，删除 5,810 行。
>
> 其中 repo-a：32 次；repo-b：41 次；repo-c：14 次。

注意：统计过程中保持 Repository 独立，再做汇总。

---

# 18. 错误处理

常见错误：

### AI API 错误

```text
AI_PROVIDER_UNAVAILABLE
AI_AUTH_FAILED
AI_TIMEOUT
AI_INVALID_RESPONSE
```

### Tool 错误

```text
TOOL_INVALID_ARGUMENT
TOOL_PERMISSION_DENIED
TOOL_DATA_SOURCE_UNAVAILABLE
TOOL_RATE_LIMITED
```

### 数据错误

```text
USER_AMBIGUOUS
REPOSITORY_NOT_FOUND
BRANCH_NOT_FOUND
COMMIT_NOT_FOUND
```

Agent 必须把这些错误转换成用户可以理解的信息，不显示内部堆栈。

---

# 19. 性能策略

## 19.1 不要默认读取 Diff

查询：

> 张三今天提交了多少？

只调用：

```text
search_users
get_contribution_statistics
```

查询：

> 他具体改了什么？

才调用：

```text
get_commits
get_commit_detail
get_commit_diff
```

## 19.2 限制 Tool 返回大小

- commit list：默认最多 100 条。
- diff：默认限制字符数。
- branch：默认分页。
- 聚合统计优先于原始明细。

---

# 20. V0.3 数据库建议

```text
ai_provider_config
------------------
id
provider_type
base_url
api_key_encrypted
model
api_mode
temperature
max_tokens
timeout_ms
enabled
created_at
updated_at

agent_session
-------------
id
user_id
title
page_context_json
created_at
updated_at

agent_message
-------------
id
session_id
role
content
created_at

agent_tool_call
---------------
id
session_id
tool_call_id
tool_name
arguments_json
result_summary_json
status
duration_ms
created_at
```

---

# 21. 实施顺序

### Phase 1：基础 Agent

- AI Provider 配置。
- LLM Gateway。
- Agent Session。
- Streaming Chat。
- System Prompt。

### Phase 2：核心 Tools

实现：

```text
search_users
list_repositories
list_branches
get_branch_detail
get_commits
get_commit_detail
get_commit_diff
get_contribution_statistics
```

### Phase 3：页面上下文

把当前页面的 Repository、Branch、过滤条件注入 Agent Context。

### Phase 4：可追溯 UI

加入 Tool Call Trace、数据范围、来源摘要。

### Phase 5：Knowledge Base

导入 GitManager 业务规则和术语文档。

---

# 22. V0.3 验收标准

### 功能

- 能配置 API URL / Key / Model。
- 能测试 AI Provider。
- 能进行多轮对话。
- 能查询指定用户指定日期的 Commit。
- 能统计指定时间范围的 additions/deletions/net/files/commits。
- 能查看 Commit Detail。
- 能基于实际 Diff 总结代码修改。
- 能跨多个 Repository 查询并保持隔离。
- 能使用当前页面 Scope。

### 安全（红线验收，任一项失败即 V0.3 不通过）

- Agent 只能读取业务数据和产出报告。
- Agent **绝对没有任何删除权限**。
- 删除类 Tool 不得注册到 Tool Registry。
- Agent 不得调用删除 Branch、Repository、Commit、Tag、Report、Configuration 的 API。
- Agent 不得调用任何可间接触发删除的通用写操作接口。
- Agent 不得修改 Repository、Branch、GitLab 数据或系统配置。
- Agent 不得修改 Schedule / Monitoring。
- Agent 不得发送通知/邮件。
- Agent Permission Guard 必须拒绝 `WRITE` / `DELETE` capability。
- API Key 不出现在前端响应和日志中。
- Tool 调用可审计。
- 必须有自动化安全测试验证“Agent 无删除路径”。

### 可信度

- 实时事实必须来自 Tool。
- 模型无法查询到的数据必须明确说明。
- Commit SHA、统计数字、Repository 名称不得由模型臆造。

---

# 23. 下一阶段扩展路线

后续版本只能在 **READ + REPORT** 边界内扩展 Agent 能力，例如：

```text
V0.4
├─ Report Agent
├─ Contribution Analysis
├─ Branch Health Analysis
├─ Monitoring Analysis
└─ Cross-Repository Analytics

V0.5
├─ 周报 / 月报生成
├─ 管理汇报生成
├─ Commit 变更总结
└─ 趋势分析 / 异常分析

V0.6+
├─ 更强的只读查询能力
├─ 更多只读 GitLab 数据源
├─ 更强的报告与可视化
└─ 更丰富的知识库
```

**明确禁止的演进方向：**

- 不为 Agent 增加任何删除 Tool。
- 不为 Agent 增加通用 `execute` / `sql` / `shell` Tool。
- 不允许 Agent 通过确认流程获得删除权限。
- 不允许 Agent 代替原有删除流程执行删除。
- 不允许因为未来新增需求而弱化本红线。

如未来业务产品需要执行删除操作，必须继续由 GitManager 原有业务 UI、原有权限链路和原有人工确认机制独立完成，**Agent 与删除路径物理隔离**。
