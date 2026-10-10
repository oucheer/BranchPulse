# GitManager Agent V0.3 → V0.3.1 Harness 增量优化实施 Prompt

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

