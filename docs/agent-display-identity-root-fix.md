# Agent 显示层身份根治 (agent-display-identity-root-fix)

> 分支 `feat/agent-display-identity-root-fix`,base master@2f5eea87。
> 目标:在架构层一次性消除"agent 显示重复 / 长回复闪没 / 卡片卡运行中 / 重连丢内容 / 子任务·ultracode 最终答复蒸发"这一整类问题,而非补症状。

## 一、问题:一类显示 bug(非个例)

历史症状(四路调研归纳,~10/19 强同源,加近亲 ~14/19):重复渲染、被旧快照覆盖闪没、Agent 卡片卡"运行中"、重连后丢内容、孤儿消息、#1 子任务综合答复永久蒸发、#2 ultracode 只见"已后台启动"。

## 二、根因:三个不对称,同一病根「缺统一稳定 key」

1. **块维度**:tool/plan/goal/agent-group/workflow/permission 块带稳定 blockId(`websocket.js:1655-1688` 走 `_blockIdToMsgId` find-or-create 幂等,刷新可从 messages 重建);唯独 **assistant text / thinking 后端 parser 不发 blockId**(`claudeMessageParser.ts:457/461`),前端只能靠易失内存指针 `_streamingAssistant`/`_streamingThinking`(`websocket.js:1501/1540`),断连/刷新/server-wins 即丢 → 下一帧走新建分支 → 同内容两条。
2. **turn 维度**:WS 流式帧用前端本地 id `m-*`(`util.js:4`),REST 历史里 server-authored 用 `srv-${peerId}-t${turnIndex}`(`sessionManager.ts:1562`),两套 id 永不相等;前端对账 `_localDominates`(`sync.js:314-325`)是位置式 `server[i].id===local[i].id`,对不上 fallback 到 server-wins 整组替换 → 覆盖/孤儿/闪烁。服务端目前靠 `dropPhantomClientAssistants`(`sessionsDb.ts:609`)兜底清重复。
3. **后端单-turn**:`claudeMessageParser.ts:179 if(this.finalized)return`(`_handleResult():678` 第一条 result 即 finalize)。官方 CLI 在同一进程调用内自驱续轮(auto-background 子任务信号 `task_notification`;ultracode workflow 信号 `task_started`),续轮内容撞 finalized 守卫被丢。sessionManager 已 ship `expectsContinuation`(commit 74118363)但**仅认 task_started → #2 已治,#1 仍漏**。

## 三、架构杠杆:后端 turnIndex = 唯一权威 turn 边界

`session.turns`(parser `_handleResult` 自增,重启靠 `getMaxTurnIdx` 恢复)既是续轮根治要用的 turn 边界,又是前端 turnId 权威源(前端 `websocket.js:1239` 注释已写 turnId 是 "future protocol upgrade")。本方案让二者收敛为同一权威源——这是 #1/#2(后端续轮)与前端重复/覆盖(L2/L3)共享的同一把钥匙。

## 四、职责分层(Codex review 修正:turnId 非"一统时序")

| 标识 | 权威源 | 职责 | 不负责 |
|---|---|---|---|
| **turnId** | 后端 `turnIndex` | turn 身份;assistant/thinking 块归属的 turn 维 key;live↔durable 对账;final 帧幂等 | 传输顺序 |
| **blockId** | parser `turnId:messageId:blockIndex` | 块身份;同 turn 内 partial→final 幂等;刷新可重建 `_blockIdToMsgId` | 跨 turn 唯一性靠 turnId 前缀保证 |
| **frameSeq** | per-session 传输游标 | 传输顺序;reconnect replay 去重;cursor 推进 | **不参与消息身份** |
| **_replyingToMsgId** | 前端 UI tracker | 用户消息状态绑定(read/replied);空 turn 检测锚点 | **不参与 assistant 消息身份** |

## 五、Codex plan review 采纳记录(7 点全采纳,无反驳)

1. ✅ turnId 不在 `deliver()` 猜 turnIndex —— 在 `_runOneTurn`/parser callback 捕获 `activeTurnId`,re-arm 后更新(流式块在 result 前=turns+1,final 在后=已自增,简单读会不一致)。
2. ✅ frameSeq 保留为 replay/cursor 权威,turnId 不一统时序(见职责分层表)。
3. ✅(阻塞)Phase 3 必须让 live `m-*` 与 durable `srv-*` 通过 turnId 真正收敛,否则重复从"位置式覆盖"变"id-keyed 并存"——伪根治。server-authored 持久化行须带同一 turnId。
4. ✅ blockId=`turnId:messageId:blockIndex`,parser 补 `message_start`/`content_block_start` 状态(现 parser 忽略,只认 tool_use);不赌"CLI 永不复用 message id"。
5. ✅(阻塞)Phase 2 续轮判据改"行为式"非"枚举信号":result 后进入有界等待(复用 90s soft-cap),窗口内 stdout 再吐新 assistant/result 即 re-arm;task_* 仅 hint;system/init 不单独触发。
6. ✅ id-keyed merge 必须显式保住 `_localDominates` 现有 5 职责:顺序、删除传播、server-only 不丢、本地未同步 user/queued 保护、active stream 保护。
7. ✅(阻塞)childBlocks(Agent 卡片内 text/thinking)也纳入 blockId upsert(现 `sync.js:165` 仍 ordered-prefix)。
+ ✅ Phase 0:现有测试先全绿;bug 复现测试**先红后绿**,不锁死坏行为。

## 六、Phase 划分

- **Phase 0**:现有 test:gateway/test:web 全绿 + 写 #1/#2/重复/对账复现测试(先红)。
- **Phase 1**(可独立上线,旧前端忽略 optional 字段):`protocol/frames.ts` 加 optional blockId/turnId;parser 补 message_start/content_block_start 状态 + text/thinking 发 blockId;`_runOneTurn` 捕获 activeTurnId 注入帧。
- **Phase 2**(可独立上线):parser surface 续轮 stdout;sessionManager 行为式有界承接,覆盖 #1+#2,绝不 submit()。
- **Phase 3**(单独 PR,最大风险,含 storage):assistant/thinking/childBlocks 改 turnId+blockId upsert;server-authored 带 turnId;sync 位置式→id-keyed merge(保 5 职责);hydrate/409 用 turnId 吸收 srv-*↔m-*。
- **Phase 4**:dev 验证(#1 dev 复现不了,mock 帧序列 + prod 观察)→ Codex 审 diff → cache-bust+changelog+safe-restart+prod smoke。

## Phase 1 实现记录(2026-06-22)

后端下发已实现并验证:gateway typecheck 0、全套 gateway 测试 548/0、lint 干净、parser 新增 6 个 blockId 测试。worktree 用相对软链让 `@openclaude/*` 指向自身 packages(非主树),获得可信 typecheck。

**Codex Phase 1 code review**:核对 turnId off-by-one / 并发(session.lock 串行)/ re-arm / Anthropic blockId 粒度 / 向后兼容 全部通过。两阻塞项已修:
1. `serverAuthoredMsgId` 收敛全部 `srv-` 构造点(directWrite fallback + crash partial flush)。
2. codex runner(显式 `index:0`、无 message_start)的 text/thinking blockId = `:0`。**决策(部分采纳)**:codex 本就是"一个 turn 一条 assistant 文本(单 buffer delta 累加)+ 合并 thinking"模型,`:0` 是正确粒度;不给 codex 模拟 message_start/递增 index(过度工程,codex delta 无 content-block 边界语义)。改由下方 Phase 3 路由契约解决 text↔thinking 区分。
可选项:error-final 帧已补 turnId;`/compact` 等 system 通知帧不带 turnId(见契约)。

## Phase 3 路由契约(后端下发语义的消费约定)

- 前端 assistant/thinking 的 upsert key = **`${turnId}:${kind}:${blockId}`**(kind 必须参与)。理由:blockId 在不同 kind 间不保证唯一(codex 的 text/thinking 同为 `:0`),kind 入 key 才能区分。
- 同一 content-block 的多个 delta 共享一个 key → 路由到同一条消息(流式累加)。Anthropic 靠 message index 分段(tool 分隔的多段 text 各一条);codex 一个 turn 一条文本 + 合并 thinking(`:0`)。
- turnId 仅用于 **turn 内容帧**(assistant/thinking 流 + final/error-final)。system 通知类帧(`/compact` 完成、rate-limit、上传错误)不带 turnId,前端按现有 system 路径处理。
- live↔durable 收敛:durable row id = `serverAuthoredMsgId(peerId,turnIndex)` = 帧 turnId;前端 hydrate/409 用 turnId 把 `srv-*` 与 live `m-*` 认同一条。

## 七、向后兼容

新字段全 optional;前端缺 blockId/turnId 一律 fallback 旧 `_streamingAssistant` 指针逻辑;渐进迁移非 big-bang;老持久化数据无 blockId/turnId 走 fallback。Phase 1/2 可先上线,Phase 3 单独 PR。

## 实现完成 & 验证汇总(2026-06-22)

**Phase 1 + Phase 3 开发完成**(根治"重复"这条线)。Phase 2(续轮 #1/#2)经 prod 数据决策为独立工程。

- Phase 1(后端下发):frames blockId/turnId、parser message_start+blockId、sessionManager serverAuthoredMsgId 单一来源 + _activeTurnId、server turnId 注入。**Codex PASS**。
- Phase 3(前端+storage 收敛):websocket `_routeStreamingBlock`(turnId:kind:blockId 路由 + 认领 + role 校验)、storage dropPhantom turnId 精确归一。不改 sync.js / childBlocks(已论证)。**Codex PASS**。
- Cache-bust:websocket.js?v=53(全 4 引用一致)、main.js?v=83、sw VERSION v106、officialTerminal 测试期望同步。
- 验证:**web 456/0、storage 71/0、gateway 548/0、typecheck(protocol/storage/gateway)0、lint 干净**。新增 11 个复现测试(parser blockId 6 + 前端路由 9 中的新增 + storage keyed 4)。

**待上线**:dev smoke → merge master → changelog → openclaude-safe-restart(重启 prod)→ prod static marker smoke。重启影响 boss 日常 AI,需确认。

## 八、关键 file:line 索引

- parser:`claudeMessageParser.ts` finalized 守卫 179、`_handleResult` 641-693(turns 自增 655、finalize 678)、content_block_start 428、忽略 message_start/delta/stop 490、text/thinking 无 blockId 457/461
- sessionManager:`_runOneTurn` 续轮 expectsContinuation 1287、re-arm 1688-1704、detach 1324-1342、soft-cap 1348-1360、Phase 0.1 持久化 1546-1622、srv-* id 1562
- gateway 发帧:`server.ts` deliver 6496、frameSeq stamp 6536
- protocol:`frames.ts` OutboundMessage 230、OutboundContentBlock 142、blockId optional 150/162/177/197
- storage:`sessionsDb.ts` appendServerAuthoredPure 幂等 904-911、dropPhantomClientAssistants 609
- 前端:`websocket.js` _blockIdToMsgId 1655-1688、流式指针 1501/1540、turnId-待升级注释 1239、frameSeq 去重 1076-1101、addMessage 272;`sync.js` _localDominates 303-325、childBlocks ordered-prefix 165、active stream 保护 391;`util.js` msgId 4
- 已 ship 续轮承重墙 commit:74118363 / bce59a6f / 401b7bf4
