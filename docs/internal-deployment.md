# 内网/离线环境部署

本文针对把 GitManager 部署到**内网服务器**（离线或半离线、由其他机器用浏览器访问）时踩到的四类问题，给出原因与处理步骤。

> 一句话结论：**不要把本机的 `node_modules` 拷过去**，用 `npm ci` 在目标机上重装；**必须显式设置 `GITMANAGER_HOST=0.0.0.0`**；GitLab 在子路径部署时地址要按下面第 4 节填。

## 1. `npm start` 后网页打不开

**原因**：`server/index.ts:10` 的默认监听地址是 `127.0.0.1`，只绑定回环地址，外部机器连不上；服务本身是正常运行的。

**处理**：启动时显式指定监听所有网卡，并放行防火墙端口。

```bash
GITMANAGER_HOST=0.0.0.0 GITMANAGER_PORT=4173 npm start
```

Windows PowerShell：

```powershell
$env:GITMANAGER_HOST='0.0.0.0'; $env:GITMANAGER_PORT='4173'; npm start
```

持久化（Linux systemd）：

```ini
[Service]
WorkingDirectory=/opt/gitmanager
Environment=GITMANAGER_HOST=0.0.0.0
Environment=GITMANAGER_PORT=4173
Environment=GITMANAGER_USER_DATA_DIR=/var/lib/gitmanager
ExecStart=/usr/bin/node /opt/gitmanager/dist/server/index.cjs
Restart=always
```

检查监听是否生效（应看到 `0.0.0.0:4173` 或 `*:4173`，而不是 `127.0.0.1:4173`）：

```bash
ss -lntp | grep 4173        # Linux
netstat -ano | findstr 4173 # Windows
```

放行防火墙：

```bash
sudo firewall-cmd --add-port=4173/tcp --permanent && sudo firewall-cmd --reload   # firewalld
sudo ufw allow 4173/tcp                                                           # ufw
```

> 启动日志会打印实际监听地址，例如 `GitManager web UI listening on http://0.0.0.0:4173`，并额外提示可从其他机器访问；若日志出现 `Listening on loopback only; set GITMANAGER_HOST=0.0.0.0 ...`，说明当前只有本机能访问。

> 如果 GitManager 运行在 WSL 中，`0.0.0.0` 只表示 WSL Linux 虚拟机内的所有网卡。其他电脑访问时还要在 Windows 防火墙放行 4173，并按 WSL 的网络模式配置端口转发；WSL2 可使用 Windows 的 `portproxy`，或切换到 mirrored networking。

## 2. `npm run build` 报 `vite: permission denied`

**原因**：`node_modules` 是从 Windows 拷贝/解压过去的，npm 为 POSIX 生成的 bin 包装脚本（`node_modules/.bin/vite`）丢失了可执行位，shell 直接执行时报 permission denied。与本项目代码无关。

**处理**：在目标机上重新安装依赖，而不是复用拷贝过来的目录。

```bash
rm -rf node_modules
npm ci            # 有 registry 时优先，按 package-lock.json 精确安装
# 使用内网 npm 私服时：
npm ci --registry http://内网私服地址 --replace-registry-host=always
# 完全离线时改用离线缓存：
npm ci --offline --cache /path/to/npm-cache
```

若确实无法重装（例如从别处拷来的 `node_modules` 必须复用），至少补回可执行位：

```bash
chmod +x node_modules/.bin/*
```

## 3. `npm run dev` 报 `node_modules/esbuild/lib/main.js:1736 throw new Error`

**原因**：与第 2 条同源。esbuild 的平台二进制是按平台拆分的 optional dependency（`@esbuild/win32-x64`、`@esbuild/linux-x64`…）。拷贝过来的 `node_modules/@esbuild/` 里只有 Windows 那份，Linux 上 esbuild 找不到自身二进制，于是在 `main.js` 里主动抛错。

**处理**：

```bash
npm ci
# 或者只补装缺失的平台包：
npm rebuild esbuild
```

如果 `npm rebuild esbuild` 后仍报错，直接确认平台包是否存在：

```bash
ls node_modules/@esbuild/          # 内网 Linux 上应看到 linux-x64
ls node_modules/@rollup/           # 应看到 rollup-linux-x64-gnu（glibc）或 rollup-linux-x64-musl
```

`package-lock.json` 里已包含 `@esbuild/linux-x64` 和 `@rollup/rollup-linux-x64-gnu`，只要用 `npm ci`/`npm install` 正常安装就会自动拉取，不需要手工改依赖。若 `@rollup` 仍缺 Linux 包，不要只执行 `npm rebuild esbuild`，应在目标机重新执行 `npm ci`。

如果目标机完全离线，可以在一台能访问 npm 源的机器上准备 Linux 依赖，再用保留权限和符号链接的归档方式传输：

```bash
# 准备机需使用 npm >= 10.5
npm ci --os=linux --cpu=x64 --libc=glibc
tar -czf gitmanager-node_modules-linux-x64.tar.gz node_modules

# 目标机项目根目录
tar -xzf gitmanager-node_modules-linux-x64.tar.gz
```

不要用会丢失可执行位或符号链接的 zip 包传输 `node_modules`；更推荐在内网 npm 私服可用时直接 `npm ci`。

> 说明：`npm run build` 会把后端与 nodemailer 等一起打进 `dist/server/index.cjs`，运行时只有 `sql.js` 保持 external（`scripts/esbuild-server.mjs` 的 `external` 列表）。所以 `npm start` 需要 `node_modules/sql.js` 存在（wasm 另有 `dist/server/sql-wasm.wasm` 作为兜底副本），但**不需要** esbuild；esbuild 只有 `npm run build` / `npm run dev` 用得到。反过来讲，只要 `npm ci` 装对了依赖，这三个问题（2、3 与启动）都会一起消失。

## 4. 能打开网页，但填 URL + Token 后扫不出分支

依次排查以下三层。

### 4.1 只看到"0 个分支"，没有报错

**原因**：早期版本里扫描失败的错误在监控服务里被吞掉，前端只看到 0 个分支。

**处理**：现已修复——扫描结果会带 `error`，仓库页与监控页会显示具体失败原因（`扫描失败：<原因>`），监控页的"最近检查"每行也会显示该次运行的所有失败项。先升级到本版本，再按页面提示的错误继续排查。

完整原始错误同时写在服务端日志：

```bash
tail -n 200 "$GITMANAGER_USER_DATA_DIR/logs/gitmanager-$(date +%F).log"
# 默认位置：Linux $XDG_CONFIG_HOME/gitmanager/logs，Windows %APPDATA%\gitmanager\logs
```

### 4.2 自建 GitLab 的根路径与子路径

**原因**：自建 GitLab 可能部署在根路径 `http://内网主机[:端口]`，也可能挂在子路径 `http://内网主机/gitlab`。API 必须保留实例的路径前缀；早期版本只按 origin 拼 `/api/v4`，子路径部署会必然 404。

**处理**：现已同时支持根路径和子路径。地址栏按下面任一种填写即可：

| 情况 | 填法 | 推导出的 API 地址 |
| --- | --- | --- |
| 云托管 | `https://gitlab.com` | `https://gitlab.com/api/v4` |
| 自建、根路径 | `http://内网主机[:端口]` | `http://内网主机[:端口]/api/v4` |
| 自建、子路径 | `http://内网主机/gitlab` | `http://内网主机/gitlab/api/v4` |
| 自建、子路径 + 已知项目 | `http://内网主机/gitlab/group/app` | `http://内网主机/gitlab/api/v4` |
| 直接指定 API | `http://内网主机/gitlab/api/v4` | 原样使用 |

如果浏览器打开 GitLab 首页的地址是 `http://内网主机:端口`，页面就填这个根地址，程序会请求 `http://内网主机:端口/api/v4`。

**已知取舍**：`http://内网主机/gitlab` 这种只有一个路径段的地址存在歧义——它既可能是"子路径根"，也可能是"命名空间只有一段的项目"。当前规则是：**1 段按子路径根解释，≥2 段按项目解释**。若你的实例根路径下恰好有个同名项目，或自动推导仍失败，请**直接填完整的 API 地址**（`.../api/v4`），这条路径不会有歧义。

对于填项目完整地址的情况，程序会先按原样请求项目，遇到 404 再把首段当实例子路径重试一次（见 `src-node/services/gitlab.ts` 中 `relativeRootProjectPath` 的注释），因此两种填法都能工作，但会多一次请求。加入仓库（`getProject`）走同样的回退，因此"连接成功但添加时报 404"不会发生；两次请求都失败时返回第一次（也就是与你填写地址一致的那次）的错误。

### 4.3 代理与自签证书

代码里**没有任何** proxy / 自定义 CA 处理，这是设计现状而非可配置项，需要靠环境变量或系统信任库解决。

**走代理**：Node 24 的内置 `fetch` 默认**不读取** `HTTP_PROXY`/`HTTPS_PROXY`，必须显式开启：

```bash
NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://代理:端口 HTTPS_PROXY=http://代理:端口 npm start
```

如果目标机是 Node 20/22，且该版本不支持 `NODE_USE_ENV_PROXY`，当前代码没有内置代理 agent；此时需要使用系统级透明代理，或在代码中增加 `undici` `ProxyAgent` 支持。

**自签证书 / 内网 CA**：

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/内网CA.pem npm start
```

**临时绕过校验**（仅用于确认原因，不要长期使用）：

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npm start
```

若开了之后能扫出分支，说明问题在证书信任链，请改用 `NODE_EXTRA_CA_CERTS`。

### 4.4 其它常见原因

- **Token 权限不足**：GitLab 用 `read_api`（或 `api`）scope 的 Personal Access Token；只有 `read_repository` 可能列不出项目。
- **Token 属于别的实例**：换过 URL 但沿用了旧 Token，页面会显示 401/403。
- **网络不通**：在服务器上直接验证：
  ```bash
  # 根路径部署
  curl -H "PRIVATE-TOKEN: <token>" "http://内网主机:端口/api/v4/projects?per_page=1"
  # 子路径部署
  curl -H "PRIVATE-TOKEN: <token>" "http://内网主机/gitlab/api/v4/projects?per_page=1"
  ```
  这条命令的返回码与 Body 就是后端应该看到的东西。401/403 → Token；404 → 路径不对（回到 4.2）；超时/连接失败 → 网络或代理（回到 4.3）；返回 `[]` → Token 所属账号看不到任何项目。

## 5. 数据目录与权限

默认按用户目录存放（Linux `$XDG_CONFIG_HOME/gitmanager`，即 `~/.config/gitmanager`）。用 systemd 或容器跑时该目录可能不可写，建议显式指定：

```bash
GITMANAGER_USER_DATA_DIR=/var/lib/gitmanager npm start
```

首次启动会在此创建 `data/`、`logs/`、`data/reports/`、`data/backups/`，确保运行用户对它有写权限。凭据加密在无 OS 密钥库可用时回退为可逆混淆并写 warning 日志；Linux 上如需强加密，见 `docs/web-port.md` 的「凭据加密」一节（`registerSecretBackend()`）。

## 6. 部署检查清单

```bash
# 1. 依赖在目标机重装，不要拷贝 node_modules
npm ci

# 2. 确认 Linux 平台二进制
ls node_modules/@esbuild/
ls node_modules/@rollup/

# 3. 构建
npm run build

# 4. 绑定所有网卡 + 显式数据目录
GITMANAGER_HOST=0.0.0.0 GITMANAGER_PORT=4173 GITMANAGER_USER_DATA_DIR=/var/lib/gitmanager npm start

# 5. 确认监听范围与防火墙
ss -lntp | grep 4173

# 6. 从另一台机器验证 HTTP 可达
curl -I http://内网主机:4173

# 7. 验证 GitLab API 路径与 Token（用你在页面上填的地址）
curl -H "PRIVATE-TOKEN: <token>" "http://内网主机:端口/api/v4/projects?per_page=1"
```

第 6 步不通 → 回到第 1 节；第 7 步不通 → 回到第 4 节，此时页面上的失败原因与服务端日志会给出同样的错误文本。
