# 移动端切后台断流修复 — Phase 0 实施计划

## 根因(已二审确认)

`packages/gateway/src/server.ts:3787-3788` 的 `deliver()`: 当 `clientsByPeer` 无客户端时静默丢弃 outbound frame。同时 `server.ts:2651-2660` WS onclose 不 interrupt REPL,子进程继续烧 token 全部被 `deliver()` 丢弃。session.messages 持久化完全依赖客户端 PUT 回灌(`server.ts:976`)。

之前 6 次修复全部修在前端/409 冲突/offline queue,从未触碰 `deliver()`,所以一直没根治。

## Phase 0 三层防线

### 0.1 服务端权威持久化(第 1 层,核心)
- 在 `sessionManager.ts:~891` turn 完成分支 emit turn.completed 前,**服务端主动把 `result.assistantText` 合成 assistant message 写入 client_sessions.messages**
- messageId 由 turnId 派生,保证同一 turn 重复写入幂等
- 新增 storage 函数 `appendServerAuthoredMessage(sessId, userId, messageId, message)`,按 messageId 去重,只 append 不覆盖
- 调整 `upsertClientSession`: 客户端 PUT 时如果 messages 里有与服务端已写同 messageId 的 assistant 消息,不覆盖正文(只允许 client 更新 user messages / 新草稿)
- **效果**: turn 跑完后无论客户端是否在线,服务端都有完整副本。切后台任意时长回来 force sync 都能拉回。

### 0.2 interrupt/stop/crash 语义
- WS onclose 不中断 runner(保持现状) — 因为用户可能快速重连
- 用户点 stop / REPL 异常终止时,aggregator 中已生成的 partial 也写入,status=`interrupted`
- turn 进行中 server crash 的情况: 接受丢失当前 turn(加 telemetry 告警),不引入 per-delta journal(I/O 过重,收益边际)

### 0.3 frameSeq + ring replay(第 2 层,短时断连优化)
- 每个 outbound frame 在 deliver 打 `frameSeq`(per session 单调递增,从 1 开始;0 保留表示"从未收到")
- 每个 sessionKey 一个 ring buffer(2000 帧或 10 分钟任一先到,按字节上限 5MB 剪枝)
- hello 帧扩展 `lastFrameSeq`,autoResumeFromHello 按游标从 buffer 补发
- buffer miss 时发 `outbound.resume_failed { from, to, reason }` → 前端立即 REST force sync

### 0.4 前端 resume + 幂等合并(第 3 层,闭环)
- `websocket.js:734` hello 帧添加 `lastFrameSeq: sess._lastFrameSeq || 0`
- 收到帧按 `frameSeq` 去重(老帧丢弃),按 `messageId` 合并(同 id 替换,不 append)
- onopen 后调用 `syncSessionsFromServer({force:true})` 兜底
- visibilitychange visible 触发 WS 健康检查(发 ping 3s 无 pong 强制 reconnect)
- 收到 `outbound.resume_failed` 立即走 force sync

## 测试矩阵

| 场景 | 期望 |
|------|------|
| 30s 切后台 | WS replay 命中,流继续,无重复 |
| 10min 切后台 | 边界内 replay 命中或 miss 后 REST,无重复 |
| 1h / 隔夜 | REST 拉回完整 assistant 消息 |
| server restart mid-turn | 仅丢当前 turn,有告警 telemetry |
| 多 tab | 一个断开不影响其他 tab,恢复无重复 |
| stop | 保留 partial assistant,status=interrupted |
| DB down | 持久化降级 outbox,恢复后补写(不丢) |

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `packages/gateway/src/sessionManager.ts` | turn.completed 前写服务端权威 assistant message |
| `packages/storage/src/sessionsDb.ts` | 新增 appendServerAuthoredMessage + upsertClientSession 合并策略 |
| `packages/gateway/src/server.ts` | deliver 加 frameSeq + ring buffer + autoResumeFromHello 游标重放 |
| `packages/web/public/modules/websocket.js` | hello 加 lastFrameSeq + frameSeq 去重 + resume_failed 处理 |
| `packages/web/public/modules/sync.js` | 去重合并时尊重 server-authored messageId |
| `packages/web/public/modules/main.js` | visibilitychange WS 健康检查 |

## 上线流程

1. dev worktree 实测全部测试矩阵通过
2. 代码交 Codex 三审
3. 合 master + bump sw.js/?v= (按 openclaude-release-checklist skill)
4. `openclaude-safe-restart`

## 后续阶段(Phase 0 稳定后)

- Phase 1: 通用 session_changed 广播(其他入站源也能实时推到 web)
- Phase 2: 移动端三档断点 + 折叠屏渐进增强 + iOS VisualViewport + 横屏 safe-area
- Phase 3: 顶部 progress bar + 会话切换 fade + 列表 skeleton
