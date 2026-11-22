# OpenClaude V5（从简 AI / Clarvy）UI/UX 设计系统与 6 层硬门禁宪章

> **权威定位**：本文是 OpenClaude V5 个人版（`feat/v5-selfhost`）唯一权威 UI/UX 软约束与硬门禁设计宪章。前端高频速查见 `packages/web-react/AGENTS.md`，工程与自治流程见 `docs/V5_SELFHOST_PLAYBOOK.md`，全仓导航见 `AGENTS.md`。

---

## 1. 品牌身份与设计人格

- **品牌资产**：中文品牌 **从简**（全称「从简 AI」），英文品牌 **Clarvy**，中英文口号 **「让复杂，从简。」 / "From complex, to clear."**；法定主体「江西启序智能科技有限公司」仅出现于协议、备案、支付、发票与页脚。
- **产品定位**：以代码与科研为主战场、通吃深度知识交付（调研 / 文档 / PPT / Excel / 站点）的强模型 **Personal Agent OS**。
- **Clarvy Atelier 视觉人格（Editorial Tactile Craftsmanship）**：
  - 吸收极简降噪的倒 L 形 Chrome 与清晰信息层级，坚持 Clarvy 独有的 **Warm-Neutral 暖纸 / 深炭墨气质**。
  - **组件级设计感铁律（功能可用 ≠ 体验合格）**：按钮、图标、卡片、胶囊、弹窗、提示、表单、空态都必须有工艺与克制的层次感；严禁“仅换暖色调”的浅层换肤、全屏白底灰框扁平化、AI 赛博霓虹紫渐变与廉价厚重模糊阴影。
  - **全中心视觉一致**：聊天主页、管理中心、市场、组织、管理后台（`packages/web-react/src/admin/`）、设置、任务看板、站点托管、Studio、账户菜单、IUI 卡片，以及独立桌面壳 `apps/windows/src/shell/shell.css`，必须全面同步同一套 Clarvy Atelier 语言，消灭“主聊精致、二级页廉价”的断层。

---

## 2. Clarvy Atelier 色彩、材质、层级、字号、图标与动效

### 2.1 暖中性双主题色彩与单一权威源

以 `packages/web-react/src/styles.css` 为全前端**唯一语义 Token 权威源**：

| 主题 | 画布与层级表面 | 强调色与语义前景色 | 工艺红线 |
|---|---|---|---|
| **浅色（`:root`）** | 暖纸画布 `--bg: #faf9f6` → 暖灰侧栏 `--sidebar: #f3f2ed` → 纯白表面 `--surface: #ffffff` → 浮层 `--elevated` | 暖陶土主强调 `--accent: #a5421c`（AA ≥ 4.5:1） | 控件边界用 `--border-control`，分隔线用 `--border`，骨架屏用 `--skeleton`，禁止隐形输入框或隐形骨架 |
| **深色（`.dark`）** | 深炭墨 `--bg: #141416` → 抬升表面 `--surface: #1b1b1f` → 浮层 `--elevated: #222227` | 亮陶土 `--accent: #df7e59` + 深墨 `--accent-fg: #141416`；成功/警告/危险填充前景分别走 `--success-fg`/`--warning-fg`/`--danger-fg` | 4 级景深 + 顶部 1px 内高光 rim + 半透明 1px 发丝边框，禁止死黑糊成一团或亮色块压白字击穿对比度 |
| **品牌标识色** | `--color-brand: #c7ff64` / `--color-brand-fg: #0a0b09` | 仅限 `BrandMark` 与营销品牌时刻 | 日常工作台强调色全屏占比严格 `<5%` |

- **数学化衍生与碎片收敛**：hover/soft/border 衍生色优先使用 `color-mix(in oklch, ...)`；Tailwind v4 `@theme` 局部覆写必须同步重绑对应别名；禁止新增硬编码 hex，持续收敛 `packages/web-react/src/components/iui/iui.css`、`packages/web-react/src/components/studio/studio.css`、`packages/web-react/src/styles/landing.css`、`packages/web-react/src/styles/containerWebPreview.css` 中的私设变量与硬编码色值。
- **6 种核心 Atelier 材质原语**：全站统一复用 `.oc-surface-card`、`.oc-surface-card-hover`、`.oc-surface-glass`、`.oc-surface-recessed`、`.oc-surface-popover`、`.oc-icon-badge*`（含 `-accent`/`-success`/`-warning`/`-danger`/`-info`）及 `packages/web-react/src/components/ui/` 的 Radix + CVA 原语。

### 2.2 11 档 `--z-*` 语义层级表（严格单调递增）

定义在 `packages/web-react/src/styles.css` `:root`，明确区分页内浮层与 Radix Portal 菜单，彻底杜绝弹窗/全屏查看器遮住下拉菜单的层级竞价：

| Token | 数值 | 职责范围 |
|---|---:|---|
| `--z-base` | `0` | 常规文档流内容 |
| `--z-sticky` | `10` | 页内吸顶分组头、时间线吸顶条 |
| `--z-sidebar` | `20` | 桌面/移动侧栏导航层 |
| `--z-header` | `30` | 顶部栏、固定操作条 |
| `--z-popover-inline` | `40` | 页内非 Portal 轻量浮层（如上下文提示条） |
| `--z-drawer` | `50` | 侧抽屉（蜂群抽屉、任务抽屉、移动 BottomSheet） |
| `--z-modal` | `60` | 模态对话框（设置、订阅、确认弹窗） |
| `--z-viewer` | `70` | 全屏查看器 / 灯箱 / 大预览层 |
| `--z-popover-portal` | `80` | Radix Portal 下拉菜单 / Select / Command 弹层 |
| `--z-tooltip` | `90` | 全局 Tooltip |
| `--z-toast` | `100` | 全局 Toast / 紧急系统通知 |

- **核心不变量**：`--z-popover-portal (80) > --z-viewer (70) > --z-modal (60) > --z-drawer (50) > --z-popover-inline (40)`（由 `packages/web-react/src/test/designTokens.test.ts` 机械断言）。
- **硬禁令**：禁止新增裸 `z-[60..999]` 或 `z-index: 60..999` 竞价写法，一律使用 `var(--z-*)`（由 `scripts/check-ui-hard-gates.ts` 拦截）。

### 2.3 排版精度：三字族与 5+1 语义字号

- **三字族职责**：
  - UI/正文：`@fontsource-variable/inter`（特性 `"cv02","cv03","cv04","cv11"`）+ 6 级中文系统黑体栈（`PingFang SC` → `Microsoft YaHei` → `HarmonyOS Sans SC` → `MiSans` → `Noto Sans SC` → `Source Han Sans SC`）。
  - 代码/流式指标/模型倍率/耗时：等宽字体 `--font-mono` + `tabular-nums` 防数字跳动。
  - 阅读栏宽：主对话阅读区约束在 `60ch–72ch`，代码/Diff/调研文档/表格在右侧 Workbench 满幅铺开。
- **5+1 语义字号档**：

| 语义类名 / Token | 字号 / 行高 | 适用场景 |
|---|---|---|
| `text-title` / `--text-title` | `15px` / `1.4` | 面板标题、对话框标题 |
| `text-section` / `--text-section` | `13.5px` / `1.45` | 分区小标题、卡片主标题 |
| `text-body` / `--text-body` | `13px` / `1.55` | 紧凑工作面正文、列表主文案 |
| `text-meta` / `--text-meta` | `12px` / `1.5` | 次级说明、时间戳、辅助操作 |
| `text-caption` / `--text-caption` | `11px` / `1.45` | 徽章标签、紧凑元信息 |
| `text-micro` / `--text-micro` | `10px` / `1.4` | **受限档**：仅角标/序号等确无空间处，新代码优先用 `text-caption` |

- **铁律：严禁覆写 Tailwind 原厂 `text-base` / `text-sm` / `text-xs` / `text-lg`**：输入框依赖 `text-base md:text-sm` 保证 `<768px` 恒为 `16px` 以防 iOS Safari 自动放大且不回弹；`text-lg`（18px）服务多处大页头。存量 `text-[Npx]` 持续用 `scripts/codemod-text-size-tokens.mjs` 收敛。

### 2.4 现代双色调图标与克制动效

- **双色调图标体系**：统一使用 `packages/web-react/src/components/ui/AtelierIcons.tsx`、`packages/web-react/src/components/ui/ModelFamilyIcons.tsx` 与校准线宽/光学对齐的 `lucide-react` 图标；模型家族用专属几何徽标，蜂群用星轨连接徽标；**严禁**古老 CPU 芯片图标、粗糙空心线框或突兀纯黑实心大圆。
- **克制的微动效纪律**：
  - 仅采用 Material 3 曲线 `--ease-standard`、`--ease-emphasized`、`--ease-emphasized-decel`、`--ease-emphasized-accel`、`--ease-spring`（空间因果动效 `120ms–200ms`）。
  - 暖陶土呼吸光标、双层 `.oc-alive-dot`、轻弹簧按压、Tabs 滑动底板、弹层退场必须服务于状态因果反馈；**同一轮次最多一处流光**，正文书写与终态禁止重复动效。
  - **强制无障碍降级**：所有含 `@keyframes` / `animation:` 的 CSS 文件必须具备同文件或全局 `prefers-reduced-motion` 覆盖，并兼顾 `forced-colors` 兜底（由 `scripts/check-ui-hard-gates.ts` 机械检查）。

---

## 3. 信息架构与交互体验铁律

### 3.1 零学习成本与无限续聊（能自动尽量自动）

- 全引擎在 ≥78% 安全上下文边界后台静默压缩/滚动检查点；遇到 `413` / `context_too_long` / `PROMPT_TOO_LONG` 时后台自动压缩并无感重试，对话中仅留一条极安静人话分隔线（「已自动整理较早对话，可继续无缝聊下去」）。
- L2 记忆自动合并与 >60 天冷技能收纳后台静默运行、**100% 可逆归档**（搜索 0 命中自动兜底召回）；管理中心仅呈「自动保洁运行中」与「随时可恢复」记录。
- **黑名单**：严禁向用户聊天面暴露 `checkpoint_reset`、`PROMPT_TOO_LONG`、bytes/tokens 拆解柱状图、80% 警告横幅、手动催促 `/compact` 压缩、给用户布置记忆/技能整理作业或暴露双会话类型概念。

### 3.2 Manus + Codex 过程披露与「厨房 ≠ 上桌」

- **单一稳定过程区**（`packages/web-react/src/components/chat/ProcessDisclosure.tsx`）：同一用户轮保持单一过程区，不切碎为「过程—响应—过程」；cleared goal 严禁留墓碑空壳。
- **运行态 vs 完成态**：运行态用 Codex 无框线性活动流，表头展示人类可读动词与 `toolSummary`/工单号（原始命令/路径/job ID 收入展开审计）；中间旁白与最终答复共享同一正文排版、流式边出边全文可读（禁降级小字灰字或先 clamp 两行）；完成态收起为极简单行（`完成 · 调用了 N 次工具 · 耗时 积分`），隐藏完成后的探索/验证子行；对话区无头像排版、页脚隐藏 token 计数。
- **「厨房 ≠ 上桌」状态诚实**：`thinking` / `tool` 属于厨房过程，不算正文上屏；一旦正文上桌，严禁回落「思考中」；严禁因仅收到 thinking/tool 误清 `_sendingInFlight`。

### 3.3 顶栏、侧栏、模型选择器、输入坞与 `/btw`

- **顶栏**：单行对称（手机 `48–52px`），仅放当前会话强相关控件（模型/档位胶囊 + Workbench 按钮 + `···` +「订阅」）；移动胶囊去渠道括号后缀；`≡` 最多 6px 静默状态点；**严禁** `99+`/`40` 红紫焦虑大数字泡泡、顶栏残影边框或把全局设置混进会话菜单。
- **侧栏**（`packages/web-react/src/components/Sidebar.tsx`、`packages/web-react/src/components/sidebar/PendingDecisionsDock.tsx`）：一级导航精简高频项；「待拍板」默认折叠占 1 行、持久化偏好、多条时限高独立滚动且点击直达对应任务抽屉；「运行中」不套双层白卡；底部账户区去谜语图标、仅留 1 枚站内信铃铛、主题切换内联进账号菜单。
- **模型选择器**：移动双区 BottomSheet / 桌面双栏 / 矮屏 2-Tab；品牌几何徽标 + 等宽倍率；「最近」与全量去重；蜂群开关放在支持模型的参数区，切不支持蜂群模型再切回绝不偷偷复活旧蜂群；**永不限制或写死思考深度**。
- **输入坞（Composer）**：悬浮极简输入坞，左下角稳守 `[📎][+]`；附件必须用 `<label htmlFor>` 激活 file input（禁 `input.click()`）；支持 `/` 命令补全、中文 IME `isComposing` 防误发、`<768px` 恒为 `16px`、点发送即刻上屏防二次连点误触「停止」；`<640px` 禁止外部孤立仓库废行，375px 零按钮溢出。
- **快问（`/btw`）**：复用主 `<MessageList>` 过程披露与 `PermissionCard`，自动增量关联主线只读摘要（无手动开关），**默认继承主强模型禁暗降**，未转正前不泄漏到侧栏或全局搜索。

### 3.4 左指挥右 Workbench、蜂群、对话内审批与 IUI 容错

- **左指挥右 Workbench**（`packages/web-react/src/components/InspectorPanel.tsx`）：右侧常驻 `产出 | 浏览器 | 计划` 三 Tab（过程降级为单步下钻 + 返回条）；过滤幽灵构建产物（如 `/assets/styles-*.css`）；覆盖代码/文档/PPTX/DOCX/XLSX（按页/单元格批注回填）/站点可视编辑/科研溯源；严守「无数据时零占位、禁无 API 假数据、报错态不留无效批注按钮」；移动端强制 **2-Bar 布局**（`48px` 顶栏 + `44px` 底栏 + ≥82% 全出血内容区），杜绝多层套娃顶栏与双层嵌套滚动。
- **蜂群与后台任务感知**：`packages/web-react/src/components/chat/SwarmBoardDrawer.tsx` 在移动端近全屏、默认收起搜索栏防弹键盘、killed 成员折为单行、完成后自动收起悬浮 Dock；关闭蜂群后续聊绝不复活旧蜂群；`packages/web-react/src/components/chat/LiveAgentCapsule.tsx` 统一聚合会话内后台委派/Swarm/Muse/定时续跑并支持单条取消，严禁把原始 `lease ls-` 或 `env HOME=...` 噪声糊给用户。
- **对话内就地审批**：通过 `present_task_approval` 在对话内就地呈卡（10 秒可读清风险/影响半径/Diff/一键动作），并与侧栏待拍板收件箱及 IM 遥控同步；严禁一边后台派发执行一边贴 backlog 审批卡自相矛盾。
- **IUI 高容错与 Markdown**：20+ IUI 交付组件对裸数组、粘连围栏、缺字段必须宽容兜底降级为干净 Markdown，禁止模型微偏 schema 就报「这个组件无法显示」；任务面板与文档区域凡可渲染 Markdown 处均完整支持。

### 3.5 红卡不可变、中性工具报错、单 Writer 滚动与多视口纪律

- **红卡不可变与中性工具报错**：
  - 计划内重启/SIGTERM、容器回收、用户点 Stop、旧 leftover 重放、恢复宽限期**一律不出红卡**。
  - 真故障终态一次性提交不可变 `_errorCardSnapshot`（禁闪烁、消失、红变黄或覆盖）；严禁把 `AUTH_ERROR` 伪装成「模型服务暂时中断」；限流卡必须附带「换模型继续」逃生入口。
  - 工具非预期错误前台默认折叠、使用中性表头（「已结束」）、无红框，原始 `error`/`isError` 保留供展开审计（需人决策的权限/确认/安全阻断保持展开）。
- **单 Writer 滚动铁律**：聊天主视口 `scrollTop` 仅由 `packages/web-react/src/components/chat/stickToBottom.ts` 与 `packages/web-react/src/hooks/useChatScroll.ts` 唯一写入，`.chat-scroll-area { overflow-anchor: none }`；程序化跳转唯一路径 `followBottomRef.current = false → stick.correctTo(scroller, targetTop)`；严禁新增 `.scrollTop =` / `.scrollTo(` / `.scrollIntoView(` 或 `400ms` 计时器替代惯性围栏。
- **多视口、44px 触控热区与弹窗隔离**：
  - 响应式统一使用 `useViewportClass()`（`packages/web-react/src/hooks/useMdViewport.ts`：`compact <640` / `medium 640-1023` / `expanded 1024-1199` / `wide ≥1200`），覆盖 `1440`/`1280`/`768`/`390`/`375`/`360`/`320px`、鸿蒙 ArkWeb（视频签名防 410 + `playsInline` + `preload`）与 Windows 桌面端。
  - `<640px` 主操作触控热区 ≥ `44×44px`；遵守 PWA `safe-area` 与 `visualViewport`（不覆写 `.oc-center-dialog`）；用 `min-width: 0` 防横向溢出（**严禁**给 `html`/`body` 加 `overflow-x: hidden` 遮丑）。
  - 嵌套子弹窗留在父组件 React 子树内防 Radix `deferPointerDownOutside` 级联关窗，关闭后清零唤起信号；严禁裸用 `React.lazy`（须经 `packages/web-react/src/components/ChunkErrorBoundary.tsx` / `packages/web-react/src/appLazyViews.tsx` 包裹）；修改公共 UI 组件前先全量 Grep 关联测试。

---

## 4. 6 层 UI/UX 硬门禁漏斗与执行命令

> **当前接线状态（严格区分已入 PR CI 与本地/校准态脚本）**：
> 1. **已接入 PR CI 硬阻断**：L1 静态门（`scripts/check-ui-hard-gates.ts`、`packages/web-react/src/test/designTokens.test.ts` 随 `test:web-react`）、`typecheck:preview`（`packages/web-react/tsconfig.browser-tests.json`）、L2/L3 实景 Chromium 多视口布局与 DOM a11y 门（`packages/web-react/browser-tests/layout-invariants.mjs --tier core --baseline packages/web-react/layout-invariants-baseline.json`，B 类存量基线由 `scripts/check-monotonic-baselines.ts` 守单调）、L5 构建期 470 KiB & CSS 预算（`packages/web-react/budgets.json` + `npm run build:web-react`）与 `scripts/check-file-size-ratchet.ts`、`npm run test:browser` 既有真浏览器套件、`scripts/check-v5-e2e-selectors.ts`。
> 2. **已落盘脚本（未接入 PR CI 阻断，清晰分层）**：L4 `packages/web-react/browser-tests/ui-preview/shoot.mjs --tier=core`（本地/按需像素截图对比，待固定 Linux 基准图后接入 PR CI）；L6 `scripts/check-vlm-aesthetic-judge.ts` + `packages/web-react/browser-tests/vlm-rubric/rubric.json`（已落盘且单测入 PR CI，当前 `mode: "advisory"` 2 周校准态，未接入实时 VLM PR 阻断）。
> 3. **P2 计划（尚未落盘）**：L5 LHCI CWV（`LCP≤2.5s`/`CLS≤0.1`/`TBT≤200ms`）。

| 层级 | 门禁职责与落点文件 | 当前执行状态 | 关键命令 / 防篡改保护 |
|---|---|---|---|
| **L1 静态样式 / Token / `--z-*` / 滚动 / 术语 / 动效** | `packages/web-react/src/test/designTokens.test.ts`（3 主题 AA + Token 棘轮 + `--z-*` 单调断言）、`packages/web-react/design-tokens-exempt.json`（A 类豁免）、`packages/web-react/design-tokens-counts.json`（B 类计数）、`packages/web-react/ui-static-baseline.json`（B 类基线）、`scripts/check-ui-hard-gates.ts`（单 writer 滚动 / `--z-*` 竞价 / 零学习成本文案 / `prefers-reduced-motion`） | **已接入 PR CI 硬阻断**（本地 `<5s` + `v5-selfhost-gates.yml` / `v5-selfhost-web-react.yml`） | `npm run check:ui-gates`<br>`npx vitest run packages/web-react/src/test/designTokens.test.ts` |
| **L2 多视口几何布局不变量** | `packages/web-react/browser-tests/layout-invariants.mjs`（A 类锁）+ `packages/web-react/layout-invariants-baseline.json`（B 类存量基线）：核心 11 场景 × 4 视口（`390×844`/`768×1024`/`1280×800`/`1440×900`）× 双主题检测零横向溢出、零控件重叠、零非省略截断、`<640px` 44px 热区，失败画红框落盘截图 | **已接入 PR CI 硬阻断**（`v5-selfhost-web-react.yml` `web-react-browser` 真 Chromium 实跑 + `check-monotonic-baselines.ts` 守基线单调） | `npm run check:layout-invariants`<br>（单测在 `scripts/__tests__/check-ui-hard-gates.test.ts`） |
| **L3 运行时 DOM 无障碍** | 集成在 `packages/web-react/browser-tests/layout-invariants.mjs`（检测无名按钮/缺 `alt`/缺 `<html lang>`，环境中存在 `@axe-core/playwright` 时自动叠加 `wcag21aa`） | **已接入 PR CI 硬阻断**（随 L2 `--tier core` 同导航执行） | 随 `npm run check:layout-invariants` 零额外启页执行 |
| **L4 像素视觉回归** | 复用 `packages/web-react/browser-tests/ui-preview/shoot.mjs`：`--tier=core`（核心 36 场景）与全量 257 场景；`bug/refactor/perf(v5):` 禁改基线，`ui(v5):` 在 L2/L3 全绿下受控更新 | **可执行脚本已落盘（本地/按需运行，尚未接入 PR CI 实景视觉快照阻断；全量归 Nightly）** | `node packages/web-react/browser-tests/ui-preview/shoot.mjs --tier=core --list` |
| **L5 首屏体积与 CSS 体积棘轮** | `packages/web-react/budgets.json`（470 KiB = `481,280 B` 硬预算 + `460,800 B` 软告警 + CSS 总量预算）+ `packages/web-react/vite.config.ts` + `scripts/check-file-size-ratchet.ts`（含 `.css` 与黄区冻结）；LHCI CWV（`LCP≤2.5s`/`CLS≤0.1`/`TBT≤200ms`，P2 计划） | **已接入构建期 + PR CI 硬阻断**（`build:web-react` / `file-size-ratchet` / `monotonic-baselines`；LHCI 为 P2 计划） | `npm run build:web-react`<br>`npx tsx scripts/check-file-size-ratchet.ts` |
| **L6 独立 VLM 审美 Rubric 评委** | `packages/web-react/browser-tests/vlm-rubric/rubric.json`（A 类 5 维 Rubric）+ `scripts/check-vlm-aesthetic-judge.ts`（条件触发/强制 CoT/`$0.50` 与 2 轮封顶/fail-closed） | **已落盘 + 单测入 PR CI；`advisory` 2 周校准态（尚未接入实时 VLM PR 阻断）** | `npm run check:vlm-judge -- --dry-run`（Rubric 锁入 A 类 `CODEOWNERS`） |

### 专项补齐门与日常必跑命令清单

```bash
# 1. 本地秒级前端静态快门 + 预览类型检查 + 纯引擎单测（<10s，均已接入 PR CI）
npm run check:ui-gates
npm run typecheck:preview --workspace packages/web-react
npx tsx --test scripts/__tests__/check-ui-hard-gates.test.ts scripts/__tests__/check-vlm-aesthetic-judge.test.ts
npx vitest run packages/web-react/src/test/designTokens.test.ts

# 2. 全量前端单测、既有真浏览器套件与 L2/L3 实景布局不变量（均已接入 v5-selfhost-web-react.yml PR CI）
npm run test:web-react
npm run test:browser
npm run check:layout-invariants

# 3. 470 KiB 首屏预算构建 + 选择器同步门（已入 CI）+ 本地按需教程/L4 视觉快照/L6 advisory 校准
npm run build:web-react && npm run check:v5:e2e-selectors
npm run check:tutorials
node packages/web-react/browser-tests/ui-preview/shoot.mjs --tier=core --list
npm run check:vlm-judge -- --dry-run --changed-files packages/web-react/src/styles.css
```
