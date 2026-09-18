# v5 个人版审计 · 总览（SUMMARY · 终稿，t-897）

> 给用户终审的**唯一入口**：总览 → 方法 → 按模块一节（含集成④ 后新交付、预演与发布前置）→ 集成④ 合入记录、集成⑤ 合入状态与集成⑤ / 发布线预留章节 → 遗留清单 → 决策与口径 → 终审导读 → 验证门 → 分支 / 提交总表 → 评审入口 → 终稿口径。30 分钟版终审导读单页见 [`FINAL-REVIEW.md`](./FINAL-REVIEW.md)。每个数字都能在各模块正文 `docs/audit/<slug>.md`、归档摘要 `docs/audit/archive/<slug>.md`、`docs/audit/INTEGRATION.md` 或 `docs/audit/RELEASE.md` 找到出处；每个 SHA 都可 `git cat-file -e` 核实（t-632 初稿与 t-897 各阶段逐个核过）。
> 只汇总不复制正文（q-786 口径）；未跑的验证一律标 **NOT RUN**。
> 版本：**终稿 · 阶段①草稿（2026-09-18 21:xx）**，分支 `feat/v5-selfhost-audit-archive-final`：基于 integration `c97a750f8`（集成④ 终点，09-17 23:28 已 push；源码态 `2d2b5cafc`）+ 归档分支 `archive@35e3ec7c9` 的初稿同步提交 + **对齐合并 integration `aeae1d72e`**（09-18 02:2x 已 push；含集成⑤ 8 步合并、canonical `f1952819f` 合入与 `RELEASE.md` v2.2）。集成⑤（t-1237）/ 发布准备（t-1268）/ 发布执行（t-1269）三条**在任务库尚未验收闭合**（09-18 20:49 账本：integ5 在跑、release-prep / release-deploy 阻塞、集成⑤ 全量门下半场 integ5-gate2 阻塞），本文对它们只登记 `git` 可核的事实并预留章节（§4.3–§4.5，TODO 字段留阶段②）；各模块表里的「待集成⑤」保留为**任务口径**——其合并提交已在 integration（§4.2 / §4.3），阶段② 定稿时统一翻转。

## 1. 总览

| 项 | 内容 |
|---|---|
| 目标 | 对 v5 个人版（selfhost，`packages/web-react` 用户端）全部页面 / 模块做 UI/UX、功能正确性、交互友好性审计，审出的问题直接改代码落地（P1 / P2 必修，P3 量力而行并登记遗留），指挥官验收、合入 integration 后统一归档给用户终审；用户 09-17 授权后目标延伸为经集成⑤ 全量门 → 合并 canonical 上游 → push 回 canonical → 服务器 v3-dev-sg 端到端上线（d-1326 / d-1450，发布线不在本归档范围） |
| 时间跨度 | 2026-09-15（基线 `210b9967`、决策 d-24/26/28）→ 2026-09-17 23:28（集成④ 终点 `c97a750f8` 推送）→ 2026-09-18 01:45–02:2x（集成⑤ 8 步合并 + canonical `f1952819f` 合入，integration `aeae1d72e` 推送）；本文现算截至 2026-09-18 21:xx（阶段①） |
| 任务数 | 协同组任务库 **75 条**（09-18 20:49 宿主现算：已完成 69 · 在跑 2 · 阻塞 4 · 待领 0；作废条 t-837 不计入统计）。本归档覆盖其中审计线：集成③ 前 **54 条**（A 审计 12 · B 修复 12 · 二期 / 补丁 6 · 覆盖复查与补审专项 · a11y 专项 · QA 复核 3 · 集成 4 · 归档 3）+ 集成③ 后用户授权 **6 条**（t-1232 QA·复核 a11y-B×3 + PermissionCard ✅ · t-1233 a11y-C 同源项清扫 ✅（四手收尾，t-1344 独立复核 ✅）· t-1234 遗留清扫 shell / market / settings / App ✅ · t-1235 遗留清扫 tutorials ✅ · t-1236 QA·集成④ 独立复核 ✅（分工单 t-1512 → t-1567 三道门、t-1524 截图 + 状态单 ✅）· t-1237 集成⑤ **未闭合**）+ 发布阻断 **t-1348** 首屏预算修复 ✅ + 集成⑤阻断 **t-1575** 首屏回归修复 ✅ + 预演三条（t-1279 发布预演 ✅ · t-1503 集成⑤预演 ✅ · t-1598 发布准备预演 ✅）+ 发布前置 **t-1455** 磁盘清理 ✅（§3.2）；集成④ 收尾单 t-1334 计入集成④。发布线 t-1268 / t-1269 与 disk-prep 在跑 / 阻塞，预留 §4.4 / §4.5；持有人离线后的收尾 / 替身单不单列（数量以任务库为准） |
| 12 模块审出 | **359 条**（P1 8 · P2 108 · P3 243），P1 8/8 全部关闭；补审专项另审出 HUD 20 · 知识星球 19 · 杂项 P3 18 · PermissionCard 17 · a11y 走查归属三条修复单 35（11 + 14 + 10）→ a11y-C 承接同源项清单 13；QA 五轮核对 37 / 84 / 61 / 58 项 + 集成④ 终点独立复核，累计 ❌ 3（t-1038 1 处勘误 + 移交后由 t-895 落地、t-1029 2 处 QA 直接修），新增阻断 0 |
| 合入量 | **37 个 `--no-ff` 合并提交**：集成① 4 条 123 files +13,855/−2,401 · 集成② 7 条 153 files +15,336/−2,295 · 集成③ 6 条 54 files +3,854/−1,211 · 集成④ 12 条 125 files +7,783/−654（前四轮合计 455 files，+40,828 / −6,561，跨轮同文件重复计）· **集成⑤ 8 条 `git diff --shortstat c97a750f8..` 64 files +2,269/−292（含 accept，按合并树差量计，与前四轮逐条累加口径不同）**；不含集成① 起点已含的 shell-B、各轮自有接线 / 用例 / 记录提交、集成待办 t-865。另 release-prep 合入 canonical `f1952819f` 上游 7 提交（`57ad2c823`），属上游内容不计入审计合入量 |
| 集成状态 | 集成④ 终点 **24 条成员分支「未合入提交 = 0」**（QA t-1236 两次独立复算 24/24）；**集成⑤ 8 步合并已在 integration**（`ec09ed419` … `936d44e85`，源码态 `91358ce54`，记录 `9103ce7b4`），8 条 `rev-list --count` 均 0，远端 = 本地；随后 release-prep `57ad2c823`（canonical `f1952819f`）+ R2 `04ba13b2e` + RELEASE.md v2.2 `aeae1d72e` = integration 现 HEAD。**任务库口径**：t-1237 / t-1268 / t-1269 未验收闭合；集成⑤ 全量门下半场（ui-preview 全量截图 + a11y 复扫）未跑（integ5-gate2 阻塞）；canonical `--ff-only` / push 未做，且远端 canonical 09-18 又前进 1 提交到 **`97f128d2b`**（integration 未含，release-prep 需重核，§4.4）；本分支 archive-final（纯文档）待合入；4 条预演分支不合入（§4.2） |
| 结果一句话 | 主流程无阻断项残留；P2 按各模块正文声明全部落地（shell 2 条设计取舍暂缓等用户拍板）；P3 以「本模块内可独立完成即做」为口径，未做的逐条有归属与理由（§5），其中集成③ 登记的跨模块遗留（H-18 / K-27 Checkbox / D-02·D-08 / TU-17·TU-34 / 备案判据 / a11y 同源项）已在集成④ 接线与 t-1233 ~ t-1235 全部落地并随集成⑤ 进入 integration；集成④ 终点全量门 typecheck / preview / `check:tutorials` / `npm test` 302 文件 4279 例 / `run.mjs` 68 / 截图 1026 张 / a11y 复扫 全绿，唯一红 `build` 首屏 gzip 471.4KB > 460.0KB **已由 t-1348 + t-1575 在集成⑤ 源码态 `91358ce54` 转绿 447.8KB（余量 12.2KB），合 canonical 后 `04ba13b2e` 448.3KB（余量 11.7KB）**；集成⑤ 全量门上半场（typecheck / preview / tutorials / build / `npm test` 305 文件 4306 例 / `run.mjs` 68 / biome）全绿，下半场截图 + a11y 复扫待跑（§4.3 / §8.1b） |

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

计数口径：「审出」= 阶段 A 清单（P1 · P2 · P3）；「修复 / 部分 / 遗留」= 各正文修复记录与遗留章节（✅ / ◐ / 仍开放的本模块归属项）；「QA 复核」= t-1028（二期 P3，`qa/QA-p3-tail.md`）/ t-1038（B 轮 P3，`qa/QA-b-p3.md`）/ t-1029（缺口补审，`qa/qa-gap.md`）/ t-1232（a11y-B×3 + PermissionCard，`qa/QA-a11y.md`）/ t-1236（集成④ 终点，`qa/qa-integ4.md`）的结论，前三份随集成④ 合入，后两份随集成⑤ 合入。**状态列的「待集成⑤」= 任务口径**（t-1237 未验收闭合）：对应分支已由集成⑤ 8 步 `--no-ff` 合入 integration，合并提交见 §4.2 / §4.3，阶段② 定稿时统一翻转。数字抽查：shell / tools / media / market / taskboard / settings 六份正文结论行与本表一致（t-632）；终稿另抽 hud / permission-card / tutorials §10 / leftover-shell 四份与 §3 / §3.1 一致。

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

### 3.1 集成④ 之后新交付（用户 09-17 授权 · 均已验收 · 已由集成⑤ 8 步合入 integration，t-1237 任务未闭合）

| 任务 | 内容 | 审出 / 处置 | 验证摘要 | 分支 @ HEAD（集成⑤ 合并提交） | 摘要 / 正文 |
|---|---|---|---|---|---|
| t-1232 QA·复核 a11y-B×3 + PermissionCard | 第四轮 QA（fable-5-1-23 起稿 → fable-5-1-35 接手独立重做） | 核对 58 项：✅ 57 / ◐ 1 / ❌ 0，四条**全部通过**；QA 直接修 2 处（`77a93d9e1`：`PublishPanel`「查看 / 收起」`min-w-11`、`PermissionCard` summary `py-3.5`，修前红修后绿） | typecheck / preview ✅；全量 `npm test` 302/302 文件（`MessageRenderer.test` 冷启超时单跑 152/152）；`run.mjs` 68/68；截图 20 场景 74 张 0 失败；CDP 复扫 301 场景，共同 257 场景回归 0；`merge-tree` 试合无冲突 | `feat/v5-selfhost-audit-qa-a11y@eed1f3989`（+2；集成⑤ 2/8 `c701daac9`） | [archive/qa.md](./archive/qa.md) §4 · [qa/QA-a11y.md](./qa/QA-a11y.md) |
| t-1233 a11y-C 跨模块同源项清扫 | a11y-shell §5 清单 13 项 + 复扫补修 2（fable-5-1-38 代码 → fable-5-1-55 收尾复核 → 指挥官 fable-5-1-50 成文 push `361f59b1f` → fable-5-1-3 第四手独立复核 t-1344 `ea9348b2b` → fable-5-1-5 补 `test:browser` 门 + 遗留登记 `c35fd00c6`，t-1233 交付） | 已修 7 项 / 9 处 className（`b591e64b6` `59e66773f` `00b86b565` `5533e0503` `abb246fdb` `faa6e8b26`）+ 补修 2（`c0c9059a1`）；同批闭环 5；不修 1（WCAG 例外）；用例格式化 `12275f27a`；16 文件仅 className（11 处 + 4 行注释）+ 用例断言；收尾补记 `TutorialCenter.tsx:387` 同根因白图标（tutorials 归属，一行改法登记 §5.2） | typecheck ✅；8 用例文件 121 例 ✅（三手复现）；biome 新增 0（两手按「文件 × 规则」比对 37 = 37）；CDP 复扫 288 场景三轮：白字压 accent / danger 4 → **0**，cL 49→47 / cD 77→70，逐场景上升 0（第四手 `tutorials-help-menu-open` tabBad 1→2 为 Radix 护栏 span 计数抖动，非回归）；截图 60 对尺寸相同；**`test:browser` `run.mjs` 68/68 + `node --test` 70/73（3 基线）**；**NOT RUN 全量 `npm test`**（交集成⑤） | `feat/v5-selfhost-audit-a11y-c@c35fd00c6`（+18 = 11 自有 + 7 对齐合并；远端 = 本地；集成⑤ 6/8 `ecf912b88`，唯一冲突 `RichBlocks.test.tsx` 两条用例全保留） | [archive/a11y.md](./archive/a11y.md) §6 · [a11y-c.md](./a11y-c.md) |
| t-1234 遗留清扫 shell / market / settings / App | K-27 `ui/Checkbox` 原语 + market 四处接入；settings 备案判据改引 `filedIcp()`；misc-p3 D-02 用例 / D-08 `ChatInteraction.reason`（前任 5 提交 → fable-5-1-52 复核成文） | 4/4 落地；不加依赖、既有原语零改动、`App.tsx` 只动 D-08 一处 | typecheck / preview ✅；相关 6 文件 92 例 + `App.test` 48/48 ✅；biome 新增 0；CDP AX 28 checkbox 全部有名、mixed 正确、移动端 label 44px；截图 before 22 / after 30 张 0 失败；**NOT RUN** 全量 / `test:browser`（非高频面） | `feat/v5-selfhost-audit-leftover-shell@7e7c7e43b`（+6；集成⑤ 3/8 `7cae5427f`） | [archive/leftover.md](./archive/leftover.md) §1 · [leftover-shell.md](./leftover-shell.md) |
| t-1235 遗留清扫 tutorials TU-17 / TU-34 | 深链 `?panel=help&tab= / work= / topic=&step=` 进 URL 可反灌（`view=` 改 `tab=` 避开 `/board`）；模块级 hero token `heroTheme.ts` 替 12 处写死色值 | 2/2 落地；`check:tutorials` 无漂移不需 accept | typecheck / preview ✅；11 文件 132 例 ✅（+6）；biome 新增 0；截图 27 场景 before / after 各 108 张 0 失败；**NOT RUN** 全量 / `test:browser` | `feat/v5-selfhost-audit-leftover-tut@69e18aa93`（+3；集成⑤ 4/8 `c4a516697`） | [archive/leftover.md](./archive/leftover.md) §2 · [tutorials.md](./tutorials.md) §10 |
| t-1348 发布阻断·首屏 gzip 预算超限修复 | 集成④ `build` 红 471.4KB > 460.0KB → 8 处「点开才需要」的覆盖层 `React.lazy` / 常量下沉（首屏可见组件不 lazy），阈值不动 | 修后 **445.5KB**，`npm run build` exit 0，净减 25.9KB；越界触及 messages / settings / sidebar 三处机械改动已单列 | `build` ✅；typecheck ✅；15 文件 303 例 ✅；**全量 `npm test` 302 / 4279 ✅**；`run.mjs` 68/68 + `ocv5-185` 15/15；biome 新增 0；**NOT RUN** 截图（零视觉改动）、慢网首开体感 | `feat/v5-selfhost-audit-budget-fix@65019b5dc`（+2；集成⑤ 1/8 `ec09ed419`） | [archive/leftover.md](./archive/leftover.md) §3 · [shell.md](./shell.md) §9 |
| t-1575 集成⑤阻断·leftover-tut 深链把教程案例数据拖进首屏 | 集成⑤预演树 `b6b78e876` `build` ❌ 475.2KB；指挥官逐合并点二分归因到 leftover-tut `3fee24a58`：`useAppRoute.ts` 静态 `import SIGNATURE_WORKS` 把 `tutorialSignatureWorks → tutorialCaseCatalog` 拖进入口闭包（`useAppRoute` chunk 1.7 → 30.7KB）；QA t-1236 同登记为 B-2 集成⑤ 必修 | 1/1：新增零依赖 `lib/tutorialSignatureWorkIds.ts`（id 表 + 类型），`useAppRoute` 改引它，`SignatureWork.id` 反向受类型约束，`tutorialSignatureWorkIds.test.ts` 断言两表集合相等；4 files +50/−5，`useAppRoute` 2.0KB | 集成⑤ 第 5 步紧跟合入后 integration `build` ✅ **447.8KB / 余量 12.2KB**（INTEGRATION 集成⑤ §3 / §5）；新增用例计入集成⑤ vitest 305 / 4306；**NOT RUN**（归档作者）分支自跑门日志未单列 | `feat/v5-selfhost-audit-leftover-tut-budget@a947662bb`（+1；集成⑤ 5/8 `10e1348fb`） | [archive/leftover.md](./archive/leftover.md) §4 · [INTEGRATION.md](./INTEGRATION.md) 集成⑤ §3 |
| t-1236 QA·集成④ 最终 HEAD `c97a750f8` 独立复核（分工：三道门实跑 fable-5-1-3 t-1567 代 t-1512 · 截图抽样 + §8 状态单 fable-5-1-3 t-1524 · 二次复算 / 登记核对 / 合成关单 fable-5-1-6） | 对 INTEGRATION 集成④ §5 / §7 / §8 逐项独立核；报告 §0 如实点出「任务书要求 QA 本人跑三道门，实际按指挥官安排分工、各自留日志」 | 三道门 + 三附加门与集成④ 登记**逐条一致，新增红 0**（唯二红 = `cc-switch-ascii-name` ×2 基线；`build` ❌ 471.4KB 已知红数值相同）；§8 状态单 **24/24** 无漂移（两次独立计算）；截图 13 场景 52 张**新增阻断 0**（K-1…K-5 = a11y-c / qa-a11y / leftover-shell 已修待合，O-5 为场景构造问题）；source-only 登记 67 / 68 / 69 与 history 一致、入口身份变化 0；**P1 0 / P2 0 / P3 8**（5 已修待合 + O-1 / O-2 / O-3 观感登记）+ 工具项 2 + 已知 2（B-1 budget-fix、**B-2 → t-1575**）；QA 直接修 0。**结论：可进集成⑤，阻断 0；必带 budget-fix + t-1575** | typecheck ✅ · `typecheck:preview` ✅ · `check:tutorials` ✅ 26 / 12 / 26 · vitest **302 文件 / 4279 例 / 0 失败**（`--maxWorkers=2` 376s，无 timeout）· `run.mjs` 68 全过 + `node --test` 87 例 85 / 2 · `build` ❌ 471.4KB（R1）；主克隆只读 `git status` 前后逐字一致；日志 `.audit-tmp\qa-integ4\t1567-*.log`、截图 `shots\` 52 张 + `manifest` failures 0 | `feat/v5-selfhost-audit-qa-integ4@31a8a92d6`（+1，纯文档；集成⑤ 8/8 `936d44e85`） | [archive/qa.md](./archive/qa.md) §5 · [qa/qa-integ4.md](./qa/qa-integ4.md) |
| t-1237 集成⑤ | 8 步 `--no-ff` 合入上表 6 支 + t-1575 + qa-integ4，source-only accept `91358ce54`，记录 `9103ce7b4`，已推 integration（指挥官 fable-5-1-4 代执行 01:45–02:15） | **任务未验收闭合**：账本在跑（fable-5-1-35 接手），全量门下半场 integ5-gate2 阻塞 | 上半场全绿（build 447.8KB · vitest 305 / 4306 · `run.mjs` 68 · biome 新增 0）；下半场截图 + a11y 复扫**未跑** | integration `9103ce7b4`（源码态 `91358ce54`） | **§4.3 预留** · [archive/release.md](./archive/release.md) §5 · [INTEGRATION.md](./INTEGRATION.md) 集成⑤ |

### 3.2 预演与发布前置（已完成 · 结论以文档带入，预演分支不合入）

| 任务 | 内容 | 结论 | 验证摘要 | 分支 @ HEAD | 摘要 / 正文 |
|---|---|---|---|---|---|
| t-1279 发布预演 + 运行手册（fable-5-1-34 初稿 → fable-5-1-4 v2 / v2.1） | canonical `3b7c38b9d` → `f1952819f` 试合 integration 集成④ 源码态；服务器只读实测；RELEASE.md §0–§6 + 附录 | **7 处冲突**（4 源码 + 3 `tutorial-sync*`）解法 `d02cc7c5d`；R2 canonical 8 处旧测试文案漂移 `c1fdc935e`；R0 canonical `f1952819f` 带迁移 0281（破坏性 DDL）→ v2.1 实测 live 已是 `f1952819f`、0281 已 apply → **`HAS_MIGRATION=0` 不需放行开关**；R3 canonical 侧 incident-regressions FAIL 不阻断 selfhost；磁盘 87% 余 26.6 GiB 门过；无 open train | v2 全门（typecheck / preview / tutorials / `lint:migration-order` 283 支 · 161 条 / `test:protocol` 14/14 / vitest 9 文件 295 例 / build ✅ 447.3KB 余量 12.7KB / trailer PASS）；无 budget-fix 对照 ❌ 471.9KB；`cursorCliWrapper.test` 55/57 Windows 假阳性；**NOT RUN** `test:browser`、commercial integ（需 PG） | `feat/v5-selfhost-audit-release-rehearsal@a4452c7b6`（初稿 `c1fdc935e`；不合入，手册由 t-1268 带入） | [archive/release.md](./archive/release.md) §1 · [RELEASE.md](./RELEASE.md) |
| t-1503 集成⑤预演（fable-5-1-2） | 从 `c97a750f8` 以 `rehearsal:` 合并试合 6 条待合分支 | 合并顺序与唯一冲突（`RichBlocks.test.tsx` 两条用例全保留）被集成⑤ 沿用；**`build` ❌ 475.2KB** → 指挥官二分归因（`586131c42` + leftover-tut 一步从 447.3 跳到 475.2KB）→ t-1575 | typecheck ✅；build ❌（数值）；纯预演树 `check:tutorials` 报 `agents / billing-usage` 漂移（集成⑤ 处置） | `feat/v5-selfhost-audit-integ5-rehearsal@b6b78e876`（未推；不合入） | [archive/release.md](./archive/release.md) §2 · [INTEGRATION.md](./INTEGRATION.md) 集成⑤ §3 |
| t-1598 发布准备预演（fable-5-1-6，RELEASE.md v2.2 §3.1b） | 集成⑤预期树 `fc5c4f075`（`b6b78e876` + t-1575 + qa-integ4）实合 canonical `f1952819f` | 同 7 处冲突，实解 **`b96cb194f`**（正式 release-prep 重放取此 SHA，替代 `d02cc7c5d`：叠 a11y-C「默认」徽章 3 行）；**教程门两段式**（先在集成⑤树 `--source-only --ids agents,billing-usage`，再合 canonical 普通 accept `advisor-mode`） | typecheck ✅ · preview ✅ · tutorials ✅ · `lint:migration-order` ✅ · `test:protocol` 14/14 · vitest **27 文件 547 例** ✅ · build ✅ **448.3KB / 余量 11.7KB** · trailer PASS；**NOT RUN** `test:browser`、gateway / commercial 单测、commercial integ | `feat/v5-selfhost-audit-release-prep-rehearsal@e75749dd0`（不合入） | [archive/release.md](./archive/release.md) §3 · [RELEASE.md](./RELEASE.md) §3.1b |
| t-1455 发布前置·v3-dev-sg 磁盘核查与安全清理 | 服务器 `/` 盘 94%（09-17 d-1326）→ 87%（09-18 00:56 只读实测，S10 ≥ 8 GiB 门过）→ **76%**（d-1603 登记） | ≤ 85% 目标达；`.prev-release` `rel-3b7c38b9d-20260915-073032` 保留为回滚点 | **NOT RUN**（归档作者）：本机无服务器通道未复核现值；清理明细待指挥官交付摘要（阶段②） | —（服务器操作） | [archive/release.md](./archive/release.md) §4 · [RELEASE.md](./RELEASE.md) §2.2b S10 |

## 4. 集成④ 合入记录、集成⑤ 合入状态与集成⑤ / 发布线预留章节

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

### 4.2 集成⑤ 合入状态（09-18 00:3x 待合清单按 `c97a750f8..<分支>` 现算 → 09-18 21:xx 按 integration `aeae1d72e` 复核）

| 分支 `feat/v5-selfhost-audit-*` @ HEAD | 任务 | 00:3x 未合入 | 集成⑤ 合并提交（序 / 文件 · 行） | 21:xx `rev-list --count aeae1d72e..` | 远端 | 备注 |
|---|---|---|---|---|---|---|
| `budget-fix@65019b5dc` | t-1348 | 2 | 1/8 **`ec09ed419`**（12, +323/−142） | 0 | = 本地 | `App.tsx` 三方自动合并；**发布门** build 转绿（§4.3） |
| `qa-a11y@eed1f3989` | t-1232 | 2 | 2/8 **`c701daac9`**（5, +222/−4） | 0 | = 本地 | 零重叠 |
| `leftover-shell@7e7c7e43b` | t-1234 | 6 | 3/8 **`7cae5427f`**（18, +659/−85） | 0 | = 本地 | 零重叠 |
| `leftover-tut@69e18aa93` | t-1235 | 3 | 4/8 **`c4a516697`**（10, +529/−28） | 0 | = 本地 | 引入首屏回归（§3 / §3.1 t-1575），第 5 步修正 |
| `leftover-tut-budget@a947662bb` | t-1575（00:3x 尚未立项） | — | 5/8 **`10e1348fb`**（4, +50/−5） | 0 | = 本地 | `useAppRoute` chunk 30.7 → 2.0KB |
| `a11y-c@c35fd00c6` | t-1233（t-1344 第四手复核 `ea9348b2b`） | 18（11 自有 + 7 对齐合并） | 6/8 **`ecf912b88`**（17, +312/−14） | 0 | = 本地 | **集成⑤ 唯一冲突** `RichBlocks.test.tsx`（D-08 用例 ↔ `text-accent-fg` 用例同位）两条全保留，与 t-1503 预演解法一致 |
| `archive@35e3ec7c9` | t-632 / t-761 / t-897 预写 | 1 | 7/8 **`b6da4ef8d`**（1, +19/−13） | 0 | = 本地 | 本分支 archive-final 已带入同一提交（`e01791796`） |
| `qa-integ4@31a8a92d6` | t-1236（00:3x 待领） | — | 8/8 **`936d44e85`**（1, +153） | 0 | = 本地 | 纯文档 |
| `archive-final`（本分支，§9） | t-897 | 本轮 docs 提交 | **待合入** | 阶段① 提交数见 §9 | 阶段① 推送 | 纯文档（`SUMMARY.md` / `FINAL-REVIEW.md` / `archive/`）；已对齐合并 `aeae1d72e`，合入 integration 预期零冲突；`archive` 分支不必再单独合入 |
| ~~`integ4-rehearsal@522c24988`~~ · ~~`integ5-rehearsal@b6b78e876`~~ · ~~`release-rehearsal@a4452c7b6`~~ · ~~`release-prep-rehearsal@e75749dd0`~~ | 集成④ 预演 / t-1503 / t-1279 / t-1598 | 8 / 6 / — / — | — | — | 前两条未推，后两条已推 | **不合入**：结论已进 INTEGRATION.md 集成⑤（合入顺序、冲突解法、首屏二分）与 RELEASE.md（7 处冲突解法 `b96cb194f`、教程门两段式、门数值） |

八步合计 `git diff --shortstat c97a750f8..936d44e85` 64 files, +2269/−292，43 提交；`git grep -l '^<<<<<<< '` 为空；自有提交 `91358ce54` chore（source-only accept，§7-1）、`9103ce7b4` docs。集成⑤ 之后的发布线在 §4.4 / §4.5 预留。

### 4.3 【预留 · 阶段②填】集成⑤（t-1237 · 起点 `c97a750f8` · 指挥官 fable-5-1-4 代执行 01:45–02:15 → 账本由 fable-5-1-35 接手）

> 任务在待办池解锁时被宿主自动领到已离线的 fable-5-1-3 名下，组内在线只剩指挥官与 fable-5-1-6，用户 02:0x「全权负责……都不要停」（d-1603）→ 指挥官代执行合并 / 门 / 记录 / 推送；记录 [INTEGRATION.md 集成⑤](./INTEGRATION.md)（`9103ce7b4`）。**验收未闭合**：账本 integ5 在跑、全量门下半场 integ5-gate2 阻塞。本节只登记 `git` 事实，结论字段留 TODO。

| 项 | 已核事实（09-18 21:xx，integration `aeae1d72e`） |
|---|---|
| 合并 | 8 步 `--no-ff`（§4.2 表）；`rev-list --count` 对 8 条成员 HEAD 均 0；未 rebase / squash / force-push；subject 无 `fix(v5)` |
| 冲突 | 唯一 `RichBlocks.test.tsx`（a11y-c ↔ leftover-shell），两条用例全保留，合并后该文件 vitest 25/25；`App.tsx` 第 1 步三方自动合并 |
| 首屏回归专项 | 预演树 475.2KB ❌ → 二分归因 leftover-tut（`useAppRoute` 1.7 → 30.7KB）→ t-1575 `a947662bb` 第 5 步合入 → **`build` ✅ 447.8KB（458555 B），余量 12.2KB**（§3.1 / archive/leftover.md §4） |
| `check:tutorials` | 8 步合完报 `agents / billing-usage` 功能源漂移（a11y-C `AgentPicker` / `OrgSubscribeDialog`、budget-fix `SubscriptionDialog` className / lazy 改动致；入口身份 0 变化）→ `--source-only` accept **`91358ce54`**（history 第 70 条，**待用户终审**，§7-1；可逆 `git revert 91358ce54`） |
| 全量门 · 上半场（源码态 `91358ce54`；`.audit-tmp\integration\integ5\GATES-SUMMARY.txt`） | typecheck ✅ 29s · `typecheck:preview` ✅ 19s · `check:tutorials` ✅ 26 / 12 / 26 · **`build` ✅** 5108 modules，13 chunk 447.8KB · **`npm test` 305 文件 / 4306 例全部通过**（集成④ 302 / 4279 → +3 文件 `OrgSubscribeDialog.test` / `ui/Checkbox.test` / `tutorialSignatureWorkIds.test`，+27 例；`--maxWorkers=2` 339s）· `test:browser` `run.mjs` 68 全过 + `node --test` 87 例 85 / 2（`cc-switch-ascii-name` ×2 基线，五轮逐条相同）· biome 52 个改动源文件 HEAD vs `c97a750f8` **lint 新增 0**（5 条 `format` 差异全在本轮新增文件，为 Windows 工作树 CRLF 与 formatter 判定差异，blob 为 `i/lf`） |
| 全量门 · 下半场 | ui-preview 全量截图（≥ 301 场景）+ a11y 复扫（`scan.mjs` + compare vs 集成④）：**未跑**（集成⑤段 §5「第二拍」；t-1236 / t-1524 52 张抽样与 a11y-C 288 场景复扫已覆盖本轮改动面，但不替代全量） |
| 状态单 | 集成④ 24 条仍 0；本轮 8 条见 §4.2；远端 = 本地 |

- TODO（阶段②）：□ 下半场截图张数 / failures / 九项 a11y 指标 vs 集成④ 1026 张 · 301 场景 □ 集成⑤ 终点 HEAD 与验收结论、关单人 □ `[待集成⑤]` 状态全量翻转（§3 / §3.1 / §5.2 / §9 与 `archive/*.md`）□ 若 fable-5-1-35 补跑门后数值有变，以其记录为准回写本节。

### 4.4 【预留 · 阶段②填】发布准备（t-1268 · integration 合 canonical + 门 + canonical ff / push）

> 已核事实（[RELEASE.md §3.1c](./RELEASE.md)，fable-5-1-6 接任指挥官后代执行 09-18 02:1x–02:2x；fable-5-1-4 起合并遇 7 处冲突后掉线，接任者按 §3.1b 逐字重放）：**`57ad2c823`** merge canonical `feat/v5-selfhost@f1952819f`（parents `9103ce7b4` / `f1952819f`；4 源码文件 `git checkout b96cb194f --`，3 个 `tutorial-sync*` `--ours` 后普通 accept `advisor-mode` = history **第 71 条**）→ `04ba13b2e` cherry-pick R2 `c1fdc935e` → **`aeae1d72e`** RELEASE.md v2.2 + §3.1c = `<INT>`，已推 origin。门（HEAD `04ba13b2e`，`.audit-tmp\release-deploy\gates-int\`）：typecheck ✅ · preview ✅ · `check:tutorials` ✅ · `lint:migration-order` ✅ 283 支 · 161 条 · `test:protocol` 14/14 · vitest **29 文件 583 例** ✅ · `build` ✅ **448.3KB（459061 B）≤ 460.0KB，余量 11.7KB**（与 t-1598 预演逐字节相同）· trailer ✅ PASS；**NOT RUN** `test:browser`、gateway / commercial 单测、commercial integ（服务器 / CI 复跑）。
> **未做**：§3.3 canonical `--ff-only` + push。`git ls-remote`（09-18 21:xx）：`origin/feat/v5-selfhost` = **`97f128d2b`**（`feat(v5): send Cursor Sand Direct to api2 as 3.21.12 sand-desktop`，`f1952819f` 之后上游又 +1），integration 未含 → 发布准备需以 `97f128d2b` 重做 §1.1 `merge-tree` 冲突核对与 §3.2 门后再 ff / push。账本：release-prep 阻塞（等 integ5）。

- TODO（阶段②）：□ 合入 `97f128d2b`（或更新）的合并提交 / 冲突集合 / 门复跑数值 □ `<INT>` 终值、`<REL>` □ push 时间与 `git rev-parse origin/feat/v5-selfhost == <REL>` □ history 条数终值 □ t-1268 验收结论。

### 4.5 【预留 · 阶段②填】发布执行（t-1269 · 服务器 `/opt/openclaude/openclaude-v5-selfhost`，root@38.55.252.217 v3-dev-sg，[RELEASE.md §4](./RELEASE.md)）

> 已知前置：live = `rel-f1952819f-20260917-082520`（sourceCommit `f1952819f`），`schema_migrations` 已含 0281 → 预期 `HAS_MIGRATION=0`、不加 `OC_V5_ALLOW_BREAKING_MIGRATION`；磁盘 76%（t-1455，§3.2）；`--preflight` 为首装门不在 live 实例上跑（d-1603 ④）；不可逆动作由指挥官代批（d-1326 / d-1603）；个人版 `openclaude.service` / 18789 / Redis db0 不碰。账本：release-deploy 阻塞（等 release-prep）；disk-prep 在跑。**未开始。**

- TODO（阶段②，按 RELEASE.md §6 发布记录模板）：□ §4.0 前值（`<OLD_HEAD>` / `<OLD_REL>` / `<OLD_PREV>` / `<OLD_BUILD>` / runtime-release / platform bundle / lease / 磁盘）□ `git fetch` + `--ff-only` 到 `<REL>` □ `--status` / `--smoke` 前值 □ `--deploy --dry-run` 计划（HAS_MIGRATION 实值）□ `--deploy` 结果（`rel-<REL>-<ts>`、耗时、补偿与否）□ `--smoke` / `--status` 后值 □ §4.8 浏览器功能验证 □ 回滚点 □ t-1269 验收结论 □ 用户是否在发布前叫停（§7-7）。

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
| 首屏预算 | 下次逼近 460KB 时的可拆候选：专项工具卡体 ≈18KB · `lib/taskboard.ts` ≈3.3KB · `@openclaude/protocol` + typebox ≈30KB（需改 `packages/protocol` 导出，PLAYBOOK §9 范围外）· `PermissionCard` ≈5.7KB；集成⑤ 后余量 12.2KB、合 canonical 后 11.7KB | 登记，`shell.md` §9.4；`vite.config.ts:77-87` 已有「useAppRoute 别拖教程案例数据」注释（t-1575 重申） |
| QA t-1236 观感项（P3，不阻断） | O-1 hud `PinnedTaskTracker` / `PinnedDelegateTracker` 到 max-height 末行裁半行、无渐隐 · O-2 permission-card 命令块 `break-all` 把 `diff` 拆成 `d\|iff` · O-3 `Composer` textarea 达 max-height 底边裁半行 | ⏸ hud / permission-card / composer owner 各一行（渐隐遮罩或整行吸附 / `overflow-wrap:anywhere` / 底部内边距），`qa/qa-integ4.md` §7 |
| QA t-1236 工具·场景项（非产品缺陷） | O-4 `scenes-kp-automation.tsx` `kp-automation-new-picker` 星球选择器 Popover 未入图 · O-5 `scenes-workspace.tsx:45,86` `workspace-chat-density` 把 `<Sidebar>` 行内固定并开 mobile 视口，390px 主列被挤到 ~100px | ⏸ 场景加 clip 覆盖 / 改 `viewports: ['desktop']` 或换 App 壳组合；不改产品代码 |
| 集成⑤ biome `format` | 5 个本轮新增文件（`heroTheme.ts` / `ui/Checkbox.tsx` / `ui/Checkbox.test.tsx` / `hooks/useAppRoute.test.ts` / `scenes-market-audit.tsx`）在 Windows 工作树按 CRLF 判定报 format 差异，blob 为 LF | ⏸ 如需消掉在 Linux 或 `--line-ending=lf` 跑 `biome format --write`，与逻辑无关（INTEGRATION 集成⑤ §7） |

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
| d-1450（release，已被 d-1603 替代） | 用户 09-17 22:5x 在线再次确认「全权负责，尽快搞完上线」；持有人离线的超时原单由指挥官改派在线成员在原 id 下交付；僵尸替身单 t-1334 不交付 | 集成④ 收尾、a11y-C / QA-a11y 接手链、本归档终稿 |
| d-1603（release） | 用户 09-18 02:0x 对新指挥官 fable-5-1-4 重申「全权负责，端到端部署上线，不用问我」：沿用 d-1326 / d-1450 全部口径（push canonical 与服务器 `--deploy` 由指挥官代批，不再向用户确认）；人手不足可 `spawn_session` 补位；服务器现状 live = `rel-f1952819f-20260917-082520`、0281 已 apply → 本次 `HAS_MIGRATION=0`；磁盘 76%（t-1455）；发布序列以 RELEASE.md v2.1+ 为准，`--preflight` 是首装门不在 live 实例上跑；红线不变（个人版 18789 / Redis db0 不碰、不 force-push、禁 `fix(v5)`） | 集成⑤ 由指挥官代执行（§4.3）、release-prep / release-deploy（§4.4 / §4.5） |
| 集成⑤ source-only accept（指挥官 fable-5-1-4 按 q-1227 口径代确认，**待用户终审**） | `91358ce54`：`agents / billing-usage` 2 项功能源漂移（a11y-C / budget-fix / leftover-shell 的 className / lazy 改动致，入口身份 0 变化）`--source-only` 接受，history 第 70 条 | **必列终审导读**（§7-1） |
| release-prep 普通 accept（上游内容） | `57ad2c823` 内 `advisor-mode` 注册表 / 功能源 / 正文变化 = canonical OCV5-220 顾问卡文案 v4，普通 `tutorials:accept`，history 第 71 条 | 列入导读供知悉（上游变更，非审计侧） |
| q-786 | 归档摘要落 `docs/audit/archive/`，摘要 + 索引不复制正文，SHA 逐个核存在 | t-761 / t-632 / t-897 |
| q-979 → `fix_in_integ3` | `check:tutorials` 入口覆盖两处存量漏标（ChatHeader「导出会话」、Sidebar「清除搜索」）在集成③ 补 `data-product-control` | `c034f05d7` |
| q-988 → `accept_in_integ3` | 教程同步快照 17 + 2 漂移在集成③ accept，附抄检 / note / 清单三条要求 | 引出 q-1076 |
| q-1076 → A `demote_then_source_only`（fable-5-1-18 拍板，**代用户确认**） | composer-B 新增的「去授权」「排队发送」两处 `data-product-feature` 降级为 `data-product-control`（`29a277b25`）+ `tutorials:accept --source-only --ids <17 项>`（`b249317f4`） | **必列终审导读**（§7-1） |
| q-1227 → A（fable-5-1-18 拍板，**代用户确认**） | 集成④ 合入范围追加 tut-sync-2 / qa-gap / qa-p3 / qa-b-p3 / archive 五支；`scenes-hud.tsx` 冲突取 qa-gap；凡 a11y / 样式改动引起、入口身份无变、正文与 UI 文案抄检一致的功能源漂移统一 `--source-only` 接受（`2d2b5cafc`，`github-repository` 1 项） | **必列终审导读**（§7-1） |

## 7. 终审导读（需用户过目 / 确认；30 分钟单页版见 [FINAL-REVIEW.md](./FINAL-REVIEW.md)）

1. **教程同步快照 accept 四笔（指挥官代用户确认，可逆）**。TU-37 修好后 `check:tutorials` 在 Windows 首次真跑到底，一次性暴露 B 阶段各模块对入口元素的 UI/UX 修改导致的功能源哈希漂移：
   - **集成③ q-988 → q-1076 → A**：17 项功能源漂移 + 2 项入口身份变化 → 两处新入口降级为控件（`29a277b25`，UI 零变化）+ `--source-only` accept（`b249317f4`，`tutorial-sync-history.jsonl` 第 67 条 note「待用户终审」）。抄检两篇教程正文引用的入口文案与 HEAD 逐条一致；唯一不一致（正文未描述这两个新入口）→ **t-1046 已补写并恢复**（`e798c3123`：agents v5 / chat-basics v9 抬版，两处 `data-product-feature` 恢复，普通 `tutorials:accept`，history 第 68 条），随集成④ `96eb0eadf` 合入，q-1076 闭环。详见 [INTEGRATION.md 集成③ §4](./INTEGRATION.md)。
   - **集成④ q-1227 → A**：合入 a11y 三支后 `check:tutorials` 再报 `github-repository` 功能源漂移 1 项——哈希覆盖 `RepoPill` / `RepoStatusBanner` / `Sidebar`，改动全部来自 a11y-mod-a `036a2f3dd` 的 opacity → 实色，无任何用户可见文案增删、入口身份不变、正文 / 媒体未动 → `--source-only` accept（`2d2b5cafc`，history 第 69 条，note 注明「由指挥官 fable-5-1-18 代用户确认，待用户终审」）。详见 [INTEGRATION.md 集成④ §4](./INTEGRATION.md)。
   - **集成⑤ → `91358ce54`（指挥官 fable-5-1-4 按 q-1227 口径代确认）**：8 步合完 `check:tutorials` 报 `agents / billing-usage` 功能源漂移 2 项——哈希覆盖 `AgentPicker.tsx`（a11y-C「默认」徽章 `text-accent-fg`）、`SubscriptionDialog.tsx`（budget-fix `React.lazy` 拆分）、`OrgSubscribeDialog.tsx`（a11y-C「当前」徽章），均为 className / 加载方式改动，无用户可见文案增删、入口身份变化 0 → `--source-only` accept（history 第 70 条）。详见 [INTEGRATION.md 集成⑤ §4](./INTEGRATION.md)。
   - **不认可怎么退**：集成⑤ 一笔 `git revert 91358ce54`；集成④ 一笔 `git revert 2d2b5cafc`（`check:tutorials` 重新报 github-repository 1 项，其余门不受影响）；集成③ 一笔 `git revert b249317f4 29a277b25`（合入 t-1046 后需连带 revert `e798c3123`）。
   - 提示：release-prep `57ad2c823` 合 canonical `f1952819f` 时按预演口径做了一次**普通** accept（`advisor-mode` 注册表 / 功能源 / 正文 = 上游 OCV5-220 顾问卡文案 v4，history 第 71 条）——这是接受上游内容变更的例行动作，非审计侧改动，列出供知悉；发布准备重合 `97f128d2b` 时若再出现，仍按同一口径列入发布记录。
2. **2 条基线红（与本轮改动无关，四轮集成逐条相同）**：`browser-tests/cc-switch-ascii-name.node-test.mjs` ×2（settings `ApiKeysSection` 模型 id 断言 `expected 'gemini-3.8-flash' / actual 'sonnet-5'` + 「还没有 API Key」10s 超时；基线 `210b9967` 同样红）。`ocv5-185-qa` 在工作树干净 + junction 就位时 15/15 绿（集成④ / t-1348 均绿），已不算红。是否要在本轮之外修 cc-switch 基线，请拍板。
3. **NOT RUN 汇总**：真机 iOS Safari / Android（全部模块）；读屏实机（NVDA / VoiceOver，a11y 以 CDP AX 树与 jsdom 断言替代）；真后端行为（登录 / 注册 / 支付回跳 / OAuth / 投稿 / 撤回 / WS 多标签 / 服务端版本比对 / 知识星球写接口 / 分享令牌）—— 本轮无 v5-dev 通道，全部以 api-stub 场景与单测桩覆盖；各模块 `npm test` 全量与 `test:browser` 在成员分支多为 NOT RUN（非高频面），由集成①②③④ 在 integration 统一跑（§8.1）；集成④ 之后的 a11y-C / leftover-shell / leftover-tut 全量 `npm test` NOT RUN（leftover 两支 `test:browser` 亦 NOT RUN，非高频面；a11y-C 已补跑 68/68），交集成⑤ 合并树统一跑（budget-fix 已自跑全量 302 / 4279 ✅）；慢网首开体感（t-1348 懒块）未在节流网络实测。
4. **越界改动**（均经指挥官批准并在交付单列）：t-839 改 messages 归属 `RichBlocks.tsx`（OptionsBlock 注册改 `useLayoutEffect`、聚合判定读快照）与 `MarkdownImpl.tsx`（`components` `useMemo`，根因：每次渲染新造渲染器致富块整体重挂）；t-1029 改 settings 归属 `KnowledgePlanetAutomationPanel.tsx`（忙态改按键集合）；t-865 / 集成轮的 App 接线与原语扩展（`Sheet closeButton` opt-in、`MediaTaskCenter onReusePrompt`）；t-895 附录改 shell `App.test` / `AuthGate.test` 两行选择器（L-11）；t-1232 QA 直接修 market `PublishPanel` / `PermissionCard` 各一处 className（`77a93d9e1`）；t-1233 a11y-C `12275f27a` 仅格式化自己新增的用例；t-1348 触及 messages（`chat/media.tsx` / `cards.tsx` / `MarkdownImpl.test`）、settings（`SubscriptionDialog`）、sidebar（`ProjectRow`）——改 import / 抽常量 re-export / 测试等待方式，不改业务行为。
5. **设计取舍待拍板**：shell S-08 / S-20；market K-12 二期取「换行」（非箭头）；tutorials TU-13 删 `MissionReplay` / TU-31 第 4 步改指「设定目标」已按指挥官拍板落地；TU-17 深链参数名 `view=` 改 `tab=`（与 `/board` 冲突，t-1235）；HUD H-19 保留既有交互；t-1348 选 A 方案拆动态 import 而非上调阈值；市场审核面 checkbox 16px 导致 1440 宽一行第 4 枚徽章折行（`flex-wrap` 既定行为，接受）。
6. **需后端配合项**（§5.1）本轮一律未动，请决定是否另开后端专项。
7. **发布门与发布线**：集成④ 终点 `build` 首屏 gzip 471.4KB > 460.0KB 为红（非基线）→ t-1348 修到 445.5KB（阈值不动）→ 集成⑤ 合入 leftover-tut 又冲到 475.2KB（预演暴露）→ t-1575 修回 → **集成⑤ 源码态 `91358ce54` `build` ✅ 447.8KB、合 canonical 后 `04ba13b2e` ✅ 448.3KB（余量 11.7KB）**，发布门已绿。发布线现状（§4.3–§4.5）：集成⑤ 8 步已在 integration 但任务未验收、全量门下半场（截图 + a11y 复扫）未跑；release-prep 已合 canonical `f1952819f` 并过门，但 **canonical ff / push 未做**，且远端 canonical 又前进到 `97f128d2b` 需重核；release-deploy 未开始；不可逆动作两项（push canonical、`--deploy`）按 d-1326 / d-1603 在用户授权范围内由指挥官代批；服务器 live 已是 `f1952819f`、0281 已 apply、磁盘 76%。**终审若要在发布前叫停，请在 release-deploy（t-1269）开始前说。**
8. **本归档的阶段状态**：本文为阶段①草稿——集成③ 之后到 09-18 21:xx 全部已 done 任务已归入，集成⑤ / 发布线三章预留 TODO；阶段② 在 t-1237 / t-1268 / t-1269 交付后填齐并 `complete_task`。阶段① 未能自证的两处：t-1455 清理明细（服务器侧，等指挥官交付摘要）、集成⑤ 下半场门（未跑）。

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

### 8.1b 集成⑤ 上半场 · 发布准备门（记录值转录自 INTEGRATION.md 集成⑤ §5 与 RELEASE.md §3.1c；t-1237 / t-1268 任务未验收，阶段② 补下半场与终值）

| 门 | 集成⑤ 源码态 `91358ce54`（01:5x–02:1x，主克隆，`.audit-tmp\integration\integ5\`） | 发布准备 `04ba13b2e`（= `91358ce54` + canonical `f1952819f` + R2；02:1x–02:2x，`.audit-tmp\release-deploy\gates-int\`） | QA t-1236 / t-1567 独立实跑 `c97a750f8`（对照） |
|---|---|---|---|
| typecheck / `typecheck:preview` | ✅ 29s / ✅ 19s | ✅ 29s / ✅ 17s | ✅ / ✅ |
| `check:tutorials` | ✅ 26 / 12 / 26（accept `91358ce54` 后，第 70 条） | ✅ 26 / 12 / 26（普通 accept `advisor-mode` 后，第 71 条） | ✅ 26 / 12 / 26 |
| **`build` 首屏 gzip** | **✅ 447.8KB（458555 B）/ 13 chunk / 余量 12.2KB**（集成④ 471.4KB ❌ → t-1348 + t-1575） | **✅ 448.3KB（459061 B）/ 13 chunk / 余量 11.7KB**（与 t-1598 预演逐字节相同） | ❌ 471.4KB（R1 已知红，数值与集成④ 登记逐个相同） |
| web-react vitest | **全量 305 文件 / 4306 例 ✅**（339s，+3 文件 / +27 例） | 目标集合 29 文件 583 例 ✅（80s；全量 NOT RUN） | **全量 302 / 4279 ✅**（376s） |
| `test:browser` | `run.mjs` 68 全过；`node --test` 87 例 85 / 2（cc-switch 基线） | NOT RUN（服务器 / CI 复跑） | `run.mjs` 68 全过；87 例 85 / 2 |
| `lint:migration-order` / `test:protocol` | —（本轮无迁移 / 协议改动） | ✅ 283 支 · 161 条 / ✅ 14/14（canonical 0281 与 `engineModels.ts`） | — |
| Incident trailer 门 | — | ✅ PASS（起点 `e490e22af2cf`，冻结 tip 18，检查 45 条 `fix(v5)`） | — |
| biome | 52 文件 lint 新增 0（5 format 差异 = 新文件 CRLF 判定） | — | — |
| ui-preview 全量截图 / a11y 复扫 | **未跑（下半场，integ5-gate2 阻塞）** | — | 抽样 13 场景 52 张新增阻断 0（不替代全量） |
| gateway / commercial 单测、`test:commercial:integ` | — | NOT RUN（Windows 假阳性 R6 / R9；integ 需 PG） | — |

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
| leftover-tut-budget t-1575 | ✅（集成⑤ 合并树） | ✅ 新增 `tutorialSignatureWorkIds.test.ts`，计入集成⑤ 305 / 4306 | ✅ 集成⑤ 68/68 | NOT RUN（零视觉改动） | 分支自跑门日志未单列（以集成⑤ §5 为准） |
| QA t-1236 / t-1567 / t-1524（主克隆 `c97a750f8` 只读） | ✅ + `typecheck:preview` ✅ + `check:tutorials` ✅ | ✅ 全量 302 / 4279 / 0 失败 | ✅ 68/68；`node --test` 85/87 | ✅ 13 场景 52 张 failures 0（逐张 Read） | biome、ui-preview 全量、a11y 全量（有集成④ §5 记录 + t-1524 / t-1344 侧证） |
| 发布预演 t-1279（预演分支 `f6572abb6` / v2.1） | ✅ + preview ✅ + tutorials ✅ + `lint:migration-order` ✅ + `test:protocol` 14/14 + **`build` ✅ 447.3KB** | ✅ 9 文件 295 例 | NOT RUN | — | `test:browser`、commercial integ（需 PG）、`cursorCliWrapper.test` 55/57 Windows 假阳性 |
| 发布准备预演 t-1598（`addb87bd1`） | ✅ + preview ✅ + tutorials ✅ + `lint:migration-order` ✅ + `test:protocol` 14/14 + **`build` ✅ 448.3KB** + trailer PASS | ✅ 27 文件 547 例 | NOT RUN | — | `test:browser`、gateway / commercial 单测、commercial integ |
| 集成⑤ t-1237（`91358ce54`）/ 发布准备 t-1268（`04ba13b2e`） | 见 §8.1b | 见 §8.1b | 见 §8.1b | **集成⑤ 下半场未跑** | 任务未验收，阶段② 回写 |

## 9. 分支 / 提交总表

| 分支 | HEAD（本地 = 远端，09-18 21:xx `git ls-remote` 核对） | 用途 / 状态 |
|---|---|---|
| `feat/v5-selfhost`（canonical，远端） | **`97f128d2b`**（`f1952819f` + 1：`feat(v5): send Cursor Sand Direct to api2 as 3.21.12 sand-desktop`，09-18 上游推进）；`f1952819f`（基线 `210b9967` 之后上游 7 提交）已由 release-prep `57ad2c823` 合入 integration，`97f128d2b` **未合** | 基线 / 发布目标；release-prep 需重核（§4.4） |
| `feat/v5-selfhost-ocv5-audit-ux` | **`aeae1d72e`**（集成④ 终点 `c97a750f8` → 集成⑤ 源码态 `91358ce54` / 记录 `9103ce7b4` → canonical 合入 `57ad2c823` → R2 `04ba13b2e` → RELEASE.md v2.2 `aeae1d72e`） | integration（集成①②③④⑤ + 发布准备）；t-1237 / t-1268 任务未闭合；未 push canonical |
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
| `feat/v5-selfhost-audit-qa-a11y` | `eed1f3989` | QA t-1232；集成⑤ 2/8 `c701daac9`（任务口径「待集成⑤」= t-1237 未闭合，下同） |
| `feat/v5-selfhost-audit-a11y-c` | `c35fd00c6` | a11y-C t-1233（含 t-1344 复核）；集成⑤ 6/8 `ecf912b88` |
| `feat/v5-selfhost-audit-leftover-shell` | `7e7c7e43b` | t-1234；集成⑤ 3/8 `7cae5427f` |
| `feat/v5-selfhost-audit-leftover-tut` | `69e18aa93` | t-1235；集成⑤ 4/8 `c4a516697` |
| `feat/v5-selfhost-audit-leftover-tut-budget` | `a947662bb` | t-1575；集成⑤ 5/8 `10e1348fb` |
| `feat/v5-selfhost-audit-budget-fix` | `65019b5dc` | t-1348；集成⑤ 1/8 `ec09ed419`（发布门，集成⑤ build ✅ 447.8KB） |
| `feat/v5-selfhost-audit-qa-integ4` | `31a8a92d6` | QA t-1236（t-1512 / t-1524 / t-1567 分工）；集成⑤ 8/8 `936d44e85` |
| `feat/v5-selfhost-audit-archive-final`（本分支） | 基于 `c97a750f8` + 合并 `archive@35e3ec7c9`（`e01791796`）+ 承接 fable-5-1-24 未提交稿 `867e241e1` + 对齐合并 integration `aeae1d72e`（`9836216db`）+ 阶段① docs 提交（HEAD 见 send_to / complete_task 交付） | 归档终稿 t-897 阶段①，**待合入 integration**（纯文档；合入预期零冲突） |
| `feat/v5-selfhost-audit-integ4-rehearsal` / `-integ5-rehearsal` | `522c24988` / `b6b78e876`（均未推） | 集成④ / 集成⑤ 预演（t-1503），**不合入** |
| `feat/v5-selfhost-audit-release-rehearsal` / `-release-prep-rehearsal` | `a4452c7b6`（初稿 `c1fdc935e`，v2.1）/ `e75749dd0`（v2.2）（均已推） | 发布预演 t-1279 / 发布准备预演 t-1598，**不合入**（RELEASE.md 由 t-1268 `aeae1d72e` 带入） |

集成合并提交一览：集成① `3cff04c85` `09a13a472` `bf8188def` `985b3ae57`（记录 `43b7cd3a4`）；集成② `5e5ed6925` `6fa690d7e` `ab765669a` `6201518b2` `10398baa9` `b41e804ac` `ae0b0cb64`（接线 `19799c0fe` · 用例 `f7c08f3eb` · `.gitattributes` `419e0d218` · `2a6492774` · 记录 `1d8eaf769` / `2b23a31a7` · 集成待办 t-865 `e0f53688a` `d4b061e37` `a3af53970` `bae5a8673` `7d5573a92` 记录 `1e4328ac9`）；集成③ `12fc17579` `cd58600e8` `425655631` `c761bbd93` `be20adaec` `ce767d8ce`（接线 `bdf7b4d15` · q-979 `c034f05d7` · q-1076 `29a277b25` `b249317f4` · 记录 `36bb9a677`）；集成④ `2c1d659d2` `d83d4a368` `bf940d804` `015522b66` `15f816145` `68f031ba6` `80e757d95` `96eb0eadf` `902ade6e8` `4f93f6990` `f605df89f` `b23955208`（test `d2afaaa20` · 接线 `4a2745283` · q-1227 accept `2d2b5cafc` · 记录 `c97a750f8`）；**集成⑤ `ec09ed419` `c701daac9` `7cae5427f` `c4a516697` `10e1348fb` `ecf912b88` `b6da4ef8d` `936d44e85`（source-only accept `91358ce54` · 记录 `9103ce7b4`）；发布准备 `57ad2c823`（canonical `f1952819f`）· R2 `04ba13b2e` · RELEASE.md v2.2 `aeae1d72e`**。

## 10. 评审入口

- 仓库：`https://github.com/dream-star-end/smart-assistant`，分支同名（§9）；本地主克隆 `d:\code\test_project\test123\v5-selfhost`，工作树 `d:\code\test_project\test123\wt\<slug>`（本归档在 `wt\archive-final`）。
- 文档（本分支 = integration `aeae1d72e` + 归档提交，以下路径**全部在树内**）：**[FINAL-REVIEW.md](./FINAL-REVIEW.md)（30 分钟终审导读）** → 本文 → [archive/README.md](./archive/README.md)（12 模块 + 专项 / QA / 遗留清扫 / 预演与发布线索引、集成①–⑤ 合入记录、集成⑤ 合入状态）→ `archive/<slug>.md`（归档摘要；新增 [archive/leftover.md](./archive/leftover.md)、[archive/release.md](./archive/release.md)）→ `<slug>.md`（正文）；专项与 QA 正文 [hud.md](./hud.md) / [kp-automation.md](./kp-automation.md) / [misc-p3.md](./misc-p3.md) / [permission-card.md](./permission-card.md) / [a11y-shell.md](./a11y-shell.md) / [a11y-mod-a.md](./a11y-mod-a.md) / [a11y-mod-b.md](./a11y-mod-b.md) / [a11y-c.md](./a11y-c.md) / [leftover-shell.md](./leftover-shell.md) / [qa/QA-p3-tail.md](./qa/QA-p3-tail.md) / [qa/QA-b-p3.md](./qa/QA-b-p3.md) / [qa/qa-gap.md](./qa/qa-gap.md) / [qa/QA-a11y.md](./qa/QA-a11y.md) / [qa/qa-integ4.md](./qa/qa-integ4.md)；集成记录 [INTEGRATION.md](./INTEGRATION.md)（集成①–⑤）；发布手册 [RELEASE.md](./RELEASE.md)（v2.2：预演、前置清单、本地步骤、服务器命令序列、回滚、发布记录模板）。
- 截图（仓外，不入库）：`D:\code\test_project\test123\.audit-tmp\<slug>\{before,after}\`；集成③ 全量 854 张 `.audit-tmp\integration\shots-integ3\`；**集成④ 全量 1026 张 `.audit-tmp\integration\shots-integ4\`**；QA `.audit-tmp\qa-p3\shots\`（126）/ `qa-b-p3\integ\`（258）/ `qa-gap\shots\`（120）/ `qa-a11y\shots\`（74）/ **`qa-integ4\shots\`（52，集成④ 终点抽样）**；a11y 走查 `.audit-tmp\a11y\`，集成④ 复扫 `.audit-tmp\integration\a11y-integ4\`，a11y-C `.audit-tmp\a11y-c\{before,after,scan-*,finish-scan}`；leftover-shell `.audit-tmp\leftover-shell\`（含 CDP AX 脚本 `ax-checkbox.mjs`）；leftover-tut `.audit-tmp\leftover-tut\`；budget-fix 归因脚本 `.audit-tmp\budget-fix\attribute-first-screen.mjs`；集成⑤ 下半场截图 / 复扫目录待跑后登记。
- 日志（仓外）：`.audit-tmp\integration\integ4-*.log`、`integ4-final-gates.summary.txt`；**集成⑤ `.audit-tmp\integration\integ5\`（`run-gates.ps1` / `GATES-SUMMARY.txt` / `vite-build.log` / `vitest-full.log` / `test-browser-2.log` / `biome-compare.txt` / `check-tutorials-*.log`）**；首屏二分 `.audit-tmp\release-rehearsal\integ5-bisect\SUMMARY.txt`；QA 集成④ `.audit-tmp\qa-integ4\t1567-*.log`；发布预演 `.audit-tmp\release-rehearsal\gates-head-2\`、`.audit-tmp\release-prep-rehearsal\gates\SUMMARY.txt`、发布准备 `.audit-tmp\release-deploy\gates-int\`；各模块 / QA / 专项 `.audit-tmp\<slug>\*.log`。
- 作业口径：`d:\code\test_project\test123\TEAM_PLAYBOOK.md`（仓外）；决策 d-24 / d-26 / d-28 / d-1326 / d-1450 / d-1603；决策卡 q-786 / q-979 / q-988 / q-1076 / q-1227（§6）。

## 11. 终稿口径与本次更新说明（t-897 · 阶段①）

- 基点：integration `c97a750f8`（集成④ 终点）开 worktree `wt\archive-final`，分支 `feat/v5-selfhost-audit-archive-final`，先 `--no-ff` 合入归档分支 `archive@35e3ec7c9`（`e01791796`）；原持有人 fable-5-1-24 在其上完成的集成④ 事实回填与 5 条交付登记因离线未提交，由接手人（fable-5-1-32）原样提交为 `867e241e1`（承接稿，00:3x 事实），再 `--no-ff` 对齐合并 integration `aeae1d72e`（`9836216db`，零冲突、无自有改动），在其上做阶段① 更新。**主工作树未动**（fable-5-1-35 在做集成⑤ 收尾），`INTEGRATION.md` 未改。
- 阶段① 更新范围（纯文档，只动 `docs/audit/SUMMARY.md`、新增 `docs/audit/FINAL-REVIEW.md`、`docs/audit/archive/{README,qa,leftover,release}.md`）：① §1 / §3 / §3.1 按 t-1236（含 t-1512 / t-1524 / t-1567）、t-1575 补齐，新增 §3.2 预演与发布前置（t-1279 / t-1503 / t-1598 / t-1455）；② §4.2 改为「集成⑤ 合入状态」（每支的集成⑤ 合并提交 + `rev-list aeae1d72e..` 复核），新增 §4.3 集成⑤ / §4.4 发布准备 / §4.5 发布执行三章**预留**（只登记 `git` 事实，TODO 字段留阶段②）；③ §5.2 增 QA t-1236 观感 / 场景项与集成⑤ biome format；§6 增 d-1603、第 70 / 71 条 accept；§7 accept 三笔 → 四笔、§7-7 发布门现状、§7-8 阶段状态；§8.1b 集成⑤ 上半场 · 发布准备门；§9 / §10 按 `aeae1d72e` 与 canonical `97f128d2b` 更新；④ `archive/qa.md` 增 §5 t-1236、`archive/leftover.md` 增 §4 t-1575、新增 `archive/release.md`、`archive/README.md` 增专项行 / 集成⑤ 行 / 合入状态表 / 决策；⑤ 新增 `FINAL-REVIEW.md` 终审导读单页。**各模块摘要（`archive/<12 模块>.md` 等）本阶段未改**，其「待集成⑤」为任务口径，阶段② 统一翻转。
- 信息源：`INTEGRATION.md` 集成④ / 集成⑤ 全部小节；`RELEASE.md` v2.2（§0 / §1.3b / §2.2b / §3.1b / §3.1c）；`qa/qa-integ4.md`、`qa/QA-a11y.md`、`a11y-c.md`、`leftover-shell.md`、`tutorials.md` §10、`shell.md` §9（对齐合并后树内直读）；任务库账本（09-18 20:49）、决策 d-1603 / d-1700、任务书 t-897（指挥官 fable-5-1-31）；`git log / diff / ls-remote / rev-list / merge-base` 现算。统计排除作废条 t-837（正文见 `archive/permission-card.md` 文首）。
- 核对（阶段①，结果见 send_to 进度报告）：本文 + `FINAL-REVIEW.md` + `archive/*.md` 引用的全部短 SHA 逐个 `git cat-file -e <sha>^{commit}`；导读与本文的相对路径逐个存在；初稿用过的三个占位词在 `SUMMARY.md` + `FINAL-REVIEW.md` + `archive/` 全文检索 0 命中（检索词列在 send_to 报告里，此处不写以免自命中；预留章节的 `TODO` 字段是任务书要求的显式留空，不算占位）；与 `INTEGRATION.md` 集成⑤ §5 / `RELEASE.md` §3.1c 的 HEAD 与门数值逐项一致（447.8KB / 305 · 4306 / 448.3KB / 29 · 583 / trailer PASS）。
- 阶段② 收口清单：□ §4.3 下半场门 + 验收 □ §4.4 canonical `97f128d2b` 重核 / push □ §4.5 发布记录 □ 「待集成⑤」全量翻转（§3 / §3.1 / §5.2 / §9、`archive/*.md`）□ t-1455 清理明细 □ §1 任务数 / 时间跨度终值 □ `FINAL-REVIEW.md` 状态行改「已上线 / 未上线」□ `complete_task(taskId="t-897")`。
