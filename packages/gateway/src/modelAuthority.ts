/**
 * modelAuthority(容器侧)—— master 签发的**模型执行权威**的验签消费端。
 *
 * 方案:docs/V5_MODEL_AUTHORITY_PLAN.md §2 / §7。信任模型是**非对称**的:
 *
 *   master(私钥,commercial/ws/authoritySigner) --签名 envelope--> bridge 注入 inbound
 *       --> 本文件(只有公钥 keyring)验签 --> descriptor 驱动该 turn 的执行语义
 *
 * 为什么容器必须验签而不是「信 master 发来的 JSON」:容器里跑的是**用户的 AI**,与
 * gateway 同 uid。任何「裸 header / 明文字段」都能被同 uid 进程伪造(R3-M5)。公钥注入
 * 则无此问题 —— 读得到 /proc/self/environ 也签不出 Ed25519。
 *
 * ---------------------------------------------------------------------------
 * 职责边界(与 protocol/modelAuthority.ts 严格二分)
 *
 * protocol 的 `verifyAuthority` / `verifyTurnLease` **只回答**「这份 envelope 是 master
 * 签的且未过期」。以下断言全部在本文件(缺一条就是一个绕过面):
 *
 *   1. **replay 单次消费**(R3-M10):同 authorityTurnId 在活跃 TTL 内二次出现 → 拒;
 *      活跃条目**绝不静默淘汰**(踢出 = 重放窗口),容量满 → 拒新 authority + 告警;
 *   2. **connectionChallenge == 本连接**(R4-m4):challenge 由本进程每连接现铸,经
 *      attestation 帧告知 bridge,bridge 签进 payload。连接关闭 / gateway 重启后旧
 *      envelope 天然失效(无需跨进程共享 replay cache);
 *   3. **securityEpoch >= 本进程已见最大值**(单调):安全收窄后 master 会 bump epoch,
 *      旧签名(低 epoch)必须被拒 —— 否则「撤销授权」可被旧 envelope 回滚;
 *   4. **uid / containerId == 本容器身份**(env):跨容器/跨用户复用 envelope → 拒;
 *   5. **canonicalModel == frame.model**:descriptor 说 A、帧里跑 B = 计费与执行分裂;
 *   6. **capabilitySchemaVersion 已知**(R2-m15):高于本进程理解上限 → fail-closed 拒,
 *      不做「尽力解析」。
 *
 * ---------------------------------------------------------------------------
 * descriptor 的去向:**该 turn 的 engine / canonicalModel / effort 全部取自 descriptor**,
 * 不查本地 baked 表(server.ts resolveExecutionModel / engine/registry.resolveEngine 的
 * descriptor 覆盖入参)。master 与容器对该 turn 物理同快照 → revision 漂移问题消解。
 *
 * 无 descriptor 的本地路径(cron / synthetic / delegate / 个人版本地 WS)保持现状 baked
 * 判定 —— 切片 5 才换 catalog client,本切片一行不动。
 */

import { randomBytes } from 'node:crypto'

import {
  AUTHORITY_TTL_MS,
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_FIELD,
  MODEL_AUTHORITY_KEYRING_ENV,
  ModelAuthorityError,
  type AuthorityKeyring,
  type AuthorityReplayGuard,
  type ModelAuthorityEngine,
  type ModelAuthorityPayload,
  type ModelExecutionDescriptor,
  assertLeaseMatchesAuthority,
  keyringFingerprint,
  keyringKeyIds,
  parseAuthorityKeyring,
  stripModelAuthorityField,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'

export { MODEL_AUTHORITY_CAPABILITY, MODEL_AUTHORITY_FIELD, stripModelAuthorityField }

/**
 * 本进程能理解的 `capability_profile` schema 版本上限。
 *
 * **parity 契约**:必须与 master 侧 `commercial/billing/modelCatalog.CAPABILITY_SCHEMA_VERSION`
 * 同值。两侧各持一份常量是有意的 —— gateway 不允许 import commercial(容器不该看见计费/DB
 * 代码)。新增 profile 字段时**两处同 bump**;忘了 bump 的后果是安全的那一侧(容器见到更高
 * 版本 → fail-closed 拒帧),不会静默错跑。
 */
export const GATEWAY_CAPABILITY_SCHEMA_VERSION = 1

/** replay cache 默认容量(条)。活跃条目绝不淘汰,满 → 拒新 authority + 告警。 */
const DEFAULT_REPLAY_CAPACITY = 8192

/** 容器身份 env(v3supervisor 注入)。 */
const CONTAINER_ID_ENV = 'OC_CONTAINER_ID'
const USER_ID_ENV = 'OC_USER_ID'
/** 强制门 env:master flag 开启时由 supervisor 注入,容器侧同构 fail-closed。 */
const REQUIRE_AUTHORITY_ENV = 'OC_MODEL_AUTHORITY'

/**
 * flag 门的**单一权威**判定(`OC_MODEL_AUTHORITY=1`)。
 *
 * 两条路径同读这里:
 *   - bridge turn:inbound 必须带有效 authority(ModelAuthorityConsumer.required);
 *   - 本地路径(cron/synthetic/delegate/wechat/prewarm):判定源必须是 master 的 catalog
 *     投影(server.ts resolveLocalExecutionIfEnforced;registry.resolveEngine 的 requireAuthority 门)。
 *
 * 两者**不允许各自解释 flag** —— 半开状态(bridge 强制、本地仍 baked)正是本批要消灭的
 * 旁路形状:本地路径会继续用镜像里的 baked 表判 engine/可用性,与 catalog 漂移。
 * flag 未设 → 恒 false → 全部旧行为零变化(个人版 / 过渡期)。
 */
export function isModelAuthorityRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REQUIRE_AUTHORITY_ENV] === '1'
}

/**
 * selfhost 豁免门(`OC_SELFHOST_ENGINE_LOCAL_TURNS=1`,deploy-v5-selfhost 显式写入):
 * 允许 engine-reported 计费引擎(codex/grok/cursor)在**无 master 计费编排**的本地
 * turn(delegate / skill-eval / 无 envelope inbound)上执行。
 *
 * 语义与代价(单租户自用部署的知情选择):
 *   - 这些 turn 拿不到 bridge 铸造的 server-owned requestId,也不会有 preCheck /
 *     inflight journal / settle -> usage **不进 usage_records / credit_ledger 结算**;
 *     token 统计仍落 event/usage log(turn.completed)与 durable tape(engineBilling)。
 *   - 生产(claudeai.chat)**不设此 env** -> decideLocalExecution 的 DELEGATE_CODEX_UNSUPPORTED
 *     与 sessionManager 的 CODEX_BILLING_GUARD 维持原样 fail-closed,零行为变化。
 *   - 两处消费点(decideLocalExecution 真值表 / CODEX_BILLING_GUARD)同读本判定,
 *     不允许各自解释 -- 与 isModelAuthorityRequired 同构的单一权威。
 */
const SELFHOST_ENGINE_LOCAL_TURNS_ENV = 'OC_SELFHOST_ENGINE_LOCAL_TURNS'
export function isEngineLocalTurnExempt(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SELFHOST_ENGINE_LOCAL_TURNS_ENV] === '1'
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一个 turn 的执行权威(验签+全断言通过后的产物)。
 *
 * 这是容器侧该 turn 的**唯一执行语义来源**:engine / canonicalModel / effort /
 * capability / context 都在这里,不再回头查本地表。
 */
export interface TurnExecutionDescriptor {
  readonly canonicalModel: string
  readonly engine: ModelAuthorityEngine
  readonly contextWindow: number | null
  readonly supportsVision: boolean
  readonly supportedEfforts: readonly string[]
  readonly codexDefaultEffort?: string
  readonly capabilityProfile: Readonly<Record<string, unknown>>
  readonly capabilitySchemaVersion: number
  /** 审计/对账用(不参与判定;判定已被 descriptor 自包含消解)。 */
  readonly executionRevision: string
  readonly securityEpoch: number
  readonly authorityTurnId: string
  readonly billingRequestId?: string
  /**
   * 原样保留的两张 envelope —— **给 CCB proxy 请求绑定用**(方案 §4 / R3-M5)。
   *
   * 容器发往 egress 的每个 `/v1/messages` 必须携带**完整签名 envelope**(裸 header 同 uid
   * 可伪造),egress 侧 `http/proxy/modelAuthorityGate` 验签 + epoch fence。turn 内后续请求
   * 只带 lease 是合法的(lease TTL = 最大 turn 窗口 + grace),两张都在时交叉对账。
   *
   * 本切片只负责**把它们完好地带到 turn 上下文**;挂到出站 header 的接线属于 §4 那一刀。
   */
  readonly authorityEnvelope: string
  readonly leaseEnvelope: string
}

export type AuthorityRejectCode =
  /** 帧上没有 `__oc_model_authority`(且本进程要求必须有)。 */
  | 'missing'
  /** protocol 层拒(结构/版本/kind/签名/过期/lease 绑定不符)。 */
  | 'bad_shape'
  | 'unknown_key'
  | 'verify_fail'
  | 'expired'
  | 'lease_mismatch'
  /** authorityTurnId 在活跃 TTL 内重复出现。 */
  | 'replay'
  /** replay cache 满且全为活跃条目 —— 宁可拒服务也不放过重放(R3-M10)。 */
  | 'replay_cache_full'
  /** connectionChallenge != 本连接现铸值(跨连接复用 / gateway 重启后的旧 envelope)。 */
  | 'challenge_mismatch'
  /** securityEpoch < 本进程已见最大值(安全撤销后的旧签名回滚)。 */
  | 'epoch_regressed'
  /** uid / containerId != 本容器 env 身份。 */
  | 'identity_mismatch'
  /** descriptor.canonicalModel != frame.model。 */
  | 'model_mismatch'
  /** codex 的 server-owned requestId 未被签名 descriptor 同值绑定。 */
  | 'billing_request_mismatch'
  /** capabilitySchemaVersion > 本进程上限。 */
  | 'unknown_capability_version'
  /** 本进程没有 keyring / 容器身份 env —— 无法验签,fail-closed。 */
  | 'not_configured'

/** 结构化拒帧 —— 调用方按 code 分流(日志/告警/error 帧),禁止靠 message 判定。 */
export class AuthorityRejected extends Error {
  readonly code: AuthorityRejectCode

  constructor(code: AuthorityRejectCode, message: string) {
    super(message)
    this.name = 'AuthorityRejected'
    this.code = code
  }
}

/** 每条 bridge↔容器连接一份(challenge + 该连接的 replay 视图)。 */
export interface ConnectionAuthorityContext {
  readonly challenge: string
}

// ---------------------------------------------------------------------------
// replay cache
// ---------------------------------------------------------------------------

/**
 * `AuthorityReplayGuard` 实现(R3-M10 语义的**唯一**实现体)。
 *
 * 关键不变量:**活跃条目(未过 expiresAt)绝不因容量压力被淘汰**。常见的 LRU cache 在这里
 * 是错的 —— 攻击者只要用新 authority 灌满 cache,就能把某个还在有效期内的 authorityTurnId
 * 挤出去,然后重放它。所以容量满时的正确行为是**拒新 authority + 告警**(拒服务优于放过重放)。
 * 过期条目(verify 的 Expired 门已挡住它们)可以安全清理。
 */
export class AuthorityReplayCache implements AuthorityReplayGuard {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly capacity: number = DEFAULT_REPLAY_CAPACITY,
    private readonly onFull: (size: number) => void = () => {},
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.seen.size
  }

  consume(connectionChallenge: string, authorityTurnId: string, expiresAt: number): boolean {
    const now = this.clock()
    const key = `${connectionChallenge}\x00${authorityTurnId}`
    const prev = this.seen.get(key)
    if (prev !== undefined) {
      // 活跃期内重复 = 重放。**过期条目也不放行**:它已被 verify 的 Expired 门挡住,
      // 走到这里说明时钟/TTL 语义被破坏,保守拒。
      return false
    }
    if (this.seen.size >= this.capacity) {
      this.sweep(now)
      if (this.seen.size >= this.capacity) {
        this.onFull(this.seen.size)
        throw new AuthorityRejected(
          'replay_cache_full',
          `authority replay cache full (${this.seen.size}/${this.capacity}) — refusing new authority`,
        )
      }
    }
    this.seen.set(key, expiresAt)
    return true
  }

  /** 只清过期条目(活跃条目永不清)。 */
  private sweep(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key)
    }
  }

  /** 连接关闭时丢弃该连接的条目(challenge 已换,留着也无意义)。 */
  dropConnection(connectionChallenge: string): void {
    const prefix = `${connectionChallenge}\x00`
    for (const key of this.seen.keys()) {
      if (key.startsWith(prefix)) this.seen.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// descriptor 的 turn 级挂载(WeakMap,**不是** frame 上的私有字段)
// ---------------------------------------------------------------------------

/**
 * frame → descriptor 的旁路挂载。
 *
 * **为什么必须是 WeakMap 而不是 `frame._modelAuthority`**:inbound frame 是 `JSON.parse`
 * 出来的用户输入。任何写在 frame 上的属性(哪怕带下划线前缀)都可以被客户端在 wire 上
 * 伪造出来 —— 除非每个入口都记得覆写/删除它。WeakMap 的 key 是**对象引用**,wire 上
 * 根本无法表达,伪造面为 0。签名字段 `__oc_model_authority` 本身则在每个入口被无条件 strip。
 */
const authorityByFrame = new WeakMap<object, TurnExecutionDescriptor>()

export function attachTurnAuthority(frame: object, descriptor: TurnExecutionDescriptor): void {
  authorityByFrame.set(frame, descriptor)
}

/** 该 frame 的执行权威(无 = 本地路径 / flag 未开 → 调用方回落 baked 判定)。 */
export function getTurnAuthority(frame: object | null | undefined): TurnExecutionDescriptor | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  return authorityByFrame.get(frame)
}

// ---------------------------------------------------------------------------
// consumer
// ---------------------------------------------------------------------------

export interface ModelAuthorityConsumerOpts {
  keyring: AuthorityKeyring
  /** 本容器身份(agent_containers.id)。缺省 → 无法断言 identity → 不 attest。 */
  containerId?: number
  /** 本容器归属 uid。缺省 → 不 attest。 */
  uid?: number
  /** flag:要求 bridge 连接的每条 inbound.message 必须带有效 authority。 */
  required?: boolean
  replayCapacity?: number
  clock?: () => number
  onAlert?: (event: string, fields: Record<string, unknown>) => void
}

/**
 * 容器侧验签消费器(Gateway 持一个实例)。
 *
 * epoch 单调水位是**进程级**而非连接级:安全撤销后 master bump epoch,任何一条连接见过
 * 新 epoch,其余连接就不该再接受旧 epoch 的签名(否则换条连接就能回滚撤销)。
 */
export class ModelAuthorityConsumer {
  private readonly keyring: AuthorityKeyring
  private readonly containerId?: number
  private readonly uid?: number
  private readonly replay: AuthorityReplayCache
  private readonly clock: () => number
  private readonly onAlert: (event: string, fields: Record<string, unknown>) => void
  /** 已见最大 securityEpoch(单调不降)。 */
  private maxSeenEpoch = -1

  readonly required: boolean

  constructor(opts: ModelAuthorityConsumerOpts) {
    this.keyring = opts.keyring
    this.containerId = opts.containerId
    this.uid = opts.uid
    this.required = opts.required === true
    this.clock = opts.clock ?? (() => Date.now())
    this.onAlert = opts.onAlert ?? (() => {})
    this.replay = new AuthorityReplayCache(
      opts.replayCapacity ?? DEFAULT_REPLAY_CAPACITY,
      (size) => this.onAlert('model_authority.replay_cache_full', { size }),
      this.clock,
    )
  }

  /**
   * 从容器 env 构造。
   *
   * keyring env 畸形 → **空 ring**(protocol parseAuthorityKeyring 抛 → 这里吞成空)。
   * 空 ring = 不 attest = bridge 侧(flag 开)拒该连接 + recycle —— 正是我们要的 fail-closed:
   * 一个验不了签的容器不该假装自己能验。
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    onAlert?: (event: string, fields: Record<string, unknown>) => void,
  ): ModelAuthorityConsumer {
    let keyring: AuthorityKeyring = new Map()
    try {
      keyring = parseAuthorityKeyring(env[MODEL_AUTHORITY_KEYRING_ENV])
    } catch (err) {
      onAlert?.('model_authority.keyring_invalid', {
        err: (err as Error)?.message ?? String(err),
      })
    }
    return new ModelAuthorityConsumer({
      keyring,
      containerId: parsePositiveInt(env[CONTAINER_ID_ENV]),
      uid: parsePositiveInt(env[USER_ID_ENV]),
      required: isModelAuthorityRequired(env),
      onAlert,
    })
  }

  /**
   * 本容器是否**真的能**消费 authority(有公钥 + 有身份)。
   *
   * attestation 只在 enabled 时广播 `model_authority_v1` —— capability 的语义是「我能验签」,
   * 不是「我这版代码里有验签代码」。旧 env 的容器(有新代码、无 keyring)因此不会骗到 bridge,
   * 会被 flag 开启后的 attestation 门拒 + recycle,拿到新 env 重建。
   */
  get enabled(): boolean {
    return this.keyring.size > 0 && this.containerId !== undefined && this.uid !== undefined
  }

  /** hello attestation 广播的 capability 列表(不 enabled → 空数组)。 */
  capabilities(): string[] {
    return this.enabled ? [MODEL_AUTHORITY_CAPABILITY] : []
  }

  /**
   * 本容器 env ring 里的 keyId(字典序)—— attestation 上报,master 侧 census 统计覆盖。
   *
   * **为什么容器必须自报 keyId**(R3-M7 轮换五步的步骤②):master 切私钥(步③)之前
   * 必须确证「全部在跑容器都已经拿到新公钥」。整改前 attestation 只广播一个 capability
   * 字符串,master 无从知道容器 ring 里到底有哪几把钥匙 —— 步骤② 只能靠目测,切早了就是
   * 全站 UnknownKey 拒帧。keyId 是公钥派生的公开标识,上报它不泄漏任何秘密。
   */
  keyIds(): string[] {
    return keyringKeyIds(this.keyring)
  }

  /** 本容器 ring 的指纹(与 master 侧 `AuthoritySigner.fingerprint()` 同源:protocol 实现)。 */
  keyringFingerprint(): string {
    return keyringFingerprint(this.keyring)
  }

  /** 每条 bridge 连接现铸一个 challenge(128 bit CSPRNG)。 */
  newConnection(): ConnectionAuthorityContext {
    return { challenge: randomBytes(16).toString('hex') }
  }

  /** 连接关闭 → 丢弃该连接的 replay 条目。 */
  closeConnection(conn: ConnectionAuthorityContext): void {
    this.replay.dropConnection(conn.challenge)
  }

  /** 诊断用。 */
  get replaySize(): number {
    return this.replay.size
  }

  /**
   * 消费一条 inbound.message 的 authority bundle。
   *
   * @param frame  原始 inbound frame(**调用方必须在本函数返回后 strip 掉 wire 字段**;
   *               本函数只读不改,strip 由入口统一负责,见 server.ts)
   * @returns descriptor(该 turn 的执行权威)
   * @throws  AuthorityRejected —— 一切失败都是拒帧,没有「降级放行」
   */
  consume(
    frame: Record<string, unknown>,
    conn: ConnectionAuthorityContext,
    now: number = this.clock(),
  ): TurnExecutionDescriptor {
    if (!this.enabled) {
      throw new AuthorityRejected(
        'not_configured',
        'model authority not configured (missing keyring / container identity env)',
      )
    }
    const raw = frame[MODEL_AUTHORITY_FIELD]
    if (raw === undefined || raw === null) {
      throw new AuthorityRejected('missing', 'inbound frame carries no model authority')
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AuthorityRejected('bad_shape', 'model authority field is not an object')
    }
    const bundle = raw as { authority?: unknown; lease?: unknown }
    if (typeof bundle.authority !== 'string' || typeof bundle.lease !== 'string') {
      throw new AuthorityRejected('bad_shape', 'model authority bundle missing authority/lease')
    }

    let payload: ModelAuthorityPayload
    try {
      payload = verifyAuthority(bundle.authority, this.keyring, now)
      const lease = verifyTurnLease(bundle.lease, this.keyring, now)
      assertLeaseMatchesAuthority(lease, payload)
    } catch (err) {
      throw toRejection(err)
    }

    // ── gateway 侧断言全集(protocol 明确不管这些)────────────────────────────
    // 顺序:身份 → 连接 → epoch → model → capability → replay。
    // replay **放最后**:前面任一条不过就不该消耗 replay 槽位(否则伪造帧可以拿
    // 合法 authorityTurnId 去「烧掉」它,把真帧变成重放 → 拒服务)。
    if (payload.uid !== this.uid || payload.containerId !== this.containerId) {
      throw new AuthorityRejected(
        'identity_mismatch',
        `authority identity mismatch: payload uid=${payload.uid} cid=${payload.containerId} ` +
          `container uid=${this.uid} cid=${this.containerId}`,
      )
    }
    if (payload.connectionChallenge !== conn.challenge) {
      throw new AuthorityRejected(
        'challenge_mismatch',
        'authority connectionChallenge does not match this connection',
      )
    }
    if (payload.securityEpoch < this.maxSeenEpoch) {
      throw new AuthorityRejected(
        'epoch_regressed',
        `authority securityEpoch ${payload.securityEpoch} < highest seen ${this.maxSeenEpoch}`,
      )
    }
    const frameModel = typeof frame.model === 'string' ? frame.model : undefined
    if (frameModel !== payload.canonicalModel) {
      // bridge 在注入 authority 时**必定**把 frame.model 归一成 canonicalModel;
      // 不一致 = 有人在 master 之后改了帧,或 bridge 漏了归一 —— 两者都必须响亮地拒。
      throw new AuthorityRejected(
        'model_mismatch',
        `frame.model=${String(frameModel)} != authority.canonicalModel=${payload.canonicalModel}`,
      )
    }
    if (payload.engine === 'codex' || payload.engine === 'grok' || payload.engine === 'cursor' || payload.engine === 'zcode') {
      const frameRequestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
      if (
        typeof payload.billingRequestId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(payload.billingRequestId) ||
        frameRequestId !== payload.billingRequestId
      ) {
        throw new AuthorityRejected(
          'billing_request_mismatch',
          'engine-reported authority billingRequestId does not match frame.requestId',
        )
      }
    }
    const descriptorRaw: ModelExecutionDescriptor = payload.executionDescriptor
    if (descriptorRaw.capabilitySchemaVersion > GATEWAY_CAPABILITY_SCHEMA_VERSION) {
      throw new AuthorityRejected(
        'unknown_capability_version',
        `capability_schema_version=${descriptorRaw.capabilitySchemaVersion} > supported ` +
          `${GATEWAY_CAPABILITY_SCHEMA_VERSION} — fail-closed`,
      )
    }
    if (payload.engine === 'ccb') {
      const ccb = descriptorRaw.capabilityProfile.ccb as Record<string, unknown> | undefined
      if (
        !ccb ||
        typeof ccb !== 'object' ||
        typeof ccb.capabilityZero !== 'boolean' ||
        typeof ccb.supportsThinking !== 'boolean'
      ) {
        throw new AuthorityRejected(
          'bad_shape',
          'CCB execution descriptor missing capabilityZero/supportsThinking',
        )
      }
    }

    // 单次消费(cache 满 → AuthorityRejected('replay_cache_full') 已在 cache 内抛)。
    if (!this.replay.consume(conn.challenge, payload.authorityTurnId, payload.expiresAt)) {
      throw new AuthorityRejected(
        'replay',
        `authorityTurnId ${payload.authorityTurnId} already consumed on this connection`,
      )
    }

    // 单调水位只在**全部断言通过后**抬 —— 否则一条伪造的高 epoch 帧就能把水位顶上去,
    // 把后续所有合法帧全部判成 epoch_regressed(自伤式 DoS)。
    if (payload.securityEpoch > this.maxSeenEpoch) {
      this.maxSeenEpoch = payload.securityEpoch
    }

    return {
      canonicalModel: payload.canonicalModel,
      engine: payload.engine,
      contextWindow: descriptorRaw.contextWindow,
      supportsVision: descriptorRaw.supportsVision,
      supportedEfforts: descriptorRaw.supportedEfforts,
      ...(descriptorRaw.codexDefaultEffort === undefined
        ? {}
        : { codexDefaultEffort: descriptorRaw.codexDefaultEffort }),
      capabilityProfile: descriptorRaw.capabilityProfile as Readonly<Record<string, unknown>>,
      capabilitySchemaVersion: descriptorRaw.capabilitySchemaVersion,
      executionRevision: payload.executionRevision,
      securityEpoch: payload.securityEpoch,
      authorityTurnId: payload.authorityTurnId,
      ...(payload.billingRequestId === undefined
        ? {}
        : { billingRequestId: payload.billingRequestId }),
      authorityEnvelope: bundle.authority,
      leaseEnvelope: bundle.lease,
    }
  }
}

/** protocol ModelAuthorityError → gateway 拒帧码(不认识的错一律 bad_shape,fail-closed)。 */
function toRejection(err: unknown): AuthorityRejected {
  if (err instanceof AuthorityRejected) return err
  if (err instanceof ModelAuthorityError) {
    switch (err.code) {
      case 'UnknownKey':
        return new AuthorityRejected('unknown_key', err.message)
      case 'VerifyFail':
        return new AuthorityRejected('verify_fail', err.message)
      case 'Expired':
        return new AuthorityRejected('expired', err.message)
      case 'LeaseMismatch':
        return new AuthorityRejected('lease_mismatch', err.message)
      default:
        // 'BadShape' + 任何未来新增的 code → bad_shape(fail-closed:不认识的错也是拒)
        return new AuthorityRejected('bad_shape', err.message)
    }
  }
  return new AuthorityRejected('bad_shape', (err as Error)?.message ?? String(err))
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw.trim())) return undefined
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) ? n : undefined
}

/** 容器 attestation 帧的 type(bridge 拦截消费,**绝不**透传给浏览器)。 */
export const CONTAINER_ATTEST_FRAME_TYPE = 'outbound.control.container_attest'

/** attestation 帧形状(bridge 侧同构解析;两侧各自持有,由测试锁 parity)。 */
export interface ContainerAttestFrame {
  type: typeof CONTAINER_ATTEST_FRAME_TYPE
  capabilities: string[]
  connectionChallenge: string
  containerId: number | null
  /** authority TTL,供 bridge 观测(不参与判定)。 */
  authorityTtlMs: number
  /**
   * 本容器 env keyring 的 keyId 集合(字典序)+ 指纹 —— **轮换五步步骤② 的数据源**。
   *
   * master 的 census(commercial/ws/authorityKeyCensus.ts)按连接汇总这两个字段,回答
   * 「全部在跑容器是否都已认得新公钥」;为 true 才允许切私钥(步③)。
   * 公钥/keyId 都是公开材料,上报不泄漏秘密。
   *
   * bridge 侧对**缺席**这两个字段的旧容器按 `keyIdsUnknown` 记账,覆盖判定一律算"不覆盖"
   * (fail-closed:不知道 ≠ 认得)。
   */
  keyIds: string[]
  keyringFingerprint: string
}

export function buildContainerAttestFrame(
  consumer: ModelAuthorityConsumer,
  conn: ConnectionAuthorityContext,
  containerId: number | null,
): ContainerAttestFrame {
  return {
    type: CONTAINER_ATTEST_FRAME_TYPE,
    capabilities: consumer.capabilities(),
    connectionChallenge: conn.challenge,
    containerId,
    authorityTtlMs: AUTHORITY_TTL_MS,
    keyIds: consumer.keyIds(),
    keyringFingerprint: consumer.keyringFingerprint(),
  }
}
