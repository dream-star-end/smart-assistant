# OCV5-672：压缩后的原文重注与原文留存

本片仅用于个人版。`personalCompactionEnabled()` 复用现有 `isEngineLocalTurnExempt()`，只有
`OC_SELFHOST_ENGINE_LOCAL_TURNS=1` 时启用；重注、留存和委派去重都限定于此。
不增加商业开关、数据库迁移、计费公式、价格或界面交互。

## 单一契约与权威来源

唯一清单是 [COMPACTION_REINJECTION_CONTRACT](../../packages/gateway/src/compactionContract.ts)，
每项标明来源与 `delivery`；本文件不维护另一份可执行清单。
- `platform_prompt`：平台规则与记忆索引。各适配器每次派发都重建平台 prompt（CCB `--append-system-prompt-file`、
  Codex `model_instructions_file`、Grok/Cursor/zcode/Antigravity 每回合拼入），CLI 的压缩不改写它，
  所以重注只声明这一点，不再重复整份 prompt。真实个人 prompt 有 6k–12k token，重复它会让重注超出内联上限。
- `inline`：用户禁止项与纠正、计费归属、当前计划/目标、进行中的委派/子任务，由重注块逐字给出。
CLI 摘要一律标作“来自摘要、未经确认”，只能提供检索线索，不能证明批准、完成或计费状态。

## 接入时机

- 压缩边界：`sessionTurnRunner` 的事件回调里观察到 `turn_status=compacting`，或 `context_compacted`
  （`native_summary`/`history_suffix`；`file_reference` 不丢内容，不算）；`prepareModelSwitch` 的原生交接；
  Box 空闲 `/compact` 派发。每次边界只把会话的压缩代数加一，并在后台启动一次原文留存。
- 重注：`sessionSubmit` 在会话锁内调用 `prepareCompactionRecovery`。只有压缩代数高于已重注代数时才返回包装器，
  即只在压缩后的第一个用户回合重注；该回合的普通、溢出重建与瞬时错误续跑都用同一包装器，活动任务每次派发重读。
  其余回合原样发出。原生 slash 命令保持原文，不消耗待重注。
- 重注所需的用户原文来自边界那次留存；若它还在进行，最多等 `COMPACTION_SOURCE_WAIT_MS`（10 秒）；
  若它失败，在此稳定点再试一次。都拿不到时仍照常发送，重注块写明原文不可用、先前的批准/完成一律视为未知。

## 重注内容与体量

- 用户回合按时间顺序：≤2 KiB 的逐字给出；更长的（多为粘贴日志）只给索引（字节数、SHA-256、开头 256 B）
  和其中带指示语气的行（禁止、纠正、批准、计费等词）。
- 整块预算 24 KiB。超出时先把最早的、不含指示语气的回合折叠成 `omitted` 区间（计数与序号范围，原文在留存里），
  再去掉长回合的开头摘录；带禁止项/纠正的回合永不丢弃，必要时允许超出预算。
- 不再有“先读私有文件”的引用模式：模型不需要读网关路径（Box 远端模型读不到，大文件也会超过 CCB Read 上限）。
- 平台传输上限（Cursor/zcode argv）先给重注预留，再裁旧注入历史；当前输入从不截断。
  连当前输入也放不下时原样发送并记日志，由适配器沿用原有处理；Antigravity 交给其完整信封的文件回退。

## 原文留存

[compactionArchive.ts](../../packages/gateway/src/compactionArchive.ts) 的 `captureCompactionOriginal`
经 `readCompactionTimelinePage` 完整翻页：有 master 凭据则从其 PG 权威时间线读取并水合大正文，只有独立本地运行才读 SQLite；
校验 revision/generation/maxSeq，变化时有界重读。master 的 tape 回退行（`_displayDegraded`，如 `records_unpublished`、
`records_failed`）按其可见文本与原因原样返回，并计入清单的 `degradedRecords`，不再让整条时间线 503。

- 只在压缩边界留存，从不在普通回合留存；全程在发送路径之外，失败只记日志。
- 去重：`$OPENCLAUDE_HOME/compaction-originals/sessions/<owner+session SHA256>/records/<sha256>.json`
  每条时间线记录只存一次；每次留存只写一份小清单 `captures/<archiveId>.json`（记录哈希序列、触发原因、trace、
  当时的当前输入与该回合的局部输出）。清单先写临时文件再改名发布；同一会话目录的留存与清理串行。
- 目录 0700、文件 0600，排他写入并落盘；不把原文写进日志。
- 保留期 30 天，读时拒绝过期清单；gateway 启动时与每小时清理：删过期清单与其 trace 索引，再删不再被任何清单引用的记录，
  会话目录空了即删除；崩溃留下的未发布清单 1 小时后清除。
- 读取：`readCompactionOriginal({sessionId,archiveId,principal:{kind:'owner',userId}})` 只读本人会话；
  `readCompactionOriginalByTrace({traceId,principal})` 接受本人或可信进程内 `{kind:'ops-trace'}`（供 OCV5-675）。
  返回清单与重建的时间线。没有公共 HTTP 入口，调用方不得从请求参数创建 ops capability。

## 活动任务与计费边界

委派 ID 来自父会话精确匹配的 `DelegateJobStore` 非终态记录，子任务来自活动子会话；投影不含 claimToken 等执行凭据。
真实调用方（MCP `delegate_task`、`oc-memory` CLI）新建委派时不带任何键，因此去重以请求本身为准：
`delegateTaskKey` = 目标说明（goal，去首尾空白）+ 模型 + reviewMode 的 SHA-256。
`DelegateResumeRegistry.preflight` 在同一父会话、目标 agent、来源 agent 下找到仍在运行（`active`）的同一任务时，
返回原句柄而不派发：异步返回原 jobId（模型可继续等待），同步返回 409「同一委派任务仍在运行」。
两者都止于派发与计费 admission 之前。任务结束（retiring/release）后同一任务可再次发起；resume 后的会话不再代表原任务。
只做精确匹配，不按相似文字去重。原有 requestId settle 幂等、账本、SM/DURABLE 开关及计费语义保持原样。

## 范围说明（P2，后续工单）

- 回合内压缩：CCB auto/reactive、Codex 自动与 80% 预压缩、Grok checkpoint、Antigravity checkpoint 都发生在回合进行中，
  本片在其后的下一个用户回合重注，回合剩余部分不覆盖（可考虑 CCB SessionStart compact hook，或交 OCV5-674）。
  Antigravity 的 `checkpoint` step 目前被适配器丢弃，观察不到；平台自己的 `context_too_long` 重建用原文后缀，
  不经摘要，但更早的禁止项可能落在后缀之外，同样留待后续。
- 压缩代数只在进程内存里：gateway 重启后，重启前发生的压缩不再重注；进行中的委派去重同样不跨重启（durable 恢复不带任务键）。
- 非 webchat 渠道（telegram、feishu、wechat）不启用：留存与重注按 `peerId` 读取客户端时间线，这对 webchat 就是客户端会话 id；
  其他渠道的 `peerId` 能否对应到一条完整时间线尚未核实，先不启用，避免对这些渠道读到空或错的“原文”。
- 删除会话或记忆时，留存副本最多再保留到 30 天期满，目前没有级联删除；删除入口在 master，需要另开接口通知容器。

## 相邻工单

OCV5-674 可复用压缩代数、留存清单与可见边界，但覆盖前缀/后台压缩提交策略仍属其范围。
OCV5-675 可调用 owner/ops-trace reader 打开原文，并自行接运维权限入口与回放检查。
OCV5-677 可复用 typed 契约和来源标记，本片不改变压缩模型，也不越过 t1387 的既定边界。
quietctx #1300 继续负责淡灰记录；本片不改 UI，不新增“快满了”提示。
