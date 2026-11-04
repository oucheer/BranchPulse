# GitManager

GitManager 是一个 Git 分支生命周期监控与管理应用，用于帮助团队识别长期未提交（已停更）分支、命名不规范分支和清理候选，并支持通知、报告和审计追踪。

当前版本是 **Web 版**：后端是本机 Node 服务，界面在浏览器中打开。功能、操作、设置与 UI 布局与桌面版保持一致，差异只出现在浏览器物理边界（原生目录对话框、托盘等），详见 `docs/web-port.md`。

## 功能概览

- **仪表盘**：展示整体健康度、仓库数量、分支总数、命名合规率、活跃与已停更状态分布、最近巡检结果。
- **仓库管理**：连接远程 Git 托管平台，读取仓库与分支数据。
- **分支管理**：按所有分支、已停更、命名不规范筛选，并支持按分支组（创始人）筛选、批量通知和详情查看。
- **监控**：配置未提交阈值、命名校验、桌面通知和邮件通知，支持立即检查和只检查指定分支组。
- **命名规则**：配置前缀、regex/unicode 规则，验证常用分支命名和中文分支命名。
- **通知**：查看巡检提醒、邮件通知记录和异常结果。
- **报告**：生成 HTML 或 CSV 报告（可按分支组限定统计范围），并提供文件定位能力。
- **定时调度**：按周期自动巡检、生成报告或发送通知，可只检查指定分支组。
- **审计日志**：记录关键配置、规则、清理和通知操作。

## 技术栈

- Node.js 20+（后端运行时）
- React 18
- TypeScript
- Vite（渲染层构建）+ esbuild（后端打包）
- Tailwind CSS
- Zustand
- sql.js
- Three.js、OGL（启动动效）

## 快速开始

要求本机已安装 Node.js 和 npm。

```bash
npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:4173`。开发模式下渲染层走 Vite HMR，后端改动会自动重新打包并重启进程，两者共用同一端口。

生产模式：

```bash
npm run build
npm start
```

`npm run build` 产出 `dist/renderer`（前端资源）与 `dist/server/index.cjs`（后端 bundle），`npm start` 启动后端并在同一端口同时提供 API 与静态资源。

端口与监听地址可用环境变量覆盖：`GITMANAGER_PORT`（默认 `4173`）、`GITMANAGER_HOST`（默认 `127.0.0.1`）。

> **默认只监听 `127.0.0.1`**，即只有本机能访问。部署到服务器供他人访问时必须显式指定：
>
> ```bash
> GITMANAGER_HOST=0.0.0.0 npm start
> ```
>
> 否则浏览器访问 `http://<服务器IP>:4173` 会连接被拒绝（服务本身运行正常，只是没有对外监听）。

内网/离线环境部署的完整步骤见 [docs/internal-deployment.md](docs/internal-deployment.md)。

### Linux 服务端 AI 密钥

无桌面环境的 Node 服务不需要系统密钥库。部署时生成一次 AES-256 密钥，并将其固定保存在服务的受保护环境配置中：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
export GITMANAGER_ENCRYPTION_KEY='<上一步生成的64位十六进制字符串>'
# 连接内网模型时由服务器管理员显式开启
export GITMANAGER_AI_ALLOW_PRIVATE_NETWORK=1
npm start
# 也可以直接运行 node dist/server/index.cjs
```

以上变量必须传入实际运行 Node 的进程。使用 systemd 时写入权限为 `0600` 的 `EnvironmentFile`，修改后重启服务；仅在交互式终端 export 不会更新已运行的服务。应用不会自动读取项目根目录的 `.env`。

密钥用于 AES-256-GCM 加密，API 配置按登录用户分别持久化，浏览器只读取是否已保存密钥。请备份并长期保留同一密钥，不要每次启动重新生成；丢失或更换后需要重新填写原有凭据。已有 Windows DPAPI 密文不能直接移到 Linux 解密，需要重新填写。不要提交真实密钥或将其写入前端环境变量。

### 用户隔离

应用使用共享数据库：仓库目录与命名规则由管理员维护并供团队只读查看。普通用户分支列表仅显示本人的分支；界面偏好、仓库选择、AI 配置及对话按会话确定的身份隔离。普通用户不可读取管理员邮件配置、审计、通知、调度记录、备份和团队报告。注销后服务器会撤销当前会话令牌，不影响其他已登录会话。

## 常用命令

```bash
npm run dev        # 开发模式（Vite HMR + 后端热重启，单端口）
npm run build      # 构建渲染层与后端产物
npm start          # 运行已构建的后端
npm run typecheck  # 渲染层 + 后端的 TypeScript 检查
npm run test       # vitest 单元测试
npm run smoke      # Web 冒烟测试（需先 npm run build）
npm run build:icon # 重新生成品牌图标
```

`npm run smoke` 会用独立的临时数据目录启动构建产物，再用无头 Chromium 遍历所有路由，检查页面渲染、术语与关键开关。可用 `GITMANAGER_BROWSER` 指定浏览器可执行文件。

## 数据目录

后端沿用桌面版的用户数据目录规则，升级后数据无需迁移：

| 平台 | 用户数据目录 |
| --- | --- |
| Windows | `%APPDATA%\gitmanager` |
| macOS | `~/Library/Application Support/gitmanager` |
| Linux | `$XDG_CONFIG_HOME/gitmanager` |

- 数据库：`<userData>/data/gitmanager.db`
- 报告：`<userData>/data/reports`
- 备份：`<userData>/data/backups`
- 日志：`<userData>/logs`

可用 `GITMANAGER_USER_DATA_DIR`、`GITMANAGER_DATA_DIR`、`GITMANAGER_PORTABLE=1` 覆盖。

## 术语约定

应用内统一使用以下中文术语，避免同义混用：

- `活跃`
- `已停更`
- `未提交天数`
- `命名不规范`
- `清理候选`

底层的 `merged` 字段可以保留用于数据兼容，但不要在用户可见筛选、状态、报告或导出中显示“已合并”。

## 项目结构

```text
src/                React 渲染层（浏览器）
  components/       通用 UI 组件
  design-system/    设计系统组件
  lib/              工具函数、i18n、桥接 HTTP/SSE、格式化
  pages/            主要页面
  shell/            应用壳层、侧边栏与命令面板
  stores/           全局状态与数据加载
src-node/           浏览器无关的后端（Node）
  api.ts            传输无关的 API 实现
  services/         业务服务
  utils/            paths / logger / ids / secrets / open / folders
server/             HTTP + SSE 服务入口
  http.ts           静态资源、RPC、SSE、下载路由
  rpc.ts            方法派发与参数校验
  services.ts       服务装配与生命周期
shared/             前后端共享类型与 RPC 契约
scripts/            开发、构建、冒烟与工具脚本
tests/              单元测试
docs/               迁移与设计说明
```

`src/` 由 `tsconfig.json` 检查，`src-node/`、`server/`、`shared/` 由 `tsconfig.node.json` 检查。

## 验证建议

1. 执行 `npm run typecheck`。
2. 执行 `npm run test`。
3. 执行 `npm run build`，随后 `npm run smoke`。
4. 启动 `npm start`，确认启动动效后进入主界面。
5. 遍历仪表盘、仓库、分支、监控、命名规则、白名单、备份、通知、报告、定时调度、审计日志和设置页面。
6. 修改监控、通知、报告、Token 或仓库配置后重启服务并刷新页面，确认数据仍然保留。
7. 检查生成的报告文件能否在磁盘上定位到完整路径。
