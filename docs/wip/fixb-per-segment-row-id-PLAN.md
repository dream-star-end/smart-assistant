# Fix B — Per-Segment Row ID (turn 内 text↔tool 顺序根治)

## 1. 根因复述（一句话）

gateway 给一个 turn 内所有 text/thinking block stamp 同一个 canonical messageId
(`srv-${peerId}-${agentId}-t${turnIndex}`)，前端 merge 成单行 assistant，该行 ts =
text₁ 首 token 到达时间。tool_use 是独立行，ts = tool 到达时间晚于 text₁。
`sync.js:362` 按 ts 排序 → 当 agent emit 模式是 `text₁ → tool → text₂` 时
tool 卡片被排到 (text₁+text₂) 合并行下面。已在 `sync.js:354-361` 注释里挂作
"Fix B (separate PR)" 技术债。

Codex/GPT-5.5 这种习惯先 preamble 再 mcpToolCall 的 agent 是高频触发面。

## 2. 方案对比

| 方案 | 描述 | 评价 |
|------|------|------|
| A. ts 重写 | 检测 text-after-tool 时把 assistant 行 ts 改成 tool.ts+1 | 复活 v7.3 _enforceTurnGroupOrder 的并行机制；iOS Safari sync→reorder flicker 会回归；text₁ 先到的视觉次序被强行翻转，用户感知"消息跳了" |
| B. **per-segment row id** | 每个 text/thinking content block 独立 row id (`${assistantMessageId}-s${segmentIndex}`)，gateway 在跨 tool_use 边界递增 segmentIndex | 自然对齐 emit 顺序；ts-sort 工作正确；和现有 id-union merge 完全兼容；改动面跨 4 层但语义清晰；一次性消除整类问题 |
| C. 维持现状 | 把 sync.js 注释里的 trade-off 当 by-design | 用户已报告为 bug；agent emit 模式趋势是 preamble-first，问题会持续 |

**推荐 B。** 理由：
- A 是症状治理 + 复活已知坏机制；
- 这个 bug 本质是"协议把 N 段 text 强压成 1 段"，per-segment id 是协议层的对称修复；
- 未来 thinking 也可能出现 thinking₁→tool→thinking₂ 模式（DeepSeek r1 / Claude extended thinking），per-segment 一并覆盖。

## 3. Per-Segment Row ID 详细设计

### 3.1 ID 格式

```
text segment:     srv-${peerId}-${agentId}-t${turnIndex}-s${segmentIndex}
thinking segment: srv-${peerId}-${agentId}-t${turnIndex}-thinking-s${segmentIndex}
tool (不变):      srv-${peerId}-${agentId}-t${turnIndex}-tool-${blockId}
```

`segmentIndex` 从 0 开始，turn 内独立计数（text 和 thinking 各自一套
counter）。每当遇到 main-agent 的 `tool_use` block boundary，下一个 text/thinking
都用新的 segmentIndex。

**向下兼容**：旧 agent 单段 text 的 turn 一律 segmentIndex=0，id 仍 = `srv-...-t1-s0`
（新增 suffix）。**这是 breaking change** — 客户端必须能识别新 id。发版顺序
对齐 §3.5.2 的 master-first 硬约束：
1. master + 前端静态资源（packages/web 静态文件由 master 托管）一起先上 →
   此时前端已能识旧 `srv-...-tN` 和新 `srv-...-tN-s0`；
2. gateway 后上 → 开始 stamp 新 id。

期间禁止 master 回滚而 gateway 留新（详 §3.5.2）。

历史已持久化的 turn：id 是旧的 `srv-...-t1`（无 -s0 suffix），merge 时**保持不变**。
只有新 turn 走新 id 体系。

### 3.2 协议层 (`packages/protocol/src/frames.ts`)

`OutboundContentBlock` 的 `kind: 'text'` 和 `kind: 'thinking'`：
- `messageId` 字段含义不变（仍是该 segment 的 row id）
- 不新增 `segmentIndex` 字段（信息已编码在 messageId 里，前端不需要解码）

### 3.3 Gateway parser (`ccbMessageParser.ts`)

#### 3.3.1 Segment 数据模型（Codex 反馈 BLOCKER 1 — 之前 plan 漏写）

parser 现在只维护 `assistantBuf` / `thinkingBuf` 总串，**TurnResult 必须额外暴露 segments 数组**，否则 live 能分段但刷新后退回单 row，Fix B 不闭环。

新增字段：
```ts
type SegmentRecord = {
  index: number    // 0-based, turn 内累计
  text: string     // 该段累积文本
  ts: number       // 该段首 token 到达的 Date.now()
}

// in CcbMessageParser
private assistantSegments: SegmentRecord[] = []
private thinkingSegments: SegmentRecord[] = []
private currentTextSegmentIndex = 0
private currentThinkingSegmentIndex = 0
/** tool boundary 后等下一段 text/thinking 来时才 ++ counter；
 *  避免"tool 后 turn 直接结束没有 text₂"留下空段，
 *  也避免连续多个 tool_use 重复 ++。两个 stamping 触发点
 *  (`_handleStreamEvent content_block_start` + `_handleAssistant`
 *  finalized snapshot) 共用同一 flag，幂等置位安全。 */
private pendingTextSegmentBumpOnNextText = false
private pendingThinkingSegmentBumpOnNextThinking = false
```

text_delta 路径（伪代码）：
```ts
if (delta.type === 'text_delta' && delta.text) {
  if (!parentToolUseId) {
    if (this.pendingTextSegmentBumpOnNextText) {
      this.currentTextSegmentIndex++
      this.pendingTextSegmentBumpOnNextText = false
    }
    this.assistantBuf += textStr        // 仅本地累积用于 onFinish 调试/observability；
                                         // v3MasterSink 不再 surface 总串到 wire（见 §3.5.2）
    let cur = this.assistantSegments[this.assistantSegments.length - 1]
    if (!cur || cur.index !== this.currentTextSegmentIndex) {
      cur = { index: this.currentTextSegmentIndex, text: '', ts: Date.now() }
      this.assistantSegments.push(cur)
    }
    cur.text += textStr
  }
  this.onEvent({
    kind: 'block',
    block: stampMainAgentId(
      withParent({ kind: 'text', text: textStr }),
      this.assistantMessageId
        ? `${this.assistantMessageId}-s${this.currentTextSegmentIndex}`
        : undefined,
    ),
  })
}
```

tool boundary 置位（在 `_handleStreamEvent` 的 `content_block_start.tool_use`
分支末尾 + `_handleAssistant` 的 finalized `tool_use` 分支末尾各加一行）：
```ts
if (!parentToolUseId) {
  // 只有"当前类型已经至少有过一段"才置 pending。否则
  //   pattern = tool → text₁ 时第一段会被错误 ++ 成 s1。
  // 也保证多个连续 tool 不会让 counter 跳过空段：
  //   tool₁ → tool₂ → text 仍然 (s0 已存在 → bump → s1) 而不是 s2。
  if (this.assistantSegments.length > 0) {
    this.pendingTextSegmentBumpOnNextText = true
  }
  if (this.thinkingSegments.length > 0) {
    this.pendingThinkingSegmentBumpOnNextThinking = true
  }
}
```

thinking_delta 路径同构。

**Corner case：tool-first turn**（Codex 反馈 MAJOR）：
- pattern = tool → text₁ → text₂：assistantSegments=[] 时 tool boundary 不置 pending →
  text₁ 来时 currentTextSegmentIndex 仍是 0 → 首段 id `srv-...-tN-s0`（不是 s1）。
- pattern = tool only：assistantSegments=[] 始终为空，无 assistant row 写入。

#### 3.3.2 TurnResult / onFinish 暴露

`TurnResult` 类型加：
```ts
assistantSegments: SegmentRecord[]
thinkingSegments: SegmentRecord[]
```

`onFinish(turnResult)` 调用前，parser 把 `this.assistantSegments` /
`this.thinkingSegments` 浅拷贝灌进去。下游 `sessionManager` → `v3MasterSink`
→ master HTTP body 这一路传递。

#### 3.3.3 边界 / corner case 行为表

| emit pattern | currentTextSegmentIndex 轨迹 | 持久化 assistant rows |
|--------------|------------------------------|------------------------|
| text 单段 | 0 | 1 行 id `srv-...-tN-s0` |
| text₁ → tool → text₂ | 0 → bump → 1 | 2 行 (-s0 / -s1) |
| text₁ → tool₁ → tool₂ → text₂ | 0 → bump → 1 (第二 tool 看 segments[-1]=s1 还未存在 → 不置；s1 写入后再有 tool 才会 bump 到 s2) | 2 行 |
| tool → text₁ → text₂（tool 先发）| segments=[] 不置 pending → text₁=s0 → text₂ 继续累 s0 | 1 行 (-s0) |
| text → tool → (turn 结束) | 0 → bump（无后续 text 不消费） | 1 行 (-s0)；assistantSegments=[s0] |
| tool only（无 text） | 0（未被 stamp 过） | 0 assistant 行；assistantSegments=[] |
| thinking₁ → tool → thinking₂ | thinking counter 独立 0→1 | 2 thinking 行 (-thinking-s0/-s1) |

ID 命名空间确认（Codex MINOR 反馈）：`-tool-${blockId}` 永远夹 `-tool-` 前缀，
`-thinking-s${idx}` 永远夹 `-thinking-` 前缀，与 `-s${idx}` 无歧义。

### 3.4 Codex runner (`codexAppServerRunner.ts`)

**需要小改一处**（与 §4 文件清单对齐）：在 tool item 出现的时刻
(`emitAssistantToolUse` / `handleItemStarted` for commandExecution/fileChange/mcpToolCall) 给
sessionManager 记录 `arrivedAt = Date.now()`。详见 §3.5.1 BLOCKER 3 说明
（tool ts 必须是 tool **卡片出现时间**，不是 tool_result 完成时间，否则并发
tool 完成顺序乱时刷新结果与 live 不一致）。

segment 边界本身**不需要 runner 直接改** — Codex 通过 parser 的
`_handleAssistant` 路径看到 tool_use → 在 parser 内部触发 pendingTextBump。
runner 唯一新增的职责是 stamp arrivedAt。

具体接入点：
- Anthropic SDK 路径：parser 的 `_handleStreamEvent` `content_block_start.tool_use`
  分支已有 block，加 `arrivedAt: Date.now()` 一起记到 `completedTools` 的 stub 上；
- Codex runner 路径：`emitAssistantToolUse` 调用前 stamp，记到 `currentTurnTools[blockId].arrivedAt`，
  后续 `emitToolResult` 只填 output / status / duration，**不覆盖 arrivedAt**。

### 3.5 Master sink (`v3MasterSink.ts` + `internalServerAuthored.ts`)

#### 3.5.1 Wire schema 改动

`ServerAuthoredBody` 当前：
```ts
text: string            // 全 turn 的 assistant 文本
thinkingText?: string   // 全 turn 的 thinking
tools?: ToolEntry[]
```

改为：
```ts
// 新字段
assistantSegments?: Array<{
  segmentIndex: number       // 0,1,2,...
  text: string
  segmentTs: number          // 该 segment 首 token 到达的时间（gateway 提供）
}>
thinkingSegments?: Array<{
  segmentIndex: number
  text: string
  segmentTs: number
}>
// 旧字段保留兼容期
text?: string          // 改为 optional
thinkingText?: string  // 同上
```

`tools[]` 里每个 entry 加：
```ts
arrivedAt?: number     // tool 卡片出现时间(gateway 在 tool_use start/finalized
                       // 时 stamp Date.now())。OPTIONAL — 旧 gateway 不发。
```

**为什么是卡片出现时间不是完成时间（Codex 反馈 BLOCKER 3）**：tool 完成顺序
和发起顺序可能不一致（并行 tool 背靠背启动但完成顺序反了），用完成时间
排序会让刷新后的 tool 卡片顺序与 live 不一致。`tool_use` start 时间锁
住"该 tool 卡片在 turn 里的位置"，后续 tool_result 只补 output/status/duration，
**不能改 arrivedAt**。

**arrivedAt 优先级链（兼容期）**：master sink 落 tool ts 时按 ↓ 顺序取：
```
ts = arrivedAt ?? clientTs ?? (baseTs - toolsCount + i)
```
- `arrivedAt`：新 gateway 提供（首选）；
- `clientTs`：当前 tools[] 已有 `ts` 字段时退而求其次（不期望，但 strict schema 不拒）；
- `baseTs - toolsCount + i`：旧 gateway 无任何 tool ts 时的兜底（与现行行为完全一致）。

`refine` 改成：`text || thinkingText || assistantSegments || thinkingSegments
|| (tools && tools.length>0)` 至少一个非空。

#### 3.5.2 部署顺序约束（Codex 反馈 BLOCKER 2 — 收敛双轨叙事）

**严格 master-first，不支持回滚组合**：

| 组合 | 行为 |
|------|------|
| 旧 gateway × 旧 master | 走 `text` 字段，单 row（现状） |
| 旧 gateway × **新** master | 走 `text` 字段（兼容字段保留），单 row 写入 id `srv-...-tN`（无 -s 后缀）✅ |
| **新** gateway × **新** master | 走 `assistantSegments[]`，多 row 写入 id `srv-...-tN-s0/-s1/...` ✅ |
| **新** gateway × 旧 master | ❌ 400 fatal drop（旧 master strict schema 拒 unknown keys）— **靠 deploy 顺序避免** |

发版顺序硬性约束（写进 v3-commercial-deploy SOP 的 release notes）：
1. master（commercial pkg + storage schema）先升 → 验证旧 gateway 仍能写入；
2. gateway（packages/gateway）后升 → 验证新字段路径；
3. 升级期间禁止单独回滚 master（gateway 已发新字段，master 回滚 = drop）。

新 gateway **不再发送** `text` / `thinkingText` 字段（避免双写浪费 wire），只
发 `assistantSegments[]`。旧字段彻底从新 gateway 移除（在 ccbMessageParser
TurnResult 暴露的同时不再 surface 总串）。

兼容字段 `text` 在 master 保留至旧 gateway 全部下线 + 14 天 grace，之后删除
fallback。

#### 3.5.3 持久化写入

```ts
const lastAsstIdx = body.assistantSegments
  ? body.assistantSegments[body.assistantSegments.length - 1].segmentIndex
  : -1
for (const seg of body.assistantSegments ?? []) {
  const isLast = seg.segmentIndex === lastAsstIdx
  const msg: ServerAuthoredMessageInput = {
    id: `${baseAssistantId}-s${seg.segmentIndex}`,
    role: 'assistant',
    text: seg.text,
    ts: seg.segmentTs,
    status: body.status,
    // usage / _truncated / _errorCode / _errorDetail 只贴最后一段
    ...(isLast && body.usage ? { usage: body.usage } : {}),
    ...(isLast && body.truncated ? { _truncated: true } : {}),
    ...(isLast && body.errorCode ? { _errorCode: body.errorCode } : {}),
    ...(isLast && body.errorDetail ? { _errorDetail: body.errorDetail } : {}),
  }
  if (isLast && body.requestId !== undefined) {
    await storage.appendServerAuthoredMessageForRequest(
      body.requestId, sessionId, userId, msg)
  } else {
    await storage.appendServerAuthoredMessage(sessionId, userId, msg)
  }
}
```

**为什么 request map 只贴最后一段（Codex 反馈 MAJOR）**：deferred
`appendCostCredits(requestId)` patch 的是 usage.costCredits，而 usage 只在最后
一段。如果把 request map 也贴前面 N-1 段，late patch 会找不到 usage 字段或被
覆盖。前面 N-1 段一律走 plain `appendServerAuthoredMessage`，无 cost-patch 钩子。

**tools 持久化用每个 tool 自己的 arrivedAt（Codex 反馈 BLOCKER 2+3）**：

```ts
const baseTs = body.ts ?? Date.now()
for (let i = 0; i < tools.length; i++) {
  const t = tools[i]
  const toolTs = t.arrivedAt ?? t.ts ?? (baseTs - tools.length + i)
  await storage.appendServerAuthoredMessage(sessionId, userId, {
    id: `${baseAssistantId}-tool-${t.blockId}`,
    role: 'tool',
    text: t.output,
    ts: toolTs,
    ...
  })
}
```

`text₁→tool₁→text₂→tool₂→text₃` 的多边界场景下，新 gateway 提供
`arrivedAt`，每个 tool ts 落在自己真实区间，sort 出来自然交错。

旧 gateway 兼容期：`arrivedAt` 缺失 → 退化到 `baseTs - i` 公式，配合旧
`text` 单 row 路径，行为与现状完全一致（单 assistant row + 多 tool 集中
在 baseTs 前后）。

#### 3.5.4 v3MasterSink body cap 适配（Codex 反馈 MAJOR）

现行 cap 顺序（v3MasterSink.ts:334-388）：
1. 总 body > 256KB → drop tools[]
2. 再超 → drop thinkingText
3. 再超 → fatal throw

迁移到 segments[] 后维持**同一优先级语义**：
1. drop `tools[]` 不变；
2. **drop thinkingSegments[]**（替代 thinkingText 位置；assistant 优先级最高）；
3. assistantSegments[] 仍超 256KB → fatal（与现状一致，是 CCB bug）。

具体调整：
```ts
// 把 hasThinking 判断从 thinkingText 改成 thinkingSegments
const hasThinking =
  (bodyObj.thinkingSegments !== undefined && bodyObj.thinkingSegments.length > 0)
  || bodyObj.thinkingText !== undefined   // 兼容期保留
const hasAssistant =
  (bodyObj.assistantSegments !== undefined && bodyObj.assistantSegments.length > 0)
  || ((bodyObj.text as string | undefined)?.length ?? 0) > 0

// drop 时两种 key 都清，避免漏掉兼容字段
delete bodyObj.thinkingSegments
delete bodyObj.thinkingText
```

assistant 部分**不允许部分 drop**（不能丢中间某段，会让 turn 失去连续性）；
全保留或全 fatal。

`MAX_THINKING_BUFFER_BYTES = 8 KB` 的 parser 侧 cap 仍生效，所以 thinking
seg 单段不会超；segments[] 总长理论 < N×8KB，但实际并发 thinking-tool
模式少，触发 drop 的概率与现行 thinkingText 路径相当。

#### 3.5.5 thinkingSegments 同等处理

`thinkingSegments[]` 走与 assistantSegments 相同的 multi-row 写入，id 形如
`${baseAssistantId}-thinking-s${idx}`。fallback 字段 `thinkingText` 仍按现行
单 row 写入（id `srv-...-tN-thinking`）。

### 3.6 Frontend websocket (`websocket.js`)

`_findOrCreateStreamingRow` 已经按 `messageId` 找/建 row，**协议变后自动支持** —
text₁ 用 `srv-...-t1-s0` id 建第一段；text₂ 用 `srv-...-t1-s1` id 建第二段（不同 id
所以不会复用第一段）。tool_use 边界后 `_streamingAssistant = null` 已存在
(`websocket.js:2280`)。

唯一需要改的：`_streamingAssistant` 字段一直只跟踪"当前活跃段"，这本来就是 segment
语义。无需结构改动。

确认点：
- usage / cost_charged frame 收到时只贴到 `_lastFinaledAssistantId`（最后一段）— 已是现状；
- truncated 标记 — 同上。

### 3.7 Frontend sync (`sync.js`)

`_mergeServerAuthoredIntoLocal` 按 id-union 工作，**协议变后天然支持** — 每个
segment 是独立 id，client streaming row 与 server-authored row 通过同一 id 对齐。
ts-sort 出来自然交错。

`_dropLegacyClientStreamRows` **需要修**（Codex 反馈 MAJOR）：当前用
`id.endsWith('-thinking')` 判断 server thinking row，新格式 `-thinking-s0/-s1`
不命中，导致 legacy `m-*` thinking 迁移 backstop 失效。

改判断逻辑：
```js
// 之前
const isServerThinking = id.endsWith('-thinking')
// 之后
const isServerThinking = /^srv-.*-thinking(-s\d+)?$/.test(id)
```

或者更稳：在 backstop 谓词里直接用 `serverMsg.role === 'thinking' &&
typeof serverMsg.id === 'string' && serverMsg.id.startsWith('srv-')`，绕开
id 后缀匹配。倾向后者（语义更清）。

### 3.8 旧数据 / 跨版本会话

已存在的 turn 持久化的是 `srv-...-t${N}` 单 row，新版前端 merge 时：
- server-only row id = `srv-...-t1`，本地无 streaming row 对应 → 进 server-only 分支 append；
- 显示为单 assistant 行，与旧行为完全一致。

新 turn 跑在升级后 gateway → 多段 row 自然分开。

无数据迁移需求，无破坏。

## 4. 影响文件清单

| 文件 | 改动 |
|------|------|
| `packages/protocol/src/frames.ts` | 文档/注释更新 messageId 字段语义 |
| `packages/gateway/src/ccbMessageParser.ts` | segmentIndex counter + pendingBump 边界 + segments 累积 + TurnResult 暴露 |
| `packages/gateway/src/codexAppServerRunner.ts` | 在 `emitAssistantToolUse` 前 stamp `arrivedAt = Date.now()` 到 currentTurnTools[blockId]；`emitToolResult` 不覆盖 arrivedAt |
| `packages/gateway/src/v3MasterSink.ts` body cap | drop 顺序适配 segments[]（详 §3.5.4）|
| `packages/gateway/src/sessionManager.ts` | TurnResult → sink 传递 segments + 每 tool arrivedAt |
| `packages/gateway/src/v3MasterSink.ts` | 收集 segments + arrivedAt；wire 新增 assistantSegments[] + thinkingSegments[]，去掉 text 总串 |
| `packages/commercial/src/http/internalServerAuthored.ts` | BodySchema 加 assistantSegments[]/thinkingSegments[] + ToolEntry.arrivedAt；handler 双轨写入（新优先、旧 fallback）；refine 谓词更新 |
| `packages/web/public/modules/websocket.js` | 无结构改动（确认 streamingAssistant 语义） |
| `packages/web/public/modules/sync.js` | `_dropLegacyClientStreamRows` thinking 判断改 role+前缀 |
| 测试 | 见 §5 |

## 5. 测试计划（按 CLAUDE.md "Phase 0 lock baseline" 规则）

### 5.1 Baseline lock (改代码前)

**新建** `packages/gateway/src/__tests__/ccbMessageParser-textToolText.test.ts`：
- 喂 SDK 序列：text("hello") → tool_use(skill_list) → tool_result → text("here is the answer")
- 当前期望（baseline）：parser 发出 3 个 block (text, tool_use, text)，**两个 text 都 stamp 同一 messageId**
- 标 `@baseline-v7.4` 注释，明确这是"将被本 PR 改写"的契约

**新建** `packages/web/__tests__/syncTextToolTextOrder.test.ts`：
- 构造 session messages = [user, assistant(srv-tN, text=text₁+text₂, ts=T1), tool(srv-tN-tool-X, ts=T2)]
- 当前期望（baseline）：merge 后 assistant 在 tool 上面（ts-sort），这是 bug 但确实是现行行为
- 同样标 `@baseline-v7.4`

### 5.2 New-behavior tests

ccbMessageParser test：
- 喂序列 text("a") → tool_use → text("b") → 期望 parser 发出 3 个 block，
  两个 text messageId = `srv-test-agent-t1-s0` 和 `srv-test-agent-t1-s1`，
  parser.assistantSegments = [{idx:0,text:"a",ts:T1},{idx:1,text:"b",ts:T3}]
- 喂序列 text → tool₁ → tool₂ → text → 期望 segments 只有 2 段（bump 幂等），
  第二段 idx=1 不是 2
- 喂序列 text → tool → (turn end no text) → 期望 segments 只有 1 段 idx=0，
  pendingBump 已置位但未消费不应留下空段
- 喂序列 tool → text("a") → text("b") → 期望 segments=[{idx:0,text:"ab"}]
  （tool-first 不应让首段变 s1）
- 喂序列 tool₁ → tool₂ → text → 期望 segments=[{idx:0,text:...}]
  （连续 tool 在 segments=[] 时都不置 pending，首段仍 s0）

frontend sync test：
- 构造 session messages = [user, asstSeg0(srv-tN-s0, ts=T1), tool(srv-tN-tool-X, ts=T2), asstSeg1(srv-tN-s1, ts=T3)]
- merge 后顺序 = [user, asstSeg0, tool, asstSeg1]（ts-sort 自然成立）

frontend websocket test：
- 模拟 streaming frame 序列：text("a", messageId=s0) → tool_use → text("b", messageId=s1)
- 期望 sess.messages 长度 = 3，第一段和第二段是不同 row

internalServerAuthored test：
- 多段 multi-tool 持久化端到端用例（Codex 反馈 MAJOR）：
  提交 body 带 assistantSegments=[{0,"a",T1},{1,"b",T3},{2,"c",T5}]，
  tools=[{blockId:"x",arrivedAt:T2,...},{blockId:"y",arrivedAt:T4,...}]
- 期望写入 5 条 row：
  - assistant -s0 ts=T1
  - tool -tool-x ts=T2
  - assistant -s1 ts=T3
  - tool -tool-y ts=T4
  - assistant -s2 ts=T5
- 期望 usage 只贴在 -s2 这条
- 期望 request map 只在 -s2 走 `appendServerAuthoredMessageForRequest`，
  -s0/-s1 走 plain append

baseline-fallback test：
- 提交 body 只带 `text="a"` (无 assistantSegments)
- 期望写入 1 条 assistant row id = `srv-...-t1`（旧行为不破）
- tools 缺 arrivedAt 时退化 `baseTs - i` 公式

sync.js `_dropLegacyClientStreamRows` test：
- 构造 merged 含 server thinking row id = `srv-x-thinking-s0`，并夹一条 legacy
  m-* thinking row
- 期望 legacy m-* row 仍被 drop（新判断逻辑 role+srv- 前缀生效）

### 5.3 Regression sweep

- 跑 `bun test` 全套，目标 0 红
- 重点 watch：v3MasterSink / sessionManager / sync.js merge 现有用例

### 5.4 端到端 dev 验证

按 v3 商业版 deploy 流程：
1. worktree build → 推 dev VPS;
2. 用真 Codex agent 触发 mcpToolCall 模式（询问需要查 skill 的问题）;
3. 验证 UI 顺序：text₁ → tool 卡片 → text₂；
4. 刷新页面验证持久化后顺序保持；
5. 切回 Claude 走纯 tool-first 流，验证无回归。

## 6. 风险与回滚

### 风险

- **协议非对称期**：唯一支持的非对称组合是"旧 gateway × 新 master"
  （新 master 走 `text` fallback 单 row 路径，与现状一致）。**禁止**
  "新 gateway × 旧 master" — 旧 master strict schema 拒 unknown keys 直接
  400 drop。靠 §3.5.2 master-first deploy 顺序硬约束规避，**这是部署
  SOP 的一部分不是运行时风险**；
- **历史 turn 显示**：旧 single-row turn 与新 multi-segment turn 在同一会话共存 OK，按 id 各自 merge；
- **客户端缓存**：service worker bumpVersion；测试时强刷；
- **iOS Safari**：v7.4 之所以 drop _enforceTurnGroupOrder 是 iOS 在 visibilitychange
  触发 sync 时 reorder 引发 flicker。本方案**没有 reorder** —— id-union 后 ts-sort
  得到的顺序在 live stream / sync / refresh 三个场景下完全一致（因为每段 ts 都被
  client 在 streaming 时 stamp 并由 v7.2 在 merge 时 preserve）；
- **body cap 失配**：v3MasterSink 现行 256KB body cap 是按 `text` 单串总长
  截断。改成 segments[] 后总长 = `sum(seg.text)` 仍可能超 256KB，需新增
  cap 策略（详见 §3.5.4）。

### Rollback

- 全文件可 revert，无数据迁移；
- 历史 turn 不受影响（旧 `srv-...-tN` id 仍然 server-only append + ts-sort 正常）；
- 部署顺序：master 必须先升，gateway 后升。回滚必须**反向**：gateway 先回，
  master 再回。任何"master 回但 gateway 不回"的组合都会让 400 drop 出现 →
  写进 deploy SOP；
- frontend 客户端缓存：service worker bump version 触发强刷；
- ~~"frontend fallback：找不到 `-s0` 时同时认 legacy id"~~（已删，Codex MINOR
  反馈：会模糊新旧 row 边界，且部署顺序约束已能解决回滚组合，不必要的防御层）。

## 7. 工作量估计 & 验收

- 代码：约 6 个 prod 文件 + 4 个测试文件，~600-900 行净增
- ETA：1-2 个完整 dev session（含 Codex 双审 + dev 验证 + deploy）
- 验收硬指标：
  1. baseline 测试改成新期望全绿
  2. text-tool-text 端到端 dev 验证顺序正确
  3. 单 text 单 tool 回归测试全绿
  4. Codex review PASS

## 8. 显式 Out of Scope

- 不动 thinking 内 tool 嵌套的 UI 折叠规则；
- 不动 agent group / subagent childBlocks 路径；
- 不改 tool_result merge 逻辑；
- 不引入新的 sort 规则 / anchor map / kind-based ordering（继续 v7.4 ts-only-sort 路线）；
- 不重写 `_localMessageSupersedes` / `_overlayServerAuthoritative`（继续按 row id 工作）。
