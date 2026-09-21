# AGENT.md

本文件记录 GitManager 多轮开发、修复与冒烟验证中沉淀的经验和固定规则。后续会话开始前应先阅读本文件；会话中出现新的通用经验、应用红线或常用验证方法时，应更新到这里。

## 工作流约定

- 每次修改完成后都必须提交 commit 到本地 git。提交前检查 `git status` 和 `git diff`，只提交本次任务相关文件；`.tmp-*`、用户数据、日志、截图和打包产物不要提交。
- 小修改只需要运行类型检查和必要的单元测试。涉及基础功能、状态流转、数据迁移、邮件报告、打包行为或 UI 布局的大修改，必须做冒烟验证、回归验证、黑盒验证和白盒验证。
- 修改基础功能或 UI 布局时，必须在说明中明确影响范围：受影响页面、用户流程、持久化字段、兼容性风险和已执行的验证。
- 不主动重置或回退用户工作区中的无关修改。提交使用简洁的英文 conventional commit 消息，例如 `fix:`、`feat:`、`docs:`、`refactor:`。
- 会话结束时清理临时目录、调试脚本、无效截图和无用文件；确有复用价值的工具脚本应整理后再提交。

## 应用红线

- 应用必须能从启动动效正常进入主界面，不允许空白屏。启动流程或打包行为变化后必须实际启动新产物验证。
- 完整保留启动动效和页面交互动效：不降帧、不隐藏效果、不移动端/低端设备降级、不延迟挂载主背景。可读性问题只允许局部调整对比度、阴影或文字层，不能削弱整体动效。
- Electron 渲染层保持 `sandbox: false`。移除该配置会导致空白屏或功能异常。
- 默认语言使用中文 `zh`，但用户已有显式语言设置不能被强制覆盖。
- Dark 模式的次要文本必须保持可读；调整颜色时优先检查仪表盘、列表和详情页。
- 全局中文生命周期术语只使用：`活跃`、`已停更`、`未提交天数`、`命名不规范`、`清理候选`。
- 用户可见文案中禁止混用 `过期`、`到期`、`陈旧` 作为状态名，以及 `已合并`、`合并`。底层 `merged` 字段可以保留用于数据兼容，但不能作为用户筛选或状态展示。
- 分支筛选统一为问题维度：`所有分支`、`已停更`、`命名不规范`。不要恢复独立的“所有状态/所有问题”双下拉，不要显示 `已合并`。
- 批量邮件按钮与当前筛选互斥：筛选命名不规范时禁用停更创始人通知；筛选停更时禁用命名不规范创始人通知。
- 监控时间单位顺序固定为 `周`、`天`、`小时`、`分钟`，内部换算必须保持一致。新配置默认阈值为 180 天；旧数据只做一次性迁移，不能反复覆盖用户自定义值。
- 基准分支（`main`、`develop`、仓库默认分支）不参与任何生命周期评比：不计已停更、不进清理候选、不进"需要关注"列表。豁免必须落在 `electron/services/branch.ts` 的 `buildFromFacts` 与 `refreshComputed` 两处（共用 `isBaselineBranch`），不要在页面层逐个 filter 打补丁，否则仪表盘、分支列表、邮件、报告、通知会各算一套。
- 用户说"某个分支不该出现在某某列表"时，先查状态字段（`stale` / `state` / `cleanupCandidate`）的产生位置，再查消费位置。只改页面过滤会留下缓存、邮件和报告三条漏网路径。
- 监控页不要单独出现“发送邮件通知”开关。是否通知由“通知自己”“通知分支创始人”等对象开关决定。立即检查必须使用当前表单配置，结束后不能用数据库旧配置回灌表单。
- Git API Token、设置项和仓库配置必须持久化。重启、重进页面或连接成功后应回填已保存值；Token 默认掩码展示，可手动切换可见性。
- 报告格式只保留 `HTML` 和 `CSV`。报告成功后要显示或提供定位完整文件路径的能力。
- 设置页必须保留「配置导入 / 导出」（`electron/services/configPort.ts`）。导出覆盖单行表 `app_settings`、`monitoring_rules`、`email_config`，集合表 `monitoring_rules_repo`、`branch_naming_rules`、`whitelist`、`protected_branches`、`email_groups`、`email_templates`、`scheduler_jobs`、`report_schedules`、`repositories`，以及渲染层的动效开关和语言。换机导入后配置必须与原机一致。
- 配置导出绝不能写出敏感列：`gitlab_api_key`、`remote_api_key`、`password_encrypted` 由 `SENSITIVE_COLUMNS` 统一拦截，导入时保留本机原值，`gitlab_has_key` 按本机实际情况重算。新增表或列时必须同步维护这张清单。
- 换机导入后必须显式提示哪些凭据没跟过来：远程仓库 `remote_api_key` 为空和全局 `gitlab_api_key` 为空时，`importFromFile` 会把仓库名清单和全局提示写进中文 warnings。否则用户会以为导入失败或仓库连不上。
- 导入是「覆盖式」操作：必须先弹覆盖确认框，再执行 `pruneOrphans()` 清理指向未导入仓库的 `branches`/`scheduler_jobs`/`report_schedules`/`monitoring_rules_repo` 记录，并在 `active_repository_id` 失效时回落到第一个仓库。用户可见提示走中文 warnings。
- 邮件正文和 HTML 报告结构保持与参考项目 `oucheer/git-management` 一致，但品牌与状态术语使用 GitManager 的统一文案。
- 命名规则说明必须完整覆盖前缀、小写、无空格、无连续斜杠、不以 `/` 或 `-` 开头、前缀后描述、`main`/`develop` 豁免，以及中文分支需要 regex/unicode 规则的场景。
- 定时调度周期支持 `周`、`天`、`小时`、`分钟`；内部存储保持分钟字段兼容。
- 界面语言必须全局一致：托盘菜单、侧边栏分组标题、筛选按钮、设置卡片标题等所有用户可见文本都必须走 `tr()`，不允许硬编码英文。托盘菜单语言跟随 `settings.language`，保存设置后立即重建菜单。
- 关闭窗口与托盘驻留要分离：`trayEnabled` 只影响“关闭时隐藏到托盘”，用户从托盘选择“退出”或系统退出时必须能真正结束进程。

## 构建与打包

- 对齐邮件正文和 HTML 报告结构时使用的参考项目克隆在 `.tmp-git-management-ref/`（`oucheer/git-management`，Python 版 BranchGuardian，约 0.8MB，已被 `.gitignore` 忽略）。不要提交它，也不要把它当成 GitManager 的源码。

- 常用命令：
  - 类型检查：`npm run typecheck`
  - 单元测试：`npm run test -- --run`
  - 完整打包：`npm run package`
  - 快速本地验证：`npm run package:dir`
- 完整打包输出位于 `release/`，安装包为 `GitManager-<version>-x64.exe`，便携包为 `GitManager-Portable-<version>.exe`。
- 验证打包结果时不要只看构建成功日志，要确认新 exe 的时间戳和体积；`release/win-unpacked/GitManager.exe` 更适合快速启动冒烟。
- 空白屏类问题必须在真实打包产物中验证，不能只依赖 dev server。用户重复出现空白屏时，先确认运行的确实是最新的安装包或便携包。

## 冒烟与回归验证

- 大修改按四个层次验证：
  1. 白盒验证：类型检查、单元测试、关键 IPC/数据迁移/配置回灌路径代码走查。
  2. 黑盒验证：按用户路径操作页面，不依赖实现细节。
  3. 冒烟验证：隔离用户数据目录启动新包，遍历主要路由，确认不空白、主内容渲染、术语正确。
  4. 回归验证：覆盖之前修复过的缺陷，尤其是动效、术语、筛选、监控配置、通知开关、报告文件和 Token 持久化。
- Electron 单实例锁会阻止第二个实例。冒烟测试必须设置独立的 `GITMANAGER_USER_DATA_DIR`，例如使用 `.tmp-gitmanager-smoke/userdata`，并通过 `--remote-debugging-port=9335` 连接 CDP。
- 冒烟启动用 `scripts/run-smoke.ps1`（隔离 userdata、`-WindowStyle Hidden`、打印 PID 与 CDP 地址），随后跑 `node scripts/smoke-cdp.mjs`。`run-smoke.ps1` 里的 `$env:GITMANAGER_USER_DATA_DIR` 只对子进程生效，不要指望它改变当前 shell 之后的行为。
- Node 24 自带全局 `WebSocket`，可以直接连接 CDP，不需要为冒烟脚本额外安装依赖。
- 这个应用的 `Page.captureScreenshot` 可能被 3D 场景阻塞或挂起。视觉截图优先使用系统级窗口截图，例如 PowerShell `CopyFromScreen`，不要把 CDP 截图作为唯一手段。
- 冒烟脚本应抓取路由完整 `innerText`，扫描禁止术语和重复开关，并检查关键控件的选中值。截图只能确认视觉布局，不能替代文本检查。
- 冒烟实例不要直接批量杀 GitManager 进程，可能误伤用户已打开的实例。只关闭由独立用户数据目录启动、可识别的冒烟进程。
- 截图只能证明视觉布局，锁屏或后台窗口会让 `CopyFromScreen` 拍到无关画面。此时改用产物字符串校验做白盒确认：直接在 `release/win-unpacked/resources/app.asar` 中搜索本次新增的中文文案或 CSS 变量值，命中即说明修复真的进入了安装包。
- 用户报告“已修复但现象仍在”时，第一步比对 exe 时间戳与对应 commit 时间戳。产物早于 commit 说明运行的不是新包，不要先怀疑代码。

## 代码搜索与验证工具

- 仓库里 `rg` 对中文模式偶尔会长时间无输出甚至卡住；查中文文案优先用 `rg -n -F "关键词"`，或用 `Select-String -SimpleMatch`。多文件大范围搜索要有超时预期。
- 打包产物的字符串校验很慢（单个关键词 `Select-String` 在 `app.asar` 上可能耗时 30s~2min）。一次批量查多个关键词，不要逐个开进程。
- 打包产物字符串校验优先用 `node scripts/asar-check.cjs`：它用 `@electron/asar` 直接读取归档内的 `out/main/index.js` 和 `out/renderer/assets/*.js`，一次校验托盘中文标签、`isQuitting` 守卫、标语术语和禁止术语，比 `Select-String` 快很多。新增用户可见文案后把关键词补进该脚本的 `needles`。
- `asar-check.cjs` 分两组断言：主进程 `needles` 只放 `electron/` 下会打进 `out/main/index.js` 的文案与 IPC 通道名，渲染层文案放在末尾单独一组。把只存在于 `src/` 的界面文案写进主进程 `needles` 会得到假 FAIL，不要靠改产品代码去迁就脚本。
- `@electron/asar` 的 `listPackage` 返回以反斜杠开头的路径（如 `\out\main\index.js`），但 `extractFile` 要用 `path.join('out','main','index.js')` 这种不带前导分隔符的写法，否则报 `was not found in this archive`。另外 `renderer` 这个子串会命中 `node_modules/three` 里的 `renderers` 目录，匹配渲染产物必须锚定 `\out\renderer` 前缀。
- 托盘菜单与退出路径的黑盒验证：先跑 `scripts/run-tray-probe.ps1`（用 dev runtime 启动并开放 `--inspect=9338` 与 `--remote-debugging-port=9339`），再跑 `node scripts/tray-probe.mjs 9338 9339`。打包产物关闭了 `EnableNodeCliInspectArguments`，`--inspect` 在正式包上不可用，必须用 dev runtime 验证主进程行为。
- 关闭窗口行为分两种情况，都要验证：`trayEnabled=true` 时关窗口只隐藏（托盘退出仍要能真正结束进程），`trayEnabled=false` 时关掉最后一个窗口必须结束进程。用 `scripts/close-window-probe.mjs 9338 9339` 覆盖后者。
- dev runtime 复用同一个 userdata 目录时，上一次异常退出残留的 `DevToolsActivePort` 会让渲染进程调试端口起不来（9339 连接被拒，只剩主进程 inspector）。验证前确认上一个实例已退出，或换一个全新的 `.tmp-*` userdata 目录。
- `win.close()` / `win.isDestroyed()` 是异步的：调用后立刻判断会得到“窗口仍存在”的假失败，必须轮询等待窗口销毁。

## 常见坑

- `tr(key)` 直接读取 `useAppStore.getState().language`，它本身不产生订阅。只在 `Settings` 页调用 `setLanguage` 而不让根组件订阅 `language`，会出现“切到中文但页面仍是英文”。根组件必须订阅 `language`（本项目用 `<Routes key={language}>` 强制重挂载路由树）才能让所有页面刷新文案。
- 分支创始人的中文称谓全局统一为 `分支创始人`，不要再用 `创建人`、`创建者`、`作者` 等混用词。涉及位置：分支列表列头与整行单元格、分支详情抽屉、报告 HTML 表头、审计动作标签、监控页说明、`i18n.creator` / `notifyBoth` / `notifyCreators`。邮件正文与附件早已使用 `分支创始人`，改文案时以邮件为基准对齐。
- 分支列表的列顺序是「分支名 → 分支创始人 → 类别 → 未提交 → 健康分 → 保护 → 操作」，表头与 `ExplorerRow` 必须共用同一个 `ROW_GRID` 网格模板（不要一个用 flex、一个用 grid），两边列数错一个都会整体错位。
- 表头必须放在同一个 `overflow-y-auto` 容器里用 `sticky top-0`（不透明背景 + `z-10`）。放在容器外面时，垂直滚动条会把行的可用宽度挤掉约 10px，而没有滚动条的表头不会收缩，结果是前半段对齐、后半段整体右移，看起来像「列没对齐」。
- Tailwind 颜色只在 `tailwind.config.js` 的 `theme.extend.colors` 里注册。历史上把 `--surface-elevated` 写成 `bg-surface-elevated`，而注册名其实是 `elevated`，导致 8 处（Dashboard/Branches/Animation/Monitoring/Settings）的 `bg-*` 全是无效类，编译后不进 CSS，元素背景静默变成 `rgba(0, 0, 0, 0)`。给 sticky 表头这类必须不透明的元素加背景前，先用 `Runtime.evaluate` 读 `getComputedStyle(el).backgroundColor` 确认真实生效值，别只看类名。
- 校验 Tailwind 类是否真的生成，看 `out/renderer/assets/*.css` 里有没有对应的 `.类名 {` 选择器；改 `tailwind.config.js` 后必须重新 `electron-vite build`。

- `creator.name` 在后端拿不到提交作者时会写成字面量 `'Unknown'`（`electron/services/branch.ts`）。任何展示用户可见文案的地方都要把它映射成 `—` 或 `未知`，不要把英文占位符直接渲染出去。
- 托盘菜单是主进程用 `Menu.buildFromTemplate` 手工构造的，不会随 i18n 自动更新。新增或修改用户可见菜单项时，必须同步维护中英文 label 并在设置保存回调里 `setContextMenu` 重建。
- 窗口 `close` 事件里无条件 `event.preventDefault()` 会拦截 `app.quit()`，表现为点击“退出”后应用关不掉。必须用 `isQuitting` 标志区分“用户关窗口”和“应用退出”。
- 只重建不覆盖安装，会让用户继续打开旧副本，表现成“重新打包后仍然空白”。必须核对产物时间戳并明确用户应运行的新包路径。
- `npm run package` 会在打包前清空并重写 `release/win-unpacked/`。只要有旧实例还在从该目录运行，就会报 `EBUSY: resource busy or locked, unlink 'release\win-unpacked\icudtl.dat'`。打包前先确认并退出 `release\win-unpacked\GitManager.exe` 实例；不要再三重复尝试，先解决文件锁。
- `npm run package` 偶发在 `after-pack.cjs` 的 `rcedit --set-icon` 步骤失败退出，但 `release/win-unpacked/` 已经写入了 Electron 本体。这种失败是文件句柄/杀软扫描的瞬时占用，不是配置错误：先手动执行 `.\node_modules\rcedit\bin\rcedit-x64.exe release\win-unpacked\GitManager.exe --set-icon build\icon.ico` 确认返回 0，再重跑 `npm run package` 即可通过。重跑后务必核对 `release/*.exe` 时间戳晚于本次 commit。
- 概念相似但文案不同的生命周期状态，会在仪表盘、分支列表、分支详情、报告、邮件、审计导出中出现不一致。文案修改要用仓库级搜索收尾。
- 配置回灌是高危路径：立即检查、表单刷新或页面重新加载时把数据库旧值写回表单，会让用户误以为开关或默认值被自动重置。
- 报告文件存在但用户找不到，等同于功能失败。新增或修改报告输出时必须验证真实磁盘路径。
- UI 截图中看不出交互逻辑，分支筛选、批量通知、立即检查和报告导出必须实际触发到状态变化或文件落盘才算通过。
- 冒烟启动脚本以隐藏窗口运行时，`Page.captureScreenshot` 可能永远不返回（没有合成帧），表现为脚本挂起而不是报错。这种实例改用 `Runtime.evaluate` 抓 DOM 文案，或改用可见窗口 + 系统级截图；不要把 CDP 截图当作隐藏窗口下的验证手段。
- 全局文字颜色集中在 `src/styles/index.css` 的 `--fg` 与 `--muted` 两个 token，页面文本几乎都经由 `text-muted`、`text-canvas-fg`、`.btn`、`.input` 派生。调暗色模式亮度只改这两个变量，并确认 `html.light` 有对应覆盖，避免连带改坏亮色主题。
- 报告 HTML 属于用户可见产物，不能直接输出底层英文枚举（`active` / `stale` / `valid`）。`electron/services/report.ts` 用 `reportStateLabel` / `reportNamingLabel` 做映射，新增状态枚举时同步补齐。
- 创始人邮件的表格必须带仓库列，且正文要点明仓库名：同一创始人可能横跨多个远程仓库，只给分支名等于没告诉对方是哪个仓。期限提示统一由 `processingDeadlineNotice()` 输出，改文案只需改这一处。
- 附件 HTML 报告（`buildBranchEmailHtml`）的三个明细列表按仓库分组渲染：组标题条（`仓库：xxx`）在最前面，表内不再保留「仓库」列。分组逻辑集中在 `groupedTables()`，新增列表复用它，不要退回逐行仓库列。创始人邮件正文表格（`scenarioRowsTable`）仍保留仓库列，两者是不同载体，不要互相「统一」掉。
- 附件 HTML 里的分支名可能很长（`feature/...`），必须用 `table-layout:fixed` + `<colgroup>` 固定列宽 + `word-break:break-all`，否则表格会横向撑出外层白色卡片。渲染分支名的单元格统一走 `branchCell()`。
- 邮件/报告排版改动属于黑盒可见产物，验证方式：`.\node_modules\.bin\vite-node scripts\preview-emails.ts` 生成 `out/email-previews/*.html`，然后用 `rg -F` 检查分组标题、表头不含「仓库」、`table-layout:fixed` 是否命中。`scripts/preview-emails.ts` 里保留了一条超长分支名样例，专门用于复现溢出回归。

## 远程分支创始人归因

- 分支创始人**绝不能**兜底成基准分支最后一次提交的作者。历史上 `analyzeGitLabBranch()` 用「默认分支最近 500 个 SHA 做差集」推断创始人，新建且未提交的分支差集为空，于是回填了基准分支的最后提交人。这不只是显示错误：`electron/services/email.ts` 按 `creatorEmail` 分组发信，`monitoring.ts` 不校验 `confidence`，**邮件会真的发给无关的人**。
- 归因顺序固定为三级，集中在 `resolveRemoteCreator()`（`electron/services/branch.ts`，已导出以便单测）：
  1. 分支第一个自有提交 → `confidence: high`，带邮箱，权威来源；
  2. 平台的分支创建事件（仅 GitLab）→ 有邮箱 `high`，无邮箱 `medium`（名字对但**不可发信**）；
  3. 都没有 → `unknown`，宁可不显示也不猜。
- `confidence !== high` 或邮箱为空时，创始人邮件必须跳过。`medium` + 无邮箱在分支详情抽屉显示「未公开邮箱」说明卡，`unknown` 显示「无法确定分支创始人」说明卡。
- 分支「自有提交」用 `compareCommits(projectId, defaultBranch, branchName)` 获取，**索引 0 就是分支第一个自有提交**（GitHub `/compare/base...head` 与 GitLab `/repository/compare?from=&to=` 都是 oldest-first）。不要退回本地差集启发式：差集分不清「分支没有提交」和「基准分支提交超出抓取窗口」两种情况。
- GitLab 的 `/projects/:id/events?action=pushed` 是**唯一**能查到「无提交分支的创建人」的接口：`push_data.action === "created" && push_data.ref_type === "branch"`，`commit_count` 可以是 0。GitHub REST **没有**等价端点（`CreateEvent` 不出现在 `/repos/:o/:r/events`，实测 3 个仓库 100 条事件为 0 条），所以 `listBranchCreators()` 对非 GitLab 直接返回空 Map 且**不发请求**。
- GitLab 事件的三个已知限制，不要当成 bug：① `author.public_email` 经常为空（实测 8 个创建者里 7 个为空）；② 事件有保留窗口（大仓库 400 条事件只覆盖约 10 小时），老分支查不到属正常，`listBranchCreators()` 失败或为空必须降级为空 Map 而不是抛错；③ 一次扫描只请求一次，不要按分支循环调 events。
- 归因语义变更时必须同时 bump 分支缓存 key（`v3` → `v4`，`electron/services/branch.ts` 的 `cacheContentKey`），否则库里旧快照会继续返回错误创始人。

## Git 工作流

- **提交前先确认当前分支**：`git rev-parse --abbrev-ref HEAD`。本项目多次出现 HEAD 被切到 `pantum` 而非 `main`，导致 commit 落在错误分支上。发现错位后用 `git checkout main` + `git merge --ff-only <branch>` 归位（提交已在远程 `pantum` 上时也能快进），不要用 rebase 改写已推送历史。
- 用户要求「推送到远程 + tag 最新 commit」时，先 `git log --oneline <tag>..HEAD` 确认 tag 是否落后，再 `git tag -f V0.1.x <sha>` 并 `git push origin main --follow-tags`（或 `git push -f origin V0.1.x`）。
- **绝不要按进程名批量杀 `GitManager.exe` / `electron.exe`**。用户可能同时开着自己的实例，`Get-CimInstance ... | Stop-Process` 会连带杀掉它。只终止自己能识别的目标：核对 `CommandLine` 里的 `--user-data-dir` 是否指向 `.tmp-*` 冒烟目录，或直接用 `scripts\run-smoke.ps1` 打印的 PID 加 `taskkill /PID <pid> /T`。
- `npm run package` 前必须先确认没有实例占用 `release\win-unpacked\`：`Get-CimInstance Win32_Process -Filter "Name='GitManager.exe'"` 看 `CommandLine`，指向 `release\win-unpacked` 的才是需要退出的，`.tmp-*\userdata` 的是冒烟实例。
- 工作区长期存在几个无关未跟踪文件（`GitManager-使用手册.docx`、`~$anchPulse-使用手册.docx`、`docshots/`），提交时不要 `git add -A`，按路径显式添加。

## 定时调度

- `scheduler_jobs` 是**全局表**，`listJobs()` 不带仓库过滤，`tick()` 每 30s 让所有 `enabled` 任务运行。因此调度页**不能**按 `activeRepositoryId` 过滤显示，否则会出现「任务在别处轮询发邮件但 UI 完全看不到」。当前实现：显示全部任务、按「本仓库优先」排序、非当前仓库的任务用 `text-warn` 高亮仓库名。
- 托盘「暂停监控」必须作用于全部任务（`setAllEnabled()`），只改第一个 enabled 任务会让其余任务继续发信。
- 「删除全部定时任务」走 `deleteAllJobs()`：`DELETE FROM scheduler_jobs WHERE 1 = 1` + 审计 `scheduler_jobs_deleted_all`，UI 侧必须用 `ConfirmCheckbox` 二次确认（未勾选时确认按钮 disabled）。
- 配置导入会整表带入别的机器的 `scheduler_jobs`（`configPort.ts`），`pruneOrphans()` 只在仓库不存在时清理，所以跨机导入后残留任务需要用户手动一键删除——这是该功能存在的理由。
