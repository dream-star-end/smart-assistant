# Aurora Windows：Codex 桌面形态二次重构方案

状态：对照 Codex 真实截图重新校准；方案审第二轮 **PASS**（会话 `019ffbad-91b6-7721-bbd5-96f743e09af3`）。可进入完整 diff 审。  
基线：`origin/feat/v5-windows-app` @ `0045911e2`（PR #408 已合入）  
范围：**app-only**，`apps/windows/**` + 本方案 + `docs/V5_WINDOWS_DESKTOP.md` + `apps/windows/docs/design-qa.md`  
不进入 V5 server release queue，不运行 `scripts/deploy-v5.sh`，不改 `packages/web-react` / server / protocol。

仓根旧 `design-qa.md` 的 `final result: passed` 只证明 **PR #408 基线**。本轮必须以新截图 + 参考图对照重写 `apps/windows/docs/design-qa.md`。

参考图（用户提供，含生产会话内容，**不入库、不截取账号**；本机对照路径）：

1. 主界面三栏：`/Users/dengxuan/.cursor/projects/Users-dengxuan-git-project-openclaude-v3/assets/image-c48a28ef-fd72-4c3f-82f8-afc5a7ba5ea7.png`
2. 对话 + 文件查看 / 文件树：`/Users/dengxuan/.cursor/projects/Users-dengxuan-git-project-openclaude-v3/assets/image-f0402cd5-6c16-49c1-a125-2b6b04ef1e1a.png`
3. 设置页：`/Users/dengxuan/.cursor/projects/Users-dengxuan-git-project-openclaude-v3/assets/image-237b325c-a3d5-4f71-bebf-40da07bb134d.png`

## 0. 对照参考图后的产品结论（硬性）

Codex 桌面版在截图里是**同一应用内的完整产品 UI**：无浏览器工具条、内容顶到窗口上沿、左侧会话/项目分组、中间对话（可再拆文件查看）、右侧上下文或文件树、设置页是左导航 + 右行式控件。

Aurora V5 Windows 客户端按 skill **不是**这个形态的全原生复制，而是：

```
BaseWindow
├─ 本地可信 shell（44px app bar + 下载/离线 modal + 原生 Menu）
└─ 隔离的远端产品 view（packages/web-react：会话、聊天、设置、右侧面板）
```

**无法两全的取舍**：若把三栏/设置画进本地 shell，就必须读取或伪造项目、会话、agent、环境信息，直接违反 skill 第 2–3 节。若用 `insertCSS` / DOM 注入去改线上页面，同样禁止。

**推荐（本轮执行）**：

1. 本地 shell 做到 Windows chrome 与 Codex **窗口级**对齐（WCO、克制 app bar、浅色 hairline、原生菜单、下载/离线）。
2. 三栏主界面、消息排版、输入区、右侧面板、设置各分节标为 **独立 server/web PR**（`feat/v5-aurora-rewrite` → upstream-sync 到 Windows canonical）。
3. 不把假侧栏画进离线态（禁止用空白色条伪造 Codex sidebar）。
4. 本轮不停工：把 shell 能自主达成的部分做到位并过质量门。

## 1. 为什么再做一轮，而不是重写 PR #408

PR #408 已经把权威骨架落到 skill 硬边界上。本轮**不推翻**：

- `BaseWindow` + 两个 `WebContentsView`
- 产品区无 preload / Node / IPC；shell preload 只暴露冻结的 `send/subscribe`
- 44px 本地 app bar，不做浏览器式后退/前进/刷新/地址栏
- 低频命令走 main 构造的 Electron 原生 `Menu`
- modal 下载/离线必须 `productView.setVisible(false)`，恢复 `visible -> layout -> focus`
- 下载 opaque ID、indeterminate `<progress>`、列表重建按 ID 恢复焦点
- Mica 仅 Windows 11 22H2+；forced-colors / 减少透明 / API 失败时不透明回退
- 固定无隐私 Jump List + 严格 argv；窗口按 workArea 裁剪
- 不读远端 DOM，不伪造项目 / 会话 / agent / 环境数据

本轮补的平台缝：

1. 标准标题栏 + 44px app bar 叠两层 chrome → win32 WCO。
2. 恢复 Windows `Alt` 应用菜单（不注册 accelerator，IME 仍走 `before-input-event`）。
3. 下载完成 toast（固定文案、opaque id、窗口存活才发、show 前保活）。
4. 按真实 Codex 截图把 **token / 密度 / 离线与下载表面** 校准到浅色桌面形态。
5. 明确三栏与设置的所有权，避免再把产品 UI 画进 shell。

## 2. 对齐 / 有意不对齐（截图校准后）

| Codex 截图观察到的形态 | 所有权 | Aurora 决策 | 原因 |
| --- | --- | --- | --- |
| 不是浏览器壳；内容顶到窗口上沿 | shell | **对齐** 为 WCO + 44px app bar | skill 第 3 节；Windows caption 在右上 |
| 固定产品名，不把会话标题写入窗口标题 | shell | **对齐且加强**：永远 `OpenClaude Aurora` | 隐私 |
| 左侧会话/项目分组、活跃蓝条、底栏账号 | **web** | 本轮不对齐进 shell | 数据权威在 `packages/web-react` `Sidebar.tsx` |
| 中间对话、工具卡片、输入区、模型选择 | **web** | 本轮不对齐进 shell | 聊天协议与渲染权威在 web |
| 右侧环境/+/−/分支 或 文件树 | **web** | 本轮不对齐进 shell | 无本地环境真相；禁止伪造 |
| 设置：左分组导航 + 右行式开关/下拉 | **web** | 本轮不对齐进 shell | 现有 `SettingsCenter` 五分区，需独立 PR 才接近截图 IA |
| macOS traffic lights 在左上 | shell | **有意改成 Windows**：caption 在右上 | 平台惯例 |
| 半透明最大化 sidebar | shell | **不对齐** | Codex Win10 透出桌面；Mica 仅 Win11 22H2+ |
| Store/MSIX、自动更新 | — | **不对齐** | unsigned NSIS 内测 |
| 本地 44px Aurora app bar | shell | **有意保留** | skill 硬性；Codex 无此条是因为它是全产品 UI |

## 3. 从三张参考图提取的可验收规格

下列数字是从截图归纳的**设计规格**（不是像素 golden）。macOS 控件位置在 Windows 上按第 11 节替换。

### 3.1 整体栅格

测量基准：CSS DIP、100% 缩放、参考图约 1024×528 视口。百分比与 px 同时给出时，**px 下限优先**，再用 `clamp()`；冲突时先收右栏、再收左栏。这是 web 规格，不是 shell 合同。

参考图是**两种工作区模式**，不要合成一套恒定三栏：

| 模式 | 左 | 中 | 右 |
| --- | --- | --- | --- |
| 聊天模式（图 1） | 会话栏 240–280px（`clamp(240px, 20vw, 280px)`） | 对话 flex，最小 420px | 上下文卡 260–320px，可关；看起来像浮层而不是等权第三列 |
| 文件审阅（图 2） | 同上 | 对话 + 文件查看垂直或水平拆分 | 文件树 240–280px，顶搜索 |

其它：

| 项 | 规格 |
| --- | --- |
| 左栏可折叠 | 折叠后主区吃满；最小窗口仍要能显示中区输入框 |
| 左栏低于 220px | overlay/drawer（web 已有移动抽屉） |
| 分栏线 | 1px `#E5E7EB` hairline |
| 窗口 chrome | Windows caption **右上** 44px；WCO 未就绪时 app bar 右侧预留 140px，禁止控件落到 caption 下 |
| 设置页 | 左导航 240–268px；右内容列 `max-width: 720px`、左对齐，窄窗单列 |

### 3.2 左侧栏（web）

- 顶：品牌字 + 右侧「新会话」方钮（线框图标，约 32px）。
- 分组标题：较小字重、略大写/弱对比；其下会话缩进 12–16px。
- 会话行：单行标题（medium）+ 可选次行预览（muted、ellipsis）；高 36–44px。
- 活跃态：浅蓝/浅灰圆角底 + **左侧 2–3px 强调条**。
- Hover：更浅的灰底，无重阴影。
- 次要元信息：右侧小 pill（如未读），不抢标题。
- 底栏：圆形头像 + 账号标识，顶部分割线；不把积分大数做成广告条。

### 3.3 中间主区（web）

- 顶：会话标题（16–18px semibold）+ 右侧 `⋯`；其下可选状态 pill。
- 正文：sans，约 14–15px，行高 1.55–1.7；标题加粗；列表缩进清晰；链接蓝色。
- 工具/文件改动卡片：浅边框、8–12px 圆角；`+N` 绿 / `-N` 红；可 Expand。
- 附件/安装包：文件图标 + 蓝色文件名，不把路径当正文。
- 代码块：独立表面、圆角、横向滚动，不撑破中栏。
- 底栏输入：大圆角容器（12–16px）浮于底部；左 `+`，中多行输入，右模型/模式选择 + 圆形发送。

### 3.4 右侧面板（web）

- 可折叠分区：环境 / 变更统计 / 分支 / 任务 / 来源，或切换为文件树。
- `+` / `-` 数字用成功绿 / 危险红，等宽数字。
- 文件树：chevron + 类型色图标 + 标准缩进；顶可有搜索。
- 中栏拆分文件查看时：路径面包屑 + 等宽正文 + 行号。

### 3.5 设置页（web）

截图左导航（Codex IA，**不是** Aurora 现网 IA）：

- 个人：常规、个人资料、外观、语言、配置、个性化、宠物、键盘快捷键、使用情况和计费、账户
- 集成：应用快捷键、插件、浏览器、电脑视觉
- 开发：钩子、连接、Git、环境、Worktrees
- 已归档：已归档的聊天

右栏：大标题 + 分节标题 + **行式设置**（左：标题 semibold + 说明 muted；右：开关 / 下拉 / 文本按钮）。行高约 56–72px，节间 hairline。

Aurora 现网 `SettingsCenter` 只有：账户与计费 / 用量 / 偏好 / 反馈 / 关于。要对齐 Codex IA **必须独立 web PR**，并决定哪些 Codex 项在 V5 没有对应能力（宠物、Worktrees、电脑视觉等）——缺失项不要画空壳。

### 3.6 设计 token（shell 本轮采用；web 建议同源）

| Token | 浅色规格 | Windows 备注 |
| --- | --- | --- |
| 画布 | `#FFFFFF` |  |
| 侧栏/次表面 | `#F7F8FA` | Win11 可用 Mica **衬在窗口**，控件本身不透明 |
| 边框 | `#E5E7EB` | forced-colors 改系统色 |
| 主文字 | `#1F2328` |  |
| 次文字 | `#6B7280` |  |
| 强调（Codex 蓝） | 仅 web 会话活跃态 | shell 品牌继续 Aurora 紫 `#6B57C8`，避免伪造 Codex 产品 |
| 成功/危险 | `#178653` / `#B32636` |  |
| 圆角 | 控件 8px，卡片 12px，输入 12–16px |  |
| 间距刻度 | 4 / 8 / 12 / 16 / 24 |  |
| 字重 | 400 正文、550–600 标题、650 品牌 | Segoe UI Variable |
| 图标 | 20px 线框，stroke 一致 | Fluent UI System Icons，禁止手绘 SVG |
| 阴影 | 仅浮层 `0 12px 34px / 0 2px 8px`，栏与栏之间不用阴影 |  |
| 滚动条 | Windows overlay 风格，不画 macOS 细条 |  |

## 4. 全界面清单（当前 → 目标 → 谁做 → 验收）

| 界面/状态 | 当前 | 目标 | 本轮 | 验收点 |
| --- | --- | --- | --- | --- |
| 窗口 chrome | 系统标题栏或 WCO | 内容顶到上沿；Win caption 右上 44px | **shell** | `overlayActive && wcoReady` 才 drag/safe-area；env=0 时 140px 预留为合法稳定态；构造失败回退默认标题栏 |
| 44px app bar | Aurora / 下载 / More | 克制；无浏览器按钮；无会话标题 | **shell** | 静态文案；F6 循环 |
| 主聊天三栏 | web 已有左栏 268px + 中栏；无 Codex 式右栏 | 截图三栏 | **web PR** | 比例/折叠/最小宽 |
| 会话列表 | web `Sidebar`：时间分组，非项目文件夹 | 项目/工作区层级 + 活跃条 | **web PR** | 不进 shell |
| 消息/代码/卡片 | web 已有工具卡 | 字号行高、文件改动卡、横向滚动 | **web PR** |  |
| 输入区 | web composer | 大圆角、左+、右模型与发送 | **web PR** |  |
| 右侧上下文/文件树 | 无对等物 | 截图右栏 | **web PR** | 禁止 shell 伪造 git 数字 |
| 设置各分节 | 对话框五分区 | 左导航 + 行式页 | **web PR** | 只展示 V5 真实能力 |
| 下载 modal | 本地抽屉 | 行式列表、空状态、indeterminate | **shell** | 隐藏 product；Esc；焦点按 ID 恢复 |
| 离线/加载失败 | 假 220px 色条 + 卡片 | 不伪造侧栏；居中恢复卡 | **shell** | 去掉假侧栏；Retry `sendInputEvent` |
| 加载态 | app bar track | 细进度，不挡产品 | **shell** |  |
| OAuth/connector | 独立窗，无 shell preload | 保持；Windows 标题栏 | **shell 保持** | fail-closed |
| 空会话 | web | web 空状态，不由 shell 画欢迎页 | **web** |  |
| 长内容溢出 | web | 中栏滚动、代码横向滚动 | **web** |  |
| 520×360 / 1366×768 | smoke 已有 | 小窗：下载/离线不裁切；大窗：app bar 不换行失控 | **shell** | 现有 smoke |
| 高对比/减少透明 | 已有 | 不透明 fallback | **shell** | smoke forced-colors |
| toast | 固定文案 | 继续；Win Action Center 保活 | **shell** | 单测；送达真机 |

## 5. 架构（硬边界不变）

```
BaseWindow
├─ app://aurora-shell   非持久 session，CSP，窄 preload
└─ https://claudeai.chat  persist:openclaude-v5-prod-v1，无 preload
```

禁止：`<webview>`、已弃用 `BrowserView`、DOM 选择器注入、`insertCSS` 魔改产品页、shell 读产品 DOM、把会话标题写入 caption/Jump List。

### 5.1 模块拆分（保持）

| 文件 | 职责 |
| --- | --- |
| `src/desktop-menu.mjs` | 命令描述表 → application menu / More popup |
| `src/desktop-chrome.mjs` | WCO 决策、不透明 overlay 颜色、原子双路径创建 |
| `src/download-notify.mjs` | toast；固定文案；click 只转发 opaque id；show 前 retain |
| `src/smoke-harness.mjs` | 有界轮询 / sendInputEvent |

### 5.2 WCO（仅 win32）

原子双路径：第一次 `hidden + overlay(height:44)`；仅构造抛错才 destroy 后走不含 overlay 的第二路径。`overlayActive` 仅成功路径为 true。

**几何合同**：`data-wco-ready` 仅当 overlay 激活 **且 CSS** `env(titlebar-area-width/height) > 0`。这是 drag/width 的唯一几何源，不另用 `getTitlebarAreaRect()` 以免与 env=0 的布局分裂。监听 `resize` 与 `windowControlsOverlay.geometrychange` 重新测量。

**未就绪安全态**：Electron `WebContentsView` 上 WCO 构造成功后 env 仍可能为 0。此时 `overlayActive && !wcoReady` 是**合法稳定态**：不启用 drag/width，右侧 padding 140px，避免控件落到系统 caption 下。Smoke 两种都 settle：env 正值走 safe-area；env=0 走 140px 预留。

### 5.3 菜单与 IME

真正快捷键只走 `before-input-event`。win32/linux：展示 accelerator + `registerAccelerator:false`。darwin：**省略** accelerator 字段。

### 5.4 下载 toast

- 固定 title/body；无文件名/路径。
- `complete()` 成功且窗口存活且非 smoke 才创建。
- **先** `retainNotification` **再** `show()`。
- win32：`close` 可能只是超时、Action Center 仍在，**不**因 close 释放实例；`failed` 才释放；窗口销毁清空；上限 20。
- 其它平台：close 可释放。
- 保活上限 20，**FIFO** 淘汰最旧实例。
- packaged 身份：`electron-builder.yml` `appId` 与 `src/main.mjs` `APP_ID` 同为 `chat.claudeai.aurora`；NSIS 创建开始菜单快捷方式。ToastActivatorCLSID 走 Electron/NSIS 默认，本阶段不另签自定义 CLSID。
- **保证范围**：仅窗口存活期间 click → opaque id → `showRegisteredDownload`。本阶段不做 tray/深链，**不承诺**进程退出后 Action Center 仍能打开下载面板。

### 5.5 明确不做（本阶段）

close-to-tray、自动启动、深链、自动更新、离线聊天、自定义协议、shell 复制 Codex sidebar/右栏/设置 IA、thumbar（缺合法 16px PNG）。

## 6. 需要独立 server/web PR 的部分

基线：`feat/v5-aurora-rewrite`。合入后再 **upstream-sync** 到 `feat/v5-windows-app`。禁止把整个 Windows 分支反向合入 server canonical。

建议拆分顺序：

1. **产品决策**：三栏是所有桌面 Web 用户的统一布局，还是仅 Windows 客户端？产品 view 无 preload，不能靠 shell 私下切布局。
2. **数据权威审计**：项目/工作区分组、环境、变更统计、文件树是否已有 API。缺则先独立 server/protocol PR；没有真相就保持右栏关闭。
3. **中栏排版 / composer / 设置页**（只消费现有数据）可先做 web-only PR，不必等虚构 server 工作。
4. **响应式栅格 + 左栏层级 + 右栏**，有数据再开。设置：左导航 + 行式页，映射现有五分区；Codex 独有且 V5 无能力的项不要做空入口。
5. web PR 补真 Chromium 交互测试；合入 `feat/v5-aurora-rewrite` 并按 web dist 生效面发布后，再 upstream-sync 做 Windows 集成验收。

用户要的「三栏 + 设置达到参考效果」只能在 web PR 部署并 Windows 集成验证后关单，不能由本 app-only PR 关单。

本 Windows PR **零** `packages/web-react` 改动。

## 7. Windows 化（相对 macOS 截图）

| Codex macOS | Windows 做法 | 原因 |
| --- | --- | --- |
| traffic lights 左上 | caption 按钮右上，WCO 高度 44 | 平台惯例 |
| 侧栏顶入 caption | 产品区从 app bar 下开始；左栏由 web 画 | shell 不画会话 |
| SF 字体 | Segoe UI Variable | skill |
| 半透明材料 | Win11 22H2+ Mica；Win10/forced-colors/减少透明不透明 | 避开透出 bug |
| 菜单栏 / 设置里「显示在菜单栏」 | Alt 应用菜单 + 自动隐藏；不做 tray | 本阶段不做 tray |
| Finder 作为打开目标 | **打开本地下载目录**继续由 shell 固定原生命令 `open-downloads-folder` 承担，web 不能经产品 view 要任意本地路径。web 独立 PR 只改云端/附件文案里的「Finder」字样 | 无 IPC bridge |
| macOS 开关键 | 行式开关可用 web 控件；shell 不用自绘假 WinUI |  |
| 覆盖式滚动条 | Windows overlay scrollbar |  |
| 右键 | 系统/Electron 菜单；产品内右键仍走 web |  |

## 8. Windows 适配矩阵

| 能力 | 本轮 |
| --- | --- |
| 44px 本地 app bar + 隔离产品区 | 保持；去掉离线假侧栏 |
| Win11 22H2+ Mica | 保持；WCO caption 不透明 |
| Win10 / forced-colors / 减少透明 | 保持 |
| Segoe UI Variable | 保持 |
| 窗口位置/尺寸/maximized + 多屏 workArea | 保持 |
| Alt+Left/Right、Ctrl+R、缩放、鼠标前进后退 | 保持 |
| F6；modal 焦点留在 shell | 保持 |
| 中文 IME | 保持 + 菜单不注册 accelerator |
| Jump List `--home` | 保持 |
| 下载 opaque ID / indeterminate / 焦点 | 保持 |
| 任务栏进度 | 保持 |
| WCO + geometry 重测 | **新建/加固** |
| Alt 应用菜单 | **新建** |
| 下载 toast + Action Center 保活 | **新建** |
| 三栏/设置视觉 | **不做**（web PR） |
| thumbar | 不做 |
| DPI 100–200% | DIP 保持；真机发布门 |

## 9. 测试计划

单测：IPC、argv、layout、裁剪、theme/forced-colors、下载状态机、URL/OAuth/权限、WCO 双路径、菜单 accelerator 策略、toast payload/retain/show 顺序/死窗口。

Smoke：真实双 view；`sendInputEvent`；有界轮询完整 attr/class/style 并打印最后状态；不并发抢前台。含按钮/Esc/Retry/F6/modal/焦点/indeterminate/forced-colors/520×360/1366×768；resize 后重测 `wcoReady`；未就绪 overlay 预留 140px；win32 overlay 路径 maximize/unmaximize。禁止 `about:blank` 假 smoke。

```bash
OPENCLAUDE_SMOKE_SCREENSHOT_PATH=/tmp/aurora-windows.png npm --prefix apps/windows run smoke
```

`apps/windows/docs/design-qa.md` 的 `final result: passed` **只表示 app-shell scope passed**。整机参考图相似度标 `pending web PR`。不得把 shell 截图解释成 Codex 主界面已达成。

视觉对照保留完整参考图作 comparison input，用区域标注区分 shell 已验收与 web 待办。像素 golden 不能替代真机。

本轮只能在 Windows 真机/RDP 证明、写入 PR 已知限制：

- `Alt → Esc` 焦点回到进入菜单前的 pane；自动隐藏菜单不永久挤压 44px 布局
- 安装后 toast 送达、超时后仍在 Action Center、窗口存活时 click 回到正确 opaque id
- Win10/11、100/125/150/200% 缩放、最大化/还原、至少一次跨屏移动下的 WCO 安全矩形
- 进程退出后 Action Center 点击：**不保证**

## 10. 版本与发布

- `0.3.0` → `0.4.0`
- 产物 **internal/unsigned**；不指导关闭 SmartScreen
- PR base：`feat/v5-windows-app`；required：`Windows app gate`
- 不自行合并
