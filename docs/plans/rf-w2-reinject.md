# OCV5-672：压缩后的原文重注与原文留存

本片仅用于个人版。`personalCompactionEnabled()` 复用现有 `isEngineLocalTurnExempt()`，只有
`OC_SELFHOST_ENGINE_LOCAL_TURNS=1` 时启用；上下文重注与快照还限定 `webchat`。
不增加商业开关、数据库迁移、计费公式、价格或界面交互。

## 单一契约与权威来源

唯一清单是 [COMPACTION_REINJECTION_CONTRACT](../../packages/gateway/src/compactionContract.ts)，
其字面量派生 `CompactionContractId`；本文件不维护另一份可执行清单。
清单覆盖平台规则、用户禁止项与纠正、计费权威、计划/目标、记忆索引、活动工具/子任务/委派。
平台内容通过原有 `buildPromptContext` 重读，并沿用本轮冻结的隐私策略、身份及项目上下文；
用户原文取自本人完整主时间线，保留顺序与来源，实际后续指令仍按指令层级生效。
记忆沿用现有隐私读取路径，不恢复 `user.md` 的旧常驻注入方式。
计划、目标和记忆索引保持各自的数据身份，不能证明用户授权；来源缺失表示未知。
CLI 摘要一律标作“来自摘要、未经确认”，只能提供检索线索，不能证明批准、完成或计费状态。

## 接入时机与引擎适用

`sessionSubmit` 在持有会话锁时调用 `prepareCompactionTurn`，先保存原文，再提交引擎。
每次实际派发（含普通下一轮、上下文溢出与瞬时错误续跑）都携带同一恢复契约，重新读取在途任务身份；多模态当前输入保留原块。
原生 slash command 保持命令文本，内部模型切换控制流程沿用原路；跨引擎原生摘要交接显式标记未经确认。
CCB、Codex、Grok 继续由各自 CLI 产生 native compact，平台没有另建摘要生成器。
Codex 下一轮前的主动 compact 也位于快照之后；CCB/Box/Grok 的底座历史所有权保持原样。
Cursor、zcode、Antigravity 无原生 compact，恢复契约同样用于平台注入历史的字节裁剪与重建。
传输预算先为恢复契约保留空间，再拟合旧注入历史；不缩短当前输入或原文来源。
超过内联预算（默认 24 KiB）时引用私有完整文件，要求行动前分块读完；文件内容不裁剪、不改写为摘要。

## 原文存储与访问

[compactionArchive.ts](../../packages/gateway/src/compactionArchive.ts) 的 `captureCompactionOriginal`
经 `readCompactionTimelinePage` 完整翻页：有 master 凭据则从其 PG 权威时间线读取并水合大正文，只有独立本地运行才读 SQLite。校验 revision/generation/maxSeq，变化时有界重读。
内部分页按水合后实际字节自动缩页，保留真实游标及全部正文。路由 `/internal/v3/compaction-timeline` 仅个人版挂载，沿用 bearer+bound-IP 容器鉴权，owner 仅从身份推导；远端失败不回退本地，分片及整页 SHA 必须完整。
不调用带模型窗口裁剪的 `getEngineContextMessages`；首次确认为新会话时才显式允许空时间线。
source 固定为 `platform-full-timeline`：原始主时间线、exact 当前输入、平台上下文及活动 ID。
`sessionTurnRunner` 在可见 compact 边界/终态调用 `observeCompactionOriginal`，同步追加当轮
`getPartialSnapshot()` 原文与未完成工具 ID；追加片不可变，独立于基础快照。
平台未持有 opaque CLI 内部可能额外保存的 transcript，不将本快照宣称为该内部全文。
CLI 压缩失败不覆盖或删除上述原文；快照失败发生于提交之前，观察回调失败记录日志，不令 parser 崩溃。

路径为 `$OPENCLAUDE_HOME/compaction-originals/sessions/<owner+session SHA256>/<archiveId>/`，
包含 `snapshot.json`、完整 `original.txt` 和 `turn-originals/`；trace 索引仅存哈希目录与定位信息。
目录 0700、文件 0600，排他写入并同步落盘，基础快照以目录原子发布；不把原文写进日志。
保留期固定 30 天，读时立即拒绝过期内容；capture 按 root 至多每小时清理一次，
`pruneCompactionOriginals()` 可供生命周期清理调用，基础快照及所有追加片共同删除。
`readCompactionOriginal({sessionId,archiveId,principal:{kind:'owner',userId}})` 只读本人会话。
`readCompactionOriginalByTrace({traceId,principal})` 接受本人或可信进程内 `{kind:'ops-trace'}`；
ops 只开放 trace 查询 seam，不能借 session reader 扩大权限。本片没有新增公共 HTTP 路由，
调用方不得从请求参数创建 ops capability。返回值同时含基础 snapshot、reference 和 turnOriginals。

## 活动任务与计费边界

委派 ID 来自父会话精确匹配的 `DelegateJobStore` 非终态记录，子任务来自活动会话，
工具 ID 来自真实 use/result 事件；投影不含 claimToken 等执行凭据，不依赖 UI 活动卡或摘要推测。
进行中的 exact idempotencyKey 即使丢失 resumeSessionKey，也只在父会话/目标/source 匹配时
恢复旧句柄，先返回旧 jobId，再止于派发与新计费 admission 之前；不按相似目标文字去重。
原有 requestId settle 幂等、账本、SM/DURABLE 开关及计费语义保持原样。

## 相邻工单与验证状态

OCV5-674 可复用快照 reference、活动 ID 与可见边界，但覆盖前缀/后台压缩提交策略仍属其范围。
OCV5-675 可调用 owner/ops-trace reader 打开原文及追加片，并自行接运维权限入口与回放检查。
OCV5-677 可复用 typed 契约和来源标记，本片不改变压缩模型，也不越过 t1387 的既定边界。
quietctx #1300 继续负责淡灰记录；本片不改 UI，不新增“快满了”提示。
定向测试已编写：假批准与原文禁止、隐私、字节/多模态、完整分页与一致性、ACL/过期/追加片，
以及 exact 委派重放不新增派发或 admission；测试、审查与精确 head CI 结果待主控实跑登记。
