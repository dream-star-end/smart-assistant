# v5 个人版审计 · 总览（SUMMARY · 初稿，t-632）

> 给用户终审的**唯一入口**：总览 → 方法 → 按模块一节 → 已验收未合入清单 → 遗留清单 → 决策与口径 → 终审导读 → 验证门 → 分支 / 提交总表 → 评审入口。每个数字都能在各模块正文 `docs/audit/<slug>.md`、归档摘要 `docs/audit/archive/<slug>.md` 或 `docs/audit/INTEGRATION.md` 找到出处；每个 SHA 都可 `git cat-file -e` 核实（t-632 逐个核过）。
> 只汇总不复制正文（q-786 口径）；未跑的验证一律标 **NOT RUN**。
> 版本：**初稿**（基于 integration `36bb9a677` = 集成③ 终点）。凡标 **[待集成④]** 的位置，终稿 t-897 在集成④（t-896）合入后更新。

## 1. 总览

| 项 | 内容 |
|---|---|
| 目标 | 对 v5 个人版（selfhost，`packages/web-react` 用户端）全部页面 / 模块做 UI/UX、功能正确性、交互友好性审计，审出的问题直接改代码落地（P1 / P2 必修，P3 量力而行并登记遗留），指挥官验收、合入 integration 后统一归档给用户终审 |
| 时间跨度 | 2026-09-15（基线 `210b9967`、决策 d-24/26/28）→ 2026-09-17 01:45（集成③ 终点 `36bb9a677`）；集成④与终稿在后 |
| 任务数 | 协同组任务库 **54 条**（含 A 审计 12 · B 修复 12 · 二期 / 补丁 6 · 覆盖复查与补审专项 · a11y 专项 · QA 复核 3 · 集成 4 · 归档 3；作废条 t-837 不计入统计） |
| 12 模块审出 | **359 条**（P1 8 · P2 108 · P3 243），P1 8/8 全部关闭；补审专项另审出 HUD 20 · 知识星球 19 · 杂项 P3 18 · PermissionCard 17 · a11y 走查归属三条修复单 35（11 + 14 + 10） |
| 合入量（按 INTEGRATION 集成①②③ 合入表逐行相加） | 17 个 `--no-ff` 合并提交：集成① 4 条 123 files +13,855/−2,401 · 集成② 7 条 153 files +15,336/−2,295 · 集成③ 6 条 54 files +3,854/−1,211 → **330 files，+33,045 / −5,907**（跨轮同文件重复计；不含集成① 起点已含的 shell-B、各轮自有接线 / 用例 / 记录提交、集成待办 t-865） |
| 集成状态 | 12 条模块分支在集成③ 终点「未合入提交 = 0」，远端 = 本地；已验收未合入 7 条分支见 §4 **[待集成④]** |
| 结果一句话 | 主流程无阻断项残留；P2 按各模块正文声明全部落地（shell 2 条设计取舍暂缓等用户拍板）；P3 以「本模块内可独立完成即做」为口径，未做的逐条有归属与理由（§5）；全量门在集成③ 终点全绿（§8） |

## 2. 方法与口径

| 项 | 内容 | 出处 |
|---|---|---|
| 作业环境 | 本机到 v5-dev / 22 端口不通 → 全部在本地克隆 + 每人独立 git worktree：主克隆 `v5-selfhost`（只读参照）、`wt\<slug>` 工作树、分支 `feat/v5-selfhost-audit-<slug>`，成员只推自己的分支，指挥官合入 integration `feat/v5-selfhost-ocv5-audit-ux`；合入 canonical `feat/v5-selfhost` 与 Lease Center 发布需 v5-dev 通道，**本轮不做** | d-24、`TEAM_PLAYBOOK.md` §1–§2 |
| 提交纪律 | subject 禁用 `fix(v5)`（门禁要求真实 Incident trailer，本轮无事故编号，禁止编造）→ `feat / refactor / style / test / docs / chore(v5)`；禁 `reset --hard` / `stash` / force-push；不碰 `changelog.json`；`git add` 精确文件 | d-26、PLAYBOOK §7 |
| 证据工具 | `browser-tests/ui-preview/shoot.mjs` 截图台（真组件 + 真 production CSS + 真 Chromium + api-stub 假数据，每场景 desktop / mobile × light / dark）；每模块 before / after 各一套，PNG 存仓外 `D:\code\test_project\test123\.audit-tmp\<slug>\`（不入库），场景文件随代码提交 | d-28、PLAYBOOK §4 |
| 两阶段流程 | A 审计（只出文档 + 场景，不改业务代码）→ 指挥官评审 → B 修复（按批准计划改，每改动配测试，typecheck + 模块 vitest + 高频交互面跑 `test:browser` + after 截图）→ 二期（遗留 P3 收尾）→ 补丁 / 专项 → 集成 → QA 复核 | PLAYBOOK §6 |
| 严重度 / 清单 | P1 阻断 · P2 明显缺陷或移动端不可用 · P3 打磨；七项清单：视觉 / 响应式（390px、触控 ≥44px）/ 交互反馈 / 功能正确性 / 可访问性 / 文案 / 代码质量 | PLAYBOOK §5 |
| 归属与协同 | 文件归属表 + 写锁；跨模块需求 `send_to` owner 或登记接线由集成轮落地；越界改动须指挥官批准并单列（§7-4） | PLAYBOOK §8 |
| 归档口径 | 摘要 + 索引不复制正文；SHA 逐个 `cat-file` 核存在；统计排除 t-837 | q-786、t-632 任务书 |

## 3. 按模块一节

计数口径：「审出」= 阶段 A 清单（P1 · P2 · P3）；「修复 / 部分 / 遗留」= 各正文修复记录与遗留章节（✅ / ◐ / 仍开放的本模块归属项）；「QA 复核」= t-1028（二期 P3，`qa/QA-p3-tail.md`）/ t-1038（B 轮 P3，`qa/QA-b-p3.md`）/ t-1029（缺口补审，`qa/qa-gap.md`）的结论，三份 QA 报告均已验收、随集成④ 合入 **[待集成④]**。数字抽查：shell / tools / media / market / taskboard / settings 六份正文结论行与本表一致。

| 模块 | 任务 | 审计文档 | 审出（P1 · P2 · P3） | 修复 / 部分 / 遗留 | QA 复核 | 集成状态 | 一句结论 |
|---|---|---|---|---|---|---|---|
| shell 应用壳层与设计系统 | t-30 / t-31 | [shell.md](./shell.md) · [archive/shell.md](./archive/shell.md) | 20（1 · 8 · 11） | 18 / 1（S-20 半条）/ 2 暂缓（S-08、S-20 等用户拍板） | —（集成① 起点；a11y-shell t-893 另修 token 层 11 条） | 集成① 起点 `e6f73dd99` 已含 | P1「桌面端 `⌘K` 把整页点死」改按视口分流；Esc 归弹层不再掐掉生成中回合；Button / Chip 触控 44px、语义色对比度守卫、横幅栈折叠、主题跨标签同步为其余模块打底 |
| messages 消息渲染与时间线 | t-32 / t-33 / t-629 | [messages.md](./messages.md) · [archive/messages.md](./archive/messages.md) | 25（0 · 4 · 21） | 22 / 0 / 3（M-21 需独立设计 · M-24 需状态机专项 · M-25 需真后端复现） | 二期由 t-629 自评（代码改动 0）；misc-p3 越界改动经 t-1029 复核无回归 | 集成① `985b3ae57` → 集成③ `cd58600e8` | 只读面死按钮、触屏动作行折叠、宽表不拆词、流式光标内联、评价 chip 触控与配色全部落地 |
| composer 输入区 / 会话头 / 模型与目标 | t-34 / t-35 | [composer.md](./composer.md) · [archive/composer.md](./archive/composer.md) | 35 + 承接 M-16（0 · 13 · 22） | 32 / 0 / 4（C-16 · C-26 · C-30 · C-32；C-32 已由 t-865 `d4b061e37` 落地） | —（集成② 合入后随全量门） | 集成② `ae0b0cb64`；接线 `19799c0fe` | 两行式输入区、语音状态播报、草稿超限预警、排队发送、模型切换中态 / 最近去重、目标对话框并发保护、窄屏更多菜单与快捷键平台化 |
| sidebar 侧栏 / 会话 / 项目 / 站内信 / GitHub | t-36 / t-37 / t-627 | [sidebar.md](./sidebar.md) · [archive/sidebar.md](./archive/sidebar.md) | 38（0 · 12 · 26；编号行 50，正文统计 38，摘要已注） | P2 12/12 + P3 多数 + 二期 S-14（正文未给逐条计数）/ — / 0 归属内；需后端 2（UCP-01 · GH-03） | t-1028：二期 §6.2 遗留 6 条处置 + RepoPill 顺手项 + shell 接线闭环 7 ✅ / 0 ❌ **通过** | 集成① `3cff04c85` → 集成② `b41e804ac`；接线 `678fe9d38` `09d15400f` | 重命名 / 删除 / 加载更多失败不再静默、项目列表失败自动重试、拖宽把手键盘可调、多选保留状态点、项目范围深链冷启不回落 all（T-02） |
| manage 管理中心 | t-38 / t-39 / t-426 / t-626 | [manage.md](./manage.md) · [archive/manage.md](./archive/manage.md) | 27 + 跨模块 3（1 · 8 · 18） | 22 + 补丁① 4 + 二期 1 + 承接 X-03 / 0 / 2 需后端（M-17 · M-06 ③） | t-1028：§9 遗留 5 条处置 + X-03 + 验证门 6 ✅ / 0 ❌ **通过**（`cronHuman` 另跑 23 组边界探针） | 集成① `09a13a472` → 集成③ `c761bbd93` | P1 `cronBlocked` 误渲染空态收口；技能列表 / 工作台 / 项目专属技能改造；记忆面板读失败与空态互斥；`cronHuman` 支持星期 / 小时区间 |
| settings 设置中心 / 组织 / 支付 | t-40 / t-41 / t-426 / t-628 | [settings.md](./settings.md) · [archive/settings.md](./archive/settings.md) | 43（0 · 12 · 31） | 41 + 二期 4 / 0 / 需后端 2（SET-09 · SET-10）· 跨模块 2 · 不修 3 | t-1028：遗留表 11 项处置（4 项落地）+ 验证门 11 ✅ / 0 ❌ **通过**；2 条 a11y nit 转 a11y-mod-a（已修 `4efc0fa35` `beb48d930`） | 集成② `5e5ed6925` → 集成③ `12fc17579` | 壳层与偏好、用量 / API 接入统计卡、计费与支付、组织中心、ChatGPT 直连移动端 Tab 全部按审计落地；补丁① 承接 manage 的 ConnectorsTab 四项 |
| taskboard 任务面板 | t-42 / t-43 / t-630 | [taskboard.md](./taskboard.md) · [archive/taskboard.md](./archive/taskboard.md) | 30（2 · 14 · 14） | 27 + T-02 由 sidebar 修 / 2（T-20 shell 类型 · T-28 后端约束）/ 0 | 二期由 t-630 自评（仅场景 1 行，消 `typecheck:preview` TS2322） | 集成① `bf8188def` → 集成③ `425655631` | P1「切换 projects/agents 数据丢失」与 T-02 深链回落已修；看板 / 列表 / 抽屉 / 设置面板 P2 14/14 |
| tools 工具卡 / 智能体过程 / 检查器 | t-44 / t-45 | [tools.md](./tools.md) · [archive/tools.md](./archive/tools.md) | 31 + 跨模块 4（1 · 7 · 23） | 31 / 0 / 0（跨模块 4 转 owner；T-18 选中态由 `19799c0fe` 接线） | — | 集成② `6fa690d7e` | P1 Grok 输出归一化只对原生名与明确信封生效；状态单一权威、信封解包、触控靶、a11y、文案全部收口 |
| market AI 市场 | t-46 / t-47 / t-625 | [market.md](./market.md) · [archive/market.md](./archive/market.md) | 26（1 · 4 · 21） | 13 + 二期 10 = 23 / 0 / 3（K-23 不做有判据 · K-25 需后端 offset · K-27 需 shell Checkbox） | t-1028：10 条 P3 落地 + 3 条保持遗留 + 验证门 13 ✅ / 0 ❌ **通过** | 集成② `ab765669a` → 集成③ `be20adaec`；接线 `19799c0fe` | P1「发布草稿关弹窗无提示丢失」已落盘；发现页卡片截断 / 分区计数 / 加载更多报错；二期收掉已安装行动作簇、就绪徽章、kill-switch 窄屏折叠、徽章解释 Tooltip、插件契约人话 |
| landing 落地页 / 登录 / 法务 / 桌面端登记 | t-48 / t-49 | [landing.md](./landing.md) · [archive/landing.md](./archive/landing.md) | 20 + 跨模块 3（0 · 3 · 17） | 16 + L-11（t-895 附录 `6236dfb08` **[待集成④]**）/ 2 / 1（L-16 ② 产品） | t-1038：20 条 + X-01~03 逐条对上 **0 处不符**，P2 3/3 ✅；L-11 遗留理由失效 → 移交 t-895 已修 | 集成② `6201518b2` | 无阻断项；P2 ×3 + P3 ×13 落地（登录 / 法务 / 桌面端登记文案、备案占位、页脚）；登录 / 注册页占位符不再复读标签（L-11） |
| media 图片 / 媒体 / 容器网页预览 | t-50 / t-51 | [media.md](./media.md) · [archive/media.md](./archive/media.md) | 27（2 · 11 · 14） | 25（含 M-23 两半条：textarea 自增高 `2d75dbb45` + 性能半条 t-895 附录 `986f72b2f` **[待集成④]**）/ 0 / 2（M-25 需后端分享令牌，前端半条已做 · M-27 转 shell → t-865 `a3af53970` 已落地） | t-1038：27 条 + X-M1~M4 逐条对上，**1 处不符**（M-23 性能半条文档写 ✅ 实未做 → `media.md` 已勘误 + 移交 t-895 落地）；P1 2/2 · P2 11/11 ✅ | 集成② `10398baa9`；X-M2 / X-M3 / X-M4 由 t-865 落地 | 图片查看器子模式、圈选编辑器底栏、视频任务中心关闭 / 术语 / 危险操作确认、容器网页预览 Esc 分层 / 关闭确认 / Tab 可达 / 触屏跟手 |
| tutorials 教程中心 | t-52 / t-53 | [tutorials.md](./tutorials.md) · [archive/tutorials.md](./archive/tutorials.md) | 37（0 · 12 · 25） | 28 / 5（TU-19 · 20 · 24 · 29 · 32）/ 4（TU-17 · TU-21 · TU-34 需 shell 或产品口径；TU-36 已由集成② 落地） | t-1038：37 条 + 追加①② 逐条对上 **0 处不符**，P2 12/12 ✅；`check:tutorials` 在核对态红 → q-1076 处置后在 `b249317f4` 复跑绿 | 集成③ `ce767d8ce`（A+B）；接线 `bdf7b4d15` | 功能参考有一级入口、精选作品受控、帮助菜单换 DropdownMenu、移动端搜索有反馈、教程工作室表单门槛 / 错误态 / 撤回确认、iframe 沙箱、22 KB 死代码删除、TU-37 门禁在 Windows 首次真跑到底 |
| HUD 任务列表 / 后台子任务（t-760 缺口 G-1 / G-2） | t-836 | `hud.md` **[待集成④]** | 20（0 · 7 · 13） | 17 / 1（H-12 计时起点）/ 3（H-18 shell 一行接线 · H-19 设计取舍 · H-20 messages + shell） | t-1029：核对 20 项 ✅ 19 / ❌ 1（`typecheck:preview` TS2353 → `747596782` 已修）；单测 55 例、`run.mjs` 68/68、截图 40 张复核 | 未合入 `feat/v5-selfhost-audit-hud@b1f06f8f5` **[待集成④]** | 后台任务失败原因可见、折叠态 390px 可读、结束态有结果信号、单一切换按钮 + inset 焦点环、列表高度封顶 + 渐隐、「知道了」跨刷新持久化 |
| 知识星球自动回复面板（G-3） | t-838 | `kp-automation.md` **[待集成④]** | 19（1 · 7 · 11） | 17（P1 / P2 全部；P3 9）/ 0 / 2 不修有判据（KP-18 · KP-19）+ 弹层形态 / Checkbox 原语归 shell | t-1029：核对 16 项 ✅ 15 / ❌ 1（KP-14 忙态单键静默吞点击 → `1db992620` 已修，用例修前红修后绿）；单测 70 例、截图 56 张复核 | 未合入 `feat/v5-selfhost-audit-kp-automation@b0fd16dad` **[待集成④]** | P1「同意并开启」失败错误写到弹层背后 + 上限不校验 → 就地报错与 1–30 校验；规则行 CardRow、字段级校验、运行记录可读、空态与文案 |
| 杂项 P3：`?demo=1` 演示模式 + optionsGroup 多题聚合（G-4 / G-5） | t-839 | `misc-p3.md` **[待集成④]** | 18 = D 9 + OG 9（0 · 2 · 16） | 12 = D 5 + OG 7（P2 2/2）/ 0 / D-02 余项 · D-08 shell；OG-05 · OG-09 messages；D-04 · D-09 产品 / 排版专项 | t-1029：核对 12 项全 ✅；MarkdownImpl 记忆化闭包审读无陈旧依赖；messages 使用方单测 167 + 150 例、`run.mjs` 68/68 无回归 | 未合入 `feat/v5-selfhost-audit-misc-p3@c834dffa1` **[待集成④]** | 首帧点选不再隐式发送、流式结束点选不丢（根因 `MarkdownImpl` 每次渲染新造渲染器导致富块整体重挂，受益含 HtmlPreview iframe）；demo fixture 自洽、流式三点可读屏 |
| PermissionCard 未决态审批交互（t-760 薄弱点） | t-875（t-837 作废重开） | `permission-card.md` **[待集成④]** | 17（0 · 5 · 12） | 17 / 0 / 0 | 首节核对 t-837 声称项：**无任何落地**（工作树半成品由 t-875 逐行走读后收口） | 已验收，未合入 `feat/v5-selfhost-audit-permission-card@8a3179896` **[待集成④]** | 卡头可换行 + 待决摘要、被顶掉活提问的待答入口、问答选项组方向键 / Home / End 与校验播报、批准中 loader、过期 fail-safe 说明；13 个预览场景 |
| a11y 专项：键盘 / 焦点 / 无障碍走查 → 三条修复单 | t-762 走查 → t-893 shell / t-894 mod-a / t-895 mod-b | `a11y-shell.md` · `a11y-mod-a.md` · `a11y-mod-b.md` **[待集成④]**；走查产物仓外 `.audit-tmp\a11y\DELIVERABLE.md` | 走查归属三单 **35**：shell 11（P2 2 · P3 9）· mod-a 14（P2 6 · P3 8）· mod-b 10（P2 1 · P3 9） | shell 11 / 11 · mod-a 14 / 14 + 顺手 1 + QA nit 2 · mod-b 10 / 10 + 顺手 1 + 附录 2（L-11 · M-23）/ 0 / a11y-shell §5 约 10 处模块内同源项（opacity 降色、`bg-accent text-white` 等）→ **待定：新任务或遗留 [待集成④]** | 复扫 257 场景：浅色对比度 <4.5 文本命中 356 → 58、深色 111 → 81、移动端 44px 触控命中 493 → 419（a11y-shell）；mod-a CDP 复扫无名控件 0、悬空 `aria-controls` 0 | 已验收，未合入 `-a11y-shell@4930707cc` · `-a11y-mod-a@475e3e6c7` · `-a11y-mod-b@8110d0eea` **[待集成④]** | 设计系统层：`text-accent-fg / danger-fg` 替代硬编码白字、浅色代码高亮四组色值 ≥4.8:1、`--faint` / 语义色压暗、全站 `::placeholder`、`TimeAgo` 渲染 `<time>`、Modal 正文可键盘滚动、Sheet 焦点回绕滚回可视区、DropdownMenu / SegmentedControl / Switch 触屏 44px、Toast 悬停暂停；模块内：无名控件补名、悬空引用、触控档、opacity 改实色 |

归属表勘误（t-839 §7，供 PLAYBOOK §8 修订）：`components/optionsGroup.tsx` → messages；`components/chat/researchEvidence.tsx` → tools；`components/mathDelimiters.ts` → messages。

## 4. 已验收未合入清单（集成④ t-896 范围）**[待集成④]**

| 分支 @ HEAD | 任务 | 内容 | 合入提示 |
|---|---|---|---|
| `feat/v5-selfhost-audit-qa-gap@c1734aac6`（指挥官验收时 `c06947a0c`，之后仅 +1 docs 提交） | t-1029 | = integration `c034f05d7` + hud `b1f06f8f5` / kp-automation `b0fd16dad` / misc-p3 `c834dffa1` 三支干净合入 + 2 处修复（`747596782` scenes-hud TS2353、`1db992620` KP-14 busyKeys）+ `qa/qa-gap.md` | 整支 fast-forward 可同时带上三条专项分支；或单独 cherry 三个提交 |
| `feat/v5-selfhost-audit-qa-p3@3e640a85d` | t-1028 | `qa/QA-p3-tail.md`：market2 / manage2 / sidebar2 / settings2 复核 37 ✅ / 0 ❌，2 条 a11y nit 已由 a11y-mod-a 落地 | 纯文档 |
| `feat/v5-selfhost-audit-qa-b-p3@0ac949b2e` | t-1038 | `qa/QA-b-p3.md` + `landing.md` L-11 备注 + `media.md` M-23 勘误：landing-B / media-B / tutorials-B 复核，1 处不符（M-23）已勘误并移交 t-895 | 纯文档；与 a11y-mod-b 的 `media.md` / `landing.md` 改动同文件，留意合并 |
| `feat/v5-selfhost-audit-a11y-shell@4930707cc` | t-893 | shell#1–11 全修（token / 原语层，8 + 1 提交）+ `a11y-shell.md` | 触碰 `styles.css` / `components/ui/**`，建议先合 |
| `feat/v5-selfhost-audit-a11y-mod-a@475e3e6c7` | t-894 | settings / org / manage / market / sidebar 14 条 + 顺手 1 + QA nit 2 + `a11y-mod-a.md` | — |
| `feat/v5-selfhost-audit-a11y-mod-b@8110d0eea` | t-895 | media / messages / tools / taskboard / landing / composer 10 条 + 顺手 1 + 附录 L-11 `6236dfb08` / M-23 `986f72b2f` + `a11y-mod-b.md` | 基线为集成③ 5/6 `be20adaec`，含 `App.test` / `AuthGate.test` 选择器改写 |
| `feat/v5-selfhost-audit-permission-card@8a3179896` | t-875 | PC-01…PC-17 全修 + 13 个预览场景 + `permission-card.md` | 基于 `210b9967`，含截图台外链 bundle 提交 `3f2c40ad9`（与 integration 同源方案，留意同文件） |
| `feat/v5-selfhost-audit-archive`（本分支） | t-632 | 本文 + `archive/` 更新（含 archive-prep `591c4cb70` 合并） | 纯文档 |

在跑 / 待领：t-1046 tut-sync-2（补写 agents / chat-basics 正文并抬 `contentVersion` 后恢复两处 `data-product-feature`，走普通 `tutorials:accept`）；t-896 集成④；t-897 归档终稿。

## 5. 遗留清单（逐条带归属与原因）

### 5.1 需后端 / 协议配合（本轮一律未动）

| 模块 | 项 | 原因 |
|---|---|---|
| sidebar | UCP-01 / GH-03 | 需后端字段 / 接口 |
| manage | M-17 文献库引用导出 / 文档详情 | `ResearchLibraryDoc` 无作者 / 年份 / venue，无单文档读接口 |
| manage | M-06 ③ `SkillSummary.sensitive` | 需后端下发；前端 `isSecretSkill` 规则兜底已就位 |
| settings | SET-09 组织充值汇率预估 / SET-10 组织改名 | 需 `credits_per_yuan` 下发 / `PATCH /api/org {name}` |
| settings | 会话用量 offset 分页漏行 | 前端已去重；漏行需游标分页 |
| taskboard | T-28 直接新建 AI 阶段 | 后端要求 AI 阶段绑定 agent |
| market | K-25 / X-02 offset 分页 / 虚拟化 | 需后端 offset |
| media | M-25 持久可分享地址 | 需分享令牌 / 公开链接接口；前端已改名「复制临时链接」并提示有效期 |
| messages | M-25 多标签旧快照覆写 IDB | 需真后端复现（本轮无 WS 后端） |
| HUD | H-12 计时精确起点 | `InflightDelegateSurface` 缺 `startedAt`；前端已取 `min(首次观察, updatedAt)` 并在 title 注明 |

### 5.2 需 shell / 跨模块接线（建议集成④ 或 shell 二期一并处理）

| 来源 | 项 | 落点 |
|---|---|---|
| HUD H-18 | 父轮结束后「停止本轮」仍显示 | `App.tsx` `onStop={wsSending ? stopTurn : undefined}`（一行）**[待集成④]** |
| tutorials TU-17 / TU-02 | 深链 `?panel=help&view=&work=` | `hooks/useAppRoute.ts` + `App.tsx`（集成③ 登记待办） |
| tutorials TU-34 | hero 品牌深蓝 token | `styles.css` `--hero-bg / --hero-fg`（可选） |
| taskboard T-20 | `BoardViewParam` 的 `inbox/backlog` 类型 | `hooks/useAppRoute.ts`（无功能影响） |
| market K-27 / kp-automation 同意勾选 | Checkbox 原语 | `components/ui`（全站尚无 Checkbox，两处保留原生 `<input type=checkbox>`） |
| misc-p3 D-02 余项 / D-08 | demo 其余会话 `onDemoSelect` 一行；demo 下交互块未说明原因 | `App.tsx`；`ChatInteraction` 加 `reason` |
| misc-p3 OG-05 / OG-09 | 发送文本半角标点（被 8 处断言与历史数据锁定）；发送失败后组锁定无恢复 | messages 单独立项；`sendUserText` 需失败通道 |
| HUD H-20 | `TokenUsageBadge` 流式重放入场动画；`--faint` 暗色对比度 | messages `chat/tokenUsage.tsx`；shell token（a11y-shell 已压暗 `--faint`，需复核是否已覆盖） |
| messages M-21 / M-24 | 生成中查找不能跳转；`_liveStreamBroken` 无 UI 消费方 | 需独立滚动交互设计；需 lib/chat 状态机专项 |
| settings | ConnectorsTab / KnowledgePlanetAutomationPanel 目录迁移；备案判据去重 | manage owner 决定；可选 |
| composer C-16 / C-26 / C-30 | 见 composer 正文遗留节 | shell / 产品 |
| a11y-shell §5 | 约 10 处模块内同源项：`OrgSubscribeDialog` / `OptimizationPanel` / `ApiKeysSection` 图标块 `bg-accent text-white`、`AgentPicker`「默认」`bg-accent/15`、`ModelSelector` 锁定行 opacity、`optionsGroup` / `RichBlocks` 勾选框白字、media 沉浸式 `bg-danger text-white`、`RepoPill` opacity、`KnowledgePlanetAutomationPanel:700` 勾选态白字 | **待定：新任务或遗留**（指挥官正请用户拍板）**[待集成④]**；其中 RepoPill / ApiKeysSection 部分已由 a11y-mod-a 落地 |

### 5.3 产品口径 / 设计取舍（先问再改）

shell S-08 / S-20；tutorials TU-19（0.9s 即已读）/ TU-21（CTA 五种文案）；HUD H-19（任务集文案微调也重展开）；market K-23（与「已安装页是卸载唯一权威」既有决定冲突）；misc-p3 D-04（演示账号 handle）/ D-09（气泡任意字号，排版专项）；landing L-16 ②；settings Auto-Dream 卡片文案、`ccswitch://` 深链带密钥（协议要求）。

### 5.4 不修有判据 / 打磨

kp-automation KP-18（骨架）/ KP-19（重拉星球列表）；settings SET-32（双份轮询不会并存）；tutorials TU-20 / TU-24 余量 / TU-29；taskboard §5 暂缓 9 项（平台限制 / 他模块归属 / 非缺陷）。

## 6. 决策与口径（全部有效决策 + 本轮决策卡）

| 编号 | 内容 | 影响 |
|---|---|---|
| d-24（arch） | 全部在本地克隆 + 每人独立 worktree 上做，不走 v5-dev SSH；成员只推自己分支，指挥官合入 integration；canonical 合入与发布留给有服务器通道的会话 / 用户 | 所有分支与本文 §9 的仓库布局 |
| d-26（git） | 提交 subject 禁 `fix(v5)`，改用 `feat / refactor / style / test / docs(v5)`；不碰 `changelog.json` | 全部提交 |
| d-28（ui） | UI 审计以 ui-preview 截图台为主要证据，每模块 before / after 各一套 | 全部审计 / 修复 / QA 的证据形态 |
| q-786 | 归档摘要落 `docs/audit/archive/`，摘要 + 索引不复制正文，SHA 逐个核存在 | t-761 / t-632 / t-897 |
| q-979 → `fix_in_integ3` | `check:tutorials` 入口覆盖两处存量漏标（ChatHeader「导出会话」、Sidebar「清除搜索」）在集成③ 补 `data-product-control` | `c034f05d7` |
| q-988 → `accept_in_integ3` | 教程同步快照 17 + 2 漂移在集成③ accept，附抄检 / note / 清单三条要求 | 引出 q-1076 |
| q-1076 → A `demote_then_source_only`（fable-5-1-18 拍板，**代用户确认**） | composer-B 新增的「去授权」「排队发送」两处 `data-product-feature` 降级为 `data-product-control`（`29a277b25`）+ `tutorials:accept --source-only --ids <17 项>`（`b249317f4`） | **必列终审导读**（§7-1） |

## 7. 终审导读（需用户过目 / 确认）

1. **教程同步快照 accept（q-988 → q-1076，指挥官代用户确认）**。TU-37 修好后 `check:tutorials` 在 Windows 首次真跑到底，一次性暴露 B 阶段各模块对入口元素的 UI/UX 修改导致的 17 项功能源哈希漂移 + 2 项入口身份变化。处置：两处新入口降级为控件（UI 零变化）+ source-only accept（`tutorial-sync-history.jsonl` 第 67 条 note 注明「待用户终审」）。抄检两篇教程正文引用的入口文案与 HEAD 逐条一致；唯一不一致是正文未描述这两个新入口 → t-1046 补写后恢复。**不认可 → `git revert b249317f4 29a277b25`**，其余门不受影响。详见 [INTEGRATION.md 集成③ §4](./INTEGRATION.md)。
2. **3 条基线红（与本轮改动无关，三轮集成逐条相同）**：`browser-tests/cc-switch-ascii-name.node-test.mjs` ×2（settings `ApiKeysSection` 模型 id 断言 `expected 'gemini-3.8-flash' / actual 'sonnet-5'` + 「还没有 API Key」10s 超时）；`ocv5-185-qa.node-test.mjs` ×1（Windows `symlinkSync` EPERM / 用例自带 `git diff --exit-code` 要求干净工作树，满足环境后单跑 15/15 绿）。是否要在本轮之外修 cc-switch 基线，请拍板。
3. **NOT RUN 汇总**：真机 iOS Safari / Android（全部模块）；读屏实机（NVDA / VoiceOver，a11y 以 CDP AX 树与 jsdom 断言替代）；真后端行为（登录 / 注册 / 支付回跳 / OAuth / 投稿 / 撤回 / WS 多标签 / 服务端版本比对 / 知识星球写接口 / 分享令牌）—— 本轮无 v5-dev 通道，全部以 api-stub 场景与单测桩覆盖；各模块 `npm test` 全量与 `test:browser` 在成员分支多为 NOT RUN（非高频面），由集成①②③ 在 integration 统一跑（§8.1）。
4. **越界改动**（均经指挥官批准并在交付单列）：t-839 改 messages 归属 `RichBlocks.tsx`（OptionsBlock 注册改 `useLayoutEffect`、聚合判定读快照）与 `MarkdownImpl.tsx`（`components` `useMemo`，根因：每次渲染新造渲染器致富块整体重挂）；t-1029 改 settings 归属 `KnowledgePlanetAutomationPanel.tsx`（忙态改按键集合）；t-865 / 集成轮的 App 接线与原语扩展（`Sheet closeButton` opt-in、`MediaTaskCenter onReusePrompt`）。
5. **设计取舍待拍板**：shell S-08 / S-20；market K-12 二期取「换行」（非箭头）；tutorials TU-13 删 `MissionReplay` / TU-31 第 4 步改指「设定目标」已按指挥官拍板落地；HUD H-19 保留既有交互；a11y-shell §5 约 10 处同源项是否新开任务（§5.2 末行）。
6. **需后端配合项**（§5.1）本轮一律未动，请决定是否另开后端专项。

## 8. 验证门汇总

### 8.1 集成③ 终点全量门（源码态 `b249317f4`，日志 `.audit-tmp\integration\integ3-*`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0 |
| `npm run typecheck:preview` | ✅ exit 0（集成② 登记的 3 红全消） |
| `npm run check:tutorials` | ✅ OK · 26 capabilities · 12 cases · 26 media pairs（accept 后，§7-1） |
| `npm test`（web-react 全量 vitest） | ✅ **298 文件 / 4213 例全部通过 ×2**（676s / 801s） |
| `npm run test:browser` | `run.mjs` **T1–T68 全部 ok**；`node --test` 73 例 70 过 / 3 失败 = §7-2 基线 |
| ui-preview 全量截图 | ✅ 257 场景 / 854 张，failures 0 / retried 0（`unmockedApi` 仅 `listCronChannels` / `listProjectAssets`，可选桩） |
| `biome lint`（集成③ 触碰 5 文件） | 新增 0 |

集成④ 终点全量门 **[待集成④]**。

### 8.2 各模块 / 专项交付时的验证（转录，NOT RUN 如实保留）

| 模块 / 专项 | typecheck | 模块 vitest | test:browser | 截图 before / after | NOT RUN |
|---|---|---|---|---|---|
| shell | ✅ | ✅ | ✅ | ✅ | 见正文 |
| messages | ✅ | ✅ | ✅（T68 新增） | ✅ | 真后端 WS / 多标签 |
| composer | ✅ | ✅ | ✅ `run.mjs` 67 全过 | ✅ | 真机 |
| sidebar | ✅ | ✅ | ✅ 67 全过 | ✅ 12 场景 34 张 | 真机 |
| manage | ✅ | ✅ 17 文件 212 例（二期） | NOT RUN（非高频面） | ✅ 49 场景 136 张 + after-2 12 张 | 全量交集成 |
| settings | ✅ | ✅ 21 文件 269 例（二期） | NOT RUN（非高频面） | ✅ + after-2 8 张 | 真实服务端版本比对 |
| taskboard | ✅ | ✅ | NOT RUN（非高频面） | ✅ 17 场景 66 张 | 全量交集成 |
| tools | ✅ | ✅ | ✅ | ✅ | — |
| market | ✅ | ✅ 11 文件 152 例（二期） | NOT RUN（非高频面） | ✅ 各 88 张（二期） | 真机 / Tooltip hover |
| landing | ✅ | ✅ | NOT RUN | ✅ | 真后端登录 |
| media | ✅ | ✅ | ✅ T30 更新 | ✅ | 真机 |
| tutorials | ✅ | ✅ 12 文件 95 例 | NOT RUN（非高频面） | ✅ 27 场景 108 张 | 全量交集成③ |
| HUD t-836 | ✅（`typecheck:preview` 红 → t-1029 修） | ✅ 4 文件 55 例 | ✅ 67 全过 | ✅ 40 / 40 | — |
| kp-automation t-838 | ✅ | ✅ 22 文件 270 例（settings + manage 目录） | NOT RUN（非高频面） | ✅ 56 / 56 | 全量 |
| misc-p3 t-839 | ✅ | ✅ 7 文件 270 例 + App.test | ✅ 两轮 68 全过 | ✅ 24 / 24 + messages 三场景对照 | 全量 |
| permission-card t-875 | ✅ | ✅ 70 例 | ✅（详见正文） | ✅ 13 场景 before / after-2 | 全量 **[待集成④]** |
| a11y-shell t-893 | ✅ | ✅ | ✅ | ✅ 257 场景 854 张 failures 0 + CDP 复扫 | 读屏实机 |
| a11y-mod-a t-894 | ✅ | ✅ | ✅ | ✅ 28 场景 各 90 张 + CDP 复扫 40 场景 | 读屏实机 |
| a11y-mod-b t-895 | ✅ | ✅ | ✅ | ✅ before / after 量化 | 读屏实机 |
| QA t-1028（integration `c034f05d7`） | ✅ + `typecheck:preview` | ✅ 四模块单测 | ✅（3 基线红同 §7-2） | ✅ 126 张 | — |
| QA t-1038（integration `c034f05d7`） | ✅ + `typecheck:preview` | ✅ 三模块单测 | ✅ | ✅ 258 张 | — |
| QA t-1029（integration `c034f05d7` + 三专项） | ✅ + `typecheck:preview` ✅（修后） | ✅ HUD 55 / KP 70 / misc 167(+150) / t-865 115 | ✅ 68/68；`node --test` 70/73 | ✅ 120 张 failures 0 | 全量交集成④ |

## 9. 分支 / 提交总表

| 分支 | HEAD（本地 = 远端，t-632 `git ls-remote` 核对） | 用途 |
|---|---|---|
| `feat/v5-selfhost`（canonical） | `210b9967`（基线，本轮未推进） | 基线 |
| `feat/v5-selfhost-ocv5-audit-ux` | `36bb9a677` | integration（集成①②③）**[待集成④]** |
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
| `feat/v5-selfhost-audit-hud` | `b1f06f8f5` | 专项 **[待集成④]** |
| `feat/v5-selfhost-audit-kp-automation` | `b0fd16dad` | 专项 **[待集成④]** |
| `feat/v5-selfhost-audit-misc-p3` | `c834dffa1` | 专项 **[待集成④]** |
| `feat/v5-selfhost-audit-permission-card` | `8a3179896` | 专项 **[待集成④]** |
| `feat/v5-selfhost-audit-a11y-shell` / `-a11y-mod-a` / `-a11y-mod-b` | `4930707cc` / `475e3e6c7` / `8110d0eea` | a11y **[待集成④]** |
| `feat/v5-selfhost-audit-qa-p3` / `-qa-b-p3` / `-qa-gap` | `3e640a85d` / `0ac949b2e` / `c1734aac6` | QA **[待集成④]** |
| `feat/v5-selfhost-audit-archive-prep` | `591c4cb70` | 归档摘要（已合入本分支 `ac0db7c35`） |
| `feat/v5-selfhost-audit-archive` | 本分支 | SUMMARY.md + archive/ **[待集成④]** |

集成合并提交一览：集成① `3cff04c85` `09a13a472` `bf8188def` `985b3ae57`（记录 `43b7cd3a4`）；集成② `5e5ed6925` `6fa690d7e` `ab765669a` `6201518b2` `10398baa9` `b41e804ac` `ae0b0cb64`（接线 `19799c0fe` · 用例 `f7c08f3eb` · `.gitattributes` `419e0d218` · `2a6492774` · 记录 `1d8eaf769` / `2b23a31a7` · 集成待办 t-865 `e0f53688a` `d4b061e37` `a3af53970` `bae5a8673` `7d5573a92` 记录 `1e4328ac9`）；集成③ `12fc17579` `cd58600e8` `425655631` `c761bbd93` `be20adaec` `ce767d8ce`（接线 `bdf7b4d15` · q-979 `c034f05d7` · q-1076 `29a277b25` `b249317f4` · 记录 `36bb9a677`）；集成④ **[待集成④]**。

## 10. 评审入口

- 仓库：`https://github.com/dream-star-end/smart-assistant`，分支同名（§9）；本地主克隆 `d:\code\test_project\test123\v5-selfhost`，工作树 `d:\code\test_project\test123\wt\<slug>`。
- 文档：本文 → [archive/README.md](./archive/README.md)（12 模块索引）→ `archive/<slug>.md`（归档摘要）→ `<slug>.md`（正文）；集成记录 [INTEGRATION.md](./INTEGRATION.md)；专项与 QA 正文（`hud.md` / `kp-automation.md` / `misc-p3.md` / `permission-card.md` / `a11y-*.md` / `qa/*.md`）随集成④ 合入后出现在 integration **[待集成④]**，此前可在各自分支查看。
- 截图（仓外，不入库）：`D:\code\test_project\test123\.audit-tmp\<slug>\{before,after}\`；集成③ 全量 854 张 `.audit-tmp\integration\shots-integ3\`；QA `.audit-tmp\qa-p3\shots\`（126）/ `qa-b-p3\integ\`（258）/ `qa-gap\shots\`（120）；a11y 走查 `.audit-tmp\a11y\`。
- 日志（仓外）：`.audit-tmp\integration\integ3-*.log`；各模块 / QA `.audit-tmp\<slug>\*.log`。
- 作业口径：`d:\code\test_project\test123\TEAM_PLAYBOOK.md`（仓外）；决策 d-24 / d-26 / d-28；决策卡 q-786 / q-979 / q-988 / q-1076（§6）。

## 11. **[待集成④]** 标记索引（终稿 t-897 逐处更新）

| 位置 | 更新内容 |
|---|---|
| §1 集成状态 / §4 全表 / §9 | 集成④ 合入后的 integration HEAD、合并提交、7 条分支状态 |
| §3 landing / media 行 | L-11 `6236dfb08`、M-23 `986f72b2f` 合入后去掉标记 |
| §3 HUD / 知识星球 / 杂项 P3 / PermissionCard / a11y 行 | 审计文档链接改为 integration 路径；a11y-shell §5 同源项拍板结果 |
| §5.2 H-18 / a11y-shell §5 | 集成④ 是否落地 H-18 一行接线；同源项新任务 or 遗留 |
| §7-1 | t-1046 补写正文 + 恢复 `data-product-feature` + 普通 `tutorials:accept` 后更新状态 |
| §8.1 | 集成④ 终点全量门 |
| §8.2 permission-card 行 | 合入后全量结果 |
| `archive/` | 新增 `archive/{hud,kp-automation,misc-p3,permission-card,a11y}.md` 摘要 + README 索引行 |
