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
