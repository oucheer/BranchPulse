# BranchPulse

BranchPulse 是一个 Git 分支生命周期监控与管理桌面应用，用于帮助团队识别长期未提交分支、宽限期状态、命名不规范分支和清理候选，并支持通知、报告和审计追踪。

## 功能概览

- **仪表盘**：展示整体健康度、仓库数量、分支总数、命名合规率、活跃与宽限期状态分布、最近巡检结果。
- **仓库管理**：连接远程 Git 托管平台，读取仓库与分支数据。
- **分支管理**：按所有分支、已停更、宽限期内、宽限期已过、命名不规范筛选，并支持批量通知和详情查看。
- **监控**：配置未提交阈值、提醒宽限期、命名校验、桌面通知和邮件通知，支持立即检查。
- **命名规则**：配置前缀、regex/unicode 规则，验证常用分支命名和中文分支命名。
- **通知**：查看巡检提醒、邮件通知记录和异常结果。
- **报告**：生成 HTML 或 CSV 报告，并提供文件定位能力。
- **定时调度**：按周期自动巡检、生成报告或发送通知。
- **审计日志**：记录关键配置、规则、清理和通知操作。

## 技术栈

- Electron
- React 18
- TypeScript
- Vite / electron-vite
- Tailwind CSS
- Zustand
- sql.js
- Three.js、GSAP、Recharts

## 快速开始

要求本机已安装 Node.js 和 npm。

```bash
npm install
npm run dev
```

## 常用命令

```bash
npm run typecheck
npm run test -- --run
npm run build
npm run package:dir
npm run package
npm run package:portable
```

## 打包产物

完整打包输出位于 `release/`：

- Windows 安装包：`BranchPulse-<version>-x64.exe`
- Windows 便携版：`BranchPulse-Portable-<version>.exe`
- 快速本地验证产物：`release/win-unpacked/BranchPulse.exe`

打包或发布前必须运行类型检查和单元测试；涉及启动流程、主界面、监控、通知、报告或持久化配置时，还应使用最新打包产物做实际启动冒烟。

## 术语约定

应用内统一使用以下中文术语，避免同义混用：

- `活跃`
- `已停更`
- `宽限期内`
- `宽限期已过`
- `未提交天数`
- `命名不规范`
- `清理候选`

底层的 `merged` 字段可以保留用于数据兼容，但不要在用户可见筛选、状态、报告或导出中显示“已合并”。

## 项目结构

```text
src/
  components/       通用 UI 组件
  design-system/    设计系统组件
  lib/              工具函数、i18n、格式化与平台逻辑
  pages/            主要页面
  shell/            应用壳层、侧边栏与命令面板
  stores/           全局状态与数据加载
tests/              单元测试
release/            本地打包产物
```

## 验证建议

1. 执行 `npm run typecheck`。
2. 执行 `npm run test -- --run`。
3. 使用 `npm run package:dir` 生成可启动产物。
4. 启动 `release/win-unpacked/BranchPulse.exe`，确认启动动效后进入主界面。
5. 遍历仪表盘、仓库、分支、监控、命名规则、白名单、备份、通知、报告、定时调度、审计日志和设置页面。
6. 修改监控、通知、报告、Token 或仓库配置后重启应用，确认数据仍然保留。
