# Aurora Windows Desktop

> 当前目录是 Windows 独立产品线的迁移基线。长期 canonical 为
> `feat/v5-windows-app`；app-only 改动从该分支创建并 PR 回该分支，不运行
> `scripts/deploy-v5.sh`。0.2.0 原生壳批次会把权威目录迁到 `apps/windows`。

Aurora Windows Desktop 是 OpenClaude V5 的轻量 Electron 客户端。它只承载
`https://claudeai.chat/` 的现有 V5 Web 产品，不在用户电脑上复制 gateway、商业控制面、
CCB/Codex runtime 或计费逻辑。服务端和 `packages/web-react` 继续是业务与界面的单一权威。

完整架构、安全边界、CI 与发布验收见
[`docs/V5_WINDOWS_DESKTOP.md`](../../docs/V5_WINDOWS_DESKTOP.md)。

## 包边界

- 本目录是独立 npm 包，维护自己的 `package-lock.json`。
- 不加入仓库根 `workspaces`，不改变根 Node 20 CI 的安装面。
- V5 部署脚本已经排除 `packages/desktop`；桌面产物不通过 `deploy-v5.sh` 上线。
- Windows 安装包只由独立 Windows workflow 构建。

## 安全默认值

- 主窗口只承载固定的 V5 生产 origin。
- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、
  `webSecurity: true`；不向远端页面暴露 Node 或通用 IPC。
- 新窗口默认拒绝。普通外链经协议校验后交给系统浏览器；OAuth 使用隔离授权窗口，
  与主窗口共享登录 session，但不扩大主窗口导航权限。
- 权限按固定 origin 和用途最小放行；摄像头、定位、MIDI、任意通知等默认拒绝。
- 正式打包版本固定生产 URL；开发 URL 覆盖不得在 packaged app 中生效。
- `--smoke-test` 只创建隐藏的沙箱窗口并加载本地 `about:blank`，不得访问公网。

## 开发与检查

需要 Node.js `22.12.0` 或更高兼容版本。

```bash
npm --prefix packages/desktop ci
npm --prefix packages/desktop run check
npm --prefix packages/desktop start
```

离线检查 Electron 主进程能否启动：

```bash
npm --prefix packages/desktop start -- --smoke-test
```

该命令不访问 `claudeai.chat`，不能替代真实登录和聊天旅程测试。

## 构建

在 Windows x64 上生成 NSIS 安装包：

```bash
npm --prefix packages/desktop run dist:win
```

主要产物：

- `release/win-unpacked/Aurora.exe`
- `release/Aurora-Setup-<version>-x64.exe`
- CI 生成的 `release/SHA256SUMS.txt`

macOS 可运行当前平台的 unpacked 打包检查：

```bash
npm --prefix packages/desktop run pack
```

macOS 打包不能证明 NSIS 安装、Windows 权限、签名或 SmartScreen 行为；这些必须由
Windows CI 和真实 Windows 10/11 机器验收。

## 关于未签名安装包

当前 CI 产物明确是 **unsigned 内测包**，Windows SmartScreen 可能显示“未知发布者”警告。
它不能直接作为公开正式版分发。正式发布前必须完成组织代码签名证书、受保护 secrets、
时间戳与 `signtool verify` 门禁；详见完整文档的“正式签名前置条件”。
