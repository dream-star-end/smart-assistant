# G8 回放门（OCV5-675 片 A）

监控规则改动前，先跑这组离线回放。夹具是脱敏合成数据，不连库，不调模型，不计费。

```bash
npx tsx scripts/v5-selfhost-g8-replay.ts
```

退出码 0 表示每例的判定、严重度、是否请人看、是否告警都与夹具一致。`stopSession` 恒为 false。

| 夹具 | 类 | 预期 |
| --- | --- | --- |
| `box-rejected.json` | Box 拒接 | `box_rejected` / warning / 请人看 / 告警 |
| `engine-starting-without-process.json` | 假引擎态 | `engine_state_mismatch` / `engine_starting_without_process` / 告警 / 不请人看 |
| `duplicate-charge.json` | 重复扣费 | `duplicate_charge` / critical / 请人看 / 告警 |
| `clean-completed.json` | 对照 | `ok` |
| `user-cancel.json` | 对照：用户取消不是拒接 | `ok` |
| `idempotent-replay.json` | 对照：幂等重放不是第二笔账 | `ok` |
| `compact-busy-after-terminal.json` | 假引擎态：摘要点上引擎仍忙、调度已终态 | `engine_busy_after_terminal` |

优先级：重复扣费，然后引擎与调度不一致，然后 Box 拒接，其余为 ok。判定不生成给用户看的句子，也不使用内部码当作用户文案。

## 检查点默认关

「写压缩摘要」和「回合结束」各有一个可插拔检查点。没有监听器时，检查直接返回，不写日志，不写指标，不进 outbox，不改会话，不改计费。

开启方式是在进程里调用 `installG8ReplayCheckpoint()`。本片不从 `index.ts` 调用，也不读新的环境变量。开启之后：

- 指标 `g8_replay_check_total`，标签只有 `point` 和 `verdict`。trace id 不进标签。
- 既有 logger 记一条 `g8_replay_check`（trace id、点、判定、严重度、原因）。不记提示词或摘要正文。
- 严重判定调用既有 `safeEnqueueAlert`，事件 `ops.g8_replay_severe`。不停止会话。

当前线上调用只带该处已有的事实。摘要点只知道「写过摘要、引擎报告为 compacting」。回合结束只知道调度行（终态、outcome、failureCode、trace id），因此能认出 Box 拒接码。引擎是否活着、扣费笔数留给回放夹具和以后补进观察的字段，本片不去查账。

## 片 B（等 OCV5-672，本片不实现）

调查工具按 trace id 打开压缩前全文。只读，权限与 672 相同：操作者调查，不是用户聊天。

- `PrecompactOriginalRef`：`{ traceId, retainRef }`。`retainRef` 是 672 给出的不透明句柄。
- `PrecompactOriginalReader.openByTraceId(traceId): Promise<PrecompactOriginalRef | null>`
- 没有留存则返回 null。这次打开不得新建留存。
- 不得调用模型，不得计费。
- 将来的入口：`npx tsx scripts/oc-trace.ts <traceId> --precompact`。不写 `--session`。
