/**
 * T-32 — 账号池调度器。
 *
 * v3 0064(2026-05-13)起改用 **Weighted Rendezvous Hashing (WRH)** 单一算法:
 *
 *   - sessionId 存在 → 同 key + 同候选 + 同 weight 选同账号(强 sticky)
 *     候选上下线或 weight 变化只导致 O(Δ/总和) 比例的 session 迁移
 *     (Thaler-Ravishankar HRW 性质,见 https://en.wikipedia.org/wiki/Rendezvous_hashing)
 *   - sessionId 缺失 → 用一次性 random key 退化为加权随机 (历史 chat 模式行为)
 *
 *   `mode` 字段保留只作为 metric label(`scheduler_pick{mode=chat|agent}`),
 *   行为不分支 —— 简化 future readers 心智负担。
 *
 *   权重 = max(1, health_score) * f_quota(5h) * f_quota(7d) * f_subscription
 *   各因子 NULL 输入返回中性 1.0(详见 computeAccountWeight 注释)。
 *
 * 错误语义:
 *   - 无 active 账号 / 全 cooldown / 全 vanished → AccountPoolUnavailableError(503)
 *   - 所有 active 到达 per-account in-flight 上限 → AccountPoolBusyError(429)
 *
 * release 语义:
 *   - `success` → `health.onSuccess(id)` 恢复健康度
 *   - `failure` → `health.onFailure(id, msg)` 扣分;触发 3 连败熔断
 *
 * 非职责:
 *   - 本模块不关心 token 刷新(T-33)、不关心扣费(T-22)、不决定用哪个模型。
 *   - 本模块只做 "从 active 池子挑一个 account" 这一件事。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { AeadError } from '../crypto/aead.js'
import { loadKmsKey } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import type { AccountHealthTracker } from './health.js'
import {
  ACCOUNT_KINDS,
  type AccountKind,
  type AccountPlan,
  type AccountProvider,
  getTokenForUse,
  updateAccount,
} from './store.js'

export const ERR_ACCOUNT_POOL_UNAVAILABLE = 'ERR_ACCOUNT_POOL_UNAVAILABLE'
export const ERR_ACCOUNT_POOL_BUSY = 'ERR_ACCOUNT_POOL_BUSY'
export const ERR_CONTAINER_STALE_BINDING = 'ERR_CONTAINER_STALE_BINDING'

export class AccountPoolUnavailableError extends Error {
  readonly code = ERR_ACCOUNT_POOL_UNAVAILABLE
  constructor(reason: string) {
    super(`account pool unavailable: ${reason}`)
    this.name = 'AccountPoolUnavailableError'
  }
}

/**
 * 所有 active 账号都到达 per-account in-flight 并发上限时抛出。
 *
 * 和 `AccountPoolUnavailableError`(无 active / 全 cooldown / 全 vanished)区分:
 *   - Unavailable → 503(池子确实不可用,需要运维介入)
 *   - Busy        → 429 + Retry-After(瞬时过载,前端 retry 即可)
 */
export class AccountPoolBusyError extends Error {
  readonly code = ERR_ACCOUNT_POOL_BUSY
  constructor(reason: string) {
    super(`account pool busy: ${reason}`)
    this.name = 'AccountPoolBusyError'
  }
}

/**
 * 容器 codex_account_id IS NULL(legacy 绑定)且池子里有 active codex 账号时抛出。
 *
 * 背景:plan v3 K/L invariant — docker bind mount 在 startup 时固定;
 * NULL 绑定的容器永远 mount 共享 root(`<codexContainerDir>/auth.json`),
 * 不读 per-container subdir。v3 commercial 没有 master writer 维护这个共享
 * auth.json,所以 NULL 容器在池子有账号时仍然 401。
 *
 * 解法是把容器标 vanished + docker rm,让用户下条 message 触发 ensureRunning
 * 重 provision,picker 走 active 账号路径产出 per-container mount → 正常工作。
 *
 * 该错误由 `codexBinding.acquire` 在判定 stale 后抛出,bridge 应捕获并:
 *   - 给前端发 CODEX_CONTAINER_RECYCLED error frame
 *   - 关掉本次 ws 连接
 *   - 不释放任何 slot / inflight(因为本 turn 还没占任何资源)
 */
export class ContainerStaleBindingError extends Error {
  readonly code = ERR_CONTAINER_STALE_BINDING
  readonly containerId: number
  constructor(containerId: number) {
    super(`container ${containerId} codex binding stale (NULL bind + non-empty pool); recycled`)
    this.name = 'ContainerStaleBindingError'
    this.containerId = containerId
  }
}

/** 单账号同时 in-flight 请求默认上限。防止单账号被 Anthropic 风控。 */
export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 10

/**
 * 解析 `CLAUDE_ACCOUNT_MAX_CONCURRENT` 环境变量。
 *
 * 严格语义:只接受纯正整数字符串(如 `"10"`);`"10xyz"` / `"0"` / `"-1"` /
 * `"1.5"` / `"abc"` / 空 均退回默认 10。
 */
export function parseMaxConcurrentEnv(
  raw: string | undefined = process.env.CLAUDE_ACCOUNT_MAX_CONCURRENT,
): number {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_MAX_CONCURRENT_PER_ACCOUNT
  return Number.parseInt(raw, 10)
}

/**
 * 归一化构造参数 `deps.maxConcurrent`:非正整数一律回退默认 10。
 * 与 env 路径同语义,避免调用方传 `0` / 小数 / NaN 破掉上限。
 */
function sanitizeMaxConcurrent(n: number | undefined): number {
  if (n === undefined) return parseMaxConcurrentEnv()
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_PER_ACCOUNT
  return n
}

export interface PickInput {
  /**
   * `mode` 字段只作 metric label,真实选号算法全部走 WRH(见文件头注释)。
   * 历史上 `chat` 走加权随机、`agent` 走 rendezvous-hash sticky,v3 0064 起统一。
   *
   * 行为:
   *   - mode=agent + 缺 sessionId → TypeError(保留旧契约,防 caller 漏传)
   *   - mode=chat  + 缺 sessionId → 生成临时 randomUUID(退化为加权随机分布)
   *   - 任一 mode + 有 sessionId → 同 key + 同 weight 选同账号(强 sticky)
   */
  mode: 'chat' | 'agent'
  /**
   * WRH 的稳定 key。mode=agent 时必传;mode=chat 可选 — 不传则用 randomUUID
   * 作一次性 key,统计上仍按 weight 加权分布(与旧 chat 行为兼容)。
   */
  sessionId?: string
  /** 为未来 "按模型过滤账号池" 预留,目前不使用。 */
  model?: string
  /**
   * V3 provider 分区(默认 'claude' 与 v2 行为一致)。
   *   - 'claude' → SELECT ... WHERE provider='claude' AND status='active'
   *   - 'codex'  → SELECT ... WHERE provider='codex'  AND status='active'
   *
   * 注意:codex 容器的 sticky 绑定走独立函数 `pickCodexAccountForBinding`(不污染
   * scheduler 健康分 + 不进 inflight),pick() 只在 claude 路径或未来 codex chat
   * 真实 API 调用路径上调用。
   */
  provider?: AccountProvider
  /**
   * V3 envv2 (0070, 2026-05-21) 账号用途分区。
   *
   *   - 'platform'     默认值;平台容器 OAuth 流量。
   *   - 'external_api' 外接 ApiKey 专属 OAuth 流量。
   *
   * 物理隔离两池(plan §1.1)。SELECT WHERE 子句叠 `AND kind = $kind`。
   *
   * **Phase 1 仅暴露 scheduler 能力,handler 调用点不改** —— pickUpstream 不传此
   * 字段,所有路径走 default 'platform',与历史等价。Phase 1.5(独立 PR)在 boss
   * 手动把账号划进外接池且校验非空后,handler 外接 ApiKey 分支才显式传
   * `kind: 'external_api'`;池空抛 `AccountPoolUnavailableError`,**不**降级回
   * 'platform' 池(plan §1.4 决策)。
   */
  kind?: AccountKind
}

export interface PickResult {
  account_id: bigint
  plan: AccountPlan
  /** 解密后的 OAuth access token —— **调用方用完必须 .fill(0)** */
  token: Buffer
  /** 解密后的 refresh token(可能为 null)—— **调用方用完必须 .fill(0)** */
  refresh: Buffer | null
  expires_at: Date | null
  /** 该账号专属出口代理(明文 URL,内含密码);null 表示走本机出口或 mTLS host 出口 */
  egress_proxy: string | null
  /**
   * mTLS forward proxy 自动分配的 host(0038);仅在 egress_proxy 为 null 时使用。
   * egressDispatcher 优先级:egress_proxy > egress_target > 默认。
   */
  egress_target: import('./store.js').AccountToken['egress_target']
  /**
   * 反风控锚定:该账号永久绑定的客户端 device_id(64 字符小写 hex)。
   * 由 0067 migration 注入 schema DEFAULT + NOT NULL + CHECK + UNIQUE。
   * anthropicProxy 选号后用此值重写出站 body.metadata.user_id.device_id,
   * 让 Anthropic 网关看到稳定的 "account_uuid ↔ device_id" 一对一绑定。
   */
  pinned_user_id: string
}

/**
 * 请求释放结果。
 *
 * - `success`:请求正常完成。onSuccess → 健康分恢复
 * - `failure`:上游显式报错(5xx / 解析失败 / 显式业务失败 / 401 / 403 / 429 等
 *   账号相关 4xx)。onFailure → 扣健康分
 * - `transient_network`:纯网络层抖动(DNS / TCP / TLS / proxy 不通),**不扣健康分**,
 *   仅 dec 并发槽位。设计动机:账号配 egress_proxy 后,代理一抖等于一次性把整池账号
 *   全扣分 → 误判 cooldown / disable。网络抖动应由连续多次 http_error(上游)体现,
 *   而非把纯网络失败算到具体账号头上。
 * - `client_error`:用户/客户端侧错误(上游 400 invalid_request_error 如 thinking
 *   block signature 损坏 / 参数非法,或客户端主动断流 ac.abort)。**不扣健康分**,
 *   仅 dec 并发槽位。设计动机:用户客户端 bug 反复发坏请求会把账号反复打到 cooldown
 *   (boss 自己 thinking signature broken 反复触发 d1 cooldown 实例),账号本身没问题,
 *   不应代为受过。
 */
export type ReleaseResult =
  | { kind: 'success' }
  | { kind: 'failure'; error?: string | null }
  | { kind: 'transient_network'; error?: string | null }
  | { kind: 'client_error'; error?: string | null }

export interface ReleaseInput {
  account_id: bigint | string
  result: ReleaseResult
}

export interface SchedulerDeps {
  health: AccountHealthTracker
  /** 注入测试 key fn;默认 loadKmsKey */
  keyFn?: () => Buffer
  /** 注入 hash(用于测试;默认 SHA-256 64-bit) */
  hash?: (s: string) => bigint
  /**
   * 注入 sessionId 缺省时的"临时 WRH key"生成器;默认 `crypto.randomUUID()`。
   * 测试用此 dep 可让 mode=chat 无 sessionId 路径变得确定。
   */
  ephemeralKey?: () => string
  /** 注入"当前时间"(用于测试 subscription_end_at 因子);默认 `() => new Date()` */
  now?: () => Date
  /**
   * 单账号同时 in-flight 请求上限。未传则读 `CLAUDE_ACCOUNT_MAX_CONCURRENT`,
   * 再 fallback `DEFAULT_MAX_CONCURRENT_PER_ACCOUNT`(10)。
   */
  maxConcurrent?: number
}

/**
 * pick() SELECT 出来的候选行 — 含 WRH weight 因子全部输入。
 */
export interface CandidateRow extends QueryResultRow {
  id: string
  plan: AccountPlan
  health_score: number
  /** Anthropic 5h 配额已用百分比(0-100);NULL = 未知,按中性看待 */
  quota_5h_pct: number | null
  /** Anthropic 7d 配额已用百分比(0-100);NULL = 未知,按中性看待 */
  quota_7d_pct: number | null
  /** Anthropic 订阅周期到期日(管理员手填;NULL = 未知,按中性看待) */
  subscription_end_at: Date | null
  /**
   * 反风控锚定:该账号永久绑定的客户端 device_id(64 字符小写 hex)。
   * 来自 claude_accounts.pinned_user_id 列(0067 migration)。
   */
  pinned_user_id: string
}

/** 默认哈希:SHA-256,截前 8B 作 64-bit 无符号整数。 */
export function defaultHash(s: string): bigint {
  const h = createHash('sha256').update(s).digest()
  return h.readBigUInt64BE(0)
}

/** 用于把 64-bit 哈希映射到 (0,1) 开区间(避免 ln(0)/ln(1) 极端值)。 */
const TWO_64 = 2n ** 64n

/**
 * 单账号综合权重 = max(1, health) × f_quota(5h) × f_quota(7d) × f_subscription.
 *
 * 设计要点(boss 决策 + Codex review 反馈):
 *   1. **NULL 全部按中性 1.0 处理** — 字段未维护不应隐式降权。新加因子不能把
 *      老账号一夜踢出池子(KISS + 渐进维护友好)。
 *   2. **配额因子 f_quota 用线性插值**而非阶梯函数:配额 header 每 5min 抖几下都
 *      不该触发整池 session 重洗。50% 以下中性,50→95% 线性 1.0→0.05,95% 以上钳到
 *      0.05(保留一点点 weight 让上层 fallback 可选,而不是直接踢出池子让 503)。
 *   3. **订阅因子 f_subscription 反向加权**:跟 quota 方向相反 — quota 是触顶风险
 *      (用得多减权),subscription 是月度付费的沉没成本(到期前没用完就白付钱),
 *      所以**快到期反而加权**优先榨干额度。阶梯阈值:≤0 天(已过期)= 0.1(belt+
 *      suspenders);<2 天 = 2.0(紧急榨);<7 天 = 1.5(优先用);<30 天 = 1.0
 *      (中性);≥30 天 = 0.8(远期让路)。管理员手填字段、变更频率极低,阶梯 OK。
 *   4. **永不返回 0**:全局保底 0.05 — health=0、quota=100、subscription 过期的
 *      "残废账号" 也保留极小机会被探活,以便健康分恢复路径不死锁。
 *
 * @param now 注入"当前时间",方便测试 subscription 阶梯;默认调用方传 new Date()
 */
export function computeAccountWeight(c: CandidateRow, now: Date): number {
  const wHealth = Math.max(1, c.health_score)
  const wQuota5h = quotaFactor(c.quota_5h_pct)
  const wQuota7d = quotaFactor(c.quota_7d_pct)
  const wSub = subscriptionFactor(c.subscription_end_at, now)
  const w = wHealth * wQuota5h * wQuota7d * wSub
  // 极小 floor:避免 0/负数(ln(0)=-inf → WRH 数值崩)。0.05 仍允许探活但极不被偏好。
  return Math.max(0.05, w)
}

/**
 * 配额因子 f_quota(util)。
 *   - null(quota_*_pct 未上报) → 1.0
 *   - util ≤ 50              → 1.0
 *   - 50 < util < 95         → 线性 1.0 → 0.05
 *   - util ≥ 95              → 0.05
 *
 * NaN / 负数等异常值统一回退 1.0(防御性兜底)。
 */
function quotaFactor(util: number | null): number {
  if (util == null || Number.isNaN(util) || util < 0) return 1.0
  if (util <= 50) return 1.0
  if (util >= 95) return 0.05
  // 50 < util < 95:线性插值 1.0 → 0.05
  const t = (util - 50) / 45 // ∈ (0, 1)
  return 1.0 - t * 0.95
}

/**
 * 订阅因子 f_subscription(end, now) — **收益最大化** 方向。
 *
 * 业务语义:Anthropic 订阅按月付费,到期前没用完的额度白白浪费。所以**快到期的账号
 * 反而要优先吃流量,把额度榨干**。这跟 quota_5h/7d 是相反的两件事:
 *   - quota = 滚动窗口 rate limit,触顶被 ban → 用得越多越减权(避免触顶)
 *   - subscription = 月度付费,过期就白付钱 → 越临近到期越加权(榨干额度)
 *
 *   - end IS NULL          → 1.0  中性(admin 没填,语义不明)
 *   - days ≤ 0(已过期)     → 0.1  belt+suspenders;真正过期 health 系统会 disable
 *   - days < 2(紧急)        → 2.0  急用!2 天内到期猛吃
 *   - days < 7(临期)        → 1.5  优先吃额度
 *   - days < 30(月内)       → 1.0  中性
 *   - days ≥ 30(远期)       → 0.8  让快到期的先消化,远期账号慢慢用
 *
 * 阶跃 vs 平滑:admin 手填字段、改动频率极低,阶跃 OK(不会因为时间分秒变化产生 session
 * 漂移);quota 用线性是因为 5h header 自动 refresh 容易在 50-95% 平滑过渡。
 */
function subscriptionFactor(end: Date | null, now: Date): number {
  if (end == null) return 1.0
  const ms = end.getTime() - now.getTime()
  if (Number.isNaN(ms)) return 1.0
  const days = ms / (24 * 60 * 60 * 1000)
  if (days <= 0) return 0.1
  if (days < 2) return 2.0
  if (days < 7) return 1.5
  if (days < 30) return 1.0
  return 0.8
}

/**
 * Weighted Rendezvous Hashing (Thaler-Ravishankar) — 同 key + 同候选 + 同 weight
 * 必选同账号;候选/weight 变化只迁移 O(Δ/总和) 比例的 key。
 *
 * 数学:
 *   - 对每个候选 i:取 hash64 高 53 bit(BigInt.asUintN(64, h) >> 11n 转 Number 不丢精度),
 *     计算 u_i = (h53 + 0.5) / 2^53,均匀分布于 (0,1) 开区间
 *   - score_i = -ln(u_i) / weight_i,服从 Exp(weight_i)
 *   - **argmin** score_i ⇒ 选 weight 最大那个的概率正比于 weight_i / Σ weight_j
 *
 * 实现细节:不用 `Number(h)/2^64` —— `Number(2^64-1)` 会舍入到 2^64 让 u=1、-ln(u)=0,
 * 违背开区间承诺。改用 53-bit safe mapping 后 u 严格在 (0,1)。
 *
 * (常见错误:argmax → 会选 weight 最小的!Codex review 已经卡掉过一次。)
 *
 * @throws AccountPoolUnavailableError 候选为空
 */
export function pickWRH(
  candidates: ReadonlyArray<CandidateRow>,
  key: string,
  now: Date,
  hash: (s: string) => bigint = defaultHash,
): CandidateRow {
  if (candidates.length === 0) {
    throw new AccountPoolUnavailableError('no candidates for WRH')
  }
  let bestIdx = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]
    const h = hash(`${key}:${c.id}`)
    // u ∈ (0, 1):加 0.5 保证既不 0 也不 1,避免 ln 极端值
    // 用 53-bit 安全映射 — Number(2^64-1) 会舍入到 2^64 让 u=1,违背开区间承诺
    const h53 = Number(BigInt.asUintN(64, h) >> 11n)
    const u = (h53 + 0.5) / 2 ** 53
    const w = computeAccountWeight(c, now)
    // score 越小越优:w 越大 ⇒ 期望 score 越小(选中概率正比 w)。
    // 同样 u(给定 key+id 确定),w 越大 ⇒ score 越小,故 argmin 优先 w 大者。
    const score = -Math.log(u) / w
    if (score < bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return candidates[bestIdx]
}

/**
 * 调度器 —— 从 `status='active'` 账号集里挑一个返 token(解密后的明文 Buffer)。
 *
 * 生命周期:
 *   - pick 时装填 `AccountPoolUnavailableError` 的唯一真相:候选集非空 ∧ token 解密成功
 *   - release 时调 health tracker 更新统计
 */
export class AccountScheduler {
  private readonly health: AccountHealthTracker
  private readonly keyFn: () => Buffer
  private readonly hash: (s: string) => bigint
  private readonly ephemeralKey: () => string
  private readonly now: () => Date
  /**
   * 单账号 in-flight 计数。pick() 选中并准备返 token 之前 inc,
   * release() 时 dec;归 0 就 delete 避免 Map 无限膨胀。
   *
   * 一致性边界:本字段是进程内状态,只在同一 AccountScheduler 实例内严格
   * 满足 inflight[id] ≤ maxConcurrent。多进程部署不会自动汇总。
   *
   * TOCTOU 安全:`filter → pickWRH → inc` 在 pick() 循环内的一个同步块里完成,
   * 中间没有 await —— Node 单线程协作调度下两个并发 pick() 只能在 await 边界
   * 交错,因此硬上限成立。
   */
  private readonly inflight = new Map<string, number>()
  /** 单账号同时 in-flight 请求上限。 */
  readonly maxConcurrent: number

  constructor(deps: SchedulerDeps) {
    this.health = deps.health
    this.keyFn = deps.keyFn ?? loadKmsKey
    this.hash = deps.hash ?? defaultHash
    this.ephemeralKey = deps.ephemeralKey ?? randomUUID
    this.now = deps.now ?? (() => new Date())
    this.maxConcurrent = sanitizeMaxConcurrent(deps.maxConcurrent)
  }

  /**
   * 当前 in-flight 计数。测试/监控用;非测试路径不要依赖返回值做判断。
   */
  getInflight(accountId: bigint | string): number {
    return this.inflight.get(String(accountId)) ?? 0
  }

  private incInflight(id: string): void {
    this.inflight.set(id, (this.inflight.get(id) ?? 0) + 1)
  }

  /** 幂等:对未计数/已归零的 id 调用无副作用、无日志噪音。 */
  private decInflight(id: string): void {
    const cur = this.inflight.get(id)
    if (cur === undefined) return
    const next = cur - 1
    if (next <= 0) this.inflight.delete(id)
    else this.inflight.set(id, next)
  }

  /**
   * 选一个账号并返回 token。
   *
   * TOCTOU 保护:如果选中的账号在 SELECT 和 getTokenForUse 之间被删
   * (`getTokenForUse` 返 null),从候选池剔除该 id 重新选,直到池空才抛 503。
   * 这避免了"池里还有可用账号但本次 pick 误报不可用"的假阳性。
   *
   * AEAD 解密失败(密文损坏)→ 内部 quarantine 该账号(status='disabled' + last_error),
   * 然后从候选里剔除,继续挑下一个。避免坏账号长期留在 active 池里持续制造随机失败。
   *
   * @throws `AccountPoolUnavailableError` 当无 active 账号 / 全部候选都失效
   * @throws `TypeError` 当 `mode=agent` 缺 sessionId
   */
  async pick(input: PickInput): Promise<PickResult> {
    if (input.mode === 'agent') {
      if (!input.sessionId || input.sessionId.length === 0) {
        throw new TypeError('sessionId required when mode=agent')
      }
    } else if (input.mode !== 'chat') {
      throw new TypeError(`unknown mode: ${String(input.mode)}`)
    }

    const provider: AccountProvider = input.provider ?? 'claude'
    // V3 envv2 (0070):kind 分区。default 'platform' 与历史等价(0070 DEFAULT 也
    // 是 'platform',backfill 后存量行全部 platform)。Phase 1.5 才有 caller 显式
    // 传 'external_api'。校验非法值早 fail,避免 SQL injection-shaped 错(虽然
    // pg 参数化已挡)。
    const kind: AccountKind = input.kind ?? 'platform'
    if (!ACCOUNT_KINDS.includes(kind)) {
      throw new TypeError(`invalid kind: ${String(input.kind)}`)
    }
    const res = await query<CandidateRow>(
      `SELECT id::text AS id, plan, health_score,
              quota_5h_pct, quota_7d_pct, subscription_end_at,
              pinned_user_id
       FROM claude_accounts
       WHERE status = 'active' AND provider = $1 AND kind = $2
       ORDER BY id`,
      [provider, kind],
    )
    let pool = res.rows
    if (pool.length === 0) {
      throw new AccountPoolUnavailableError('no active accounts')
    }

    // WRH key:有 sessionId 走强 sticky;没有则生成一次性 randomUUID(分布上仍按
    // weight 加权,等价旧 chat 模式语义)。**整个 pick() 调用共享同一个 key**,
    // 这样下面重选循环(vanish/AEAD quarantine)在剩余候选集里仍是稳定的。
    const wrhKey = input.sessionId && input.sessionId.length > 0
      ? input.sessionId
      : this.ephemeralKey()
    const now = this.now()

    // 最多重选 N 轮(N = 候选数)。每次选中账号若解密时发现已不存在,
    // 剔除后从剩余候选再选一次 —— WRH 对剩余集仍是稳定的,只是换到次优选择。
    //
    // 并发上限:每轮先按 `inflight < maxConcurrent` 过滤出 under-cap 账号;
    // filter → pick → incInflight 同一 sync 块内完成(无 await),保证硬上限。
    // 退出后区分两种状态:
    //   - pool.length > 0 但 under-cap 为空 → AccountPoolBusyError(可重试 429);
    //   - pool.length === 0(vanish/AEAD 把池子掏空) → AccountPoolUnavailableError(503)。
    let vanished = 0
    let quarantined = 0
    while (pool.length > 0) {
      const available = pool.filter((c) => (this.inflight.get(c.id) ?? 0) < this.maxConcurrent)
      if (available.length === 0) break

      const chosen = pickWRH(available, wrhKey, now, this.hash)
      // 同步 reserve 槽位 —— 必须在下一个 await(getTokenForUse)之前完成
      this.incInflight(chosen.id)
      try {
        const tok = await getTokenForUse(chosen.id, this.keyFn)
        if (tok) {
          return {
            account_id: BigInt(chosen.id),
            plan: tok.plan,
            token: tok.token,
            refresh: tok.refresh,
            expires_at: tok.expires_at,
            egress_proxy: tok.egress_proxy,
            egress_target: tok.egress_target,
            pinned_user_id: chosen.pinned_user_id,
          }
        }
        // 账号在 SELECT 和 readToken 之间被并发删了,剔除再选
        this.decInflight(chosen.id)
        vanished += 1
        pool = pool.filter((c) => c.id !== chosen.id)
      } catch (err) {
        this.decInflight(chosen.id)
        if (err instanceof AeadError) {
          // 密文坏 —— 隔离这个账号(异步 disable 不阻塞 pick 路径),从候选剔除继续选
          void updateAccount(
            chosen.id,
            {
              status: 'disabled',
              last_error: `AEAD decryption failed at pick(): ${err.message}`.slice(0, 500),
            },
            this.keyFn,
          ).catch(() => {
            /* best-effort;下一轮 pick 的 SELECT status='active' 也会自然排除 */
          })
          quarantined += 1
          pool = pool.filter((c) => c.id !== chosen.id)
          continue
        }
        throw err
      }
    }
    if (pool.length > 0) {
      // 还有 active 账号但全部命中 inflight cap — 是可重试的 busy 状态
      // (无论之前有没有 vanish/aead 剔除,只要剩余池非空就代表"重试可解")
      const drained =
        vanished + quarantined > 0
          ? ` (after vanished=${vanished} aead_quarantined=${quarantined})`
          : ''
      throw new AccountPoolBusyError(
        `all ${pool.length} remaining active account(s) at per-account concurrency cap (max=${this.maxConcurrent})${drained}`,
      )
    }
    // 池子真被掏空 — 全部 vanish/AEAD,无可重试目标
    throw new AccountPoolUnavailableError(
      `candidate pool drained while pick()ing: vanished=${vanished} (deleted between SELECT and readToken), ` +
        `aead_quarantined=${quarantined} (decryption failed → auto-disabled)`,
    )
  }

  /**
   * 请求结果回调:交给 health tracker 更新 status/计数。
   *
   * 上游流程:
   *   ```
   *   const p = await scheduler.pick({mode:"chat"});
   *   try {
   *     const r = await callClaudeApi(p.token);
   *     await scheduler.release({account_id:p.account_id, result:{kind:"success"}});
   *   } catch (err) {
   *     await scheduler.release({
   *       account_id:p.account_id,
   *       result:{kind:"failure", error:String(err)},
   *     });
   *     throw err;
   *   } finally {
   *     p.token.fill(0); p.refresh?.fill(0);
   *   }
   *   ```
   */
  async release(input: ReleaseInput): Promise<void> {
    // 先 dec inflight(幂等,健康 tracker 抛错也不能让 slot 永久占用)
    this.decInflight(String(input.account_id))
    if (input.result.kind === 'success') {
      await this.health.onSuccess(input.account_id)
    } else if (input.result.kind === 'failure') {
      await this.health.onFailure(input.account_id, input.result.error ?? null)
    }
    // transient_network / client_error:已释放 slot,但不扣健康分(见 ReleaseResult 注释)
  }

  /**
   * 申请一个 codex per-account 并发槽。
   *
   * 与 pick() 路径区别:
   *   - 不解密 token、不读 DB 之外的状态
   *   - 不调 health tracker(release 也不调)
   *   - 仅按 maxConcurrent 卡 inflight Map
   *
   * 调用契约:
   *   - 每条 codex inbound 独立成对调用 acquire / release(plan G7 严格单飞)
   *   - 抛 AccountPoolBusyError → bridge 转 error 帧 fast-fail,不 fallback
   *
   * @throws `AccountPoolBusyError` 当 inflight[id] >= maxConcurrent
   */
  acquireCodexSlot(account_id: bigint | string): void {
    const id = String(account_id)
    const cur = this.inflight.get(id) ?? 0
    if (cur >= this.maxConcurrent) {
      throw new AccountPoolBusyError(
        `codex account ${id} at per-account concurrency cap (max=${this.maxConcurrent})`,
      )
    }
    // 与 pick() 同步块语义一致 —— 当前 fn 是 sync,确实在 await 边界之外完成
    this.incInflight(id)
  }

  /**
   * 释放一个 codex per-account 并发槽(幂等)。
   *
   * 不调 health.onSuccess / onFailure(plan 决策 J2:bridge 用真实 turn 出参
   * 决定健康分,不在这里挂)。
   */
  releaseCodexSlot(account_id: bigint | string): void {
    this.decInflight(String(account_id))
  }
}

/**
 * Codex 容器与账号绑定专用 picker — 不污染 scheduler 健康分 / inflight Map。
 *
 * 用于:
 *   - v3supervisor.provisionV3Container:容器启动时挑账号 → UPDATE
 *     agent_containers.codex_account_id → 写 per-container auth.json
 *   - userChatBridge lazy migrate(账号被 disable):重选一个 active codex 账号
 *
 * 与 `AccountScheduler.pick({provider:'codex'})` 区别:
 *   - 不调 getTokenForUse(token 由调用方按需 getCodexTokenSnapshot 单独取)
 *   - 不 inc inflight(provision 不是真实 API 调用)
 *   - 不调 health(provision 不算 turn)
 *   - **每个候选独立循环过滤 AEAD 损坏的账号**(若密文坏 quarantine + 跳过)
 *
 * @returns null 当 codex 池空 / 全 disabled(plan 决策 P:走 legacy mount)
 */
export interface PickCodexBindingDeps {
  /** 注入测试 hash;默认 SHA-256 64-bit */
  hash?: (s: string) => bigint
}

/**
 * pickCodexAccountForBinding 的返回值。
 *
 * v3 plan(feat/codex-disable-rebind):返回值含 `plan` —— M1 in-turn 自愈
 * 后要在响应里塞 `chatgptPlanType`,picker SQL 本就查了 plan,顺手带出避免
 * caller 再查一次。
 */
export interface PickedCodexBinding {
  account_id: bigint
  plan: AccountPlan
}

/**
 * In-tx 版本 —— 用调用方持有的 `PoolClient` 跑 SELECT,**不申请第二个 pool
 * client**。callers:
 *   - `userChatBridge.codexBinding.acquire` 的 tx
 *   - M1 `internalCodexTokenRefresh` 的 in-turn lazy migrate tx
 *   - M2 `codexDisableFanout` 的 migrate tx
 *
 * 旧的 `pickCodexAccountForBinding(sessionId)` 改为 thin wrapper,保留给
 * provision-time(无 tx 上下文)用。
 */
export async function pickCodexAccountForBindingInTx(
  client: PoolClient,
  sessionId: string,
  deps: PickCodexBindingDeps = {},
): Promise<PickedCodexBinding | null> {
  if (!sessionId || sessionId.length === 0) {
    throw new TypeError('sessionId required for pickCodexAccountForBindingInTx')
  }
  const hash = deps.hash ?? defaultHash

  const res = await client.query<{ id: string; plan: AccountPlan; health_score: number }>(
    `SELECT id::text AS id, plan, health_score
     FROM claude_accounts
     WHERE status = 'active' AND provider = 'codex'
     ORDER BY id`,
  )
  if (res.rows.length === 0) return null

  // rendezvous-hash sticky:对每个候选计算 hash(`sessionId:id`),取最大。
  // 故意不带 weight 因子 — codex 容器与账号绑定是 provision-once 的物理关系,
  // 应该稳定;weight(health/quota/subscription)的"软"波动不该把已绑定容器迁
  // 到别处。容器侧只在账号被显式 disable 时通过独立 codexDisableFanout 路径
  // 触发重新绑定。这里不进 inflight、不解密 token、不调 health。
  let bestIdx = 0
  let bestScore = hash(`${sessionId}:${res.rows[0].id}`)
  for (let i = 1; i < res.rows.length; i += 1) {
    const s = hash(`${sessionId}:${res.rows[i].id}`)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return {
    account_id: BigInt(res.rows[bestIdx].id),
    plan: res.rows[bestIdx].plan,
  }
}

/**
 * Thin wrapper —— 不在 tx 上下文中(如 provisionV3Container)使用。
 * 自申请 pool client、释放。tx 内绝不要调用此函数,改用 `pickCodexAccountForBindingInTx`。
 */
export async function pickCodexAccountForBinding(
  sessionId: string,
  deps: PickCodexBindingDeps = {},
): Promise<PickedCodexBinding | null> {
  const client = await getPool().connect()
  try {
    return await pickCodexAccountForBindingInTx(client, sessionId, deps)
  } finally {
    client.release()
  }
}
