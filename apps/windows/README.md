# OpenClaude Aurora for Windows

Aurora for Windows 是 OpenClaude V5 的独立桌面产品线。它不是把线上站点直接塞进单个
`BrowserWindow`：安装包自带本地 Fluent Windows shell，远端 V5 产品区运行在另一块隔离的
`WebContentsView` 中。认证、会话、聊天协议、计费和核心聊天 UI 仍复用 V5 Web/服务端单一
权威，桌面端不复制 gateway、用户 runtime 或模型凭据。

长期 canonical 是 `feat/v5-windows-app`。应用代码只在 `apps/windows/**` 演进；任务分支必须
命名为 `<type>/v5-windows-<slug>` 并 PR 回 Windows canonical。app-only 变化不运行
`scripts/deploy-v5.sh`。

完整架构、安全、CI 与发布验收见
[`docs/V5_WINDOWS_DESKTOP.md`](../../docs/V5_WINDOWS_DESKTOP.md)。

## 架构边界

```text
BaseWindow
├─ app://aurora-shell (本地 Fluent shell，窄 preload IPC)
└─ https://claudeai.chat/ (sandboxed product WebContentsView，无 preload/Node/IPC)
```

- shell 使用受控 `app://` handler、非持久 session 和严格 CSP；不能传任意 URL/path。
- product view 使用持久 product partition，保持固定生产 origin；登录、Service Worker 和本地
  Web 存储与 Chromium 一致。
- OAuth/connector 窗与 product 共用 session，但没有 shell preload；外链、权限、blob 预览和
  危险下载继续 fail-closed。
- 下载面板只持有 opaque ID；只有已完成且仍在 main 登记表中的文件才能“在文件夹中显示”。

## Windows 适配

- 参考 Codex 桌面版的信息层级，窗口顶部保留 44px 本地 app bar；Windows 上与系统 caption
  通过 Electron Window Controls Overlay 合并，失败则回退标准标题栏。标题固定为安装包内的
  “Aurora / 桌面工作区”，不读取远端 DOM，也不伪造项目、任务或会话标题。
- app bar 只承载下载状态和更多操作；后退、前进、刷新、主页、缩放与下载等桌面命令由
  Electron 原生 `Menu` 和既有键盘快捷键提供，不在远端产品区注入脚本。
- Segoe UI Variable/system 字体、键盘可达、可见焦点、forced-colors/high-contrast 和 reduced
  motion 支持。
- 窗口位置/尺寸/maximized 持久化，多屏拔插后按当前 workArea 回收；Windows 11 22H2+ Mica 在不适用
  时安全回退不透明背景。
- F6 在远端产品区与本地 app bar 间循环焦点；Alt+Left/Right、Ctrl+R、Ctrl+0/+/-、鼠标
  前进/后退键和固定无隐私 Jump List 任务。
- 下载与离线状态是本地 modal：进入 modal 时 main 隐藏 product view，shell 扩展为整窗；关闭下载
  modal 或网络恢复后，main 恢复 product view、重新布局并把焦点还给产品区。两块 renderer 不叠层
  抢占输入。
- 暂不做 close-to-tray、自动启动、深链、自动更新或离线聊天。

## 开发与验证

要求 Node.js 22.12.0 或更高兼容版本：

```bash
npm --prefix apps/windows ci
npm --prefix apps/windows run check
npm --prefix apps/windows start
```

离线行为型 smoke：

```bash
npm --prefix apps/windows run smoke
```

smoke 使用安装包内本地 fixture，真实创建 shell/product 两个 view，验证 bridge 隔离、导航、
resize 布局和关闭销毁，不访问 `claudeai.chat`。它不能替代真实登录、OAuth、聊天、上传下载和
语音旅程。

macOS 可检查当前平台 unpacked 包结构：

```bash
npm --prefix apps/windows run pack
```

Windows x64 NSIS：

```bash
npm --prefix apps/windows run dist:win
```

主要产物是 `release/win-unpacked/Aurora.exe`、`release/Aurora-Setup-<version>-x64.exe` 和 CI
生成的 `release/SHA256SUMS.txt`。

## 发布边界

`Windows app gate` 是 Windows canonical 的 required check：执行独立 `npm ci`、策略/合同测试、
unsigned NSIS 构建、packaged 双-view smoke 和 SHA-256。当前产物明确是 **unsigned 内测包**；
Windows 可能显示未知发布者/SmartScreen 警告，不能伪装成公开正式版，也不能指导用户关闭系统
保护。公开分发前必须完成组织代码签名、可信时间戳、`signtool verify`、不可变产物与 Win10/11
安装/升级/卸载真机矩阵。

本目录的 shell、Electron main、测试、图标、文档或 installer 改动均为 app-only：
**server runtime image rebuild = no**，不得运行 `scripts/deploy-v5.sh`，只走 Windows installer lane。

本地 shell 使用的 Microsoft Fluent UI System Icons 第三方来源、固定版本、registry integrity 与
MIT 许可见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
