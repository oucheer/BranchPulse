# GitManager Agent V0.3 → Harness 架构优化方案

> 版本：V0.3.1-Harness
> 目标：基于已经按照《GitManager Agent V0.3 技术规格》实现的 Agent，进行增量式 Harness 化重构，不推翻现有实现。
> 核心定位：GitManager 内置、业务数据驱动、只读查询 + 报告生成的 Agent Harness。
> 最高安全标准：**Agent 只能读取数据和产出报告，Agent 永久不具备任何删除权限。**

---

## 0. 先说结论

当前 V0.3 已经具备 Harness 的若干核心部件：

- Session Manager
- Context Builder
- LLM Gateway
- Tool Orchestrator
- Permission Guard
- Tool Audit
- Knowledge Retriever

因此这次不要“重写 Agent”，而是把现有 `Agent Runtime` **结构化升级成 Agent Harness**。

推荐演进：

```text
当前 V0.3

Agent Runtime
├── Session Manager
├── Context Builder
├── LLM Gateway
├── Tool Orchestrator
├── Permission Guard
└── Knowledge Retriever

                ↓ 增量重构

V0.3.1 Harness

Agent Harness
├── Agent Run Manager
├── Agent Orchestrator
├── Context Engine
├── Policy Engine
├── Tool Registry
├── Tool Executor
├── Knowledge Retriever
├── Model Gateway
├── Report Composer
├── Trace / Audit
└── Result Renderer
```

原则：**Harness 是控制层，不是新的业务系统。**

---

# 1. V0.3 与 Harness 的对应关系

| 当前 V0.3 | Harness 化后的职责 | 是否需要重写 |
|---|---|---|
| Agent Session Manager | Session Store / Session Manager | 否，重命名+拆职责 |
| Context Builder | Context Engine | 小幅重构 |
| LLM Gateway | Model Gateway | 保留并抽象 Provider |
| Tool Orchestrator | Agent Orchestrator + Tool Executor | 需要拆分 |
| Permission Guard | Policy Engine | 需要提升为独立策略层 |
| Tool Schema | Tool Registry | 需要集中注册和校验 |
| Knowledge Retriever | Knowledge Service | 保留 |
| Agent Tool Audit | Trace / Audit | 扩展生命周期追踪 |
| Report API | Report Composer | 明确“生成而不是写业务数据” |
| Agent UI | Agent Console / Run Viewer | 小幅增强 |

**目标不是增加更多代码，而是把“Agent 如何运行”从业务 Tool 中抽离出来。**

---

# 2. 新的总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     GitManager UI                          │
│ Repository / Branch / Reports / Monitoring / Audit / Agent │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    GitManager Agent Harness                 │
│                                                             │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   │
│  │ Run Manager │ → │ Orchestrator │ → │ Model Gateway │   │
│  └─────────────┘   └──────┬───────┘   └───────┬───────┘   │
│                            │                   │           │
│  ┌─────────────┐   ┌──────▼───────┐   ┌──────▼───────┐   │
│  │Context      │   │ Policy       │   │ Provider     │   │
│  │Engine       │   │ Engine       │   │ Adapter      │   │
│  └──────┬──────┘   └──────┬───────┘   └──────────────┘   │
│         │                  │                               │
│  ┌──────▼──────┐   ┌──────▼────────┐                     │
│  │ Knowledge   │   │ Tool Registry  │                     │
│  │ Retriever   │   │ + Tool Executor │                     │
│  └─────────────┘   └──────┬─────────┘                     │
│                            │                               │
│                   ┌────────▼────────┐                      │
│                   │ Trace / Audit   │                      │
│                   └─────────────────┘                      │
└────────────────────────────┬────────────────────────────────┘
                             │
             ┌───────────────┼────────────────┐
             ▼               ▼                ▼
     Read-only Services   Report Service   Permission Service
             │               │                │
             ▼               ▼                ▼
         App DB / GitLab / Local Git / Existing GitManager
```

---

# 3. 最重要的变化：从“Agent Chat”变成“Agent Run”

当前 V0.3 更偏向：

```text
message → LLM → tool → answer
```

Harness 版本统一成：

```text
User Message
    ↓
Create Agent Run
    ↓
Build Context
    ↓
Apply Policy
    ↓
Model Decide
    ↓
Tool Call?
 ┌──┴────────────┐
 │               │
 Yes             No
 │               │
 ▼               ▼
Policy Check   Final Answer
 │
 ▼
Tool Execute
 │
 ▼
Tool Result
 │
 ▼
Observation
 │
 ▼
Model Continue
 │
 └──────→ repeat
```

一个 Session 可以包含多个 Run：

```text
Session
├── Run 001：统计张三 9 月 10 日提交
├── Run 002：其中哪个提交最大？
└── Run 003：分析这个 Commit 改了什么
```

这样后续做长任务、取消、重试、恢复、Trace 都有基础。

---

# 4. Agent Run 生命周期

建议增加明确状态机：

```text
CREATED
  ↓
CONTEXT_BUILDING
  ↓
RUNNING
  ├── MODEL_THINKING
  ├── TOOL_PENDING
  ├── TOOL_RUNNING
  ├── TOOL_COMPLETED
  └── MODEL_CONTINUING
  ↓
COMPLETED
```

异常：

```text
RUNNING
 ↓
FAILED
```

用户取消：

```text
RUNNING
 ↓
CANCELLED
```

建议每一个 Run 记录：

```ts
interface AgentRun {
  id: string;
  sessionId: string;
  userId: string;
  status:
    | 'created'
    | 'context_building'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';
  startedAt?: string;
  completedAt?: string;
  currentScope: AgentScope;
  finalAnswer?: string;
  errorCode?: string;
}
```

---

# 5. Context Engine

当前 `Context Builder` 建议升级为 Context Engine，并明确分层。

```text
Context Engine
├── Identity Context
│   └── current user
├── Permission Context
│   └── accessible repositories
├── Page Context
│   └── current page / current repo / branch / filters
├── Conversation Context
│   └── recent messages / summary
├── Knowledge Context
│   └── business rules / terminology
└── Task Context
    └── current query intent / normalized time range / scope
```

推荐最终输入：

```json
{
  "identity": {},
  "permissions": {},
  "page_context": {},
  "conversation": {},
  "knowledge": {},
  "task": {
    "intent": "contribution_statistics",
    "repository_ids": ["repo-a"],
    "author_ids": ["user-123"],
    "start_time": "2026-09-10T00:00:00+08:00",
    "end_time": "2026-09-10T23:59:59+08:00"
  }
}
```

### 5.1 关键优化：模型不能直接决定 Scope

模型可以提出：

```text
repository_ids = repo-a
```

但最终必须由 Harness 计算：

```text
Requested Scope
      ↓
Policy Engine
      ↓
Allowed Scope
```

例如：

```text
用户可访问 repo-a、repo-b
当前页面选择 repo-a、repo-b
模型请求 repo-c
        ↓
DENY / FILTER OUT
```

也就是说：**Scope 是 Harness 的安全对象，不是 Prompt 里的自然语言约定。**

---

# 6. Policy Engine

这是 Harness 化最重要的一步。

不要只保留一个 `PermissionGuard`。

升级为：

```text
Policy Engine
├── Identity Policy
├── Repository Scope Policy
├── Tool Capability Policy
├── Data Visibility Policy
├── Rate / Limit Policy
└── Hard Redline Policy
```

## 6.1 Capability 定义

```ts
type AgentCapability =
  | 'READ'
  | 'REPORT_GENERATE';
```

明确不存在：

```text
WRITE
DELETE
MUTATE
EXECUTE
SHELL
SQL
ADMIN
```

## 6.2 Tool Capability

每一个 Tool 必须声明：

```ts
interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  capability: 'READ' | 'REPORT_GENERATE';
  scopeType: 'repository' | 'global_read';
  handler: string;
  maxResultSize?: number;
}
```

### 红线：Capability 不是字符串约定，而是 Allowlist

启动时建立：

```text
ALLOWED_CAPABILITIES = {
  READ,
  REPORT_GENERATE
}
```

如果某个 Tool 出现其他 capability：

```text
REGISTRATION FAILED
```

而不是“注册后再禁用”。

---

# 7. Tool Registry

当前 8 个 Tool 保留，不需要重新设计业务功能：

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

建议 Registry 结构：

```ts
interface ToolRegistry {
  register(tool: AgentToolDefinition): void;
  get(name: string): AgentToolDefinition | undefined;
  listAllowedTools(): AgentToolDefinition[];
  validateToolCall(name: string, args: unknown): ValidationResult;
}
```

### 7.1 强制规则

Registry 只能接受：

```text
READ
REPORT_GENERATE
```

禁止：

```text
register(deleteBranchTool)
register(writeTool)
register(executeTool)
register(sqlTool)
register(shellTool)
```

另外禁止任何“万能 Tool”：

```text
execute(action, payload)
request(url, method, body)
sql(query)
shell(command)
```

这是 Harness 安全边界的核心。

---

# 8. Tool Executor

原来的 Tool Orchestrator 中，真正执行 Tool 的部分拆出来：

```text
Agent Orchestrator
        │
        ▼
Tool Registry
        │
        ▼
Policy Engine
        │
        ▼
Tool Executor
        │
        ▼
Business Read Service
```

Tool Executor 负责：

- 参数 Schema 校验
- Scope 注入
- 当前用户注入
- Policy 再检查
- Timeout
- Retry
- Result Size Limit
- Sensitive Data Filtering
- Trace

### 8.1 Tool 不允许接收 LLM 自己提供的 userId / permission

错误：

```json
{
  "user_id": "admin"
}
```

正确：

```text
LLM args
 ↓
Tool Executor
 ↓
Server injected actor.userId
 ↓
Permission Service
```

LLM 只能提供业务查询条件，不能自报身份。

---

# 9. Tool Result Contract

建议统一所有 Tool 输出：

```json
{
  "tool_call_id": "tc_001",
  "tool_name": "get_commits",
  "status": "success",
  "scope": {
    "repository_ids": ["repo-a"],
    "start_time": "2026-09-10T00:00:00+08:00",
    "end_time": "2026-09-10T23:59:59+08:00"
  },
  "data": {},
  "meta": {
    "source": "gitlab",
    "truncated": false,
    "count": 6
  }
}
```

这样最终答案可以明确说明：

```text
查询范围：repo-a
时间：2026-09-10
数据源：GitLab
提交：6
```

---

# 10. Evidence / Provenance

Harness 版本建议增加一个非常重要的概念：**Evidence**。

因为 Agent 的答案应该能够回答：

> 你为什么得出这个结论？

例如：

```ts
interface Evidence {
  type: 'repository' | 'commit' | 'branch' | 'statistic' | 'report';
  repositoryId?: string;
  commitSha?: string;
  source: 'gitlab' | 'gitmanager-db' | 'derived';
  reference?: string;
}
```

最终答案：

```text
张三 2026-09-10 共提交 6 次。
新增 1,842 行，删除 637 行。

数据来源：GitLab Commit API
[查看 6 个 Commit]
```

注意：Evidence 是来源信息，不是把完整 GitLab 数据塞进 Prompt。

---

# 11. Agent Loop 要限制深度

Harness 必须防止模型无限调用 Tool。

例如：

```ts
MAX_TOOL_CALLS_PER_RUN = 20;
MAX_TOOL_CHAIN_DEPTH = 10;
MAX_RUN_TIME_MS = 120000;
```

如果超过限制：

```text
RUN_LIMIT_EXCEEDED
```

并向用户说明：

> 查询范围较大，已达到本次 Agent 查询上限，请缩小时间范围或仓库范围。

---

# 12. Tool 调用策略优化

不是所有问题都需要相同的查询深度。

### Level 1：聚合问题

```text
“张三这个月提交了多少代码？”
```

只需要：

```text
search_users
→ get_contribution_statistics
```

### Level 2：提交列表

```text
“张三这个月提交了哪些 Commit？”
```

调用：

```text
search_users
→ get_commits
```

### Level 3：代码变化

```text
“这个 Commit 具体改了什么？”
```

调用：

```text
get_commit_detail
→ get_commit_diff
```

### Level 4：跨提交分析

```text
“这个人本周主要在做什么？”
```

调用：

```text
get_contribution_statistics
→ get_commits
→ 必要时选取少量 Commit Detail / Diff
```

Agent 不应默认读取所有 Diff。

---

# 13. Report Composer

现有“产出报告”建议正式独立成：

```text
Report Composer
```

它只允许：

```text
Tool Result
   ↓
Report Composer
   ↓
Generated Report Artifact
```

例如：

```text
张三 2026-09-01 ~ 2026-09-10

Commit：32
Additions：6,240
Deletions：2,180
Files：86

主要变化：
...
```

## 13.1 报告可以生成，但不能触发业务写操作

允许：

```text
生成报告内容
生成 Markdown
生成 HTML
生成数据表
生成图表
```

禁止：

```text
保存到 GitLab
修改 Repository
修改 Branch
发送邮件
```

如果已有报告模块需要持久化，也必须调用**专用 Report Persistence**，且这个接口只能写“报告产物”，不能写 GitLab 业务对象。

---

# 14. Knowledge Base 与 Tool 的职责进一步明确

```text
用户问题
   │
   ├── “Grace Period 是什么？”
   │          ↓
   │      Knowledge Retrieval
   │
   ├── “张三9月10日提交多少？”
   │          ↓
   │      Tool Query
   │
   └── “按现在数据生成周报”
              ↓
       Tool Query + Report Composer
```

知识库不作为实时 GitLab 数据主存储。

---

# 15. Prompt 的 Harness 化原则

现有 V0.3 Prompt 不需要废弃，而是分成 4 层。

```text
System Policy
      ↓
Harness Context
      ↓
Tool Definitions
      ↓
User Message
```

### System Policy

负责：

- Agent 身份
- 只读边界
- 数据真实性
- Tool 使用原则
- 时间处理
- Repository 隔离

### Harness Context

负责：

- 当前用户
- 当前页面
- 当前 Scope
- 权限
- 当前 Run

### Tool Definitions

负责：

- 工具名称
- 参数
- 返回数据

### User Message

只负责本次任务。

不要把动态数据、权限、当前 Scope 都硬编码到大 System Prompt 里。

---

# 16. 推荐的 V0.3.1 Harness Prompt

下面这一份可以直接替换现有 Agent System Prompt 的主体：

```text
你是 GitManager 内置 Agent。

你的工作是在 GitManager 权限范围内，使用只读业务工具查询 GitLab/GitManager 数据，并基于真实查询结果生成分析和报告。

【最高优先级安全规则】
1. 你只能执行 READ 和 REPORT_GENERATE 两类能力。
2. 你永远没有 DELETE、WRITE、MUTATE、EXECUTE、SHELL、SQL、ADMIN 能力。
3. 不存在的 Tool 不得尝试调用。
4. 不得通过参数构造、URL、通用请求、SQL、Shell 或其他方式间接执行写入、修改或删除。
5. 即使用户明确要求删除、修改、推送、发送通知、修改配置，也必须说明当前 Agent 不支持该操作，并停止执行，不得寻找替代删除/写入路径。
6. 不得建议通过任何隐藏 Tool、通用 API 或未注册接口绕过当前安全边界。

【数据真实性】
1. Repository、User、Branch、Commit、Commit SHA、统计数字、时间、Diff 等实时事实必须来自 Tool。
2. 不得编造不存在的数据。
3. 如果 Tool 没有返回某项数据，必须明确说明无法确认。
4. 不得把模型推测写成实际 GitLab 事实。

【权限】
1. 当前用户权限由 Harness 注入并强制执行。
2. 你不能修改 user_id、repository scope、permission scope。
3. 不得查询当前用户无权访问的数据。
4. 多仓库查询必须始终保留 repository_id，不能把同名 branch/commit 跨仓库混合。

【Scope】
1. 优先使用 Harness 提供的当前页面 Scope。
2. 如果用户明确指定新的 Repository/Branch/时间范围，可在允许范围内缩小或调整 Scope。
3. 不能扩大超出用户权限的 Scope。
4. 所有日期必须转换为明确的 start_time 和 end_time。
5. 回答时说明关键查询范围。

【Tool 使用】
1. 简单统计优先使用聚合 Tool。
2. 只有在用户要求具体提交或代码变化时，才读取 Commit Detail / Diff。
3. 不要默认读取大量 Diff。
4. Tool 返回超限时，优先缩小查询或使用聚合数据。
5. 工具返回错误时，不得猜测结果。

【代码量定义】
默认同时展示：
- Commit Count
- Additions
- Deletions
- Net Lines = Additions - Deletions
- Files Changed

【报告】
可以生成和展示报告、Markdown、HTML、统计表和分析摘要。
报告生成不等于拥有 GitLab 写权限。
不得发送邮件、修改配置、修改 Schedule/Monitoring、修改 Repository/Branch。

【回答】
1. 先给结论，再给关键数据。
2. 对查询范围进行说明。
3. 尽可能展示 Commit SHA、时间、作者、Repository、Additions、Deletions 等真实字段。
4. 对代码变更优先说明修改了什么、主要文件和影响范围。
5. 给出数据来源或 Evidence 摘要。
6. 保留当前 Session 的对话上下文，支持连续追问。
```

---

# 17. 强化“删除请求”处理

当用户说：

```text
删除 feature/test
```

Agent 不应该调用任何 Tool。

正确流程：

```text
User
 ↓
Intent = DELETE
 ↓
Policy Engine
 ↓
DENY
 ↓
Final Answer
```

返回：

```text
当前 GitManager Agent 是只读 Agent，不具备任何删除权限，无法执行该操作。
```

**注意：不要再把 DELETE 意图交给 Tool Registry 再判断。Policy Engine 可以在进入 Tool 阶段之前就拦截。**

---

# 18. 前端优化

当前 Agent UI 保留，但增加 Run 级展示：

```text
┌─────────────────────────────────────────┐
│ GitManager Agent                  ● Ready│
├─────────────────────────────────────────┤
│                                         │
│ 你：统计张三9月10日提交                  │
│                                         │
│ Agent                                   │
│ ┌─────────────────────────────────────┐ │
│ │ Scope                                │ │
│ │ repo-a · 2026-09-10                 │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ✓ search_users                          │
│ ✓ get_contribution_statistics           │
│                                         │
│ 6 commits                               │
│ +1,842 / -637 lines                     │
│                                         │
│ [查看 Commit] [查看数据来源]             │
│                                         │
└─────────────────────────────────────────┘
```

建议增加：

```text
Scope
Tools
Evidence
```

三个折叠区。

---

# 19. 后端目录优化

基于当前实现做增量调整：

```text
agent/
├── harness/
│   ├── AgentRunManager
│   ├── AgentOrchestrator
│   ├── AgentLoop
│   └── AgentRuntimeConfig
│
├── context/
│   ├── ContextEngine
│   ├── PageContextResolver
│   ├── ScopeResolver
│   └── ConversationContext
│
├── policy/
│   ├── PolicyEngine
│   ├── PermissionPolicy
│   ├── ScopePolicy
│   └── HardRedlinePolicy
│
├── tools/
│   ├── registry/
│   │   └── ToolRegistry
│   ├── executor/
│   │   └── ToolExecutor
│   └── definitions/
│       ├── SearchUsersTool
│       ├── ListRepositoriesTool
│       ├── ListBranchesTool
│       ├── GetBranchDetailTool
│       ├── GetCommitsTool
│       ├── GetCommitDetailTool
│       ├── GetCommitDiffTool
│       └── GetContributionStatisticsTool
│
├── llm/
│   ├── ModelGateway
│   └── providers/
│
├── knowledge/
├── report/
├── trace/
└── security/
```

不要求一次性改完目录，可以先建立逻辑层，再逐步移动代码。

---

# 20. 数据库增量变化

在现有表基础上新增：

```text
agent_run
---------
id
session_id
user_id
status
scope_json
started_at
completed_at
error_code
final_answer
```

扩展：

```text
agent_tool_call
---------------
run_id
sequence_no
capability
scope_json
status
request_summary_json
result_summary_json
started_at
completed_at
```

可选：

```text
agent_evidence
--------------
id
run_id
tool_call_id
type
repository_id
commit_sha
source
reference
```

这样 Session、Run、Tool Call、Evidence 四层清晰分离：

```text
Session
 └── Run
      ├── Tool Call
      ├── Tool Call
      ├── Tool Call
      └── Evidence
```

---

# 21. API 增量设计

保留原有 API，不做破坏性调整。

新增：

```http
POST /api/agent/sessions/:sessionId/runs
GET  /api/agent/runs/:runId
POST /api/agent/runs/:runId/cancel
GET  /api/agent/runs/:runId/trace
GET  /api/agent/runs/:runId/evidence
```

原有：

```http
POST /api/agent/sessions/:sessionId/messages
```

可以内部迁移为：

```text
messages endpoint
      ↓
create AgentRun
      ↓
run Harness
```

因此前端可以暂时不大改。

---

# 22. 测试方案

## 22.1 功能测试

```text
Query User
Query Repository
Query Branch
Query Commit
Query Diff
Contribution Statistics
Multi Repository
Continuous Conversation
Page Context
Generate Report
```

## 22.2 Harness 测试

```text
Run State Transition
Context Assembly
Scope Filtering
Tool Schema Validation
Tool Timeout
Tool Retry
Tool Result Truncation
Evidence Generation
Trace Generation
```

## 22.3 红线测试（最高优先级）

必须自动化测试：

```text
DELETE branch
DELETE repository
DELETE commit
DELETE tag
DELETE report
MODIFY branch
MODIFY repository
MODIFY config
MODIFY schedule
SEND email
SHELL command
SQL query
ARBITRARY HTTP write
```

预期全部：

```text
DENIED
```

同时扫描：

```text
Tool Registry
Agent routes
Agent service dependencies
```

确保不存在：

```text
delete*
write*
update*
execute*
shell
sql
```

形式的通用 Agent 工具。

---

# 23. 实施顺序：不要一次重构完

### Step 1：建立 Harness 外壳

保留现有 AgentService，把入口包成：

```text
AgentController
 ↓
AgentRunManager
 ↓
AgentOrchestrator
```

### Step 2：拆分 Tool Registry

把当前 Tool 定义统一注册。

### Step 3：把 PermissionGuard 升级为 PolicyEngine

重点先做：

```text
ScopePolicy
HardRedlinePolicy
```

### Step 4：建立 Agent Run

Session 不再直接等于一次模型执行。

### Step 5：统一 Tool Envelope

所有 Tool Call 都产出统一结构。

### Step 6：加入 Evidence / Trace

前端显示来源和调用摘要。

### Step 7：拆分 Report Composer

明确报告是 Agent 的输出产物，不等于业务写权限。

### Step 8：替换 System Prompt

使用本文件第 16 节 Prompt。

### Step 9：跑全套回归测试

尤其是删除/写入隔离测试。

---

# 24. 最终 Harness 运行模型

```text
                 ┌─────────────────┐
                 │   User Message  │
                 └────────┬────────┘
                          ▼
                 ┌─────────────────┐
                 │  Agent Run Mgr  │
                 └────────┬────────┘
                          ▼
                 ┌─────────────────┐
                 │  Context Engine │
                 └────────┬────────┘
                          ▼
                 ┌─────────────────┐
                 │  Policy Engine  │
                 └────────┬────────┘
                          ▼
                 ┌─────────────────┐
                 │      Model      │
                 └────────┬────────┘
                          ▼
                   Tool requested?
                    /            \
                  yes             no
                  /                 \
                 ▼                   ▼
        ┌────────────────┐    ┌──────────────┐
        │   Tool Policy  │    │ Final Answer │
        └───────┬────────┘    └──────────────┘
                ▼
        ┌────────────────┐
        │ Tool Executor  │
        └───────┬────────┘
                ▼
        ┌────────────────┐
        │ Read Service   │
        └───────┬────────┘
                ▼
        ┌────────────────┐
        │ Tool Result    │
        └───────┬────────┘
                ▼
        ┌────────────────┐
        │ Evidence/Trace │
        └───────┬────────┘
                │
                └──────────→ Model Continue

Hard Redline:
任何 DELETE / WRITE / EXECUTE 意图
          ↓
      Policy DENY
          ↓
     不进入 Tool Executor
```

---

# 25. V0.3.1 验收标准

### 必须保持的现有能力

- AI Provider 配置仍可用。
- 多轮对话仍可用。
- 现有 8 个查询 Tool 仍可用。
- 当前页面 Scope 仍可用。
- 多仓库隔离仍可用。
- Commit / Diff 查询仍可用。
- 贡献统计仍可用。
- 报告生成仍可用。

### 新增 Harness 能力

- Session 与 Run 分离。
- 明确的 Run 状态机。
- Context Engine。
- Policy Engine。
- Tool Registry。
- Tool Executor。
- Tool Result Envelope。
- Evidence / Provenance。
- Trace。
- Tool Chain / Run Limit。
- 统一错误处理。

### 红线

以下任何一项失败，V0.3.1-Harness 不通过：

```text
Agent 可以删除任何数据                 ❌
Agent 可以修改 GitLab 数据              ❌
Agent 可以调用通用 write API            ❌
Agent 可以执行 SQL                      ❌
Agent 可以执行 Shell                    ❌
Agent 可以通过 arbitrary HTTP 间接写入  ❌
Agent 可以发送通知/邮件                 ❌
Agent 可以扩大当前用户权限 Scope        ❌
Agent 可以伪造 Commit / SHA / Statistics ❌
```

---

# 26. 给代码 Agent 的实施 Prompt

> 下面 Prompt 按“已有实现基础上的连续优化”编写，适合直接交给 Codex / Claude Code / Qoder 等代码 Agent。

```text
你现在要对一个已经完成 GitManager Agent V0.3 的现有项目进行增量优化。

重要：不要重写整个 Agent，不要推翻已有代码，不要重新设计已经正常工作的 GitManager 业务模块。
你的任务是：在现有 V0.3 实现基础上，把当前 Agent Runtime 连续演进为“轻量业务型 Agent Harness”。

【现有实现假设】
项目已经按照 GitManager Agent V0.3 方案实现了至少以下能力：
- AI Provider 配置
- Base URL / API Key / Model 配置
- 多轮 Agent Chat
- Session
- Context Builder
- LLM Gateway
- Tool Calling
- Permission Guard
- Tool Audit
- Knowledge Retriever
- 以下只读 Tools：
  search_users
  list_repositories
  list_branches
  get_branch_detail
  get_commits
  get_commit_detail
  get_commit_diff
  get_contribution_statistics

在开始修改前，必须先阅读并理解当前项目实际代码结构、Agent 入口、Session、LLM Gateway、Tool Registry/Orchestrator、Permission Guard、数据库模型、API 路由和 Agent 前端组件。
不要假设当前代码结构与文档完全一致，以实际代码为准。

==================================================
一、最高优先级红线
==================================================

GitManager Agent 是永久 READ + REPORT ONLY Agent。

Agent 只能：
1. 读取数据
2. 查询数据
3. 分析数据
4. 基于读取结果生成/展示报告

Agent 永远不能：
- 删除 Repository
- 删除 Branch
- 删除 Commit
- 删除 Tag
- 删除 Report
- 删除 Configuration
- 修改 Repository
- 修改 Branch
- 修改 GitLab 数据
- 修改 Schedule
- 修改 Monitoring
- 发送通知/邮件
- 执行 Shell
- 执行任意 SQL
- 执行任意代码
- 调用通用 arbitrary HTTP write
- 调用任何可能间接产生删除/修改副作用的通用 Tool

非常重要：
“没有删除 Tool”不是唯一安全措施。
必须从 Tool Registry、Tool Executor、Policy Engine、Agent Service、Agent API 和依赖关系上保证 Agent 没有删除/修改路径。

不要新增：
- deleteBranchTool
- deleteRepositoryTool
- writeTool
- updateTool
- executeTool
- shellTool
- sqlTool
- arbitraryRequestTool
- genericActionTool

如果发现现有 Agent 已经存在以上类型能力，必须优先将其从 Agent 路径隔离/移除，并保留原有 GitManager 正常业务功能不受影响。

==================================================
二、目标架构
==================================================

把当前 Agent Runtime 增量重构成：

Agent Harness
├── AgentRunManager
├── AgentOrchestrator
├── AgentLoop
├── ContextEngine
├── PolicyEngine
├── ToolRegistry
├── ToolExecutor
├── KnowledgeRetriever
├── ModelGateway
├── ReportComposer
└── Trace/Audit

不要为了形式上的目录变化而大规模移动代码。
优先实现职责清晰和调用链清晰，再做必要的文件拆分。

目标调用链：

User
→ Agent API
→ AgentRunManager
→ ContextEngine
→ PolicyEngine
→ AgentOrchestrator
→ ModelGateway
→ ToolRegistry
→ PolicyEngine
→ ToolExecutor
→ Read-only Business Service
→ Tool Result
→ Evidence/Trace
→ Model Continue
→ Final Answer / Report

==================================================
三、第一步：先做现状分析
==================================================

在修改代码之前：
1. 找到 Agent API 入口。
2. 找到 AgentService / Runtime。
3. 找到 Session 数据模型。
4. 找到 LLM Gateway 和 Provider Adapter。
5. 找到 Tool 定义和 Tool Calling 逻辑。
6. 找到 Permission Guard。
7. 找到所有 Agent API routes。
8. 找到 Agent UI。
9. 找到报告生成实现。
10. 搜索 Agent 路径是否存在 delete/write/update/execute/shell/sql/arbitrary HTTP 能力。

输出一个简短的当前架构图，再开始修改。

==================================================
四、建立 Agent Run
==================================================

在保留 Session 的前提下增加 Agent Run。

一个 Session 可以包含多个 Run。

建议模型：
AgentRun {
  id
  sessionId
  userId
  status
  scopeJson
  startedAt
  completedAt
  errorCode
  finalAnswer
}

状态至少支持：
created
context_building
running
completed
failed
cancelled

不要破坏现有 message API。
如已有 message endpoint，可以让它内部创建 Run，再调用 Harness。

==================================================
五、建立 ContextEngine
==================================================

把现有 Context Builder 演进成 ContextEngine。

Context 分层：
- current user
- permission scope
- page context
- selectedRepositoryIds
- current branch
- current filters
- conversation history
- knowledge context
- normalized task scope

关键要求：
LLM 不允许自己定义权限。
LLM 不能自己修改 userId。
LLM 不能扩大 repository scope。

最终执行前使用：
Requested Scope
→ PolicyEngine
→ Allowed Scope

==================================================
六、建立 PolicyEngine
==================================================

把 Permission Guard 提升为 PolicyEngine。

至少实现：
- PermissionPolicy
- RepositoryScopePolicy
- HardRedlinePolicy

Agent capability 只允许：
READ
REPORT_GENERATE

没有：
WRITE
DELETE
MUTATE
EXECUTE
SHELL
SQL
ADMIN

PolicyEngine 必须在 Tool Executor 之前执行。

如果用户要求：
删除 branch
修改 branch
修改 repository
发送邮件
执行 shell
执行 sql

必须在进入 Tool Executor 之前 DENY。

禁止让模型为了寻找“替代办法”继续调用其他 Tool。

==================================================
七、建立 ToolRegistry
==================================================

统一注册现有 8 个 Tool：
- search_users
- list_repositories
- list_branches
- get_branch_detail
- get_commits
- get_commit_detail
- get_commit_diff
- get_contribution_statistics

每个 Tool 增加 metadata：
- name
- description
- inputSchema
- capability
- scopeType
- handler
- maxResultSize

只允许 capability：
READ
REPORT_GENERATE

Registry 对非法 capability 在启动/注册时直接失败。

禁止通用 Tool：
execute(action,payload)
request(url,method,body)
sql(query)
shell(command)

==================================================
八、拆分 ToolExecutor
==================================================

把当前 Tool Orchestrator 中的实际执行逻辑拆成 ToolExecutor。

执行顺序：
1. Tool Name 校验
2. Schema 校验
3. 当前用户注入
4. Allowed Scope 注入
5. Policy 再检查
6. 调用 Read-only Business Service
7. 限制结果大小
8. 敏感信息过滤
9. 写 Trace
10. 返回统一 Tool Result

LLM 不可以传入：
userId
permission scope
admin flag

这些必须由服务器/Harness 注入。

==================================================
九、统一 Tool Result
==================================================

统一 envelope，例如：
{
  tool_call_id,
  tool_name,
  status,
  scope,
  data,
  meta
}

至少包含：
- source
- count
- truncated

让最终回答可以说明真实数据来源。

==================================================
十、增加 Evidence / Provenance
==================================================

每个重要查询结果尽可能保存 Evidence：
- repositoryId
- commitSha
- source
- reference
- statistic

前端显示：
“数据来源 / 查看 Commit / 查看原始数据”

不要把大块原始数据全部展示给用户。

==================================================
十一、Agent Loop
==================================================

实现有限 Agent Loop：
Model
→ Tool Call
→ Tool Result
→ Model Continue
→ ...
→ Final Answer

增加限制：
- max tool calls per run
- max chain depth
- max run duration
- timeout

避免模型无限调用 Tool。

==================================================
十二、报告能力
==================================================

将报告生成明确抽象为 ReportComposer。

允许：
- Markdown
- HTML
- 数据表
- 图表
- 汇报摘要

不允许：
- 发邮件
- 修改 GitLab
- 修改 Schedule
- 修改 Monitoring
- 保存为 GitLab 业务对象

如必须持久化报告，使用专用 Report Persistence，且只能写“报告产物”，绝不能写 GitLab Repository/Branch 等业务对象。

==================================================
十三、Prompt 优化
==================================================

将现有 Agent System Prompt 改造成 Harness-aware Prompt。
核心内容必须包括：
- READ + REPORT ONLY
- 不存在 DELETE/WRITE/MUTATE/EXECUTE/SHELL/SQL/ADMIN
- 不得绕过 Tool Registry
- 实时事实必须来自 Tool
- 不得伪造 Commit/SHA/Statistics
- 权限由 Harness 决定
- 不得扩大 Repository Scope
- 多仓库必须保持 repository_id 隔离
- 时间范围明确化
- 聚合问题优先用统计 Tool
- 只有用户要求时才读取 Diff
- 连续对话继承 Session Context

不要把 Prompt 当作唯一安全机制。

==================================================
十四、前端
==================================================

保留现有 Agent Panel。
增加：
- Run 状态
- Scope 摘要
- Tool Call 摘要
- Evidence / Data Source
- Loading / failed / cancelled 状态

用户可以看到：
“正在查询张三的提交”
“已查询 2 个仓库”
“正在统计代码变更”

不要展示敏感信息，例如 API Key。

==================================================
十五、测试
==================================================

必须先写/补测试再完成重构。

功能测试：
- 单仓库
- 多仓库
- 用户查询
- Commit 查询
- Diff 查询
- Contribution Statistics
- Page Context
- Follow-up Question
- Report Generation

Harness 测试：
- Run lifecycle
- Context build
- Scope filtering
- Tool schema validation
- Timeout
- Retry
- Tool result truncation
- Evidence
- Trace

最高优先级安全测试：
以下全部必须 DENIED：
- delete branch
- delete repository
- delete commit
- delete tag
- delete report
- modify branch
- modify repository
- modify config
- modify schedule
- send email
- shell command
- SQL query
- arbitrary HTTP write

并检查 Agent 代码路径中不存在通用 write/delete/execute 能力。

==================================================
十六、实施纪律
==================================================

1. 不要修改 GitManager 原有 Repository/Branch 删除功能本身。
2. 不要修改原业务权限系统逻辑，Agent 只是继承它。
3. 不要为了 Harness 化而重做现有 GitLab integration。
4. 保持已有 API 尽可能兼容。
5. 优先小步提交，每一步都可运行。
6. 每个结构调整后运行现有测试。
7. 最终给出：
   - 修改文件列表
   - 新增类/模块
   - Agent 调用链
   - 安全隔离说明
   - 测试结果
   - 仍需后续优化项

最终目标不是做一个“更复杂的 Agent”，而是让 GitManager Agent 具备一个真正可控的业务 Harness：

Model 负责推理；
Harness 负责上下文、Scope、策略、Tool、生命周期和追踪；
Business Service 负责真实 GitLab 数据；
Knowledge Base 负责规则和术语；
Report Composer 负责报告产物；
Agent 永远不具备任何删除或修改 GitLab 数据的权限。
```

---

# 27. 本次优化完成后的核心变化

```text
原 V0.3

Chat → Agent Runtime → Tools → GitLab

                ↓

Harness V0.3.1

Chat
 ↓
Agent Run
 ↓
Context Engine
 ↓
Policy Engine
 ↓
Agent Orchestrator
 ↓
Model
 ↓
Tool Registry
 ↓
Policy Engine
 ↓
Tool Executor
 ↓
Read-only Services
 ↓
Evidence / Trace
 ↓
Model
 ↓
Answer / Report
```

真正重要的不是增加多少 Agent 功能，而是做到：

```text
LLM = 推理
Harness = 控制
Tool = 能力
Business Service = 数据
Knowledge = 规则
Report Composer = 输出
Policy = 边界
Trace = 证据
```

其中最高优先级红线永久保持：

```text
                    GitManager Agent
                          │
                 ┌────────┴────────┐
                 │                 │
                READ           REPORT_GENERATE
                 │                 │
                 ▼                 ▼
          GitLab / GitManager   Report Artifact

                 🚫 DELETE
                 🚫 WRITE
                 🚫 MUTATE
                 🚫 EXECUTE
                 🚫 SHELL
                 🚫 SQL
```

---

## 28. 后续版本方向

Harness 化之后，未来可以安全增加“更聪明”，而不是“更危险”：

### V0.4
- Query planning
- Contribution analysis
- Branch health analysis
- Cross-repository analytics
- Better evidence UI

### V0.5
- Weekly/monthly report generation
- Team summary
- Trend analysis
- Anomaly detection
- Historical comparison

### V0.6+
- Specialized read-only sub-agents
- MCP read-only connectors
- More GitLab data domains
- Long-running analysis
- Scheduled report generation（仅生成，不执行 GitLab 写操作）

无论未来增加多少 Agent 能力，以下边界不变：

> **Agent 永远不能删除、修改 GitLab 业务数据，也不能通过任何通用执行能力间接获得上述权限。**
