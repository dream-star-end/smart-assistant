# v5 个人版审计 · 归档摘要索引

> 本目录是 t-761「归档预整理·按模块归集已完成交付」的产物：每个模块一份**归档摘要**（审出问题 → 修复情况 → 验证摘要 → 遗留 → 分支 / 提交），每段末尾链回模块负责人维护的正文 `docs/audit/<module>.md`。摘要不复制正文，避免两份漂移。
> 路径按决策卡 q-786 裁决放在 `docs/audit/archive/`（不与各模块分支及 integration 上既有的 `docs/audit/<module>.md` 撞名）。t-632 归档任务据本页写 `docs/audit/SUMMARY.md` 即可。
> 基线 `210b9967`；integration 分支 `feat/v5-selfhost-ocv5-audit-ux`，HEAD `419e0d218`（截至 09-16 22:22）。SHA 均为分支上实际提交的短哈希。

## 模块索引

| 模块 | 任务（A / B / 二期·补丁） | 分支 | HEAD | 发现 | 已修 | 遗留（归属内） | 状态 | 摘要 | 正文 |
|---|---|---|---|---|---|---|---|---|---|
| shell 应用壳层与设计系统 | t-30 / t-31 / — | `feat/v5-selfhost-audit-shell` | `39697560b` | 20（P1 1 · P2 8 · P3 11） | 18 + 半条 1 | 2 暂缓（S-08、S-20，等用户拍板） | 已合入（集成①起点） | [shell.md](./shell.md) | [../shell.md](../shell.md) |
| messages 消息渲染与时间线 | t-32 / t-33 / t-629 | `feat/v5-selfhost-audit-messages` | `2abe389a9` | 25（P2 4 · P3 21） | 22 | 3（M-21 / M-24 / M-25） | B 已合入（集成①）；二期**待验收** | [messages.md](./messages.md) | [../messages.md](../messages.md) |
| composer 输入区 / 会话头 / 模型与目标 | t-34 / t-35 / — | `feat/v5-selfhost-audit-composer` | `70d3db8b3` | 35 + 承接 M-16 | 32 | 4（C-16 / C-26 / C-30 / C-32 团队卡） | 已合入（集成②） | [composer.md](./composer.md) | [../composer.md](../composer.md) |
| sidebar 侧栏 / 会话 / 项目 / 站内信 / GitHub | t-36 / t-37 / t-627 | `feat/v5-selfhost-audit-sidebar` | `25c775295` | 正文统计 38（P2 12 · P3 26；编号行 50，见摘要注） | P2 全部 + 二期 S-14（正文未给逐条计数） | 0；需后端 2（UCP-01 / GH-03） | B 与二期均已合入（集成① / ②） | [sidebar.md](./sidebar.md) | [../sidebar.md](../sidebar.md) |
| manage 管理中心 | t-38 / t-39 / t-426（补丁①）· t-626 | `feat/v5-selfhost-audit-manage` | `26b865e2f` | 27（P1 1 · P2 8 · P3 18）+ 跨模块 3 | 22 + 补丁① 4 + 二期 1 | 2 需后端（M-17 / M-06 ③） | B 已合入（集成①）；二期**在跑** | [manage.md](./manage.md) | [../manage.md](../manage.md) |
| settings 设置中心 / 组织 / 支付 | t-40 / t-41 / t-426 · t-628 | `feat/v5-selfhost-audit-settings` | `5eac1b807` | 43（P2 12 · P3 31） | 41 + 二期 4 项 | 需后端 2（SET-09 / SET-10）· 跨模块 2 · 不修 3 | B + 补丁① 已合入（集成②）；二期待集成③ | [settings.md](./settings.md) | [../settings.md](../settings.md) |
| taskboard 任务面板 | t-42 / t-43 / t-630 | `feat/v5-selfhost-audit-taskboard` | `05dd185df` | 30（P1 2 · P2 14 · P3 14） | 27 + 2 部分 + T-02 由 sidebar 修 | 2 部分（T-20 shell 类型 / T-28 后端约束） | B 已合入（集成①）；二期**待验收** | [taskboard.md](./taskboard.md) | [../taskboard.md](../taskboard.md) |
| tools 工具卡 / 智能体过程 / 检查器 | t-44 / t-45 / — | `feat/v5-selfhost-audit-tools` | `d65c6741e` | 31（P1 1 · P2 7 · P3 23）+ 跨模块 4 | 31 | 0 | 已合入（集成②） | [tools.md](./tools.md) | [../tools.md](../tools.md) |
| market AI 市场 | t-46 / t-47 / t-625 | `feat/v5-selfhost-audit-market` | `1fb99bfcc` | 26（P1 1 · P2 4 · P3 21） | 13 | 13（全部 P3） | B 已合入（集成②）；二期**在跑** | [market.md](./market.md) | [../market.md](../market.md) |
| landing 落地页 / 登录 / 法务 / 桌面端登记 | t-48 / t-49 / — | `feat/v5-selfhost-audit-landing` | `b97adb3fb` | 20（P2 3 · P3 17）+ 跨模块 3 | 16 + 2 部分 | 2（L-11 shell 用例 / L-16 ② 产品） | 已合入（集成②） | [landing.md](./landing.md) | [../landing.md](../landing.md) |
| media 图片 / 媒体 / 容器网页预览 | t-50 / t-51 / — | `feat/v5-selfhost-audit-media` | `8834aca08` | 27（P1 2 · P2 11 · P3 14） | 25 | 2（M-25 需后端 / M-27 shell） | 已合入（集成②） | [media.md](./media.md) | [../media.md](../media.md) |
| tutorials 教程中心 | t-52 / t-53 / — | `feat/v5-selfhost-audit-tutorials` | `5bf80f0bc` | 37（P2 12 · P3 25） | **待补 t-53** | 待补 | A 已完成；B **在跑**；未合入 | [tutorials.md](./tutorials.md) | [../tutorials.md](../tutorials.md) |

「已修 / 遗留」以各模块正文修复记录 / 遗留章节为准，摘要只转录计数；跨模块转出项在对方模块的摘要里登记闭环状态。

## 集成分支合入记录（`feat/v5-selfhost-ocv5-audit-ux`）

| 轮次 | 任务 · 执行 | 起点 / 合并提交 | 接线 · 用例 · 记录 |
|---|---|---|---|
| 集成① | t-399 · fable-5-1-21 | 起点 `e6f73dd99`（已含 shell-B `de38a312c`…`39697560b`）；`3cff04c85` sidebar-B @`ef872e91a` · `09a13a472` manage-B @`af79d7b05` · `bf8188def` taskboard-B @`0b06f7ce5` · `985b3ae57` messages-B @`d2f84063d` | `678fe9d38` App 接 sidebar-B S-05/S-06/S-08/UUS-01 · `09d15400f` `useChatSocket` 空标题（ST-01）· `1ae92b831` 两处既有用例随契约更新 · 记录 `43b7cd3a4`（[../INTEGRATION.md](../INTEGRATION.md)） |
| 集成② | t-624 · fable-5-1-52（**在跑**，分支上提交已到 `419e0d218`） | `5e5ed6925` settings-B + 补丁① @`c0efc9c91` · `6fa690d7e` tools-B @`d65c6741e` · `ab765669a` market-B @`1fb99bfcc` · `6201518b2` landing-B @`b97adb3fb` · `10398baa9` media-B @`8834aca08` · `b41e804ac` sidebar 二期 @`25c775295` · `ae0b0cb64` composer-B @`70d3db8b3` | `19799c0fe` App 接线（market `onRequireLogin` / tools T-18 选中态 / composer 去授权入口 / brand `contactEmail`）· `f7c08f3eb` 既有用例随契约更新（App.test 登录控件按标签取、media.test Radix 开合、market 场景 import 后缀）· `419e0d218` 仓根 `.gitattributes` 教程夹具 `-text`（TU-36）· 记录**待补** |
| 集成③ | integ3（待领，等前置 6 条） | 待合入：media-B 之后的余项 / tutorials-B / 全部二期分支（messages `2abe389a9`、manage `0a47b4948`…`26b865e2f`、settings `8b2636e94`…`5eac1b807`、taskboard `cb6629bd1`…`05dd185df`、market 二期）| 待补 |

全量门（typecheck / `npm test` / `test:browser` / ui-preview 118 场景 350 张）在集成①记录 §5，已知基线失败（`tutorialShowcase` autocrlf、`cc-switch-ascii-name`、`ocv5-185-qa` symlink、`MessageRenderer` beforeAll 并行超时）在 §6。

## 待补占位（本索引与各摘要中标「待补」的项）

| 项 | 等什么 |
|---|---|
| market 二期 | t-625（fable-5-1-57，在跑） |
| manage 二期验收 | t-626（fable-5-1-54，在跑；分支上代码提交已在） |
| messages 二期验收 | t-629（待验收） |
| taskboard 二期验收 | t-630（待验收） |
| tutorials 阶段 B | t-53（fable-5-1-54，在跑） |
| 集成② 记录 / 全量门 | t-624（fable-5-1-52，在跑） |
| 集成③ / SUMMARY.md | integ3 / t-632（待领） |

## 相关决策

- d-24 本轮全部在本地克隆 + 每人独立 git worktree 上做，不走 v5-dev SSH（主克隆 `v5-selfhost`，工作树 `wt\<slug>`，成员只推自己的分支）。
- d-26 提交 subject 禁用 `fix(v5)`，一律 `feat / refactor / style / test / docs(v5)`；不碰 `changelog.json`。
- d-28 UI 审计以 `browser-tests/ui-preview` 截图台为主要证据，每模块 before / after 各一套（PNG 不入库，存 `.audit-tmp\<slug>\`）。
- q-786 归档摘要落 `docs/audit/archive/`，写「归档摘要」而非全量复制。
