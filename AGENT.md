# AGENT.md

本文件记录 BranchPulse 多轮开发、修复与冒烟验证中沉淀的经验和固定规则。后续会话开始前应先阅读本文件；会话中出现新的通用经验、应用红线或常用验证方法时，应更新到这里。

## 工作流约定

- 每次修改完成后都必须提交 commit 到本地 git。提交前检查 `git status` 和 `git diff`，只提交本次任务相关文件；`.tmp-*`、用户数据、日志、截图和打包产物不要提交。
- 小修改只需要运行类型检查和必要的单元测试。涉及基础功能、状态流转、数据迁移、邮件报告、构建行为或 UI 布局的大修改，必须做冒烟验证、回归验证、黑盒验证和白盒验证。
- 修改基础功能或 UI 布局时，必须在说明中明确影响范围：受影响页面、用户流程、持久化字段、兼容性风险和已执行的验证。
- 不主动重置或回退用户工作区中的无关修改。提交使用简洁的英文 conventional commit 消息，例如 `fix:`、`feat:`、`docs:`、`refactor:`。
- 会话结束时清理临时目录、调试脚本、无效截图和无用文件；确有复用价值的工具脚本应整理后再提交。

## 应用红线

- 应用必须能从启动动效正常进入主界面，不允许空白屏。Web 版的启动动效在 `index.html` 的 `#startup-shell` 与渲染层动画组件里，后端启动/构建流程变化后必须实际启动验证。
- 完整保留启动动效和页面交互动效：不降帧、不隐藏效果、不移动端/低端设备降级、不延迟挂载主背景。可读性问题只允许局部调整对比度、阴影或文字层，不能削弱整体动效。
- 渲染层不得依赖 Electron 专属 API。历史上桌面版需要 `sandbox: false`，迁移到 Web 后这层约束已不存在：所有能力都必须经由 `window.branchpulse` 桥接（`src/lib/bridge.ts` 走 HTTP/SSE），页面里不允许直接 `import electron` 或读取 `process.*`。
- 默认语言使用中文 `zh`，但用户已有显式语言设置不能被强制覆盖。
- Dark 模式的次要文本必须保持可读；调整颜色时优先检查仪表盘、列表和详情页。
- 全局中文生命周期术语只使用：`活跃`、`已停更`、`宽限期内`、`宽限期已过`、`未提交天数`、`命名不规范`、`清理候选`。
- 用户可见文案中禁止混用 `过期`、`到期`、`陈旧`、`宽限期` 作为状态名，以及 `已合并`、`合并`。底层 `merged` 字段可以保留用于数据兼容，但不能作为用户筛选或状态展示。
- 分支筛选统一为问题维度：`所有分支`、`已停更`、`宽限期内`、`宽限期已过`、`命名不规范`。不要恢复独立的“所有状态/所有问题”双下拉，不要显示 `已合并`。
- 批量邮件按钮与当前筛选互斥：筛选命名不规范时禁用停更创始人通知；筛选停更或宽限期状态时禁用命名不规范创始人通知。
- 监控时间单位顺序固定为 `周`、`天`、`小时`、`分钟`，内部换算必须保持一致。新配置默认阈值为 180 天，宽限期为 60 天；旧数据只做一次性迁移，不能反复覆盖用户自定义值。
- 未提交阈值支持**按分支前缀覆盖**：`MonitoringConfig.thresholdRules`（`{ prefix, value, unit }[]`，存在 `monitoring_rules.threshold_rules` / `monitoring_rules_repo.threshold_rules` 的 JSON 文本里）。解析与序列化只有 `src-node/services/branch.ts` 的 `parseThresholdRules()` / `serializeThresholdRules()` 两个出口，匹配规则只有 `effectiveThreshold()` 一个实现，**必须**同时被 `buildFromFacts()` 与 `refreshComputed()` 调用；前缀最长（最具体）者优先，未命中任何规则时回落到全局阈值。新增/修改阈值语义时必须同步改 `fingerprint()`（已含 `thresholdRuleFingerprint()`），否则旧缓存会继续用旧阈值判定。分支实际生效的阈值写进 `BranchSummary.thresholdDays` / `thresholdUnit`，邮件阈值提示由 `MonitoringService.thresholdHint()` 输出。
- 监控页的「提醒宽限期」已按用户要求灰掉：数值与单位输入框 `disabled`，并标注“本页暂不提供调整入口”。底层 `gracePeriodDays` / `gracePeriodUnit` 字段与生命周期判定（`grace_period` / `grace_expired`）**保留不动**，不要顺手删除，也不要恢复可编辑入口，除非用户明确要求。
- 基准分支（`main`、`develop`、仓库默认分支）不参与任何生命周期评比：不计已停更、不计宽限期、不进清理候选、不进"需要关注"列表。豁免必须落在 `src-node/services/branch.ts` 的 `buildFromFacts` 与 `refreshComputed` 两处（共用 `isBaselineBranch`），不要在页面层逐个 filter 打补丁，否则仪表盘、分支列表、邮件、报告、通知会各算一套。
- 应用**不提供任何删除远程分支的能力**（2026-09 移除）。`shared/rpc.ts` 不再暴露 `beginDelete` / `deleteBranch` / `batchDelete`，`DeletionPolicyEngine` 与 `src-node/services/deletion.ts` 已删除，`git.ts` 不再有 `deleteRemoteBranch()` / `deleteLocalBranch()`，监控与巡检只做只读检查。不要重新引入删除按钮、删除策略、`autoDeleteEnabled`、`deletionDisabled` 或任何 `deleted` 运行计数，也不要按“清理候选”自动删分支；「清理候选」只是提示，处置动作由人工在 Git 平台完成。「删除全部定时任务」是调度页的合法功能，不受此约束。
- 用户说"某个分支不该出现在某某列表"时，先查状态字段（`stale` / `state` / `cleanupCandidate`）的产生位置，再查消费位置。只改页面过滤会留下缓存、邮件和报告三条漏网路径。
- 监控页不要单独出现“发送邮件通知”开关。是否通知由“通知自己”“通知分支创始人”等对象开关决定。立即检查必须使用当前表单配置，结束后不能用数据库旧配置回灌表单。
- Git API Token、设置项和仓库配置必须持久化。重启、重进页面或连接成功后应回填已保存值；Token 默认掩码展示，可手动切换可见性。
- 报告格式只保留 `HTML` 和 `CSV`。报告成功后要显示或提供定位完整文件路径的能力。
- **分支组（组名 + 组员）**是全局配置，存在 `email_groups` 表（新增 `members_json` 列存 `{ name, email }[]`，见 `shared/types.ts` 的 `EmailGroupMember`）。归属规则只有一个口径：**分支的分支创始人（人名或邮箱）命中组员即为该组的分支**，实现集中在 `shared/groups.ts` 的 `branchBelongsToGroup()`，前后端必须共用这一份，不要在页面或服务里另写一套 filter。匹配是忽略大小写的精确匹配，**不做模糊匹配**（否则「张三」会命中「张三丰」）。
- 组名作为收件人 token 时的语义是「**只把这个组自己的分支情况发给组员**」，**不是**「把整仓汇总也发给这些人」。`partitionRecipientTokens()`（`shared/groups.ts`）负责把收件人输入拆成「命中的组 + 其余普通收件人」，`MonitoringService.sendSummaryWithGroups()` 与 `ReportScheduleService.tick()` 都必须走它；若把组名直接丢给 `resolveRecipients()`，组员会同时收到整仓汇总和分组邮件两封。只有普通收件人（或 `self`）时才发整仓汇总。
- 组的导出走 `GroupService.exportBranches()`（`src-node/services/groups.ts`），报告格式同样只用 `HTML` / `CSV`，CSV 额外带 `group` 与 `creator_email` 列，落盘到报告目录并写入 `reports` 表，因此在报告页可见可下载。组相关 RPC 是 `exportGroupBranches` / `emailGroupBranches`，新增或改名时两边都要改（`shared/rpc.ts` + `src-node/api.ts` 的 `BranchPulseApi`，`tests/rpcContract.test.ts` 会编译期校验）。
- 设置页必须保留「配置导入 / 导出」（`src-node/services/configPort.ts`）。导出覆盖单行表 `app_settings`、`monitoring_rules`、`email_config`，集合表 `monitoring_rules_repo`、`branch_naming_rules`、`whitelist`、`protected_branches`、`email_groups`、`email_templates`、`scheduler_jobs`、`report_schedules`、`repositories`，以及渲染层的动效开关和语言。换机导入后配置必须与原机一致。
- 配置导出绝不能写出敏感列：`gitlab_api_key`、`remote_api_key`、`password_encrypted` 由 `SENSITIVE_COLUMNS` 统一拦截，导入时保留本机原值，`gitlab_has_key` 按本机实际情况重算。新增表或列时必须同步维护这张清单。
- 换机导入后必须显式提示哪些凭据没跟过来：远程仓库 `remote_api_key` 为空和全局 `gitlab_api_key` 为空时，`importFromFile` 会把仓库名清单和全局提示写进中文 warnings。否则用户会以为导入失败或仓库连不上。
- 导入是「覆盖式」操作：必须先弹覆盖确认框，再执行 `pruneOrphans()` 清理指向未导入仓库的 `branches`/`scheduler_jobs`/`report_schedules`/`monitoring_rules_repo` 记录，并在 `active_repository_id` 失效时回落到第一个仓库。用户可见提示走中文 warnings。
- 邮件正文和 HTML 报告结构保持与参考项目 `oucheer/git-management` 一致，但品牌与状态术语使用 BranchPulse 的统一文案。
- 邮件统一通过设置页配置的发件邮箱（SMTP）直发：`src-node/services/email.ts` 的 `buildTransport()` 是唯一出口，`server`/`port`/`username`/`password`/`from`/`secure`/`tls` 全部来自 `email_config`，密码用 `encryptSecret()` 加密存储且不随配置导出。`secure` 表示连接即 TLS（465），`tls` 表示明文连接上协商 STARTTLS（587）。**不要**恢复本机 Outlook/COM 或任何依赖桌面邮件客户端的发送路径：Web 后端可能跑在没有邮件客户端的机器上，测试页与报告投递必须走同一条通道。
- 设置页的「测试连接」「发送测试邮件」必须带当前表单草稿调用（`testEmailConnection(draft)` / `sendTestEmail(draft)`），否则用户改了服务器或密码却测到旧配置；`EmailConfigDraft`（`shared/types.ts`）就是为此存在的参数类型。
- 命名规则说明必须完整覆盖前缀、小写、无空格、无连续斜杠、不以 `/` 或 `-` 开头、前缀后描述、`main`/`develop` 豁免，以及中文分支需要 regex/unicode 规则的场景。
- 定时调度周期支持 `周`、`天`、`小时`、`分钟`；内部存储保持分钟字段兼容。
- 界面语言必须全局一致：侧边栏分组标题、筛选按钮、设置卡片标题等所有用户可见文本都必须走 `tr()`，不允许硬编码英文。
- （历史桌面版专有）托盘菜单语言跟随 `settings.language`，保存设置后立即重建菜单；关闭窗口与托盘驻留要分离，`trayEnabled` 只影响“关闭时隐藏到托盘”，从托盘退出必须真正结束进程。Web 版没有托盘，设置项保留但标注“桌面版专有”，保存值不丢弃。

## 构建与运行

- 对齐邮件正文和 HTML 报告结构时使用的参考项目克隆在 `.tmp-git-management-ref/`（`oucheer/git-management`，Python 版 BranchGuardian，约 0.8MB，已被 `.gitignore` 忽略）。不要提交它，也不要把它当成 BranchPulse 的源码。
- 应用已经是 Web 版：后端是 `server/` + `src-node/` 打包出的 Node 进程，界面在浏览器里。`electron/`、`electron-vite`、`electron-builder` 和 `release/` 打包流程都已删除，不要再按桌面版的方式构建或验证。
- 常用命令：
  - 类型检查：`npm run typecheck`（`tsconfig.json` + `tsconfig.node.json`）
  - 单元测试：`npm run test`
  - 开发模式：`npm run dev`
  - 构建：`npm run build` → `dist/renderer`（Vite）+ `dist/server/index.cjs`（esbuild）
  - 运行构建产物：`npm start`
  - Web 冒烟：`npm run smoke`
- `npm run dev` 里 Vite 必须以 `appType: 'spa'` 挂载中间件。用 `custom` 时 Vite 既不装 HTML fallback 也不装 index-HTML 中间件，`GET /` 会落到 404，页面根本打不开——这是迁移过程中真实踩过的坑。
- 空白屏类问题必须在 `npm run build` 之后的真实产物中验证（`npm start` + 浏览器），不能只依赖 dev server。
- 后端 bundle 走 CommonJS：`src-node/utils/paths.ts` 靠 `import.meta` 探测失败后回退 `__dirname`，`storage.ts` 也优先按 `__dirname` 找 sql.js 的 wasm。改 esbuild 配置时不要随手切成 ESM。
- 后端关闭要快：`server/http.ts` 的 `close()` 里必须持续轮询 `closeIdleConnections()`（50ms 间隔 + `unref()`），否则浏览器标签开着时 Ctrl+C 会卡满 65s（keep-alive socket 不是立刻变 idle）。

## 冒烟与回归验证

- 大修改按四个层次验证：
  1. 白盒验证：类型检查、单元测试、关键 RPC/数据迁移/配置回灌路径代码走查。
  2. 黑盒验证：按用户路径操作页面，不依赖实现细节。
  3. 冒烟验证：隔离用户数据目录启动构建产物，遍历主要路由，确认不空白、主内容渲染、术语正确。
  4. 回归验证：覆盖之前修复过的缺陷，尤其是动效、术语、筛选、监控配置、通知开关、报告文件和 Token 持久化。
- Web 冒烟用 `npm run build && npm run smoke`（`scripts/smoke-web.mjs`）：它在临时目录里准备独立的 `BRANCHPULSE_USER_DATA_DIR` 与浏览器 profile，用 `BRANCHPULSE_PORT` 起构建产物，再无头 Chromium 走 CDP 遍历 13 条路由并校验术语。脚本自己负责收尾，不会碰用户的真实数据目录。
- Web 版已无单实例锁，但 `BRANCHPULSE_USER_DATA_DIR` 隔离仍然必须保留，否则冒烟会写进用户真实配置。默认端口 `4319`、CDP 端口 `4320`，可用 `BRANCHPULSE_SMOKE_PORT` 覆盖；浏览器可用 `BRANCHPULSE_BROWSER` 指定。
- Node 24 自带全局 `WebSocket`，可以直接连接 CDP，不需要为冒烟脚本额外安装依赖。
- 这个应用的 `Page.captureScreenshot` 可能被 3D 场景阻塞或挂起。需要视觉确认时用系统级窗口截图（PowerShell `CopyFromScreen`），不要把 CDP 截图作为唯一手段；无头浏览器下更不能依赖它。
- 冒烟脚本应抓取路由完整 `innerText`，扫描禁止术语和重复开关，并检查关键控件的选中值。截图只能确认视觉布局，不能替代文本检查。
- 不要按进程名批量杀 `node.exe` / 浏览器进程，可能误伤用户已经开着的实例。只终止自己启动、带明确命令行特征的进程（`dist/server/index.cjs`、`.tmp-*` 的 profile）。
- 需要确认修复是否真的进入产物时，直接对 `dist/server/index.cjs` 和 `dist/renderer/assets/*.js|*.css` 做字符串校验（批量 `Select-String`），比重新拉起界面快。
- 用户报告“已修复但现象仍在”时，第一步比对 `dist/` 产物时间戳与对应 commit 时间戳，并确认浏览器加载的不是缓存。产物早于 commit 说明运行的不是新版本，不要先怀疑代码。

## 代码搜索与验证工具

- 仓库里 `rg` 对中文模式偶尔会长时间无输出甚至卡住；查中文文案优先用 `rg -n -F "关键词"`，或用 `Select-String -SimpleMatch`。多文件大范围搜索要有超时预期。
- 产物字符串校验直接跑 `Select-String -SimpleMatch`，一次批量查多个关键词，不要逐个开进程。后端文案在 `dist/server/index.cjs`，界面文案在 `dist/renderer/assets/*.js`。
- 界面文案与 i18n key 分开看：`src/lib/i18n.ts` 里的中文值会进渲染层 bundle，硬编码在 `src/pages/*.tsx` 里的中文同样会进；只搜其中一个会漏。
- 黑盒验证一律在浏览器里做：`npm start`（或 `npm run dev`）后打开 `http://127.0.0.1:4173`，用 DevTools / CDP 的 `Runtime.evaluate` 读 DOM、触发按钮、核对 `location.hash`。Web 版没有主进程 inspector，也没有托盘或窗口关闭探测脚本可跑。
- 服务端行为（RPC、SSE、静态资源、下载、关闭）的黑盒入口是 HTTP：`POST /api/rpc/<method>`、`GET /api/events`、`GET /api/health`、`GET /api/reports/:id/download`。`tests/httpServer.test.ts` 覆盖了这些路由，改 `server/http.ts` 后必须跑它。
- 关闭服务的行为验证：起一个 `npm start`，用浏览器标签保持连接，再 Ctrl+C，确认进程在 1~2s 内退出而不是卡到 65s。

## 常见坑

- `tr(key)` 直接读取 `useAppStore.getState().language`，它本身不产生订阅。只在 `Settings` 页调用 `setLanguage` 而不让根组件订阅 `language`，会出现“切到中文但页面仍是英文”。根组件必须订阅 `language`（本项目用 `<Routes key={language}>` 强制重挂载路由树）才能让所有页面刷新文案。
- 分支创始人的中文称谓全局统一为 `分支创始人`，不要再用 `创建人`、`创建者`、`作者` 等混用词。涉及位置：分支列表列头与整行单元格、分支详情抽屉、报告 HTML 表头、审计动作标签、监控页说明、`i18n.creator` / `notifyBoth` / `notifyCreators`。邮件正文与附件早已使用 `分支创始人`，改文案时以邮件为基准对齐。
- 分支列表的列顺序是「分支名 → 分支创始人 → 类别 → 未提交 → 健康分 → 保护 → 操作」，表头与 `ExplorerRow` 必须共用同一个 `ROW_GRID` 网格模板（不要一个用 flex、一个用 grid），两边列数错一个都会整体错位。
- 表头必须放在同一个 `overflow-y-auto` 容器里用 `sticky top-0`（不透明背景 + `z-10`）。放在容器外面时，垂直滚动条会把行的可用宽度挤掉约 10px，而没有滚动条的表头不会收缩，结果是前半段对齐、后半段整体右移，看起来像「列没对齐」。
- Tailwind 颜色只在 `tailwind.config.js` 的 `theme.extend.colors` 里注册。历史上把 `--surface-elevated` 写成 `bg-surface-elevated`，而注册名其实是 `elevated`，导致 8 处（Dashboard/Branches/Animation/Monitoring/Settings）的 `bg-*` 全是无效类，编译后不进 CSS，元素背景静默变成 `rgba(0, 0, 0, 0)`。给 sticky 表头这类必须不透明的元素加背景前，先用 `Runtime.evaluate` 读 `getComputedStyle(el).backgroundColor` 确认真实生效值，别只看类名。
- 校验 Tailwind 类是否真的生成，看 `dist/renderer/assets/*.css` 里有没有对应的 `.类名 {` 选择器；改 `tailwind.config.js` 后必须重新 `npm run build`。

- `creator.name` 在后端拿不到提交作者时会写成字面量 `'Unknown'`（`src-node/services/branch.ts`）。任何展示用户可见文案的地方都要把它映射成 `—` 或 `未知`，不要把英文占位符直接渲染出去。
- 浏览器缓存会让用户以为“改了没生效”：静态资源带 hash 无需担心，但 `index.html` 与 RPC 响应必须 `no-store`（`server/http.ts` 已设置）。排查“现象仍在”时先强刷或用无痕窗口。
- 概念相似但文案不同的生命周期状态，会在仪表盘、分支列表、分支详情、报告、邮件、审计导出中出现不一致。文案修改要用仓库级搜索收尾。
- 配置回灌是高危路径：立即检查、表单刷新或页面重新加载时把数据库旧值写回表单，会让用户误以为开关或默认值被自动重置。
- 报告文件存在但用户找不到，等同于功能失败。新增或修改报告输出时必须验证真实磁盘路径。
- UI 截图中看不出交互逻辑，分支筛选、批量通知、立即检查和报告导出必须实际触发到状态变化或文件落盘才算通过。
- 无头浏览器（`--headless=new`）下 `Page.captureScreenshot` 可能永远不返回（没有合成帧），表现为脚本挂起而不是报错。无头冒烟一律改用 `Runtime.evaluate` 抓 DOM 文案；需要看图时另开可见窗口 + 系统级截图。
- 全局文字颜色集中在 `src/styles/index.css` 的 `--fg` 与 `--muted` 两个 token，页面文本几乎都经由 `text-muted`、`text-canvas-fg`、`.btn`、`.input` 派生。调暗色模式亮度只改这两个变量，并确认 `html.light` 有对应覆盖，避免连带改坏亮色主题。
- 报告 HTML 属于用户可见产物，不能直接输出底层英文枚举（`active` / `grace_period` / `valid`）。`src-node/services/report.ts` 用 `reportStateLabel` / `reportNamingLabel` 做映射，新增状态枚举时同步补齐。
- 创始人邮件的表格必须带仓库列，且正文要点明仓库名：同一创始人可能横跨多个远程仓库，只给分支名等于没告诉对方是哪个仓。期限提示统一由 `processingDeadlineNotice()` 输出，改文案只需改这一处。
- 附件 HTML 报告（`buildBranchEmailHtml`）的三个明细列表按仓库分组渲染：组标题条（`仓库：xxx`）在最前面，表内不再保留「仓库」列。分组逻辑集中在 `groupedTables()`，新增列表复用它，不要退回逐行仓库列。创始人邮件正文表格（`scenarioRowsTable`）仍保留仓库列，两者是不同载体，不要互相「统一」掉。
- 附件 HTML 里的分支名可能很长（`feature/...`），必须用 `table-layout:fixed` + `<colgroup>` 固定列宽 + `word-break:break-all`，否则表格会横向撑出外层白色卡片。渲染分支名的单元格统一走 `branchCell()`。
- 邮件/报告排版改动属于黑盒可见产物，验证方式：`.\node_modules\.bin\vite-node scripts\preview-emails.ts` 生成 `out/email-previews/*.html`，然后用 `rg -F` 检查分组标题、表头不含「仓库」、`table-layout:fixed` 是否命中。`scripts/preview-emails.ts` 里保留了一条超长分支名样例，专门用于复现溢出回归。

## 远程分支创始人归因

- 分支创始人**绝不能**兜底成基准分支最后一次提交的作者。历史上 `analyzeGitLabBranch()` 用「默认分支最近 500 个 SHA 做差集」推断创始人，新建且未提交的分支差集为空，于是回填了基准分支的最后提交人。这不只是显示错误：`src-node/services/email.ts` 按 `creatorEmail` 分组发信，`monitoring.ts` 不校验 `confidence`，**邮件会真的发给无关的人**。
- 归因顺序固定为三级，集中在 `resolveRemoteCreator()`（`src-node/services/branch.ts`，已导出以便单测）：
  1. 分支第一个自有提交 → `confidence: high`，带邮箱，权威来源；
  2. 平台的分支创建事件（仅 GitLab）→ 有邮箱 `high`，无邮箱 `medium`（名字对但**不可发信**）；
  3. 都没有 → `unknown`，宁可不显示也不猜。
- `confidence !== high` 或邮箱为空时，创始人邮件必须跳过。`medium` + 无邮箱在分支详情抽屉显示「未公开邮箱」说明卡，`unknown` 显示「无法确定分支创始人」说明卡。
- 分支「自有提交」用 `compareCommits(projectId, defaultBranch, branchName)` 获取，**索引 0 就是分支第一个自有提交**（GitHub `/compare/base...head` 与 GitLab `/repository/compare?from=&to=` 都是 oldest-first）。不要退回本地差集启发式：差集分不清「分支没有提交」和「基准分支提交超出抓取窗口」两种情况。
- GitLab 的 `/projects/:id/events?action=pushed` 是**唯一**能查到「无提交分支的创建人」的接口：`push_data.action === "created" && push_data.ref_type === "branch"`，`commit_count` 可以是 0。GitHub REST **没有**等价端点（`CreateEvent` 不出现在 `/repos/:o/:r/events`，实测 3 个仓库 100 条事件为 0 条），所以 `listBranchCreators()` 对非 GitLab 直接返回空 Map 且**不发请求**。
- GitLab 事件的两个已知限制，不要当成 bug：① 事件有保留窗口（大仓库 400 条事件只覆盖约 10 小时），老分支查不到属正常，`listBranchCreators()` 失败或为空必须降级为空 Map 而不是抛错；② 一次扫描只请求一次，不要按分支循环调 events。
- `author.public_email` 经常为空（实测 8 个创建者里 7 个为空），这不再算限制：`listBranchCreators()` 收集完事件后，对「有 username 但没邮箱」的创建者再查一次 `/users?username=`（`GitLabService.resolveUserEmails()`），取 `public_email`，为空再退到账号 `email`。用户目录是 GitLab 唯一会给出「从未提交过的账号」邮箱的地方，这是需求「分支创始人邮箱拿不到」的修复点。约束：按 `MAX_CREATOR_EMAIL_LOOKUPS`（50）截断，结果按 `<host>|<username 小写>` 缓存在进程内，单个用户查询失败只跳过该用户、不影响扫描，非 GitLab provider 直接返回空 Map。
- 归因语义变更时必须同时 bump 分支缓存 key（当前是 `v5`，`src-node/services/branch.ts` 的 `cacheContentKey`，远程与本地两处），否则库里旧快照会继续返回旧的创始人数据。`v5` 的变更点是创始人邮箱改由 forge profile 补齐。

## Git 工作流

- **提交前先确认当前分支**：`git rev-parse --abbrev-ref HEAD`。本项目多次出现 HEAD 被切到 `pantum` 而非 `main`，导致 commit 落在错误分支上。发现错位后用 `git checkout main` + `git merge --ff-only <branch>` 归位（提交已在远程 `pantum` 上时也能快进），不要用 rebase 改写已推送历史。
- 用户要求「推送到远程 + tag 最新 commit」时，先 `git log --oneline <tag>..HEAD` 确认 tag 是否落后，再 `git tag -f V0.1.x <sha>` 并 `git push origin main --follow-tags`（或 `git push -f origin V0.1.x`）。
- **绝不要按进程名批量杀 `node.exe` / 浏览器进程**。用户可能同时开着真实的 BranchPulse 后端和浏览器，`Get-CimInstance ... | Stop-Process` 会连带杀掉它。只终止自己能识别的目标：核对 `CommandLine` 里是否有 `dist\server\index.cjs` 且 `BRANCHPULSE_PORT` 指向自己用的端口，再用 `taskkill /PID <pid> /T`。
- 端口冲突是 Web 版最常见的“起不来”原因：`netstat -ano | Select-String ":4173"` 找到占用进程，先判断是不是自己上一轮没关干净，不要直接杀用户已开着的服务。
- 工作区长期存在几个无关未跟踪文件（`BranchPulse-使用手册.docx`、`~$anchPulse-使用手册.docx`、`docshots/`），提交时不要 `git add -A`，按路径显式添加。

## 定时调度

- `scheduler_jobs` 是**全局表**，`listJobs()` 不带仓库过滤，`tick()` 每 30s 让所有 `enabled` 任务运行。因此调度页**不能**按 `activeRepositoryId` 过滤显示，否则会出现「任务在别处轮询发邮件但 UI 完全看不到」。当前实现：显示全部任务、按「本仓库优先」排序、非当前仓库的任务用 `text-warn` 高亮仓库名。
- （历史桌面版专有）托盘「暂停监控」作用于全部任务（`setAllEnabled()`），只改第一个 enabled 任务会让其余任务继续发信。Web 版没有托盘入口，`setAllEnabled()` 目前只由单测覆盖，但语义约束仍然成立：任何批量启停都必须覆盖全部任务。
- 「删除全部定时任务」走 `deleteAllJobs()`：`DELETE FROM scheduler_jobs WHERE 1 = 1` + 审计 `scheduler_jobs_deleted_all`，UI 侧必须用 `ConfirmCheckbox` 二次确认（未勾选时确认按钮 disabled）。
- 配置导入会整表带入别的机器的 `scheduler_jobs`（`configPort.ts`），`pruneOrphans()` 只在仓库不存在时清理，所以跨机导入后残留任务需要用户手动一键删除——这是该功能存在的理由。
