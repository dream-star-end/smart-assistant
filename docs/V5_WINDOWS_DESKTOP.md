# Aurora V5 Windows Desktop

本文是 Aurora Windows PC 客户端的架构、开发、CI、安全与发布验收说明。桌面端是
“本地 Fluent Windows shell + 隔离远端 V5 产品区”的混合应用，不建立第二套聊天、认证、
会话或计费实现，也不再是单个 `BrowserWindow` 直接包装线上站点。

> 分支权威：`feat/v5-windows-app` 是 Windows 应用长期 canonical。app-only 任务从该分支
> 创建 worktree，分支命名为 `<type>/v5-windows-<slug>`，PR 也回该分支；它只走 installer
> release lane，不进入 V5 server release queue，也不得运行 `scripts/deploy-v5.sh`。共享
> server/protocol/web 改动先进入
> `feat/v5-aurora-rewrite`，再通过显式 upstream-sync PR 同步到 Windows canonical。

Windows canonical 必须保持 `strict=true`、`enforce_admins=true`、PR-only、conversation
resolution、禁止 force/delete，并 require GitHub Actions 的 `Windows app gate`。任务开工与合并
后都要通过 GitHub API 回读；保护缺失时 fail-closed，不得先开实现 PR 再补门禁。

## 1. 目标与非目标

目标：

- 提供可安装、可卸载、带开始菜单和桌面快捷方式的 Windows x64 NSIS 包。
- 完整复用 `https://claudeai.chat/` 的登录、会话、WebSocket、附件、语音和更新握手。
- 保留 Electron 的持久 cookie、IndexedDB、localStorage 与 Service Worker，使登录恢复、
  会话续接和 Web 前端 cache-bust 语义与普通 Chromium 一致。
- 安装包内提供 Fluent 命令栏、导航/连接状态、下载面板、窗口恢复、系统主题/高对比度、
  Windows 11 22H2+ Mica 安全降级、快捷键、鼠标导航和固定 Jump List。
- 用较小且可审的桌面代码面提供窗口生命周期、外链、权限、下载和 IPC 安全边界。

非目标：

- 不把 gateway、PostgreSQL/Redis、用户容器、CCB/Codex runtime 或模型凭据装进 PC。
- 不复制或 fork `packages/web-react`，不在 Electron 中重写核心聊天状态机。
- 本阶段不提供自动更新、自定义协议、托盘常驻、自动启动或离线聊天。
- 首版不复活历史 V3 Desktop 的本地 PTY/CCB enrollment 与 `:18792` ingress 协议。

## 2. 架构与权威源

```text
Windows NSIS
  └─ Aurora.exe (Electron main，窗口/权限/下载/IPC 权威)
       └─ BaseWindow
            ├─ app://aurora-shell
            │    └─ 本地 Fluent shell WebContentsView + 窄 preload bridge
            └─ https://claudeai.chat/ (独立 sandboxed product WebContentsView)
                 ├─ 同源 REST / Cookie refresh
                 ├─ wss://claudeai.chat/... / bearer subprotocol
                 ├─ IndexedDB / localStorage / Service Worker
                 └─ V5 master → egress → 用户容器
```

业务单一权威仍在 V5 服务端与 `packages/web-react`。桌面主进程不得解释聊天帧、保存
access token、代扣积分或代理模型请求。shell 与 product renderer 不直接通信：main 观察净化后的
加载、导航、主题和下载状态发给 shell，shell 只回传封闭命令。Web 产品更新随 V5 dist 发布生效；
本地 shell、Electron 边界、Windows 集成或安装器变化才发布新的 Windows app 版本。

### 2.1 独立依赖与锁文件

`apps/windows` 使用独立 `package.json` 与 `package-lock.json`，不加入根
`package.json#workspaces`。原因：V5 主 CI 固定 Node 20，并在多个 Linux job 中重复执行根
`npm ci`；Electron 当前工具链要求 Node 22.12。把桌面依赖加入根 lock 会让所有服务端 job
下载 Electron，并无谓扩大生产安装和供应链审计面。

桌面命令统一使用：

```bash
npm --prefix apps/windows ci
npm --prefix apps/windows run check
npm --prefix apps/windows run dist:win
```

V3/V5 的 release/rollback rsync 均排除 `apps/windows`（并保留旧 `packages/desktop` 防删除
历史工件），因此 app-only 变化不要求 runtime image、master、dist 或 egress 部署。安装包通过
GitHub Actions artifact；正式发布渠道另行受控。

## 3. Electron 安全模型

### 3.1 shell 与产品 view

产品 view 必须同时满足：

- packaged app 固定加载 `https://claudeai.chat/`，不接受环境变量、argv 或配置文件改写。
- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、
  `webSecurity: true`、`allowRunningInsecureContent: false`。
- 完全不设置 preload，不把文件系统、shell、进程或任何 IPC 暴露给远端 renderer。
- 不覆盖 `certificate-error`，TLS 验证失败即失败。
- 拒绝 `<webview>` attach；普通 renderer 新窗口默认拒绝。

本地 shell 使用 `app://aurora-shell` 精确 host/path 白名单、非持久 session 与严格 CSP。shell 的
preload 只能暴露冻结的 `send/subscribe` 窄接口；main 同时校验 sender、senderFrame、精确 origin、
main frame 和 payload schema。禁止任意 URL/path、原始 `ipcRenderer`、文件系统或进程能力。

`BaseWindow` 关闭时必须显式关闭 shell/product 两个 child `webContents` 并清监听；resize、maximize、
display/DPI 改变统一经过一个 layout 函数。窗口状态恢复必须按当前 display workArea 裁剪，防止
拔掉副屏后窗口落在屏外。

开发环境可允许显式 URL 覆盖，但必须由 `app.isPackaged === false` 硬门控制，并只接受明确的
`http://127.0.0.1`/`http://localhost` 开发地址。测试开关不得改变 packaged app 的生产 URL。

### 3.2 导航、外链与 OAuth

- 主产品窗口保持在固定 V5 origin；`http:`、`file:`、`javascript:`、`data:` 和自定义协议等导航拒绝。
- 普通跨站链接只允许 `https:`，经 `shell.openExternal` 交给系统默认浏览器，绝不自动执行下载；
  仅额外允许经过控制字符与 CRLF 校验的 `mailto:` 交给系统邮件应用。
- 登录与连接器 OAuth 不能简单交给系统浏览器：callback cookie/session 必须回到 Electron 的
  登录 session。OAuth 应使用隔离授权窗口，和主窗口共享持久 session；授权窗口只允许 HTTPS
  跳转，回到 V5 callback/origin 后关闭或把结果交回主窗口。
- OAuth provider 可能来自管理员审核后的连接器配置，不能靠一份会腐烂的硬编码域名全集；
  但任意跨源页面也不得进入拥有桌面能力的主窗口。隔离窗口没有 Node/preload/IPC 能力。

### 3.3 权限与下载

- 权限请求同时校验请求 origin、顶层页面和权限类型，默认拒绝。
- 麦克风只对固定 V5 origin 的音频采集放行；摄像头不能因同属 `media` 被顺带放行。
- 剪贴板只放行产品实际需要的最小写能力；定位、MIDI、串口、USB、HID、蓝牙、屏幕捕获、
  任意通知等未登记能力全部拒绝。
- 下载只接受来自 V5 origin/受信响应的用户发起请求；清洗 Windows 保留名、路径分隔符和控制
  字符。可执行/脚本类扩展名要显式告警，下载后绝不自动打开或运行。
- shell 下载面板只接收 main 生成的 opaque ID。只有“下载已完成 + 文件路径仍在内存登记表”同时
  满足时，main 才能执行 show-in-folder；renderer 永远不能提交任意本地路径。

### 3.4 持久化与更新

不能每次启动清空 cookie、IndexedDB、localStorage 或 Service Worker；这样会破坏登录恢复、
长会话镜像和 V5 自带前端更新握手。桌面壳升级与 Web dist 更新是两条独立版本轴。

本阶段不接 `electron-updater`。正式接入时必须要求 HTTPS、签名校验、不可变版本产物和受保护发布
权限，且更新失败不能删除用户 profile。

## 4. 本地开发与 macOS 验证

要求 Node.js `22.12.0` 或更高兼容版本：

```bash
npm --prefix apps/windows ci
npm --prefix apps/windows run check
npm --prefix apps/windows start
```

离线主进程 smoke：

```bash
npm --prefix apps/windows run smoke
```

`--smoke-test` 使用独立非持久 partition 与安装包内 fixture，真实创建 shell/product 两个
`WebContentsView`，断言 shell bridge 存在且窄、product 没有 `process/require/auroraDesktop`、
导航命令和 resize 布局生效、关闭后两个 webContents 均销毁，再退出 0。它不访问公网、DNS 或
生产服务；应用内有硬超时，CI 再施加 30 秒外层超时。

macOS 还可验证当前平台 unpacked 打包结构：

```bash
npm --prefix apps/windows run pack
```

macOS 能证明纯策略单测、主进程语法、Electron 生命周期与 asar/files 配置；不能证明 NSIS、
Windows 快捷方式、安装目录权限、卸载、代码签名或 SmartScreen。

## 5. Windows CI

Workflow：`.github/workflows/v5-windows-desktop.yml`。

触发与门禁：

- PR/push 目标为 V5 server canonical 或 Windows app canonical 时，稳定产出唯一的
  `Windows app gate` context，避免 branch/path filter 让 required check 永久 pending。
- Windows app canonical 的每个 PR/push 都构建 installer；V5 server canonical 只有命中桌面包、
  本文或 workflow 时才构建，其余改动由 scope job 明确跳过 installer 后让 gate 通过。
- workflow 不声明 `workflow_dispatch`：它不在仓库默认分支，不能把不可用的手动入口写成承诺。

需要构建时，流水线在 `windows-latest`、Node `22.12.0` 上执行：

1. 用 `apps/windows` 独立 lockfile 执行 `npm ci`。
2. 执行策略、合同、窗口/IPC/下载和语法检查 `npm run check`。
3. 以 electron-builder 构建 Windows x64 NSIS。
4. 启动 `release/win-unpacked/Aurora.exe --smoke-test` 跑 packaged 双-view 行为合同，30 秒未退出即强杀并判红。
5. 静默安装到 runner 临时目录，再跑一次 installed smoke，最后静默卸载并确认 exe 消失。
6. 对唯一的 `Aurora-Setup-*.exe` 生成 `SHA256SUMS.txt`。
7. 上传 installer、blockmap/metadata（若生成）和 SHA-256，保留 14 天。

该 workflow 当前在所有触发方式下都设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，产物名含
`unsigned`，只用于内测。它不读取任何签名 secret，也不会发布 GitHub Release。

## 6. 验收矩阵

| 层级 | 必验项目 | 通过标准 |
| --- | --- | --- |
| 纯策略 | URL/OAuth/权限、IPC、argv、窗口裁剪、布局、主题、下载 ID | 正反例单测均通过，未知输入 fail-closed |
| macOS 本地 | `check`、双-view 离线 smoke、当前平台 `pack` | 产品无 bridge，布局/销毁合同成立，包结构完整 |
| Windows CI | 独立 `npm ci`、check、NSIS、unpacked/installed smoke、silent uninstall、SHA-256 | 35 分钟 job 内全部通过，installer 恰好一个 |
| Windows 10/11 真机 | 安装、启动、快捷方式、卸载 | 普通用户可安装；卸载不误删浏览器/其他应用数据 |
| Windows UI | 1366×768/1080p、多屏拔插、100–200% 缩放、浅/深/高对比、键盘/Narrator | shell 不遮挡产品区，焦点和 IME 正常，窗口始终可恢复 |
| 登录 | 密码登录、刷新恢复、退出、LinuxDo OAuth | callback 回到同一 Electron session，重启仍保持预期登录态 |
| 连接器 | GitHub 与至少一个动态 OAuth connector | 隔离授权窗完成往返，主窗口不获得跨源桌面能力 |
| 核心聊天 | 新建会话、流式回复、停止、重连、长会话恢复 | REST/WS 正常，无空白回复或重复 turn |
| 文件/媒体 | 上传、下载、图片预览、麦克风语音 | 用户手势生效；权限最小；危险下载不自动执行 |
| 导航攻击面 | `file:`/`javascript:`/`data:`、恶意 popup、webview | 全部拒绝；HTTPS 普通外链只进系统浏览器 |
| 签名发布 | installer/exe 签名、时间戳、哈希 | `signtool verify /pa /all /v` 通过，SHA-256 与发布页一致 |

## 7. 未签名包与 SmartScreen

CI 当前生成的是未签名内测包。Windows 会显示“未知发布者”，SmartScreen 也可能拦截；这不是
可通过改文件名或关闭系统保护解决的问题。禁止把未签名 artifact 伪装成正式版或指导普通用户
永久关闭 SmartScreen。

内测人员必须从受控 CI run 下载，并对照同一 artifact 内 `SHA256SUMS.txt`：

```powershell
Get-FileHash .\Aurora-Setup-<version>-x64.exe -Algorithm SHA256
```

## 8. 正式签名前置条件

公开分发前必须全部满足：

1. 确定 Windows `appId`、产品名、publisher subject 与品牌图标，后续保持稳定。
2. 取得组织代码签名证书或受支持的云签名服务，确认能同时签应用 exe 与 NSIS installer。
3. 签名凭据只放 GitHub protected environment/repository secrets；fork PR 与普通 PR 永远拿不到。
4. 签名 job 只允许受保护 canonical push 或人工 dispatch，经 environment approval 后运行；
   PR 始终构建清晰标记的 unsigned 验证包。
5. 配置可信时间戳服务，electron-builder 签名失败必须 fail-closed，禁止退回 unsigned 后继续发布。
6. 在上传前执行 `signtool verify /pa /all /v`，并重新计算最终已签名 installer 的 SHA-256。
7. 发布记录绑定 exact Git commit、Desktop semver、Actions run、证书 subject/serial 与哈希。
8. 真 Windows 10/11 干净机完成安装、升级、卸载与 SmartScreen 观察；签名能证明发布者身份，
   但新证书信誉仍可能需要时间积累。

正式签名 lane 尚未接入当前 workflow。在证书与 secrets 准备完成前，当前任务的完成定义是
“可重复生成并通过 Windows smoke 的 unsigned 内测 NSIS”，不是“可公开分发的正式安装包”。
