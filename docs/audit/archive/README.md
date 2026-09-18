# v5 个人版审计 · 归档摘要索引

> 本目录是 t-761「归档预整理·按模块归集已完成交付」的产物，t-632 初稿 / t-897 终稿逐轮更新：每个模块一份**归档摘要**（审出问题 → 修复情况 → 验证摘要 → 遗留 → 分支 / 提交），每段末尾链回模块负责人维护的正文 `docs/audit/<module>.md`。摘要不复制正文，避免两份漂移。
> 路径按决策卡 q-786 裁决放在 `docs/audit/archive/`（不与各模块分支及 integration 上既有的 `docs/audit/<module>.md` 撞名）。
> 基线 `210b9967`；integration 分支 `feat/v5-selfhost-ocv5-audit-ux`，HEAD **`c97a750f8`**（集成④ 终点，09-17 23:28，已 push；源码态 `2d2b5cafc`）。t-761 首版按 `419e0d218` 写，t-632 初稿按 `36bb9a677`（集成③ 终点）更新，**t-897 终稿按 `c97a750f8` 更新**，并登记集成④ 之后、待集成⑤ 合入的 6 条分支。SHA 均为分支上实际提交的短哈希，终稿逐个 `git cat-file -e` 核过。
> 总览与终审导读见 [`docs/audit/SUMMARY.md`](../SUMMARY.md)。

## 模块索引

| 模块 | 任务（A / B / 二期·补丁） | 分支 | HEAD | 发现 | 已修 | 遗留（归属内） | 状态 | 摘要 | 正文 |
|---|---|---|---|---|---|---|---|---|---|
| shell 应用壳层与设计系统 | t-30 / t-31 / —；a11y-shell t-893；发布阻断 t-1348 | `feat/v5-selfhost-audit-shell` | `39697560b` | 20（P1 1 · P2 8 · P3 11） | 18 + 半条 1；a11y-shell 11/11；`ui/Checkbox` 原语（t-1234）；首屏预算 471.4 → 445.5KB（t-1348） | 2 暂缓（S-08、S-20，等用户拍板） | 已合入（集成①起点）；a11y-shell 集成④ `15f816145`；t-1234 / t-1348 待集成⑤ | [shell.md](./shell.md) · [a11y.md](./a11y.md) · [leftover.md](./leftover.md) §1 / §3 | [../shell.md](../shell.md) · [../a11y-shell.md](../a11y-shell.md) |
| messages 消息渲染与时间线 | t-32 / t-33 / t-629 | `feat/v5-selfhost-audit-messages` | `2abe389a9` | 25（P2 4 · P3 21） | 22 | 3（M-21 / M-24 / M-25，二期复核均不可独立完成） | B 已合入（集成①）；二期已合入（集成③ `cd58600e8`，代码改动 0）；a11y-mod-b messages#1/#2 集成④ | [messages.md](./messages.md) | [../messages.md](../messages.md) |
| composer 输入区 / 会话头 / 模型与目标 | t-34 / t-35 / — | `feat/v5-selfhost-audit-composer` | `70d3db8b3` | 35 + 承接 M-16 | 32；C-32 由 t-865 `d4b061e37` 落地 | 3（C-16 / C-30 待 `ask_decision`；C-26 需后端） | 已合入（集成②）；a11y-mod-b composer#2/#3 与 tut-sync-2 集成④；a11y-C「默认」徽章待集成⑤ | [composer.md](./composer.md) | [../composer.md](../composer.md) |
| sidebar 侧栏 / 会话 / 项目 / 站内信 / GitHub | t-36 / t-37 / t-627 | `feat/v5-selfhost-audit-sidebar` | `25c775295` | 正文统计 38（P2 12 · P3 26；编号行 50，见摘要注） | P2 全部 + 二期 S-14（正文未给逐条计数） | 0；需后端 2（UCP-01 / GH-03）；P3 nit `RepoStatusBanner:85` 关闭钮 opacity（QA t-1232 观察） | B 与二期均已合入（集成① / ②）；QA t-1028 通过；a11y-mod-a sidebar#1/#2/#4 集成④ | [sidebar.md](./sidebar.md) | [../sidebar.md](../sidebar.md) |
| manage 管理中心 | t-38 / t-39 / t-426（补丁①）· t-626 | `feat/v5-selfhost-audit-manage` | `6fae01440` | 27（P1 1 · P2 8 · P3 18）+ 跨模块 3 | 22 + 补丁① 4 + 二期 1（M-12 余量）+ 承接 X-03 | 2 需后端（M-17 / M-06 ③） | B 已合入（集成①）；二期已合入（集成③ `c761bbd93`）；QA t-1028 通过；a11y-mod-a manage#1–#4 集成④ | [manage.md](./manage.md) | [../manage.md](../manage.md) |
| settings 设置中心 / 组织 / 支付 | t-40 / t-41 / t-426 · t-628 | `feat/v5-selfhost-audit-settings` | `5eac1b807` | 43（P2 12 · P3 31） | 41 + 二期 4 项；备案判据去重 t-1234 `74026e020` | 需后端 2（SET-09 / SET-10）· 跨模块 1（`ConnectorsTab` 目录迁移，可选）· 不修 3 | B + 补丁① 已合入（集成②）；二期已合入（集成③ `12fc17579`）；QA t-1028 通过；a11y-mod-a settings 五条 + QA nit 2 集成④ | [settings.md](./settings.md) | [../settings.md](../settings.md) |
| taskboard 任务面板 | t-42 / t-43 / t-630 | `feat/v5-selfhost-audit-taskboard` | `05dd185df` | 30（P1 2 · P2 14 · P3 14） | 27 + 2 部分 + T-02 由 sidebar 修 | 2 部分（T-20 shell 类型 / T-28 后端约束） | B 已合入（集成①）；二期已合入（集成③ `425655631`，仅场景 1 行） | [taskboard.md](./taskboard.md) | [../taskboard.md](../taskboard.md) |
| tools 工具卡 / 智能体过程 / 检查器 | t-44 / t-45 / — | `feat/v5-selfhost-audit-tools` | `d65c6741e` | 31（P1 1 · P2 7 · P3 23）+ 跨模块 4 | 31 | 0 | 已合入（集成②）；a11y-mod-b tools#1 集成④ | [tools.md](./tools.md) | [../tools.md](../tools.md) |
| market AI 市场 | t-46 / t-47 / t-625 | `feat/v5-selfhost-audit-market` | `5391c150a` | 26（P1 1 · P2 4 · P3 21） | 13 + 二期 10 = 23；K-27 由 t-1234 落地 | 2（K-23 不做有判据 / K-25 需后端）；P3 nit `MyPublishes` 折叠钮 322×42（QA t-1232 观察） | B 已合入（集成②）；二期已合入（集成③ `be20adaec`）；QA t-1028 通过；a11y-mod-a market#1/#2 集成④；K-27 与 QA t-1232 `77a93d9e1` 待集成⑤ | [market.md](./market.md) | [../market.md](../market.md) |
| landing 落地页 / 登录 / 法务 / 桌面端登记 | t-48 / t-49 / — | `feat/v5-selfhost-audit-landing` | `b97adb3fb` | 20（P2 3 · P3 17）+ 跨模块 3 | 16 + 2 部分；L-11 由 t-895 附录 `6236dfb08` 落地 | 1（L-16 ② 产品） | 已合入（集成②）；QA t-1038 0 不符；a11y-mod-b landing#1/#2 + L-11 集成④ | [landing.md](./landing.md) | [../landing.md](../landing.md) |
| media 图片 / 媒体 / 容器网页预览 | t-50 / t-51 / — | `feat/v5-selfhost-audit-media` | `8834aca08` | 27（P1 2 · P2 11 · P3 14） | 25；M-27 由 t-865 `a3af53970`、M-23 性能半条由 t-895 附录 `986f72b2f` 落地 | 1（M-25 需后端分享令牌，前端半条已做） | 已合入（集成②）；QA t-1038 1 不符已勘误 + 移交落地；a11y-mod-b media#1/#2 + M-23 集成④；a11y-C 「放弃」键 / placeholder 待集成⑤ | [media.md](./media.md) | [../media.md](../media.md) |
| tutorials 教程中心 | t-52 / t-53 / —；t-1046 正文补写；t-1235 遗留清扫 | `feat/v5-selfhost-audit-tutorials` → `-tut-sync-2` → `-leftover-tut` | `02c358655` → `67b1494ea` → `69e18aa93` | 37（P2 12 · P3 25） | 28 + 5 部分；TU-17 / TU-34 由 t-1235 落地 | 1（TU-21 产品口径；TU-36 已由集成② 落地） | A+B 已合入（集成③ `ce767d8ce`）；App 接线 `bdf7b4d15`；QA t-1038 0 不符；tut-sync-2 集成④ `96eb0eadf`；leftover-tut 待集成⑤ | [tutorials.md](./tutorials.md) · [leftover.md](./leftover.md) §2 | [../tutorials.md](../tutorials.md) |

「已修 / 遗留」以各模块正文修复记录 / 遗留章节为准，摘要只转录计数；跨模块转出项在对方模块的摘要里登记闭环状态。

## 专项与 QA 索引（覆盖复查 t-760 之后立项）

| 专项 | 任务 | 分支 @ HEAD | 发现 | 已修 | 遗留 | 集成 | 摘要 | 正文 |
|---|---|---|---|---|---|---|---|---|
| HUD 任务列表 / 后台子任务（G-1 / G-2） | t-836 + QA t-1029 | `feat/v5-selfhost-audit-hud` @ `b1f06f8f5`（QA 修复 `747596782` 在 qa-gap） | 20（P2 7 · P3 13） | 17 + ◐1；H-18 接线 `4a2745283` | H-12 需后端 · H-20 ① messages · H-19 取舍 | ✅ 集成④ `2c1d659d2` | [hud.md](./hud.md) | [../hud.md](../hud.md) |
| 知识星球自动回复面板（G-3） | t-838 + QA t-1029 | `feat/v5-selfhost-audit-kp-automation` @ `b0fd16dad`（QA 修复 `1db992620` 在 qa-gap） | 19（P1 1 · P2 7 · P3 11） | 17；勾选态白字由 a11y-C `00b86b565` 修 | KP-18 / 19 不修有判据；弹层形态归 shell；同意勾选换 `ui/Checkbox` 为建议；「从当前账号…」钮 316×42 nit | ✅ 集成④ `d83d4a368`；a11y-C 待集成⑤ | [kp-automation.md](./kp-automation.md) | [../kp-automation.md](../kp-automation.md) |
| 杂项 P3：`?demo=1` + optionsGroup（G-4 / G-5） | t-839 + QA t-1029 | `feat/v5-selfhost-audit-misc-p3` @ `c834dffa1` | 18（P2 2 · P3 16） | 12；D-02 接线 `4a2745283`、D-08 t-1234 `3aba642ca`、勾选白字 a11y-C `59e66773f` | OG-05 / OG-09 messages · D-04 / D-09 产品 | ✅ 集成④ `bf940d804`；t-1234 / a11y-C 待集成⑤ | [misc-p3.md](./misc-p3.md) | [../misc-p3.md](../misc-p3.md) |
| PermissionCard 未决态审批交互 | t-875（t-837 作废重开）+ QA t-1232 | `feat/v5-selfhost-audit-permission-card` @ `8a3179896` | 17（P2 5 · P3 12） | 17；QA 补 1（summary 44px `77a93d9e1`） | 弹框关闭焦点归位（shell）· 提交超时（状态机） | ✅ 集成④ `015522b66`；QA 修复待集成⑤ | [permission-card.md](./permission-card.md) | [../permission-card.md](../permission-card.md) |
| a11y 专项：走查 + 三条修复单 + 同源项清扫 | t-762 → t-893 / t-894 / t-895 → t-1233 a11y-C；QA t-1232 | `-a11y-shell` @ `4930707cc` · `-a11y-mod-a` @ `475e3e6c7` · `-a11y-mod-b` @ `9710a3b24` · `-a11y-c` @ `c35fd00c6` | 35（P2 9 · P3 26）+ §5 同源项 13 | 35 + 顺手 2 + QA nit 2 + 附录 2（L-11 · M-23）；a11y-C 已修 7 项 9 处 + 补修 2（同批闭环 5 / 不修 1） | 禁用态 / 装饰性文本等 WCAG 例外项不列；a11y-C 补记 `TutorialCenter:387` 图标块白字（tutorials 一行） | ✅ 三单集成④ `15f816145` / `68f031ba6` / `80e757d95`；a11y-C 待集成⑤ | [a11y.md](./a11y.md) | [../a11y-shell.md](../a11y-shell.md) [../a11y-mod-a.md](../a11y-mod-a.md) [../a11y-mod-b.md](../a11y-mod-b.md)；`../a11y-c.md`（分支） |
| QA 复核四轮 | t-1028 / t-1038 / t-1029 / t-1232 | `-qa-p3` @ `3e640a85d` · `-qa-b-p3` @ `0ac949b2e` · `-qa-gap` @ `c1734aac6` · `-qa-a11y` @ `eed1f3989` | 核对 37 / 84 / 61 / 58 项 | ❌ 0 / 1（勘误 + 移交）/ 2（已修）/ 0（◐1 + 漏项 1 已修） | — | ✅ 前三轮集成④ `4f93f6990` / `f605df89f` / `902ade6e8`；qa-a11y 待集成⑤ | [qa.md](./qa.md) | [../qa/QA-p3-tail.md](../qa/QA-p3-tail.md) [../qa/QA-b-p3.md](../qa/QA-b-p3.md) [../qa/qa-gap.md](../qa/qa-gap.md)；`../qa/QA-a11y.md`（分支） |
| 集成待办清理 | t-865 | integration `e0f53688a` `d4b061e37` `a3af53970` `bae5a8673` `7d5573a92`，记录 `1e4328ac9` | 7 项待办 | 5 修 + 1 核对已具备 + 1 转 t-53 | — | ✅ 集成② 内 | — | [../INTEGRATION.md](../INTEGRATION.md) 集成② §7.1 |
| tutorials 正文补写（q-1076 闭环） | t-1046 | `feat/v5-selfhost-audit-tut-sync-2` @ `67b1494ea`（`e798c3123` feat + INTEGRATION 勾销） | — | agents / chat-basics 正文补写 + 抬版，两处 `data-product-feature` 恢复，普通 `tutorials:accept`（history 第 68 条） | — | ✅ 集成④ `96eb0eadf` | — | [../tutorials.md](../tutorials.md) / [../INTEGRATION.md](../INTEGRATION.md) 集成③ §4 |
| 遗留清扫 shell / market / settings / App | t-1234 | `-leftover-shell` @ `7e7c7e43b` | 4 项遗留 | 4/4（`ui/Checkbox` + K-27 四处 · 备案判据 `filedIcp()` · D-02 用例 · D-08 reason 文案） | 无 | 待集成⑤（+6） | [leftover.md](./leftover.md) §1 | `../leftover-shell.md`（分支）· [../market.md](../market.md) · [../misc-p3.md](../misc-p3.md) |
| 遗留清扫 tutorials TU-17 / TU-34 | t-1235 | `-leftover-tut` @ `69e18aa93` | 2 项遗留 | 2/2（深链 `tab= / work= / step=` · 模块级 hero token） | 无 | 待集成⑤（+3） | [leftover.md](./leftover.md) §2 | [../tutorials.md](../tutorials.md) §10 |
| 发布阻断 · 首屏 gzip 预算超限 | t-1348 | `-budget-fix` @ `65019b5dc` | `build` 红 471.4KB > 460.0KB | 445.5KB ≤ 460.0KB，阈值不动；8 处拆分（覆盖层 lazy） | 后续可拆候选 4 项（见摘要） | 待集成⑤（+2）；**发布门** | [leftover.md](./leftover.md) §3 | [../shell.md](../shell.md) §9 |

## 集成分支合入记录（`feat/v5-selfhost-ocv5-audit-ux`）

| 轮次 | 任务 · 执行 | 起点 / 合并提交 | 接线 · 用例 · 记录 |
|---|---|---|---|
| 集成① | t-399 · fable-5-1-21 | 起点 `e6f73dd99`（已含 shell-B `de38a312c`…`39697560b`）；`3cff04c85` sidebar-B @`ef872e91a` · `09a13a472` manage-B @`af79d7b05` · `bf8188def` taskboard-B @`0b06f7ce5` · `985b3ae57` messages-B @`d2f84063d` | `678fe9d38` App 接 sidebar-B S-05/S-06/S-08/UUS-01 · `09d15400f` `useChatSocket` 空标题（ST-01）· `1ae92b831` 两处既有用例随契约更新 · 记录 `43b7cd3a4`（[../INTEGRATION.md](../INTEGRATION.md)） |
| 集成② | t-624 · 合并 fable-5-1-40 → 接线 / 门 / 记录 fable-5-1-52 | `5e5ed6925` settings-B + 补丁① @`c0efc9c91` · `6fa690d7e` tools-B @`d65c6741e` · `ab765669a` market-B @`1fb99bfcc` · `6201518b2` landing-B @`b97adb3fb` · `10398baa9` media-B @`8834aca08` · `b41e804ac` sidebar 二期 @`25c775295` · `ae0b0cb64` composer-B @`70d3db8b3` | `19799c0fe` App 接线（market `onRequireLogin` / tools T-18 选中态 / composer 去授权入口 / brand `contactEmail`）· `f7c08f3eb` 既有用例随契约更新 · `419e0d218` 仓根 `.gitattributes` 教程夹具 `-text`（TU-36）· `2a6492774` 还原 market 场景 import 后缀 · 记录 `1d8eaf769`，分支状态单 `2b23a31a7`；集成待办清理 t-865 `e0f53688a` `d4b061e37` `a3af53970` `bae5a8673` `7d5573a92`，记录 `1e4328ac9`（[../INTEGRATION.md](../INTEGRATION.md) 集成② §7.1） |
| 集成③ | t-631 · 合并 / 接线 fable-5-1-54 → 门禁探测 fable-5-1-16 → 落地 / 全量门 / 记录 fable-5-1-22 | `12fc17579` settings 二期 @`5eac1b807` · `cd58600e8` messages2 @`2abe389a9` · `425655631` taskboard2 @`05dd185df` · `c761bbd93` manage2 @`6fae01440` · `be20adaec` market2 @`5391c150a` · `ce767d8ce` tutorials A+B @`02c358655`（唯一冲突 `shoot.mjs` 取 integration 版本） | `bdf7b4d15` App 接线 TU-32 · `c034f05d7` 入口覆盖两处存量漏标补 `data-product-control`（q-979）· `29a277b25` composer 两处新增入口降级为控件 + `b249317f4` 教程同步快照 `--source-only` accept 17 项（q-1076，**指挥官代用户确认，待终审**）· 记录 `36bb9a677`（[../INTEGRATION.md](../INTEGRATION.md) 集成③） |
| 集成④ | t-896 · 合并 / 接线 / 门 / 截图 / a11y 扫描 fable-5-1-24 → 收尾复跑 / 记录 / 推送 fable-5-1-52 | 起点 `36bb9a677`；12 步 `--no-ff`：`2c1d659d2` hud @`b1f06f8f5` · `d83d4a368` kp-automation @`b0fd16dad` · `bf940d804` misc-p3 @`c834dffa1` · `015522b66` permission-card @`8a3179896` · `15f816145` a11y-shell @`4930707cc` · `68f031ba6` a11y-mod-a @`475e3e6c7` · `80e757d95` a11y-mod-b @`9710a3b24` · `96eb0eadf` tut-sync-2 @`67b1494ea` · `902ade6e8` qa-gap @`c1734aac6`（唯一冲突 `scenes-hud.tsx` 取 qa-gap `747596782`）· `4f93f6990` qa-p3 @`3e640a85d` · `f605df89f` qa-b-p3 @`0ac949b2e` · `b23955208` archive @`a38a093bf`；合计 125 files, +7783/−654，LOST = 0 | `d2afaaa20` test scenes-hud TS2353（后被 qa-gap 同处覆盖）· `4a2745283` App 接线 hud H-18 `onStop` 条件化 + misc-p3 D-02 demo 会话按 id 取 fixture · `2d2b5cafc` `chore` 教程同步快照 `--source-only` accept `github-repository` 1 项（q-1227 → A，**指挥官 fable-5-1-18 代用户确认，待终审**，history 第 69 条）· 记录 `c97a750f8`（[../INTEGRATION.md](../INTEGRATION.md) 集成④），已 push origin |

全量门：集成① 记录 §5（ui-preview 118 场景 350 张）；集成② §5（227 场景 734 张）；集成③ §5（`npm test` 298 文件 / 4213 例全绿 ×2、`run.mjs` 68/68、ui-preview 257 场景 854 张 failures 0、`typecheck:preview` 3 红全消、`check:tutorials` 转绿）；**集成④ §5（源码态 `2d2b5cafc`，三次全量）：typecheck ✅ · `typecheck:preview` ✅ · `check:tutorials` ✅（accept 后）· `npm test` 302 文件 / 4279 例全绿 ×3 · `run.mjs` 68/68 + `node --test` 85/87（2 红 = cc-switch 基线）· ui-preview 301 场景 1026 张 failures 0 · a11y 复扫 301 场景 0 失败、共同 257 场景九项指标只降不升 · biome 新增 0 · `build` ❌ 首屏 gzip 471.4KB > 460.0KB（非基线，t-1348 已修 445.5KB，待集成⑤ 合入后转绿）**。已知基线失败（`cc-switch-ascii-name` ×2、`ocv5-185-qa` 需干净工作树 + junction、`MessageRenderer` beforeAll 冷启偶发）见各轮 §6。

## 集成⑤ 待合清单（t-1237 前置；09-18 00:3x 按 `git rev-list --count c97a750f8..<分支>` 现算）

| 分支 `feat/v5-selfhost-audit-*` | HEAD | 任务 | 未合入 | 远端 | 备注 |
|---|---|---|---|---|---|
| qa-a11y | `eed1f3989` | QA t-1232 | 2 | = 本地 | `77a93d9e1` 4 文件 + 报告；`merge-tree` 试合 `2d2b5cafc` 无冲突 |
| a11y-c | `c35fd00c6` | t-1233 a11y-C（已交付；t-1344 第四手复核 `ea9348b2b`，第五手补 `test:browser` `c35fd00c6`） | 18（11 自有 + 7 对齐合并） | = 本地 | 基线 `36bb9a677` + 七支对齐合并（与集成④ 内容相同，预期零冲突）；全量 `npm test` NOT RUN 交集成⑤ |
| leftover-tut | `69e18aa93` | t-1235 | 3 | = 本地 | `App.tsx` / `useAppRoute.ts` 与 leftover-shell / budget-fix 同文件不同 hunk |
| leftover-shell | `7e7c7e43b` | t-1234 | 6 | = 本地 | 基于 `2d2b5cafc` |
| budget-fix | `65019b5dc` | t-1348 | 2 | = 本地 | 基于 `2d2b5cafc`；合入后 `npm run build` 必须绿（发布门） |
| archive-final（本分支） | 见 SUMMARY §9 | t-897 归档终稿 | 本轮提交 + 已带入 `archive@35e3ec7c9` 的 1 个预写提交 | 交付时推送 | 纯文档；archive 分支不必再单独合入 |
| ~~integ4-rehearsal~~ `522c24988` / ~~release-rehearsal~~ `c1fdc935e` | — | 集成④ 预演 / t-1279 发布预演 | 8 / 8 | 未推 | **不合入**（预演结论已用于 q-1227 与 release-prep 的冲突核对） |

集成⑤ 之后：release-prep（integration 合并 canonical `feat/v5-selfhost@f1952819f` 上游 7 提交 + 部署前置核对）→ release-deploy（push canonical + 服务器 `deploy-v5-selfhost.sh --preflight/--deploy/--smoke`），按 d-1326 / d-1450 由指挥官全权推进；QA-integ4 t-1236 独立复核待领。以上不在本归档范围，状态以任务库为准。

## 相关决策

- d-24 本轮全部在本地克隆 + 每人独立 git worktree 上做，不走 v5-dev SSH（主克隆 `v5-selfhost`，工作树 `wt\<slug>`，成员只推自己的分支）。
- d-26 提交 subject 禁用 `fix(v5)`，一律 `feat / refactor / style / test / docs(v5)`；不碰 `changelog.json`。
- d-28 UI 审计以 `browser-tests/ui-preview` 截图台为主要证据，每模块 before / after 各一套（PNG 不入库，存 `.audit-tmp\<slug>\`）。
- q-786 归档摘要落 `docs/audit/archive/`，写「归档摘要」而非全量复制。
- q-1076 → A / q-1227 → A 教程同步快照 accept（集成③ 17 项 + 集成④ 1 项，指挥官代用户确认，**待用户终审**，见 SUMMARY §7-1）。
- d-1326 / d-1450（release）端到端上线由指挥官全权推进：push canonical 与服务器 deploy 由指挥官代批，发布通道 root@38.55.252.217 SSH；用户 09-17 22:5x 在线再次确认「尽快搞完上线」。
