# v5 个人版审计 · 总览（SUMMARY · 终稿，t-897）

> 给用户终审的**唯一入口**：总览 → 方法 → 按模块一节（含集成④ 后新交付）→ 集成④ 合入记录与集成⑤ 待合清单 → 遗留清单 → 决策与口径 → 终审导读 → 验证门 → 分支 / 提交总表 → 评审入口 → 终稿口径。每个数字都能在各模块正文 `docs/audit/<slug>.md`、归档摘要 `docs/audit/archive/<slug>.md` 或 `docs/audit/INTEGRATION.md` 找到出处；每个 SHA 都可 `git cat-file -e` 核实（t-632 初稿与 t-897 终稿各逐个核过一遍）。
> 只汇总不复制正文（q-786 口径）；未跑的验证一律标 **NOT RUN**。
> 版本：**终稿**，基于 integration **`c97a750f8`**（集成④ 终点，2026-09-17 23:28 已 push；源码态 `2d2b5cafc`），并带入归档分支 `feat/v5-selfhost-audit-archive@35e3ec7c9` 的初稿同步提交。集成⑤（t-1237）**尚未开始**：集成④ 之后已验收的 6 条分支在本文以「待集成⑤」为状态列出（§4.2），其数字来自各自交付文档与分支现算，不是占位。

## 1. 总览

| 项 | 内容 |
|---|---|
| 目标 | 对 v5 个人版（selfhost，`packages/web-react` 用户端）全部页面 / 模块做 UI/UX、功能正确性、交互友好性审计，审出的问题直接改代码落地（P1 / P2 必修，P3 量力而行并登记遗留），指挥官验收、合入 integration 后统一归档给用户终审；用户 09-17 授权后目标延伸为经集成⑤ 全量门 → 合并 canonical 上游 → push 回 canonical → 服务器 v3-dev-sg 端到端上线（d-1326 / d-1450，发布线不在本归档范围） |
| 时间跨度 | 2026-09-15（基线 `210b9967`、决策 d-24/26/28）→ 2026-09-17 23:28（集成④ 终点 `c97a750f8` 推送）；集成④ 之后当日又交付 6 条分支（§4.2），本文现算截至 2026-09-18 00:3x |
| 任务数 | 协同组任务库 **68 条**（09-18 00:20 宿主现算：已完成 57 · 在跑 1 · 待领 9 · 阻塞 1；作废条 t-837 不计入统计）。本归档覆盖其中审计线：集成③ 前 **54 条**（A 审计 12 · B 修复 12 · 二期 / 补丁 6 · 覆盖复查与补审专项 · a11y 专项 · QA 复核 3 · 集成 4 · 归档 3）+ 集成③ 后用户授权 **6 条**（t-1232 QA·复核 a11y-B×3 + PermissionCard ✅ · t-1233 a11y-C 同源项清扫 ✅ 已交付（四手收尾，t-1344 独立复核）· t-1234 遗留清扫 shell / market / settings / App ✅ · t-1235 遗留清扫 tutorials ✅ · t-1236 QA·集成④ 独立复核 待领 · t-1237 集成⑤ 待前置）+ 发布阻断 **t-1348** 首屏预算修复 ✅；其余为发布线（t-1279 预演 · 磁盘核查 · release-prep · release-deploy）与持有人离线后的收尾 / 替身单，不计入归档统计（数量以任务库为准） |
| 12 模块审出 | **359 条**（P1 8 · P2 108 · P3 243），P1 8/8 全部关闭；补审专项另审出 HUD 20 · 知识星球 19 · 杂项 P3 18 · PermissionCard 17 · a11y 走查归属三条修复单 35（11 + 14 + 10）→ a11y-C 承接同源项清单 13 |
| 合入量 | **29 个 `--no-ff` 合并提交**：集成① 4 条 123 files +13,855/−2,401 · 集成② 7 条 153 files +15,336/−2,295 · 集成③ 6 条 54 files +3,854/−1,211 · **集成④ 12 条 125 files +7,783/−654** → 合计 **455 files，+40,828 / −6,561**（跨轮同文件重复计；不含集成① 起点已含的 shell-B、各轮自有接线 / 用例 / 记录提交、集成待办 t-865） |
| 集成状态 | 集成④ 终点 **24 条成员分支「未合入提交 = 0」**（12 模块 + hud / kp-automation / misc-p3 / permission-card / a11y ×3 / tut-sync-2 / qa ×3 / archive@`a38a093bf`），远端 = 本地（`git ls-remote` 逐条核）；集成④ 之后新交付、**待集成⑤** 6 条：qa-a11y +2 · a11y-c +18 · leftover-tut +3 · leftover-shell +6 · budget-fix +2 · archive-final（本分支）；2 条预演分支不合入（§4.2） |
| 结果一句话 | 主流程无阻断项残留；P2 按各模块正文声明全部落地（shell 2 条设计取舍暂缓等用户拍板）；P3 以「本模块内可独立完成即做」为口径，未做的逐条有归属与理由（§5），其中集成③ 登记的跨模块遗留（H-18 / K-27 Checkbox / D-02·D-08 / TU-17·TU-34 / 备案判据 / a11y 同源项）已在集成④ 接线与 t-1233 ~ t-1235 全部落地；集成④ 终点全量门 typecheck / preview / `check:tutorials` / `npm test` 302 文件 4279 例 / `run.mjs` 68 / 截图 1026 张 / a11y 复扫 全绿，**唯一红 `build` 首屏 gzip 预算 471.4KB > 460.0KB 已由 t-1348 修到 445.5KB（待集成⑤ 合入后转绿，发布门）**（§8） |

## 2. 方法与口径

| 项 | 内容 | 出处 |
|---|---|---|
| 作业环境 | 本机到 v5-dev / 22 端口不通 → 全部在本地克隆 + 每人独立 git worktree：主克隆 `v5-selfhost`（只读参照）、`wt\<slug>` 工作树、分支 `feat/v5-selfhost-audit-<slug>`，成员只推自己的分支，指挥官合入 integration `feat/v5-selfhost-ocv5-audit-ux`；合入 canonical `feat/v5-selfhost` 与服务器发布在用户 09-17 授权后走 root@38.55.252.217 SSH 密钥通道，由指挥官代批（d-1326 / d-1450） | d-24、`TEAM_PLAYBOOK.md` §1–§2、d-1326 |
| 提交纪律 | subject 禁用 `fix(v5)`（门禁要求真实 Incident trailer，本轮无事故编号，禁止编造）→ `feat / refactor / style / test / docs / chore(v5)`；禁 `reset --hard` / `stash` / force-push；不碰 `changelog.json`；`git add` 精确文件；集成一律 `--no-ff` 不 rebase / squash | d-26、PLAYBOOK §7 |
| 证据工具 | `browser-tests/ui-preview/shoot.mjs` 截图台（真组件 + 真 production CSS + 真 Chromium + api-stub 假数据，每场景 desktop / mobile × light / dark）；每模块 before / after 各一套，PNG 存仓外 `D:\code\test_project\test123\.audit-tmp\<slug>\`（不入库），场景文件随代码提交；a11y 用 CDP AX 树扫描脚本 `.audit-tmp\a11y\scan.mjs` 量化对比度 / 触控 / 无名控件，逐场景比对 | d-28、PLAYBOOK §4 |
| 两阶段流程 | A 审计（只出文档 + 场景，不改业务代码）→ 指挥官评审 → B 修复（按批准计划改，每改动配测试，typecheck + 模块 vitest + 高频交互面跑 `test:browser` + after 截图）→ 二期（遗留 P3 收尾）→ 补丁 / 专项 → 集成 → QA 复核（第二双眼睛：每条声称定位到 file:line + 用例，复跑门，复扫，不合格直接修或移交） | PLAYBOOK §6 |
| 严重度 / 清单 | P1 阻断 · P2 明显缺陷或移动端不可用 · P3 打磨；七项清单：视觉 / 响应式（390px、触控 ≥44px）/ 交互反馈 / 功能正确性 / 可访问性 / 文案 / 代码质量 | PLAYBOOK §5 |
| 归属与协同 | 文件归属表 + 写锁；跨模块需求 `send_to` owner 或登记接线由集成轮落地；越界改动须指挥官批准并单列（§7-4）；持有人离线的任务由指挥官改派在线成员在原 id 下交付（d-1450 ③） | PLAYBOOK §8 |
| 归档口径 | 摘要 + 索引不复制正文；SHA 逐个 `cat-file` 核存在；统计排除 t-837；未合入的分支以「待集成⑤」为状态如实列出，不写占位 | q-786、t-632 / t-897 任务书 |

## 3. 按模块一节

计数口径：「审出」= 阶段 A 清单（P1 · P2 · P3）；「修复 / 部分 / 遗留」= 各正文修复记录与遗留章节（✅ / ◐ / 仍开放的本模块归属项）；「QA 复核」= t-1028（二期 P3，`qa/QA-p3-tail.md`）/ t-1038（B 轮 P3，`qa/QA-b-p3.md`）/ t-1029（缺口补审，`qa/qa-gap.md`）/ t-1232（a11y-B×3 + PermissionCard，`qa/QA-a11y.md`）的结论，前三份随集成④ 合入，第四份待集成⑤。数字抽查：shell / tools / media / market / taskboard / settings 六份正文结论行与本表一致（t-632）；终稿另抽 hud / permission-card / tutorials §10 / leftover-shell 四份与 §3 / §3.1 一致。

| 模块 | 任务 | 审计文档 | 审出（P1 · P2 · P3） | 修复 / 部分 / 遗留 | QA 复核 | 集成状态 | 一句结论 |
|---|---|---|---|---|---|---|---|
| shell 应用壳层与设计系统 | t-30 / t-31 | [shell.md](./shell.md) · [archive/shell.md](./archive/shell.md) | 20（1 · 8 · 11） | 18 / 1（S-20 半条）/ 2 暂缓（S-08、S-20 等用户拍板） | —（集成① 起点；a11y-shell t-893 另修 token 层 11 条，QA t-1232 11/11 ✅） | 集成① 起点 `e6f73dd99` 已含；a11y-shell 集成④ `15f816145`；`ui/Checkbox` 原语（t-1234）与首屏预算修复（t-1348，`shell.md` §9）待集成⑤ | P1「桌面端 `⌘K` 把整页点死」改按视口分流；Esc 归弹层不再掐掉生成中回合；Button / Chip 触控 44px、语义色对比度守卫、横幅栈折叠、主题跨标签同步为其余模块打底；a11y-shell 令牌层 `-fg` / `--faint` / hljs / placeholder / `<time>` / Modal·Sheet 焦点 / 触屏 44px / Toast 暂停 |
| messages 消息渲染与时间线 | t-32 / t-33 / t-629 | [messages.md](./messages.md) · [archive/messages.md](./archive/messages.md) | 25（0 · 4 · 21） | 22 / 0 / 3（M-21 需独立设计 · M-24 需状态机专项 · M-25 需真后端复现） | 二期由 t-629 自评（代码改动 0）；misc-p3 越界改动经 t-1029 复核无回归；a11y-mod-b messages#1/#2 经 t-1232 ✅ | 集成① `985b3ae57` → 集成③ `cd58600e8`；misc-p3 越界 / a11y-mod-b 集成④ | 只读面死按钮、触屏动作行折叠、宽表不拆词、流式光标内联、评价 chip 触控与配色全部落地；查找条焦点归还、ReqIdChip 44px |
| composer 输入区 / 会话头 / 模型与目标 | t-34 / t-35 | [composer.md](./composer.md) · [archive/composer.md](./archive/composer.md) | 35 + 承接 M-16（0 · 13 · 22） | 32 / 0 / 3（C-16 · C-30 待 `ask_decision` · C-26 需后端；C-32 已由 t-865 `d4b061e37` 落地） | —（集成② 合入后随全量门）；a11y-mod-b composer#2/#3 经 t-1232 ✅ | 集成② `ae0b0cb64`；接线 `19799c0fe`；a11y-mod-b / tut-sync-2 集成④；a11y-C「默认」徽章 `faa6e8b26` 待集成⑤ | 两行式输入区、语音状态播报、草稿超限预警、排队发送、模型切换中态 / 最近去重、目标对话框并发保护、窄屏更多菜单与快捷键平台化；锁定行实色 + sr-only 说明 |
| sidebar 侧栏 / 会话 / 项目 / 站内信 / GitHub | t-36 / t-37 / t-627 | [sidebar.md](./sidebar.md) · [archive/sidebar.md](./archive/sidebar.md) | 38（0 · 12 · 26；编号行 50，正文统计 38，摘要已注） | P2 12/12 + P3 多数 + 二期 S-14（正文未给逐条计数）/ — / 0 归属内；需后端 2（UCP-01 · GH-03）；P3 nit `RepoStatusBanner:85` 关闭钮 opacity（t-1232 观察） | t-1028：二期 §6.2 遗留 6 条处置 + RepoPill 顺手项 + shell 接线闭环 7 ✅ / 0 ❌ **通过**；a11y-mod-a sidebar#1/#2/#4 经 t-1232 ✅ | 集成① `3cff04c85` → 集成② `b41e804ac`；接线 `678fe9d38` `09d15400f`；a11y-mod-a 集成④ | 重命名 / 删除 / 加载更多失败不再静默、项目列表失败自动重试、拖宽把手键盘可调、多选保留状态点、项目范围深链冷启不回落 all（T-02）；RepoPill / RepoStatusBanner 去 opacity 实色 |
| manage 管理中心 | t-38 / t-39 / t-426 / t-626 | [manage.md](./manage.md) · [archive/manage.md](./archive/manage.md) | 27 + 跨模块 3（1 · 8 · 18） | 22 + 补丁① 4 + 二期 1 + 承接 X-03 / 0 / 2 需后端（M-17 · M-06 ③） | t-1028：§9 遗留 5 条处置 + X-03 + 验证门 6 ✅ / 0 ❌ **通过**（`cronHuman` 另跑 23 组边界探针）；a11y-mod-a manage#1–#4 经 t-1232 ✅ | 集成① `09a13a472` → 集成③ `c761bbd93`；a11y-mod-a 集成④；a11y-C `OptimizationPanel` 图标块 `b591e64b6` 待集成⑤ | P1 `cronBlocked` 误渲染空态收口；技能列表 / 工作台 / 项目专属技能改造；记忆面板读失败与空态互斥；`cronHuman` 支持星期 / 小时区间 |
| settings 设置中心 / 组织 / 支付 | t-40 / t-41 / t-426 / t-628 | [settings.md](./settings.md) · [archive/settings.md](./archive/settings.md) | 43（0 · 12 · 31） | 41 + 二期 4 / 0 / 需后端 2（SET-09 · SET-10）· 跨模块 1（`ConnectorsTab` 目录迁移，可选）· 不修 3；备案判据去重已由 t-1234 `74026e020` 落地 | t-1028：遗留表 11 项处置（4 项落地）+ 验证门 11 ✅ / 0 ❌ **通过**；2 条 a11y nit 转 a11y-mod-a（已修 `4efc0fa35` `beb48d930`）；a11y-mod-a settings 五条经 t-1232 ✅ | 集成② `5e5ed6925` → 集成③ `12fc17579`；a11y-mod-a 集成④；a11y-C `ApiKeysSection` 图标块 `b591e64b6`、t-1234 待集成⑤ | 壳层与偏好、用量 / API 接入统计卡、计费与支付、组织中心、ChatGPT 直连移动端 Tab 全部按审计落地；补丁① 承接 manage 的 ConnectorsTab 四项 |
| taskboard 任务面板 | t-42 / t-43 / t-630 | [taskboard.md](./taskboard.md) · [archive/taskboard.md](./archive/taskboard.md) | 30（2 · 14 · 14） | 27 + T-02 由 sidebar 修 / 2（T-20 shell 类型 · T-28 后端约束）/ 0 | 二期由 t-630 自评（仅场景 1 行，消 `typecheck:preview` TS2322）；a11y-mod-b taskboard#2 经 t-1232 ✅ | 集成① `bf8188def` → 集成③ `425655631`；a11y-mod-b 集成④ | P1「切换 projects/agents 数据丢失」与 T-02 深链回落已修；看板 / 列表 / 抽屉 / 设置面板 P2 14/14 |
| tools 工具卡 / 智能体过程 / 检查器 | t-44 / t-45 | [tools.md](./tools.md) · [archive/tools.md](./archive/tools.md) | 31 + 跨模块 4（1 · 7 · 23） | 31 / 0 / 0（跨模块 4 转 owner；T-18 选中态由 `19799c0fe` 接线） | a11y-mod-b tools#1 经 t-1232 ✅ | 集成② `6fa690d7e`；a11y-mod-b 集成④ | P1 Grok 输出归一化只对原生名与明确信封生效；状态单一权威、信封解包、触控靶、a11y、文案全部收口 |
| market AI 市场 | t-46 / t-47 / t-625 | [market.md](./market.md) · [archive/market.md](./archive/market.md) | 26（1 · 4 · 21） | 13 + 二期 10 = 23 / 0 / 2（K-23 不做有判据 · K-25 需后端 offset）；K-27 已由 t-1234 `ui/Checkbox` 落地；P3 nit `MyPublishes` 折叠钮 322×42（t-1232 观察） | t-1028：10 条 P3 落地 + 3 条保持遗留 + 验证门 13 ✅ / 0 ❌ **通过**；a11y-mod-a market#1/#2 经 t-1232 ✅（计划外「查看」钮宽 38 → QA `77a93d9e1` 补 `min-w-11`） | 集成② `ab765669a` → 集成③ `be20adaec`；接线 `19799c0fe`；a11y-mod-a 集成④；t-1234 / qa-a11y 待集成⑤ | P1「发布草稿关弹窗无提示丢失」已落盘；发现页卡片截断 / 分区计数 / 加载更多报错；二期收掉已安装行动作簇、就绪徽章、kill-switch 窄屏折叠、徽章解释 Tooltip、插件契约人话；审核面 / 发布页 checkbox 走原语 |
| landing 落地页 / 登录 / 法务 / 桌面端登记 | t-48 / t-49 | [landing.md](./landing.md) · [archive/landing.md](./archive/landing.md) | 20 + 跨模块 3（0 · 3 · 17） | 16 + L-11（t-895 附录 `6236dfb08`）/ 2 / 1（L-16 ② 产品） | t-1038：20 条 + X-01~03 逐条对上 **0 处不符**，P2 3/3 ✅；L-11 遗留理由失效 → 移交 t-895 已修；a11y-mod-b landing#1/#2 + L-11 经 t-1232 ✅ | 集成② `6201518b2`；a11y-mod-b（含 L-11）集成④ `80e757d95` | 无阻断项；P2 ×3 + P3 ×13 落地（登录 / 法务 / 桌面端登记文案、备案占位、页脚）；登录 / 注册页占位符不再复读标签（L-11）；页脚 / FAQ / AuthGate 触控 44px（landing 11 场景 t44 18 → 0） |
| media 图片 / 媒体 / 容器网页预览 | t-50 / t-51 | [media.md](./media.md) · [archive/media.md](./archive/media.md) | 27（2 · 11 · 14） | 25（含 M-23 两半条：textarea 自增高 `2d75dbb45` + 性能半条 t-895 附录 `986f72b2f`）/ 0 / 1（M-25 需后端分享令牌，前端半条已做；M-27 由 t-865 `a3af53970` 落地） | t-1038：27 条 + X-M1~M4 逐条对上，**1 处不符**（M-23 性能半条文档写 ✅ 实未做 → `media.md` 已勘误 + 移交 t-895 落地）；P1 2/2 · P2 11/11 ✅；a11y-mod-b media#1/#2 + M-23 经 t-1232 ✅ | 集成② `10398baa9`；X-M2 / X-M3 / X-M4 由 t-865 落地；a11y-mod-b（含 M-23）集成④ `80e757d95`；a11y-C 「放弃」危险键 `5533e0503` / placeholder `c0c9059a1` 待集成⑤ | 图片查看器子模式、圈选编辑器底栏、视频任务中心关闭 / 术语 / 危险操作确认、容器网页预览 Esc 分层 / 关闭确认 / Tab 可达 / 触屏跟手；MediaTaskCenter header 固定 + body 滚动 |
| tutorials 教程中心 | t-52 / t-53；t-1046；t-1235 | [tutorials.md](./tutorials.md) · [archive/tutorials.md](./archive/tutorials.md) | 37（0 · 12 · 25） | 28 + t-1235 2（TU-17 · TU-34）/ 5（TU-19 · 20 · 24 · 29 · 32）/ 1（TU-21 产品口径；TU-36 已由集成② 落地）+ 1 nit（`TutorialCenter:387` 图标块白字，a11y-C 补记） | t-1038：37 条 + 追加①② 逐条对上 **0 处不符**，P2 12/12 ✅；`check:tutorials` 在核对态红 → q-1076 处置后在 `b249317f4` 复跑绿 | 集成③ `ce767d8ce`（A+B）；接线 `bdf7b4d15`；tut-sync-2 `67b1494ea` 集成④ `96eb0eadf`；leftover-tut `69e18aa93` 待集成⑤ | 功能参考有一级入口、精选作品受控、帮助菜单换 DropdownMenu、移动端搜索有反馈、教程工作室表单门槛 / 错误态 / 撤回确认、iframe 沙箱、22 KB 死代码删除、TU-37 门禁在 Windows 首次真跑到底；正文补写 agents / chat-basics；深链 `tab= / work= / topic=&step=` + 模块级 hero token |
| HUD 任务列表 / 后台子任务（t-760 缺口 G-1 / G-2） | t-836 | [hud.md](./hud.md) · [archive/hud.md](./archive/hud.md) | 20（0 · 7 · 13） | 17 / 1（H-12 计时起点）/ 2（H-19 设计取舍 · H-20 ① messages）；H-18 由集成④ `4a2745283` 接线、H-20 ② 由 a11y-shell 压暗 `--faint` | t-1029：核对 20 项 ✅ 19 / ❌ 1（`typecheck:preview` TS2353 → `747596782` 已修）；单测 55 例、`run.mjs` 68/68、截图 40 张复核 | 集成④ `2c1d659d2`（QA 修复随 qa-gap `902ade6e8`） | 后台任务失败原因可见、折叠态 390px 可读、结束态有结果信号、单一切换按钮 + inset 焦点环、列表高度封顶 + 渐隐、「知道了」跨刷新持久化；父轮结束后「停止本轮」收起 |
| 知识星球自动回复面板（G-3） | t-838 | [kp-automation.md](./kp-automation.md) · [archive/kp-automation.md](./archive/kp-automation.md) | 19（1 · 7 · 11） | 17（P1 / P2 全部；P3 9）/ 0 / 2 不修有判据（KP-18 · KP-19）+ 弹层形态归 shell；勾选态白字由 a11y-C `00b86b565` 修；P3 nit「从当前账号…」钮 316×42（t-1232 观察） | t-1029：核对 16 项 ✅ 15 / ❌ 1（KP-14 忙态单键静默吞点击 → `1db992620` 已修，用例修前红修后绿）；单测 70 例、截图 56 张复核 | 集成④ `d83d4a368`；a11y-C 待集成⑤ | P1「同意并开启」失败错误写到弹层背后 + 上限不校验 → 就地报错与 1–30 校验；规则行 CardRow、字段级校验、运行记录可读、空态与文案 |
| 杂项 P3：`?demo=1` 演示模式 + optionsGroup 多题聚合（G-4 / G-5） | t-839 | [misc-p3.md](./misc-p3.md) · [archive/misc-p3.md](./archive/misc-p3.md) | 18 = D 9 + OG 9（0 · 2 · 16） | 12 = D 5 + OG 7（P2 2/2）/ 0 / OG-05 · OG-09 messages；D-04 · D-09 产品 / 排版专项；D-02 余项由集成④ `4a2745283`、D-08 由 t-1234 `3aba642ca`、勾选框白字由 a11y-C `59e66773f` 落地 | t-1029：核对 12 项全 ✅；MarkdownImpl 记忆化闭包审读无陈旧依赖；messages 使用方单测 167 + 150 例、`run.mjs` 68/68 无回归 | 集成④ `bf940d804`；t-1234 / a11y-C 待集成⑤ | 首帧点选不再隐式发送、流式结束点选不丢（根因 `MarkdownImpl` 每次渲染新造渲染器导致富块整体重挂，受益含 HtmlPreview iframe）；demo fixture 自洽、流式三点可读屏、演示模式交互块说明原因 |
| PermissionCard 未决态审批交互（t-760 薄弱点） | t-875（t-837 作废重开） | [permission-card.md](./permission-card.md) · [archive/permission-card.md](./archive/permission-card.md) | 17（0 · 5 · 12） | 17 / 0 / 0（弹框关闭焦点归位 shell、提交超时 状态机 两项 ⏸ 登记） | 首节核对 t-837 声称项：**无任何落地**（工作树半成品由 t-875 逐行走读后收口）；**t-1232：PC-01…17 17/17 在 integration 定位 ✅**，QA 补 1 处漏项（`查看完整参数` summary 触屏 44px `77a93d9e1`） | 集成④ `015522b66`；QA 修复待集成⑤ | 卡头可换行 + 待决摘要、被顶掉活提问的待答入口、问答选项组方向键 / Home / End 与校验播报、批准中 loader、过期 fail-safe 说明；13 个预览场景 |
| a11y 专项：键盘 / 焦点 / 无障碍走查 → 三条修复单 → 同源项清扫 | t-762 走查 → t-893 shell / t-894 mod-a / t-895 mod-b → t-1233 a11y-C | [a11y-shell.md](./a11y-shell.md) · [a11y-mod-a.md](./a11y-mod-a.md) · [a11y-mod-b.md](./a11y-mod-b.md) · `a11y-c.md`（分支）· [archive/a11y.md](./archive/a11y.md)；走查产物仓外 `.audit-tmp\a11y\DELIVERABLE.md` | 走查归属三单 **35**：shell 11（P2 2 · P3 9）· mod-a 14（P2 6 · P3 8）· mod-b 10（P2 1 · P3 9）；a11y-shell §5 同源项清单 **13** | shell 11 / 11 · mod-a 14 / 14 + 顺手 1 + QA nit 2 · mod-b 10 / 10 + 顺手 1 + 附录 2（L-11 · M-23）= 12 / 0 / —；**a11y-C 13 项：已修 7 项 / 9 处 + 复扫补修 2、同批分支闭环 5、不修 1（`ReviewPanel` 禁用态 WCAG 例外）**；收尾补记 `TutorialCenter:387` 图标块白字（tutorials，一行改法登记） | **t-1232**：t-893 11/11 ✅ · t-894 16 ✅ / 1 ◐（QA 直接修）· t-895 13/13 ✅ —— 合入态 301 场景复扫 vs t-893 after 共同 257 场景 cL 58→44 / cD 81→69 / t44 419→163 / names 16→11 / ax 3→1，**逐场景回归 0**；集成④ 自扫 vs 集成③ 态 cL 356→44 / cD 111→69 / t44 493→163 | 集成④ `15f816145` · `68f031ba6` · `80e757d95`（附录 `85a7aea54` M-23 契约用例 + docs）；a11y-c@`c35fd00c6` / qa-a11y@`eed1f3989` 待集成⑤ | 设计系统层：`text-accent-fg / danger-fg` 替代硬编码白字、浅色代码高亮四组色值 ≥4.8:1、`--faint` / 语义色压暗、全站 `::placeholder`、`TimeAgo` 渲染 `<time>`、Modal 正文可键盘滚动、Sheet 焦点回绕滚回可视区、DropdownMenu / SegmentedControl / Switch 触屏 44px、Toast 悬停暂停；模块内：无名控件补名、悬空引用、触控档、opacity 改实色；a11y-C 把「白字压 `bg-accent` / `bg-danger`」类命中 4 → 0 |

归属表勘误（t-839 §7，供 PLAYBOOK §8 修订）：`components/optionsGroup.tsx` → messages；`components/chat/researchEvidence.tsx` → tools；`components/mathDelimiters.ts` → messages。

### 3.1 集成④ 之后新交付（用户 09-17 授权 · 均已验收 · 待集成⑤）

| 任务 | 内容 | 审出 / 处置 | 验证摘要 | 分支 @ HEAD | 摘要 / 正文 |
|---|---|---|---|---|---|
| t-1232 QA·复核 a11y-B×3 + PermissionCard | 第四轮 QA（fable-5-1-23 起稿 → fable-5-1-35 接手独立重做） | 核对 58 项：✅ 57 / ◐ 1 / ❌ 0，四条**全部通过**；QA 直接修 2 处（`77a93d9e1`：`PublishPanel`「查看 / 收起」`min-w-11`、`PermissionCard` summary `py-3.5`，修前红修后绿） | typecheck / preview ✅；全量 `npm test` 302/302 文件（`MessageRenderer.test` 冷启超时单跑 152/152）；`run.mjs` 68/68；截图 20 场景 74 张 0 失败；CDP 复扫 301 场景，共同 257 场景回归 0；`merge-tree` 试合无冲突 | `feat/v5-selfhost-audit-qa-a11y@eed1f3989`（+2） | [archive/qa.md](./archive/qa.md) §4 · `qa/QA-a11y.md`（分支） |
| t-1233 a11y-C 跨模块同源项清扫 | a11y-shell §5 清单 13 项 + 复扫补修 2（fable-5-1-38 代码 → fable-5-1-55 收尾复核 → 指挥官 fable-5-1-50 成文 push `361f59b1f` → fable-5-1-3 第四手独立复核 t-1344 `ea9348b2b` → fable-5-1-5 补 `test:browser` 门 + 遗留登记 `c35fd00c6`，t-1233 交付） | 已修 7 项 / 9 处 className（`b591e64b6` `59e66773f` `00b86b565` `5533e0503` `abb246fdb` `faa6e8b26`）+ 补修 2（`c0c9059a1`）；同批闭环 5；不修 1（WCAG 例外）；用例格式化 `12275f27a`；16 文件仅 className（11 处 + 4 行注释）+ 用例断言；收尾补记 `TutorialCenter.tsx:387` 同根因白图标（tutorials 归属，一行改法登记 §5.2） | typecheck ✅；8 用例文件 121 例 ✅（三手复现）；biome 新增 0（两手按「文件 × 规则」比对 37 = 37）；CDP 复扫 288 场景三轮：白字压 accent / danger 4 → **0**，cL 49→47 / cD 77→70，逐场景上升 0（第四手 `tutorials-help-menu-open` tabBad 1→2 为 Radix 护栏 span 计数抖动，非回归）；截图 60 对尺寸相同；**`test:browser` `run.mjs` 68/68 + `node --test` 70/73（3 基线）**；**NOT RUN 全量 `npm test`**（交集成⑤） | `feat/v5-selfhost-audit-a11y-c@c35fd00c6`（+18 = 11 自有 + 7 对齐合并；远端 = 本地） | [archive/a11y.md](./archive/a11y.md) §6 · `a11y-c.md`（分支） |
| t-1234 遗留清扫 shell / market / settings / App | K-27 `ui/Checkbox` 原语 + market 四处接入；settings 备案判据改引 `filedIcp()`；misc-p3 D-02 用例 / D-08 `ChatInteraction.reason`（前任 5 提交 → fable-5-1-52 复核成文） | 4/4 落地；不加依赖、既有原语零改动、`App.tsx` 只动 D-08 一处 | typecheck / preview ✅；相关 6 文件 92 例 + `App.test` 48/48 ✅；biome 新增 0；CDP AX 28 checkbox 全部有名、mixed 正确、移动端 label 44px；截图 before 22 / after 30 张 0 失败；**NOT RUN** 全量 / `test:browser`（非高频面） | `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`（+6） | [archive/leftover.md](./archive/leftover.md) §1 · `leftover-shell.md`（分支） |
| t-1235 遗留清扫 tutorials TU-17 / TU-34 | 深链 `?panel=help&tab= / work= / topic=&step=` 进 URL 可反灌（`view=` 改 `tab=` 避开 `/board`）；模块级 hero token `heroTheme.ts` 替 12 处写死色值 | 2/2 落地；`check:tutorials` 无漂移不需 accept | typecheck / preview ✅；11 文件 132 例 ✅（+6）；biome 新增 0；截图 27 场景 before / after 各 108 张 0 失败；**NOT RUN** 全量 / `test:browser` | `feat/v5-selfhost-audit-leftover-tut@69e18aa93`（+3） | [archive/leftover.md](./archive/leftover.md) §2 · [tutorials.md](./tutorials.md) §10 |
| t-1348 发布阻断·首屏 gzip 预算超限修复 | 集成④ `build` 红 471.4KB > 460.0KB → 8 处「点开才需要」的覆盖层 `React.lazy` / 常量下沉（首屏可见组件不 lazy），阈值不动 | 修后 **445.5KB**，`npm run build` exit 0，净减 25.9KB；越界触及 messages / settings / sidebar 三处机械改动已单列 | `build` ✅；typecheck ✅；15 文件 303 例 ✅；**全量 `npm test` 302 / 4279 ✅**；`run.mjs` 68/68 + `ocv5-185` 15/15；biome 新增 0；**NOT RUN** 截图（零视觉改动）、慢网首开体感 | `feat/v5-selfhost-audit-budget-fix@65019b5dc`（+2） | [archive/leftover.md](./archive/leftover.md) §3 · [shell.md](./shell.md) §9 |
| t-1236 QA·集成④ 最终 HEAD 独立复核 | — | **待领**（截至 09-18 00:3x 无产出） | — | — | — |
| t-1237 集成⑤ | 合入上表 5 支 + 本归档分支，复跑全量门（`build` 必须绿） | **待前置**（qa-integ4 t-1236 等） | — | — | INTEGRATION 集成④ §7 / §8 待合清单 |

## 4. 集成④ 合入记录与集成⑤ 待合清单

### 4.1 集成④（t-896，`36bb9a677` → `c97a750f8`；执行 fable-5-1-24 → 收尾 fable-5-1-52）

| 序 | 成员分支 @ HEAD（任务） | 合并提交 | 文件 / 行 | 备注 |
|---|---|---|---|---|
| 1 | `-hud@b1f06f8f5`（t-836） | `2c1d659d2` | 9, +959/−90 | `run.mjs` T61 一行三方合并 |
| 2 | `-kp-automation@b0fd16dad`（t-838） | `d83d4a368` | 4, +1525/−283 | 零重叠 |
| 3 | `-misc-p3@c834dffa1`（t-839） | `bf940d804` | 9, +676/−51 | 零重叠 |
| 4 | `-permission-card@8a3179896`（t-875） | `015522b66` | 5, +1248/−37 | `MessageRenderer.test.tsx` 三方自动合并 |
| 5 | `-a11y-shell@4930707cc`（t-893） | `15f816145` | 20, +513/−51 | token / `components/ui/**` / `styles.css`，先于 mod-a / mod-b |
| 6 | `-a11y-mod-a@475e3e6c7`（t-894） | `68f031ba6` | 29, +414/−50 | 零重叠 |
| 7 | `-a11y-mod-b@9710a3b24`（t-895，含 L-11 / M-23 附录） | `80e757d95` | 18, +481/−57 | `Composer.tsx` / `MessageRenderer.test.tsx` 三方自动合并 |
| 8 | `-tut-sync-2@67b1494ea`（t-1046） | `96eb0eadf` | 7, +25/−24 | `Composer.tsx` 三方自动合并（恢复 C-02 `data-product-feature`） |
| 9 | `-qa-gap@c1734aac6`（t-1029，自带 hud / kp / misc-p3 合并） | `902ade6e8` | 4, +192/−41 | **唯一冲突** `scenes-hud.tsx` 取 qa-gap `747596782`（q-1227 预先指定） |
| 10 | `-qa-p3@3e640a85d`（t-1028） | `4f93f6990` | 1, +125 | 纯文档 |
| 11 | `-qa-b-p3@0ac949b2e`（t-1038） | `f605df89f` | 3, +242/−2 | 纯文档 + landing / media 勘误 |
| 12 | `-archive@a38a093bf`（t-632 / t-761 / t-897 预写） | `b23955208` | 20, +1404 | 纯文档；tip 后又 +1 `35e3ec7c9`（本分支已带入） |

自有提交：`d2afaaa20` test（scenes-hud TS2353，后被 #9 覆盖）· `4a2745283` feat App 接线（hud H-18 `onStop` 条件化、misc-p3 D-02 demo 会话按 id 取 fixture）· `2d2b5cafc` chore 教程同步快照 `--source-only` accept 1 项（q-1227 → A，§7-1）· `c97a750f8` docs 记录。合计 125 files, +7783/−654；`git rev-list --count HEAD..<成员 HEAD>` 12 条均为 0，合并完整性 LOST = 0，五处三方合并逐文件对照无丢失；全部 subject 无 `fix(v5)`，未 rebase / squash / force-push。远端：`git ls-remote` = 本地 `c97a750f8`（快进 `36bb9a677..c97a750f8`，集成④ 全部 81 个提交）。详见 [INTEGRATION.md 集成④](./INTEGRATION.md)。

### 4.2 集成⑤ 待合清单（t-1237 前置；09-18 00:3x 按 `git rev-list --count c97a750f8..<分支>` 现算）

| 分支 `feat/v5-selfhost-audit-*` @ HEAD | 任务 | 未合入 | 远端 | 合入提示 |
|---|---|---|---|---|
| `qa-a11y@eed1f3989` | t-1232 | 2 | = 本地 | `77a93d9e1` 4 文件 + 报告；`merge-tree` 试合 `2d2b5cafc` 无冲突 |
| `a11y-c@c35fd00c6` | t-1233（已交付；t-1344 第四手复核 `ea9348b2b`） | 18（11 自有 + 7 对齐合并） | = 本地 | 基线 `36bb9a677` + a11y-shell / mod-a / mod-b / kp-automation / misc-p3 / tut-sync-2 / qa-gap 七支对齐合并（与集成④ 内容相同，预期零冲突）；全量 `npm test` 交集成⑤ |
| `leftover-tut@69e18aa93` | t-1235 | 3 | = 本地 | 基于 `tut-sync-2@67b1494ea`；`App.tsx` / `useAppRoute.ts` 与下两支同文件不同 hunk，留意三方合并 |
| `leftover-shell@7e7c7e43b` | t-1234 | 6 | = 本地 | 基于 `2d2b5cafc`；`App.tsx` 一处（D-08） |
| `budget-fix@65019b5dc` | t-1348 | 2 | = 本地 | 基于 `2d2b5cafc`；`App.tsx` lazy 改造较大；**合入后 `npm run build` 必须绿（发布门）** |
| `archive-final`（本分支，§9） | t-897 | 本轮 docs 提交 + 已带入 `archive@35e3ec7c9` | 交付时推送 | 纯文档（`SUMMARY.md` + `archive/`）；`archive` 分支不必再单独合入 |
| ~~`integ4-rehearsal@522c24988`~~ / ~~`release-rehearsal@c1fdc935e`~~ | 集成④ 预演 / t-1279 发布预演 | 8 / 8 | 未推 | **不合入**：前者 8 个 `rehearsal:` 合并；后者 canonical `3b7c38b9d` 试合 `2d2b5cafc` 的 7 处冲突解法与普通 `tutorials:accept` 第 70 条，结论供 release-prep 以 canonical `f1952819f` 重做核对 |

集成⑤ 之后（不在本归档范围，按 d-1326 / d-1450 由指挥官全权推进）：release-prep（integration 合并 canonical `feat/v5-selfhost@f1952819f`，基线之后上游 7 提交：OCV5-220 顾问卡 / OCV5-223 Codex 1M 双胞胎 / Sand 家族接入选择器）→ release-deploy（push canonical + 服务器 `/opt/openclaude/openclaude-v5-selfhost` `deploy-v5-selfhost.sh --preflight/--deploy/--smoke`；服务器 `/` 盘 94% 的磁盘核查 disk-prep 在跑）。

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
| media | M-24 价格字段 / M-09 双指缩放 | INTEGRATION 集成④ §7 登记为后端 / 协议项 |
| messages | M-25 多标签旧快照覆写 IDB | 需真后端复现（本轮无 WS 后端） |
| HUD | H-12 计时精确起点 | `InflightDelegateSurface` 缺 `startedAt`；前端已取 `min(首次观察, updatedAt)` 并在 title 注明 |
| composer | C-26 余额预警阈值 | 前端无阈值字段，硬编码会与套餐漂移 |

### 5.2 跨模块 / 接线项（集成③ 登记 → 集成④ 与 t-1233 ~ t-1235 处置结果）

| 来源 | 项 | 状态 / 落点 |
|---|---|---|
| HUD H-18 | 父轮结束后「停止本轮」仍显示 | ✅ 集成④ `4a2745283` `App.tsx` `onStop={wsSending ? stopTurn : undefined}` |
| tutorials TU-17 / TU-02 | 深链 `?panel=help&view=&work=` | ✅ t-1235 `3fee24a58`（参数名改 `tab=`，`useAppRoute` + `App.tsx` 两处挂载）待集成⑤ |
| tutorials TU-34 | hero 品牌深蓝 token | ✅ t-1235 `04006714f` 模块级 `heroTheme.ts`，不再需要 shell 改 `styles.css`；待集成⑤ |
| market K-27 / kp-automation 同意勾选 | Checkbox 原语 | ✅ t-1234 `959735722` 新增 `ui/Checkbox`，market 四处接入 `ffac63718`；kp-automation 同意勾选换用原语为后续建议（owner 另出 before / after）；待集成⑤ |
| misc-p3 D-02 余项 / D-08 | demo 其余会话 `onDemoSelect` 一行；demo 下交互块未说明原因 | ✅ D-02 集成④ `4a2745283` + 用例 t-1234 `3aba642ca`；D-08 t-1234 `3aba642ca` `ChatInteraction.reason`；待集成⑤ |
| settings | 备案判据去重 | ✅ t-1234 `74026e020` 改引 `lib/legal` `filedIcp()`；待集成⑤ |
| a11y-shell §5 | 约 10 处（清单 13 项）模块内同源项 `bg-accent text-white` / `bg-accent/15` / `bg-danger text-white` | ✅ t-1233 a11y-C 已修 7 项 / 9 处 + 补修 2、同批闭环 5、不修 1（`ReviewPanel` 禁用态 WCAG 例外）；分支 `a11y-c@c35fd00c6` 待集成⑤；合入后集成④ 复扫的 `shell#1` 残留 4 与 `AgentPicker` 4.40 应归零 |
| a11y-C 收尾补记 | `TutorialCenter.tsx:387` 教程中心头部图标块「案例」模式白图标压实底 `bg-accent`（深色 2.82 <3:1，同 shell#1 根因；不在 §5 清单、`<svg>` 非文本节点复扫不计） | ⏸ tutorials owner / 集成⑤ 顺手：`mode === "cases" ? "bg-accent text-accent-fg" : "bg-grad-cta text-white"` 一行 |
| composer C-32 | 团队卡内部代号 | ✅ t-865 `d4b061e37`（集成②） |
| media M-27 / X-M2 | 容器预览 10–11px 字号 | ✅ t-865 `a3af53970`（集成②） |
| landing L-11 / media M-23 性能半条 | QA t-1038 移交 | ✅ t-895 附录 `6236dfb08` / `986f72b2f` `85a7aea54`（集成④） |
| taskboard T-20 | `BoardViewParam` 的 `inbox/backlog` 类型 | ⏸ `hooks/useAppRoute.ts`（无功能影响） |
| misc-p3 OG-05 / OG-09 | 发送文本半角标点（被 8 处断言与历史数据锁定）；发送失败后组锁定无恢复 | ⏸ messages 单独立项；`sendUserText` 需失败通道 |
| HUD H-20 | ① `TokenUsageBadge` 流式重放入场动画；② `--faint` 暗色对比度 | ① ⏸ messages `chat/tokenUsage.tsx`；② ✅ a11y-shell `d30ed780e` 压暗（集成④ 复扫 hud 场景对比度 0） |
| messages M-21 / M-24 | 生成中查找不能跳转；`_liveStreamBroken` 无 UI 消费方 | ⏸ 需独立滚动交互设计；需 lib/chat 状态机专项 |
| settings | `ConnectorsTab` / `KnowledgePlanetAutomationPanel` 目录迁移 | ⏸ manage owner 决定；可选 |
| composer C-16 / C-30 | 「+」菜单单项直达；Cursor 1M 档位费用确认 | ⏸ 待 `ask_decision`（改直达需同改 T2 / T7 / T25 真浏览器用例契约；1M 档位计费语义是产品口径） |
| permission-card | 自动弹框关闭后焦点落 `document.body`；「正在提交…」无超时 / 重试 | ⏸ shell 接 `Modal onCloseAutoFocus` 一行；协调器 / `lib/chat` 状态机 |
| QA t-1232 观察项（P3 nit） | `KnowledgePlanetAutomationPanel`「从当前账号已加入的星球中选择」316×42 · `PublishPanel` `MyPublishes` 折叠钮 322×42 · `RepoStatusBanner:85` 关闭钮 `opacity-70` | ⏸ kp-automation / market / sidebar owner，各一行 `min-h-11` / `text-muted` |
| a11y-C 顺带 | `ContainerWebPreview.tsx:1345/1403/1775` `text-white/35`（预览场景未渲染未命中） | ⏸ media owner 顺手 |
| 首屏预算 | 下次逼近 460KB 时的可拆候选：专项工具卡体 ≈18KB · `lib/taskboard.ts` ≈3.3KB · `@openclaude/protocol` + typebox ≈30KB（需改 `packages/protocol` 导出，PLAYBOOK §9 范围外）· `PermissionCard` ≈5.7KB | 登记，`shell.md` §9.4 |

### 5.3 产品口径 / 设计取舍（先问再改）

shell S-08 / S-20；tutorials TU-19（0.9s 即已读）/ TU-21（CTA 五种文案）；HUD H-19（任务集文案微调也重展开）；market K-23（与「已安装页是卸载唯一权威」既有决定冲突）；misc-p3 D-04（演示账号 handle）/ D-09（气泡任意字号，排版专项）；landing L-16 ②；settings Auto-Dream 卡片文案、`ccswitch://` 深链带密钥（协议要求）；kp-automation 表单弹层是否改贴底 Sheet（shell 统一决定）。

### 5.4 不修有判据 / 打磨

kp-automation KP-18（骨架）/ KP-19（重拉星球列表）；settings SET-32（双份轮询不会并存）；tutorials TU-20 / TU-24 余量 / TU-29；taskboard §5 暂缓 9 项（平台限制 / 他模块归属 / 非缺陷）；permission-card 内联「拒绝」无二次确认 / 「已跳过」问答不展示题目 / 待答入口条整条不可键盘聚焦（既有交互约定）；a11y 复扫剩余命中全部为禁用态控件 / 禁用输入框 placeholder / `role="img"` 示意图内文 / `sr-only` 文本（WCAG 1.4.3 例外或非问题，a11y-C §3、QA t-1232 §5.6 逐条登记）。

## 6. 决策与口径（全部有效决策 + 本轮决策卡）

| 编号 | 内容 | 影响 |
|---|---|---|
| d-24（arch） | 全部在本地克隆 + 每人独立 worktree 上做，不走 v5-dev SSH；成员只推自己分支，指挥官合入 integration；canonical 合入与发布留给有服务器通道的会话 / 用户 | 所有分支与本文 §9 的仓库布局 |
| d-26（git） | 提交 subject 禁 `fix(v5)`，改用 `feat / refactor / style / test / docs(v5)`；不碰 `changelog.json` | 全部提交 |
| d-28（ui） | UI 审计以 ui-preview 截图台为主要证据，每模块 before / after 各一套 | 全部审计 / 修复 / QA 的证据形态 |
| d-1326（release） | 用户 09-17 03:5x「目标是端到端部署上线……你全权负责」：push integration → canonical 与服务器 `deploy-v5-selfhost.sh --deploy` 两项不可逆动作由指挥官代批，成员 `request_action_approval` / `ask_decision` 由指挥官 resolve；发布通道 root@38.55.252.217（v3-dev-sg）SSH 密钥已验证；服务器 `/` 盘 94% 需先核查 | 发布线 t-1237 / t-1268 / t-1269 |
| d-1450（release） | 用户 09-17 22:5x 在线再次确认「全权负责，尽快搞完上线」；持有人离线的超时原单由指挥官改派在线成员在原 id 下交付；僵尸替身单 t-1334 不交付 | 集成④ 收尾、a11y-C / QA-a11y 接手链、本归档终稿 |
| q-786 | 归档摘要落 `docs/audit/archive/`，摘要 + 索引不复制正文，SHA 逐个核存在 | t-761 / t-632 / t-897 |
| q-979 → `fix_in_integ3` | `check:tutorials` 入口覆盖两处存量漏标（ChatHeader「导出会话」、Sidebar「清除搜索」）在集成③ 补 `data-product-control` | `c034f05d7` |
| q-988 → `accept_in_integ3` | 教程同步快照 17 + 2 漂移在集成③ accept，附抄检 / note / 清单三条要求 | 引出 q-1076 |
| q-1076 → A `demote_then_source_only`（fable-5-1-18 拍板，**代用户确认**） | composer-B 新增的「去授权」「排队发送」两处 `data-product-feature` 降级为 `data-product-control`（`29a277b25`）+ `tutorials:accept --source-only --ids <17 项>`（`b249317f4`） | **必列终审导读**（§7-1） |
| q-1227 → A（fable-5-1-18 拍板，**代用户确认**） | 集成④ 合入范围追加 tut-sync-2 / qa-gap / qa-p3 / qa-b-p3 / archive 五支；`scenes-hud.tsx` 冲突取 qa-gap；凡 a11y / 样式改动引起、入口身份无变、正文与 UI 文案抄检一致的功能源漂移统一 `--source-only` 接受（`2d2b5cafc`，`github-repository` 1 项） | **必列终审导读**（§7-1） |

## 7. 终审导读（需用户过目 / 确认）

1. **教程同步快照 accept 三笔（指挥官代用户确认，可逆）**。TU-37 修好后 `check:tutorials` 在 Windows 首次真跑到底，一次性暴露 B 阶段各模块对入口元素的 UI/UX 修改导致的功能源哈希漂移：
   - **集成③ q-988 → q-1076 → A**：17 项功能源漂移 + 2 项入口身份变化 → 两处新入口降级为控件（`29a277b25`，UI 零变化）+ `--source-only` accept（`b249317f4`，`tutorial-sync-history.jsonl` 第 67 条 note「待用户终审」）。抄检两篇教程正文引用的入口文案与 HEAD 逐条一致；唯一不一致（正文未描述这两个新入口）→ **t-1046 已补写并恢复**（`e798c3123`：agents v5 / chat-basics v9 抬版，两处 `data-product-feature` 恢复，普通 `tutorials:accept`，history 第 68 条），随集成④ `96eb0eadf` 合入，q-1076 闭环。详见 [INTEGRATION.md 集成③ §4](./INTEGRATION.md)。
   - **集成④ q-1227 → A**：合入 a11y 三支后 `check:tutorials` 再报 `github-repository` 功能源漂移 1 项——哈希覆盖 `RepoPill` / `RepoStatusBanner` / `Sidebar`，改动全部来自 a11y-mod-a `036a2f3dd` 的 opacity → 实色，无任何用户可见文案增删、入口身份不变、正文 / 媒体未动 → `--source-only` accept（`2d2b5cafc`，history 第 69 条，note 注明「由指挥官 fable-5-1-18 代用户确认，待用户终审」）。详见 [INTEGRATION.md 集成④ §4](./INTEGRATION.md)。
   - **不认可怎么退**：集成④ 一笔 `git revert 2d2b5cafc`（`check:tutorials` 重新报 github-repository 1 项，其余门不受影响）；集成③ 一笔 `git revert b249317f4 29a277b25`（合入 t-1046 后需连带 revert `e798c3123`）。
   - 提示：release-prep 试合 canonical 上游时预演分支曾需再做一次普通 accept（第 70 条，未合入）；正式 release-prep 若再出现，仍按同一口径列入发布记录。
2. **2 条基线红（与本轮改动无关，四轮集成逐条相同）**：`browser-tests/cc-switch-ascii-name.node-test.mjs` ×2（settings `ApiKeysSection` 模型 id 断言 `expected 'gemini-3.8-flash' / actual 'sonnet-5'` + 「还没有 API Key」10s 超时；基线 `210b9967` 同样红）。`ocv5-185-qa` 在工作树干净 + junction 就位时 15/15 绿（集成④ / t-1348 均绿），已不算红。是否要在本轮之外修 cc-switch 基线，请拍板。
3. **NOT RUN 汇总**：真机 iOS Safari / Android（全部模块）；读屏实机（NVDA / VoiceOver，a11y 以 CDP AX 树与 jsdom 断言替代）；真后端行为（登录 / 注册 / 支付回跳 / OAuth / 投稿 / 撤回 / WS 多标签 / 服务端版本比对 / 知识星球写接口 / 分享令牌）—— 本轮无 v5-dev 通道，全部以 api-stub 场景与单测桩覆盖；各模块 `npm test` 全量与 `test:browser` 在成员分支多为 NOT RUN（非高频面），由集成①②③④ 在 integration 统一跑（§8.1）；集成④ 之后的 a11y-C / leftover-shell / leftover-tut 全量 `npm test` NOT RUN（leftover 两支 `test:browser` 亦 NOT RUN，非高频面；a11y-C 已补跑 68/68），交集成⑤ 合并树统一跑（budget-fix 已自跑全量 302 / 4279 ✅）；慢网首开体感（t-1348 懒块）未在节流网络实测。
4. **越界改动**（均经指挥官批准并在交付单列）：t-839 改 messages 归属 `RichBlocks.tsx`（OptionsBlock 注册改 `useLayoutEffect`、聚合判定读快照）与 `MarkdownImpl.tsx`（`components` `useMemo`，根因：每次渲染新造渲染器致富块整体重挂）；t-1029 改 settings 归属 `KnowledgePlanetAutomationPanel.tsx`（忙态改按键集合）；t-865 / 集成轮的 App 接线与原语扩展（`Sheet closeButton` opt-in、`MediaTaskCenter onReusePrompt`）；t-895 附录改 shell `App.test` / `AuthGate.test` 两行选择器（L-11）；t-1232 QA 直接修 market `PublishPanel` / `PermissionCard` 各一处 className（`77a93d9e1`）；t-1233 a11y-C `12275f27a` 仅格式化自己新增的用例；t-1348 触及 messages（`chat/media.tsx` / `cards.tsx` / `MarkdownImpl.test`）、settings（`SubscriptionDialog`）、sidebar（`ProjectRow`）——改 import / 抽常量 re-export / 测试等待方式，不改业务行为。
5. **设计取舍待拍板**：shell S-08 / S-20；market K-12 二期取「换行」（非箭头）；tutorials TU-13 删 `MissionReplay` / TU-31 第 4 步改指「设定目标」已按指挥官拍板落地；TU-17 深链参数名 `view=` 改 `tab=`（与 `/board` 冲突，t-1235）；HUD H-19 保留既有交互；t-1348 选 A 方案拆动态 import 而非上调阈值；市场审核面 checkbox 16px 导致 1440 宽一行第 4 枚徽章折行（`flex-wrap` 既定行为，接受）。
6. **需后端配合项**（§5.1）本轮一律未动，请决定是否另开后端专项。
7. **发布门与发布线**：集成④ 终点 `build` 首屏 gzip 471.4KB > 460.0KB 为红（非基线），t-1348 已修到 445.5KB（阈值不动）——**集成⑤ 合入 budget-fix 后 `npm run build` 必须绿才可发布**。发布线（release-prep 合并 canonical `f1952819f` 上游 7 提交 → push canonical → 服务器 deploy）按 d-1326 / d-1450 由指挥官代批推进，不可逆动作两项（push canonical、`--deploy`）在用户授权范围内；服务器 `/` 盘 94% 需先清理（disk-prep 在跑）。终审若要在发布前叫停，请在 t-1237 集成⑤ 完成、release-deploy 开始前说。

## 8. 验证门汇总

### 8.1 集成④ 终点全量门（源码态 `2d2b5cafc`；-24 首跑 02:xx–03:xx + -52 收尾复跑 23:12–23:27 三次全量；日志 `.audit-tmp\integration\integ4-*`、`integ4-final-*`）

| 门 | 结果 |
|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ exit 0（7 步合并态 / 接线后 / 最终 / 收尾 各一次） |
| `npm run typecheck:preview` | ✅ exit 0（7 步合并态 1 红 `scenes-hud.tsx` TS2353 → qa-gap `747596782` 修正后 0） |
| `npm run check:tutorials` | ✅ OK · 26 capabilities · 12 cases · 26 media pairs（q-1227 accept 后，§7-1；accept 前两次红只报 `github-repository` 1 项） |
| `npm test`（web-react 全量 vitest） | ✅ **302 文件 / 4279 例全部通过 ×3**（723s / 901s / 683s，逐数相同）；较集成③ 298 / 4213 → +4 文件（`KnowledgePlanetAutomationPanel.test` / `optionsGroup.test` / `demo.test` / `ui/a11y.test`）、+66 例 |
| `npm run test:browser` | `run.mjs` **T1–T68 全部 ok**（清单 68 条全部执行，含 hud T61 / media T30 / tutorials T38）；`node --test` 16 文件 87 例 **85 通过 / 2 失败** = `cc-switch-ascii-name` ×2 基线（§7-2）；`ocv5-185-qa` 15/15 ✅ |
| ui-preview 全量截图 | ✅ **301 场景 / 1026 张，failures 0 / retried 0**（集成③ 257 / 854 → +44 场景 = hud 10 + kp-automation 14 + misc-p3 7 + permission-card 13）；`unmockedApi` 仍为 `listCronChannels` / `listProjectAssets` 2 个（已返回默认值）；收尾抽样 Read 14 张无破版无溢出，唯一肉眼残留 `misc-options-partial--mobile--dark` 勾标白字（a11y-C 已修） |
| a11y 复扫（`scan.mjs` 301 场景 vs t-893 集成③ 态 257 场景） | ✅ 0 渲染失败；共同 257 场景九项指标**只降不升**：浅色对比度 356 → 44、深色 111 → 69、触控 <44 493 → 163、无名控件 16 → 11、CDP AX 3 → 1、misc 226 → 221，**逐场景回归 0**；t-762 九条 P2：8 条清零，`shell#1` 深色白字残留 4（a11y-C 已修，待集成⑤）；44 个新场景自有命中均为成员文档已登记自标项（禁用态 / 历史结清卡只读区 / 选项勾标），无新类型；`targets44` 新 3 组 = market「查看」38×44（QA t-1232 `77a93d9e1` 已补宽） |
| `npm run build`（首屏 gzip 预算） | ❌ **红，非基线**：`tsc -b` 绿 → `vite build` 5103 modules → `first-screen-budget` 拦下 15 chunk **471.4KB > 460.0KB**（main 139.4 / tapePayload 125.5 / styles 75.1 / react-vendor 55.3 / radix 29.9 …）→ **t-1348 `77e1f35dc` 修后 445.5KB exit 0**（`wt\budget-fix` 自证 + 全量 302 / 4279），待集成⑤ 合入后在 integration 复跑转绿（发布门） |
| `biome lint`（集成④ 自有提交触碰文件） | `App.tsx` 14 = 基线 14（`useExhaustiveDependencies`），`scenes-hud.tsx` 0 → 新增 0；各成员分支 biome 对照均报新增 0 |

历史：集成③ 终点（`b249317f4`）typecheck / preview / `check:tutorials` ✅、`npm test` 298 / 4213 ×2、`run.mjs` 68 + `node --test` 70/73、截图 257 / 854 failures 0；集成② 227 / 734；集成① 118 / 350（各轮 INTEGRATION §5）。

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
| kp-automation t-838 | ✅ | ✅ 22 文件 270 例（settings + manage 目录） | NOT RUN（非高频面） | ✅ 56 / 56 | 全量（集成④ ✅） |
| misc-p3 t-839 | ✅ | ✅ 7 文件 270 例 + App.test | ✅ 两轮 68 全过 | ✅ 24 / 24 + messages 三场景对照 | 全量（集成④ ✅） |
| permission-card t-875 | ✅ | ✅ 70 例 | ✅（详见正文） | ✅ 13 场景 before / after-2 | 全量（集成④ ✅ 302 / 4279） |
| a11y-shell t-893 | ✅ | ✅ 全量 299 文件 / 4220 例 | ✅ | ✅ 257 场景 854 张 failures 0 + CDP 复扫 | 读屏实机 |
| a11y-mod-a t-894 | ✅ | ✅ | ✅ | ✅ 28 场景 各 90 张 + CDP 复扫 40 场景 | 读屏实机 |
| a11y-mod-b t-895 | ✅ | ✅ | ✅ | ✅ before / after 量化 | 读屏实机 |
| QA t-1028（integration `c034f05d7`） | ✅ + `typecheck:preview` | ✅ 四模块单测 | ✅（基线红同 §7-2） | ✅ 126 张 | — |
| QA t-1038（integration `c034f05d7`） | ✅ + `typecheck:preview` | ✅ 三模块单测 | ✅ | ✅ 258 张 | — |
| QA t-1029（integration `c034f05d7` + 三专项） | ✅ + `typecheck:preview` ✅（修后） | ✅ HUD 55 / KP 70 / misc 167(+150) / t-865 115 | ✅ 68/68；`node --test` 70/73 | ✅ 120 张 failures 0 | 全量交集成④（✅） |
| QA t-1232（integration `b23955208`） | ✅ + `typecheck:preview` ✅ | ✅ 全量 302/302 文件（`MessageRenderer.test` 单跑 152/152）+ 修复两文件 88/88 | ✅ 68/68；`node --test` 70/73 | ✅ 74 张 + CDP 复扫 301 场景回归 0 | 读屏实机 |
| a11y-C t-1233 | ✅（三手） | ✅ 8 文件 121 例（三手） | ✅ `run.mjs` 68/68；`node --test` 70/73（3 基线，第五手补跑） | ✅ 60 对 + CDP 复扫 288 场景 ×3 轮 | **全量 `npm test`（交集成⑤）**、真机、读屏 |
| leftover-shell t-1234 | ✅ + `typecheck:preview` ✅ | ✅ 6 文件 92 例 + `App.test` 48/48 | NOT RUN（非高频面；CDP AX 脚本替代） | ✅ 22 / 30 张 | 全量（交集成⑤）、真机、真实 `?demo=1` 整页 |
| leftover-tut t-1235 | ✅ + `typecheck:preview` ✅ + `check:tutorials` ✅ | ✅ 11 文件 132 例 | NOT RUN（非高频面） | ✅ 108 / 108 张 | 全量（交集成⑤）、真机 |
| budget-fix t-1348 | ✅ + **`build` ✅ 445.5KB** | ✅ 15 文件 303 例 + **全量 302 / 4279** | ✅ 68/68；`ocv5-185` 15/15 | NOT RUN（零视觉改动） | 慢网首开体感 |

## 9. 分支 / 提交总表

| 分支 | HEAD（本地 = 远端，09-18 00:3x `git ls-remote` 核对） | 用途 / 状态 |
|---|---|---|
| `feat/v5-selfhost`（canonical） | `f1952819f`（基线 `210b9967` 之后上游 7 提交，本轮未推进；release-prep 试合以此为准） | 基线 / 发布目标 |
| `feat/v5-selfhost-ocv5-audit-ux` | **`c97a750f8`** | integration（集成①②③④）；集成⑤ 待做 |
| `feat/v5-selfhost-audit-shell` | `39697560b` | 模块（集成① 起点已含） |
| `feat/v5-selfhost-audit-messages` | `2abe389a9` | 模块（集成①③） |
| `feat/v5-selfhost-audit-composer` | `70d3db8b3` | 模块（集成②） |
| `feat/v5-selfhost-audit-sidebar` | `25c775295` | 模块（集成①②） |
| `feat/v5-selfhost-audit-manage` | `6fae01440` | 模块（集成①③） |
| `feat/v5-selfhost-audit-settings` | `5eac1b807` | 模块（集成②③） |
| `feat/v5-selfhost-audit-taskboard` | `05dd185df` | 模块（集成①③） |
| `feat/v5-selfhost-audit-tools` | `d65c6741e` | 模块（集成②） |
| `feat/v5-selfhost-audit-market` | `5391c150a` | 模块（集成②③） |
| `feat/v5-selfhost-audit-landing` | `b97adb3fb` | 模块（集成②） |
| `feat/v5-selfhost-audit-media` | `8834aca08` | 模块（集成②） |
| `feat/v5-selfhost-audit-tutorials` | `02c358655`（A+B，集成③ `ce767d8ce`） | 模块 |
| `feat/v5-selfhost-audit-tut-sync-2` | `67b1494ea`（t-1046，集成④ `96eb0eadf`） | tutorials 正文补写 |
| `feat/v5-selfhost-audit-hud` | `b1f06f8f5` | 专项（集成④ `2c1d659d2`） |
| `feat/v5-selfhost-audit-kp-automation` | `b0fd16dad` | 专项（集成④ `d83d4a368`） |
| `feat/v5-selfhost-audit-misc-p3` | `c834dffa1` | 专项（集成④ `bf940d804`） |
| `feat/v5-selfhost-audit-permission-card` | `8a3179896` | 专项（集成④ `015522b66`） |
| `feat/v5-selfhost-audit-a11y-shell` / `-a11y-mod-a` / `-a11y-mod-b` | `4930707cc` / `475e3e6c7` / `9710a3b24` | a11y（集成④ `15f816145` / `68f031ba6` / `80e757d95`） |
| `feat/v5-selfhost-audit-qa-p3` / `-qa-b-p3` / `-qa-gap` | `3e640a85d` / `0ac949b2e` / `c1734aac6` | QA（集成④ `4f93f6990` / `f605df89f` / `902ade6e8`） |
| `feat/v5-selfhost-audit-archive-prep` | `591c4cb70` | 归档摘要 t-761（已合入 archive 分支 `ac0db7c35`） |
| `feat/v5-selfhost-audit-archive` | `35e3ec7c9`（`a38a093bf` 集成④ `b23955208`；+1 已带入本分支） | SUMMARY 初稿 + archive/ 预写（t-632 / t-897 预写） |
| `feat/v5-selfhost-audit-qa-a11y` | `eed1f3989` | QA t-1232，**待集成⑤** |
| `feat/v5-selfhost-audit-a11y-c` | `c35fd00c6` | a11y-C t-1233（含 t-1344 复核），**待集成⑤** |
| `feat/v5-selfhost-audit-leftover-shell` | `7e7c7e43b` | t-1234，**待集成⑤** |
| `feat/v5-selfhost-audit-leftover-tut` | `69e18aa93` | t-1235，**待集成⑤** |
| `feat/v5-selfhost-audit-budget-fix` | `65019b5dc` | t-1348，**待集成⑤**（发布门） |
| `feat/v5-selfhost-audit-archive-final`（本分支） | 基于 `c97a750f8` + 合并 `35e3ec7c9`（`e01791796`）+ 本轮 docs 提交（见 complete_task 交付） | 归档终稿 t-897，**待集成⑤**（纯文档） |
| `feat/v5-selfhost-audit-integ4-rehearsal` / `-release-rehearsal` | `522c24988` / `c1fdc935e`（未推） | 预演，**不合入** |

集成合并提交一览：集成① `3cff04c85` `09a13a472` `bf8188def` `985b3ae57`（记录 `43b7cd3a4`）；集成② `5e5ed6925` `6fa690d7e` `ab765669a` `6201518b2` `10398baa9` `b41e804ac` `ae0b0cb64`（接线 `19799c0fe` · 用例 `f7c08f3eb` · `.gitattributes` `419e0d218` · `2a6492774` · 记录 `1d8eaf769` / `2b23a31a7` · 集成待办 t-865 `e0f53688a` `d4b061e37` `a3af53970` `bae5a8673` `7d5573a92` 记录 `1e4328ac9`）；集成③ `12fc17579` `cd58600e8` `425655631` `c761bbd93` `be20adaec` `ce767d8ce`（接线 `bdf7b4d15` · q-979 `c034f05d7` · q-1076 `29a277b25` `b249317f4` · 记录 `36bb9a677`）；**集成④ `2c1d659d2` `d83d4a368` `bf940d804` `015522b66` `15f816145` `68f031ba6` `80e757d95` `96eb0eadf` `902ade6e8` `4f93f6990` `f605df89f` `b23955208`（test `d2afaaa20` · 接线 `4a2745283` · q-1227 accept `2d2b5cafc` · 记录 `c97a750f8`）**。

## 10. 评审入口

- 仓库：`https://github.com/dream-star-end/smart-assistant`，分支同名（§9）；本地主克隆 `d:\code\test_project\test123\v5-selfhost`（当前检出 integration `c97a750f8`），工作树 `d:\code\test_project\test123\wt\<slug>`。
- 文档（integration `c97a750f8` 上均可读，除标「分支」者）：本文 → [archive/README.md](./archive/README.md)（12 模块 + 专项 / QA / 遗留清扫索引、集成①–④ 合入记录、集成⑤ 待合清单）→ `archive/<slug>.md`（归档摘要，新增 [archive/leftover.md](./archive/leftover.md)）→ `<slug>.md`（正文）；专项与 QA 正文 [hud.md](./hud.md) / [kp-automation.md](./kp-automation.md) / [misc-p3.md](./misc-p3.md) / [permission-card.md](./permission-card.md) / [a11y-shell.md](./a11y-shell.md) / [a11y-mod-a.md](./a11y-mod-a.md) / [a11y-mod-b.md](./a11y-mod-b.md) / `qa/QA-p3-tail.md` / `qa/QA-b-p3.md` / `qa/qa-gap.md`；集成记录 [INTEGRATION.md](./INTEGRATION.md)（集成①–④）；待集成⑤ 分支上的正文：`qa/QA-a11y.md`（qa-a11y）、`a11y-c.md`（a11y-c）、`leftover-shell.md`（leftover-shell）、`tutorials.md` §10（leftover-tut）、`shell.md` §9（budget-fix）。
- 截图（仓外，不入库）：`D:\code\test_project\test123\.audit-tmp\<slug>\{before,after}\`；集成③ 全量 854 张 `.audit-tmp\integration\shots-integ3\`；**集成④ 全量 1026 张 `.audit-tmp\integration\shots-integ4\`**；QA `.audit-tmp\qa-p3\shots\`（126）/ `qa-b-p3\integ\`（258）/ `qa-gap\shots\`（120）/ `qa-a11y\shots\`（74）；a11y 走查 `.audit-tmp\a11y\`，集成④ 复扫 `.audit-tmp\integration\a11y-integ4\`，a11y-C `.audit-tmp\a11y-c\{before,after,scan-*,finish-scan}`；leftover-shell `.audit-tmp\leftover-shell\`（含 CDP AX 脚本 `ax-checkbox.mjs`）；leftover-tut `.audit-tmp\leftover-tut\`；budget-fix 归因脚本 `.audit-tmp\budget-fix\attribute-first-screen.mjs`。
- 日志（仓外）：`.audit-tmp\integration\integ4-*.log`、`integ4-final-gates.summary.txt`；各模块 / QA / 专项 `.audit-tmp\<slug>\*.log`。
- 作业口径：`d:\code\test_project\test123\TEAM_PLAYBOOK.md`（仓外）；决策 d-24 / d-26 / d-28 / d-1326 / d-1450；决策卡 q-786 / q-979 / q-988 / q-1076 / q-1227（§6）。

## 11. 终稿口径与本次更新说明（t-897）

- 基点：integration `c97a750f8`（集成④ 终点）开 worktree `wt\archive-final`，分支 `feat/v5-selfhost-audit-archive-final`，先 `--no-ff` 合入归档分支 `archive@35e3ec7c9`（`e01791796`，集成④ 未带上的 1 个初稿同步提交），再在其上更新。
- 更新范围（纯文档，只动 `docs/audit/SUMMARY.md` 与 `docs/audit/archive/`）：初稿里全部「等集成④ 再填」的标记行与 `archive/` 的占位行逐处换成集成④ 事实（合并提交、接线、全量门、截图 / a11y 复扫、q-1227）；按 t-1232 / t-1233 / t-1234 / t-1235 / t-1348 五条交付更新 §1 / §3 / §3.1 / §4.2 / §5 / §7 / §8.2 / §9，`archive/a11y.md` 增 §6 a11y-C / §7 QA、`archive/qa.md` 增 §4 t-1232、新增 `archive/leftover.md`、`archive/README.md` 增专项 / 待合清单 / 集成④ 行；12 模块摘要里的「待集成③」等过期状态与 K-27 / TU-17 / TU-34 / L-11 / M-23 / M-27 / C-32 / 备案判据行改为落地事实。
- 信息源：`INTEGRATION.md` 集成④ 全部小节；`qa/QA-a11y.md`、`a11y-c.md`、`leftover-shell.md`、`tutorials.md` §10、`shell.md` §9（各自分支 `git show`）；任务库账本（09-18 00:20）；`git log / diff / ls-remote / rev-list` 现算。统计排除作废条 t-837（正文见 `archive/permission-card.md` 文首）。
- 核对：本文与 `archive/*.md` 引用的全部短 SHA 逐个 `git cat-file -e <sha>^{commit}`（结果见 complete_task 交付）；初稿用过的占位词（「等集成④」标记、「等终稿」占位）在 `SUMMARY.md` + `archive/` 全文检索为 0 命中；集成⑤ 及之后的状态一律写成「待集成⑤ / 待领 / 在跑」的事实描述。
- 集成⑤ 完成后若要再出一版：只需把 §1 集成状态、§3.1 / §4.2 的「待集成⑤」改成合并提交、§8.1 换成集成⑤ 终点全量门（`build` 必须绿）、§9 integration HEAD；数字口径不变。
