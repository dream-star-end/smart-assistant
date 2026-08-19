// 模型执行权威(model authority)—— master 签发 / 容器消费的**签名执行描述符**。
//
// 背景(docs/V5_MODEL_AUTHORITY_PLAN.md §2):v5 之前「哪个模型能跑、跑成什么样」的
// 判定散在三处(容器 baked 表 / master 常量 / DB pricing.enabled),master 与容器
// 各自判定 = 双信任源 + revision 漂移。本批次把判定单点化:**master 是唯一判定者**,
// 容器不再自己查表,而是消费 master 随每条 inbound 注入的签名 executionDescriptor。
//
// 信任模型 = **非对称**:
//   - master 独占 Ed25519 私钥(commercial/ws/authoritySigner.ts,与 bridge secret 同域落盘);
//   - supervisor 只向容器注入**公钥 keyring**(env,见 MODEL_AUTHORITY_KEYRING_ENV)。
//     公钥公开无妨 —— 同 uid 进程可读 /proc/*/environ 也伪造不出签名。这正是它优于
//     「裸 header + 共享 nonce」的地方(R3-M5:裸 header 同 uid 可伪造)。
//
// 本文件是**零运行时依赖的 leaf**(仅 node:crypto),被 master(签发)与容器 gateway
// (验签)共同 import —— 签名格式、规范编码、错误语义必须单一权威,任何一侧另抄一份
// 编码规则 = 签名互不认账。私钥逻辑**不在本文件**(master 独占)。

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

import type { PlatformReasoningEffort } from './engineModels.js'

// ---------------------------------------------------------------------------
// 常量(跨 master / gateway / supervisor / deploy 守卫的共享字面量)
// ---------------------------------------------------------------------------

/** 载荷版本。verify 只接受本版本;bump = 破坏性变更(需两侧同发版)。 */
export const MODEL_AUTHORITY_VERSION = 1 as const

/**
 * bridge 注入到 inbound.message 上的字段名。
 *
 * **一切入口先无条件 strip 同名字段**(方案 §2):bridge 先 strip 再注入;HTTP inbound /
 * cron / delegate / 本地 WS 只 strip 不注入 —— 客户端自带的同名字段必须永不被信任。
 * 收口成常量 = 任何入口漏 strip 都是一次 grep 可查的事实,而不是散落字面量。
 */
export const MODEL_AUTHORITY_FIELD = '__oc_model_authority'

/** supervisor 注入容器的**公钥 keyring** env 名(值格式见 encodeAuthorityKeyring)。 */
export const MODEL_AUTHORITY_KEYRING_ENV = 'OC_MODEL_AUTHORITY_KEYRING'

/**
 * 容器 hello attestation / egress 能力广播字符串(方案 §7 步 3/4 + R4-M2)。
 * bridge 对每条连接要求 `model_authority_v1`;开 flag 前另需 egress 侧 capability。
 */
export const MODEL_AUTHORITY_CAPABILITY = 'model_authority_v1'
export const MODEL_AUTHORITY_EGRESS_CAPABILITY = 'model_authority_v1-egress'

/**
 * authority envelope 有效期:**只约束「开始执行」**(gateway 首次单次消费),不是 turn 时长。
 * 长 turn 靠 turn lease(见下)存活;安全撤销靠每请求 epoch fence,不靠短 TTL。
 */
export const AUTHORITY_TTL_MS = 120_000

/**
 * turn lease 是 50min 的滚动签名窗口，不是 turn/delegate 总运行时长。
 * 活跃长 turn 在 30min 时续签；平台绝对安全上限由下方
 * AUTHORITY_TURN_MAX_LIFETIME_MS 单独定义。常量名为 wire 兼容保留。
 */
export const PLATFORM_MAX_TURN_MS = 45 * 60_000
export const TURN_LEASE_GRACE_MS = 5 * 60_000
export const TURN_LEASE_TTL_MS = PLATFORM_MAX_TURN_MS + TURN_LEASE_GRACE_MS

/**
 * bridge turn 的绝对寿命上限。lease 本身仍保持 50min 的短滚动窗口；活跃长任务由
 * master 在每次续签时把 `expiresAt` 向后滚动，但永远不能越过 durable journal 的
 * turn 起点加 `AUTHORITY_TURN_MAX_LIFETIME_MS`。gateway 对同一逻辑 turn 起点执行平台级
 * 安全终止；delegate 自身没有 45min 墙钟截止线。起点不进
 * lease wire，避免破坏仍在滚动运行的严格 v1 reader。
 */
export const AUTHORITY_TURN_MAX_LIFETIME_MS = 12 * 60 * 60_000

/** 首次续签时机。保留 20min 失败重试余量，不把瞬时 master 抖动变成用户故障。 */
export const TURN_LEASE_RENEW_AFTER_MS = 30 * 60_000

/** 签名域分离前缀 —— authority 与 lease 的签名字节前缀不同,签名不可跨类型复用。 */
const AUTHORITY_SIGNING_DOMAIN = 'oc-model-authority-v1'
const TURN_LEASE_SIGNING_DOMAIN = 'oc-turn-lease-v1'

/** envelope.kind —— 与签名域一一对应,verify 端按期望 kind 校验(跨类型 = BadShape)。 */
const AUTHORITY_KIND = 'model_authority'
const TURN_LEASE_KIND = 'turn_lease'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type ModelAuthorityEngine = 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode'

/**
 * 该模型的**完整规范化执行语义**(方案 §2 R2-B3):容器该 turn 的 engine/capability/
 * context/effort/vision **全部取自这里**,不查本地 catalog —— 自包含 = master 与容器
 * 对该 turn 物理同快照,revision 漂移问题被消解(而不是靠对账去发现漂移)。
 *
 * - `capabilityProfile`:DB `model_catalog.capability_profile` JSONB 原样投影
 *   (CCB spawn 的 capability override 从这里注入);
 * - `capabilitySchemaVersion`:未知版本消费侧 **fail-closed**(R2-m15)—— 容器见到
 *   高于自己认识的 schema version 必须拒帧,不得「尽力解析」;
 * - `supportedEfforts` / `codexDefaultEffort`:effort 判定唯一来源(codex 型号才有默认档)。
 */
export interface ModelExecutionDescriptor {
  readonly capabilityProfile: { readonly [key: string]: JsonValue }
  readonly capabilitySchemaVersion: number
  /** null = catalog 有意未声明；禁止用 0 伪装成一个真实窗口。 */
  readonly contextWindow: number | null
  readonly supportedEfforts: readonly PlatformReasoningEffort[]
  readonly codexDefaultEffort?: PlatformReasoningEffort
  readonly supportsVision: boolean
}

/**
 * 每条 forward 的 inbound 注入一份(bridge 签发)。
 *
 * 关键绑定字段:
 * - `authorityTurnId`:每 inbound 现铸(密码学随机),**不复用计费 requestId 的可选语义**;
 *   容器侧按 replay cache 单次消费(见 AuthorityReplayGuard);
 * - `connectionChallenge`(R4-m4):gateway 产生 challenge → hello attest → bridge 签入 →
 *   gateway 验证与**当前连接**一致 —— 连接关闭/gateway 重启后旧 envelope 天然失效;
 * - `securityEpoch`:容器侧维护「已见最大 epoch」,低于它 = 安全变更后的旧签名 → 拒;
 * - `billingRequestId?`:codex 的 server-owned requestId(绑定用,不是身份)。
 */
export interface ModelAuthorityPayload {
  readonly v: typeof MODEL_AUTHORITY_VERSION
  readonly keyId: string
  readonly uid: number
  readonly containerId: number
  readonly authorityTurnId: string
  readonly connectionChallenge: string
  readonly canonicalModel: string
  readonly engine: ModelAuthorityEngine
  readonly executionDescriptor: ModelExecutionDescriptor
  readonly executionRevision: string
  readonly securityEpoch: number
  readonly issuedAt: number
  readonly expiresAt: number
  /**
   * 该 turn 允许的**次级模型**(platform aux models)—— 主模型之外,容器还会用它们打上游。
   *
   * 为什么必须有(取证,2026-07-12):CCB 有一批**隐藏调用**不走主模型 ——
   * WebFetch 的 `queryHaiku`、WebSearch 的 `useHaiku` 分支、awaySummary、toolUseSummary、
   * claudeAiLimits,全部经 `getSmallFastModel()` → `ANTHROPIC_SMALL_FAST_MODEL` env。
   * v5 容器里这个 env 由 gateway `_buildSecondaryUtilityModelEnv()` 钉死为
   * `DEFAULT_SECONDARY_UTILITY_MODEL`(deepseek-v4-flash)。它们同样打 `/v1/messages`、
   * 同样经 anthropic proxy,但 `body.model ≠ canonicalModel` —— 只认单个 canonicalModel 的
   * 校验会把 WebFetch/WebSearch 全判死。
   *
   * 语义(**显式 + fail-closed**):放行集合 = `{canonicalModel} ∪ auxModels`,判定单点收口在
   * `isModelAllowedByAuthority`。集合外的 model → 拒。**缺席 = 空集**(= 只放行主模型),
   * 不是"任意"—— 老签发方(不填该字段)天然不放宽任何东西。
   *
   * 它进签名载荷(而不是让 egress 自己去猜一份"平台次级模型表"):次级模型集合是
   * **master 的判定结果**,与 canonicalModel 同源同快照同 epoch;容器改不了(改 = 验签失败),
   * egress 也不需要第二份权威表。计费不受影响:仍按 `body.model` 的真实价格行结算
   * (次级模型有自己的定价行),epoch fence 逐请求照跑。
   */
  readonly auxModels?: readonly string[]
  readonly billingRequestId?: string
}

/**
 * turn lease(R4-M1):turn 内**后续上游请求**的凭据,期限 = 最大 turn 窗口 + grace。
 *
 * 为什么不让 authority 自己长命:authority 的短 TTL 是「开始执行」的门(防 envelope 囤积
 * 重放);而长 turn(团队/delegate/compact/工具密集)会在 5min 后继续发上游请求,拿短 TTL
 * 的 authority 去认证必然误伤。拆成两张票据后:**开始执行**认 authority(单次消费),
 * **turn 内续跑**认 lease。
 *
 * lease 长 ≠ 放过撤销:**安全撤销不靠 lease 过期**,由 egress 每请求 epoch fence 保证
 * (方案 §4)—— lease 只证明「这个 turn 是 master 授权开的、绑死这些身份字段」。
 *
 * 字段是 authority 的严格子集(Codex R4-M1 明令绑定同一 uid/containerId/authorityTurnId/
 * canonicalModel/securityEpoch/connectionChallenge),消费侧必须用
 * assertLeaseMatchesAuthority 做交叉校验,不得只验签不对账。
 */
export interface TurnLease {
  readonly v: typeof MODEL_AUTHORITY_VERSION
  readonly keyId: string
  readonly uid: number
  readonly containerId: number
  readonly authorityTurnId: string
  readonly canonicalModel: string
  /**
   * 与 authority 同值(签发器同时铸两张票)。**必须**带:turn 内**后续**上游请求只带 lease
   * (authority 的短 TTL 只约束"开始执行"),而 WebFetch/WebSearch 恰恰多发生在 turn 中段 ——
   * lease 不带 auxModels = 长 turn 里的隐藏调用全挂。绑定对账见 assertLeaseMatchesAuthority。
   */
  readonly auxModels?: readonly string[]
  readonly securityEpoch: number
  readonly connectionChallenge: string
  /**
   * 一次未成功上线的滚动续签实验曾携带此字段。生产签发与续签必须省略它，
   * 以保持旧 v1 严格 reader 的字段集不变；master 从 durable journal 取绝对起点。
   * reader 只保留可选解析，用于把实验票保守收敛回旧 wire shape。
   */
  readonly originalIssuedAt?: number
  /** 本张 lease 的签发/续签时刻。 */
  readonly issuedAt: number
  readonly expiresAt: number
}

/** bridge 注入到 `__oc_model_authority` 的值:两张独立签名的票据。 */
export interface ModelAuthorityBundle {
  /** authority envelope(base64url),gateway 首次单次消费。 */
  readonly authority: string
  /** turn lease envelope(base64url),turn 内后续上游请求携带给 egress。 */
  readonly lease: string
}

export type ModelAuthorityErrorCode =
  /** 结构/类型/编码不合法(含 kind 不符、版本不符、非法 JSON、非法 UTF-16)。 */
  | 'BadShape'
  /** payload.keyId 不在 keyring 里(公钥未下发 / 已被轮换移除)。 */
  | 'UnknownKey'
  /** Ed25519 验签失败(伪造 / 任一字段被篡改)。 */
  | 'VerifyFail'
  /** expiresAt <= now。 */
  | 'Expired'
  /** lease 与 authority 的绑定字段不一致(仅 assertLeaseMatchesAuthority 抛)。 */
  | 'LeaseMismatch'

/** 结构化错误 —— 消费侧按 code 分流(拒帧 / 告警 / 触发 recycle),禁止靠 message 字符串判定。 */
export class ModelAuthorityError extends Error {
  readonly code: ModelAuthorityErrorCode

  constructor(code: ModelAuthorityErrorCode, message: string) {
    super(message)
    this.name = 'ModelAuthorityError'
    this.code = code
  }
}

/** keyId → Ed25519 raw 公钥(32 字节)。 */
export type AuthorityKeyring = ReadonlyMap<string, Uint8Array>

/**
 * **replay 防护契约**(R3-M10;实现体在容器 gateway 侧,本接口是双方共享的语义)。
 *
 * 语义(全部 fail-closed,任何一条被违反都等于放过重放):
 * 1. **单次消费**:同一 `authorityTurnId` 在活跃 TTL 内第二次出现 → `consume` 返回 false,
 *    调用方**拒帧**(不是忽略、不是覆盖)。
 * 2. **活跃条目绝不静默淘汰**:未过 expiresAt 的条目**不允许**因容量压力被 LRU 踢出 ——
 *    踢出 = 重放窗口。容量满且全为活跃条目 → `consume` **抛** ModelAuthorityError
 *    ('BadShape' 之外的资源类拒绝由实现方定义为拒新 authority)+ **critical 告警**,
 *    宁可拒服务也不放过重放。
 * 3. **绑连接**:条目 key 必须含 `connectionChallenge` —— 连接关闭/gateway 重启后
 *    challenge 变更,旧 envelope 天然失效(无需跨进程共享 cache)。
 * 4. 过期条目(expiresAt <= now)可安全清理 —— 它们已被 verify 的 Expired 门挡住。
 *
 * 测试必须覆盖:cache 满、gateway 重启后旧 envelope 重放(方案 §8)。
 */
export interface AuthorityReplayGuard {
  /**
   * 首次消费返回 true;活跃 TTL 内重复(同 challenge + 同 authorityTurnId)返回 false。
   * 容量满且无可清理的过期条目 → 抛(拒新 authority + 告警),**不得静默淘汰活跃条目**。
   */
  consume(connectionChallenge: string, authorityTurnId: string, expiresAt: number): boolean
}

// ---------------------------------------------------------------------------
// JCS(RFC 8785)规范 JSON 序列化
// ---------------------------------------------------------------------------

/**
 * JCS(RFC 8785)风格规范编码 —— **签名字节的唯一权威**。
 *
 * 为什么不用裸 JSON.stringify:键序取决于对象构造顺序,master 与容器(甚至 master 的两次
 * 构造)可能得到不同字节 → 验签随机失败;为什么不用「字符串拼接字段」:任何新增字段都要
 * 改两端拼接顺序,漏一处就是签名绕过面。JCS 给的是**由值决定的唯一字节串**。
 *
 * 规则(与 RFC 8785 一致):
 * - 对象键按 **UTF-16 code unit** 升序(JS 默认 `sort()` 即此语义);
 * - 无任何多余空白;
 * - 数字用 ECMAScript `Number::toString`(= `JSON.stringify(n)`),`-0` → `0`;
 *   NaN/Infinity → BadShape;
 * - 字符串用 ECMAScript JSON 转义(短转义 + 小写 `\u00xx` 控制符),UTF-8 输出;
 *   **孤立代理对**(lone surrogate)→ BadShape(RFC 8785 视为非法输入,不做「尽力编码」);
 * - `undefined` **属性**按 JSON 语义省略(对应可选字段缺席);数组内 `undefined`/函数/
 *   symbol/bigint → BadShape(拒绝把「不可表达」静默降级成 null)。
 */
export function canonicalizePayload(value: JsonValue): string {
  return canonicalizeValue(value, 0)
}

const MAX_CANONICAL_DEPTH = 64

function canonicalizeValue(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new ModelAuthorityError('BadShape', 'canonicalize: nesting too deep')
  }
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return canonicalizeNumber(value)
    case 'string':
      return canonicalizeString(value)
    case 'object':
      break
    default:
      throw new ModelAuthorityError(
        'BadShape',
        `canonicalize: unsupported value type ${typeof value}`,
      )
  }

  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (item === undefined) {
        throw new ModelAuthorityError('BadShape', 'canonicalize: undefined inside array')
      }
      parts.push(canonicalizeValue(item, depth + 1))
    }
    return `[${parts.join(',')}]`
  }

  // 纯数据对象:Date/Map/Set/Buffer 等一律拒(它们的 JSON 形态是隐式约定,不是规范编码)。
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new ModelAuthorityError('BadShape', 'canonicalize: non-plain object')
  }

  const record = value as Record<string, unknown>
  // RFC 8785:键按 UTF-16 code unit 排序。JS 默认 sort 的比较器正是 code unit 序。
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    const child = record[key]
    if (child === undefined) continue // JSON 语义:缺席 ≠ null
    parts.push(`${canonicalizeString(key)}:${canonicalizeValue(child, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}

function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new ModelAuthorityError('BadShape', `canonicalize: non-finite number ${String(n)}`)
  }
  // JSON.stringify 走的就是 ECMAScript Number::toString(最短往返表示),
  // 且 -0 序列化为 "0" —— 与 RFC 8785 §3.2.2.3 要求一致。
  return JSON.stringify(n)
}

/** 孤立代理:高代理后面不跟低代理,或低代理前面没有高代理。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function canonicalizeString(s: string): string {
  if (LONE_SURROGATE_RE.test(s)) {
    throw new ModelAuthorityError('BadShape', 'canonicalize: lone surrogate in string')
  }
  // ES2019 起 JSON.stringify 的字符串转义即 RFC 8785 要求的最小转义(短转义 + 小写 \u00xx)。
  return JSON.stringify(s)
}

// ---------------------------------------------------------------------------
// envelope 编解码 + 验签
// ---------------------------------------------------------------------------

interface Envelope {
  readonly v: number
  readonly kind: string
  readonly payload: unknown
  readonly sig: string
}

/** 签名字节 = domain ‖ '\n' ‖ JCS(payload) —— domain 前缀阻断 authority/lease 跨类型复用。 */
export function authoritySigningInput(payload: ModelAuthorityPayload): Buffer {
  return Buffer.from(
    `${AUTHORITY_SIGNING_DOMAIN}\n${canonicalizePayload(payload as unknown as JsonValue)}`,
    'utf8',
  )
}

export function turnLeaseSigningInput(lease: TurnLease): Buffer {
  return Buffer.from(
    `${TURN_LEASE_SIGNING_DOMAIN}\n${canonicalizePayload(lease as unknown as JsonValue)}`,
    'utf8',
  )
}

/** 打包 envelope(签发侧用;私钥逻辑在 commercial/ws/authoritySigner.ts)。 */
export function encodeAuthorityEnvelope(payload: ModelAuthorityPayload, sig: Uint8Array): string {
  return encodeEnvelope(AUTHORITY_KIND, payload as unknown as JsonValue, sig)
}

export function encodeTurnLeaseEnvelope(lease: TurnLease, sig: Uint8Array): string {
  return encodeEnvelope(TURN_LEASE_KIND, lease as unknown as JsonValue, sig)
}

/** 通用签名信封编码(dispatchAuthority 等兄弟票据复用)。 */
export function encodeEnvelope(kind: string, payload: JsonValue, sig: Uint8Array): string {
  const envelope = {
    v: MODEL_AUTHORITY_VERSION,
    kind,
    // payload 用 JCS 编码入 wire(不是必须 —— verify 会重新规范化 —— 但让 wire 字节
    // 也确定化,便于日志/对账逐字节比对)。
    payload,
    sig: Buffer.from(sig).toString('base64url'),
  }
  return Buffer.from(canonicalizePayload(envelope as unknown as JsonValue), 'utf8').toString(
    'base64url',
  )
}

/**
 * 验签 authority envelope。
 *
 * 顺序 = BadShape → UnknownKey → VerifyFail → Expired(先证明「这是 master 签的」,
 * 再谈时效 —— 反过来会把伪造签名报成 Expired,丢失告警语义)。
 *
 * **本函数只回答「这份 envelope 是 master 签的且未过期」**。以下必须由调用方(gateway)
 * 另行断言,不在这里:
 *   - authorityTurnId 未重放(AuthorityReplayGuard);
 *   - connectionChallenge == 当前连接的 challenge;
 *   - securityEpoch >= 本连接已见最大 epoch;
 *   - uid/containerId == 本容器身份;
 *   - descriptor.canonicalModel == frame.model(alias 归一后);
 *   - capabilitySchemaVersion <= 本容器支持的最高版本(未知版本 fail-closed)。
 */
export function verifyAuthority(
  envelopeB64: string,
  keyring: AuthorityKeyring,
  now: number,
): ModelAuthorityPayload {
  const { payload, sig } = decodeEnvelope(envelopeB64, AUTHORITY_KIND)
  const typed = parseAuthorityPayload(payload)
  verifySignature(authoritySigningInput(typed), sig, typed.keyId, keyring)
  assertNotExpired(typed.expiresAt, now)
  return typed
}

/** 验签 turn lease envelope(语义同上;绑定对账见 assertLeaseMatchesAuthority)。 */
export function verifyTurnLease(
  envelopeB64: string,
  keyring: AuthorityKeyring,
  now: number,
): TurnLease {
  const { payload, sig } = decodeEnvelope(envelopeB64, TURN_LEASE_KIND)
  const typed = parseTurnLease(payload)
  verifySignature(turnLeaseSigningInput(typed), sig, typed.keyId, keyring)
  assertLeaseTimeWindow(typed)
  assertNotExpired(typed.expiresAt, now)
  return typed
}

/** 只供实验票保守解析；生产绝对起点来自 master durable journal。 */
export function turnLeaseOriginalIssuedAt(lease: TurnLease): number {
  return lease.originalIssuedAt ?? lease.issuedAt
}

function assertLeaseTimeWindow(lease: TurnLease): void {
  const original = turnLeaseOriginalIssuedAt(lease)
  if (original > lease.issuedAt) {
    throw new ModelAuthorityError('BadShape', 'turn lease originalIssuedAt is after issuedAt')
  }
  if (lease.issuedAt >= lease.expiresAt) {
    throw new ModelAuthorityError('BadShape', 'turn lease issuedAt must be before expiresAt')
  }
  if (lease.expiresAt > original + AUTHORITY_TURN_MAX_LIFETIME_MS) {
    throw new ModelAuthorityError('BadShape', 'turn lease exceeds absolute turn lifetime')
  }
}

/**
 * lease ↔ authority 绑定对账(R4-M1 明令):任一绑定字段不一致 → LeaseMismatch。
 *
 * 为什么必须对账:两张票据各自签名有效,不代表它们属于同一个 turn。若不对账,持有
 * 「A turn 的长命 lease」+「B turn 的 authority」就能把 B 的执行挂到 A 的授权上 ——
 * 跨 turn/跨模型/跨 epoch 的降级攻击。keyId 不参与对账(轮换期新旧 keyId 并存,两张票据
 * 可能由不同 key 签发,这是合法的)。
 */
export function assertLeaseMatchesAuthority(
  lease: TurnLease,
  authority: ModelAuthorityPayload,
): void {
  const bindings: readonly ('uid' | 'containerId' | 'authorityTurnId' | 'canonicalModel' | 'securityEpoch' | 'connectionChallenge')[] = [
    'uid',
    'containerId',
    'authorityTurnId',
    'canonicalModel',
    'securityEpoch',
    'connectionChallenge',
  ]
  for (const field of bindings) {
    if (lease[field] !== authority[field]) {
      throw new ModelAuthorityError(
        'LeaseMismatch',
        `turn lease ${String(field)} mismatch: lease=${String(lease[field])} authority=${String(authority[field])}`,
      )
    }
  }
  // auxModels 也是**绑定字段**:两张票各自签名有效不代表放行集合相同。若不对账,持有
  // 「A turn 的宽 lease(含 aux X)」+「B turn 的 authority(不含 X)」就能在 B 的 turn 里
  // 把 X 打成合法请求 —— 与 canonicalModel 不对账是同一类降级攻击面(R4-M1 的推论)。
  // 顺序无语义(签发器已排序去重),故按集合比较,顺序不同不算漂移。
  if (!sameModelSet(lease.auxModels, authority.auxModels)) {
    throw new ModelAuthorityError(
      'LeaseMismatch',
      `turn lease auxModels mismatch: lease=[${(lease.auxModels ?? []).join(',')}] ` +
        `authority=[${(authority.auxModels ?? []).join(',')}]`,
    )
  }
}

function sameModelSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const l = [...new Set(a ?? [])].sort()
  const r = [...new Set(b ?? [])].sort()
  return l.length === r.length && l.every((v, i) => v === r[i])
}

/**
 * **放行集合判定的单一权威**(egress gate 与任何未来的消费侧共用)。
 *
 * 放行 ⟺ `canonicalModel ∈ {principal.canonicalModel} ∪ principal.auxModels`。
 * 入参 `canonicalModel` 必须是**已 alias 归一**的 id(egress 用本进程快照归一后再问)。
 * `auxModels` 缺席 = 空集 → 退化为"只放行主模型"(= 本字段引入前的行为,fail-closed)。
 */
export function isModelAllowedByAuthority(
  principal: Pick<ModelAuthorityPayload, 'canonicalModel' | 'auxModels'>,
  canonicalModel: string,
): boolean {
  if (principal.canonicalModel === canonicalModel) return true
  return (principal.auxModels ?? []).includes(canonicalModel)
}

/**
 * 无条件 strip `__oc_model_authority` —— **一切入口的第一动作**(方案 §2)。
 *
 * bridge:先 strip 再注入(客户端自带的必须先死);HTTP inbound / cron / delegate /
 * 本地 WS:只 strip(这些路径没有 envelope,走容器 catalog 本地判定)。
 */
export function stripModelAuthorityField(
  message: Record<string, unknown> | null | undefined,
): void {
  if (message && typeof message === 'object') {
    delete message[MODEL_AUTHORITY_FIELD]
  }
}

/** 通用签名信封解码(dispatchAuthority 等兄弟票据复用;kind 域隔离防跨票据混用)。 */
export function decodeEnvelope(
  envelopeB64: string,
  expectKind: string,
): { payload: unknown; sig: Buffer } {
  if (typeof envelopeB64 !== 'string' || envelopeB64 === '') {
    throw new ModelAuthorityError('BadShape', 'envelope: not a non-empty string')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(envelopeB64, 'base64url').toString('utf8'))
  } catch {
    throw new ModelAuthorityError('BadShape', 'envelope: undecodable base64url/JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelAuthorityError('BadShape', 'envelope: not an object')
  }
  const env = parsed as Partial<Envelope>
  if (env.v !== MODEL_AUTHORITY_VERSION) {
    throw new ModelAuthorityError('BadShape', `envelope: unsupported version ${String(env.v)}`)
  }
  if (env.kind !== expectKind) {
    throw new ModelAuthorityError(
      'BadShape',
      `envelope: kind mismatch (want ${expectKind}, got ${String(env.kind)})`,
    )
  }
  if (typeof env.sig !== 'string' || env.sig === '') {
    throw new ModelAuthorityError('BadShape', 'envelope: missing sig')
  }
  const sig = Buffer.from(env.sig, 'base64url')
  // Ed25519 签名恒 64 字节 —— 长度不对直接 BadShape,不喂给 verify。
  if (sig.length !== 64) {
    throw new ModelAuthorityError('BadShape', `envelope: bad sig length ${sig.length}`)
  }
  return { payload: env.payload, sig }
}

/** 通用 Ed25519 验签(keyring 域与 model authority 共用一套轮换语义)。 */
export function verifySignature(
  signingInput: Buffer,
  sig: Buffer,
  keyId: string,
  keyring: AuthorityKeyring,
): void {
  const raw = keyring.get(keyId)
  if (!raw) {
    throw new ModelAuthorityError('UnknownKey', `authority: unknown keyId ${keyId}`)
  }
  let ok: boolean
  try {
    ok = cryptoVerify(null, signingInput, publicKeyObject(raw), sig)
  } catch (e) {
    throw new ModelAuthorityError(
      'VerifyFail',
      `authority: verify threw (${(e as Error)?.message ?? String(e)})`,
    )
  }
  if (!ok) throw new ModelAuthorityError('VerifyFail', 'authority: signature verification failed')
}

export function assertNotExpired(expiresAt: number, now: number): void {
  if (!(expiresAt > now)) {
    throw new ModelAuthorityError('Expired', `authority: expired at ${expiresAt} (now=${now})`)
  }
}

// ---------------------------------------------------------------------------
// keyring 编解码(supervisor 注入 env ↔ 容器解析)
// ---------------------------------------------------------------------------

/**
 * keyring env 值格式:`keyId:pubRawBase64url` 以 `,` 连接(顺序无语义)。
 *
 * 例:`OC_MODEL_AUTHORITY_KEYRING=mak1_ab12…:Q0hB…,mak1_cd34…:X1RF…`
 *
 * 轮换五步(R3-M7)期间 ring 里**同时**存在新旧 keyId —— 两把公钥都能验通过是**要求**
 * (旧签名在 TTL 内仍有效),第五步才把旧公钥从 ring 移除,此后旧签名 → UnknownKey。
 */
export function encodeAuthorityKeyring(keyring: AuthorityKeyring): string {
  return [...keyring.entries()]
    .map(([keyId, raw]) => `${keyId}:${Buffer.from(raw).toString('base64url')}`)
    .join(',')
}

/**
 * ring 里的 keyId 集合(**字典序**)—— 轮换 census 的对账维度。
 *
 * 排序是语义的一部分:census 要回答「这条连接的容器认不认得 keyId X」,集合语义不该
 * 因 env 里的书写顺序而变。两侧(容器从 env ring / master 从落盘 ring)都过这个函数。
 */
export function keyringKeyIds(keyring: AuthorityKeyring): string[] {
  return [...keyring.keys()].sort()
}

/**
 * keyring 指纹 = sha256(规范串) 前 16 hex,规范串 = `keyId:pubB64u` 排序后逗号连接。
 *
 * 用途(R3-M7 轮换五步的步骤②「全容器 attest 新 keyId」):容器 hello attestation 上报
 * `keyIds` + 本指纹,master 的 census 据此统计「全部在连容器是否都已认得新公钥」。
 * **必须单一权威**:若容器与 master 各算一套(哪怕只是排序或分隔符不同),census 会
 * 永远显示「不覆盖」,轮换步骤②就永远 gate 不过 —— 所以放在 protocol 而不是各写各的。
 */
export function keyringFingerprint(keyring: AuthorityKeyring): string {
  const canon = [...keyring.entries()]
    .map(([keyId, raw]) => `${keyId}:${Buffer.from(raw).toString('base64url')}`)
    .sort()
    .join(',')
  return createHash('sha256').update(canon).digest('hex').slice(0, 16)
}

/** 解析 keyring env(容器侧 / 测试)。任何一项非法 → BadShape(fail-closed,不做部分解析)。 */
export function parseAuthorityKeyring(raw: string | undefined | null): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  if (!raw || raw.trim() === '') return out
  for (const item of raw.split(',')) {
    const trimmed = item.trim()
    if (trimmed === '') continue
    const sep = trimmed.indexOf(':')
    if (sep <= 0) {
      throw new ModelAuthorityError('BadShape', `keyring: malformed entry ${trimmed}`)
    }
    const keyId = trimmed.slice(0, sep)
    const key = Buffer.from(trimmed.slice(sep + 1), 'base64url')
    if (key.length !== 32) {
      throw new ModelAuthorityError(
        'BadShape',
        `keyring: bad ed25519 public key length ${key.length} for ${keyId}`,
      )
    }
    out.set(keyId, new Uint8Array(key))
  }
  return out
}

/** Ed25519 raw 32B 公钥 → KeyObject(JWK 路径,免手搓 DER)。 */
function publicKeyObject(raw: Uint8Array) {
  if (raw.length !== 32) {
    throw new ModelAuthorityError('BadShape', `keyring: bad public key length ${raw.length}`)
  }
  return createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(raw).toString('base64url'),
    },
    format: 'jwk',
  })
}

// ---------------------------------------------------------------------------
// 形状校验(验签**之前**执行:先证明它长得像载荷,才谈签名)
// ---------------------------------------------------------------------------

function parseAuthorityPayload(raw: unknown): ModelAuthorityPayload {
  const o = asObject(raw, 'payload')
  if (o.v !== MODEL_AUTHORITY_VERSION) {
    throw new ModelAuthorityError('BadShape', `payload: unsupported v ${String(o.v)}`)
  }
  const payload: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: str(o, 'keyId'),
    uid: int(o, 'uid'),
    containerId: int(o, 'containerId'),
    authorityTurnId: str(o, 'authorityTurnId'),
    connectionChallenge: str(o, 'connectionChallenge'),
    canonicalModel: str(o, 'canonicalModel'),
    engine: engine(o, 'engine'),
    executionDescriptor: parseDescriptor(o.executionDescriptor),
    executionRevision: str(o, 'executionRevision'),
    securityEpoch: int(o, 'securityEpoch'),
    issuedAt: int(o, 'issuedAt'),
    expiresAt: int(o, 'expiresAt'),
    ...(o.auxModels === undefined ? {} : { auxModels: modelList(o, 'auxModels') }),
    ...(o.billingRequestId === undefined ? {} : { billingRequestId: str(o, 'billingRequestId') }),
  }
  // 重建对象后必须与 wire 载荷**字段集完全一致**:多出的未知字段一律拒 —— 否则
  // 「签名覆盖 wire 全字段、验签只取已知字段」会让未知字段成为不被校验的携带面。
  assertNoExtraKeys(o, [
    'v',
    'keyId',
    'uid',
    'containerId',
    'authorityTurnId',
    'connectionChallenge',
    'canonicalModel',
    'engine',
    'executionDescriptor',
    'executionRevision',
    'securityEpoch',
    'issuedAt',
    'expiresAt',
    'auxModels',
    'billingRequestId',
  ])
  return payload
}

function parseTurnLease(raw: unknown): TurnLease {
  const o = asObject(raw, 'lease')
  if (o.v !== MODEL_AUTHORITY_VERSION) {
    throw new ModelAuthorityError('BadShape', `lease: unsupported v ${String(o.v)}`)
  }
  const lease: TurnLease = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: str(o, 'keyId'),
    uid: int(o, 'uid'),
    containerId: int(o, 'containerId'),
    authorityTurnId: str(o, 'authorityTurnId'),
    canonicalModel: str(o, 'canonicalModel'),
    ...(o.auxModels === undefined ? {} : { auxModels: modelList(o, 'auxModels') }),
    securityEpoch: int(o, 'securityEpoch'),
    connectionChallenge: str(o, 'connectionChallenge'),
    ...(o.originalIssuedAt === undefined
      ? {}
      : { originalIssuedAt: int(o, 'originalIssuedAt') }),
    issuedAt: int(o, 'issuedAt'),
    expiresAt: int(o, 'expiresAt'),
  }
  assertNoExtraKeys(o, [
    'v',
    'keyId',
    'uid',
    'containerId',
    'authorityTurnId',
    'canonicalModel',
    'auxModels',
    'securityEpoch',
    'connectionChallenge',
    'originalIssuedAt',
    'issuedAt',
    'expiresAt',
  ])
  return lease
}

function parseDescriptor(raw: unknown): ModelExecutionDescriptor {
  const o = asObject(raw, 'executionDescriptor')
  const profile = o.capabilityProfile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ModelAuthorityError('BadShape', 'descriptor: capabilityProfile not an object')
  }
  const efforts = o.supportedEfforts
  if (!Array.isArray(efforts) || efforts.some((e) => typeof e !== 'string')) {
    throw new ModelAuthorityError('BadShape', 'descriptor: supportedEfforts not a string[]')
  }
  if (typeof o.supportsVision !== 'boolean') {
    throw new ModelAuthorityError('BadShape', 'descriptor: supportsVision not a boolean')
  }
  if (o.codexDefaultEffort !== undefined && typeof o.codexDefaultEffort !== 'string') {
    throw new ModelAuthorityError('BadShape', 'descriptor: codexDefaultEffort not a string')
  }
  const descriptor: ModelExecutionDescriptor = {
    capabilityProfile: profile as { [key: string]: JsonValue },
    capabilitySchemaVersion: int(o, 'capabilitySchemaVersion'),
    contextWindow: o.contextWindow === null ? null : int(o, 'contextWindow'),
    supportedEfforts: efforts as PlatformReasoningEffort[],
    supportsVision: o.supportsVision,
    ...(o.codexDefaultEffort === undefined
      ? {}
      : { codexDefaultEffort: o.codexDefaultEffort as PlatformReasoningEffort }),
  }
  assertNoExtraKeys(o, [
    'capabilityProfile',
    'capabilitySchemaVersion',
    'contextWindow',
    'supportedEfforts',
    'codexDefaultEffort',
    'supportsVision',
  ])
  return descriptor
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelAuthorityError('BadShape', `${what}: not an object`)
  }
  return raw as Record<string, unknown>
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v === '') {
    throw new ModelAuthorityError('BadShape', `field ${key}: not a non-empty string`)
  }
  return v
}

function int(o: Record<string, unknown>, key: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new ModelAuthorityError('BadShape', `field ${key}: not a safe integer`)
  }
  return v
}

/**
 * model id 列表(auxModels)。fail-closed:非数组 / 含非字符串 / 含空串 / 含重复 → BadShape。
 * 重复也拒:签发器恒去重排序,wire 上出现重复 = 有人手改过载荷(签名当然过不了,但形状门
 * 先响亮地拒掉,免得把畸形载荷喂进集合判定)。
 */
function modelList(o: Record<string, unknown>, key: string): readonly string[] {
  const v = o[key]
  if (!Array.isArray(v)) {
    throw new ModelAuthorityError('BadShape', `field ${key}: not an array`)
  }
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string' || item === '') {
      throw new ModelAuthorityError('BadShape', `field ${key}: not a non-empty string[]`)
    }
    if (seen.has(item)) {
      throw new ModelAuthorityError('BadShape', `field ${key}: duplicate entry ${item}`)
    }
    seen.add(item)
  }
  return v as readonly string[]
}

function engine(o: Record<string, unknown>, key: string): ModelAuthorityEngine {
  const v = o[key]
  if (v !== 'ccb' && v !== 'codex' && v !== 'grok' && v !== 'cursor' && v !== 'zcode') {
    throw new ModelAuthorityError('BadShape', `field ${key}: unknown engine ${String(v)}`)
  }
  return v
}

function assertNoExtraKeys(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      throw new ModelAuthorityError('BadShape', `unexpected field ${key}`)
    }
  }
}
