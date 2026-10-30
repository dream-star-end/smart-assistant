# Box 已停止的恢复任务阻塞后续续聊（2026-10-30）

范围：商业 uid4 只读调查；个人版 `fix/v5-selfhost-box-stale-recovery` 根修 PR。商业发布留待下一批准的空窗；本任务没有生产写入。

## 生产时间线（CST）

| 时间 | 事实 |
| --- | --- |
| 09:23:35 | 原 Box 回合的一次 API 调用完成并结算 1545；整个 dispatch 随后仍执行工具续接。 |
| 09:23:54–59 | 后续调用遭 `BOX_CLI_UPSTREAM_REFUSED`，记录 `continuation_stream_rejected`，远端停止被证明。 |
| 09:25:07–27 | 原会话历史恢复获得旧交换的 `boxRecoveredBy`，新调用仍选 `account2-pool`，reason=`quota_benched`，再次遭上游拒绝并确定停止。 |
| 09:25:33–09:37:52 | 20 次请求在 orphan 恢复认领阶段返回 `BOX_RESUME_IN_PROGRESS`，没有进入新 profile 选择或 cc3 resume。 |
| 09:26:31 | 审计 #3710 启用两个 pool，默认改为 cc3；此时故障已经发生。cc2 冷却到 11:10。 |
| 09:38:07–09:39:08 | 用户在原会话选择 `antigravity-claude-opus-5.5`，网关 full-rebuild 载入 568 条历史，回复 completed。 |

`BOX_REPLAY_NOT_FOUND` 是流式失败后非流式 fallback 未找到 replay 的后续现象，不能当作原始失败原因。

## 根因

旧 handoff 的 `boxRecoveredBy` 指向一个已经 admitted 后失败的恢复调用。该调用的 journal 为 `aborted/failed_stopped`，`boxStopOutcome=failed`，有自身 runNonce/leaseEpoch 绑定的 `worker_failed` revision 2、exit 143 证明，dispatch 已 terminal，remote cleanup done。

`findOrphanToolHandoff` 原来仅将 `aborted` 且尚无 `boxState` 的恢复调用判为失效。已经启动后确定停止的恢复调用始终被当作占用者，`releaseOrphan` 因此返回 `BOX_RESUME_IN_PROGRESS`，既有的完整历史重载路径永远无法再获得认领。

这不是跨 profile 文件隔离问题。通过官方 Box resolver 的 `adminProbe/noLaunch`、禁止唤醒、PG 强制只读连接，在实际机器 `grok-bot-vm-473530288` 核对：两个 pool 的 `projects` 均为字面指向 `/home/box/.claude/projects` 的软链，实际路径一致，box uid1000 可读。原调用及恢复调用的 native JSONL 当前都已不存在，journal 已记录清理完成；不能用清理后的缺失反推当时发生了 resume 读失败。

失败结算核对：22 条失败 journal（2 次 upstream refusal、20 次认领失败）的 `final_credits` 总计 0，usage/ledger 引用均为 0。先前完成 API 调用的 usage=1545、journal=1545、ledger=-1545 三者一致，不能把这笔已完成用量计作失败扣费。没有修改计费数据。

## 零生产写止血

用户在原会话选择已有可用的非 Box 模型，再发“继续”。uid4 的上述成功已在生产自然发生；保留历史，不要求新建会话。无需切 profile、改库、重启或删除文件。此调查没有替用户发送消息或切换模型。

## 修复边界与验证

保留原来的未 admitted 失效条件；额外仅允许认领已被证明停止、没有产生新 handoff/完整 replay/后继恢复的失败调用。证明必须绑定该调用自身 run/lease，OpenClaude session/model 与原交换一致，dispatch 已 terminal；`worker_complete`、unknown、活跃任务及证明缺失一律拒绝。CLI native UUID 可以在历史重载时变化。

替换在既有 session advisory lock 下重新核对 parent、旧 holder 和终态，并保留 `boxRecoveredBy=replacing` 的 CAS。两个并发恢复最多一个获得认领。获得认领后复用现有 `BoxToolFetch` 历史重载，不重新执行历史工具，不修改 keeper、profile、余额或结算逻辑。

测试与审查结果以 PR 最终记录为准：定向 PostgreSQL 集成、并发/CAS、历史重载及安全负例经 `rf-heavy.sh` 执行；没有付费探针或生产重放。个人版先开 PR，商业版不得据此视为已部署。
