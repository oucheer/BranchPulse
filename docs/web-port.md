# GitManager Web 迁移方案

本文记录把 GitManager 从 Electron 桌面应用迁移为 **Web 应用**（本机 Node 服务 + 浏览器）的设计约束与取舍。

## 目标

- 功能、操作、设置、UI 布局与桌面版保持一致。
- 渲染层（`src/`）尽量不动：只把 `window.gitmanager` 这一层从 Electron IPC 换成 HTTP/SSE。
- 业务逻辑只存在一份：原 `electron/ipc.ts` 里的 handler 主体迁到传输无关的 `src-node/api.ts`，HTTP 路由只是它的一个适配器。
- 迁移后移除 Electron：主进程、预加载、托盘、单实例锁、electron-builder 打包脚本全部删除。

## 目录结构

```
src/             React 渲染层（浏览器）
src-node/        浏览器无关的后端（Node）
  api.ts         传输无关的 API 实现（含原 ipc.ts 的 handler 主体）
  services/      业务服务（原 electron/services）
  utils/         paths / logger / ids / secrets / open / folders
server/          HTTP + SSE 服务入口（web 后端）
  http.ts        静态资源 / RPC / SSE / 下载路由
  rpc.ts         方法派发（EXPOSED_METHODS 白名单）
  services.ts    服务装配与生命周期
shared/          前后端共享类型（GitManagerApi 契约）与 RPC 契约
```

`src-node/` 与 `server/` 都由 `tsconfig.node.json` 检查，`src/` 由 `tsconfig.json` 检查。

## 启动方式

| 模式 | 命令 | 说明 |
| --- | --- | --- |
| 开发 | `npm run dev` | esbuild 打包后端并启动；后端以 `--dev` 内嵌 Vite（middleware mode），渲染层 HMR 与 API/SSE 同源同端口 |
| 生产 | `npm run build` + `npm start` | `dist/renderer` 由 `server/http.ts` 直接托管，`dist/server/index.cjs` 是后端 bundle |

默认 `http://127.0.0.1:4173`，可用 `GITMANAGER_PORT` / `GITMANAGER_HOST` 覆盖。

`GITMANAGER_HOST` 默认 `127.0.0.1`，只绑定回环地址。跨机访问（部署到服务器、虚拟机或容器里由其他机器打开页面）必须改成 `0.0.0.0`，并按需放行防火墙端口。启动日志会打印实际监听地址；只在回环上监听时会额外提示需要设置 `GITMANAGER_HOST=0.0.0.0`。内网部署的完整清单见 [internal-deployment.md](internal-deployment.md)。

> dev 模式下 Vite 必须用 `appType: 'spa'`。`custom` 不会安装 HTML fallback 与 index-HTML 中间件，`GET /` 会 404。

## 传输层对比

| 能力 | 桌面版（迁移前） | Web 版（迁移后） |
| --- | --- | --- |
| API 调用 | `ipcRenderer.invoke` | `POST /api/rpc/<method>`，body 为参数数组 |
| 扫描进度 / 托盘导航 | `webContents.send` | `GET /api/events`（SSE） |
| 选择目录 | `dialog.showOpenDialog` | `GET /api/fs/folders` + 页内目录选择弹窗 |
| 打开文件夹 / 定位文件 | `shell.openPath` / `showItemInFolder` | `POST /api/fs/open`（服务端资源管理器） |
| 配置导入 | `dialog.showOpenDialog` + `showMessageBox` | 浏览器文件选择 + 页内覆盖确认框 + `importConfig(filePath, true)` |
| 配置 / 审计导出 | `dialog.showSaveDialog` | 页内目录选择弹窗 + `exportConfig(extras, filePath)` / `exportAuditLogs(format, dir)` |
| 报告查看 | `shell.openPath` | 服务端定位文件 + `GET /api/reports/:id/download` 下载 |
| 应用版本 | `app.getVersion()` | 服务端读 `package.json` |
| 关窗 / 托盘 / 开机自启 | Electron 专有 | 无对应概念，设置项保留但标注“桌面版专有” |

## 数据目录

`src-node/utils/paths.ts` 复刻原 `app.getPath('userData')` 的解析规则，**默认目录与桌面版一致**，升级后数据无感迁移：

| 平台 | 用户数据目录 |
| --- | --- |
| Windows | `%APPDATA%\gitmanager` |
| macOS | `~/Library/Application Support/gitmanager` |
| Linux | `$XDG_CONFIG_HOME/gitmanager`（缺省 `~/.config/gitmanager`） |

覆盖方式与桌面版相同：`GITMANAGER_USER_DATA_DIR`（用户数据根目录）、`GITMANAGER_DATA_DIR`（数据目录）、`GITMANAGER_PORTABLE=1`（相对当前工作目录）。

- 数据库：`<userData>/data/gitmanager.db`
- 报告：`<userData>/data/reports`
- 备份：`<userData>/data/backups`
- 日志：`<userData>/logs`

## 凭据加密

桌面版用 Electron `safeStorage`。Web 后端在没有 OS 密钥库可用时，用 **Windows DPAPI**（PowerShell `ProtectedData`，绑定当前用户）加密，语义与 `safeStorage` 一致。

- 后端可注入：`registerSecretBackend()` 可替换为 keytar / KMS 等实现。
- 不可用时回退 `plain:<base64>`，并写 warning 日志（与迁移前行为一致）。
- 既有数据无感：`decryptSecret()` 同时兼容 `safeStorage` 密文与 `plain:` 前缀；DPAPI 无法解开 safeStorage 密文时返回空串，用户重新填写一次 Token 即可。

## 明确的能力差异（浏览器物理边界）

1. **原生目录对话框不存在**：改用页内目录选择弹窗（服务端列目录 + 盘符）。页面按钮与布局不变。
2. **邮件通道改为配置邮箱直发**：不再依赖本机邮件客户端，通知、报告与定时投递统一使用设置页配置的发件邮箱（SMTP 服务器 / 端口 / 用户名 / 密码 / 加密方式），凭据加密保存在本机。
3. **托盘 / 单实例 / 开机自启 / 启动最小化**：浏览器无对应概念。设置项保留在设置页并标注“桌面版专有”，保存值不丢弃。
4. **`shell` 打开文件**：由服务端调用资源管理器，仅在后端与浏览器同机时可见效果。
5. **窗口默认尺寸 1440×920 / 最小 1080×680**：浏览器窗口由用户控制，不做限制。
