# V3 commercial — 前后端消息一致性根治计划

**Bug 入口**:刷新页面后 token 用量行(`8 积分 · in 13178 · out 15 · cache-r 11648 · T1`)和"已回复"角标双双消失。
**Boss 要求**:不是补丁,要根治 + 架构合理 + 用例覆盖好。

---

## 一、问题根因(架构层)

### 1.1 客户端 `messages` blob 把"应该是服务端权威字段"伪装成本地派生字段
| 字段 | 现状 | 该谁权威 |
|------|------|----------|
| `metaText` ("8 积分 · in N · out M…") | 客户端 `formatMeta()` 拼后写 `msg.metaText`,持久化进 IDB + PUT 进 server | **应由服务端持久化 `usage`,客户端按需重渲** |
| `_rawMeta` (`{costCredits, inputTokens, outputTokens, cacheReadTokens, totalCost, ...}`) | 客户端从 outbound.assistant_meta 帧聚合,持久化进 IDB,但服务端**无对应字段** | **应由服务端 `usage` 字段权威** |
| `status: 'replied'` | 仅当 `isFinal` 帧到达时客户端置位 | **应由"是否存在后续 assistant 消息"派生**,无需服务端字段 |
| `_truncated`, `_errorCode`, `_errorDetail` | 客户端从 outbound.error/truncate 帧打的标记,持久化但服务端无对应字段 | **应由服务端权威**(server-authored 消息一并写入) |
| `_partial`, `_completed`, `output`, `error`, `bashTail`, `inputJson`, `inputPreview` | 工具调用流式中间态,持久化进 IDB | **永远 ephemeral,不该进 IDB,不该 PUT** |

### 1.2 服务端权威路径丢字段
- `anthropicProxy.finalize.commit`(2008-2048)算出真实扣费 `costCredits` 后**仅 WS 广播 `outbound.cost_charged`**,没回写到 master SQLite。
- `internalServerAuthored.ts`(container → master 持久化通道)的 schema 只接受 `text/thinkingText/status`,**不接受 usage**。
- 结果:server 持久化的 assistant 消息里没有 token 数 / 不带积分。

### 1.3 server-wins 路径整组覆盖 → 客户端派生字段被擦
`sync.js:716-724` 在 PUT 409 → server-wins 时:
```js
Object.assign(target, { ..., messages: server.messages || [] })
```
完整替换 messages 数组。server 返回的 messages 没有 `metaText/_rawMeta/status/_truncated`,客户端持有的派生字段被一次性 wipe。`dbPut` 紧跟其后 → IDB 同样被擦 → 刷新看到的就是擦后状态。

### 1.4 `mergePreservingServerAuthored` 同样会丢
服务端在 PUT ingest 时,以 server-authored 版本替换客户端同 id 的 assistant 消息(sessionsDb.ts:578-583)。server-authored 版本只有 `id/role/text/ts/status/_source`,不带 usage —— 客户端发上来的 `metaText` 等被擦。

**= 双向都会丢:client 偶尔收到完整的 cost_charged 帧,但任何一次 server-roundtrip 都会把它擦干净。**

---

## 二、根治原则

1. **每字段唯一权威**(SSoT per field):每个字段明确归属 server 或 client,不允许双写竞争。
2. **派生字段渲染时再算**(derived at render):能从权威字段推出的 UI 字符串,绝不持久化。
3. **流式中间态绝不持久化**(streaming ephemeral never persists):`_partial/_completed/_streamingAssistant/_rawMeta` 等在内存活,落 IDB / 上 server 时被 strip。

---

## 三、字段重新归属

| 类 | 字段 | 持久层 | 写入方 | 读取方 |
|----|------|--------|--------|--------|
| **A. 服务端权威(已实现)** | `id, role, text, _seq, _source, ts, createdAt, completedAt, childBlocks(final)` | server SQLite + IDB(GET 镜像) | server-authored 路径 | 客户端 render |
| **B. 服务端权威(本次新增)** | `usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costCredits, model, turn }` | server SQLite + IDB | container v3MasterSink (tokens) + master anthropicProxy.commit (costCredits) | 客户端 `formatMeta(msg.usage)` |
| **B**(续) | `_truncated, _errorCode, _errorDetail` | server SQLite + IDB | server-authored 路径(扩展 schema) | 客户端 render |
| **C. 客户端 ephemeral**(永不持久化) | `_streamingAssistant, _streamingThinking, _blockIdToMsgId, _partial, _completed, output, error, bashTail, inputJson, inputPreview, _rawMeta, _lastFrameSeq, _pendingCostCredits, _lastFinaledAssistantId, _lastFinaledAt, _streamRafPending, _thinkRafPending, _searchText, _sendingInFlight, _replyingToMsgId, _agentGroups, _turnStartedAt, _lastFrameAt, _dirty, _syncedAt, _baseSyncedAt` | 无(内存) | 客户端 | 客户端 |
| **D. 客户端持久 / 不外传** | `_media`(本地预览图)、`_modelText`(发给模型的全文,含附件) | IDB only | 客户端 send 时 | 客户端 replay 时 |
| **E. 删除字段** | `metaText` | 退役 | — | — |
| **F. 客户端派生 status** | `'sending' / 'queued' / 'sent'` 仍由客户端管,**'replied' 改为派生**:user 消息后存在 `role:'assistant'` 且 `_source:'server'` 即视为已回复 | 客户端内存 | 客户端(render 时算) | 客户端 render |

---

## 四、实施清单

### 4.1 storage(`packages/storage/src/sessionsDb.ts`)

#### 改动 1: messages PUT 时按入口分 schema strip(关键)
**Codex 评审 R1 收紧**:不能用单一全局白名单。client PUT 入口和 server-authored 入口必须各自有独立的字段允许集,否则 `_source/_seq/usage/_truncated/_errorCode/_errorDetail/status='replied'` 这些"应当 server 权威"的字段会被 client 伪造写入。

```ts
// CLIENT PUT 入口:仅允许 client-authored 消息内容 + 客户端持久私有字段
const CLIENT_PUT_ALLOWED_FIELDS = new Set<string>([
  // 消息身份与内容(client 创建 user / tool / agent-group 时合法)
  'id', 'role', 'text', 'ts', 'createdAt', 'completedAt',
  'childBlocks', 'agentName', 'agentId',
  // 工具消息合法字段
  'toolName', 'toolIcon', 'toolInput', 'toolUseId', 'parentToolUseId',
  // empty-turn / cron 元数据
  '_emptyTurn', '_emptyTurnSoft', '_emptyTurnStopReason', 'cronJob',
  // 客户端持久私有字段(IDB only,server 当作不透明 blob 透传)
  '_media', '_modelText',
])
// status 单独处理:仅允许 'sending'/'queued'/'sent'/'read';
// 'replied' 由派生算出,client PUT 显式 strip 掉避免污染。
const CLIENT_PUT_ALLOWED_STATUSES = new Set(['sending', 'queued', 'sent', 'read'])

// 显式禁止从 CLIENT PUT 进入的"server 权威"字段(防御性 deny-list,
// 命中即丢弃 + 计数 metric 用于发现端拼错或脚本攻击):
const SERVER_AUTHORITATIVE_FIELDS = new Set([
  '_source', '_seq', 'usage',
  '_truncated', '_errorCode', '_errorDetail',
])

function _normalizeIncomingMessage(msg: unknown): MessageLike | null {
  if (!msg || typeof msg !== 'object') return null
  const src = msg as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    if (CLIENT_PUT_ALLOWED_FIELDS.has(k)) {
      out[k] = src[k]
    } else if (k === 'status') {
      if (typeof src[k] === 'string' && CLIENT_PUT_ALLOWED_STATUSES.has(src[k] as string)) {
        out.status = src[k]
      }
      // status='replied' 或非法值 → drop。
    } else if (SERVER_AUTHORITATIVE_FIELDS.has(k)) {
      // 上 metric `client_put_blocked_field` 标记可疑写入,同时 drop。
    }
    // 其余未知字段(metaText / _rawMeta / _partial / output / ...) → 静默 drop。
  }
  return out as MessageLike
}
```

server-authored 写入路径(`appendServerAuthoredMessage`)**不走这层 schema** —— 它是 server 内部代码,自我授信;它写的 `_source:'server'` / `_seq` / `usage` / `_truncated` / `_errorCode` / `_errorDetail` 是合法权威。

`mergePreservingServerAuthored` 在 PUT ingest 时仍以 server-authored row 替换同 id —— 这层保持不变;由它消化"client 想覆盖 server 权威字段"的尝试(client 写来的 assistant 同 id 但缺 usage,server 版本胜出 → usage 保留)。

理由:**两层防御 + 字段级权威清晰**。即便客户端改 bug 引发漏写或恶意构造,server 都不可能被污染。

#### 改动 2: server-authored payload 接受 usage / _truncated / _errorCode / _errorDetail
`appendServerAuthoredMessage(sessId, userId, msg)` 的 `msg` 参数已经是任意 `MessageLike`,无需类型改造。但要在 `_SEQ_CONTENT_IGNORE_FIELDS` 之外(usage **包含**在 content 里 → 加 usage 字段会导致 `_seq` 重新分配)加 helper 解释 `usage` 字段的 `_seq` 语义:**usage 的写入应当算 server-visible 内容变化,触发新 seq**(让 client 增量 GET 看到 usage 已落)。

#### 改动 3: 单写聚合点 — server-authored 入口由 master 唯一组装 usage(Codex R2 修订)

**R1 修正**:in-memory Map TTL 缓存不能做 durability,改为 durable 表。
**R2 修正**:仅靠 `pending_usage_patches` + msgId 的等待区不够;**sink 先到 + commit 后到** 场景下,commit 的 pending 记录无法被 drain(drain 只发生在 sink POST 同事务里)→ 永久孤儿。
**新方案**:**双表协同** — `server_authored_request_map`(已写消息的 requestId 索引) + `pending_usage_patches`(commit 早到 / 消息未写时的等待区)。

**所有 SQL 落在 storage SQLite(better-sqlite3)** —— `client_sessions` 已经在 SQLite 上,跨库一致性成本太高,本 PR 全部用 SQLite。

```sql
-- 0xxx_usage_aggregation.sql (SQLite)
-- 已写 server-authored message 的 requestId 索引 — commit 路径靠它定位 message
-- 主键改为 (request_id, user_id) 复合键 (Codex R4):防 requestId 跨用户碰撞导致
-- 第二个 user 的 message 写入但 map 不写,后续 appendCostCredits 落孤儿。
CREATE TABLE server_authored_request_map (
  request_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  written_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX idx_sarm_session ON server_authored_request_map(session_id, msg_id);
CREATE INDEX idx_sarm_written ON server_authored_request_map(written_at);

-- commit 早到 / message 还没写时的等待区
-- 主键同样改为 (request_id, user_id) 复合键 (Codex R4):防跨用户 cost 互相覆盖。
CREATE TABLE pending_usage_patches (
  request_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  session_id   TEXT,                  -- 可空:commit 拿不到 session 时仍能落
  cost_credits TEXT NOT NULL,         -- BigInt 字符串
  created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX idx_pup_created ON pending_usage_patches(created_at);
```

**事务模型 — better-sqlite3 适配(Codex R3 修订)**:better-sqlite3 不支持把外部 tx 句柄传进函数;只能用 `db.transaction(() => { db.prepare(...) })` 函数包装。所以**协议必须收敛到 storage 包内部 2 个新 API**,commercial 包(internalServerAuthored / anthropicProxy / userChatBridge)只调高层 API,不直接接触 SQLite。

**Storage 包对外 API**:
```ts
// 替代旧的 appendServerAuthoredMessage(sessId, userId, msg)
// 内部开一个 SQLite transaction:drain pending → append message → insert request_map → delete pending
export async function appendServerAuthoredMessageForRequest(
  requestId: string,
  sessId: string,
  userId: string,
  msg: MessageLike & { id: string },
): Promise<{ applied: true; messages: MessageLike[] } | { applied: false; reason: 'already_exists' | 'session_not_found' | 'malformed' }>

// commit 路径:in-place patch 已有 message,或落 pending
// 内部开自己的 SQLite transaction
export async function appendCostCredits(
  requestId: string,
  userId: string,
  costCredits: string,    // BigInt 字符串
): Promise<{ applied: 'patched' | 'pending' | 'noop' }>
// 'noop': 同 requestId 已 patch 过且 costCredits 一致 → 幂等(防 commit 失败重试 spurious _seq bump)
```

**写入时序无关协议(双表协同,任意先到都正确,storage 内部实现)**:

A. **`appendServerAuthoredMessageForRequest` 实现伪码**:
```ts
const txn = db.transaction((requestId, sessId, userId, msg) => {
  // 1. drain pending(commit 早到的情况)
  const pending = db.prepare('SELECT cost_credits FROM pending_usage_patches WHERE request_id = ? AND user_id = ?').get(requestId, userId)
  const finalUsage = msg.usage ? { ...msg.usage } : (pending ? {} : undefined)
  if (pending) finalUsage!.costCredits = pending.cost_credits

  // 2. 写消息(走现有 appendServerAuthoredPure 逻辑,把 finalUsage 注入)
  const finalMsg = finalUsage ? { ...msg, usage: finalUsage } : msg
  const r = _appendServerAuthoredCore(sessId, userId, finalMsg)  // 提取的同步内部 helper
  if (!r.applied) return r

  // 3. 写 requestId 反查索引(主键 (request_id, user_id) 防跨用户碰撞;
  //    若同 (request_id, user_id) 已存在 → 重试场景,不变)
  db.prepare(`INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
              VALUES (?, ?, ?, ?) ON CONFLICT (request_id, user_id) DO NOTHING`).run(requestId, userId, sessId, msg.id)

  // 4. drain 后清 pending(已按 (request_id, user_id) 双键查到,删除同样)
  if (pending) db.prepare('DELETE FROM pending_usage_patches WHERE request_id = ? AND user_id = ?').run(requestId, userId)
  return r
})
return txn(requestId, sessId, userId, msg)
```

B. **`appendCostCredits` 实现伪码**:
```ts
const txn = db.transaction((requestId, userId, costCredits) => {
  // 1. 反查 message — 加 user_id 双键防御(Codex R3 安全建议)
  const row = db.prepare(`SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?`).get(requestId, userId)
  if (row) {
    const sess = db.prepare(`SELECT messages, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(row.session_id, userId)
    if (sess) {
      const msgs = JSON.parse(sess.messages)
      const idx = msgs.findIndex((m) => m && m.id === row.msg_id && m._source === 'server')
      if (idx >= 0) {
        const existing = msgs[idx].usage?.costCredits
        // 幂等:同值 → no-op,不 bump _seq(commit 失败重试场景)
        if (existing === costCredits) return { applied: 'noop' }
        msgs[idx] = { ...msgs[idx], _seq: sess.next_seq, usage: { ...(msgs[idx].usage || {}), costCredits } }
        db.prepare(`UPDATE client_sessions SET messages = ?, next_seq = next_seq + 1, updated_at = ? WHERE id = ? AND user_id = ?`)
          .run(JSON.stringify(msgs), Date.now(), row.session_id, userId)
        return { applied: 'patched' }
      }
    }
    // request_map 残留但 message 已删 → fall through 落 pending(可被 GC 兜底)
  }
  db.prepare(`INSERT INTO pending_usage_patches (request_id, user_id, session_id, cost_credits)
              VALUES (?, ?, NULL, ?) ON CONFLICT (request_id, user_id) DO UPDATE SET cost_credits = excluded.cost_credits`)
    .run(requestId, userId, costCredits)
  return { applied: 'pending' }
})
return txn(requestId, userId, costCredits)
```

**优点**:
- **跨进程跨重启正确**:全 SQLite 持久化,better-sqlite3 transaction function 保证原子。
- **时序无关闭合**:任意一方先到 → 对方一定能在自己 transaction 里看到对方留下的数据并完成合并。无孤儿。
- **多 cost_charged 出口统一**:anthropicProxy.commit / userChatBridge.codex commit 共用同一 `appendCostCredits` API。
- **单写聚合点**:`appendServerAuthoredMessageForRequest` 是唯一把 usage 写进 messages blob 的入口;`appendCostCredits` 要么 in-place patch 要么落 pending,不会重复写。
- **幂等**:commit 失败重试 / 同值多次调 → no-op,不无谓 bump `_seq`。
- **跨用户安全**:`server_authored_request_map` 与 `pending_usage_patches` 主键均为复合键 `(request_id, user_id)`,且所有 INSERT 用 `ON CONFLICT (request_id, user_id)` —— 即便 requestId 跨用户碰撞或错路由,两个 user 各自的行独立存在,既不会跨用户 patch 错消息(`appendCostCredits` 反查带 user_id 找不到 → 落自己的 pending),也不会因 `INSERT INTO map ON CONFLICT (request_id) DO NOTHING` 让第二个 user 的 map 缺失变成孤儿(R4 修订前是这个 bug)。

**孤儿清理(Codex R3 调整)**:
- `server_authored_request_map`:保留 7d(按 written_at GC)。
- `pending_usage_patches`:**改为 24h 起步硬删,1h 起触发 metric/alarm**。这样合法慢恢复(master/gateway 重启 + outbox replay 等)有充足窗口完成,异常情况靠告警发现而不是早删隐藏。两表均 metric 上报。

**时序矩阵(Codex R3 验证)**:
| 场景 | 结果 |
|---|---|
| A (appendCostCredits) 早,B (sink POST) 晚 | A 落 pending;B drain pending、append message+usage、写 map、删 pending。OK(pending 在 24h 内)。 |
| B 早,A 晚 | B 写 message + map;A 查 map 命中 → in-place patch usage.costCredits,bump _seq。OK(map 在 7d 内)。 |
| 同时到 | SQLite 写事务串行化,退化成上面两种之一。OK。 |
| A 失败重试 | transaction function 失败 = 无半写,重试正常;若上次实际成功但调用方误以为失败 → 第 2 次 `existing===costCredits` → noop,无 spurious _seq bump。 |
| B 失败重试 | transaction function 失败 = 无半写,重试正常。 |
| A 写 pending 后 B 永远不来(异常) | 1h metric 报警 → 排查上游;24h 兜底 GC,丢 cost(罕见极端)。 |

#### 改动 3a: `_seq` 重分配语义
当 in-place patch usage 时(改动 3 步骤 1),按 `mergePreservingServerAuthored` 文档的 `_SEQ_CONTENT_IGNORE_FIELDS` 语义:`usage` 不在忽略集合内,所以 patch 后 row 的 `_seq` 必须递增到 `nextSeq`。这让客户端增量 GET cursor 推进,新 usage 字段被 same-id replacement 路径(`_mergePartialTail` 已支持)拉到。

**不会引起 UI 闪烁的理由**:assistant 消息的 text/childBlocks 内容不变,只是 usage 字段加了 costCredits → render 走相同 message id 的同位替换(`messages.js` 既有的 update 路径)→ DOM diff 仅 token meta 行重渲,不重建消息气泡。仍要在测试 T22 显式断言"无 DOM 重建闪烁"。

### 4.2 commercial — anthropicProxy(`packages/commercial/src/http/anthropicProxy.ts`)

#### 改动 4: finalize.commit 后调 appendCostCredits(durable patch / pending fallback)

**Codex R1 修正**:`turnIndex` 不再从 metadata 解析。改为以 `requestId` 为关联主键。msgId 仍是 `srv-${sessionId}-t${turnIndex}`,但 turnIndex 由 sink POST 携带(本来就有,见 4.4)→ 通过 finalize_journal 表反查 `requestId → turnIndex / sessionId` 拿到精确 msgId。

在 `outcome = await finalize.commit(observed)` 后、broadcast cost_charged 之前:

```ts
if (outcome.state === 'committed' && outcome.debitedCredits !== null && outcome.debitedCredits > 0n) {
  try {
    // 签名简洁 — 不需要 sessionId / msgId / turnIndex,storage 侧靠 server_authored_request_map
    // 反查;反查不到落 pending_usage_patches 等待 sink POST drain。详见 §4.1 改动 3。
    await deps.storage.appendCostCredits(requestId, uid.toString(), outcome.debitedCredits.toString())
  } catch (err) {
    userLog.warn('proxy_persist_costcredits_failed', { err: errSummary(err), requestId })
    // 失败不抛 — broadcast 仍发出。pending GC sweep 会 metric 报告。
  }
}
```

`userChatBridge.ts` 的 codex billing commit 路径(§4.2 改动 4a)走同一个 helper,签名一致。

#### 改动 4a: codex billing commit 路径同样接入 appendCostCredits(Codex R2)

**Codex R2 阻塞性问题**:claudeai.chat 还有第二个 cost_charged 出口 — `userChatBridge.ts:1788` 的 `outbound.codex_billing → snap.finalizer.commit → outbound.cost_charged`(用于 Codex 模式)。如果只接 anthropicProxy.commit,Codex 模式刷新后仍丢。

`userChatBridge.ts` 在 `if (debit > 0n) broadcastToUser(...)` 分支(约 1791-1810)调:
```ts
await deps.storage.appendCostCredits(requestId, uid.toString(), debit.toString())
```
**签名只 3 参**(Codex R3 修正):requestId 来自帧透传(master 生成、容器透传,inflightCodexTurns 命中 + finalizer 用 snap → 可信);userId 来自 uid;不需要 sessionId / msgId / turnIndex —— 定位完全交给 `server_authored_request_map`。

**所有产生 outbound.cost_charged 的 commit 点必须接入同一个 durable helper**。回归测试 `userChatBridgeCodexBilling.test.ts` 扩展一条:成功结算后 server GET 的 assistant message 已带 `usage.costCredits`。

#### 改动 5: 已有 cost_charged 广播保留不动
broadcast 仍然发,作为"在线快显"通道(in-page UX,无延迟)。**broadcast 不是 durability source**,持久化由 4.1 改动 3 的 single-writer aggregation 保证。客户端收到 broadcast 时:
- 仅更新内存 msg.usage(不写 metaText、不写 _rawMeta 副本)
- 不发 PUT(避免触发 server-side strip 把派生字段擦掉的多余 round-trip)
- 下次 GET 时 server 返回的 messages.usage 已经包含 costCredits,内存与 IDB 保持一致

**反 broadcast/persist 重复累加的口子**:client 在收到 broadcast 时 `msg.usage.costCredits = bcost`(覆盖,不累加 — 因为 commit 一次只 broadcast 一次);后续 GET 拉到 server 持久化的 `usage.costCredits = scost` 时,只要 `scost === bcost` → 无操作,反之 → server 胜出。L2 backlog(cost_charged 进 outboundRing replay)未来上线时,**replay 帧必须自带 dedupe key (= requestId),client 见过即跳过累加**,避免本 PR 持久化 + replay 双写翻倍。

### 4.3 commercial — internalServerAuthored(`packages/commercial/src/http/internalServerAuthored.ts`)

#### 改动 6: 扩展 schema 接受 usage + 错误标记 + requestId
```ts
const BodySchema = z.object({
  sessionId: ...,
  turnIndex: ...,
  status: ...,
  text: ...,
  thinkingText: z.string().min(1).max(MAX_BODY_BYTES).optional(),
  createdAt: ...,
  // === 新增 ===
  requestId: z.string().min(8).max(128),  // 关联 pending_usage_patches 的主键
  usage: z.object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheCreationTokens: z.number().int().min(0).optional(),
    model: z.string().max(128).optional(),
    turn: z.number().int().min(0).optional(),
  }).strict().optional(),
  truncated: z.boolean().optional(),
  errorCode: z.string().max(64).optional(),
  errorDetail: z.string().max(2048).optional(),
}).strict()
```

`internalServerAuthored.ts` 不再直接调 `appendServerAuthoredMessage`,改调 storage 包的 `appendServerAuthoredMessageForRequest(requestId, sessionId, userId, msg)`(§4.1 改动 3 定义)。后者在 storage 包内部开 SQLite transaction,完成 drain pending → append message → insert request_map → delete pending 全套原子操作:

```ts
// commercial 端只做 schema 验证 + 字段组装,不接触 SQLite
const msg = {
  id: messageId, role: 'assistant', text: body.text,
  ts: assistantTs, status: body.status,
  ...(body.usage ? { usage: body.usage } : {}),
  ...(body.truncated ? { _truncated: true } : {}),
  ...(body.errorCode ? { _errorCode: body.errorCode } : {}),
  ...(body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
}
const result = await deps.storage.appendServerAuthoredMessageForRequest(
  body.requestId, body.sessionId, userId, msg
)
// thinking-only 路径走另一个相似 helper:appendServerAuthoredMessage(sessId, userId, msg)
// (无 requestId 关联,因为 thinking 不带 cost,不需要 patch 路径)
```

**status 防御**:外层无论 client 端如何篡改,server-authored 写入的 status 永远是 schema enum `'completed'/'interrupted'/'crashed'`,**绝不会写 'replied'**,'replied' 由前端派生。

### 4.4 gateway — v3MasterSink(`packages/gateway/src/v3MasterSink.ts`)

#### 改动 7: 在 stream end 收集到 usage 后随 POST 一起送 + requestId
v3MasterSink 已经接受 `Payload` 形参,扩展之:

```ts
export interface Payload {
  sessionId: string
  turnIndex: number
  status: 'completed' | 'interrupted' | 'crashed'
  text: string
  thinkingText?: string
  // === 新增 ===
  requestId: string  // 必填 — 关联 master 端 pending_usage_patches
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    model?: string
    turn?: number
  }
  truncated?: boolean
  errorCode?: string
  errorDetail?: string
}
```

调用方(`packages/gateway/src/anthropic.ts` 或 stream-finalizer)在 `message_stop` 事件聚合 usage 时一并填上。**requestId 必填**:container 已经从上游 anthropicProxy 收到的请求头里能提取(`x-openclaude-request-id` 或类似),需要在 stream begin 时存到本会话的 turn 上下文,stream end 时取出传给 sink。

### 4.5 frontend — formatMeta 改为读 `msg.usage`(`packages/web/public/modules/websocket.js`)

#### 改动 8: `formatMeta` 入参语义切换
从 `formatMeta(rawMeta)` 改为 `formatMeta(msg)`,内部从 `msg.usage` 取字段:
```js
export function formatMeta(msg) {
  if (!msg) return ''
  const u = msg.usage || msg._rawMeta || msg  // 兼容旧 _rawMeta 残留
  const parts = []
  if (u.costCredits !== undefined && u.costCredits !== null) parts.push(formatCreditsInline(u.costCredits))
  if (typeof u.inputTokens === 'number') parts.push(`in ${u.inputTokens}`)
  if (typeof u.outputTokens === 'number') parts.push(`out ${u.outputTokens}`)
  if (u.cacheReadTokens > 0) parts.push(`cache-r ${u.cacheReadTokens}`)
  if (typeof u.turn === 'number') parts.push(`T${u.turn}`)
  return parts.join(' · ')
}
```

#### 改动 9: setMeta 退役为 setUsage
- 删 `setMeta(sess, msg, metaText)` 函数体里的 `msg.metaText = metaText`,只保留 DOM 更新触发。
- 新增 `setUsage(sess, msg, usagePartial)`:`msg.usage = { ...msg.usage, ...usagePartial }` 后 trigger DOM。
- 所有 `setMeta(...formatMeta(_rawMeta))` 调用点改为 `setUsage(sess, msg, _rawMeta)` —— 让 DOM 重渲走 `formatMeta(msg)`。

#### 改动 10: handleCostCharged 更新 msg.usage 而非 metaText
```js
target.usage = { ...(target.usage || {}), costCredits: (cur + add).toString() }
updateMsgMetaEl(target)  // 让 DOM 走 formatMeta(target)
```
不再写 `_rawMeta.costCredits`(_rawMeta 由内存累加器暂存,但**不写 message.usage 之外的副本**)。

#### 改动 11: 发送 PUT 前 strip
`pushSessionToServer` 在拷贝 sess 时已 strip 了 session 级 ephemeral 字段,但 messages 内的 `_rawMeta/_partial/_completed/output/error/bashTail/...` 没 strip。新增 `_stripMessageEphemeral(messages)` 在 PUT body 前应用 —— 与 4.1 server 端 strip 形成"双层防御"。

### 4.6 frontend — messages.js 渲染(`packages/web/public/modules/messages.js`)

#### 改动 12: render 时改读 `formatMeta(msg)`
- `if (msg.metaText)` → `const meta = formatMeta(msg); if (meta)` (两处:1801, 1946)
- `renderMetaInto(el, msg.metaText)` → `renderMetaInto(el, meta)`

#### 改动 13: status 'replied' 派生 — 严格化(Codex R1)

**Codex R1 修正**:
- thinking-only turn 不算 'replied'(对的,只有思考没回复)。
- interrupted/crashed turn 不算 'replied'(显示 'sent' 更准,boss 能看到没回完的状态)。
- 历史 `m.status === 'replied'` **不无条件保留**(就是要清洗的污染源,在 dbGetAll 阶段一并 strip)。
- 显式 'replied' 写入路径**整体退役**(websocket.js:1680 处 `_targetMsg.status = 'replied'` 删除),改为依赖派生函数的纯结构化判断。

```js
// status: 'sending' / 'queued' / 'sent' / 'read' 是 client UI 自管的,
//         'replied' 永远不持久化,纯从消息序列派生。
function _deriveUserMsgStatus(messages, idx) {
  const m = messages[idx]
  // 显式发送中状态保留(用户视角:sending → queued → sent)
  if (m.status === 'sending' || m.status === 'queued') return m.status
  // 派生 replied:扫描后续 messages,直到下一个 user 边界
  for (let j = idx + 1; j < messages.length; j++) {
    const next = messages[j]
    if (!next) continue
    if (next.role === 'user') break  // 下一 user 之前没 completed server-authored assistant → 没回复
    if (next.role !== 'assistant') continue  // 跳过 thinking / tool / agent-group 等
    if (next._source !== 'server') continue  // 仅 server-authored 算 replied(本地流式分段不算)
    // status 字段在 server-authored 上是 'completed'/'interrupted'/'crashed'(见 4.3 schema)
    if (next.status === 'completed') return 'replied'
    // interrupted/crashed:显示 'sent' 但角标可加 hint(本 PR 不强求,留 backlog)
  }
  return m.status || 'sent'
}
```

**'replied' 写入路径全退役**:
- `websocket.js:1680` 的 `_targetMsg.status = 'replied'` 删除。
- isFinal 帧到达时不再修改 user msg.status,UI 角标改由 render-time 派生函数实时计算。
- 派生函数依赖的"有 server-authored assistant 落在 messages 数组里"由 `outbound.assistant_meta` / `internalServerAuthored` 共同保证(server 写入完成后,下一次 maybeSyncNow 会 GET 到带 `_source:'server'` 的 assistant)。

**反弹延迟问题**:isFinal 到达后,client 的 assistant 消息暂时是 `_source` 缺失(本地流式产生)。此时 `_deriveUserMsgStatus` 返回 'sent' 而非 'replied'。直到 server-authored 版本通过 GET 进 sess.messages(merge 后由 mergePreservingServerAuthored 替换),角标才升为 'replied'。延迟通常 <500ms,可接受;**渲染层在 isFinal 后立即触发一次 maybeSyncNow** 加快可见性(其实已经有,checked websocket.js)。

### 4.7 frontend — db.js 加载自愈(`packages/web/public/modules/db.js`)

#### 改动 14: dbGetAll 加历史污染过滤(条件化清洗,避免 revert 不可逆)

**Codex R1 修正**:回滚不能"无副作用 revert"是真的(老前端依赖 metaText / _rawMeta 才能显示)。改为**条件化清洗**:仅在该 message 已经有 server-authoritative `usage` 字段时才清洗历史 metaText / _rawMeta;没有 usage 的老 message 保留 metaText/_rawMeta 让老路径(formatMeta fallback)继续显示。

```js
function _normalizeLoadedSession(sess) {
  if (!sess?.messages) return sess
  for (const m of sess.messages) {
    if (!m) continue
    // ephemeral 字段一律 strip(它们就不该持久化,任何前端版本都不该读)
    delete m._partial; delete m._completed; delete m.output; delete m.error
    delete m.bashTail; delete m.inputJson; delete m.inputPreview
    // 'replied' 状态污染 strip(本 PR 改派生)
    if (m.status === 'replied') delete m.status
    // 派生 meta 字段:仅在 usage 已就位时清洗(条件化,保留 revert 路径)
    if (m.usage) {
      delete m.metaText
      delete m._rawMeta
    }
    // 没有 usage 的老 row 保留 metaText/_rawMeta —— 老前端代码 path 仍可显示;
    // 新前端的 formatMeta 会 fallback 到 _rawMeta(见改动 8),也能显示。
    // 直到该 message 经历下一次 server-authored 写入(刷新页面 + GET) →
    // server 返回带 usage → 下次 dbGetAll 时清洗,自然 forward-only 收敛。
  }
  return sess
}
```

**自愈收敛模型**:
- 老 row 无 usage:dbGetAll 不清洗 → 老/新前端都用 _rawMeta 显示。
- 新 row 有 usage(本 PR 部署后产生):dbGetAll 清洗 metaText/_rawMeta → 新前端用 formatMeta(usage)。
- 新 row + 旧前端代码(理论上不存在;部署有原子性):旧前端读不到 metaText/_rawMeta → 不显示 meta 行,不破坏。

**回滚契约**(写入新条款,见 §六):**仅在 server 端(改动 1)启用 strip 后再启用前端清洗**。两步部署、两步回滚。

### 4.8 frontend — sync.js 5 个 server-wins 路径(关键)

**保持不变**。理由:经过 4.1 + 4.2 + 4.3 后,`server.messages` 已经携带 `usage / _truncated / _errorCode / _errorDetail` —— 整组 `Object.assign` 替换不再丢字段。只要新增的 4 个 helper 函数(strip / formatMeta / 派生 status / dbGetAll 清洗)都到位,server-wins 就不再是漏洞而是**唯一可信权威源**的合理实现。

---

## 五、测试矩阵(boss 强调"用例覆盖好")

### 5.1 storage 单元测试(`packages/storage/src/__tests__/sessionsDb.test.ts` 新增/扩展)

- `T1` `upsertClientSession 白名单 strip`:client PUT 包含 `metaText/_rawMeta/_partial/output/foo`,SELECT 后 messages blob 不应包含这些字段。
- `T2` `client PUT 入口字段切分`:client PUT body 含 `text/role/childBlocks/_media/_modelText`(合法) → 保留;含 `_seq/_source/usage/_truncated/_errorCode/_errorDetail/status:'replied'`(server 权威)→ strip + metric `client_put_blocked_field` 命中。
- `T3` `appendCostCredits 命中已有 server-authored row`(B 早 A 晚):预先 `appendServerAuthoredMessageForRequest(reqA, sess, uid, msg)` 写入 → 后调 `appendCostCredits(reqA, uid, '8')` → SELECT 后 messages[i].usage.costCredits === '8'(原 inputTokens 保留 + 新 costCredits 加入),`_seq` 递增。
- `T4` `appendCostCredits 未命中 → pending`(A 早 B 晚):`appendCostCredits(reqB, uid, '8')` 返回 `applied:'pending'` + `pending_usage_patches` 表有行;后续 `appendServerAuthoredMessageForRequest(reqB, sess, uid, msg)` → drain pending → 写入 messages[i].usage.costCredits === '8',pending 表清空,request_map 表新增。
- `T5` `appendCostCredits 幂等`(A 重试):同 (reqId, costCredits) 第二次调用 → 返回 `applied:'noop'`,`_seq` 不变。
- `T6` `跨用户 requestId 碰撞防御`(Codex R4 三个子用例):
  - `T6a` 反查路径:reqA 由 user X 写入 request_map,user Y 调 `appendCostCredits(reqA, Y, '8')` → `WHERE request_id=? AND user_id=?` 查不到 → 落 pending(用 Y 的 user_id)而不是误 patch X 的消息;X 的消息 SELECT 后 usage 不变。
  - `T6b` pending 写入跨用户互不覆盖:user X 先 `appendCostCredits(reqA, X, '5')` 落 pending(X 行,cost='5');user Y 再 `appendCostCredits(reqA, Y, '8')` 落 pending(Y 行,cost='8');两行并存。SELECT 后 X 行 cost='5' 未被 Y 覆盖。
  - `T6c` map 写入跨用户互不挤占:user X 先 `appendServerAuthoredMessageForRequest(reqA, sessX, X, msg1)` 写入 map(X 行)+ message;user Y 再 `appendServerAuthoredMessageForRequest(reqA, sessY, Y, msg2)` 写入 map(Y 行,因主键 `(request_id, user_id)` 不冲突)+ Y 的 message。**关键回归:R4 修订前 map 主键单 request_id + ON CONFLICT DO NOTHING → Y 的 map 行被丢,后续 Y 的 `appendCostCredits` 反查不到落孤儿。** 修订后两行并存,Y 的 commit 能命中 Y 的 map → in-place patch Y 的消息。
- `T7` `appendServerAuthoredMessageForRequest 自身幂等`:同 reqId+sessId+msgId 第二次写入 → 返回 `applied:false, reason:'already_exists'`,messages 不重复 append。
- `T7a` `mergePreservingServerAuthored 保留 usage`:server-authored row 带 usage,client PUT 同 id 但 usage 缺失 → 合并后保留 server 的 usage。
- `T7b` `_seq 语义`:同 id 的 server-authored row 后续 `appendCostCredits` patch usage → `_seq` 重分配(usage 不在 `_SEQ_CONTENT_IGNORE_FIELDS`),client 增量 GET 能看到。
- `T7c` GC sweep:`pending_usage_patches` 注入 created_at 25h 前一行 → 跑 sweep helper → 该行被删 + metric 上报;1.5h 前一行 → 不删但 metric `pending_usage_patches_aging` 上报。`server_authored_request_map` written_at 8d 前一行 → 删除。

### 5.2 commercial 单元测试

- `T8` `anthropicProxy.commit 调用 appendCostCredits`(`packages/commercial/src/__tests__/anthropicProxy.test.ts`):mock storage,模拟 stream end → 验证 `deps.storage.appendCostCredits` 被以 `(requestId, uid.toString(), outcome.debitedCredits.toString())` 调用。
- `T8a` `userChatBridge.codex commit 调用 appendCostCredits`(`packages/commercial/src/__tests__/userChatBridgeCodexBilling.test.ts` 扩展):mock storage,Codex 模式结算 debit > 0 → 同样调用 `deps.storage.appendCostCredits`,签名一致。
- `T9` `appendCostCredits 失败兜底`:storage throw → broadcast 仍发出,proxy / userChatBridge 不抛错(失败由 metric 报告)。
- `T10` `internalServerAuthored 接受 usage payload`(扩展现有 `internalServerAuthored.test.ts`):body 带 usage → appendServerAuthored 收到的 msg 含 usage。
- `T11` `internalServerAuthored 拒绝畸形 usage`:负数 / 字符串 / 缺字段子集 → 400。
- `T12` `cost_charged broadcast 仍存在`:回归测试,既有 broadcast 路径不被本次改动破坏。

### 5.3 frontend 单元测试(`packages/web/__tests__/pureFunctions.test.ts`)

- `T13` `formatMeta(msg.usage)` 输出与历史 metaText 一致:input/output/cache/turn/credits 全字段 + 部分缺失场景各 1 例。
- `T14` `formatMeta` 兼容老 `_rawMeta`:msg 无 usage 但有 _rawMeta → 正确 fallback。
- `T15` `_deriveUserMsgStatus` 全分支:
  - 后续无 assistant → 返回 'sent'
  - 后续有 assistant 但 _source !== 'server' → 返回 'sent'(纯客户端流式)
  - 后续有 server-authored assistant → 'replied'
  - 显式 'queued' 不被派生覆盖
  - 多 user 消息序列(中间夹杂工具) → 只看本 user 之后到下一 user 之前
- `T16` `_normalizeLoadedSession` 条件化清洗(Codex R4 文案对齐):
  - `T16a` 输入含 metaText/_rawMeta + **无 usage** → 输出**保留** metaText/_rawMeta(老 row 兼容,formatMeta fallback 走 _rawMeta)。
  - `T16b` 输入含 metaText/_rawMeta + **有 usage** → 输出删除 metaText/_rawMeta(usage 已就位,新前端 formatMeta(msg.usage) 显示)。
  - `T16c` 输入含 ephemeral 字段(`_partial/_completed/output/error/bashTail/inputJson/inputPreview`)→ 无论是否有 usage,**永远 strip**(它们就不该持久化)。
  - `T16d` 输入 user 消息 status='replied' → strip 该字段(派生函数算)。
  - 共同断言:text/role/id/ts/usage(若有)永远保留。
- `T17` `_stripMessageEphemeral`(发出方 strip):含 _streamingAssistant pointer / _rawMeta → strip;其余完整。

### 5.4 frontend 集成测试(新增 `packages/web/__tests__/consistencyAfterRefresh.test.ts`)

用 jsdom + mock fetch + mock IDB 模拟完整链路:
- `T18` **bug 复现/回归**(Codex R1 调整):
  1. 模拟 user 发送 → mock WS 推 cost_charged → meta 行显示。
  2. 模拟 PUT 409 → server-wins → server.messages 包含 server-authored assistant `{usage:{costCredits:'8', inputTokens:13178,...}, _source:'server', status:'completed'}` —— **不**包含 user `status:'replied'`(派生算出) → 替换后 UI 仍显示完整 meta + "已回复"角标。
  3. 模拟刷新(state.sessions clear → dbGetAll → 重渲) → meta 行 + "已回复" 仍在。
- `T19` **历史 IDB 自愈条件化**:
  - 预填 row A:含 `metaText/_rawMeta` 但**无 usage** → load 后 metaText/_rawMeta **保留**,formatMeta 走 _rawMeta fallback 显示。
  - 预填 row B:含 `metaText/_rawMeta` **且有 usage** → load 后 metaText/_rawMeta **删除**,formatMeta(msg.usage) 显示。
  - 预填 row C:user 消息 `status:'replied'`(历史污染) → load 后 status 字段被 delete,派生函数算出"replied"(因为后续有 server-authored assistant)。
- `T20` **多 tab 一致性**:tab A send → tab B fresh load → 双方 usage / 派生 status 一致。
- `T21` **costCredits 早到 / 晚到 / 跨进程持久**:
  - 早到(cost_charged 在 isFinal 之前):client 内存 msg.usage.costCredits 立即更新;后续 GET 拿到 server 持久化 usage,值相同 → 无变化。
  - 晚到(cost_charged 在 isFinal 之后):isFinal 把 server-authored assistant 落入 messages(无 costCredits),broadcast 覆盖 msg.usage.costCredits;下次 GET 同步。
  - 跨进程模拟:`pending_usage_patches` 写后 mock storage 重启 → internalServerAuthored 后到 → drain 命中 → 持久化 usage 完整。(此用例放 storage 测试 T3 / T4 加重一档。)
- `T22` **strip 双层防御 + DOM 重建检测**:
  - client 故意构造 `messages[0].metaText='evil'` / `_source:'server'` / `usage:{costCredits:'9999'}` 直接 PUT → server 收到后 SELECT 应没有这些字段 + metric `client_put_blocked_field` 被打。
  - usage in-place patch 触发 `_seq` 递增 → client 增量 GET 拉到 same-id replace → DOM 仅更新 .msg-meta 元素,不触发 .msg 气泡的 innerHTML/重建(用 MutationObserver 断言)。
- `T23` **派生 status 全场景**(纯函数测试,见 T15;此处加 DOM 断言):
  - thinking-only turn(server 写 thinking,无 assistant) → user 角标显示 'sent' 不 'replied'。
  - interrupted server-authored assistant(`status:'interrupted'`) → 'sent' 不 'replied'。
  - completed server-authored assistant → 'replied'。
- `T24` **client 伪造 server-authoritative 字段被拒**(T22 的 storage 端断言扩展):
  - client PUT body 含 `messages[0]._source:'server'`、`_seq:9999`、`status:'replied'`、`_truncated:true`、`_errorCode:'oops'` → server upsertClientSession 持久化后 SELECT 应当全部 strip。
  - mergePreservingServerAuthored 已有 server row 含 `_source:'server'+usage` → client 同 id 来包没 usage → server row 胜出(usage 保留)。

### 5.5 回归测试(必跑)

- 既有 `sessionsDbMerge.test.ts`(mergePreservingServerAuthored 全分支)
- 既有 `outboundRing.test.ts`(33 个,含 4 个 pruneAll)
- 既有 `userChatBridgeCodexBilling.test.ts`(cost_charged 流程)
- 既有 `pureFunctions.test.ts`(_basename / formatSize / shortTime / sessionGroup / _cronHuman / formatMeta 老分支)
- 前端 DOM 完整性:`npm run test:web`

---

## 六、风险评估与回滚

| 风险 | 缓解 |
|------|------|
| `appendCostCredits` 与 `appendServerAuthoredMessageForRequest` 时序竞争 | **durable** 解法:`server_authored_request_map` + `pending_usage_patches` 双表协同 + 各自独立 better-sqlite3 transaction;两表均 `ON CONFLICT` 处理。跨进程、跨重启正确。Codex R1 反对的 in-memory TTL 已废弃,R2 提的"sink 早 + commit 后到的孤儿"靠 request_map 反查闭合。 |
| 老前端 deploy 滞后写 metaText | server strip 兜底,新 GET 返回不带 metaText;老前端 formatMeta 走 _rawMeta fallback,继续显示。 |
| 老 IDB 数据迁移 | dbGetAll **条件化清洗**(仅当 usage 就位时 strip metaText/_rawMeta),老 row 保留显示;无 SQL migration。 |
| `_seq` 语义改变(usage 现在算 content) | 新增 T7 / T22 用例;client 增量 GET cursor 旧 seq < 新分配 seq → same-id replacement(`_mergePartialTail` 支持) → 仅 token meta 行重渲,无气泡重建闪烁。 |
| `appendCostCredits` 反查 `server_authored_request_map` 未命中(sink POST 还没来) | 落 `pending_usage_patches`,后续 `appendServerAuthoredMessageForRequest` 同事务 drain;不依赖 turnIndex / msgId。 |
| `pending_usage_patches` 永久孤儿(sink POST 永远不来) | 后台 sweep:**1h 起触发 metric/alarm**(`pending_usage_patches_aging`),**24h 起硬删 + metric**(`pending_usage_patches_expired`)。`server_authored_request_map` 7d 后 GC。Codex R3:1h 直接删会误杀合法慢恢复(master/gateway 重启 + outbox replay),改为 24h 兜底 + 1h 告警。 |
| `_source` / `_seq` / `usage` 字段被恶意/误写从 client PUT 进来 | client PUT schema 只允许 client-authored 字段,server-authoritative 字段命中显式 deny-list + metric 上报。 |
| client 收到 cost_charged broadcast + 后续 GET 持久化 usage 双重累加 | client broadcast handler 改为**覆盖**而非累加;requestId-based dedupe 留给 L2 backlog 时显式处理。 |
| status='replied' 派生在 thinking-only / interrupted turn 的边界 | 派生函数收紧(只看 `_source:'server'` && `status:'completed'`);测试 T15 全分支。 |

**回滚策略**:**两步部署、两步回滚**,不是无副作用 revert。

部署顺序:
1. **Step 1** (storage + commercial + gateway 后端): server strip + appendCostCredits + pending_usage_patches + sink 带 usage 字段。验证 server 端 GET 返回的 messages.usage 正确,broadcast 仍然 OK,客户端代码未改但仍能通过 _rawMeta 显示。
2. **Step 2** (frontend): formatMeta(msg) 切换 + dbGetAll 条件清洗 + 'replied' 派生 + setMeta 退役。前端只在 server 已经持续供应 usage 后开关。

回滚顺序(逆向):
1. **Frontend revert**:回到老 setMeta/_rawMeta 路径;老 row 无 usage 仍能显示;新 row 有 usage 但客户端不读 → 不显示 meta 行,不 broken。
2. **Backend revert**(必要时):pending_usage_patches 表保留(空表无害),server strip 移除;appendCostCredits 删除;internalServerAuthored schema 移除 usage 字段。回到 cost_charged broadcast-only 状态。

**SQL DDL 是新增表,不删表也不改既有表**;DDL revert 不必要(留空表无影响)。

---

## 七、验收标准

### Dev
1. `bun test packages/storage` 通过(含 T1-T7)。
2. `bun test packages/commercial` 通过(含 T8-T12)。
3. `npm --prefix packages/web run test:web` + `npm --prefix packages/web run test` 通过(含 T13-T22)。
4. 部署到 dev → 真发一句话 → cost_charged 帧 → meta 行显示 → 强刷页面 → meta 行 + "已回复" 仍在。

### Prod 验收
1. boss 实机:发一句话 → token 行显示 → 刷新 → token 行 + "已回复" 仍在。
2. 移动端 background→foreground → 刷新 → 同上。
3. 多 tab:A 发,B 切过去刷新 → token 行 + "已回复" 一致。
4. Phase 0.4 移动端长 codex turn 重连不丢帧(独立验收项,与本 PR 不耦合)。

---

## 八、实施顺序

```
Day 1  storage 改动 1-3 + 单元测试 T1-T7    → bun test packages/storage
Day 1  commercial 改动 4-6 + 单元测试 T8-T12 → bun test packages/commercial
Day 2  gateway 改动 7
Day 2  frontend 改动 8-14 + 单元 T13-T17    → npm test:web
Day 3  frontend 集成测试 T18-T22
Day 3  Codex code review → PASS
Day 3  changelog v1.0.88 → v1.0.89, deploy
Day 4  boss prod 验收 → 关单
```

每完成一段提交一个 commit,Codex 走单段评审,降低单次 review 体积。

---

## 九、不在本 PR 范围(backlog 标注)

- L2 — `cost_charged` 进 outboundRing + 提供 user-facing GET endpoint 让客户端主动重放(本 PR 通过 mergeUsage 持久化已经覆盖了"刷新后丢失"场景,replay 是更激进的纯增量方案,留给后续)。
- L3 — message blob 拆字段桶 schema(`server_fields / client_persistent_fields / client_ephemeral_fields`),需 SQL DDL,大改,留给季度级重构。
- 移动端 background→foreground 同步路径独立审计(Phase 0.4 已部分覆盖,生产验收后再决定是否深挖)。
