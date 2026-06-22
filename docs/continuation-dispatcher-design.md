# Phase 2: Continuation stdout dispatcher 设计 (B')

> 分支 `feat/continuation-stdout-dispatcher`,base master@a6f38f2e(Phase 1 turnId/blockId 已上线)。
> 根治 #1(auto-background 子任务)+ #2(ultracode workflow)的**续轮综合答复蒸发**。

## 一、问题 & 为什么不能用"持有 lock + grace"

续轮综合答复撞 `claudeMessageParser` 的 finalized 守卫被丢。#2(workflow,`task_started` 在 result **前**)已用"持有 lock + re-arm"治;#1(auto-background,`task_notification` 在 result **后**)漏。

持有 lock + grace 不行:**prod 30 样本 result→notification 中位 3.3s,但 13% >90s、最长 948s(16min)**。持有 lock 等长子任务 = 锁死用户 16 分钟 + 90s soft-cap 后尾损丢答案。

## 二、核心设计原则:持久化兜底"不丢",实时投递是优化

**"答案不丢"的底线 = 续轮答案无论实时投递归属如何,都经 parser `onFinish` 持久化(`appendServerAuthoredMessageDurable`,新 turnIndex)**。实时投递(deliver 到在场 peer)是优化(覆盖多数:用户在场 + 续轮快)。

意义:stdout 不带 gateway turnId,长子任务 + 用户插话的交织**无法 100% 完美归属**(Codex 已确认)。把"不丢"建立在**持久化**而非"完美实时归属"上,大幅降低 dispatcher 的正确性要求——交织最坏情况是"实时显示错位/缺失,但刷新后答案在"(降级可观测,非丢失)。

## 三、permanent stdout dispatcher 状态机(取代 per-turn listener 替换)

session 级常驻 dispatcher,按 **result 边界 + task_notification** 显式分 turn(取代当前"parser finalized"隐式边界):

```
IDLE --user submit--> TURN_ACTIVE
TURN_ACTIVE --result--> 投递 final + 放锁 + 进 CONTINUATION_WATCH
CONTINUATION_WATCH:
  - task_notification(强信号) --> CONTINUATION_ACTIVE(开 continuation turn)
  - idle(无续轮 > 短超时) --> IDLE(放行排队的 user submit)
  - user submit 到达 --> 排队(strict,有界等待)
CONTINUATION_ACTIVE --result--> 投递 final(新 turnId) + 持久化 --> 回 CONTINUATION_WATCH(支持多续轮)
```

turn 边界:每个 `result` 结束一个 turn;result 后 `task_notification` = 续轮开始;result 后 user submit(无 notification)= 新 turn。claude 单进程串行处理 turn,result 是清晰边界。

## 四、continuation turn 用独立 context(不复用原 onEvent)

Codex 指出复用原 submit onEvent 闭包的三个问题:`_runLog.complete` 重复调、`session._activeTurnId` 全局踩、闭包钉住 frame/out 生命周期。

→ continuation 用独立 **delivery context**:保存不可变路由信息(sessionKey/channel/peer/userId/agentId),每续轮新 turnId + 新 block aggregate + 独立 run-log + 持久化。

## 五、strict mode(用户插话,先做严格版)

CONTINUATION_WATCH 期间用户 submit **在 gateway 内排队**(不写 stdin),直到 continuation 完成或 watcher 判定无续轮(有界 idle 超时)。这避免"放锁后续轮 stdout 被用户新 turn parser 错投"(Codex 的核心警告)。

长子任务(16min)超时放行后续轮迟到的边缘:dispatcher 仍按 result+task_notification 边界尽力归属;**无论实时归属成败,续轮答案持久化兜底不丢**。"用户插话 supersede"(主动 shutdown 旧 runner)作为后续单独 UX 策略,不在本期。

## 六、8 个不变量承接(调研 ground truth,逐一不能破)

| # | 不变量 | dispatcher 模型下如何承接 |
|---|---|---|
| A | **跨 turn result 归属**(最高危) | dispatcher 显式状态机按 result+task_notification 分 turn,取代 parser-finalized 隐式边界 |
| B | bg-bash `tool_output_tail` 跨 turn 转发 + `out.blocks` 内存防泄漏 | dispatcher 常驻天然支持;tool_output_tail 仍只 deliver 不进 aggregate;aggregate 清空时机随 continuation context 重设计 |
| C | `_activeTurnId` stamp 时机 ↔ 前端 `turnId:role:blockId` 路由 | turnId 权威源随新 turn 边界(每 result→新 turn)同步刷新,绝不让两 turn 的 block 并到同一 turnId |
| D | idle timer 二层(内层 30min + 外层 liveness) | 区分"turn 内 silent"与"turn 间 CONTINUATION_WATCH idle";liveness 读 parser 状态改为读当前 active parser |
| E | auth/phantom rollback 快照(prevCost/prevTurns) | rollback 边界仍对应单个失败 turn,绝不污染累计 cost(静默数据损坏高危) |
| F | effort/model 切换 shutdown→respawn | dispatcher 绑 runner stdout,respawn 后重新绑定新进程;`spawn` 事件重置 cost 时序复核 |
| G | `settle` 一次性闸 + lock release | 每个 turn(含 continuation)独立 resolve + lock release,dispatcher 常驻不得漏 release(死锁)或重复 settle |
| H | `isFinal` 每 turn 恰好一次 + 正确 turnId(前后端硬契约) | continuation 每 sub-turn 一个 final;前端 stale-final 守卫 + streaming 指针关闭依赖此 |

## 六bis、Codex 设计审整合(5 阻塞点,已纳入设计)

1. **dispatcher 消费 raw runner message,parser 是每个 active turn 的下游**。现状 parser result 后 finalized 丢后续,且 system 帧根本没暴露 `task_notification`(只有 status/compact/task_started/progress/updated)。dispatcher 必须直接看 raw message 才能识别 `task_notification` 边界。
2. **continuation 的 durable write 必须是 turn settlement 的一部分(非 fire-and-forget)**。现状 durable append 只在 parser onFinish、且是后台 Promise。watch 超时后无 parser 接住迟到帧 / append 前进程挂 → 仍可能"既没实时又没持久化"。continuation result 的持久化要纳入 settlement,保证"不丢"兜底真触发。
3. **新增 `USER_STDIN_WRITTEN_PENDING_OUTPUT` 状态**:strict 超时放行 user submit(已写 stdin)后,若 stdout **先**冒出 `task_notification`,仍开 continuation context 承接(continuation result 后再接 user 输出)。否则迟到续轮会被当前 user parser 当成新答案 → **错投 + durable 错位**(比丢更糟)。
4. **rollback 快照改 per-turn-context**:每个新 turn context 创建时各自捕获 `prevCost/prevTurns/prevLastCcbCost`。现状链级快照在 `_runOneTurn` 开头取、continuation 复用同一 onFinish → continuation 子 turn auth/phantom 会 rollback 到原 user turn 前,污染累计 cost(静默数据损坏)。
5. **event 携带绑定的 turnId / delivery context,server 不再读全局 `session._activeTurnId`**。continuation 与 pending-user context 并存时全局 stamp 会被踩(回归 Phase 1 重复)。

**状态机补充边界规则**:
- WATCH 中来 status/init/task_progress/task_updated → 不启 turn,只更新状态 / 转发 side-channel。
- 多个 task_notification → 按 task id 去重合并,不开多 parser 抢同一 stdout。
- WATCH 中无 notification 却来 assistant/stream_event/result → 定义 orphan continuation 策略(否则"不丢"不成立)。
- continuation 内再起 workflow → 保留现有 #2 的 `task_started before result` re-arm 语义。
- `MAX_CONTINUATIONS` 上限 → final + persist 已完成 turn,明确后续帧 suppress/orphan/supersede。

**两层锁分离(不变量 G)**:`submit lock`(stdin 串行)与 `turn-context settlement`(每 context exactly-once settle/final + durable)分离;continuation 不得无限占 user submit lock。
**watch idle ≠ turn liveness(不变量 D)**:WATCH 期间不能被 5min 普通 liveness 杀掉等待中的 auto-background(可能等 16min)。

## 七、实现阶段(承重墙,谨慎分步)

- **P2.0**:baseline 测试**锁住 8 不变量当前行为**(尤其 #2 workflow 续轮承接、auth rollback、isFinal 契约),0 代码改动。
- **P2.1**:抽出 permanent dispatcher(turn 状态机 + stdout 路由),普通 turn 行为不变(回归 #2)。
- **P2.2**:continuation turn + 独立 delivery context + 持久化兜底。
- **P2.3**:strict mode user-submit 排队 + watcher 判据(task_notification 强信号,init 不触发,忽略 tool_output_tail/task_progress 噪声)。
- **P2.4**:全测试 + Codex 审 + dev mock 帧序列验证(#1 dev `CLAUDE_AUTO_BACKGROUND_TASKS=0` 复现不了,用 mock)+ 上线。

每阶段过 Codex;dev 验证用 mock 帧序列(auto-bg 真实序列 dev 复现不了)。

## 八、帧形状 ground truth(源码核验 @ 2026-06-22)+ 设计修正

R1(`task_notification` 真实帧未知)已闭环。机器上**没有任何 transcript 含真帧**——证明设计/注释里 `task_notification` 这个名字此前是推测。权威源 = 官方 Claude Code 源码副本 `claude-code-best`(installed CLI 2.1.185 已编译为 ELF,不可 grep;CCB 是其 TS 源)。

**核验到的真实 SDK system 帧形状**(`src/entrypoints/sdk/coreSchemas.ts` Zod schema + `src/utils/sdkEventQueue.ts` 发射器 + `src/cli/print.ts:878-908` 确认 stream-json verbose 下全部写出 stdout):

```ts
// 任务到达终态的"收尾书签"——#1 的信号,在 result 之后到
{ type:'system', subtype:'task_notification',
  task_id:string, tool_use_id?:string,
  status:'completed'|'failed'|'stopped',
  output_file:string, summary:string,
  usage?:{total_tokens,tool_uses,duration_ms},
  uuid:string, session_id:string }

// 任务开始——#2 ultracode 在 result 之前到(已治)
{ type:'system', subtype:'task_started',
  task_id:string, tool_use_id?:string, description:string,
  task_type?:string, workflow_name?:string, prompt?:string, uuid, session_id }

// 权威 turn 存活信号(headless 下也发)
{ type:'system', subtype:'session_state_changed',
  state:'idle'|'running'|'requires_action', uuid, session_id }
```

**关键修正(改变 watcher 判据,需在 P2.1/P2.3 前经 Codex 复审)**:
1. `task_notification` 是**侧信道 UI 书签**(原文注释:"does NOT trigger the LLM loop"),它**不等于**"续轮必来"。真正驱动续轮 LLM loop 的是注入会话的 XML `<task-notification>`(print.ts 解析),续轮自身仍是 `init → assistant → result` 帧。所以"`task_notification` = 强信号"成立(提示续轮**可能**来),但**不是**保证——dispatcher 必须容忍"见 task_notification 但续轮没来"(idle→settle)。
2. **`session_state_changed` 是更可靠的边界信号**:`state:'idle'` = 本 turn 真正结束(即便 bg-agent 把 result 扣住),`state:'running'` = 正在产出。schema 原注释称其为 "authoritative turn-over signal even when result was withheld for background agents"。
   - **建议**:CONTINUATION_WATCH 的"结束/续轮判定"以 `session_state_changed(idle/running)` 为主信号,90s 静默 soft-cap 降级为兜底而非主判据。这直接化解不变量 D 冲突(R4)——无需对长达 16min 的 auto-bg "盲目挂起 liveness",而是用显式 `running` 信号确认 runner 真在干活才续等,`idle` 立即收尾。比"凭静默猜"安全得多。
3. P2.0 #1 baseline 测试不再 `.todo`:以上真帧形状可直接构造 faithful mock 序列(`result → task_notification(status:'completed') → [init/system] → assistant → result`)。

> 此节是源码 ground truth(可直接照抄进 mock);第 2 点的 watcher 信号改造是**对已审设计的偏离**,P2.3 plan 必须显式向 Codex/boss 复核后再落地,不得静默替换。

## 九、P2.2 实现契约(Codex 两轮审 PASS @ 2026-06-23,Option A)

新 ground truth(CCB 源码):`registerTask`(framework.ts:104)在**任意** task 启动时(#1 backgrounded agent + #2 workflow)发 `task_started`,在 result **前**;`_parseWorkflowSystem` 映射所有 task_started→workflow_progress{started}(不按 task_type gate)。所以 **#1 也会 set expectsContinuation**。真 bug = "持有 lock + re-arm + 90s soft-cap" 治了快的 87%(median 3.3s),但慢的 13%(>90s,max 948s)续轮在 soft-cap finalize+drop 之后到 → 蒸发。持锁更久不可接受(16min 冻 UI)。

**核心:result 处放锁 + 进 CONTINUATION_WATCH(永久 pump 喂),续轮在锁外投递(实时,优化)+ 持久化(durable,不丢底线)。** 取代 hold-lock+softcap。

实现要点(含 Codex 必守约束):
1. **最小 submit gate(P2.2 就要,否则有 no-drop 漏洞)**:watch active 时 `submit()` 在 repoint `_currentTurnHandler`/写 stdin **之前** await watch 完成(donePromise,受 backstop 限时);用户插话排在 watch 后,不打断续轮。
2. **turn 计数不双增**:watch parser 用 `sessionTotals: session`,`_handleResult` 自己 +turns。不手动 `++session.turns`。turnId 开 context 时 precompute `serverAuthoredMsgId(peerId, turns+1)`,durable 用 post-increment 的 `turns`(同现有 onFinish lockstep)。
3. **durable 重入**:parser onFinish 同步 → 同步 capture result + 同步 re-arm fresh parser + repoint `_currentTurnHandler`(下一续轮帧能路由)→ 再把 durable append 入**每 session 串行链** `_continuationWrite`(仿 `_resumeMapWrite`)。实时 deliver 在 onFinish 同步走 `onContinuationEvent`。watch "完全 settle"(destroy/eviction await)= 串行链 drain 后。capture 不可变 `{turnId, assistantText, userId, peerId, turnIndex}`(别用 live session 字段,下一 context 会改)。
4. **watch liveness/eviction**:submit 的 5min liveness 只在 submit 期间(finally 清),放锁后不作用于 watch。watch 自己的 backstop idle timer(raw msg 刷新,低于 30min webchat eviction TTL),超时**不**interrupt runner。LRU eviction sweep 跳过 `_continuationWatch` active 的 session。P2.3 把 silence backstop 换成 session_state_changed(idle) 主信号。
5. **watch exit/error**:submit turn 的 per-turn exit/error 在 turn resolve 时已 detach;watch 装自己的 minimal exit/error listener(runner 崩 → flush partial 续轮文本 durable + end watch + 释放排队 submit)。createSession 的永久 crash-log exit listener 不动。watch-local settled guard(double observe OK,double settle 不行)。
6. **per-context rollback(E/R5)**:每 continuation context 开时 capture 自己的 prevCost/prevTurns/prevLastCcbCost;续轮 auth/phantom 只回滚自己,绝不碰原 user turn;续轮 auth-error 结束 watch(不 retry user turn)。
7. **独立投递**:新 `public onContinuationEvent?(route, event)`;gateway wire 到 stamp turnId + push peer ws(仿 server.ts block/final deliver),**不复用** per-submit onEvent(避 _runLog 双 complete + stale out.blocks)。
8. 删 90s CONTINUATION_WAIT_MS finalize+drop;保留 MAX_CONTINUATIONS。
9. watch-end 清理必须全:clear `_continuationWatch` + 仅当仍属己时 repoint `_currentTurnHandler` + remove watch exit/error/parse_error + clear timers + resolve 排队 submit waiter;durable 链失败也要 settle 链 + end watch(排队 submit 不能永挂)。
10. 测试:翻 B2(#1 投递+持久化)、改 B1(#2 release+watch)、加"慢续轮(>90s 旧窗口后)被接住"、submit-gate(插话排队、续轮仍投递)、per-context rollback 隔离、watch backstop end、eviction 跳过 active watch;storage-mock 测(durable 一次/正确 srv-tN)放独立文件、mock.module 在 import sessionManager 前。

## 十、P2.2 落地状态 + P2.3 决策(2026-06-23)

**P2.2 已在分支完成并验证**(commit 9469eea2,Codex PASS):#1/#2 续轮答案现在投递+持久化,无 90s 尾损,无 16min 锁占,无错投。验证:typecheck 全包 + gateway 566/0 + web 456/0 + gateway 包 runtime load smoke + Codex 三阶段 PASS。

**P2.3 的两块,一块已被 P2.2 实现方式吸收,一块按数据缺口推迟**:
1. **strict 队列 / `USER_STDIN_WRITTEN_PENDING_OUTPUT` 状态——已不需要**。设计原本担心"strict 超时放行 user submit(写了 stdin)后 task_notification 才到 → 错投"。但 P2.2 的 submit gate 是 **await watch.done**(watch 活跃时根本不写 stdin、不 repoint handler),所以"写了 stdin 又来续轮"的竞态在本实现里**不可能发生**。await-gate 比"超时放行+处理迟到帧"更严格也更简单,直接消除了那个状态。
2. **`session_state_changed(idle)` 作为 watch 主结束信号——推迟,缺帧序数据**。风险:若 backgrounded task 运行期间主 session 就 emit `idle`(而非 `running`),naive 的"idle→结束 watch"会在续轮到达前**提前结束 watch → 重新蒸发**(就是要修的 bug)。是 idle 还是 running 取决于 auto-background 真实帧序,dev 复现不了、prod 未抓到。**不在猜测的帧序上实现有正确性风险的改动**。当前 backstop(20min > 实测 max 16min)正确兜底:所有合法续轮(≤16min)都在 backstop 前被接住;只有"启动了 bg task 但 20min 内零续轮"才结束 watch(正确)。已知代价:那种罕见情形下用户下一条消息最多等 20min(strict 排队语义)。修法 = 抓 prod 真实 auto-background 帧序(含 session_state_changed 时序)后,按"idle + 短 grace,可被 running/续轮帧取消"安全设计,再过 Codex。

**Ship(P2.4)是 gated 最后一步**:按 CLAUDE.md,合 master 前必须 dev 实例验证(BLOCKING)→ 合并 → openclaude-safe-restart → prod smoke。这是对 boss 日用助手的最高风险操作,谨慎单独执行,不在超长 turn 末尾仓促做。
