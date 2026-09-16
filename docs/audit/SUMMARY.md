# v5 个人版审计 · 总览（SUMMARY · 初稿，t-632）

> 给用户终审的**唯一入口**：本文按「目标 → 方法 → 12 模块结论 → 补审专项 → 集成记录 → 遗留 → 验证总表 → 分支 / 提交总表 → 评审入口」组织；每个数字都能在各模块正文 `docs/audit/<slug>.md`、归档摘要 `docs/audit/archive/<slug>.md` 或 `docs/audit/INTEGRATION.md` 里找到出处，每个 SHA 都可在仓库 `git cat-file -e` 核实。
> 本文只汇总不复制正文（q-786 口径）；未跑的验证一律标 **NOT RUN**。
> 版本：初稿（t-632，基于 integration `36bb9a677` = 集成③ 终点）。终稿 t-897 补齐 §4 / §9 标「终稿补」的项。

## 1. 目标与范围

对 v5 个人版（selfhost，`packages/web-react` 用户端）**全部页面 / 模块**做一轮 UI/UX、功能正确性、交互友好性审计，审出的问题**直接改代码落地**（P1 / P2 必修，P3 量力而行并登记遗留），指挥官验收、合入 integration 分支 `feat/v5-selfhost-ocv5-audit-ux` 后统一归档给用户终审。

- 基线：`feat/v5-selfhost` @ `210b9967892b3624fb3984f69d2174e4a641b33d`（2026-09-15）。
- 范围：12 个模块（§3）+ 覆盖复查补出的 5 个缺口（§4）；不含 `admin.html` 管理后台、`packages/{commercial,gateway,storage,protocol,cli,channels}`、`apps/windows/**`、部署脚本（PLAYBOOK §9）。前端发现必须改协议 / 后端才能修的问题一律登记「需后端配合」，未动后端。
- 时间：2026-09-15 → 09-17（集成③ 终点 09-17 01:45）。

## 2. 方法与口径

| 项 | 内容 | 出处 |
|---|---|---|
| 作业环境 | 本机到 v5-dev / 22 端口不通，**全部在本地克隆 + 每人独立 git worktree** 上做：主克隆 `v5-selfhost`（只读参照），`wt\<slug>` 工作树，分支 `feat/v5-selfhost-audit-<slug>`，成员只推自己的分支，指挥官合入 integration；合入 canonical `feat/v5-selfhost` 与 Lease Center 发布需要 v5-dev 通道，**本轮不做** | 决策 d-24、`TEAM_PLAYBOOK.md` §1–§2 |
| 提交纪律 | subject 禁用 `fix(v5)`（仓库门禁要求带真实 Incident trailer，本轮无事故编号，禁止编造），一律 `feat / refactor / style / test / docs / chore(v5)`；禁止 `reset --hard` / `stash` / force-push；不碰 `changelog.json`；`git add` 精确文件 | 决策 d-26、PLAYBOOK §7 |
| 证据工具 | UI 审计以 `packages/web-react/browser-tests/ui-preview/shoot.mjs` **截图台**为主要证据：真组件 + 真 production CSS + 真 Chromium + api-stub 假数据，每个场景 desktop / mobile × light / dark 四张；每模块 before / after 各一套，PNG 存仓外 `D:\code\test_project\test123\.audit-tmp\<slug>\{before,after}\`（不入库），场景文件 `scenes-*.tsx` 随代码提交 | 决策 d-28、PLAYBOOK §4 |
| 两阶段流程 | 阶段 A 审计（只出 `docs/audit/<slug>.md` + 场景，不改业务代码；问题编号 / 位置 / 严重度 / 修复计划）→ 指挥官评审 → 阶段 B 修复（按批准计划改代码，每改动配测试；typecheck + 模块 vitest + 改到高频交互面跑 `test:browser` + after 截图）→ 二期（遗留 P3 收尾）→ 补丁 / 专项 → 集成 → QA 复核 | PLAYBOOK §6 |
| 严重度 | P1 功能不可用 / 数据错误 / 阻断主流程；P2 明显体验缺陷 / 一致性破坏 / 移动端不可用；P3 打磨项 | PLAYBOOK §5 |
| 审计清单 | 七项：UI/视觉、响应式/移动端（390px、触控 ≥44px）、交互反馈、功能正确性、可访问性、文案、代码质量（仅影响用户可感知处） | PLAYBOOK §5 |
| 归档口径 | 摘要 + 索引不复制正文；每个 SHA `git cat-file -e` 核存在；统计排除作废条 t-837 | 决策卡 q-786、t-632 任务书 |
| 协同 | 文件归属表（PLAYBOOK §8）+ 写锁；跨模块需求 `send_to` owner 或登记接线，由集成轮统一落地；越界改动须指挥官批准并单列 | PLAYBOOK §8 |

## 3. 12 模块逐个结论

计数口径：「审出」= 阶段 A 问题清单（P1 / P2 / P3）；「已修」= 各正文修复记录里 ✅ 项（含二期 / 补丁），◐ 部分修复单列；「遗留」= 正文遗留章节仍开放的本模块归属项（需后端 / 需 shell / 产品口径 / 不修有判据）。全部数字转录自各模块正文，抽查 shell / tools / media / market / taskboard / settings 六份正文的结论行与本表一致（t-632 复核）。

| # | 模块 | 任务 | 审出（P1 · P2 · P3） | 已修 | 遗留 | 一句结论 | 分支 @ HEAD | 合入 | 摘要 / 正文 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | shell 应用壳层与设计系统 | t-30 A / t-31 B | 20（1 · 8 · 11） | 18 + ◐1 | 2 暂缓（S-08 / S-20 等用户拍板） | P1「桌面端 `⌘K` 把整页点死」已修（按视口分流）；Esc 归弹层不再掐掉生成中回合；设计系统层（Button / Chip 触控 44px、语义色对比度守卫、Alert 播报级别、横幅栈折叠、主题跨标签同步）为其余模块打底 | `feat/v5-selfhost-audit-shell` @ `39697560b` | 集成① 起点 `e6f73dd99` 已含 | [archive/shell.md](./archive/shell.md) · [shell.md](./shell.md) |
| 2 | messages 消息渲染与时间线 | t-32 A / t-33 B / t-629 二期 | 25（0 · 4 · 21） | 22 | 3（M-21 需独立设计 / M-24 需状态机专项 / M-25 需真后端复现） | 只读面死按钮、触屏动作行折叠、宽表不拆词、流式光标内联、评价 chip 触控与配色全部落地；二期复核三条遗留均不可独立完成，代码改动 0 | `feat/v5-selfhost-audit-messages` @ `2abe389a9` | 集成① `985b3ae57`（B）→ 集成③ `cd58600e8`（二期） | [archive/messages.md](./archive/messages.md) · [messages.md](./messages.md) |
| 3 | composer 输入区 / 会话头 / 模型与目标 | t-34 A / t-35 B | 35 + 承接 M-16（0 · 13 · 22） | 32 | 4（C-16 / C-26 / C-30 / C-32 团队卡；C-32 已由集成待办 t-865 `d4b061e37` 落地） | 两行式输入区、语音状态播报、草稿超限预警、排队发送入口、模型切换中态 / 最近去重、目标对话框并发保护、窄屏更多菜单与快捷键平台化 | `feat/v5-selfhost-audit-composer` @ `70d3db8b3` | 集成② `ae0b0cb64`；接线 `19799c0fe` | [archive/composer.md](./archive/composer.md) · [composer.md](./composer.md) |
| 4 | sidebar 侧栏 / 会话 / 项目 / 站内信 / GitHub | t-36 A / t-37 B / t-627 二期 | 38（0 · 12 · 26）（编号行 50，正文统计 38，摘要已注） | P2 12/12 + P3 多数 + 二期 S-14（正文未给逐条计数） | 0 归属内；需后端 2（UCP-01 / GH-03） | 重命名 / 删除 / 加载更多失败不再静默、项目列表失败自动重试、拖宽把手键盘可调、多选保留状态点、看板指令版本冲突单独提示、项目范围深链冷启不回落 all（T-02） | `feat/v5-selfhost-audit-sidebar` @ `25c775295` | 集成① `3cff04c85`（B）→ 集成② `b41e804ac`（二期）；接线 `678fe9d38` `09d15400f` | [archive/sidebar.md](./archive/sidebar.md) · [sidebar.md](./sidebar.md) |
| 5 | manage 管理中心 | t-38 A / t-39 B / t-426 补丁① / t-626 二期 | 27 + 跨模块 3（1 · 8 · 18） | 22 + 补丁① 4 + 二期 1 + 承接 X-03 | 2 需后端（M-17 / M-06 ③） | P1 `cronBlocked` 误渲染空态收口；技能列表 / 工作台 / 项目专属技能改造；记忆面板读失败与空态互斥；`cronHuman` 支持星期 / 小时区间（X-03） | `feat/v5-selfhost-audit-manage` @ `6fae01440` | 集成① `09a13a472`（B）→ 集成③ `c761bbd93`（二期） | [archive/manage.md](./archive/manage.md) · [manage.md](./manage.md) |
| 6 | settings 设置中心 / 组织 / 支付 | t-40 A / t-41 B / t-426 补丁① / t-628 二期 | 43（0 · 12 · 31） | 41 + 二期 4（SET-42 ② 检查更新、备案占位、分页去重、SET-14 判定） | 需后端 2（SET-09 / SET-10）· 跨模块 2 · 不修 3 | 壳层与偏好、用量 / API 接入统计卡、计费与支付、组织中心、ChatGPT 直连移动端 Tab 全部按审计落地；补丁① 承接 manage 的 ConnectorsTab 四项 | `feat/v5-selfhost-audit-settings` @ `5eac1b807` | 集成② `5e5ed6925`（B + 补丁①）→ 集成③ `12fc17579`（二期） | [archive/settings.md](./archive/settings.md) · [settings.md](./settings.md) |
| 7 | taskboard 任务面板 | t-42 A / t-43 B / t-630 二期 | 30（2 · 14 · 14） | 27 + ◐2 + T-02 由 sidebar 修 | 2 部分（T-20 shell 类型 / T-28 后端约束） | P1「切换 projects/agents 数据丢失」与 T-02 深链回落已修；看板 / 列表 / 抽屉 / 设置面板 P2 14/14；二期消掉 `typecheck:preview` TS2322（场景 1 行） | `feat/v5-selfhost-audit-taskboard` @ `05dd185df` | 集成① `bf8188def`（B）→ 集成③ `425655631`（二期） | [archive/taskboard.md](./archive/taskboard.md) · [taskboard.md](./taskboard.md) |
| 8 | tools 工具卡 / 智能体过程 / 检查器 | t-44 A / t-45 B | 31 + 跨模块 4（1 · 7 · 23） | 31 / 31 | 0（跨模块 4 转 owner / 集成②：T-18 选中态由 `19799c0fe` 接线） | P1 Grok 输出归一化只对原生名与明确信封生效；状态单一权威、信封解包、触控靶、a11y、文案全部收口 | `feat/v5-selfhost-audit-tools` @ `d65c6741e` | 集成② `6fa690d7e` | [archive/tools.md](./archive/tools.md) · [tools.md](./tools.md) |
| 9 | market AI 市场 | t-46 A / t-47 B / t-625 二期 | 26（1 · 4 · 21） | 13 + 二期 10 = 23 | 3（K-23 不做有判据 / K-25 需后端 offset / K-27 需 shell Checkbox） | P1「发布草稿关弹窗无提示丢失」已落盘；发现页卡片截断 / 分区计数 / 加载更多报错；二期收掉已安装行动作簇、就绪徽章、kill-switch 窄屏折叠、徽章解释 Tooltip、插件契约人话 | `feat/v5-selfhost-audit-market` @ `5391c150a` | 集成② `ab765669a`（B）→ 集成③ `be20adaec`（二期）；接线 `19799c0fe` | [archive/market.md](./archive/market.md) · [market.md](./market.md) |
| 10 | landing 落地页 / 登录 / 法务 / 桌面端登记 | t-48 A / t-49 B | 20 + 跨模块 3（0 · 3 · 17） | 16 + ◐2 | 2（L-11 shell 用例 / L-16 ② 产品） | 无阻断主流程问题；P2 ×3 + P3 ×13 落地（登录 / 法务 / 桌面端登记文案、备案占位、页脚） | `feat/v5-selfhost-audit-landing` @ `b97adb3fb` | 集成② `6201518b2` | [archive/landing.md](./archive/landing.md) · [landing.md](./landing.md) |
| 11 | media 图片 / 媒体 / 容器网页预览 | t-50 A / t-51 B | 27（2 · 11 · 14） | 25（P1 2/2 · P2 11/11 · P3 12/14） | 2（M-25 需后端 / M-27 shell → 已由 t-865 `a3af53970` 落地） | 图片查看器子模式、圈选编辑器底栏、视频任务中心关闭 / 术语 / 危险操作确认、容器网页预览 Esc 分层 / 关闭确认 / Tab 可达 / 触屏跟手 | `feat/v5-selfhost-audit-media` @ `8834aca08` | 集成② `10398baa9`；X-M2 / X-M3 / X-M4 由 t-865 落地 | [archive/media.md](./archive/media.md) · [media.md](./media.md) |
| 12 | tutorials 教程中心 | t-52 A / t-53 B | 37（0 · 12 · 25） | 28 + ◐5 | 4（TU-17 / TU-21 / TU-34 需 shell 或产品口径；TU-36 已由集成② 落地） | 功能参考有一级入口、精选作品受控 + 深链准备、帮助菜单换 DropdownMenu、移动端搜索有反馈、教程工作室表单门槛 / 错误态 / 撤回确认、iframe 沙箱、22 KB 死代码删除、TU-37 门禁在 Windows 首次真跑到底 | `feat/v5-selfhost-audit-tutorials` @ `02c358655` | 集成③ `ce767d8ce`（A+B）；接线 `bdf7b4d15` | [archive/tutorials.md](./archive/tutorials.md) · [tutorials.md](./tutorials.md) |

**合计**：12 模块审出 **359** 条（P1 8 · P2 108 · P3 243）。P1 8/8 全部关闭（含 taskboard T-02 由 sidebar-B 修）；各模块正文均声明 P2 全部落地（shell 2 条暂缓项 S-08 / S-20 为等用户拍板的设计取舍）；P3 以「可独立完成即做」为口径，未做的逐条有归属与理由（§6）。「已修」不做跨模块求和：sidebar 正文未给逐条计数，强行相加会失真。

## 4. 覆盖复查与补审专项（阶段 A/B 之外）

t-760 覆盖复查把 12 份审计对照全部路由与顶层面板，指出 5 个缺口（G-1 ~ G-5）与归属表漏项；以下专项据此立项。**这些分支尚未合入 integration（集成④ t-896 范围）**，数字转录自各自正文。

| 专项 | 任务 | 审出 | 已修 | 遗留 | 分支 @ HEAD | 正文 | 状态 |
|---|---|---|---|---|---|---|---|
| HUD 任务列表 / 后台子任务（G-1 / G-2） | t-836 | 20（P2 7 · P3 13） | 17（P2 7/7）+ ◐ H-12 | H-18 shell 一行接线（`App.tsx` `onStop={wsSending ? stopTurn : undefined}`）/ H-12 需协议 `startedAt` / H-20 messages + shell / H-19 设计取舍 | `feat/v5-selfhost-audit-hud` @ `b1f06f8f5` | [hud.md](./hud.md)（合入后） | 已验收；QA 复核（t-1029）修 1 处 |
| 知识星球自动回复面板（G-3） | t-838 | 19（P1 1 · P2 7 · P3 11） | 17（P1 / P2 全部；P3 9） | KP-18 / KP-19 不修有判据；弹层形态、Checkbox 原语归 shell | `feat/v5-selfhost-audit-kp-automation` @ `b0fd16dad` | [kp-automation.md](./kp-automation.md)（合入后） | 已验收；QA 复核修 1 处 |
| 杂项 P3：`?demo=1` 演示模式 + optionsGroup 多题聚合（G-4 / G-5） | t-839 | D 9 + OG 9 = 18（P2 2 · P3 16） | D 5 + OG 7 = 12（P2 2/2） | D-02 余项 / D-08 shell；OG-05 / OG-09 messages；D-04 / D-09 产品 / 排版专项 | `feat/v5-selfhost-audit-misc-p3` @ `c834dffa1` | [misc-p3.md](./misc-p3.md)（合入后） | 已验收；越界 `RichBlocks` / `MarkdownImpl`（富块重挂根因）经指挥官批准 |
| 集成待办清理（INTEGRATION 集成② §7 遗留项） | t-865 | 7 项待办 | 5 已修（`typecheck:preview` TS5097、C-32、media X-M2 / X-M3 / X-M4）+ 1 核对已具备（排队气泡）+ 1 转 t-53（TU-37） | — | integration `e0f53688a` `d4b061e37` `a3af53970` `bae5a8673` `7d5573a92`，记录 `1e4328ac9` | [INTEGRATION.md 集成② §7.1](./INTEGRATION.md) | 已在 integration |
| QA 复核 · 缺口补审交付 | t-1029 | 核对 61 项 | ❌ 2 → 已修：`scenes-hud.tsx` TS2353（`typecheck:preview` 红）`747596782`；KP-14 忙态单键静默吞点击 `1db992620` | 确认上述专项遗留仍开放 | `feat/v5-selfhost-audit-qa-gap` @ `c1734aac6`（= integration `c034f05d7` + 三专项分支 + 修复） | `docs/audit/qa/qa-gap.md`（合入后） | 已验收 |
| 交互友好专项 · 键盘 / 焦点 / 无障碍走查 | t-762 | 走查清单（shell 令牌层 + 各模块） | → 拆为 a11y-B 三条 | — | — | **终稿补** | 走查已完成；修复 a11y-shell（t-893）/ a11y-mod-a（t-894）/ a11y-mod-b（t-895）在跑 |
| PermissionCard 未决态审批交互专审 | permission-card-2（t-837 作废重开，统计排除 t-837） | **终稿补** | | | `feat/v5-selfhost-audit-permission-card` | | 在池 |
| tutorials 补写 agents / chat-basics 正文 | t-1046 | **终稿补** | | | | | 前置 t-631 已交，待认领 |
| QA 复核 · B 轮 P3 / 二期 P3 | qa-b-p3 / qa-p3 | **终稿补** | | | `feat/v5-selfhost-audit-qa-b-p3` / `-qa-p3` | | 在跑 / 在池 |
| 归档预整理 | t-761 | 12 份归档摘要 + 索引 | — | — | `feat/v5-selfhost-audit-archive-prep` @ `591c4cb70`（已合入本归档分支） | [archive/README.md](./archive/README.md) | 已验收 |

归属表勘误（t-839 §7，供 PLAYBOOK §8 修订）：`components/optionsGroup.tsx` → messages；`components/chat/researchEvidence.tsx` → tools；`components/mathDelimiters.ts` → messages。

## 5. 集成①～③ 合入记录（`feat/v5-selfhost-ocv5-audit-ux`，详见 [INTEGRATION.md](./INTEGRATION.md)）

| 轮次 | 任务 · 时间 | 合入（合并提交 ← 成员分支 @ HEAD） | 接线 / 用例 / 处置 | 记录 |
|---|---|---|---|---|
| 集成① | t-399 · 09-16 02:10–02:45 | 起点 `e6f73dd99`（已含 shell-B）；`3cff04c85` ← sidebar-B `ef872e91a` · `09a13a472` ← manage-B `af79d7b05` · `bf8188def` ← taskboard-B `0b06f7ce5` · `985b3ae57` ← messages-B `d2f84063d` | `678fe9d38` App 接 sidebar-B S-05/06/08/UUS-01 · `09d15400f` `useChatSocket` 空标题 · `1ae92b831` 两处既有用例随契约更新 | `43b7cd3a4` |
| 集成② | t-624 · 09-16 21:15–23:10 | `5e5ed6925` ← settings-B + 补丁① `c0efc9c91` · `6fa690d7e` ← tools-B `d65c6741e` · `ab765669a` ← market-B `1fb99bfcc` · `6201518b2` ← landing-B `b97adb3fb` · `10398baa9` ← media-B `8834aca08` · `b41e804ac` ← sidebar 二期 `25c775295` · `ae0b0cb64` ← composer-B `70d3db8b3` | `19799c0fe` App 接线（market `onRequireLogin` / tools T-18 / composer 去授权入口 / brand `contactEmail`）· `f7c08f3eb` 用例随契约更新 · `419e0d218` 仓根 `.gitattributes`（TU-36）· `2a6492774` 还原 market 场景 import 后缀 · 集成待办 t-865（§4） | `1d8eaf769`（分支状态单 `2b23a31a7`；§7.1 `1e4328ac9`） |
| 集成③ | t-631 · 09-16 23:43 – 09-17 01:45 | `12fc17579` ← settings 二期 `5eac1b807` · `cd58600e8` ← messages2 `2abe389a9` · `425655631` ← taskboard2 `05dd185df` · `c761bbd93` ← manage2 `6fae01440` · `be20adaec` ← market2 `5391c150a` · `ce767d8ce` ← tutorials A+B `02c358655`（54 files +3854/−1211；唯一冲突 `shoot.mjs` 取 integration 外链 bundle 方案） | `bdf7b4d15` App 接线 TU-32 · `c034f05d7` 入口覆盖两处存量漏标补 `data-product-control`（q-979）· `29a277b25` composer 两处新增入口降级为控件 + `b249317f4` 教程同步快照 `--source-only` accept 17 项（q-1076） | `36bb9a677` |
| 集成④ | t-896（待领，等前置） | 待合入：hud / kp-automation / misc-p3 / qa-gap（可整支 ff 带上前三者）、a11y-shell / a11y-mod-a / a11y-mod-b、permission-card-2、qa-b-p3 / qa-p3 修复、t-1046 | H-18 一行接线；t-1046 后恢复两处 `data-product-feature` 并走普通 `tutorials:accept` | **终稿补** |

12 条模块分支在集成③ 终点现算「未合入提交 = 0」，远端 = 本地（INTEGRATION.md 集成③ §8；t-632 复核 `git ls-remote` 一致）。

### 5.1 终审导读（需用户确认的事项）

1. **教程同步快照 accept（集成③ §4）**：TU-37 修好后 `check:tutorials` 在 Windows 首次真跑到底，一次性暴露 B 阶段各模块对入口元素的 UI/UX 修改导致的 17 项功能源哈希漂移 + 2 项入口身份变化（composer-B 新增「去授权」「排队发送」两个 `data-product-feature` 入口）。处置（q-988 → q-1076，**指挥官 fable-5-1-18 代用户确认**）：两处新入口降级为 `data-product-control`（`29a277b25`，UI 零变化）+ `tutorials:accept --source-only --ids <17 项>`（`b249317f4`，history 第 67 条 note 注明「待用户终审」）。抄检两篇教程正文引用的入口文案与 HEAD 逐条一致；唯一不一致是正文未描述这两个新入口 → t-1046 补写后恢复。**不认可 → `git revert b249317f4 29a277b25`**，其余门不受影响。
2. **shell S-08 / S-20 两条暂缓项**（等用户拍板的设计取舍）—— 见 [archive/shell.md](./archive/shell.md) §4。
3. **market K-12 桌面端分类片**：任务书未明示，二期取「换行」（非箭头）；**tutorials TU-13 删 `MissionReplay` / TU-31 第 4 步改指「设定目标」** 已按指挥官拍板落地；**HUD H-19「任务集文案微调也重展开」** 保留文件头声明的既有交互。
4. **越界改动**（均经指挥官批准并单列）：t-839 改 messages 归属的 `RichBlocks.tsx`（OptionsBlock 注册改 `useLayoutEffect`、聚合判定读快照）与 `MarkdownImpl.tsx`（`components` `useMemo`，根因：每次渲染新造渲染器导致富块整体重挂，受益面含 HtmlPreview iframe）；t-1029 改 settings 归属的 `KnowledgePlanetAutomationPanel.tsx`（忙态改按键集合）。
5. **需后端配合项**（§6.1）本轮一律未动，请决定是否另开后端专项。

## 6. 全部遗留与理由（初稿：12 模块 + 已验收专项；终稿补 a11y-B / permission-card-2 / QA 两轮）

### 6.1 需后端 / 协议配合

| 模块 | 项 | 说明 |
|---|---|---|
| sidebar | UCP-01 / GH-03 | 需后端字段 / 接口 |
| manage | M-17 文献库引用导出 / 文档详情 | `ResearchLibraryDoc` 无作者 / 年份 / venue，无单文档读接口 |
| manage | M-06 ③ `SkillSummary.sensitive` | 需后端下发；前端 `isSecretSkill` 规则兜底已就位 |
| settings | SET-09 组织充值汇率预估 / SET-10 组织改名 | 需 `credits_per_yuan` 下发 / `PATCH /api/org {name}` |
| settings | 会话用量 offset 分页漏行 | 前端已去重；漏行需游标分页 |
| taskboard | T-28 直接新建 AI 阶段 | 后端要求 AI 阶段绑定 agent |
| market | K-25 / X-02 offset 分页 / 虚拟化 | 需后端 offset |
| media | M-25 | 需后端 |
| messages | M-25 多标签旧快照覆写 IDB | 需真后端复现（本轮无 WS 后端） |
| HUD | H-12 计时精确起点 | `InflightDelegateSurface` 缺 `startedAt`（前端已取 `min(首次观察, updatedAt)`） |

### 6.2 需 shell / 跨模块接线（建议由集成④ 或 shell 二期一并处理）

| 来源 | 项 | 落点 |
|---|---|---|
| HUD H-18 | 父轮结束后「停止本轮」仍显示 | `App.tsx` `onStop={wsSending ? stopTurn : undefined}`（一行） |
| tutorials TU-17 / TU-02 | 深链 `?panel=help&view=&work=` | `hooks/useAppRoute.ts` + `App.tsx` |
| tutorials TU-34 | hero 品牌深蓝 token | `styles.css` `--hero-bg / --hero-fg`（可选） |
| taskboard T-20 | `BoardViewParam` 的 `inbox/backlog` 类型 | `hooks/useAppRoute.ts`（无功能影响） |
| landing L-11 | shell 用例 | shell |
| market K-27 / kp-automation 同意勾选 | Checkbox 原语 | `components/ui`（全站尚无 Checkbox，两处保留原生 `<input type=checkbox>`） |
| misc-p3 D-02 余项 / D-08 | demo 其余会话 `onDemoSelect` 一行；demo 下交互块未说明原因 | `App.tsx`；`ChatInteraction` 加 `reason` |
| misc-p3 OG-05 / OG-09 | 发送文本半角标点（被 8 处断言与历史数据锁定）；发送失败后组锁定无恢复 | messages 单独立项；`sendUserText` 需失败通道 |
| HUD H-20 | `TokenUsageBadge` 流式重放入场动画；`--faint` 暗色对比度 | messages `chat/tokenUsage.tsx`；shell token |
| messages M-21 / M-24 | 生成中查找不能跳转；`_liveStreamBroken` 无 UI 消费方 | 需独立滚动交互设计；需 lib/chat 状态机专项 |
| settings | ConnectorsTab / KnowledgePlanetAutomationPanel 目录迁移；备案判据去重 | manage owner 决定；可选 |
| composer C-16 / C-26 / C-30 | 见 composer 正文 §遗留 | shell / 产品 |

### 6.3 产品口径 / 设计取舍（先问再改）

shell S-08 / S-20；tutorials TU-19（0.9s 即已读）/ TU-21（CTA 五种文案）；HUD H-19；market K-23（与「已安装页是卸载唯一权威」既有决定冲突）；misc-p3 D-04（演示账号 handle）/ D-09（气泡任意字号，排版专项）；landing L-16 ②；settings Auto-Dream 卡片文案、`ccswitch://` 深链带密钥（协议要求）。

### 6.4 不修有判据 / 打磨

kp-automation KP-18（骨架）/ KP-19（重拉星球列表）；settings SET-32（双份轮询不会并存）；tutorials TU-20 / TU-24 余量 / TU-29；taskboard §5 暂缓 9 项（平台限制 / 他模块归属 / 非缺陷）。

## 7. 验证总表

### 7.1 集成③ 终点全量门（源码态 `b249317f4`，日志 `.audit-tmp\integration\integ3-*`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| `npm run typecheck:preview` | ✅ exit 0（集成② 登记的 3 红全消） |
| `npm run check:tutorials` | ✅ OK · 26 capabilities · 12 cases · 26 media pairs（accept 后，§5.1-1） |
| `npm test`（web-react 全量 vitest） | ✅ **298 文件 / 4213 例全部通过 ×2**（676s / 801s） |
| `npm run test:browser` | `run.mjs` **T1–T68 全部 ok**；`node --test` 73 例 70 过 / 3 失败 = 基线 `cc-switch-ascii-name` ×2 + 环境 `ocv5-185-qa`（干净工作树 + junction 后单跑 15/15 ✅） |
| ui-preview 全量截图 | ✅ 257 场景 / 854 张，failures 0 / retried 0（`unmockedApi` 仅 `listCronChannels` / `listProjectAssets`，可选桩） |
| `biome lint`（集成③ 触碰 5 文件） | 新增 0 |

### 7.2 各模块 / 专项交付时的验证（转录，NOT RUN 如实保留）

| 模块 / 专项 | typecheck | 模块 vitest | test:browser | 截图 before / after | NOT RUN |
|---|---|---|---|---|---|
| shell | ✅ | ✅ | ✅ | ✅ | 见正文 |
| messages | ✅ | ✅ | ✅（T68 新增） | ✅ | 真后端 WS / 多标签 |
| composer | ✅ | ✅ | ✅ `run.mjs` 67 全过 | ✅ | 真机 |
| sidebar | ✅ | ✅ | ✅ 67 全过 | ✅ 12 场景 34 张 | 真机 |
| manage | ✅ | ✅ 17 文件 212 例（二期） | NOT RUN（非高频面） | ✅ 49 场景 136 张 + after-2 | 全量交集成 |
| settings | ✅ | ✅ 21 文件 269 例（二期） | NOT RUN（非高频面） | ✅ + after-2 | 真实服务端版本比对 |
| taskboard | ✅ | ✅ | NOT RUN（非高频面） | ✅ 17 场景 66 张 | 全量交集成 |
| tools | ✅ | ✅ | ✅ | ✅ | — |
| market | ✅ | ✅ 11 文件 152 例（二期） | NOT RUN（非高频面） | ✅ 各 88 张（二期） | 真机 / Tooltip hover |
| landing | ✅ | ✅ | NOT RUN | ✅ | 真后端登录 |
| media | ✅ | ✅ | ✅ T30 更新 | ✅ | 真机 |
| tutorials | ✅ | ✅ 12 文件 95 例 | NOT RUN（非高频面） | ✅ 27 场景 108 张 | 全量交集成③ |
| HUD t-836 | ✅（`typecheck:preview` 红 → t-1029 修） | ✅ 4 文件 55 例 | ✅ 67 全过 | ✅ 40 / 40 | — |
| kp-automation t-838 | ✅ | ✅ 22 文件 270 例（settings + manage 目录） | NOT RUN（非高频面） | ✅ 56 / 56 | 全量 |
| misc-p3 t-839 | ✅ | ✅ 7 文件 270 例 + App.test | ✅ 两轮 68 全过 | ✅ 24 / 24 + messages 三场景对照 | 全量 |
| QA t-1029（三专项合入 integration `c034f05d7` 后） | ✅ + `typecheck:preview` ✅ | ✅ HUD 55 / KP 70 / misc 167(+150) / t-865 115 | ✅ 68/68；`node --test` 70/73（基线 3） | ✅ 120 张 failures 0 | 全量交集成④ |

## 8. 分支 / 提交总表

| 分支 | HEAD（本地 = 远端） | 用途 |
|---|---|---|
| `feat/v5-selfhost`（canonical） | `210b9967`（基线，本轮未推进；合入需 v5-dev 通道） | 基线 |
| `feat/v5-selfhost-ocv5-audit-ux` | `36bb9a677` | integration（集成①②③） |
| `feat/v5-selfhost-audit-shell` | `39697560b` | 模块 |
| `feat/v5-selfhost-audit-messages` | `2abe389a9` | 模块 |
| `feat/v5-selfhost-audit-composer` | `70d3db8b3` | 模块 |
| `feat/v5-selfhost-audit-sidebar` | `25c775295` | 模块 |
| `feat/v5-selfhost-audit-manage` | `6fae01440` | 模块 |
| `feat/v5-selfhost-audit-settings` | `5eac1b807` | 模块 |
| `feat/v5-selfhost-audit-taskboard` | `05dd185df` | 模块 |
| `feat/v5-selfhost-audit-tools` | `d65c6741e` | 模块 |
| `feat/v5-selfhost-audit-market` | `5391c150a` | 模块 |
| `feat/v5-selfhost-audit-landing` | `b97adb3fb` | 模块 |
| `feat/v5-selfhost-audit-media` | `8834aca08` | 模块 |
| `feat/v5-selfhost-audit-tutorials` | `02c358655` | 模块 |
| `feat/v5-selfhost-audit-hud` | `b1f06f8f5` | 专项（待集成④） |
| `feat/v5-selfhost-audit-kp-automation` | `b0fd16dad` | 专项（待集成④） |
| `feat/v5-selfhost-audit-misc-p3` | `c834dffa1` | 专项（待集成④） |
| `feat/v5-selfhost-audit-qa-gap` | `c1734aac6` | QA 复核 + 2 处修复（待集成④，整支 ff 可带上前三条） |
| `feat/v5-selfhost-audit-archive-prep` | `591c4cb70` | 归档摘要（已合入本归档分支 `ac0db7c35`） |
| `feat/v5-selfhost-audit-archive` | 本分支 | SUMMARY.md + archive/ 更新（待集成④） |
| `feat/v5-selfhost-audit-a11y-shell` / `-a11y-mod-a` / `-a11y-mod-b` / `-permission-card` / `-qa-b-p3` / `-qa-p3` | 在跑 | **终稿补** |

集成合并提交一览：集成① `3cff04c85` `09a13a472` `bf8188def` `985b3ae57`；集成② `5e5ed6925` `6fa690d7e` `ab765669a` `6201518b2` `10398baa9` `b41e804ac` `ae0b0cb64`；集成③ `12fc17579` `cd58600e8` `425655631` `c761bbd93` `be20adaec` `ce767d8ce`。

## 9. 评审入口

- 仓库：`https://github.com/dream-star-end/smart-assistant`，各分支同名（§8）；本地主克隆 `d:\code\test_project\test123\v5-selfhost`，工作树 `d:\code\test_project\test123\wt\<slug>`。
- 文档：本文 → [archive/README.md](./archive/README.md)（12 模块索引）→ `archive/<slug>.md`（归档摘要）→ `<slug>.md`（正文）；集成记录 [INTEGRATION.md](./INTEGRATION.md)；专项正文 `hud.md` / `kp-automation.md` / `misc-p3.md` / `qa/qa-gap.md` 随集成④ 合入后出现在 integration。
- 截图（仓外，不入库）：`D:\code\test_project\test123\.audit-tmp\<slug>\{before,after}\`；集成③ 全量 854 张 `.audit-tmp\integration\shots-integ3\`；QA 复核 120 张 `.audit-tmp\qa-gap\shots\`。
- 日志（仓外）：`.audit-tmp\integration\integ3-*.log`（typecheck / typecheck:preview / check:tutorials / vitest-all / test-browser / shoot-all）；各模块 `.audit-tmp\<slug>\*.log`。
- 作业口径：`d:\code\test_project\test123\TEAM_PLAYBOOK.md`（仓外）；决策 d-24 / d-26 / d-28、决策卡 q-786 / q-979 / q-988 / q-1076。

## 10. 终稿（t-897）待补清单

| 项 | 等什么 | 补到哪 |
|---|---|---|
| 集成④ 合入记录 + 全量门 | t-896 | §5 集成④ 行、§7.1 换成集成④ 终点 |
| a11y-B 三条修复（shell 令牌 / 模块 A / 模块 B）+ t-762 走查结论 | t-893 / t-894 / t-895 | §4、§6 |
| PermissionCard 专审 | permission-card-2 | §4、§6 |
| tutorials 补写 agents / chat-basics 正文并恢复两处 `data-product-feature`、普通 `tutorials:accept` | t-1046 | §4、§5.1-1 状态 |
| QA 复核 B 轮 P3 / 二期 P3 结论与修复 | qa-b-p3 / qa-p3 | §4、§7.2 |
| 专项归档摘要 `archive/{hud,kp-automation,misc-p3,permission-card,a11y}.md` | 上述任务合入后 | `archive/` + README 索引 |
| 12 模块正文在集成④ 后若有新增小节（跨模块接线落地状态） | t-896 | §3 对应行 |
