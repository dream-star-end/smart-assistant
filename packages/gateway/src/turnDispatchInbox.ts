/**
 * turnDispatchInbox(容器侧)—— durable turn dispatch 的执行准入 + 去重权威封装。
 *
 * 方案:docs/rfcs/RFC-v5-durable-turn-dispatch.md §3 / §4 / §7。三块职责:
 *
 *   1. DispatchAuthorityConsumer —— 验签 master 铸的 `__oc_dispatch` 票据,断言
 *      身份/连接/帧体 hash,产出 descriptor 挂 WeakMap(信任模型与 modelAuthority 同构)。
 *   2. 状态机封装 —— queued → running → sink_staged → terminal;异常出口 CAS rejected。
 *      单一权威落在 storage turn_dispatch_inbox;本文件只知道"哪些 fromState 合法"。
 *   3. boot recovery —— 开放新 ingress 前单飞跑完(§3):queued→rejected;running→
 *      recovery_pending→①本地 retry queue 有同 dispatch→sink_staged;②master 三态查询;
 *      none→确定性 synthetic crashed tape。严禁用"内存空/超时"推断 negative proof。
 *
 * 与 model authority 的边界:两张票据共用同一 Ed25519 keyring / 同一 canonical 编码
 * (protocol),但 kind 域隔离('dispatch-authority' vs 'model_authority')。dispatch
 * 不需要 replay cache —— **durable inbox 本身就是 at-most-once 去重权威**(I2),重复
 * 帧只会读到现有行,不会二次执行。
 */

import {
  type AuthorityKeyring,
  DISPATCH_AUTHORITY_FIELD,
  DURABLE_TURN_DISPATCH_CAPABILITY,
  type DispatchAuthorityPayload,
  type DispatchRequestContent,
  MODEL_AUTHORITY_KEYRING_ENV,
  ModelAuthorityError,
  computeDispatchRequestHash,
  parseAuthorityKeyring,
  verifyDispatchAuthority,
} from '@openclaude/protocol'
import {
  type TurnDispatchInboxOutcome,
  type TurnDispatchInboxRow,
  type TurnDispatchInboxState,
  casTurnDispatchState,
  getTurnDispatchByDispatchId,
  getTurnDispatchByLogicalKey,
  insertQueuedTurnDispatch,
  insertRejectedTombstoneIfAbsent,
  recordTurnDispatchRunning,
  scanOpenTurnDispatches,
} from '@openclaude/storage'
import { request as undiciRequest } from 'undici'

import { createLogger } from './logger.js'
import { readV3MasterSinkConfig } from './v3MasterSink.js'

export { DISPATCH_AUTHORITY_FIELD, DURABLE_TURN_DISPATCH_CAPABILITY }

const log = createLogger({ module: 'turnDispatchInbox' })

// ---------------------------------------------------------------------------
// 容器身份 env(与 modelAuthority.ts 同源;dispatch payload 的 uid/containerId 是字符串)
// ---------------------------------------------------------------------------

const CONTAINER_ID_ENV = 'OC_CONTAINER_ID'
const USER_ID_ENV = 'OC_USER_ID'

export type DispatchRejectCode =
  | 'not_configured'
  | 'missing'
  | 'bad_shape'
  | 'unknown_key'
  | 'verify_fail'
  | 'expired'
  | 'identity_mismatch'
  | 'challenge_mismatch'
  | 'payload_hash_mismatch'
  | 'client_message_id_mismatch'
  | 'session_mismatch'
  | 'billing_request_id_mismatch'

/** 结构化拒帧 —— 调用方按 code 分流(日志/error 帧),禁止靠 message 判定。 */
export class DispatchRejected extends Error {
  readonly code: DispatchRejectCode

  constructor(code: DispatchRejectCode, message: string) {
    super(message)
    this.name = 'DispatchRejected'
    this.code = code
  }
}

/** 该 turn 的 dispatch 执行准入身份(验签+全断言通过后的产物)。 */
export interface DispatchTurnContext {
  readonly uid: string
  readonly sessionId: string
  readonly clientMessageId: string
  readonly dispatchId: string
  readonly attemptNo: number
  readonly payloadHash: string
  readonly billingRequestId: string
}

// ---------------------------------------------------------------------------
// descriptor 的 turn 级挂载(WeakMap,同 modelAuthority.authorityByFrame:wire 无法伪造 key)
// ---------------------------------------------------------------------------

const dispatchByFrame = new WeakMap<object, DispatchTurnContext>()

export function attachDispatchContext(frame: object, ctx: DispatchTurnContext): void {
  dispatchByFrame.set(frame, ctx)
}

/** 该 frame 的 dispatch 准入身份(无 = 非 durable-dispatch turn → 调用方走 legacy)。 */
export function getDispatchContext(
  frame: object | null | undefined,
): DispatchTurnContext | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  return dispatchByFrame.get(frame)
}

// ---------------------------------------------------------------------------
// 验签消费器
// ---------------------------------------------------------------------------

export interface DispatchAuthorityConsumerOpts {
  keyring: AuthorityKeyring
  containerId?: string
  uid?: string
  clock?: () => number
}

/**
 * 容器侧 dispatch 票据验签消费器(Gateway 持一个实例)。
 *
 * `enabled` = 有公钥 keyring + 容器身份 env —— 与 modelAuthority 同条件:一个验不了签的
 * 容器不该假装能做 durable dispatch(capability 广播据此 fail-closed)。
 */
export class DispatchAuthorityConsumer {
  private readonly keyring: AuthorityKeyring
  private readonly containerId?: string
  private readonly uid?: string
  private readonly clock: () => number

  constructor(opts: DispatchAuthorityConsumerOpts) {
    this.keyring = opts.keyring
    this.containerId = opts.containerId
    this.uid = opts.uid
    this.clock = opts.clock ?? (() => Date.now())
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DispatchAuthorityConsumer {
    let keyring: AuthorityKeyring = new Map()
    try {
      keyring = parseAuthorityKeyring(env[MODEL_AUTHORITY_KEYRING_ENV])
    } catch {
      keyring = new Map()
    }
    const uidRaw = (env[USER_ID_ENV] ?? '').trim()
    const cidRaw = (env[CONTAINER_ID_ENV] ?? '').trim()
    return new DispatchAuthorityConsumer({
      keyring,
      uid: uidRaw !== '' ? uidRaw : undefined,
      containerId: cidRaw !== '' ? cidRaw : undefined,
    })
  }

  /** 本容器是否真的能验签 dispatch 票据(有公钥 + 有身份)。 */
  get enabled(): boolean {
    return this.keyring.size > 0 && this.containerId !== undefined && this.uid !== undefined
  }

  /** hello attestation 广播的 capability(不 enabled → 空数组)。 */
  capabilities(): string[] {
    return this.enabled ? [DURABLE_TURN_DISPATCH_CAPABILITY] : []
  }

  /**
   * 验签并断言一条 webchat-DM inbound.message 的 dispatch 票据。
   *
   * @param frame  原始 inbound frame(调用方须在返回后 strip wire 字段)
   * @param connectionChallenge  本连接现铸的 challenge(与 model authority 同连接同值)
   * @param content  帧体内容(用于重算 payloadHash,断言与签名一致)
   * @param opts.modelAuthorityBillingRequestId  已消费的 model-authority descriptor 的
   *        billingRequestId(存在则交叉核对,防两张票据 billing 身份分裂;取不到 → 按现状不校验)
   * @throws DispatchRejected —— 一切失败都是拒帧,没有降级放行
   */
  consume(
    frame: Record<string, unknown>,
    connectionChallenge: string,
    content: DispatchRequestContent,
    opts: { modelAuthorityBillingRequestId?: string; now?: number } = {},
  ): DispatchTurnContext {
    const now = opts.now ?? this.clock()
    if (!this.enabled) {
      throw new DispatchRejected(
        'not_configured',
        'dispatch authority not configured (missing keyring / container identity env)',
      )
    }
    const raw = frame[DISPATCH_AUTHORITY_FIELD]
    if (raw === undefined || raw === null) {
      throw new DispatchRejected('missing', 'inbound frame carries no dispatch authority')
    }
    if (typeof raw !== 'string') {
      throw new DispatchRejected('bad_shape', 'dispatch authority field is not a string envelope')
    }

    let payload: DispatchAuthorityPayload
    try {
      payload = verifyDispatchAuthority(raw, this.keyring, now)
    } catch (err) {
      throw toDispatchRejection(err)
    }

    // ── gateway 侧断言(protocol 只回答"master 签的且未过期")────────────────
    if (payload.uid !== this.uid || payload.containerId !== this.containerId) {
      throw new DispatchRejected(
        'identity_mismatch',
        `dispatch identity mismatch: payload uid=${payload.uid} cid=${payload.containerId} ` +
          `container uid=${String(this.uid)} cid=${String(this.containerId)}`,
      )
    }
    if (payload.connectionChallenge !== connectionChallenge) {
      throw new DispatchRejected(
        'challenge_mismatch',
        'dispatch connectionChallenge does not match this connection',
      )
    }
    // clientMessageId 绑定:inbox 以 clientMessageId 为逻辑键;descriptor 说 X、帧里跑 Y
    // = 准入键与执行内容分裂(重复去重/错归属)。
    const frameClientMessageId =
      typeof frame.clientMessageId === 'string' ? frame.clientMessageId : undefined
    if (frameClientMessageId !== payload.clientMessageId) {
      throw new DispatchRejected(
        'client_message_id_mismatch',
        'dispatch clientMessageId does not match frame.clientMessageId',
      )
    }
    // 帧体 hash 断言(§3):payloadHash 绑定实际内容,防同 uid 进程持窃票配异体。
    const computed = computeDispatchRequestHash(content)
    if (computed !== payload.payloadHash) {
      throw new DispatchRejected(
        'payload_hash_mismatch',
        'dispatch payloadHash does not match frame body hash',
      )
    }
    // sessionId 绑定(B9):webchat-DM 的 peer.id 即会话逻辑 sessionId;descriptor 说会话 X、
    // 帧却路由到会话 Y = 准入键(inbox 逻辑键含 sessionId)与实际会话分裂 → 跨会话错归属。
    const peer = frame.peer as { id?: unknown } | undefined
    const framePeerId = typeof peer?.id === 'string' ? peer.id : undefined
    if (framePeerId !== payload.sessionId) {
      throw new DispatchRejected(
        'session_mismatch',
        'dispatch sessionId does not match frame.peer.id',
      )
    }
    // billing 身份交叉核对(B9):同 turn 的 model-authority descriptor 若带 billingRequestId,
    // 必须与 dispatch payload 一致 —— 两张票据由 master 同事务铸造(§2.2),billing 身份分裂
    // = 计费记账与执行准入指向不同 request,财务歧义。取不到 model authority(未验签/无该字段)
    // → 按现状不校验(census 混跑期老 master 兼容)。
    if (
      opts.modelAuthorityBillingRequestId !== undefined &&
      opts.modelAuthorityBillingRequestId !== payload.billingRequestId
    ) {
      throw new DispatchRejected(
        'billing_request_id_mismatch',
        'dispatch billingRequestId does not match model-authority billingRequestId',
      )
    }

    return {
      uid: payload.uid,
      sessionId: payload.sessionId,
      clientMessageId: payload.clientMessageId,
      dispatchId: payload.dispatchId,
      attemptNo: payload.attemptNo,
      payloadHash: payload.payloadHash,
      billingRequestId: payload.billingRequestId,
    }
  }
}

/**
 * durable-turn-dispatch-v1 capability 广播判据(B5:attest + healthz 单一权威)。
 *
 * fail-closed:capability = 能验签(enabled)**且** 整条 durable 链路就绪(ready)。ready
 * 由 server 在 sink hooks 装配 ∧ 端点注册 ∧ boot recovery 首跑成功 后置真;任一不满足 →
 * 不申报 → master 便不建 dispatch(legacy 语义),不会出现"申报了却没法收敛"的孤儿。
 */
export function durableTurnDispatchCapabilities(enabled: boolean, ready: boolean): string[] {
  return enabled && ready ? [DURABLE_TURN_DISPATCH_CAPABILITY] : []
}

/**
 * inbox/tombstone 逻辑键的 user_id 归一(B1)—— 统一为**裸 uid**(与 descriptor.uid / OC_USER_ID
 * 同源)。master 端点若漏传 `c:<uid>` 前缀形态(commercial userChatBridge 会话用 c: 前缀),
 * 归一到裸 uid,避免同一用户在 inbox 里裂成两把键(准入去重失效)。已是裸形态 → 原样返回。
 */
export function normalizeDispatchUserId(userId: string): string {
  return userId.startsWith('c:') ? userId.slice(2) : userId
}

function toDispatchRejection(err: unknown): DispatchRejected {
  if (err instanceof DispatchRejected) return err
  if (err instanceof ModelAuthorityError) {
    switch (err.code) {
      case 'UnknownKey':
        return new DispatchRejected('unknown_key', err.message)
      case 'VerifyFail':
        return new DispatchRejected('verify_fail', err.message)
      case 'Expired':
        return new DispatchRejected('expired', err.message)
      default:
        return new DispatchRejected('bad_shape', err.message)
    }
  }
  return new DispatchRejected('bad_shape', (err as Error)?.message ?? String(err))
}

// ---------------------------------------------------------------------------
// 状态机封装(合法迁移的单一权威 —— fromStates 只在这里出现)
// ---------------------------------------------------------------------------

/** 准入:INSERT queued(不存在才插)。见 storage insertQueuedTurnDispatch 契约。 */
export function admitTurnDispatch(input: {
  ctx: DispatchTurnContext
  now?: number
}): Promise<{ inserted: boolean; row: TurnDispatchInboxRow | null }> {
  return insertQueuedTurnDispatch({
    userId: input.ctx.uid,
    sessionId: input.ctx.sessionId,
    clientMessageId: input.ctx.clientMessageId,
    dispatchId: input.ctx.dispatchId,
    attemptNo: input.ctx.attemptNo,
    payloadHash: input.ctx.payloadHash,
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}

/** queued → running(同事务落 finalize 元数据,先于模型调用)。 */
export function inboxRunning(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  agentId: string
  turnIndex: number
  turnKey: string
  requestId: string | null
  createdAt: number
  now?: number
}): Promise<TurnDispatchInboxRow | null> {
  return recordTurnDispatchRunning(input)
}

/** running → sink_staged(模型终态、tape stageDurable 成功后)。 */
export function inboxSinkStaged(
  key: LogicalKey,
  now?: number,
): Promise<TurnDispatchInboxRow | null> {
  return casTurnDispatchState({
    ...key,
    fromStates: ['running', 'recovery_pending'],
    toState: 'sink_staged',
    ...(now !== undefined ? { now } : {}),
  })
}

/** sink_staged/running → terminal(master ACK)。 */
export function inboxTerminal(
  key: LogicalKey,
  outcome: TurnDispatchInboxOutcome,
  now?: number,
): Promise<TurnDispatchInboxRow | null> {
  return casTurnDispatchState({
    ...key,
    fromStates: ['sink_staged', 'running', 'recovery_pending'],
    toState: 'terminal',
    outcome,
    ...(now !== undefined ? { now } : {}),
  })
}

/** → sink_stage_failed(stageDurable I/O 失败 / boot partial 消歧)。 */
export function inboxSinkStageFailed(
  key: LogicalKey,
  now?: number,
): Promise<TurnDispatchInboxRow | null> {
  return casTurnDispatchState({
    ...key,
    fromStates: ['running', 'sink_staged', 'recovery_pending'],
    toState: 'sink_stage_failed',
    ...(now !== undefined ? { now } : {}),
  })
}

/**
 * 异常出口:queued → rejected(not_accepted)。
 * INSERT queued 成功后任何 enqueue/beginClientTurn 异常必须走这里(不留给 boot);
 * boot recovery 对残留 queued 也用它收敛。
 */
export function inboxReject(key: LogicalKey, now?: number): Promise<TurnDispatchInboxRow | null> {
  return casTurnDispatchState({
    ...key,
    fromStates: ['queued'],
    toState: 'rejected',
    outcome: 'not_accepted',
    ...(now !== undefined ? { now } : {}),
  })
}

/**
 * B3 fail-closed 终局错误:queued→running CAS 未确认(返回 null / 抛异常)时抛出。
 * 语义 = 本 turn 未被容器接受执行(not_accepted);调用方(runOneTurnWithRetry)据此**在调用
 * 模型前中断**,经既有失败路径把用户可见错误投影出去,绝不继续跑出真 tape。
 */
export class TurnDispatchNotAcceptedError extends Error {
  readonly dispatchId: string
  constructor(dispatchId: string, message: string) {
    super(message)
    this.name = 'TurnDispatchNotAcceptedError'
    this.dispatchId = dispatchId
  }
}

/**
 * B3:running CAS 未确认 → CAS inbox → rejected(not_accepted)+ 抛 TurnDispatchNotAcceptedError。
 *
 * 铁律:**先落 durable rejected 墓碑(negative proof)再抛**,不留孤儿。reject 写入本身失败
 * (DB 异常)→ error log,行仍 queued,由 boot/周期 recovery(queued→rejected)兜底收敛;
 * 无论 reject 是否落地,**必抛**以阻断模型调用(不抛=继续跑出真 tape=rejected 与真 tape 双终态)。
 */
export async function failClosedOnRunningCasMiss(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  cause?: unknown
  now?: number
}): Promise<never> {
  const key: LogicalKey = {
    userId: input.userId,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
  }
  try {
    const rejected = await inboxReject(key, input.now)
    if (!rejected) {
      // CAS 落空:行已非 queued(并发 boot recovery / 已终态)或行缺失。不能保证 rejected 落地,
      // 但仍必须抛错阻断模型调用;周期 recovery 会收敛任何残留 queued 行。
      log.error('turn dispatch running CAS miss: rejected tombstone CAS did not apply', {
        dispatchId: input.dispatchId,
      })
    }
  } catch (err) {
    log.error(
      'turn dispatch running CAS miss: rejected tombstone write failed (leaving to recovery)',
      { dispatchId: input.dispatchId },
      err,
    )
  }
  throw new TurnDispatchNotAcceptedError(
    input.dispatchId,
    '任务受理后未能进入执行(内部状态未确认),本轮未执行,请重试。',
  )
}

/** running → recovery_pending(boot recovery 内部过渡态)。 */
export function inboxRecoveryPending(
  key: LogicalKey,
  now?: number,
): Promise<TurnDispatchInboxRow | null> {
  return casTurnDispatchState({
    ...key,
    fromStates: ['running'],
    toState: 'recovery_pending',
    ...(now !== undefined ? { now } : {}),
  })
}

export interface LogicalKey {
  userId: string
  sessionId: string
  clientMessageId: string
}

function keyOf(row: TurnDispatchInboxRow): LogicalKey {
  return { userId: row.userId, sessionId: row.sessionId, clientMessageId: row.clientMessageId }
}

/** tape status → inbox terminal outcome。 */
export function outcomeFromTapeStatus(
  status: 'completed' | 'interrupted' | 'crashed',
): TurnDispatchInboxOutcome {
  return status
}

// ── dispatchId 键入口(sink ACK/staged 回调只有 dispatchId,先查行再按逻辑键 CAS)──

async function withRowByDispatch<T>(
  dispatchId: string,
  attemptNo: number,
  fn: (key: LogicalKey) => Promise<T | null>,
): Promise<T | null> {
  const row = await getTurnDispatchByDispatchId(dispatchId, attemptNo)
  if (!row) return null
  return fn(keyOf(row))
}

/** sink stageDurable 成功(running → sink_staged),dispatchId 键。 */
export function inboxSinkStagedByDispatch(
  dispatchId: string,
  attemptNo: number,
): Promise<TurnDispatchInboxRow | null> {
  return withRowByDispatch(dispatchId, attemptNo, (key) => inboxSinkStaged(key))
}

/** master ACK(→ terminal),dispatchId 键。 */
export function inboxTerminalByDispatch(
  dispatchId: string,
  attemptNo: number,
  status: 'completed' | 'interrupted' | 'crashed',
): Promise<TurnDispatchInboxRow | null> {
  return withRowByDispatch(dispatchId, attemptNo, (key) =>
    inboxTerminal(key, outcomeFromTapeStatus(status)),
  )
}

/** stageDurable I/O 失败(→ sink_stage_failed),dispatchId 键。 */
export function inboxSinkStageFailedByDispatch(
  dispatchId: string,
  attemptNo: number,
): Promise<TurnDispatchInboxRow | null> {
  return withRowByDispatch(dispatchId, attemptNo, (key) => inboxSinkStageFailed(key))
}

/**
 * M-R1-1(R3)— master ACK 落 inbox terminal 的**去重安全**收口。sink 同步(onAck)/ 延迟(onDispatchAck)
 * 两条回调共用,返回「终态是否确认」:确认 → 调用方删 durable entry;未确认 → **保留 entry** 退避重试。
 *
 * 铁律:CAS 返回 null **绝不**当成功删 entry。null 有两类:
 *   - 行已是目标 terminal(同 outcome,别人/上一轮先落)→ 幂等成功 true;
 *   - 行缺失 / 仍 queued / recovery_pending 外的非 from-state / sink_stage_failed / rejected / 异 outcome
 *     → false,保留 entry(否则「文件已删、行永停非终态」= sink_staged 永不收敛)。
 * 写抛异常由调用方 catch 归 false(同样保留 + 依赖周期 recovery)。
 */
export async function resolveInboxTerminalAck(
  dispatchId: string,
  attemptNo: number,
  status: 'completed' | 'interrupted' | 'crashed',
): Promise<boolean> {
  const applied = await inboxTerminalByDispatch(dispatchId, attemptNo, status)
  if (applied) return true
  // CAS 落空:回读行判幂等(唯一允许 true 的 null 分支)。
  const current = await getTurnDispatchByDispatchId(dispatchId, attemptNo)
  return current?.state === 'terminal' && current.outcome === outcomeFromTapeStatus(status)
}

// ---------------------------------------------------------------------------
// master 三态 tape 查询(RFC §3 契约;master agent 并行在建端点)
// ---------------------------------------------------------------------------

export type MasterTapeState = 'none' | 'partial' | 'finalized' | 'unreachable'

/** master finalized tape 的精确终态(M1:boot recovery 据此映射 inbox outcome,不再固定 completed)。 */
export type TapeStatus = 'completed' | 'interrupted' | 'crashed'

/**
 * master 三态查询结果。`tapeStatus` 仅 finalized 时可能带 —— 新 master 返回精确 status;
 * 旧 master(endpoint 未带 status)→ undefined,boot recovery 保守映射 completed(M1)。
 */
export interface MasterTapeStateResult {
  state: MasterTapeState
  tapeStatus?: TapeStatus
  /** Required when state=none; protects recovery while the master dispatch lease is live. */
  dispatchLeaseActive?: boolean
  /** Optional; true means master recorded process shutdown for this dispatch. */
  gatewayShutdownEvidence?: boolean
}

/** GET /internal/v3/turn-tape-state?dispatchId=&attemptNo= 契约客户端。 */
export const TURN_TAPE_STATE_PATH = '/internal/v3/turn-tape-state'

/**
 * 查询 master 该 dispatch 的 tape 终态。任何网络/非 2xx/畸形响应 → 'unreachable'
 * (fail-closed:绝不把不可达当作 'none' 去合成 crashed tape —— 那会覆盖真 tape)。
 * finalized 时透传 master 返回的精确 status(M1);缺失/非法 status → tapeStatus 省略。
 */
export async function queryMasterTapeState(
  dispatchId: string,
  attemptNo: number,
  deps?: { fetcher?: typeof undiciRequest; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<MasterTapeStateResult> {
  const cfg = readV3MasterSinkConfig(deps?.env ?? process.env)
  if (!cfg) return { state: 'unreachable' }
  const fetcher = deps?.fetcher ?? undiciRequest
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps?.timeoutMs ?? 10_000)
  try {
    const url =
      `${cfg.baseUrl}${TURN_TAPE_STATE_PATH}` +
      `?dispatchId=${encodeURIComponent(dispatchId)}&attemptNo=${encodeURIComponent(String(attemptNo))}`
    const res = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${cfg.bearer}` },
      signal: controller.signal,
    })
    if (res.statusCode < 200 || res.statusCode >= 300) return { state: 'unreachable' }
    let bodyText = ''
    for await (const chunk of res.body) {
      bodyText += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (bodyText.length > 64 * 1024) break
    }
    const parsed = JSON.parse(bodyText) as {
      state?: unknown
      status?: unknown
      dispatchLeaseActive?: unknown
      gatewayShutdownEvidence?: unknown
    }
    if (parsed.state === 'none') {
      // Rolling-safe capability handshake: a new gateway talking to an old
      // master must wait, not turn missing lease evidence into negative proof.
      if (typeof parsed.dispatchLeaseActive !== 'boolean') return { state: 'unreachable' }
      return {
        state: 'none',
        dispatchLeaseActive: parsed.dispatchLeaseActive,
        ...(parsed.gatewayShutdownEvidence === true ? { gatewayShutdownEvidence: true } : {}),
      }
    }
    if (parsed.state === 'partial') {
      return { state: 'partial' }
    }
    if (parsed.state === 'finalized') {
      const tapeStatus =
        parsed.status === 'completed' || parsed.status === 'interrupted' || parsed.status === 'crashed'
          ? parsed.status
          : undefined
      return { state: 'finalized', ...(tapeStatus ? { tapeStatus } : {}) }
    }
    return { state: 'unreachable' }
  } catch {
    return { state: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// boot recovery
// ---------------------------------------------------------------------------

/**
 * synthetic crashed tape 的**确定性** payload(RFC §3 none 分支)。
 *
 * 全部字段取自 inbox 持久化值(turn_key/request_id/created_at/turn_index/agent_id) ——
 * 多次恢复得到同 tapeId/hash(见 v3MasterSink.buildLosslessTurnTapeRequests)。
 * 严禁 Date.now():那会让每次重启生成异 hash tape。最小诚实错误记录。
 */
export function buildSyntheticCrashedTapePayload(row: TurnDispatchInboxRow): {
  agentId: string
  sessionId: string
  turnIndex: number
  clientMessageId: string
  status: 'crashed'
  turnKey?: string
  requestId?: string
  createdAt: number
  text: string
  errorCode: string
  errorDetail: string
  dispatchId: string
  attemptNo: number
} {
  return {
    agentId: row.agentId ?? 'main',
    sessionId: row.sessionId,
    turnIndex: row.turnIndex ?? 0,
    clientMessageId: row.clientMessageId,
    status: 'crashed',
    ...(row.turnKey ? { turnKey: row.turnKey } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    createdAt: row.createdAt,
    text: '',
    errorCode: 'SERVICE_RESTART',
    errorDetail: '任务因服务重启中断，此前已生成的过程已完整保留',
    dispatchId: row.dispatchId,
    attemptNo: row.attemptNo,
  }
}

// ---------------------------------------------------------------------------
// inbound bypass 的 method×path 契约(checkInboundBypass 复用)
// ---------------------------------------------------------------------------

/**
 * master→容器 internal 通道的 method 白名单:POST 为默认;GET **仅**放行
 * turn-dispatch-state(reconciler 只读求证,RFC §2.4/§3)。
 *
 * 共享 bypass 曾钉死 POST,durable 批新增 GET 端点后鉴权恒 401 —— §2.4 收敛链在
 * SSRF 网段错配之下还叠着这一层,两层都是"上线以来零次成功"的静默死链
 * (2026-07-19,SSRF 修通后才暴露)。新增 GET 端点必须在这里显式登记。
 */
export function isInboundBypassMethodAllowed(method: string, pathname: string): boolean {
  if (method === 'POST') return true
  return method === 'GET' && pathname === '/internal/v3/turn-dispatch-state'
}

// ---------------------------------------------------------------------------
// 活执行注册表(live dispatch registry)
// ---------------------------------------------------------------------------
//
// 恢复协议(§3)的全部推断都以「该行没有活着的执行方」为前提:boot 单飞时前提天然成立
// (新进程无在飞 turn),但 §B4 周期 sweep 复用同一协议跑在**活进程**里 —— 2026-07-19
// 事故:sweep tick 落在 turn 在飞窗(queued 等锁 / running 生成中、真 tape 未 stage),
// 走 none 分支把自己进程正在执行的 turn 合成 SERVICE_RESTART crashed(boss 实锤 8 秒
// 被枪毙)。因此:受理方在 INSERT queued **之前**登记活标记,执行链路 settle 后注销;
// recovery 对活标记行一律跳过。mark 先于行存在 ⇒ sweep 扫到的行若在飞必已带标记,无竞态窗。
// 进程死亡即注册表清零 → boot recovery 语义不变(孤儿照收)。

// 引用计数而非 Set:transport retry 可能让同一 dispatch 的重复帧与首达执行**并发**走
// 受理块(mark→查重→unmark),Set 语义下重复帧的 unmark 会误删首达执行中的保护。
const liveDispatchRefs = new Map<string, number>()

function liveKeyOf(dispatchId: string, attemptNo: number): string {
  return `${dispatchId}#${attemptNo}`
}

/** 受理方在 INSERT queued 前登记(引用 +1);每次 mark 必须配对一次 unmark。 */
export function markTurnDispatchLive(dispatchId: string, attemptNo: number): void {
  const key = liveKeyOf(dispatchId, attemptNo)
  liveDispatchRefs.set(key, (liveDispatchRefs.get(key) ?? 0) + 1)
}

/** 执行链路 settle / 受理早退口注销(引用 -1,归零移除);多余调用安全 no-op。 */
export function unmarkTurnDispatchLive(dispatchId: string, attemptNo: number): void {
  const key = liveKeyOf(dispatchId, attemptNo)
  const next = (liveDispatchRefs.get(key) ?? 0) - 1
  if (next <= 0) liveDispatchRefs.delete(key)
  else liveDispatchRefs.set(key, next)
}

/** recovery 跳活行用;也导出给测试断言注册表状态。 */
export function isTurnDispatchLive(dispatchId: string, attemptNo: number): boolean {
  return liveDispatchRefs.has(liveKeyOf(dispatchId, attemptNo))
}

export type DurableDispatchAdmissionResult = 'executed' | 'duplicate' | 'admit_failed'

/**
 * Production durable WS admission lifecycle.
 *
 * Ordering is part of the protocol: mark before INSERT, send the first receipt
 * immediately after a durable INSERT (before dispatch), and keep the live
 * reference until dispatch settles. A transport duplicate owns a separate
 * reference, so its early unmark cannot expose the original execution to the
 * periodic recovery sweep.
 */
export async function runDurableDispatchAdmission(input: {
  ctx: DispatchTurnContext
  sendReceipt: (row: TurnDispatchInboxRow | null) => void
  dispatch: () => Promise<void>
  onAdmitError?: (err: unknown) => void
  onOrphanRejectError?: (err: unknown) => void
}): Promise<DurableDispatchAdmissionResult> {
  const { ctx } = input
  markTurnDispatchLive(ctx.dispatchId, ctx.attemptNo)
  let admitted: Awaited<ReturnType<typeof admitTurnDispatch>>
  try {
    admitted = await admitTurnDispatch({ ctx })
  } catch (err) {
    unmarkTurnDispatchLive(ctx.dispatchId, ctx.attemptNo)
    input.onAdmitError?.(err)
    return 'admit_failed'
  }

  if (!admitted.inserted) {
    unmarkTurnDispatchLive(ctx.dispatchId, ctx.attemptNo)
    input.sendReceipt(admitted.row)
    return 'duplicate'
  }

  try {
    // B2: first durable acceptance is acknowledged before model dispatch so
    // the master can CAS admitted → accepted on a single transport delivery.
    input.sendReceipt(admitted.row)
    await input.dispatch()
  } finally {
    try {
      await inboxReject({
        userId: ctx.uid,
        sessionId: ctx.sessionId,
        clientMessageId: ctx.clientMessageId,
      })
    } catch (err) {
      input.onOrphanRejectError?.(err)
    } finally {
      unmarkTurnDispatchLive(ctx.dispatchId, ctx.attemptNo)
    }
  }
  return 'executed'
}

export interface BootRecoveryDeps {
  /** 本地 retry queue 是否已有该 dispatch/attempt 的 entry(①路径)。 */
  retryQueueHasDispatch: (dispatchId: string, attemptNo: number) => Promise<boolean>
  /** master 三态查询(②路径);finalized 时带精确 tapeStatus(M1)。 */
  queryMasterTapeState: (dispatchId: string, attemptNo: number) => Promise<MasterTapeStateResult>
  /** 构造并 stageDurable synthetic crashed tape(none 分支)。抛 → 记 sink_stage_failed。 */
  stageSyntheticCrashedTape: (row: TurnDispatchInboxRow) => Promise<void>
  /** manual/告警出口(partial 分支等)。 */
  onManualReconcile?: (row: TurnDispatchInboxRow, reason: string) => void
  /**
   * 该 dispatch 是否正被本进程活执行(受理→执行 settle 的全窗,含 queued 等锁)。
   * 活行一律跳过 —— 恢复推断只对无执行方的行成立。省略 = 全不活(boot 单飞语义)。
   */
  isDispatchLive?: (dispatchId: string, attemptNo: number) => boolean
  now?: () => number
}

export interface BootRecoveryStats {
  scanned: number
  rejected: number
  sinkStaged: number
  terminal: number
  sinkStageFailed: number
  recoveryPending: number
  /** 因活执行标记跳过的行数(周期 sweep 下 >0 属正常;boot 首跑恒 0)。 */
  liveSkipped: number
  /** master dispatch lease 仍活,none 分支延后 synthetic 的行数。 */
  leaseDeferred: number
}

/**
 * boot recovery 全协议(§3)。**在开放新 ingress 前单飞跑完**。
 *
 * 逐行确定性收敛,不可达一律保持 recovery_pending 重试(禁止推断)。返回统计供日志/healthz。
 */
export async function recoverTurnDispatchInboxOnBoot(
  deps: BootRecoveryDeps,
): Promise<BootRecoveryStats> {
  const stats: BootRecoveryStats = {
    scanned: 0,
    rejected: 0,
    sinkStaged: 0,
    terminal: 0,
    sinkStageFailed: 0,
    recoveryPending: 0,
    liveSkipped: 0,
    leaseDeferred: 0,
  }
  const now = deps.now ?? (() => Date.now())
  const rows = await scanOpenTurnDispatches()
  for (const row of rows) {
    stats.scanned++
    try {
      await recoverOneRow(row, deps, stats, now)
    } catch (err) {
      log.error(
        'turn dispatch boot recovery: row failed',
        { dispatchId: row.dispatchId, state: row.state },
        err,
      )
    }
  }
  log.info('turn dispatch boot recovery complete', { ...stats })
  return stats
}

async function recoverOneRow(
  row: TurnDispatchInboxRow,
  deps: BootRecoveryDeps,
  stats: BootRecoveryStats,
  now: () => number,
): Promise<void> {
  const key = keyOf(row)

  // 活执行行一律不碰(任何状态):恢复协议的孤儿推断只对无执行方的行成立。
  // 周期 sweep 撞上在飞 turn(queued 等锁 / running 生成中 / sink_staged 刚落)全走这里跳过;
  // boot 首跑注册表恒空,不改变 boot 语义。
  if (deps.isDispatchLive?.(row.dispatchId, row.attemptNo)) {
    stats.liveSkipped++
    return
  }

  // queued → rejected(not_accepted):受理过但从未进入执行(fsync 后 enqueue 前崩)。
  if (row.state === 'queued') {
    if (await inboxReject(key, now())) stats.rejected++
    return
  }

  // sink_staged:正常由 retry queue drain 驱动 terminal(onDispatchAck)。M-R1-1 ② 兜底:
  // 周期 sweep 查 master 三态 —— finalized 说明 tape 已完整落到 master(内容不丢),本地直接
  // 收敛 terminal(按精确 tapeStatus 映射 outcome),覆盖"entry 已丢/曾终态写失败但行永停
  // sink_staged"的历史残留。非 finalized(partial/none/unreachable)→ 保持 sink_staged 不动
  // (retry queue 仍在送 / fail-closed 禁把不可达当 none),绝不合成异 hash tape 或推断终态。
  if (row.state === 'sink_staged') {
    const result = await deps.queryMasterTapeState(row.dispatchId, row.attemptNo)
    if (result.state === 'finalized') {
      const outcome = outcomeFromTapeStatus(result.tapeStatus ?? 'completed')
      if (await inboxTerminal(key, outcome, now())) stats.terminal++
    }
    return
  }
  if (row.state === 'sink_stage_failed') {
    deps.onManualReconcile?.(row, 'sink_stage_failed_on_boot')
    return
  }

  // running / recovery_pending → 走恢复协议。running 先过渡到 recovery_pending(幂等)。
  if (row.state === 'running') {
    await inboxRecoveryPending(key, now())
  }

  // ① 本地 retry queue 有同 dispatch/attempt entry → tape 已 stage,补 sink_staged。
  if (await deps.retryQueueHasDispatch(row.dispatchId, row.attemptNo)) {
    if (await inboxSinkStaged(key, now())) stats.sinkStaged++
    return
  }

  // ② master 三态查询。
  const result = await deps.queryMasterTapeState(row.dispatchId, row.attemptNo)
  const state = result.state
  if (state === 'finalized') {
    // master 已收全 tape(内容不丢)→ 本地直接终态。M1:按 master 返回的精确 tapeStatus
    // 映射 outcome(completed/interrupted/crashed);旧 master 不带 status → 保守 completed。
    // 只收敛本地去重态,不覆盖 master 侧已 materialize 的内容。
    const outcome = outcomeFromTapeStatus(result.tapeStatus ?? 'completed')
    if (await inboxTerminal(key, outcome, now())) stats.terminal++
    return
  }
  if (state === 'partial') {
    // 部分 part 已上传但未 finalize:不生成异 hash tape(会与残留 part 冲突)→ manual。
    if (await inboxSinkStageFailed(key, now())) stats.sinkStageFailed++
    deps.onManualReconcile?.(row, 'partial_tape_on_boot')
    return
  }
  if (state === 'unreachable') {
    // 保持 recovery_pending 重试,禁止推断(fail-closed I2)。
    stats.recoveryPending++
    return
  }

  if (result.dispatchLeaseActive !== false && result.gatewayShutdownEvidence !== true) {
    // none + 活 lease:master 仍可能有一个刚受理/刚 accepted 的执行方,不能把
    // "尚无 tape"当作进程已死。缺字段同样 fail-closed(滚动期间老 master)。
    // 有停机证据时允许合成:accepted 租约本就不续,lease_until 残留不能挡 SERVICE_RESTART。
    stats.recoveryPending++
    if (result.dispatchLeaseActive === true) stats.leaseDeferred++
    return
  }

  // none:master 无任何 part → 构造确定性 synthetic crashed tape → stage → sink_staged。
  try {
    await deps.stageSyntheticCrashedTape(row)
    if (await inboxSinkStaged(key, now())) stats.sinkStaged++
  } catch (err) {
    log.error(
      'turn dispatch boot recovery: synthetic crashed tape stage failed',
      { dispatchId: row.dispatchId },
      err,
    )
    if (await inboxSinkStageFailed(key, now())) stats.sinkStageFailed++
    deps.onManualReconcile?.(row, 'synthetic_stage_failed')
  }
}

// ---------------------------------------------------------------------------
// reject-if-absent 端点核心 + state 查询(server.ts 端点复用)
// ---------------------------------------------------------------------------

export interface RejectIfAbsentResult {
  /** 本次是否新插了 rejected 墓碑(false = 已有行 / dispatch_id 撞了别的逻辑键)。 */
  inserted: boolean
  state: TurnDispatchInboxState | null
  outcome: TurnDispatchInboxOutcome | null
  /** MINOR ①:逻辑键不存在但 (dispatch_id, attempt_no) 撞了**别的**逻辑键(master 契约破坏)。
   *  为 true 时 inserted=false 且 state/outcome=null —— 调用方据此明确判"未插墓碑因身份冲突",
   *  绝不误当作"已落 negative proof"。 */
  conflict: boolean
}

/**
 * reject-if-absent(§3 端点 / reconciler rejecting 分支):有行返状态;无行插 rejected。
 * payloadHash 无从由 master 提供(它没有帧体)→ 用逻辑键即可;墓碑的 payload_hash 记空占位。
 *
 * MINOR ①:storage 层现在在 dispatch_id 撞别的逻辑键时返回 { inserted:false, row:null, conflict:true }
 * (不再谎报 inserted:true);这里把 conflict 透传出去供端点/reconciler 明确分流。
 */
export async function rejectTurnDispatchIfAbsent(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
  now?: number
}): Promise<RejectIfAbsentResult> {
  const res = await insertRejectedTombstoneIfAbsent({
    userId: input.userId,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    dispatchId: input.dispatchId,
    attemptNo: input.attemptNo,
    payloadHash: '',
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  return {
    inserted: res.inserted,
    state: res.row?.state ?? null,
    outcome: res.row?.outcome ?? null,
    conflict: res.conflict ?? false,
  }
}

export async function getTurnDispatchState(input: {
  userId: string
  sessionId: string
  clientMessageId: string
}): Promise<TurnDispatchInboxRow | null> {
  return getTurnDispatchByLogicalKey(input.userId, input.sessionId, input.clientMessageId)
}

export async function getTurnDispatchStateByDispatch(
  dispatchId: string,
  attemptNo: number,
): Promise<TurnDispatchInboxRow | null> {
  return getTurnDispatchByDispatchId(dispatchId, attemptNo)
}

export interface TurnDispatchStateResponse {
  found: boolean
  state: TurnDispatchInboxState | 'absent'
  outcome: TurnDispatchInboxOutcome | null
  dispatchId: string | null
  attemptNo: number | null
}

/**
 * B4(R3)— GET /internal/v3/turn-dispatch-state 的响应形状**单一权威**(纯函数,可断言)。
 * 行缺失(row===null)= 容器 durable inbox 无该 dispatch 的**权威 negative signal** → `state:'absent'`
 * (不是 `null`!)。master 侧 containerDispatchClient 据 'absent' 对 accepted 行走 manual_reconcile
 * (行消失 = 财务/执行归宿歧义);若回 `null`,client parseStateBody 解析失败误当 error 无限重试,
 * accepted 孤儿永不收敛。`found` 仍保留(true=行在)供调用方双保险。
 */
export function buildTurnDispatchStateResponse(
  row: TurnDispatchInboxRow | null,
): TurnDispatchStateResponse {
  return {
    found: row !== null,
    state: row?.state ?? 'absent',
    outcome: row?.outcome ?? null,
    dispatchId: row?.dispatchId ?? null,
    attemptNo: row?.attemptNo ?? null,
  }
}

// ---------------------------------------------------------------------------
// turn_dispatch_receipt 控制帧(§3.b)—— bridge 据此 CAS accepted 放下 lease
// ---------------------------------------------------------------------------

export interface TurnDispatchReceiptFrame {
  type: 'outbound.control.turn_dispatch_receipt'
  dispatchId: string
  attemptNo: number
  sessionId: string
  clientMessageId: string
  state: TurnDispatchInboxState | null
  outcome: TurnDispatchInboxOutcome | null
  ts: number
}

/**
 * B2:构造 turn_dispatch_receipt 控制帧。**首次受理(INSERT queued fsync 成功)后立即回发**,
 * bridge 收到 state='queued' 即 CAS dispatch accepted 并放下 lease;重复帧回发现有行状态。
 * 纯函数(ts 由调用方注入)→ 可断言帧形状,尤其"首次受理即 state=queued"。
 */
export function buildTurnDispatchReceiptFrame(
  ctx: Pick<DispatchTurnContext, 'dispatchId' | 'attemptNo' | 'sessionId' | 'clientMessageId'>,
  row: Pick<TurnDispatchInboxRow, 'state' | 'outcome'> | null | undefined,
  ts: number,
): TurnDispatchReceiptFrame {
  return {
    type: 'outbound.control.turn_dispatch_receipt',
    dispatchId: ctx.dispatchId,
    attemptNo: ctx.attemptNo,
    sessionId: ctx.sessionId,
    clientMessageId: ctx.clientMessageId,
    state: row?.state ?? null,
    outcome: row?.outcome ?? null,
    ts,
  }
}
