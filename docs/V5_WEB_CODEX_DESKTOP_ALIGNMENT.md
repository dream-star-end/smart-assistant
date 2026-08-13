# V5 Web 产品区 ↔ Codex 桌面形态：审计与方案

> 状态：本轮只做审计与方案，不写实现、不开 PR。  
> 基线：`origin/feat/v5-aurora-rewrite` @ `e4f3fc930382a80dcbfc5a0920593777bcd07177`（Merge PR #428）  
> 工作树：`/Users/dengxuan/git_project/openclaude_v3/openclaude-v5-web-codex-desktop-audit`  
> 分支：`docs/v5-web-codex-desktop-alignment`  
> 参考图：Codex 桌面主界面（三栏 / 中区拆分+文件树）+ 设置页（左导航+行式控件）  
> 约束：Windows PR #429 只做本地 Electron shell；三栏主界面与设置页只能由 `packages/web-react` 实现。本地 shell 不得读远端 DOM、不得伪造会话/项目/环境、不得 `insertCSS`。

环境限制：本机没有 `oc-worktree` / `/opt/openclaude/worktrees-registry.json`，按 `parallel-worktree-workflow` 的独立开发环境例外使用 `git worktree add`。进入有注册表的共享环境后必须先 `oc-worktree adopt`。

---

## 0. 一句话结论

**不要按参考图原样画三栏。** V5 没有 Codex 桌面那种「本地工作区 + git 工作树 + 文件树 + 剪贴板来源」产品概念。推荐目的地是 **A′：桌面宽度下的数据门控三区**——左栏会话、中栏对话、右栏只渲染已有可靠数据的面板，空则折叠消失。落地必须先做 **方案 C 的 token/排版层**（可独立上线），再改信息架构。**否决方案 B（双套布局）作为主路径。** 参考图里没有权威数据的面板一律不画。

---

## 1. `packages/web-react` 现状结构摘要

### 1.1 技术栈与入口

| 项 | 现状 |
|---|---|
| 包 | `@openclaude/web-react`，Vite 8 + React 19 + TypeScript |
| 样式 | Tailwind CSS 4 + 自研 token（`src/styles.css` `@theme`） |
| 组件库 | **没有** shadcn/antd/MUI。Radix 原语（Dialog/Dropdown/Popover/ScrollArea/Switch/Tooltip）+ 自研 `src/components/ui/*` + `lucide-react` 线标 |
| 字体 | Inter Variable；中文回退 PingFang SC / Microsoft YaHei / Segoe UI |
| 主题 | `useTheme`：`light / dark / system`，写 `html.dark` + `localStorage oc_theme`，偏好可写穿后端 `preferences.theme` |
| 路由 | **无 React Router**。工作区 `view: home \| app`；会话深链 `/s/<id>`（`useAppRoute`）；法律页 `/terms` `/privacy` 在 `main.tsx` 短路；管理后台第二入口 `/admin.html` |
| 状态 | 无 Redux/Zustand。`App.tsx` 聚合 hooks：`useSessionList`、`useChatSocket`、`useRepoBinding`、`useAgentGate`、`useTheme` 等；会话权威在 server `client_sessions`，本地 IndexedDB 为缓存 |

### 1.2 桌面布局：两栏，不是三栏

工作区骨架在 `App.tsx`：

- **左栏**：`Sidebar` 固定 `w-[268px]`，`bg-sidebar`。`md+` 内联，可折叠；`<md` 走 `Sheet` 抽屉（同一 `Sidebar` 组件）。
- **中栏**：`main` 占剩余宽度。顶栏 `ChatHeader`（h-14）→ 可选 `RepoStatusBanner` → 消息流（`max-w-3xl` 居中）→ `PinnedTaskTracker` + `Composer`。
- **右栏**：**不存在。** 没有 ContextPanel / FileTree / 环境信息列。

其它「中心」全部是 **Modal 叠层**，不是第三列：设置、管理中心、市场、组织、教程、站内信、媒体任务、网页预览（`ContainerWebPreview` 全屏 overlay）。

响应式断点：

| 断点 | 行为 |
|---|---|
| `<768px`（`md`） | 左栏抽屉；顶栏汉堡；Composer 粗指针 Enter=换行 |
| `≥768px` | 左栏内联 268px；可折叠到顶栏「展开+新建」 |
| `1024px` | `clientFriction` 把视口标成 tablet，**不改变栏数** |
| 无 `≥1280` 三栏布局 | — |

**移动端与桌面共用同一套布局代码。** 左栏是同一 `Sidebar`；消息/Composer/设置 Dialog 也是同一组件。改桌面三栏若不用 `md:`/`xl:` 门控，会直接打到手机。

### 1.3 左栏信息架构（与参考图差在「分组轴」）

参考图按 **项目/工作区文件夹** 分组会话。V5 按 **日期** 分组：

```136:146:packages/web-react/src/lib/utils.ts
export function groupLabel(iso: string): string {
  // 今天 / 昨天 / 本周 / 本月 / 更早
}
```

侧栏条目：标题截断 + hover/focus 显重命名/删除。无次要元信息（模型、repo、未读）。底部账号区：头像 + 显示名 + 积分余额，点开设置。顶部还有管理中心/市场/教程/组织/超管入口——参考图没有这些，它们是 V5 一等能力，不能为了像 Codex 而藏掉。

`SessionMeta.pinned` 在 API/DB 存在，**侧栏未消费**，没有「置顶分组」。

### 1.4 中栏与输入区

- 助手正文 `.prose`：15.5px / 1.7；用户气泡 15.5px、`rounded-[20px]`、`max-w-[78%]`。
- 工具卡（Edit/Write/Bash/TodoWrite/…）在时间线内，流式展开、完成后折叠。
- Diff 在工具卡内（最多 60 行），**不是**参考图那种「已编辑 11 个文件 + Undo/Approve」会话级卡片。
- `Composer`：`max-w-3xl`、外壳 `rounded-[26px]`。左 `+`（附件/目标），右发送圆钮；语音在输入框内。**模型选择器在顶栏 `ChatHeader`，不在输入框右下角。** GitHub 绑定是 Composer 下方 `RepoPill`。
- `PinnedTaskTracker`：当前 turn 的 TodoWrite / plan 钉在输入框上方（参考图右栏「子工作区」的最近真实对应物）。
- `ContainerWebPreview`：容器网页预览，全屏 overlay，不是中栏分屏。
- 权限：`PermissionCard` 按次审批工具调用，**没有**全局「完全访问」开关。

### 1.5 设置页：Dialog + 顶 Tab，不是整页 master-detail

`SettingsCenter` 是居中 Dialog（`max-w-2xl`），顶栏 Tabs：

| 现分区 | 内容 |
|---|---|
| 账户与计费 | 余额、订阅、流水、组织 |
| 用量 | token/积分报表 |
| 偏好 | 主题、默认模型、思考深度、通知、快捷键、Auto-Dream、API Key（admin） |
| 反馈 | 反馈表单 |
| 关于 | 品牌/备案 |

插件/浏览器在 **管理中心** 的「插件」Tab（`ConnectorsTab`），不在设置里。没有：外观独立页、语言页、宠物、菜单栏、Finder、终端位置、钩子、Git、环境、Worktrees、已归档聊天独立页。

行式控件：偏好里已有「左标签 + 右 Select」雏形，但 `Field` 原语是 **上标签+下控件**，不是参考图的「左标题+说明 / 右控件」设置行。开关是 Radix，开态用 `--accent` 紫，不是参考图的系统蓝。

### 1.6 设计 token（已有体系，观感仍偏 Aurora 紫）

浅色：`--bg #fafafb`、`--sidebar #f5f5f8`、`--accent #6c54f0`。圆角档 `6/9/12/16/22/28/full`。阴影 soft/pop/float。字号语义档 title/section/body/meta/caption/micro。聊天正文仍大量 `text-[15.5px]` 任意值。无 spacing scale token（靠 Tailwind 间距）。

---

## 2. 数据权威审计（先于视觉）

原则：**没有真实数据支撑的面板一律不画。** 参考图是 Codex **本地**桌面（cwd=本机 git repo）。V5 商业版是 **远端容器沙箱 + 可选 GitHub clone**，不是本机 IDE。

### 2.1 逐面板结论

| 参考图面板 | V5 是否有对应概念 | 权威数据源 | 结论 | 若要做 |
|---|---|---|---|---|
| 左栏会话列表 | 有 | `GET /api/sessions/list` → `SessionMeta` | **已有可靠数据** | 纯前端改样式/密度即可 |
| 左栏按项目/文件夹分组 | **无**。只有日期分组。DB `client_sessions` 无 folder/project 列 | 无 | **无对应概念，不该画** | 新概念：migration + PATCH API + 侧栏 UX。估 **M**：storage 加列、list/patch、前端拖拽/新建分组。**不要**用 GitHub repo 名或 cwd 猜测分组 |
| 会话置顶分组 | 字段有（`pinned`），UI 未用 | `client_sessions.pinned` | **已有数据、未产品化** | 小：侧栏消费 pinned。估 **S** |
| 左栏底部账号 | 有 | `/api/me` 显示名+积分 | **已有可靠数据** | 样式对齐 |
| 中栏消息/工具卡/附件 | 有 | WS frames + tape 水合 | **已有可靠数据** | 卡片视觉向参考图靠，不改协议 |
| 中栏「已编辑 N 个文件」汇总卡 + Undo/Approve | 部分 | 单次 Edit/Write 工具卡有 per-file diff；**无** turn/workspace 级汇总，无 Undo/Approve 协议 | **不该画成参考图那种总卡** | 可在时间线内加强单文件卡（+m/−n）。会话级汇总需新协议从工具结果聚合，估 **M**，且 Undo 会碰容器文件系统——高风险，本阶段不做 |
| 中栏网页预览卡 | 有，但是 overlay | `ContainerWebPreview` + 容器 preview 通道 | **已有可靠数据** | 可做「对话旁打开」分屏，复用现能力。估 **S–M**，纯前端布局 |
| 中栏拆出文件查看器（打开 SHA256SUMS.txt） | **无目录树 / 无工作区浏览模型**。已有的是「已知绝对路径取文件」 | `GET /api/file?path=`（`gateway/src/server.ts` `handleApiFile`）：allowlist + 用户隔离，给工具输出里的绝对路径（如图片落盘）签名读取。记忆文件有 ManageCenter 编辑器；聊天附件有灯箱。**没有** `readdir` / workspace-scoped 文件树协议 | **不该画 IDE 文件树**。已知路径的预览可复用 `/api/file`，不能从它推出「打开任意文件」 | 文件树仍要新 list-dir protocol，估 **L**。若做打开已知路径，必须复用现有 `/api/file` 边界，禁止另做一套裸读。未立项前禁止画空文件树 |
| 右栏环境信息：本地/云端 | 部分 | `useAgentGate` 容器态；不是「本机 vs 云」 | **不可画「本地」**。AgentGate **留在中栏独占**（禁用 Composer），不进右栏，避免双权威 | 不另做右栏容器卡 |
| 右栏 git +/- 大数字 `+297,244 / −3,882` | **无** | 无 workspace `git diff --stat` API。绑了 GitHub 只有 `branch` + `head_sha` + clone status | **无对应概念，不该画** | 新协议：容器内 `git status/diff --numstat` 经 gateway 净化。估 **M**。未做前禁止假数字 |
| 右栏当前分支 | 有条件，且是**绑定时快照** | `RepoSelection.branch` / `head_sha`：clone/绑定流程写入，**不是** agent 后来 `checkout`/`commit` 后的 live HEAD | **可画「绑定仓库 / 绑定分支 / 绑定时 HEAD」**；禁止标成「当前分支」。未绑定不渲染。无 live `git status` | 右栏 Repo 卡只展示绑定元数据。估 **S**。要 live 分支需新 protocol（归 PR8） |
| 右栏 Commit & Push / Create PR 链接 | **无** 一等 UI | Agent 可用 Bash/gh；没有产品按钮 | **不该画成 chrome** | 真要做需 OAuth + 专用 API。估 **L**。本阶段让模型走工具，不做右栏按钮 |
| 右栏子工作区 16 running / 2 finished | **无** Codex worktree | 近邻：`PinnedTaskTracker` todos；`TeamPanel`/delegate；`MediaTaskCenter` | **可画「当前任务/委派」，不可画 worktree** | 把已有 HUD 挪到右栏。估 **S**。空则隐藏 |
| 右栏来源 / 剪贴板历史 | **无** | Inbox 是站内信；Composer 只消费当次 paste | **无对应概念，不该画** | 新能力。估 **L**，隐私面大 |
| 右栏文件树 + 筛选 | **无** | Glob 工具结果只在聊天里 | **不该画** | 同文件浏览器，**L** + protocol |
| 设置：常规/账户/用量/偏好 | 有，但是 Dialog+Tab | 见 §1.5 | **已有可靠数据** | 改成与 ManageCenter 同壳的近全屏 Dialog + 左导航。估 **M**，纯前端 |
| 设置：外观/语言独立页 | 部分 | 主题在偏好；无独立语言设置（UI 中文写死） | 外观可拆；语言 **不该画假选项** | 除非做 i18n（**L**） |
| 设置：个性化/宠物 | **无** | — | **不该画** | — |
| 设置：键盘快捷键 | 有 | 偏好 `hotkeys` | **已有可靠数据** | 迁到设置左导航 |
| 设置：使用情况与计费/账户 | 有 | 账户+用量 Tab | **已有可靠数据** | 导航重排 |
| 设置：应用快捷键/提权/菜单栏/Finder/终端位置 | **无用户向 web 开关**（本机 OS 能力） | Windows 这些属于 **本地 shell**，且 #429 明确不读产品 DOM | **不该画进 web** | 若要做，走 Windows/Harmony **app-only PR**，不是 web-react |
| 设置：浏览器/电脑视觉 | 部分 | 管理中心插件：`managed-browser`；无「电脑视觉」产品开关 | 浏览器入口可链到插件；电脑视觉 **不该画** | — |
| 设置：钩子/连接/Git/环境/Worktrees | **无** 用户向产品 | GitHub 绑定在 Composer；Worktrees 是开发者流程不是用户功能 | **不该画 Codex 同名页** | 连接器已在管理中心。Git 绑定可进设置「GitHub」节，不是 git CLI 设置 |
| 设置：已归档的聊天 | **无** 用户归档 | `deleted_at` 是软删；历史归档是 tape spill，不是用户文件夹 | **不该画「已归档聊天」** | 真要做需新状态+API。估 **M** |

### 2.2 会话/项目 API 现状（证据）

`SessionMeta`（`packages/web-react/src/lib/types.ts`）：

`id, agentId, title, pinned, createdAt, lastAt, messageCount, updatedAt, modelId`

`client_sessions`（`packages/storage/src/sessionsDb.ts`）同样没有 `project_id` / `folder` / `workspace_label`。

GitHub 绑定是 **per-session**：`GET/PUT /api/me/sessions/:sid/github-selection`，WS `outbound.control.session_repo_status` 带 `owner, repo, branch, headSha, status`。这是「这个会话 clone 了哪个 GitHub 仓库」，以及绑定时采集的 branch/HEAD 快照，不是 Codex 的「当前目录就是一个 git repo」，也不是 live `git status`。

权限：runtime 有平台控制的 `permissionMode`（含 `bypassPermissions`），由 gateway/agent 配置注入，**没有**用户级「完全访问」设置开关。参考图那个开关不该画进 web 设置；按次审批仍走 `PermissionCard`。

### 2.3 识别机制（方案 B 需要、当前没有）

Windows 产品 view：**无 preload、无 IPC**，`loadURL('https://claudeai.chat/')`，不带 `?client=`。Harmony 同样吃线上 SPA。web-react **没有** `isDesktopClient` / `aurora-shell` 客户端标识。UA 可伪造，且 Electron/ArkWeb UA 不稳定，不能当布局权威。

---

## 3. 三方案对比与推荐

| | 方案 A 全平台统一三栏 | 方案 B 桌面客户端专属布局 | 方案 C 只对齐 token/排版 |
|---|---|---|---|
| 做什么 | 所有 web 用户（含手机浏览器以外的桌面浏览器）改成 Codex 式三栏+设置整页 | Windows/Harmony 一套三栏，普通浏览器保持现状 | 不改栏数与 IA；改色、字号、行高、间距、圆角、开关/输入/卡片 |
| 对参考图完成度 | 若硬抄：**视觉 85–90%**，其中 ~30% 是假 UI。诚实版见 A′ | 仅原生客户端 **70–80%**（仍缺数据）；浏览器 **0%** | **35–45%** 观感接近，信息架构仍是现在的两栏+Dialog |
| 工作量 | XL（布局+所有中心+右栏+设置+回归）。假数据会返工 | XL + 永久双套。还要先发明客户端识别 | **S**（1 个纯前端 PR） |
| 移动端冲击 | 高。共用 `Sidebar`/`Composer`/`SettingsCenter`。必须 `xl:` 门控否则手机被毁 | 表面上不碰浏览器手机，但原生窄窗/平板仍要第三套 | 低（token 变更要跑 browser-tests + 真机） |
| 现网用户习惯 | 高。所有桌面浏览器用户侧栏/设置形态变 | 中。浏览器用户无感；桌面用户突然另一套产品 | 低 |
| 维护成本 | 单套布局，但右栏空态/折叠逻辑要一直养 | **双套布局 × 每个新功能**。违反「第二套并行机制直接否掉」 | 单套，只养 token |
| 可回滚 | 中（布局 PR 大）；feature flag 可降风险 | 差（客户端识别 + 两套 CSS/组件） | **好**（几乎纯 CSS/class） |
| 数据诚实性 | 硬抄会破产；必须降级成 A′ | 同样缺数据，只是假 UI 只给桌面用户看 | 不引入假面板 |
| 风险 | 高：移动回归、空右栏难看、假 git 数字 | 高：识别不可信、产品分裂、Windows 还要 upstream-sync | 低：视觉回归、对比度 |

### 推荐（明确取舍）

**目的地选 A′（数据门控的桌面三区），否决字面方案 A，否决方案 B。第一批可上线工作走方案 C。**

理由：

1. **架构硬边界**：Windows/Harmony 的产品 UI **就是**这份 web-react。shell 不能插入三栏。把三栏做成「仅客户端」等于承认 web 与桌面是两个产品，而客户端又没有可信识别通道（无 preload）。方案 B 会把每个后续功能变成两次实现、两次 browser-tests、两次真机。
2. **数据红线**：参考图右栏大数字、文件树、剪贴板、Worktrees、宠物、Finder **在 V5 里不存在**。方案 A 若按图施工，必然假 UI。A′ 的验收标准是「有数据才占列，没数据就是两栏」，视觉可以像 Codex，语义必须是 OpenClaude。
3. **方案 C 不是终点，但是唯一可独立、可回滚、不依赖拍板的第一刀。** 它让 Windows 44px app bar 下面的产品区不再那么「另一套皮肤」，又不改用户找会话/设置的路径。
4. **V5 已有能力应保留入口**：管理中心、市场、教程、组织、积分。参考图没有它们，不能为了对齐而藏到三层菜单。

A′ 在 `xl`（≥1280px）才开右栏；`md–lg` 保持两栏；`<md` 保持抽屉。右栏默认模块仅限：**绑定仓库元数据**、**当前 todos/plan**。其它模块未立项就不做。

**单实例规则（防假三栏）：** 任一数据块只允许一个 renderer。迁到右栏后，中栏对应 HUD/pill **必须卸载**，`<xl` 再回到中栏原位置。禁止同时渲染。AgentGate 继续独占中栏并禁用 Composer，**不进右栏**。PermissionCard 继续走时间线/modal，**不进右栏**。

需要用户拍板的点见 §6。

---

## 4. 规格文档与 PR 拆分

- 可验收 UI 规格：[`packages/web-react/docs/CODEX_DESKTOP_UI_SPEC.md`](../packages/web-react/docs/CODEX_DESKTOP_UI_SPEC.md)
- 全界面清单在规格文档 §8

### 4.1 拆分原则

每个 PR：单一主题、可独立评审、可独立上线（或 flag 关闭后无行为变化）、有明确验证。server/web 走 `feat/v5-aurora-rewrite` 受保护 PR；合入后再 upstream-sync 到 Windows canonical。本轮不开这些 PR。

### 4.2 PR 序列

| 顺序 | PR | 范围 | 依赖 | 类型 | migration/protocol | 验证 | 可独立上线 |
|---|---|---|---|---|---|---|---|
| 1 | **token 与密度** | 只改规格 §7.5 的「PR1 必改清单」列出的 class/token；不改栏数、不改设置壳、不搬模型选择器 | 无 | 纯前端 | 否 | 必改清单逐项有 before/after；`vitest` + `test:browser`；390 与 1440 对照 `browser-tests/ui-preview` 基线（本 PR 提交截图或 shoot 场景名） | 是 |
| 2 | **设置近全屏 master-detail** | 与 ManageCenter 同壳（`size=xl` 定高 Dialog + 左导航），**不是新路由**。现有五分区 + 插件深链；行式控件；**不**新增宠物/Worktrees/Finder。`<md` **必须**单列（见规格 §5.1） | 建议在 1 之后，可并行 | 纯前端 | 否 | 390×844：不得并排、不横溢、五分区可切、长项可滚、焦点/返回正确；教程 `settings.section` 深链；Desktop 左导航+内容 | 是 |
| 3 | **桌面右栏壳（空则隐藏）** | `xl+` 右栏；只接入绑定仓库卡 + todos 卡；迁入后中栏 RepoPill / PinnedTaskTracker 卸载（单实例） | 1 | 纯前端 | 否 | 无数据 → 两栏；有数据 → 三栏且中栏不再重复同一块；`<xl` 回到中栏原位置；AgentGate/Permission 仍在中栏 | 是 |
| 4 | **Composer/顶栏 chrome** | 模型选择是否下沉到输入条：需拍板。本 PR 最多做视觉（药丸输入、按钮位置），不擅自搬模型选择器 | 1；搬选择器依赖拍板 | 纯前端 | 否 | Composer 附件契约必须真浏览器；粗指针 Enter=换行不回归 | 是 |
| 5 | **会话列表视觉** | 活跃条、hover、账号区、日期分组样式。若做置顶：必须改 `Session` 类型 + `metaToSession`/`storedToSession`（这两处目前丢弃 `pinned`），仍可不碰 DB | 1 | 纯前端 | 否（pinned 列已有） | Sidebar 单测 + 键盘可达；置顶则断言 list 映射不再丢 `pinned` | 是 |
| 6 | **中栏分屏预览（可选）** | 把 `ContainerWebPreview` 从 overlay 改为桌面中栏右侧分屏；移动端保持 overlay | 3 的壳可复用 | 纯前端 | 否 | 现有 preview browser-tests；resize/焦点 | 是，可砍 |
| 7 | **项目分组（仅当产品拍板「要」）** | `client_sessions.folder_id` 或独立 folder 表；`GET /api/sessions/list` 与 PATCH 在 **gateway**（`server.ts`），不是只改 commercial | 5 | **web-react + gateway + storage + schema migration**；合入后走 V5 **runtime-source** 生效面（容器内 gateway 读 session 元数据） | **要 DB migration**；list/PATCH 契约变了还要协议/handler 测试 | storage 单测 + gateway list/patch 往返 + 旧会话 folder=null 走「未分组」 | 可独立，但是新概念；**不是纯前端** |
| 8 | **工作区 git/文件树（仅当拍板「要」且安全方案过审）** | 容器 `git diff --numstat` / `list dir` 净化 API。已知路径读取必须复用现有 `GET /api/file` allowlist，禁止第二套裸读 | 3 | protocol + gateway + 前端 | **要 protocol** | 路径穿越/跨用户 volume/密钥文件拒绝；无 repo 时 API 空而非假 0；不得用 `/api/file` 枚举目录 | 高风险，默认不做 |

PR 1–5 覆盖「像 Codex 但不假装是 Codex」。6–8 是增强，默认不进第一波。

不需要为本方案改 Windows app；#429 的 44px app bar 与产品区叠在一起后，PR1 的 token 就会显在桌面窗口里。Harmony 同理。

---

## 5. 风险

- **假 UI 诱惑**：设计评审会拿参考图逐像素对比。规格把「不该画」写成验收反例， Codereview 按表打回。
- **移动回归**：任何不加断点的 `flex` 三栏都会毁掉 iOS/ArkWeb。PR3 必须 `xl:` 门控 + 390px browser-test。
- **设置从顶 Tab Dialog 变近全屏左导航**：教程深链 `destination.kind=settings`、`productCapabilities` 必须跟着改，否则教程点了没反应（历史事故形态）。不是新路由。
- **双布局（B）**：一旦做了客户端识别，以后每个入口都要问「浏览器还是桌面」。拒绝。
- **git/文件树安全**：容器 FS 暴露给浏览器等于新的数据面。未做威胁模型前禁止。
- **Windows 同步**：web PR 合入 aurora 后还要 upstream-sync，否则桌面包仍是旧 dist。
- **对比度**：参考图更「系统灰/蓝」；V5 token 是紫 accent 且刚为 AA 调过。换蓝要重测 contrast，不要悄悄改回不达标色。

---

## 6. 需要用户拍板

1. **目的地是否接受 A′**（诚实三区，缺数据的面板不画），而不是「必须像素级复刻三张参考图」？
2. **方案 C 是否作为第一批可上线 PR**（不改 IA）？
3. **模型选择器位置**：留在顶栏（现状，移动更稳）还是搬到输入条右侧（更像参考图，顶栏会空）？
4. **V5 特有入口**（管理中心/市场/教程/组织）留在左栏顶部，还是收进账号菜单？推荐留在左栏，否则可发现性倒退。
5. **要不要立项「会话文件夹」**（PR7，要 migration）？没有的话左栏永远是日期分组，不可能变成参考图的 `openclaude-v3` 文件夹。
6. **要不要立项容器文件树/git stat**（PR8，要 protocol + 安全评审）？推荐 **不做**。
7. **设置页范围**：只重排现有分区，还是把「插件」从管理中心搬进设置？推荐设置里放深链，管理中心仍是插件权威，避免两个编辑器。
8. **Windows 本地设置**（菜单栏、下载目录、高对比）是否永远留在 native shell，不进 web 设置？推荐是。

---

## 7. Codex 审

- 工具：`npx @openai/codex@latest exec`（本机 npm 全局 `codex` 的 darwin 二进制缺失，改用 npx 0.147.0），`sandbox=read-only`，`approval=never`。
- 首轮 **PARTIAL**：6 项 Finding（`/api/file` 误标、branch 非 live、右栏双权威、PR7 包范围、设置窄屏、PR1 验收主观）。
- 文档按 Finding 修订后二轮 **PASS**：Finding 全部闭合，无新的必须修项。
