# 在飞轮尾部优先水合（Tail Unit Hydrate）

- 日期：2026-08-20
- 状态：方案审 FAIL 已闭合（B1/B2/B3 冻结）→ 修订 + 实施（PR1+PR2，无 checkpoint）
- 环境：新个人版 V5 自用（uid=3，`openclaude-v5-selfhost`）
- 工作树：`/opt/openclaude/worktrees/v5-selfhost-inflight-tail-hydrate`（分支 `feat/v5-selfhost-inflight-tail-hydrate`；文档 `docs/design/2026-08-20-inflight-tail-unit-hydrate.md`）
- 产品方向（老板拍板）：点开会话默认先只加载**最后一个 agent 响应**的最新约 20 条**可渲染内容**（无论该轮是否在跑）；用户上滑再向上懒加载更早内容。
- 产品契约：点开在飞会话 **2s 内看到当前这一轮过程**，不可破。
- 红线：leftover `legacy:*` 永不进热路径；禁止把原始尾页当 snapshot（审计 B2：reducer 需要完整 delta）；tape / 计费 / 物化语义零改动。

---

## 审闭合（冻结的 3 条 blocker，diff 审只按此 + §6）

后续 diff 审查只对照本节 + §6 契约，不再新开边界。

### B1 降级路径假完成 — 闭合方式（§2.4、§3.1、§4.1）

- **禁止** 400ms CPU 假完成。无 checkpoint 时只能正向归并到流尾。
- 硬顶 **5s**（`LIVE_UNITS_REDUCE_DEADLINE_MS`）。6.5k 帧实测约 1s CPU，可接受。
- 超顶：`degraded: "fallback"`，**不带 `resume`**。客户端必须走旧 `after=0` 全量路径；占位继续显示。
- `resume.frameSeq` **只能在真实到达流尾后下发**，禁止用已 reduce 的前缀水位冒充。
- catch-up **不允许省略**：snapshot 归并后必须再查 `record_id > last` 一次，把这期间新持久化的帧 continue-reduce 进同一状态，然后才 mint resume。客户端首包后也必须 `GET after=resume.recordId` 补页（WS 不补发订阅前已持久化的帧）。

### B2 checkpoint/reduce 状态被显示窗口污染 — 闭合方式（§2.3、§2.4）

- **归并状态与线上视图分层**。`reduceLiveFrames` / 未来 checkpoint 永远存**完整折叠态**：全部子块、完整 payload 或 payloadRef。
- K 窗口、64KB 单块 preview、512KB 首包预算 **只在 `serveLiveUnits` 响应整形时应用**。
- catch-up 等价测试覆盖「跨窗口引用」：`tool_use` 在 K 窗外、随后 `tool_result` 在窗内 → continue-reduce 必须 join 到原块，结果与全量 reduce 相等。

### B3 首包无总字节硬预算 — 闭合方式（§2.3、§3.1、§8）

- 首包 **序列化后硬预算 ≤512KB**（`LIVE_UNITS_FIRST_PACK_MAX_BYTES`，可配置）。
- 超预算确定性裁剪顺序：最大 payload 先降为 preview+payloadRef → 再缩组内 K → 再缩 N。
- **open 组卡 chrome 永不裁掉**（可清空 children，但卡本身必须在）。
- 对抗性夹具：20 张各 8–60KB 父工具卡 + 4 个 open 组 ×20 个子块，全部低于 64KB 单块阈值，序列化后仍 ≤512KB。

### 两条 warning（已做，不阻塞）

- before 分页：单元稳定 `id`；open 组卡只出现在首包，before 页跳过仍 open 的组卡；客户端 prepend 再按 ID 去重。
- `payloadRef` 懒加载：`GET /live-frames/payload?recordId=&sha256=` 先读 live frame，剪枝后按 `content_sha256` 回落到 tape。`choosePayloadRefSource` 锁 live→tape 顺序。

**本修订不做 checkpoint（原 PR3）**：先发布 PR1+PR2 现算路径。若真机手机视口 TTFU ≥1.5s 再上 checkpoint；checkpoint 必须存完整折叠态（B2），迁移号 fetch 后领。
- 环境：新个人版 V5 自用（uid=3，`openclaude-v5-selfhost`，live `rel-3e7b3216a` / sourceCommit `3e7b3216a`）
- 工作树：`/opt/openclaude/worktrees/v5-selfhost-inflight-tail-hydrate`（分支 `feat/v5-selfhost-inflight-tail-hydrate`；文档 `docs/design/2026-08-20-inflight-tail-unit-hydrate.md`）
- 产品方向（老板拍板）：点开会话默认先只加载**最后一个 agent 响应**的最新约 20 条**可渲染内容**（无论该轮是否在跑）；用户上滑再向上懒加载更早内容。
- 产品契约：点开在飞会话 **2s 内看到当前这一轮过程**，不可破。
- 红线：leftover `legacy:*` 永不进热路径；禁止把原始尾页当 snapshot（审计 B2：reducer 需要完整 delta）；tape / 计费 / 物化语义零改动。

---

## 0. 取证摘要（真实数字）

取证时刻：2026-08-20 22:08–22:20 CST。只读 PG / gateway 日志 / 源码。未写库、未重启、未发布。未向用户真实会话发消息。未新开 Playwright 探针（当晚 21:32 手机打开的生产请求链已足够作为真浏览器样本）。

### 0.1 样本轮

| 会话 | 标题（截断） | dispatch | 状态 | 模型 | 开始 | 时长 | 帧数 | payload 字节 |
|---|---|---|---|---|---|---|---|---|
| `webmt1j5mw8ie9gtt` | 教程功能整体废弃…（4 委派 run） | `0ae5389f-…a84fa7` | accepted 在飞 | gpt-5.6-sol-1m | 21:02:21 | >65 min | **6526→6572**（调查中仍在涨） | **19.7–20.1 MB** |
| `webmt1c2q0xsbrwk7` | 会话列表颜色点是否持久化 | `2baf92b4-…05c31d` | accepted 在飞 | cursor-opus-5-high | 19:01:26 | >3 h | 2278 | 3.11 MB |

21:32 手机打开的就是 `webmt1j5mw8ie9gtt`：gateway 日志 `2026-08-20T13:31:56Z`–`13:32:26Z` 对该 session 连续 7 次 `GET /live-frames` 200。该会话 leftover 流 **0 条**（只有一条 `dispatch:<id>:1` live 流）。符合 2026-08-19 热路径只读当前 open dispatch。

第二样本同样是 4 个 `delegate_progress` run。

### 0.2 帧类型占比（`webmt1j5mw8ie9gtt` / dispatch `0ae5389f`，约 6510 帧时）

| wire type / block.kind | 帧数 | 字节 | 帧占比 | 字节占比 | 均帧 | 最大单帧 |
|---|---:|---:|---:|---:|---:|---:|
| `outbound.message` / **delegate_progress** | 6138 | 18.91 MB | 94.3% | 93.4% | 3.1 KB | **746 KB** |
| `outbound.message` / tool_result | 46 | 1.15 MB | 0.7% | 5.7% | 25 KB | 77 KB |
| `outbound.message` / tool_use | 46 | 67 KB | 0.7% | 0.3% | 1.5 KB | 9 KB |
| `outbound.message` / thinking | 104 | 43 KB | 1.6% | 0.2% | 416 B | 455 B |
| `outbound.turn_usage` | 115 | 42 KB | 1.8% | 0.2% | 368 B | — |
| `outbound.call_usage` | 55 | 27 KB | 0.8% | 0.1% | 484 B | — |
| `outbound.message` / plan | 2 | 2 KB | ~0 | ~0 | — | — |
| **合计** | ~6506 | ~20.1 MB | 100% | 100% | — | — |

thinking 的 `text` 长度在 2–59 字之间跳动、**不随 seq 单调变长** → 增量 delta，拼原始尾页得不到完整思考段（B2 实锤）。

`delegate_progress` 同 `runId` 三帧对照（`dlg-mt1jtfsg-5a6ccb96` / general-assistant）：

| frame_seq | bytes | phase | 形态 |
|---:|---:|---|---|
| 1417 | 3134 | start | goal + text，无 nested `block` |
| **3834** | **746021** | tool | nested `block` = 完整 `tool_result`（output/outputJson/preview） |
| 5643 | 2898 | done | 1520 字 summary，**没有** nested `block` |

last-wins 最后一帧会丢掉 746 KB 工具输出。这就是 B2 在委派卡上的具体形状。

粗 fold（按 `toolUseBlockId` last-wins + 拼接 text，**未**走完整 `appendSubagentBlock`）得到该 run **折叠 JSON ≈ 10 MB、1376 个 nested tool 键**。说明：即便归并成「一张委派卡」，卡内历史子块仍可能极大。真 reducer 会对同 `blockId` 的 `tool_use`/`tool_result` 原地更新（`reducer.ts` `appendSubagentBlock`），子块数会少于 1376，但单条 tool_result 仍可达数百 KB。设计必须把「卡」和「卡内子行」分层。

第二样本 `2baf92b4`：2278 帧 / 3.1 MB；delegate_progress 69.5% 帧 / 79% 字节；同样 4 个 run；另有 thinking 286、text 46、tool_use 23、tool_result 22。

### 0.3 打开链路耗时拆解（21:32 真手机打开）

前端水合：`getSessionLiveFrames(..., after, limit=500)`，`LIVE_JOURNAL_OPEN_CURSOR="0"` 正向翻页，最多 `LIVE_JOURNAL_MAX_PAGES=24` 或 `LIVE_JOURNAL_MAX_MS=30_000`。首屏 **stage 全部分页再一次性 `applyDurableLiveFrames`**。

gateway access（该 session，13:31:56–13:32:26Z）：

| # | ts (UTC) | durationMs | 与上一请求间隔 |
|---:|---|---:|---:|
| 1 | 13:31:56.507 | 211 | — |
| 2 | 13:31:59.693 | 186 | 3.19 s |
| 3 | 13:32:01.913 | 398 | 2.22 s |
| 4 | 13:32:06.104 | 511 | 4.19 s |
| 5 | 13:32:17.984 | 593 | **11.88 s** |
| 6 | 13:32:23.687 | 293 | 5.70 s |
| 7 | 13:32:26.986 | 686 | 3.30 s |

- 墙钟 **30.5 s**，打满 `LIVE_JOURNAL_MAX_MS=30s` → 大概率 `degraded=true`（浅底条「实时内容未完全加载」）。
- 服务端 duration 合计约 2.9 s；**间隔合计约 27.6 s 在客户端/传输**。
- 当时轮已跑 ~30 min。按后来 ~99 帧/分钟外推，21:32 约 **2900–3500 帧 / 6–7 页 ×500**，与 7 次 GET 吻合。

当日该 session 全部 live-frames：n=49，min=10 ms，p50=398 ms，p95=**2990 ms**，max=**5301 ms**，duration 合计 36.5 s（含后续后台对账翻页）。

同机 SQL（22:10 CST，6526 帧时）：

| 操作 | 耗时 | 体积 |
|---|---:|---|
| `after=0 LIMIT 500` EXPLAIN | **25.7 ms** | 返回 500 行；**Bitmap Heap 扫了全部 6526 行**（统计值 rows=552 严重偏低，选了 top-N sort） |
| 同上 payload `sum(length)` | 21 ms | **880 KB** raw bytea |
| 第 2 页 `record_id > cursor LIMIT 500` | **1.9 ms** | Index Only Scan + Limit，正常 |
| 500 帧：psql 取出 + JSON.parse + 包一层 serialize | 205+26+73 ms | 序列化 **1.03 MB** |
| 全量 6545 帧取出 + parse + serialize | 1402+816+788 ms | 序列化 **23.2 MB**；再 parse 931 ms |
| 粗 reduce → 104–115 个父级单元 | parse 后 ~0.9–1.0 s | 全量折叠 JSON ~1.3 MB（未含委派卡完整子块） |

gateway 未发现对 live-frames 做 gzip（`server.ts` 无 compression 命中）。

### 0.4 「正在恢复实时内容…」条件

文案只出自 `TurnActivity`（`packages/web-react/src/components/chat/TurnActivity.tsx`）：

```text
recoveryKind === "waiting-service" || recoveryKind === "retrying"
  → 「正在恢复实时内容…」
```

置位：

1. 从 IndexedDB 恢复 `_sendingInFlight` 的在飞会话：`_recoveryStatus = { kind: "waiting-service" }`（`socket.ts` ~2956）。
2. `startContinuousReconcile` / `runContinuousReconcile` 每次对账。

消失：

1. **首条热 WS `onLiveFrame`**：若仍在 `_reconciling`，立刻 `resumed` 并停对账。
2. `finishRestoreIfReady` → `resumed`/`completed`。对**仍是 live owner 的在飞轮**，`restoreExitDecision` **不会**因「已经有可见正文」退出；要等 `RESTORE_RECONCILE_MAX_ATTEMPTS=8` 或 `RESTORE_RECONCILE_MAX_MS=45s`，或等到 WS 帧。
3. 成功对账但 turn 仍在飞时，代码把状态写成 `retrying`——**同一句占位文案继续显示**，同时 1s 一次再拉 live-frames。

因此：占位不是「等首包」，而是「等整段 after=0 正向水合结束 + 再等到 WS 或 45s」。大轮上等于卡死在「正在恢复」。

另有浅底条 `JournalHydrationRetry`（「实时内容未完全加载…」）：页数/30s 封顶或单页 12s abort。21:32 这条链会同时触发。

### 0.5 主导瓶颈（按贡献排序）

1. **传输 + 主线程 JSON.parse / 暂存**（21:32 间隔 27 s / 墙钟 30 s）。6–7 页 × ~1 MB，手机链路。第 5 页间隔 11.9 s 无法用 593 ms 服务端解释。
2. **首屏必须 stage 全量再 reduce**：`hydrateDurableLiveFrameJournal` initial 路径把所有页推进数组，最后才 `applyDurableLiveFrames` → `dispatch` → `reducer.ts`。在此之前时间线没有当前轮过程。
3. **服务端 JSON 序列化**（单页 200–700 ms，长大轮 p95 3 s / max 5.3 s）。SQL 不是主因（首页 26 ms，后续页 2 ms），但首页计划因统计过期会扫全流（仍只需 26 ms）。
4. **占位状态机**把「对账中」和「还没有可渲染过程」绑在一起，水合结束后若 WS 稍慢，占位还能再挂到 45 s。

**不是** leftover 全量回放（该会话无 leftover）。**不是** tape GET（历史通道已秒开）。**不是** 今天的 DOM 窗口本身（窗口在 reduce 出 `renderItems` 之后才切 80 行；慢在 reduce 之前）。

未取证到的项：

- 无真 Chromium Performance API 主线程火焰图（前端 reduce vs 布局 vs parse 的毫秒切分）。用 21:32 请求间隔作上界。
- 无 HTTP `Content-Length`/nginx 字节日志（gateway http 行只有 `durationMs`）。体积用 PG payload + 本地 JSON.dumps 代替。
- 未把 6545 帧丢进真实 `reducer.dispatch` 计时（避免在生产路径跑副作用）；粗 Python reduce ≈ 1 s，真实 reducer 会更重（委派卡 `appendSubagentBlock`、索引重建）。
- 未新建长任务探针会话（会耗真实模型配额）；21:32 生产打开已覆盖「手机打开在飞大轮」。

---

## 1. 目标与非目标

### 目标

- 打开任意会话（在飞或刚结束、tape 尚未取代 live 之前）时，**最后一个 agent 响应**的时间线先出现**最新约 20 条可渲染单元的完整内容**。
- 2s 内能看到「当前这一轮在干什么」（思考段 / 工具卡 / 委派卡），而不是转圈。
- 上滑与今天已上线的普通 DOM 窗口（`TIMELINE_INITIAL_TAIL_ITEMS=80` + 「查看更早」）是**同一套**扩窗，不是第二套虚拟列表。
- 热 WS 从明确 seq 边界续流：不重、不漏、不乱序。
- 水合中途 live→tape 收敛：不双份、不丢尾。

### 非目标

- 不改 tape 物化、计费、`projection_source` 切换事务、leftover 是否删除。
- 不把 leftover `legacy:*` 拉回热路径。
- 不回退已完成轮的 `GET /api/sessions` tape 打开路径。
- 本设计不把 virtuoso 请回来。

---

## 2. 可渲染单元（B2 合规归并）

### 2.1 定义

一帧 `outbound.message.blocks[0]` 是 **delta 或相位事件**，不是时间线行。可渲染单元是 `reducer.ts` 应用到会话后用户能看见的一行（与 `coalesceTeam` 之前的物理行对齐，委派组是一行 group card）：

| 单元 kind | 归并规则（必须与 `reducer.ts` 同位） | 完整性 |
|---|---|---|
| `thinking` | 连续 thinking delta 拼到当前段；被其它 kind 打断则新开一段 | 整段 text |
| `text` | 同 thinking | 整段 text |
| `tool` | `tool_use` 按 `blockId` 原地更新（含 `partialJson`）；`tool_result` 按 `toolUseBlockId` 合并到同一卡 | 完整 input + output |
| `plan` | 累进 steps | 完整 plan |
| `agent_group` | `delegate_progress` 按 `runId` 落到一张组卡：`start` 建卡，`text`/`thinking` 拼到子块，`tool` 走 `appendSubagentBlock`，`done`/`error` 只标终态+preview，**不得覆盖/丢弃已落入的子块** | 组卡 chrome + 子块（见 2.3） |
| 其它 `outbound.*` | usage/status 不是时间线行；只更新侧车状态，不占 N 的名额 | — |

**禁止**：把 `ORDER BY record_id DESC LIMIT K` 的原始帧当首屏。委派卡最后一帧经常是 `phase=done` 的 3 KB summary。

N 默认 **20**，指**父级时间线单元**（不是原始帧，也不是组卡内全部历史子工具）。查询参数 `n`，服务端 clamp 1–80（80 = 前端已有首屏窗口，避免首包比 DOM 窗口还大）。

「最后一个 agent 响应」= 当前 open dispatch 的 `client_message_id` 对应那一轮。无 open dispatch 时热路径返回空，历史仍走 tape（现契约不变）。

### 2.2 尾部语义（必须含「仍在更新的旧单元」）

单元在时间线上的位置 = **首次成为可渲染行的 frame_seq**（`seq_first`）。委派卡可能在 seq=37 出现、seq=6460 仍在更新。

若「最新 20 条」只按 `seq_first` 取尾：本样本 115 个父级单元里 4 张委派卡分别在 idx 8/11/78/79，**最后 20 条里一张都没有**。用户打开 4 智能体在飞轮会只看到父助手最近的 thinking/tool，看不到正在跑的委派卡——违反 2s 看「当前这一轮过程」。

首包集合 =：

```
tail = 按 seq_first 排序的最后 N 个已封闭或仍开放的父级单元
open = 仍在更新的单元（未 done 的 thinking 段、未完成 tool、未 done/error 的 agent_group）
first_pack = uniq(tail ∪ open)  再按 seq_first 排序
```

本样本：`last20 ∪ 4 张委派卡` ≈ 24 行父级单元。这就是「最新约 20 条」在团队轮上的自然膨胀，允许略超 N，但必须有上限（建议 `N + open_groups`，open_groups 经验上 ≤ 8）。

### 2.3 组卡内子行：第二层窗口

一张 `agent_group` 在 reducer 里是 **一条** 时间线消息，但 `childBlocks` 可以有几十到上千个工具子块。把整张卡的完整子块塞进首包，可能回到 MB～10 MB 量级，2s 契约再次被单卡打穿。

组卡首包只带：

- 组 chrome：`runId`、`agentId`、`goal`、phase/status、`_resultPreview`
- **该组内最新 K 条已归并子块**（K 默认 = N = 20；thinking/text 段算 1 条，tool 卡算 1 条）
- `nestedHasMoreBefore` + `nestedBeforeCursor`（该组更早子块）

超大单条子块（本样本 746 KB `tool_result`）：

- **reduce 状态仍保留完整 output/outputJson**（B2）。
- 首包 serving 把 >64 KB 字段改成 `preview` + `payloadRef`（record_id + sha256）。卡片结构完整，大 payload 可延后。
- **另外**有整包 512KB 硬预算（B3）：即便每块都 <64KB，总包超预算仍按「最大 payload → K → N」裁，open 组 chrome 不裁。

### 2.4 归并执行位置：查询时现算（v1）；checkpoint 仅当 TTFU 不达标

| 方案 | 6k 帧成本 | B2 | 写路径风险 | 建议 |
|---|---|---|---|---|
| A. 只现算 | 每次打开扫全流、parse ~20 MB、reduce ~1 s | 正确（完整态） | 无 | **v1 采用**。硬顶 5s，超顶 fallback，不假完成 |
| B. 只物化热快照行 | 读 O(N 单元) | 正确，若 snapshot 与 reducer 同位 | 拖慢 `persistGatewayLiveFrame` | 不作同步写 |
| C. 混合 checkpoint | 读 = snapshot + catch-up | 正确 **当且仅当 checkpoint 存完整折叠态** | 异步、可丢、可重建 | TTFU 不达标再上；禁止把 K 窗口写入 checkpoint |

**写路径（若做 checkpoint）**

- 不在 `persistGatewayLiveFrame` 的同一事务里做 reduce。
- `units_jsonb` 必须是完整折叠态（全部子块、完整 payload 或 payloadRef）。K/preview 禁止写入 checkpoint。
- 与帧的关系：checkpoint 是派生缓存。丢了就现算。不参与计费、不参与 tape hash。
- `reducer_epoch`：共享归并函数的 semver；升级则忽略旧 checkpoint。

**读路径（v1，无 checkpoint）**

1. 热路径仍用 `OPEN_DISPATCH_STREAM_SQL`（leftover 永不进）。
2. 一次性扫当前 open dispatch **全部帧** reduce。
3. **强制 catch-up**：另开事务 `record_id > last` 再读一轮，`continueReduceLiveFrames` 进同一状态。这步不可省略。
4. 现算预算：硬超时 **5s**。超时返回 `degraded:"fallback"`、空 units、**无 resume**。客户端回退 after=0，占位不消失。
5. 成功到达流尾才 `resume.frameSeq = throughFrameSeq`。serving 再切 N∪open、K、512KB。

缓存：v1 无 checkpoint 行。live→tape 时 payloadRef 懒加载改读 tape（`readLiveOrTapeFramePayload`）。

---

## 3. API 契约

### 3.1 新查询（新客户端）

```
GET /api/sessions/:id/live-frames?view=units&n=20
```

响应（示意）：

```json
{
  "view": "units",
  "units": [ /* 完整可渲染单元，时间线序，含 open ∪ tail */ ],
  "n": 20,
  "hasMoreBefore": true,
  "beforeCursor": "u:1416",
  "streamClientMessageIds": ["m-mt1j5mw8-ed-urov"],
  "openDispatch": true,
  "hasTapeProjection": false,
  "tapeProjectionVersion": 0,
  "resume": {
    "sessionKey": "agent:main:webchat:dm:webmt1j5mw8ie9gtt",
    "frameSeq": 6572,
    "recordId": "1711869"
  },
  "reducerEpoch": "1",
  "throughFrameSeq": 6572,
  "degraded": false
}
```

向上翻页：

```
GET /api/sessions/:id/live-frames?view=units&n=20&before=u:1416
```

组卡内更早子块：

```
GET /api/sessions/:id/live-frames?view=units&group=dlg-mt1jtfsg-5a6ccb96&nestedBefore=c:12&n=20
```

`beforeCursor` 编码：`u:<seq_first>`（父级）/ `c:<childIndex>`（组内）。不暴露原始 `record_id` 给「内容窗口」，以免客户端又按帧去拼。

`degraded` 是 `false | "fallback"`。`"fallback"` 时 **omit `resume`**，客户端必须走旧 after=0。序列化后 body 硬预算 512KB（B3）。

payloadRef 懒加载：

```
GET /api/sessions/:id/live-frames/payload?recordId=&sha256=
```

先 live `record_id`，miss 后 tape `content_sha256`（live→tape prune 后不得悬空）。

### 3.2 旧查询（回滚 / 老客户端）

```
GET /api/sessions/:id/live-frames?after=0&limit=500
```

行为保持今天：原始帧正向页。`seek=tail` 仍仅显式 opt-in，且**仍然不是 snapshot**。

缺 `view=units` ⇒ 旧行为。这是一键回滚面（见 §7）。

### 3.3 热 WS

不改帧写入与广播。水合完成后客户端用 `resume.frameSeq` 作为 reducer 游标：

- `lastDurableFrameSeqBySessionKey[sessionKey].frameSeq = resume.frameSeq`
- 随后 WS 帧 `frameSeq <= resume.frameSeq` 丢弃（现有 dedupe）
- `frameSeq = resume.frameSeq + 1 …` 正常 `dispatch`

首包 units 已经是 `throughFrameSeq` 处的完整折叠态；WS 只应用之后的 delta。若 WS 在 REST 返回前到达：缓冲，等 `resume.frameSeq` 落地再放行（今天 initial hydrate 对 WS 也有 snapshot→reset 竞态处理，保持同一闸门，只是闸门从「全部分页结束」提前到「首个 units 包应用结束」）。

---

## 4. 续流与 live→tape

### 4.1 不重不漏不乱序

| 事件 | 处理 |
|---|---|
| REST units 包 | 重置该 cmid 的 client-owned 行（保留 today 的 `preserveStreamingPointer` 规则），把 units **直接写成** 已 reduce 的消息/组卡，不走逐帧 `dispatch` |
| 随后 WS | 只接受 `frameSeq > resume.frameSeq` |
| REST 后 catch-up 页 | **必须** `after=resume.recordId` 的原始帧小页。不可省略。走同一 frameSeq dedupe |
| 多标签 | 每个 tab 独立 hydrate；checkpoint 共享。两 tab 各自 resume.frameSeq 以各自响应为准，写入仍是同一流，dedupe 按 sessionKey+frameSeq |

### 4.2 水合中途 complete

今天靠 `tapeProjectionVersion` + `applyTapeProjection()`（再 GET `/api/sessions`）。保留：

- units 响应仍带 `tapeProjectionVersion` / `hasTapeProjection` / `streamClientMessageIds`
- 若水合发出时 dispatch 仍 open，响应到达时已 tape：`streamClientMessageIds` 为空且 version 前进 → 走现有 tape 补拉，**丢弃**未应用的 units 包（tape 是权威）
- 若 units 已应用、随后 WS 终态 / version 前进：现有 `applyTapeProjection` 用 server-authored 行替换 client-owned 行（`_source==='server'` / `_turnTapeId` 已保留）。units 写入的行必须打上与 journal replay 相同的 owner 标记（`_clientMessageId`、非 server），以便 tape 替换时能清掉，避免双份
- 丢尾防护：tape GET 失败时保留已画的 units 尾包 + 现有降级条，不把会话画成欢迎页（C3）

### 4.3 完成轮打开

无 open dispatch → units 接口返回 `units: []`、`openDispatch: false`。前端不进热水合，只画 tape。与 2026-08-19 读模型一致。

---

## 5. 前端协同

今天 `MessageRenderer` 已经是：全量普通 DOM + 首次有内容冻结 `windowStart` 为最近 80 行 + 上滚/按钮每次扩 80 + `windowStart===0` 才 `onLoadOlder` + stick-to-bottom。

合并成一套，不新开窗口机制：

1. **首包 units 直接变成该 turn 的 `messages` 尾部**（不是再喂 6000 帧）。`renderItems` 只有几十行，`TIMELINE_INITIAL_TAIL_ITEMS=80` 不会裁掉首包。
2. `hasMoreBefore`（热单元）与 `hasOlderHistory`（tape 归档）在同一「查看更早」按钮上分阶段：
   - `windowStart > 0`：只扩本地窗口（现逻辑）
   - `windowStart === 0` 且热 `hasMoreBefore`：请求 `view=units&before=…`，**prepend** 更早单元，走现成 `beginViewportPreserve` / `correctedScrollTop` / `following=false`
   - 热单元翻完（`beforeCursor` 到该 turn 的 seq_first 最小）之后，才把 `onLoadOlder` 交给 tape 归档（现契约）
3. 组卡 `nestedHasMoreBefore`：卡内「查看更早过程」展开，不搅动外层窗口。
4. **占位**：`restoreExitDecision` 增加一条：units 首包已应用且（`openDispatch` 或已有可见过程行）→ 立即 `resumed`，不要等 WS，不要等 45 s。`retrying` 不再复用「正在恢复实时内容…」文案（对账后台静默；有过程行就显示 `computeTypingLabel`）。浅底降级条只在 units 首包失败/超时时出现。
5. 本地窗口冻结规则不变：流式 append 不卸用户正在看的行。units prepend 视为扩窗，不是「首次有内容」。

`hydrateDurableLiveFrameJournal` 伪代码：

```
if (serverSupportsViewUnits) {
  pack = GET view=units&n=20
  applyUnits(pack)           // 写完整行，设 resume.frameSeq
  markRecoveryResumed()      // 占位消失
  // 不再 for-page after=0
  return
}
// fallback: 今天的 after=0 正向分页
```

---

## 6. 既有契约对照

| 契约 | 如何守住 |
|---|---|
| leftover 永不进热路径 | 继续 `OPEN_DISPATCH_STREAM_SQL`；checkpoint 只对 `dispatch:%` 流 |
| 2s 看到当前轮过程 | 首包 O(N 单元) 而非 O(帧)；占位在首包后消失。超 5s 则 fallback 旧路径，不假完成 |
| B2 禁止原始尾页当 snapshot | 服务端完整态归并；K/preview 只 serving；`seek=tail` 仍不是默认 |
| tape/计费/物化零改动 | v1 无 checkpoint；不进 tape hash |
| 完成轮打开不回退 | 无 open dispatch → 空 units + tape GET |
| C1–C4 显示层 | 单轮降级；不因 units 失败把整会话变成欢迎页 |
| B1 resume 水位 | 只在到达流尾后下发；fallback 无 resume |
| B3 首包体积 | 序列化 ≤512KB |

---

## 7. 兼容与回滚

| 组合 | 行为 |
|---|---|
| 新客户端 + 新服务端 | `view=units` |
| 老客户端 + 新服务端 | 不传 `view`，旧 after=0 分页。新服务端必须保持该路径字节级兼容（字段可加不可删） |
| 新客户端 + 老服务端 | 响应无 `view:"units"` → 客户端 fallback after=0 |
| 一键回退 | gateway env `OC_LIVE_FRAMES_UNITS=0`（读路径忽略 `view=units`，当旧接口）。前端同名 flag 或发现 400/缺字段即 fallback。不需要迁数据回滚：checkpoint 表留着也不被读 |
| checkpoint 坏了 | `reducer_epoch` 不匹配或 JSON 校验失败 → 当无缓存，现算 |

---

## 8. 边界清单

| 边界 | 处理 |
|---|---|
| 超大单条（746 KB tool_result） | 组卡/工具卡结构完整；payload >64 KB 预览 + 懒加载全文。验收时必须有「卡在、内容不是空白、展开能看到全文」 |
| N 条不足（轮刚开始） | 有几条回几条；`hasMoreBefore=false`；占位最多等到首包（可能是 0 单元 + 仍 sending → 走 `computeTypingLabel`「思考中」，不再「正在恢复」） |
| 多标签并发打开 | 各 tab 独立 REST；checkpoint 行 `UPDATE` 以 `through_frame_seq` 单调前进（`WHERE through_frame_seq < $new`） |
| 移动端切后台回来 | 今天 foreground 对账会再 hydrate。新路径再拉一次 units 首包（小），用 resume.frameSeq 与内存游标 max 对齐，避免重放。不重建 DOM 窗口的 `windowStart`（用户可能停在中间） |
| 首页 SQL 扫全流 | 统计过期导致 after=0 bitmap 全表；units 现算也会扫流，但只一次且不把 20 MB JSON 吐给手机。phase 2 checkpoint 后打开不再扫。顺手 `ANALYZE` 是运维可选项，不是本设计的门 |
| 水合中 Stop / SERVICE_RESTART | 与今天相同：dispatch terminal → tape 投影 → units 响应变空 → tape GET |
| 组卡 open 且不在 last-N | 强制并入 first_pack（§2.2） |

---

## 9. 测试与验收

### 9.1 单测（必须先红后绿的契约）

**服务端归并**

- thinking 两段被 tool 打断 → 两个单元，text 为拼接结果，不是最后一帧。
- 委派 `start` + 中间 746 KB `phase=tool` + `phase=done` → 组卡仍有该 tool_result 子块，done 只加 preview。**禁止 last-wins done 帧。**
- leftover 流即使存在也不出现在 units 响应（沿用 OPEN_DISPATCH 夹具）。
- 无 open dispatch → 空 units。
- checkpoint epoch 不匹配 → 现算。
- catch-up：checkpoint 停在 seq=100，流到 120 → 只 reduce 20 帧，结果与全量现算相等。

**续流**

- units 应用后注入 `frameSeq = resume` 的 WS 帧 → 丢弃；`resume+1` → 追加不重复。
- 应用 units 过程中 tapeProjectionVersion 前进 → 走 tape，消息不双份。
- 乱序 WS（先 +2 再 +1）保持今天 reducer 行为（不因 units 变得更松）。

**前端**

- 首包到达前才显示「正在恢复实时内容…」；首包后即使 `_sendingInFlight` 也改为阶段文案。
- `hasMoreBefore` 时「查看更早」走 units prepend，scrollTop 用现成 preserve lock。
- 本地 80 行窗口不被第二套逻辑覆盖；units 只有 24 行时窗口不裁。
- 老响应（无 `view`）自动 fallback 分页；断言仍会请求 `after=0`。

### 9.2 真浏览器（含手机视口）

场景：只读打开本设计的样本类会话（4 委派、在飞、≥1 min），或自建探针会话跑长任务（禁止往老板真实会话发消息）。

可测指标（Performance API / gateway 日志 / DOM）：

| 指标 | 目标 | 量法 |
|---|---|---|
| TTFU 首个过程单元进 DOM | **< 1.0 s**（Wi-Fi）；4G 允许 < 1.5 s | `performance.mark`：click session → 第一条 `[data-testid]` thinking/tool/delegate 卡 |
| 尾窗完整（N 条 + open 组卡 chrome） | **< 2.0 s** | 上述 + 组卡 goal/status 可见 |
| 占位「正在恢复实时内容…」最长显示 | **< 1.0 s** 且首包后必须消失 | DOM 文案 |
| 首包 HTTP | 1 次 `view=units`；**body ≤ 512KB** | DevTools |
| 上滑 | 更早单元出现且视口锚点不跳；不触发 tape `onLoadOlder` 直到热窗口耗尽 | 手工 + 日志 |
| live→tape 在打开后 2 s 内完成 | 无双份组卡、无空白欢迎页、console 无 #185 | 选择长轮将完时打开 |
| 切后台 10 s 再回 | 不重放全量；过程续上 | 现成 foreground 用例扩一条 |
| 回退开关 | `OC_LIVE_FRAMES_UNITS=0` 后行为回到 after=0（允许再变慢） | 运维开关 |

回归：今天 MessageRenderer 125 条窗口/贴底用例；live journal chat.test 委派卡套件；`readClientSessionLiveFrames` 的 leftover 过滤 integ。

---

## 10. 实施工作量

不需要为 v1 改生产。落地时建议两 PR，**v1 无迁移**。

### PR1 — 服务端 units 读路径 + 共享归并（约 1200–1600 行）

| 文件 | 大约 | 做什么 |
|---|---|---|
| 新 `packages/protocol` 或 `packages/commercial/src/live/reduceLiveUnits.ts` | 400–600 | 从 `reducer.ts` 抽出 **无 DOM** 的单元归并（thinking/tool/delegate `appendSubagentBlock` 同位）。web-react reducer 改为调用它，避免两套 drift |
| `packages/web-react/src/lib/chat/reducer.ts` | 100–200 改 | 委托给共享函数；行为锁在现有 chat.test |
| `packages/commercial/src/db/liveTurnFrames.ts` | 250–400 | `readClientSessionLiveUnits`；仍用 `OPEN_DISPATCH_STREAM_SQL` |
| `packages/gateway/src/server.ts` | 40–60 | 解析 `view=units`；env 开关 |
| `packages/commercial/src/__tests__/…liveTurnFrames…` | 400–500 | B2 夹具（start/tool/done）、leftover、无 open dispatch、catch-up |
| `packages/web-react/src/lib/chat/chat.test.ts` | 50–100 | 共享函数抽出后的等价锁 |

无 DDL。

### PR2 — 前端首包 + 占位 + 与 DOM 窗口合并（约 800–1100 行）

| 文件 | 大约 | 做什么 |
|---|---|---|
| `packages/web-react/src/lib/api.ts` | 40 | 新查询参数 |
| `packages/web-react/src/lib/chat/socket.ts` | 250–400 | hydrate 走 units；resume.frameSeq；restoreExitDecision；fallback |
| `packages/web-react/src/hooks/useChatSocket.ts` | 20–40 | 传 n=20 |
| `packages/web-react/src/components/MessageRenderer.tsx` | 80–150 | 「查看更早」接 `hasMoreBefore`；不新增窗口常量 |
| `packages/web-react/src/components/chat/TurnActivity.tsx` | 10–20 | 文案不再把对账 `retrying` 当成恢复中 |
| 对应测试 | 400–500 | hydrate / 占位 / fallback / prepend |

### PR3（可选，P1 checkpoint）— 约 400 行 + 迁移 1 张表

`client_session_live_unit_checkpoints` + debounce 更新 + prune 时删除。迁移号按当时 `schema_migrations` 头部领取，写入 `deploy/v5/release-metadata.json` `requiredMigrations`。无此 PR 时 v1 每次打开现算；6k 帧约 1 s CPU，Wi-Fi 仍可能进 2s，手机 4G 偏紧，故大轮要尽快上 checkpoint。

**合计**：v1 ≈ 2000–2700 行，**无迁移**；v1+checkpoint ≈ +400 行 + 1 表。不要在 `persistGatewayLiveFrame` 热事务里做 reduce。

---

## 11. 最值得审计员盯的点

1. **委派卡完整性（B2 的真实形状）**  
   `phase=done` 的最后一帧不是卡。归并必须等同 `applyDelegatePhaseToGroup` + `appendSubagentBlock`（同 blockId 原地更新，done 只标终态）。任何「last frame per runId」实现都应该直接 FAIL。组卡内 746 KB 子块是截断预览还是完整带上，要在契约里写死，避免「完整」被理解成 10 MB 首包。

2. **resume.frameSeq 与 units 折叠态的同一快照**  
   首包 units 必须是 `throughFrameSeq=resume.frameSeq` 的折叠结果。若 checkpoint 停在 6500、catch-up 到 6572、但 resume 写成 6500，WS 会重放 6501–6572，组卡子块双份或 text 双拼。反之 resume 超前会丢尾。live→tape 窗口里 units 行的 owner 标记必须能被 tape 替换清掉。

3. **「最新 20 条」漏掉仍在飞的委派卡**  
   按 `seq_first` 切尾会把 4 张早出现、仍在更新的组卡切掉，2s 契约表面上达标、产品失败。审计应有夹具：父轮已有 100 个 thinking/tool 单元、中间插入 4 个仍 open 的 runId → first_pack 必须含这 4 张卡。

（次级但相关：共享归并函数与 `reducer.ts` drift；`retrying` 占位文案若未改，即使用上 units，用户仍会看 45 s「正在恢复」。）

---

## 12. 建议实施顺序

1. 抽出共享 reduce + 用本样本 `0ae5389f` 的真实帧（脱敏 fixture）做黄金向量：全量 reduce 的父级单元数、4 个 runId、done 后 tool 子块仍在。
2. `view=units` 只读 API + env 开关，旧 after=0 不动。
3. 前端 hydrate 切换 + 占位退出条件 + 「查看更早」接 beforeCursor。
4. 真机打开本样本类在飞轮，看 TTFU / 2s / 占位。
5. 再上 checkpoint 表（若现算 TTFU 在手机上 >1.5 s）。
