# OpenClaude v5 服务端提示词队列与中途插话 RFC

> 状态：设计提案，待评审；本文是施工图，不包含实现代码。  
> 适用范围：Aurora v5 商业版，Codex 与 CCB 双引擎。  
> 日期：2026-07-16；基线：`feat/v5-queue-rfc` @ `2abfe82a488adb66e47a825aebac5c57aea39163`。

## 0. 结论先行

本 RFC 采用一个持久化队列、三个交付档位：

1. **唯一队列权威是平台层的 `SessionManager + PG`**。`SessionManager` 负责状态机和调度，commercial master 只提供经容器身份认证的 PG repository、执行前模型权威/计费准备和多标签页转发；任何引擎内队列都不是业务真值。
2. 所有普通用户输入先持久化为队列项。空闲时由同一调度器立即 claim 并启动；运行中按 Enter 默认留在可见、可编辑、可删除、可重排的队列里。不存在“空闲直发、忙时走另一套队列”的双轨。
3. “插入当前任务”始终显示，交付能力只有：
   - `steerDelivery: 'native'`：Codex `turn/steer`；
   - `steerDelivery: 'fork-native'`：CCB fork 的 `openclaude_steer` stdin 控制帧；
   - `steerDelivery: 'turn-boundary'`：当前 turn 结束时自动转队首。
4. Codex G7 的 `CODEX_TURN_BUSY` 拒帧退役；`SessionManager` 的 promise 链不再承载不可见业务队列；`CodexAppServerRunner.queue` 删除，或在过渡期最多保留为长度 1 的执行交接断言。三层不会并存三份待执行消息。
5. 中途插话属于原逻辑 turn：沿用原 `turnKey`、`traceId`、计费 journal、idle-timeout、评分和 goal budget，不拆一张虚假的“插话账单”。撞上 turn 结束时，原队列项原子回到队首，保证不丢。
6. 新队列路径的 idle-timeout 退款必须从“会话 + 时间窗”升级为按 `turnKey` 精确冲正，否则 5 秒延迟退款会误伤刚自动启动的下一轮。

## 1. 背景、目标与边界

### 1.1 已核实的现状

- CCB：`SessionManager.submit()` 把每次调用挂到 `session.lock` promise 链，并在 `await prev` 前把 `_activeTurnCount` 加一；后到消息已被接受，但用户看不到也不能编辑（`packages/gateway/src/sessionManager.ts:2137-2154`）。释放发生在 finally，且会清 `_currentTurnKey`（`packages/gateway/src/sessionManager.ts:2450-2485`）。
- Codex 商业版：G7 在已有账户槽、API relay turn 或 acquire 在飞时直接发 `CODEX_TURN_BUSY` 并 return（`packages/commercial/src/ws/userChatBridge.ts:2968-2981`）。前端仍把它翻译为“上一轮任务仍在运行，请等它结束后再发送”（`packages/web-react/src/lib/chat/pure.ts:570-586,611-614`）。
- Codex runner 自己还有一个进程内 `queue`（`packages/gateway/src/engine/codexAppServerRunner.ts:786-802`），`submit()` push、`drain()` FIFO 消费（`packages/gateway/src/engine/codexAppServerRunner.ts:1189-1204,1306-1318`）；进程退出即丢，不能成为产品队列。
- 平台逻辑 turn 已有可复用的稳定键：模型启动前先持久预留 turn index，再派生 `turnKey` 并写到 session（`packages/gateway/src/sessionManager.ts:2517-2563`）。该键同时进入 lossless turn tape 与计费归因（`packages/gateway/src/sessionManager.ts:646-734`）。
- Web 模型已经声明用户消息状态 `queued`，但当前没有服务端队列快照驱动它（`packages/web-react/src/lib/chat/model.ts:15-17`）。

现状的核心问题不是“少一个数组”，而是同一用户动作在两个引擎上分别变成“静默排下轮”和“拒绝后重发”，并且又叠着 runner 内存队列。必须先统一权威，再接原生 steer。

### 1.2 目标

- 双引擎同入口、同队列 UI、同重连和多标签页语义。
- 用户可观察并管理所有尚未执行的输入。
- master、容器或浏览器重连不丢队列；重复请求不重复创建或插话。
- 原生 steer 只缩短交付时间，不改变持久化、顺序、计费、权限或失败语义。
- 沿用现有 frame/ring/hello、media ref、lossless tape、计费 finalizer，不造平行系统。

### 1.3 非目标

- 本 RFC 不实现 CCB fork 控制帧，只规定契约和改动面。
- 不承诺把已经进入模型上下文的插话撤回；编辑/删除只对尚未交付的项有效。
- 不把队列变成跨会话任务调度器；队列作用域是一个已认证用户的一个 `sessionKey`。
- 不改变专用图片编辑 relay 的结算语义。此类 item 可排队，但不支持中途注入时走同一个 `turn-boundary` 档位。
- 不拆分一轮内每条插话的 token 成本；现有双引擎都没有可靠的分段 token 归因依据。

## 2. 架构裁决与方案权衡

### 2.1 推荐架构

```text
浏览器（一个或多个 tab）
  │  queue mutation frames / full snapshot
  ▼
commercial userChatBridge（认证、透传、执行前 grant；不是队列）
  │
  ▼
Gateway SessionManager / PromptQueueCoordinator（唯一状态机）
  │                       │
  │ authenticated store  ├─ native       → Codex turn/steer
  │ API                   ├─ fork-native  → CCB openclaude_steer
  ▼                       └─ turn-boundary→ 下轮 claim
commercial PgPromptQueueStore → shared PG
```

容器不获得 PG 凭据。`PromptQueueCoordinator` 通过与现有 master sink/turn-waive 同等级的容器身份认证内部 API 调用 `PgPromptQueueStore`；owner 从已验证容器身份取，不接受 wire 上的 `userId`。现有 turn-waive 已采用 bearer + bound IP 的身份边界并从身份推导用户（`packages/commercial/src/http/internalTurnWaive.ts:9-19,46-50`），队列 repository 沿用该惯例。

commercial 还负责“真正出队时”的执行准备：重跑模型 catalog/epoch fence、Codex account slot、`preCheck` 和 billing journal，返回带 claim token 的执行 grant。**入队时不占账户槽、不预扣、不创建长寿命 journal**。当前桥的 acquire、journal、snapshot 都发生在 inbound turn 前（`packages/commercial/src/ws/userChatBridge.ts:2882-2891,3070-3124,3341-3369`）；实现时把这段封装成可由 coordinator 请求的单一 `prepareQueuedTurn()`，而不是复制逻辑。

若没有任何认证 browser bridge 连接，已在飞 turn 可以照常收尾，但不启动下一队列项；PG 队列等待重连。这样不会为了“离线自动跑”绕过模型权威和商业计费。未来若要离线自运行，应另行设计 durable service identity，不在本 RFC 偷渡。

### 2.2 队列权威：SessionManager vs commercial 层

| 选择 | 优点 | 致命问题 | 裁决 |
|---|---|---|---|
| commercial `userChatBridge` 做队列权威 | 直接拿 PG、账户槽和计费依赖 | bridge 生命周期绑定某个 WS；看不到 CCB/Codex runner 的真实 active turn 与 tool boundary；多标签页会有多个 bridge 状态机；个人/容器执行语义再次分叉 | 拒绝 |
| `SessionManager` 做协调器、PG 做持久真值，commercial 只实现 repository/grant | engine-neutral；已经持有 `turnKey`、interrupt、runner 和 lossless persistence；master/容器重启都能从 PG 重建 | 需要一个认证内部 store/grant API；调度跨进程，多一个明确的 claim 协议 | **推荐** |

这里的“SessionManager + PG”不是两份权威：PG 是 durable state，SessionManager 是唯一写状态机；commercial repository 只执行带 owner、CAS 和 claim 的事务，不自行决定顺序或交付档位。

### 2.3 全量快照 vs 增量 patch

| 选择 | 优点 | 风险 | 裁决 |
|---|---|---|---|
| 增量 patch | 单帧更小 | 断线、ring eviction、重复/乱序、双 tab 会要求客户端复刻服务端 reducer；删除/重排漏一帧就永久分叉 | 拒绝作为 v1 协议 |
| 每次成功事务广播完整 `PromptQueueSnapshot` | 客户端只做 version 比较和替换；重连、master restart、stale edit 都可用同一收敛路径 | 要限制投影大小；不能把 300MB 正文塞进快照 | **推荐** |

快照只含可展示投影和 attachment refs，不含大正文/二进制。编辑器打开时通过同一 PG authority 的只读 detail API 拉完整 item；写回仍用 edit frame + `expectedVersion`。这不是第二套队列协议，只是大字段读取通道。

## 3. 数据模型

### 3.1 PG 表

建议下一可用迁移命名为 `NNNN_prompt_queue.sql`；实现开工时按 canonical 最新编号分配，不在 RFC 固化可能冲突的数字。迁移必须向后兼容。

#### `prompt_queue_heads`

每个 `(owner_user_id, session_key)` 一行，既是事务锁，也是 snapshot version/active turn 真值。

| 列 | 类型 | 约束/语义 |
|---|---|---|
| `owner_user_id` | `BIGINT` | FK `users(id)`；只从认证身份写入 |
| `session_key` | `TEXT` | 与 gateway `agent:<aid>:webchat:dm:<peer>` 同空间 |
| `client_session_id` | `TEXT` | 前端会话/peer id，便于 history 与队列对账 |
| `agent_id` | `TEXT` | 当前队列执行 agent；与 session key 交叉校验 |
| `version` | `BIGINT` | 从 0 开始、只增不减；wire 用十进制字符串，避免 JS 53-bit 溢出 |
| `active_turn_id` | `TEXT NULL` | **平台 `turnKey`**（64 位小写 hex），不是 native engine id |
| `active_item_id` | `TEXT NULL` | 当前 turn 来源队列项 |
| `active_trace_id` | `TEXT NULL` | master 铸造的 canonical trace |
| `active_started_at` | `TIMESTAMPTZ NULL` | idle refund/观测；不因插话重置 |
| `steer_delivery` | `TEXT NULL` | `native` / `fork-native` / `turn-boundary` |
| `coordinator_epoch` | `BIGINT` | container replacement fencing token |
| `lease_owner`, `lease_until` | `TEXT`, `TIMESTAMPTZ` | 只保护调度 claim，不影响用户 mutation |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | 审计/清理 |

主键为 `(owner_user_id, session_key)`。所有 mutation `SELECT ... FOR UPDATE` 该行；不存在时先以 owner + canonical session data 创建。

#### `prompt_queue_items`

| 列 | 类型 | 约束/语义 |
|---|---|---|
| `owner_user_id`, `session_key` | 同 head | 复合 FK 到 head，任何查询都带 owner |
| `item_id` | `TEXT` | 客户端预铸稳定 ID，匹配既有 stable client message id 约束；复合主键的一部分 |
| `client_message_id` | `TEXT` | 最终 materialize 用户行的稳定 id；通常等于 item id |
| `position` | `INTEGER NULL` | 可见队列中从 1 连续编号；`active/steer_pending` 可为 NULL |
| `state` | `TEXT` | `queued` / `dispatch_claimed` / `active` / `steer_pending` / `delivery_unknown` / `blocked` |
| `display_text` | `TEXT` | 有界展示投影，不作为模型输入真值 |
| `content_json` | `JSONB` | 完整结构化用户输入；不含 `base64` / `localSrc` |
| `content_sha256`, `content_bytes` | `TEXT`, `BIGINT` | detail 对账、同 idempotency key 冲突检测、容量配额 |
| `requested_execution` | `JSONB` | 用户选的 agent/model/effort/teamMode；执行时重新做 authority fence，不保存已签 descriptor |
| `delivery_mode` | `TEXT NULL` | `insert_current` / `interrupt_then_head` |
| `expected_turn_id` | `TEXT NULL` | 用户点击插话时看到的平台 `turnKey` |
| `delivery_idempotency_key` | `TEXT NULL` | 插话请求键 |
| `delivered_turn_id` | `TEXT NULL` | 成功注入的原平台 turnKey |
| `engine_receipt` | `JSONB NULL` | native turn id/client id 或 fork ACK；仅 server 读 |
| `claim_token`, `claim_until` | `TEXT`, `TIMESTAMPTZ` | 启动/交付 lease |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | 排序与展示 |

约束：

- `(owner_user_id, session_key, item_id)` 主键。
- `(owner_user_id, session_key, position)` 在 `position IS NOT NULL` 时唯一、可延迟检查；重排事务内统一重编号。
- `queued` 必须有 position；`active` 必须与 head 的 `active_item_id` 一致。
- 一个 session 同时最多一个 `active`，由 head 行和 partial unique index 双保险。
- item 数量建议上限 50；队列总内容字节上限与现有单消息总上传上限共用常量，避免把现有可发送的大文本武断降成 64 KiB。大字段永不进 snapshot。

#### `prompt_queue_item_attachments`

| 列 | 类型 | 语义 |
|---|---|---|
| owner/session/item | 复合 FK | 删除 item 时级联删除逻辑引用 |
| `ordinal` | `SMALLINT` | 0..7；件数权威继续复用 `MAX_ATTACHMENTS_PER_MESSAGE=8`（`packages/protocol/src/frames.ts:58-66`） |
| `kind` | `TEXT` | image/file/audio/video 等 |
| `url` | `TEXT` | 只接受 `/api/media/<content-addressed-name>` |
| `mime_type`, `filename`, `hidden` | `TEXT/TEXT/BOOL` | 现有 `MediaRef` 投影字段 |
| `content_sha256`, `size_bytes` | nullable | 可校验时记录，不信任客户端自报 |

现有 `MediaRef.localSrc` 明确是浏览器本地字段，发送/持久化前必须剥离（`packages/protocol/src/frames.ts:33-55`）；新队列同样不存它。url-only 媒体解析已经要求 `/api/media/...` 并校验 realpath 留在 uploadsDir（`packages/gateway/src/server.ts:11299-11320`），出队和 steer 必须复用该函数，不重写一份校验。

#### `prompt_queue_mutations`

持久化幂等 ledger，不能复用 gateway 进程内的 inbound dedupe。

| 列 | 类型 | 语义 |
|---|---|---|
| owner/session | 复合 owner | 隔离租户 |
| `idempotency_key` | `TEXT` | 调用方稳定键，唯一 |
| `operation` | `TEXT` | enqueue/edit/delete/reorder/interject |
| `request_sha256` | `TEXT` | 同 key 不同 payload 必须 `IDEMPOTENCY_CONFLICT` |
| `item_id` | `TEXT NULL` | 关联 item |
| `outcome` | `TEXT` | applied/noop/conflict 等 |
| `applied_version` | `BIGINT` | 首次成功的 version |
| `created_at` | `TIMESTAMPTZ` | 保留至少 30 天；清理由既有中央 retention job 承担，不新增独立 sweeper |

重复请求返回**当前**完整 snapshot，并在 `mutation.appliedVersion` 指出首次生效版本；不回放一份过时 snapshot。

### 3.2 Wire 类型

```ts
type SteerDelivery = 'native' | 'fork-native' | 'turn-boundary'

type PromptQueueAttachmentRef = {
  ordinal: number
  kind: string
  url: string
  mimeType?: string
  filename?: string
  hidden?: boolean
}

type PromptQueueItem = {
  id: string
  clientMessageId: string
  position: number | null // delivery lane items have no waiting-list position
  displayText: string
  contentHash: string
  contentBytes: string
  attachmentRefs: PromptQueueAttachmentRef[]
  state: 'queued' | 'steer_pending' | 'delivery_unknown' | 'blocked'
  requestedExecution: {
    agentId: string
    model?: string
    effortLevel?: string | null
    teamMode?: boolean
  }
  createdAt: number
  updatedAt: number
}

type PromptQueueSnapshot = {
  type: 'outbound.prompt_queue.snapshot'
  owner: {
    userId: string
    sessionKey: string
    clientSessionId: string
    agentId: string
  }
  version: string
  activeTurn: null | {
    id: string                 // platform turnKey
    sourceItemId: string
    traceId?: string
    startedAt: number
    steerDelivery: SteerDelivery
  }
  items: PromptQueueItem[]
  mutation?: {
    idempotencyKey: string
    operation: 'enqueue' | 'edit' | 'delete' | 'reorder' | 'interject'
    outcome: 'applied' | 'duplicate' | 'version_conflict' |
             'turn_changed' | 'delivery_pending' | 'delivery_unknown' |
             'rejected'
    appliedVersion?: string
    code?: string
  }
  serverTs: number
  frameSeq?: number
}
```

`version` 是业务状态版本；`frameSeq` 只是 transport ring 游标。前端先过既有 `frameSeq` 去重，再以 `BigInt(snapshot.version)` 比较：小版本忽略，大版本整体替换；同版本只可完成本地 mutation promise，不能回退状态。

### 3.3 事务与状态不变量

每个写请求的固定事务模板：

1. 由认证上下文得到 owner，锁 `prompt_queue_heads`。
2. 查 `prompt_queue_mutations`；相同 key/hash 走 duplicate，相同 key/不同 hash loud fail。
3. 对 edit/delete/reorder/interject 校验 `expectedVersion`；enqueue 是可交换 append，不因另一 tab 刚入队而拒绝，但仍记录 `observedVersion`。
4. 校验 item owner/state/附件；事务内应用 mutation 并连续重编号。
5. `version = version + 1`，写 mutation ledger，提交。
6. 从已提交事务结果组装完整 snapshot，广播所有同 peer tabs。广播失败不回滚；下次 hello 从 PG 重建。

edit/delete 只允许 `queued/blocked`；`steer_pending/delivery_unknown/active` 返回 `ITEM_ALREADY_DELIVERING`，不能假装撤回模型已经可能看到的内容。

## 4. 协议帧与对账

### 4.1 Client → server 请求帧

所有 schema 在 `packages/protocol/src/frames.ts` 以 TypeBox 定义、导出 `Static` 类型并加入 `AnyFrame`。现有 `sys.context_rebuilt` 注释已明确要求新帧同时进 schema、类型和 `AnyFrame`，避免历史漏型（`packages/protocol/src/frames.ts:708-744,799-816`）。`packages/web-react/src/lib/chat/frames.ts` 只 type-import，不另抄一份枚举（`packages/web-react/src/lib/chat/frames.ts:1-18`）。

公共字段：`sessionKey` 不由浏览器任意指定；仍由 `peer + agentId + authenticated user` 解析并交叉校验。所有 mutation 带 `idempotencyKey`，edit/delete/reorder/interject 带 `expectedVersion`。

```ts
type InboundPromptQueueEnqueue = {
  type: 'inbound.prompt_queue.enqueue'
  peer: Peer
  channel: 'webchat'
  agentId: string
  itemId: string
  clientMessageId: string
  observedVersion?: string
  idempotencyKey: string
  content: InboundMessage['content']
  requestedExecution: { model?: string; effortLevel?: string | null; teamMode?: boolean }
}

type InboundPromptQueueEdit = {
  type: 'inbound.prompt_queue.edit'
  peer: Peer
  agentId: string
  itemId: string
  expectedVersion: string
  idempotencyKey: string
  content: InboundMessage['content']
}

type InboundPromptQueueDelete = {
  type: 'inbound.prompt_queue.delete'
  peer: Peer
  agentId: string
  itemId: string
  expectedVersion: string
  idempotencyKey: string
}

type InboundPromptQueueReorder = {
  type: 'inbound.prompt_queue.reorder'
  peer: Peer
  agentId: string
  orderedItemIds: string[]       // 当前可见队列的完整排列，不是 from/to delta
  expectedVersion: string
  idempotencyKey: string
}

type InboundPromptQueueInterject = {
  type: 'inbound.prompt_queue.interject'
  peer: Peer
  agentId: string
  itemId: string
  mode: 'insert_current' | 'interrupt_then_head'
  expectedVersion: string
  expectedTurnId: string         // 平台 turnKey；native id 永不暴露到浏览器
  idempotencyKey: string
}
```

重排传完整 `orderedItemIds`，服务端要求与当前可重排 item 集合完全相等；这样不会因客户端算错 from/to 把 item 漏出队列。

大内容详情通过 `GET /api/prompt-queue/items/:itemId?session=...` 读取，返回 `content_json + contentHash + snapshotVersion`；它只用于打开编辑器。edit frame 仍是唯一写入口。

### 4.2 Server → client 完整快照

唯一业务状态帧是 `outbound.prompt_queue.snapshot`。成功 mutation/turn start/turn end/steer 状态变化都 bump version 并向 `clientsByPeer` 的所有 tab 广播。现有 permission settlement 已通过 `_sendStampedSessionFrame()` 做 ring store + all-tab broadcast（`packages/gateway/src/server.ts:10135-10200`），队列快照复用同一 helper，不造专用 socket fanout。

stale mutation 不改 version，只向请求 tab 回当前 snapshot，`mutation.outcome='version_conflict'`。客户端用它覆盖本地并提示“队列已在另一标签页更新，请确认后重试”；禁止自动覆盖别人的编辑/删除。enqueue 因为是 append 可安全自动合并，不走版本冲突。

### 4.3 hello、ring 与重连

现有 hello 每个 peer 已带 `inFlight/lastFrameSeq/resumeActiveTurnCandidateMessageIds`（`packages/web-react/src/lib/chat/frames.ts:222-233`）。gateway 会按 session ring replay；ring miss 发 `outbound.resume_failed`，并明确 durable persistence 才是长期 backstop（`packages/gateway/src/server.ts:10490-10561`）。

队列对账规则：

1. hello 完成现有 ring replay 后，**无论 hit/miss 都从 PG 读取一次当前完整 queue snapshot，单播给本次 ws**。ring 只优化 live mutation；PG snapshot 才解决 master/container restart。
2. ring 可能依次重放多个 snapshot；前端 version 守卫只保留最大版本。随后 PG fresh snapshot 相同或更高，幂等收敛。
3. `resume_failed` 仍触发既有 REST 会话同步；queue 不塞进会话 messages，而是并行拉/等 fresh snapshot。两种数据各守自己的 durable authority。
4. master restart 后 ring 消失不影响 queue；新 bridge 建立后由 SessionManager repository 读 PG。
5. container restart 后新 coordinator 用 `coordinator_epoch` fence 旧 claim，再重建 queued items。旧实例迟到的 delivery ACK 因 epoch/claim token 不符被拒。

gateway 的 ring 本来就是短期内存优化（`packages/gateway/src/server.ts:1603-1610`），不能把 queue version 或 items 只放 ring。队列快照按 `content` 而不是 `progress` 分类；现有 eviction 水位线是 `contentLossSeq`，只有 content 丢失才要求 REST resync（`packages/gateway/src/outboundRing.ts:18-28,52-59`）。因此即使 ring 因压力丢过队列快照，连接也会用 PG 生成的新快照收敛，而不是从 delta 猜状态。

## 5. 用户语义与状态机

### 5.1 Enter、自动启动和可见状态

- **空闲按 Enter**：仍先 durable enqueue；同一事务提交后 coordinator claim 队首并请求 execution grant，UI 可短暂看到 queued → active。没有“空闲时绕过 PG 直发”的旁路。
- **运行中按 Enter**：默认 enqueue 到队尾，立即广播。前端用户行显示 `queued`，队列面板允许 edit/delete/reorder。
- master/PG 不可用时不返回已入队 ACK；本地 optimistic 行保持 `sending/retry`，不能降级塞进 SessionManager promise 链。
- 出队前重新按当前 catalog 做模型授权和价格预检。模型已下线、余额不足或账户池暂不可用时，item 不丢：分别进入 `blocked`（需用户处理）或留队首等待可重试资源，并通过 snapshot 给稳定 reason code。

### 5.2 “插入当前任务”

固定算法：

1. 事务锁 head，验证 `expectedVersion`、item 可交付、`expectedTurnId === active_turn_id`。
2. 不匹配说明用户点击时当前 turn 已变；不调用引擎，直接把 item 原子移到 position 1，返回 `turn_changed`。
3. 匹配时把 item 置 `steer_pending`，写 delivery idempotency key、claim token，bump version。**先 durable，后调用引擎**。
4. 根据 active turn 能力选择且只选择一个档位：
   - `native`：适配器调用 Codex `turn/steer`；
   - `fork-native`：适配器发送 CCB `openclaude_steer`；
   - `turn-boundary`：不调用引擎，立即把 item 移到队首。
5. 只有收到可核验的“已进入当前 turn” receipt 才把 item 从队列 ownership 转移到 active turn tape/user row；否则 item 仍在 PG。

UI 入口永远叫“插入当前任务”。差异只在结果微文案：

- `native/fork-native` receipt：`已加入当前任务`；
- 能力/内容不支持或 turn 已结束：`已移到下一项，将在当前任务结束后执行`；
- receipt 未决：`正在确认是否已加入当前任务…`，不允许重复按钮制造新 item。

### 5.3 插话与 turn 结束竞态

turn completion 与 delivery ACK 都必须锁同一 head：

- completion 先拿锁：清 active turn，把所有属于它的 `steer_pending` 按插话请求顺序放到队首，bump version；迟到 ACK 的 claim token/active turn 不再匹配，忽略。
- positive receipt 先拿锁：item 标记已由该 `active_turn_id` 消费并转移附件 ownership；completion 不再把它入队。
- transport 断在“引擎可能已收、平台未收到 response”的 `delivery_unknown`：不得盲重发。
  - Codex 用 `thread/items/list`/`thread/read(includeTurns=true)` 查当前 native turn 中 `userMessage.clientId === itemId`；存在即 consumed，不存在才入队首。
  - CCB fork receipt 只在 query loop 真正把 steer attachment 注入下一次 API round 后发出；未消费项在 run 收尾时由 fork 返回 `turn_ended`，不会被 CCB 自己偷偷排成 follow-up。
  - 若进程已毁且无法证明，保留 `delivery_unknown`、阻止自动下一轮并重试 reconciliation；达到运维时限后按“不丢优先”转队首并打 duplicate-risk metric。Codex native 灰度的前置门是实测能用 `clientId` 消除该歧义。

这是一条 at-least-once 风险边界：在底座进程崩溃且 rollout 也不可读的极端窗口，无法同时数学保证不丢和不重复。本 RFC 明确选择不丢，并把 native 开关以 reconciliation probe 为硬门。

### 5.4 “停止并立即执行”

`mode='interrupt_then_head'` 的事务先把目标 item 放 position 1、记录 interrupt intent，再调用 `SessionManager.interrupt(sessionKey)`。当前 interrupt 已统一中止 external turn 与 runner（`packages/gateway/src/sessionManager.ts:3695-3717`）。

规则：

- interrupt 是当前 turn 的终止动作，不把待执行 item 直接写进 runner stdin。
- 收到当前 turn terminal/persistence barrier 后，正常 coordinator claim 队首并走新的 execution grant、new `turnKey`、new billing journal。
- interrupt 调用失败/进程已结束也不丢 item；它已经在队首，按普通 turn-boundary 执行。
- 若该 item 已有 positive steer receipt，按钮禁用并显示“已加入当前任务”，因为不能可靠撤回已注入上下文。

### 5.5 item 与附件生命周期

```text
queued/blocked
  ├─ edit/delete/reorder
  ├─ claim → dispatch_claimed → active → terminal+tape ACK → 删除 queue row
  └─ interject → steer_pending
                   ├─ positive receipt → active turn ownership → tape ACK → 删除
                   ├─ turn ended/not steerable → queued(position=1)
                   └─ ambiguous → delivery_unknown → reconcile
```

- 普通启动：用户行 durable materialize 并取得 `turnKey` 后，item 从可见队列转 active；turn tape ACK 后删除 queue row。启动前 container crash 的过期 claim 可安全回 queued；已有 active turn id 的 claim 不自动重跑，先查 tape/runner，避免重复工具副作用。
- native 插话：materialize 一条 role=user 的 interjection record，携带**同一**逻辑 `turnKey`；它是 transcript 内容，但不是新 turn 边界。
- 删除/编辑 queued item 只删/替换 queue attachment refs。现有上传文件是内容寻址并且运行期没有通用物理删除（仅 tmp 清理），因此 v1 不因删队列项立即 unlink blob；若同一 blob 已进会话历史更不能删。普通启动/插话成功时，ref ownership 转给 user message/tape。未来 blob GC 必须按 queue + chat 全局引用计数，不做局部猜测。
- base64 legacy 帧在入队前先走现有 upload，PG 只存 URL ref。这样 master/container restart 不需要把二进制塞进 snapshot。
- `structuredBlocks` 已用于 plan/goal 的精确输出流，和 `engineBilling` 一起进入 lossless tape（`packages/gateway/src/sessionManager.ts:722-734`）。队列输入不滥用 `structuredBlocks`；插话证据应作为同 turn user record + bounded runtime event 持久化。

## 6. 引擎交付

### 6.1 统一适配器契约

Engine capabilities 增加：

```ts
type EngineSteerCapability = {
  steerDelivery: SteerDelivery
}

type SteerRequest = {
  itemId: string
  expectedPlatformTurnId: string
  content: NormalizedUserContent
  attachmentRefs: PromptQueueAttachmentRef[]
}

type SteerReceipt =
  | { disposition: 'accepted_current_turn'; platformTurnId: string; engineReceipt: object }
  | { disposition: 'turn_ended' | 'not_steerable' | 'unsupported_input' }
  | { disposition: 'unknown'; reconcileKey: string }
```

SessionManager 先比较平台 `turnKey`，adapter 再把它映射到私有 native turn id。浏览器和 PG item 永远不拿 native id 当业务主键。

### 6.2 Codex `native`

本机 `codex-cli 0.144.0` 在 2026-07-16 用
`codex app-server generate-ts --experimental` 生成的协议绑定已确认：

```ts
type TurnSteerParams = {
  threadId: string
  clientUserMessageId?: string | null
  input: UserInput[]
  responsesapiClientMetadata?: Record<string, string> | null
  additionalContext?: Record<string, AdditionalContextEntry> | null
  expectedTurnId: string
}
type TurnSteerResponse = { turnId: string }
```

`UserInput` schema 包含 text、image URL、localImage path、skill、mention；错误 schema 还声明 `activeTurnNotSteerable`，当前非 steerable kind 为 review/compact。生成物只在 `/tmp` 探测，不是仓库实现依据；正式开发应把同一生成命令锁进 compatibility test。

调用映射：

- `threadId = runner.threadId`
- `expectedTurnId = runner.activeTurnId`（native UUID，不是平台 turnKey）
- `clientUserMessageId = itemId`
- `input =` 复用 `turn/start` 的 normalise/media builder
- response `turnId` 必须等于调用时 active native turn id，否则 receipt 无效

runner 当前已有 generic request pending map（`packages/gateway/src/engine/codexAppServerRunner.ts:786-802`）和 `turn/completed` active-id 守卫（`packages/gateway/src/engine/codexAppServerRunner.ts:2097-2112`），新增 `steer()` 应复用 `sendRequest`，不另开 stdio writer。

**待实测及硬门：**

1. 同一个 `clientUserMessageId` 重复 steer 是幂等、拒绝还是重复注入。
2. response 返回时 user item 是否已经 durable 写入 rollout；进程在 response 前崩溃后，`thread/items/list` 是否稳定返回 `clientId`。
3. text/image URL/localImage 在运行 turn 的实际接受范围；远端 `/api/media` URL 是否要先转容器 path。
4. steer 与 `turn/completed`、review/compact、permission/tool call 同时发生的错误码和通知顺序。
5. steer 产生的 token 是否自然进入当前 `thread/tokenUsage/updated` 的 `last/total`。当前 runner 已按该通知维护 turn usage（`packages/gateway/src/engine/codexAppServerRunner.ts:2114-2120`），但 steer 后增量仍需实跑。

探测方法：启动 app-server，initialize → thread/start → 发一个有工具等待的长 turn → `turn/steer`；分别重复 client id、在 completion 前后发、带 image/localImage 发、kill app-server 于 request/response 间，再 resume + `thread/items/list` 查 clientId。所有 probe 录原始 JSONL 和 0.144.0 版本；任一 receipt/reconcile 不满足，生产 capability 仍报 `turn-boundary`。

### 6.3 CCB `fork-native` 控制帧（只设计）

#### 帧名与 schema

沿用 CCB stdin `control_request/control_response`，自有 subtype 使用 namespace，避免将来与上游同名：

```json
{
  "type": "control_request",
  "request_id": "steer-<idempotency-key>",
  "request": {
    "subtype": "openclaude_steer",
    "steer_id": "<queue item id>",
    "expected_turn_id": "<platform turnKey>",
    "content": [
      { "type": "text", "text": "补充要求" }
    ]
  }
}
```

成功 response：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "steer-...",
    "response": {
      "steer_id": "...",
      "disposition": "accepted_current_turn",
      "expected_turn_id": "..."
    }
  }
}
```

可恢复结果用 success response 的 `disposition: turn_ended | duplicate_accepted`；契约/内容错误用 error response，error code 放进 bounded response 字段，不把任意异常文本直透用户。

`content` 类型与 `QueuedCommand.value` 对齐：string 或 Anthropic content blocks。fork 当前 `QueuedCommand.value` 已支持 `string | ContentBlockParam[]`（`claude-code-best/src/types/textInputTypes.ts:297-307`），gateway 的普通 submit 也支持完整 blocks（`packages/gateway/src/subprocessRunner.ts:1485-1503`）。

#### 注入点与 current-turn 语义

- schema：在 `claude-code-best/src/entrypoints/sdk/controlSchemas.ts:97-103,552-584` 附近增加 `SDKControlOpenClaudeSteerRequestSchema` 并加入 inner union；沿用既有 control response schema（`:586-609`）。
- stdin：`StructuredIO.processLine()` 已原地应用 `update_environment_variables`，并把 `control_request` 交给 main loop（`claude-code-best/src/cli/structuredIO.ts:338-367,437-453`）。steer 不在此处改队列，只做 schema/路由。
- handler：在 `print.ts` 的 interrupt 分支旁处理。先要求 `running=true`，再解析 `process.env.CLAUDE_CODE_EXTRA_METADATA.oc_turn_key` 与 `expected_turn_id` 相等；该 env 已由 gateway 每 turn 注入（`packages/gateway/src/subprocessRunner.ts:178-197,1492-1524`）。不匹配直接 `turn_ended`。
- handler 把 command 标为 `origin=openclaude-steer`、`uuid=steer_id`、`priority='next'`。现有 priority 定义已经把 `next` 定义为“当前工具结束后、下一次 API round 前注入”（`claude-code-best/src/types/textInputTypes.ts:276-294`），message queue 同优先级 FIFO（`claude-code-best/src/utils/messageQueueManager.ts:40-53,123-155`）。
- **不能 enqueue 后立刻 ACK。** `query.ts` 当前在 tool result 与下一轮 API 之间取 `next` 队列、转 attachment，并在真正消费后 remove（`claude-code-best/src/query.ts:1550-1593,1633-1646`）。只有该消费点确认同一 run generation 后，才回 `accepted_current_turn`。
- 若本轮没有下一次 API round 就结束，run-finally 必须移除尚未消费的 `openclaude-steer` command、回 `turn_ended`；绝不让 `print.ts` 的 turn 间 drain 把它变成 CCB 自己的 follow-up。当前 turn 间 drain 会批量合并 queued prompt（`claude-code-best/src/cli/print.ts:1932-1973`），该路径对 openclaude steer 必须显式排除。
- 图片 blocks 在现有 `getQueuedCommandAttachments()` 内会作为 queued command prompt 注入（`claude-code-best/src/utils/attachments.ts:1045-1083`）；实测不支持的 block 返回 `unsupported_input`，平台自动走队首，不丢附件。

#### 幂等与 interrupt

- fork 维护以 `(runGeneration, steer_id)` 为键的 bounded receipt map；重复帧返回原 disposition，不重复 enqueue。
- 可同时复用已有 user UUID runtime/history dedupe 思路；普通 user path 已检查 session JSONL 和当前进程 UUID set（`claude-code-best/src/cli/print.ts:4074-4113`）。steer 是否进入 JSONL 要在实现测试中钉死。
- interrupt 优先：收到 interrupt 后先把 generation 标成 stopping，未消费 steer 回 `turn_ended`，再 abort。现有 interrupt control request 会 abort 当前 controller 并回 success（`claude-code-best/src/cli/print.ts:2842-2862`）；gateway 当前也用 stdin control request 发 interrupt（`packages/gateway/src/subprocessRunner.ts:1854-1868`）。
- 已消费并 ACK 的 steer 不可撤回；后到 interrupt 只终止余下生成。

#### fork 改动面估计

- `controlSchemas.ts`：schema + 类型；
- `print.ts`：pending receipt/generation、handler、turn-end flush；
- `messageQueueManager.ts` / `textInputTypes.ts`：origin/dedupe/remove helper；
- `query.ts`：消费回调；
- 3 组单测：成功 mid-turn、turn-end fallback、interrupt/duplicate/image。

预计 fork 侧 5～7 个文件、约 180～300 行实现与 250～400 行测试；gateway 另需 `SubprocessRunner` pending control-response map 和 `CcbAdapter.steer()`。当前 runner 对 stdout JSONL 只统一 emit `message`（`packages/gateway/src/subprocessRunner.ts:1383-1444`），因此 response 关联必须在 runner 增加 request map，不能让业务层猜日志。

### 6.4 `turn-boundary`

它不是第四个队列，只是 PG item 的交付结果：item 原子移动 position 1，当前 turn terminal 后由同一个 coordinator claim。以下情况统一落此档：

- engine capability 本来就是 fallback；
- Codex review/compact 不可 steer；
- CCB 当前 run 没有下一 API boundary；
- item 是专用 imageEdit/job 或含 native 不支持的附件；
- expected turn 已改变；
- 明确 negative receipt。

## 7. G7、SessionManager lock 与 runner.queue 退役

### 7.1 userChatBridge 替代逻辑

新 queue mutation frame 只做认证、限流和转发，不进入 Codex acquire/preCheck/journal。G7 的三个 busy 条件不再拒绝用户输入。

真正 dequeue 时，coordinator 发内部 `prompt_queue.dispatch_request`（带 head version、item id、claim token、requested execution）；commercial 的 `prepareQueuedTurn()`：

1. 重新解析 model catalog/engine 与 security epoch；
2. 对 Codex 获取 account/relay slot；资源 busy 时回 retryable grant failure，item 留队首；
3. 跑 `preCheck`、创建 journal、铸造 requestId/traceId、签 execution descriptor；
4. 回 `dispatch_grant`；gateway 以 claim token CAS 成 active 再调用 runner；
5. 任何 grant 在 claim/epoch 失效后都必须 release，不能由迟到 grant 启动 turn。

这一封装复用 current bridge 的单套计费/authority helper，不复制 acquire/finalizer。Codex billing 仍经 `codexFinalizer → settleUsageAndLedger → spendTwoBucket` 收口；现有 bridge 在 billing 帧分支已明确该链和零输出规则（`packages/commercial/src/ws/userChatBridge.ts:4008-4039`）。

### 7.2 `CODEX_TURN_BUSY` 兼容期

按三阶段退役：

1. **兼容写入**：master 识别新 container capability。老 web 的第二条 legacy `inbound.message` 若 container 已支持 queue，master 将它规范化为 enqueue（id/item 取既有 `clientMessageId`），不 acquire、不回 busy；老 container 仍保留旧 busy，避免发它不认识的帧。
2. **新 web 上线**：composer 全部发 queue enqueue。前端仍识别 `CODEX_TURN_BUSY` 一个发布窗，但文案改为“服务端队列尚未就绪，本条未入队，请重试”，并打 compatibility telemetry；不再引导“等结束再发”。
3. **runtime 覆盖后**：删除 G7 reject branch 和 error emit；再保留一个发布窗的纯解析兼容，观察命中为 0 后删 `codex_turn_busy` 映射。

`CODEX_TURN_BUSY` 不是新的 fallback 交付机制，只是滚动升级期间老 runtime 的显式失败。

### 7.3 SessionManager promise lock

保留一个执行 mutex 可以防实现 bug，但语义改为：

- 用户请求不直接调用 `submit()` 等待 mutex；只写 PG。
- coordinator 只在没有 active claim 时调用一次 `submit()`。
- `_activeTurnCount` 表示真实 active execution，不再把 promise 链里尚未执行的消息都算在飞。
- 发现第二个 submit 时抛内部 invariant error，并把对应 PG claim 退回 queued；绝不静默排到 promise 后面。

### 7.4 Codex runner.queue

推荐删除 `QueuedTurn[]`，把 `submit()` 改为单次 `runTurn()`；`processing=true` 时抛 `RUNNER_BUSY_INVARIANT`。若为滚动兼容暂留，硬上限必须是 1，且只代表 SessionManager 已 claim 的那一个执行交接；metrics 命中第二项即告警。完成全量灰度后删除，不留下第四套排队语义。

## 8. 计费、免单、退款、评分与 goal 裁决

### 8.1 成本归因

**裁决：native/fork-native 插话的全部成本归原逻辑 turn，不拆分。**

- 插话沿用 active `turnKey`、traceId 和已建立的执行 grant/journal。
- Codex final usage 是 turn aggregate；CCB 插话进入同一 query/tool loop，后续代理请求继续携带同一个 `oc_turn_key`。`_buildCcbUsageAttributionEnv()` 已把 turnKey 放进每次请求 metadata（`packages/gateway/src/subprocessRunner.ts:178-197`）。
- 现有结算已在双钱包 `spendTwoBucket` 单点扣费并把 request 精确 stage 到 turnKey（`packages/commercial/src/billing/proxyBilling.ts:749-789`）；不新增“queue charge”或“steer charge”。
- queue item id 作为 tape runtime event/原 turn user record 的观测字段，不是 ledger ref。
- `turn-boundary`/停止后立即执行会创建新 turnKey、traceId、preCheck 和 journal，按新轮独立计费。

拆分插话成本会要求猜测 cache/input/output token 属于哪段文字，双引擎没有相同粒度；它还会让一轮出现多个评分/退款边界。因此明确拒绝。

### 8.2 零输出免单

现有 Codex finalizer 在 success 且 `output_tokens=0` 时把应收改为 0、只留 audit snapshot（`packages/commercial/src/billing/codexFinalizer.ts:235-278`）；代理路径同样在 finalizer 中执行零输出规则（`packages/commercial/src/billing/proxyBilling.ts:354-373`）。

插话后的规则不变：

- active turn 从开始到结束完全没有 output → 整轮按现有规则免单；
- 插话前已经有 output、插话后没有新增 output → 不做“插话局部免单”，因为用户已经收到本轮输出，且没有可靠分段用量；
- CCB 内某个新增上游请求自身 output=0 时，既有 per-request finalizer仍会免该请求，不影响其它成功请求；
- fallback 新 turn 的 output 独立判断。

### 8.3 idle-timeout 与精确退款

现状：gateway 从 turn start 回退 15 秒上报 `sessionId + sinceTs`（`packages/gateway/src/sessionManager.ts:1432-1453`），发送端在 interrupt 后延迟 5 秒、失败重试一次（`packages/gateway/src/masterTurnWaive.ts:1-29`）；master 的 `refundSessionWindow()` 按 user/session/created_at 圈 success debit 并按原桶冲正（`packages/commercial/src/billing/refund.ts:1-29,35-57`）。

队列自动 drain 后，旧窗口存在确定性错账：turn A timeout，5 秒后才退款；期间 turn B 可能已在同 session settle，B 的 `created_at >= A.sinceTs`，会被一起退掉。

因此新路径必须新增精确接口：

```ts
POST /internal/v5/turn-waive
{ turnKey, engineSessionId, reason: 'idle_timeout' | 'no_response' }
```

- owner 仍从 container identity 取；`turnKey` 必须 64 hex。
- `refundTurn()` 通过 `pending_usage_patches.turn_key` 与已 materialize 的 `turn_tape_cost_components`/request id 找到**仅此 turn**的 usage records，再复用 `refundSessionWindow` 内既有“按原四桶、refund ledger、per-user advisory lock、幂等”核心。
- 0147 已给 `pending_usage_patches` 加 turn key 索引，并建立 immutable tape/cost 关联（`packages/commercial/src/db/migrations/0147_lossless_turn_tapes.sql:8-31,33-53,102-114`）；结算事务也已经原子 stage request→turn locator（`packages/commercial/src/db/pgSessionsBackend.ts:142-187`），不需要再造账务映射表。
- 插话不重置 `_turnStartedAtMs` 或 idle refund identity；它属于原 turn。用户输入可刷新 runner activity/watchdog，但不能换退款边界。
- 精确 endpoint 未覆盖前，兼容 gateway 若仍用时间窗，coordinator 必须等 waive 首次发送窗口结束后再启下一 turn；精确 endpoint 全量后删除这个节流。

### 8.4 评分卡“挂轮末条”

当前前端以“遇到 user 消息即开启新轮”计算每轮最后一条 assistant 正文（`packages/web-react/src/components/chat/turnSegment.ts:24-59`），`MessageRenderer` 用该 flag 挂评分卡（`packages/web-react/src/components/MessageRenderer.tsx:377-383,465-479`）。native 插话会在同一 engine turn 内新增 user record，继续用 user 边界会错误拆成两个评分 turn。

改为：

1. server-authored/user records 增加可选 `logicalTurnId=turnKey`；native/fork-native interjection user row沿用 active turnKey，fallback 新轮用新 turnKey。
2. `turnFinalAssistantFlags` 优先按 `logicalTurnId` 分组，只有 legacy 行缺字段时回落“user 开轮”。
3. 评分卡只挂在该 logical turn **terminal 后**最后一条非 error assistant 正文；运行中插话前的中间正文不显示评分卡。
4. response rating DB 仍以 `(user_id,message_id)` upsert，并保留 traceId/model；无需拆表或新增“插话评分”。现有表/DAO正是每条稳定 message id 的 upsert（`packages/commercial/src/db/migrations/0121_response_rating.sql:15-41`，`packages/commercial/src/responseRatings.ts:25-53`）。
5. 若整轮无 assistant 正文，不显示评分卡；零输出/timeout 由免单和错误 UI 表达。

### 8.5 goal budget

**裁决：插话不创建、补充或重置 goal budget；所有由插话引发的 token 继续计入当前 thread goal。**

Codex runner 已把 `thread/goal/updated` 的 `tokenBudget/tokensUsed/timeUsedSeconds` 转成 goal block（`packages/gateway/src/engine/codexAppServerRunner.ts:1939-1949`），并且 normalization 明确保留这些字段（`:193-224`）。因此：

- native steer 仍在同一 thread/turn，底座 goal 的 `tokensUsed` 是唯一计量权威；平台不自行估算扣减。
- turn-boundary 是新 turn，但 thread goal 若仍 active 就继续由底座累计；只有明确的 goal clear/update 才改变预算。
- queue 等待时间不计 token budget；执行后的 tokens 才计。
- CCB 当前没有同等 thread goal capability，不合成假 goal，也不为了 UI 对称发明第二份预算。若将来 CCB 提供 goal，以 engine capability 接入同一 goal block。

**待实测：**Codex 0.144.0 steer 后 `thread/goal/updated.tokensUsed` 是否包含 steer 引发的后续 output。用 §6.2 probe 同步记录 goal notification；不包含则 native steer 先不向有 tokenBudget 的 active goal 开放，降 `turn-boundary`。

## 9. 故障矩阵

| 场景 | durable 状态 | 对用户预期 | 自动恢复/防重 |
|---|---|---|---|
| 浏览器在 enqueue 发送后断线 | mutation 可能已提交，也可能未到 | 重连后以 full snapshot 为准；本地 optimistic 行按 item id 合并或标重试 | idempotency ledger 防重复 enqueue |
| 浏览器断线但当前 turn 继续 | queued items 留 PG，不启动下一项直到有认证 bridge | 当前输出可由 tape/ring/REST 恢复；队列仍在 | hello 后 fresh PG snapshot |
| 插话 request 后、receipt 前断线 | `steer_pending/delivery_unknown` | 显示“确认中”；不允许另建同 item | Codex 查 clientId；CCB receipt map/turn-end response；否则不丢优先转队首 |
| master 重启 | PG queue/head/mutation ledger 不变；内存 ring/grant 丢 | 重连后队列完整；未 grant 的项继续等待 | 新 grant/epoch；旧 claim token 迟到拒绝 |
| container 重启 | queued/blocked items 不变；旧 coordinator lease 过期 | 队列重现 | 未启动 claim 回 queued；已有 active id 先查 tape，active turn 标 interrupted，不自动重跑工具副作用 |
| 双 tab 同时 edit/delete | 第一个 expectedVersion 成功，第二个 stale | 第二个看到最新 snapshot + 冲突提示，用户决定是否重试 | 不做 last-write-wins；enqueue 仍可交换 append |
| 双 tab 同时 reorder | 只有一个完整排列 CAS 成功 | 两边最终同一顺序 | full item-set 校验，绝不漏 item |
| 连续多次“插入当前任务” | 每项独立 id/key，按点击事务顺序 `steer_pending` | native boundary 能消费的依次注入；turn 先结束则未消费项保持顺序转队首 | engine receipt 后才消费；同 key 重复不注入 |
| 插话与 turn completion 同时 | 两者锁同一 head | 要么进入原 turn，要么成为下一轮队首，无消失态 | active turn/claim token CAS |
| “停止并立即执行”时 runner 已结束 | item 已在队首 | 直接作为新 turn 启动 | interrupt negative 不删除 item |
| 图片附件、短断线 | PG 只有 content-addressed refs | 缩略图/文件名仍显示；交付时重新 resolve | 禁 base64/localSrc；同一 media validation |
| 图片 ref 文件缺失/损坏 | item 进入 `blocked`，保留文本和 ref metadata | 明确“附件不可用，可删除/替换后重试”，不静默丢图运行 | edit 替换附件后新 version；不自动重复上传 |
| native 不支持该图片/专用 imageEdit | item 不调用 steer，position=1 | 微文案说明当前任务结束后执行 | 仍是 `turn-boundary`，不是新机制 |
| PG/store 暂不可用 | 不 ACK durable enqueue/mutation | 显示可重试错误，本地草稿保留 | 禁止 fallback 到 promise/runner 内存队列 |
| 出队时余额/模型权限变化 | item `blocked` | 展示稳定 reason；充值/换模型/编辑后重试 | 不在 enqueue 时预占/预扣 |
| idle-timeout 后立刻自动下一轮 | turn A 精确 turnKey refund；turn B 新 turnKey | A 免单、B 正常计费 | 禁止旧 session time-window 跨轮冲正 |

## 10. 测试计划

### 10.1 协议、PG 与状态机

- protocol TypeBox 编译/parse：五类 inbound + snapshot；非法 version、owner、item id、附件 URL、超 8 件拒绝；`AnyFrame` 与 web union 完整。
- PG 真库集成：单调 version、enqueue 可交换、edit/delete/reorder CAS、同 key 同 payload replay、同 key 异 payload冲突、owner 隔离、position 连续、claim lease/epoch、master restart reload。
- property/state-machine test：随机 enqueue/edit/delete/reorder/interject/complete 序列后满足“每个未 receipt item 恰好在 active 或 queue 一处”“position 无洞”“version 不回退”。
- snapshot 测试要走真实帧序列/reducer，不写源码 regex；V5 playbook 也要求行为断言而非源码文本断言（`docs/V5_DEV_PLAYBOOK.md:120-124`）。

### 10.2 双引擎对称验收矩阵

| 用例 | Codex | CCB |
|---|---|---|
| active turn 按 Enter | PG 队尾、可编辑 | 完全相同 |
| 空闲 Enter | enqueue → claim → 1 个 turn | 完全相同 |
| edit/delete/reorder + stale version | full snapshot 收敛 | 完全相同 |
| 插入当前任务成功 | `turn/steer` response + clientId 可查 | `openclaude_steer` 在 query boundary 消费后 ACK |
| 没有可用 mid-turn boundary | response not steerable → 队首 | fork `turn_ended` → 队首 |
| 插话撞 completion | 原 turn receipt 或队首二选一 | 完全相同 |
| 连续 3 次插话 | FIFO 注入；余项队首 | FIFO 注入；余项队首 |
| 停止并立即执行 | interrupt 原 turn，item 新 turn | 完全相同 |
| 图片 text+image | schema/runtime probe 后 native；不支持则 boundary | content blocks；不支持则 boundary |
| master/container/browser 重启 | PG reload + native receipt reconcile | PG reload + fork receipt/turn-end reconcile |
| cost/zero-output/idle refund | 原 turnKey；精确 refund | 原 turnKey；精确 refund |
| rating | logical turn 只挂最后正文 | 完全相同 |
| active Codex goal budget | steer 后 tokensUsed 增长（probe gate） | 不伪造 goal；queue 语义仍一致 |

每个用例还要各跑 `steerDelivery='turn-boundary'`，证明关闭 native/fork flag 时 UX 和不丢保证仍成立。

### 10.3 CCB fork 专项

- control schema accept/reject；expected turnKey mismatch；无 running turn。
- steer 到达 tool call 中：不立刻 ACK，query boundary 消费后 ACK，下一 API request 确实包含 queued attachment。
- turn 在消费前结束：command 从 fork queue 删除并回 `turn_ended`，不得在下一 ask 被 drain。
- duplicate steer id 在 enqueue 前/消费后/ACK 丢失三时点只注入一次。
- interrupt 与 steer 两种顺序。
- string、image block、非法 block、8 attachments 边界。

### 10.4 计费与反馈

- Codex/CCB 插话前后多次 upstream request 仍全部 stage 到同一 turnKey，只有一个 logical rating boundary。
- output=0 与“插话前已有 output、插话后无 output”两组对照。
- idle timeout 延迟 5 秒期间启动下一 turn：只退旧 turn 的 usage/四桶，不退新 turn；重复 waive 幂等。
- org_period/org_wallet/user_period/user_wallet 四桶原路冲正；沿用 refund 测试矩阵。
- goal token budget steer 前后 notification 的 raw fixture。

## 11. Feature flag、部署生效面与灰度

### 11.1 Flags/capabilities

- `OC_PROMPT_QUEUE_V1`：总开关，默认 off；server authority 开后 web 才启用新发送协议。
- `OC_PROMPT_STEER_CODEX_NATIVE`：默认 off；必须 queue on 且 0.144.0 probe pass。
- `OC_PROMPT_STEER_CCB_FORK`：默认 off；必须 queue on 且 fork/runtime tuple 含对应 capability。
- UI 不自行读 env；以 fresh snapshot 的 `activeTurn.steerDelivery` 为真值。关闭两个 steer 子开关时仍完整提供 queue + `turn-boundary`，不是回退 G7。
- capability handshake 明确 `promptQueueV1` 和 CCB fork protocol version，供 rolling master 判断是否还能发 legacy busy。

### 11.2 生效面分类与 runtime image 预判

| 改动 | 生效面 | 动作 |
|---|---|---|
| `packages/protocol` frames | master + runtime gateway + web build | 先兼容 schema，随后 runtime/web |
| `packages/gateway` SessionManager/runner/adapters | 用户容器 runtime | runtime 发布；按本仓更严格规则重建 image |
| `claude-code-best` fork | 用户容器 CCB bundle/runtime | bun build + runtime image/tuple，存量容器滚动 |
| `packages/commercial` PG store/grant/G7/refund | master | `deploy-v5.sh` |
| `packages/web-react` queue UI/reducer/rating | dist | `deploy-v5.sh --dist`；与 master 同窗用 `--with-dist` |
| migration | shared PG | backward-compatible，受控人工 apply + `schema_migrations` 登记 |

**预判：需要重建 runtime image。**理由不是 PG 或 web，而是实施必改容器内 gateway 与 CCB fork。仓库 `AGENTS.md:5-10` 对 v5 明确规定“gateway/CCB/entrypoint 改动必须重建 runtime image”；虽然新版 playbook 的 runtime-release 矩阵允许部分源码经 release/tuple 生效（`docs/V5_DEV_PLAYBOOK.md:198-207`），本任务必须遵守两者中更严格的 image 结论。迁移仍按 `AUTO_MIGRATE=0` 人工 apply（`docs/V5_DEV_PLAYBOOK.md:365-392`）。

本 RFC 本身只改文档，不构建、不迁移、不部署。

### 11.3 灰度顺序

0. **协议 probe**：完成 Codex 0.144.0 §6.2 全部探测；未通过只做 queue boundary。
1. **PG/master 兼容层**：先 apply migration；部署 repository、dispatch grant、exact-turn refund、capability parsing，flag off。旧 runtime/web 零行为变化。
2. **runtime boundary 层**：发布新 image，SessionManager queue coordinator + PG + full snapshot + runner single-flight，native flags off。先 internal uid canary，验证 master/container restart。
3. **web**：新 composer/queue panel/full snapshot reducer 上线；总开关按 uid 1% → 10% → 50% → 100%。这一阶段两引擎都只有 `turn-boundary`，先验证统一 UX。
4. **Codex native**：仅 probe 通过的 runtime、internal uid 开；观察 delivery accepted/fallback/unknown、duplicate reconcile、计费/goal 指标，再逐级放量。
5. **CCB fork-native**：独立 runtime canary；先 text，再 image；观察 turn-end fallback 和 fork receipt。
6. **退役清理**：runtime 覆盖率 100%、`CODEX_TURN_BUSY` compatibility hit 连续一个发布窗为 0 后，删除 G7 emit、SessionManager 隐形 promise queue 与 runner.queue；最后删前端 legacy 文案。

每步 smoke 至少包含：双引擎各一轮、运行中 enqueue、重连 full snapshot、插话 fallback、stop-and-run、exact refund dry fixture。代码 + web 同窗部署遵循单次 `--with-dist`，避免两次 restart 连续打断 turn（`docs/V5_DEV_PLAYBOOK.md:212-233`）。

## 12. 可独立合并的实施切片与文件所有权

每批都以 flag off/向后兼容为合并条件，独立 typecheck/test；同一批内只由一个 owner 修改所属 package，避免交叉覆盖。

### P0：协议与探测固化

- **protocol owner**：新增 queue TypeBox types/AnyFrame/export；stable id/version helpers。
- **gateway owner**：只加 Codex app-server generated-schema compatibility fixture/probe test，不启用行为。
- **web-react owner**：只 type-import 新帧，保持旧 UI。
- 验收：schema parse、generated 0.144.0 steer shape、无 runtime 行为变化。

### P1：PG repository 与 migration（flag off）

- **commercial owner**：`NNNN_prompt_queue.sql`、`PgPromptQueueStore`、container-authenticated mutation/snapshot/detail/claim API、owner/CAS/idempotency测试。
- **protocol owner**：内部 store request/response 若需共享类型，只放 transport DTO，不放 SQL 状态机。
- 验收：真 PG restart、多 owner、双 tab CAS、mutation replay；旧 master route 不受影响。

### P2：SessionManager coordinator + turn-boundary

- **gateway owner**：PromptQueueCoordinator、hello fresh snapshot、all-tab stamped broadcast、single active claim、stop-and-run、附件复用、turn completion race。
- **gateway owner**：把 promise lock 降为执行 invariant；runner.queue 长度 1 guard（本批先不删便于 rolling）。
- **commercial owner**：抽 `prepareQueuedTurn()` 单一 helper + internal dispatch grant；新 queue frame bypass G7，但 legacy 仍兼容。
- 验收：两引擎 `turn-boundary` 全矩阵；master/container/browser restart；无预占/预扣排队项。

### P3：Web queue UX 与 logical turn rating

- **web-react owner**：snapshot reducer、queue panel、queued status、edit/detail/delete/reorder、两个动作、version conflict、compat busy 文案。
- **web-react owner**：ChatMessage `logicalTurnId`、按 turnKey 的末条评分；legacy user-boundary fallback。
- **gateway/commercial owner**：user/interjection record 透传/持久化 logical turn id（按 package 分成两个连续 commit，避免同批多人碰同文件）。
- 验收：多标签页、刷新、历史评分、移动端 composer；新入口在所有 tier 恒存在。

### P4：精确 turn refund 与计费回归

- **commercial owner**：`refundTurn(turnKey)`，复用四桶 refund core；新 internal endpoint；旧 window endpoint 兼容。
- **gateway owner**：waive 上报 turnKey；兼容期 next-turn gate；exact capability 后移除 gate。
- 验收：两轮紧邻 + 5 秒延迟、四桶、重复上报、跨桥 journal/tape locator。

### P5：Codex native

- **gateway owner**：`CodexAppServerRunner.steer()`、adapter receipt/reconcile、clientUserMessageId、image mapping、native id 私有映射。
- **commercial owner**：无需新账单；只补 native metrics/trace 查询（若需要）。
- 验收：§6.2 probe + 对称矩阵，delivery_unknown 可恢复；feature 默认 off 后独立 canary。

### P6：CCB fork-native

- **CCB fork owner**：schema、print generation/pending ACK、query consumption ACK、dedupe/interrupt/image tests。
- **gateway owner**：SubprocessRunner control response pending map、CcbAdapter.steer()。
- **protocol owner**：只在 engine capability 需要跨包时改；不把 fork 私有 frame 暴露给 web。
- 验收：fork 无隐藏 follow-up，kill/duplicate/interrupt 边界，runtime image canary。

### P7：退役与收口

- **commercial owner**：删除 G7 `CODEX_TURN_BUSY` emit/acquire-before-enqueue 分支；保留真正 dispatch grant 的 slot single-flight。
- **gateway owner**：删除 Codex runner.queue 和 SessionManager 隐形排队路径/兼容 metrics。
- **web-react owner**：命中为 0 后删 legacy busy 文案与 telemetry；保留通用 queue unavailable/conflict 文案。
- **docs/ops owner**：更新 V5 playbook 生效面、监控指标、runbook。
- 验收：源码/行为均只剩 PG queue authority；关闭 native 后仍是 turn-boundary，不复活 G7。

## 13. 观测与告警

建议指标：

- `prompt_queue_items{state,engine}` gauge；queue age/length histogram；
- mutation result：applied/duplicate/version_conflict/idempotency_conflict；
- delivery：accepted_current_turn/turn_boundary/turn_changed/unknown/unsupported；
- `delivery_unknown` age、Codex clientId reconcile hit/miss、CCB pending flushed at turn end；
- dispatch grant：authority_denied/account_busy/insufficient/retry；
- G7 compatibility hits（退役门）；runner busy invariant hits（应恒 0）；
- exact refund record/credits、任何 window fallback、跨 turn refund guard violation；
- full snapshot bytes/items、ring replay hit 后 fresh snapshot version 差值。

告警红线：

- 同一 item 同时出现在 active 与 queued；position 重复/有洞；version 回退；
- positive receipt 没有对应 active turn/tape user record；
- idle refund 命中非目标 turnKey；
- queue flag on 时出现第二个 runner queued turn 或 G7 user reject；
- delivery_unknown 超时且无法查 rollout。

## 14. 待实测清单与上线阻断项

| 未知 | 探测 | 阻断 |
|---|---|---|
| Codex duplicate `clientUserMessageId` 语义 | 重复 steer + thread/items/list | 不阻断 queue；阻断 native 放量 |
| Codex response 前 crash 的 clientId durability | kill/resume/read rollout | 阻断 native 放量 |
| Codex steer image/localImage | URL/path 各一条真 turn | 只阻断 image native；自动 boundary |
| Codex goal tokensUsed 是否含 steer | 记录 goal/token usage notifications | 有 active tokenBudget 时阻断 native |
| Codex review/compact/turn-end 错误顺序 | 并发发 steer，保存 JSONL | 阻断 native 错误映射 |
| CCB mid-turn attachment 是否写入可复核 JSONL | fork 测试 + crash replay | 阻断 fork-native |
| CCB image block 在 queued attachment 的真模型行为 | text+image integration | 只阻断 image fork-native |
| 线上 runtime-release 与 AGENTS image 红线最终运营裁决 | 发布前由 owner 对照部署树/规则确认 | 本 RFC 按更严格“重建 image”规划 |

在这些探测完成前，**完整 server queue + `turn-boundary` 已可独立上线**。任何 native 未知只影响交付时点，不能使队列入口消失，也不能回退到拒帧或内存排队。
