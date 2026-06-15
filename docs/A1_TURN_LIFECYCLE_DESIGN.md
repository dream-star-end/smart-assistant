# A1 — Turn 生命周期单一权威源 + server `clientTurnId`（设计文档)

状态:**设计稿,待 Codex 计划审 → 批准后分步实现**。
关联:审计计划 `AUDIT_REMEDIATION_PLAN_2026-06-14.md` 的 A1(W4,高风险,design-doc 先行)。
硬约束:**保留全部现有可见流式行为**(打字指示器、停止按钮、流式增量、重连恢复、切会话),每子步 dev 流式 smoke 通过才进下一步;可回滚。

---

## 1. 背景与根因(基于代码实测,非猜测)

一个"turn"(用户发一条消息 → AI 流式回复 → isFinal 结束)的存活状态,当前由**三套并行表示**承载,且**拆解逻辑复制在 5 文件 ~11 处**,缺少 server 权威 `turnId`,靠跨时钟域比较 + 扫描消息数组把流式帧绑定到 turn。

### 1.1 三套并行的 in-flight 表示
| 表示 | 语义 | 读/写点 | 问题 |
|------|------|---------|------|
| `sess._sendingInFlight` | 每会话:这条会话有 turn 在跑 | 17 读 / 16 写 | 与下面两个手动同步,易漂移 |
| `state.sendingInFlight` | 全局 UI:**当前**会话是否在跑(驱动发送/停止按钮、打字指示器、自动滚动) | 16 读 / 14 写 | 是 `sess._sendingInFlight`(当前会话)的派生量,却被独立赋值 |
| `state._reconnectInFlightSet` | 重连安全:重连时仍在跑的 sessionId 集合 | 2 读 / 5 写 | 第三套真相,仅重连用 |

> 还有两个 turn 绑定辅助量:`sess._replyingToMsgId`(本 turn 在回哪条 user 消息,8 读/7 写)、`sess._trackerResetAt`(放弃 turn 的时刻,用于丢弃�late final,1 读/6 写)。

**根因**:同一个事实(turn 是否存活 + 属于哪条消息)有 3+2 个权威源,任一处忘记同步就出现"打字指示器不消失 / 停止按钮卡住 / 流式 final 丢失"这一**类**症状。

### 1.2 teardown 复制在 ~11 处
只有 isFinal 主路径(`websocket.js:3091-3116`)做**完整** teardown(finalize 流式行 + 清 `_sendingInFlight` + `clearTurnTiming` + `resetReplyTracker` + 清权限/regen 定时器 + 从重连集合移除 + 同步全局/UI + 推进离线 drain)。其余 10 处(stop 按钮、思考安全超时、重连合成 final、error 帧、regen 失败/超时、REST sync 落定、reload 陈旧、/clear、切 agent)各做**子集**,且多数**不**更新 `_streamingAssistant/_streamingThinking`,导致渲染半残。

清单(file:line → 触发 → 范围)见附录 A。

### 1.3 帧↔turn 绑定靠跨时钟域比较(自承认风险)
- 绑定:`websocket.js:2400-2409` 反向扫描 `sess.messages` 找最近一条 `status∈{sent,read}` 的 user 消息当作本 turn 的 `_replyingToMsgId`。
- 丢弃 late/stale final:`websocket.js:2346-2370` 用 `frame.ts < boundMsg.ts` 或 `frame.ts < sess._trackerResetAt` 判旧帧。**两处都跨时钟域**(server `frame.ts` vs client `Date.now()`)。
- 代码自承认(`websocket.js:2341-2345`):设备时钟比 server 快 >5s 时,**新 final 可能被误判为 stale 丢弃** → "stream final disappear"。
- server 侧:gateway 每帧打 `frameSeq`(每会话单调,见 `server.ts:8189-8207` / 权限帧 `6642-6643`)+ `ts`,有 `OutboundRing`(`outboundRing.ts`)做重连重放;**但无 `turnId`**。

---

## 2. 目标 / 非目标
**目标**
1. turn 存活与归属收敛为**单一权威源** `sess.turn`(形状见 §4.1);`state.sendingInFlight` 过渡期保留为镜像,读点按"transport 真相 / UI busy"**分层**迁移后退役(§4.1,非一刀切派生 getter)。
2. teardown 收敛为**唯一 mutator** `beginTurn()/endTurn(reason,{finalize})`,11 处改为调用它,且**按 reason 区分 finalize 策略**(§4.1)。
3. 引入**权威 `clientTurnId`**(§4.2 命名,避与 codex app-server turnId 撞),帧按 **per-turn binding mode**(§4.3)绑定,在 `turnId` 模式下**消除跨时钟域比较**这一类丢帧风险。

**非目标(本次不动)**
- 不改流式渲染节流策略 / throttle 阈值(`websocket.js:2669`)。
- 不改 `OutboundRing` 重放协议语义(只**新增** turnId 字段,frameSeq/replay 不变)。
- 不改后端 CCB/容器的 turn 切分逻辑(仅透传 turnId)。

---

## 3. 行为对照清单(parity — 每子步 dev smoke 必须逐条复核不变)
| # | 可见行为 | 当前驱动 | 验收(正常/重连/abort/切会话/弱网) |
|---|----------|----------|-----------------------------------|
| P1 | 打字指示器显示/文案("生成中"/"深度思考中90s"/">5min")/隐藏 | `state.sendingInFlight` + 计时(`websocket.js:377-378`) | 正常 turn 全程显示、isFinal 即隐;重连恢复仍显示 |
| P2 | 发送↔停止按钮切换 | `updateSendEnabled`(`websocket.js:1216-1244`) | in-flight=停止;断网+in-flight=停止;断网+空闲=发送(离线入队) |
| P3 | 流式文本/思考增量、tool 卡片 | `_streamingAssistant/_streamingThinking`(`2632-2865`) | 增量逐帧追加、顺序正确、final flush |
| P4 | 重连恢复 in-flight turn(指示器+停止+标题 spinner;30s 无帧提示;resume 失败回退 REST sync) | `1722-1757` / `_reconnectInFlightSet` / `handleResumeFailed 3231-3312` | 重连后 final 正确落定,不重复/不丢 |
| P5 | 切会话 mid-turn:旧会话保活、隐 UI;回切恢复 UI;in-flight 时拒切 | `sessions.js:81-114` | 来回切不串台、不卡 UI |
| P6 | abort/stop、/clear、切 agent、error 帧、REST sync 落定、reload 陈旧 | 附录 A 各点 | 各自正确清 turn,不残留 |

---

## 4. 设计

### 4.1 客户端:`modules/turnLifecycle.js`(新)
单一 turn 状态机,挂在 session 上。**收敛范围必须覆盖 turn 全部附属状态**(Codex A1-14),不止 busy flag:
```js
// sess.turn —— turn 生命周期的单一真相(替代散落字段)
// status: 'idle' | 'pending'(已发,未见首帧) | 'streaming' | 'finalizing'
sess.turn = {
  status, clientTurnId, boundMsgId,
  startedAt, lastFrameAt, resetAt,        // 取代 _turnStartedAt/_lastFrameAt/_trackerResetAt
  blockCount,                              // 取代 _currentTurnBlockCount
  streamBroken,                            // 取代 _liveStreamBroken(重连/sync 的事实源,A1-13)
  pendingCostCredits, lastFinaledAssistantId, // 取代同名散字段
  // 关联但不内联:regen timer、permission pending、_activeTeamRun、OutboundTurnStatus
  //   由 endTurn 统一清理(见下 reason 策略),状态仍存原处但生命周期归 turn 管。
}
```
**mutator(唯一写入口)**:
- `beginTurn(sess, { boundMsgId, clientTurnId })` → status='pending';幂等(同 id 再 begin = no-op)。
- `endTurn(sess, reason, { finalize })` → **按 reason 决定 finalize 策略**(Codex A1-4/5/6,关键):
  | finalize | 行为 | 适用 reason |
  |----------|------|-------------|
  | `'full'` | 完整定稿:**按现有 handleOutbound final 的完整有序阶段抽取**(empty-turn 判定/`resetReplyTracker` 在 ~`websocket.js:2441`,usage 合并/`lastFinaledAssistantId`/rich render/finalize plan-tool/通知/清理在 `websocket.js:2997` 之后)——抽取须覆盖**整条有序流程**,不能只抽后半段 | **仅 `final`** |
  | `'flushOnly'` | 仅 flush 待渲染 rAF 文本,**不**定稿/不通知/不算 usage/不 empty-turn | `stop` / `thinking_timeout` / `error` / `agent_switch` |
  | `'none'` | 不碰流式渲染,仅清 turn 运行态指针 | `clear` / `session_delete` / `sync_settled`(服务端 tape 才是权威,见 sync.js:675/732,**本地不 full finalize**) / `stale_reload` / `reconnect_restart` |
  所有 reason 都做的公共动作:置 status='idle'、记 resetAt、清 regen timer/permission pending、从 `_reconnectInFlightSet` 移除。
- `isSessionInFlight(sess)` = `sess.turn.status !== 'idle'`(= 该会话**真实有 active turn**)。

**`state.sendingInFlight` 不做激进派生(Codex A1-1/2/3)**。现状刻意保留"全局 UI flag 与当前会话 turn 短暂不一致"(reconnect `websocket.js:1829` 只清全局保会话给 hello;`sessions.js:80` 以此为前提)。因此**分层**,不一刀切删 14 写:
- **transport/真相读点**(某会话是否真有 active turn):`websocket.js:1364/1722/1079`、`sync.js:675/732/762`、offline drain、reconnect safety → 改为显式 `isSessionInFlight(sess)`。
- **UI busy 读点**(当前 UI 是否表现 busy):`updateSendEnabled`、Enter/send click、auto-scroll、`papers.js:18`(A1-12) → 读 `isCurrentTurnUiBusy()`。**该函数必须逐位复刻 P2 现状**(含"断网+in-flight=停止"):即 `updateSendEnabled` 现用 `state.wsStatus`+busy 组合出的全部分支不得改变。
  - 现状用 `websocket.js:1829` 重连期**只清全局 flag、保会话 flag** 实现某种 UI 抑制;该抑制的**确切作用对象与时机需在实现期先 smoke 复现确认**(它影响的是打字指示器/标题 spinner 还是停止按钮、抑制多久),再用显式字段(暂名 `turn.uiSuppressedDuringReconnect`)建模。**硬约束:新模型必须重放 1829 的现有可见效果,不得改变 P2**;若 smoke 发现它并不抑制停止按钮,则该字段只作用于其真实对象。
- 过渡期 `state.sendingInFlight` 保留为**镜像**(由 mutator 写),待全部读点迁移到分层 API 后再退役,降低一次性回归面。

### 4.2 服务端:权威 `clientTurnId`(扩 frame schema,**加字段不破协议**)
**命名 `clientTurnId`**(不叫 `turnId` —— 与 Codex app-server 内部 turnId 冲突,见 `codexAppServerRunner.ts:1689`,Codex A1-8)。
**方案 A(选定):client-mint + 全链路 echo**。理由:turn 边界客户端最清楚,避免 server 端"idle→active"探测。
- client 发送 user 帧时 `crypto.randomUUID()` 生成 `clientTurnId` 放进 inbound 帧;`beginTurn` 记录。
- **echo 全链路必改点(Codex A1-7)**:
  - gateway 帧构造 `server.ts:8189-8207`(+ permission `6642-6643`):从该 session 当前 inbound 请求上下文取 `clientTurnId` 一并打入。
  - **商业 bridge**:`packages/commercial/src/ws/userChatBridge.ts:2071`(rewrite requestId/traceId 处)必须把 `clientTurnId` 一并透传;`:2574`(`storeStamped` 缓存容器已打标帧)必须把 `clientTurnId` 纳入打标。多机/容器路径不补这两点 = turnId 链路断。
- **合成帧 turnId 规则(Codex A1-9)**:
  - rate-limit / upload reject / model reject:复制 inbound `clientTurnId`。
  - `outbound.error` / permission / turn_status:经 `_inheritOutboundRouting(out)` 复制路由时一并复制 `clientTurnId`。
  - auto-resume `service_restart`(`server.ts:7010`,单 ws inline send):需 reconnect 的 `inbound.hello` peer **携带当前 active `clientTurnId`**,gateway 据此给合成 final 打 id;hello 未带则该合成帧**无 id**,走兼容路径(见 §4.3 binding mode)。
- client 收帧:按 §4.3 的 per-turn binding mode 绑定,**彻底替换** `frame.ts` 跨时钟域比较。

> 备选方案 B(server-mint):否决——需 server 可靠探测 turn 边界 + 跨 backend 透传,复杂度更高、边界语义不如 client 清晰。

### 4.3 帧绑定:**per-turn binding mode**(Codex A1-10/11,关键)
同一会话内**混用** turnId 绑定与旧 ts 扫描**不安全**(新 turn 已有 id 时,无 id 的旧 replay/合成 final 仍可能被旧扫描错绑到当前 user 消息 —— 现有 bug 的变体)。故按 turn 锁定模式:
- **server capability 协商**:引入显式 `outbound.capabilities`(连接早期 server 主动下发,标明是否支持 `clientTurnId`),client **缓存**该 capability(`state.serverCaps.clientTurnId`)。`beginTurn` 时读**已缓存**的 capability 锁定 `turn.bindingMode`:**capability 未知/未支持 → 一律 `legacy`**;仅当已确证支持时新 turn 才锁 `turnId`。避免"capability 要等首个 outbound 才知道却要在 beginTurn 决定"的死结。
- `turnId` 模式的 turn:**只**接受 `frame.clientTurnId === turn.clientTurnId` 的帧;**无 id 的 `outbound.message` final 默认不绑定**本 turn(除非确证对端是兼容 server 且本 turn 从未见过任何 turnId 帧)。彻底不用 ts 跨域比较。
- `legacy` 模式的 turn(旧 server / 缺能力):全程沿用现有 `_replyingToMsgId` 扫描 + `resetAt` 二级闸(行为不变,不退化)。
- `resetAt` 仅作"本地放弃后,**同模式**迟到帧的二级忽略闸",不再承担跨时钟判旧。

> 即:绑定模式是 **per-turn 一次锁定**,不在 turn 内切换,杜绝混用。

---

## 5. 迁移策略(分子步;每步独立可发布 + 可回滚 + dev 流式 smoke)
**Phase 1 目标降级(Codex A1-15/16):仅做客户端 teardown 收敛 + facade 包装,不宣称彻底单一权威,不一次性改 getter / 删全部写点。** 无 clientTurnId 时 `boundMsgId` 仍来自旧扫描,只降 drift、不消除丢 final 类问题(那要 Phase 2)。子步顺序:
- **1a. facade + 镜像**:新增 `turnLifecycle.js` + `sess.turn`,**镜像/兼容旧字段**(旧 `_sendingInFlight/_turnStartedAt/...` 暂保留并由 facade 同步),不删任何读写。纯加法,行为零变。
- **1b. reason 策略收敛 teardown**:11 处改调 `endTurn(reason, {finalize})`,严格按 §4.1 表(`full` 仅 final;stop/error/agent_switch=`flushOnly`;clear/session_delete/sync_settled/stale_reload/reconnect_restart=`none`)。**逐处对照现状 finalize 范围**,确保非 final 路径不新增"定稿半截流式行/发通知/算 usage"。begin 路径(发送/regen/drain ACK)改调 `beginTurn`。
- **1c. UI getter 分层 + reconnect 抑制**:**单独**一步引入 `isCurrentTurnUiBusy()` + 显式 `turn.uiSuppressedDuringReconnect`(取代 1829 隐式清全局抑制),把 UI 读点迁过去;transport 读点迁 `isSessionInFlight`。最后再退役 `state.sendingInFlight` 镜像。
- 验收:每子步行为对照 P1-P6 全绿(dev smoke);ws*/sync* 单测全绿(按新 API 调断言,语义不变)。

**Phase 2(clientTurnId,协议加字段,per-turn binding mode)**
- 2a. server 下发 `outbound.capabilities`(连接早期)+ client 缓存 `state.serverCaps.clientTurnId`,`beginTurn` 据缓存锁定 `turn.bindingMode`(未确证→legacy)。
- 2b. client mint `clientTurnId` 随 inbound;`beginTurn` 记录。
- 2c. 全链路 echo:`server.ts:8189/6642` + bridge `userChatBridge.ts:2071/2574` + 合成帧规则(§4.2)。
- 2d. client 按 binding mode 绑定(turnId 模式不混旧扫描);稳定后删 `turnId` 模式下的 ts 跨域比较。
- 验收:重点 P4(重连)+ **设备时钟超前**场景(手动调快客户端钟验证不再丢 final)+ 多机/容器路径(bridge echo 生效)。

每子步:`node --check` 改动模块 + `npm run test:web` + `bun scripts/bump-version.ts --check`(?v= 完整)+ dev 起站逐条 P1-P6 流式 smoke(含移动端窄屏 + 弱网 throttle)。**流式/重连/弱网的可见体验无法 headless 自动验证 → dev+浏览器逐条 smoke 是本设计硬前置,不可省。**

---

## 6. 风险与回滚
- **最高风险**:误伤流式可见行为(P1-P3)。缓解:Phase 1 不碰协议、纯收敛;每子步独立 commit + dev smoke;出问题 `deploy-v3.sh --rollback`。
- **协议风险**(Phase 2):`clientTurnId` 加字段对旧端无害(忽略未知字段)。安全性靠 **per-turn binding mode**(§4.3):capability 未确证支持时新 turn 锁 `legacy`(全程旧扫描,行为不变);仅确证支持后新 turn 锁 `turnId`(只收匹配 id 帧)。**同一 turn 内不混用两种绑定**,杜绝"无 id 旧帧错绑新 turn"。
- **测试盲区**:流式/重连/弱网的**可见**体验无法 headless 自动验证 → **必须** dev 起站 + 浏览器逐条 smoke(本设计的硬前置;不可省略)。

---

## 附录 A — 11 处 teardown 现状(收敛目标)
| # | file:line | 触发 | 现状范围 |
|---|-----------|------|----------|
| 1 | websocket.js:325 | 思考安全 10min 超时 | 发 stop、清 flag/timing/tracker、同步全局+隐 UI |
| 2 | websocket.js:1272 | 用户停止按钮 | 清 flag/timing/tracker、同步当前 |
| 3 | websocket.js:2320 | 重连合成 service_restart final | 清 flag/timing/tracker、同步+UI |
| 4 | websocket.js:3091-3116 | **isFinal 主路径(完整)** | finalize 流式行 + 全套清理 + 推进 drain |
| 5 | websocket.js:3607 | outbound.error 帧 | 清 flag、同步当前 |
| 6 | messages.js:2478-2492 | regen 失败/abort | 清 flag、同步、隐 UI |
| 7 | messages.js:2585-2594 | regen 安全定时器 | 清 flag、同步、隐 UI |
| 8 | sync.js:743 | REST sync 服务端 terminal 落定 | 清 flag/timing/tracker |
| 9 | sessions.js:451 | reload 后陈旧 in-flight(20s liveness 失败) | 清 flag |
| 10 | main.js:1130 | /clear | 清 flag、发 stop、同步、隐 UI |
| 11 | main.js:1618 | 切 agent mid-turn | 清 flag、发 stop、同步、隐 UI(if current) |

(begin 侧:websocket.js:1135/1143 drain ACK、messages.js:2566/2599 regen、sync.js:764 recovery、sessions.js:420/90 切会话恢复。)

## 附录 B — server 帧机制现状
- 帧构造 + frameSeq:`gateway/src/server.ts:8189-8207`(outbound.message)、`6642-6643`(permission)。
- 重放环:`gateway/src/outboundRing.ts`(`nextSeq/store/storeStamped`);hello 带 `lastFrameSeq` 重放 `>lastFrameSeq` 帧。
- 帧现有字段:`ts`、`frameSeq` + producer 字段(`type/peer/blocks/isFinal/meta`)。**无 `clientTurnId`**(本设计新增)。
