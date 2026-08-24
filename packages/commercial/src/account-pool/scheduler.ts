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
import { getCodexAccountRuntimeChannel, getRuntimeChannel } from '../runtimeChannel.js'
import type { AccountHealthTracker } from './health.js'
import {
  type AccountPlan,
  type AccountProvider,
  type AccountRecoveryHint,
  getTokenForUse,
  readAccountRecoveryHint,
  updateAccount,
} from './store.js'

export const ERR_ACCOUNT_POOL_UNAVAILABLE = 'ERR_ACCOUNT_POOL_UNAVAILABLE'
export const ERR_ACCOUNT_POOL_BUSY = 'ERR_ACCOUNT_POOL_BUSY'
export const ERR_CONTAINER_STALE_BINDING = 'ERR_CONTAINER_STALE_BINDING'
export const ERR_SESSION_PIN_UNBOUND = 'ERR_SESSION_PIN_UNBOUND'
export const ERR_SESSION_PIN_UNAVAILABLE = 'ERR_SESSION_PIN_UNAVAILABLE'

export class AccountPoolUnavailableError extends Error {
  readonly code = ERR_ACCOUNT_POOL_UNAVAILABLE
  /**
   * 结构化原因 — 给调用方按 reason 做 metric 分桶 / 日志 facet 用,而不是
   * substring-match `err.message`(message 带 "account pool unavailable: " 前缀,
   * 多桶共存场景下容易写错匹配)。当前已知值:'no_active' / 'no_uuid' / 自由 string。
   */
  readonly reason: string
  constructor(reason: string) {
    super(`account pool unavailable: ${reason}`)
    this.name = 'AccountPoolUnavailableError'
    this.reason = reason
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

/**
 * v3 反关联根治 — session pin 已标记 'unbound' 时抛。
 *
 * 触发场景:
 *   - 该 (user_id, session_id) 原本 pinned 到某个 account,该 account 后来被
 *     banned/disabled,store.transitionAccountStatus / updateAccount cascade
 *     更新 csap.status='unbound'。
 *   - 用户下一次请求命中 unbound pin → 不许在同 session 内换号(避免 cascade-ban),
 *     强制走"reset session"路径:前端 fresh 新 session_id,scheduler 重新选号。
 *
 * HTTP 映射:409 Conflict + body 形如
 *   `{ error: { type: 'session_pin_unbound', action: 'reset_session', message: '...' } }`
 *
 * 注意:retryable=false — 同 session 重试只会再次 hit 同一 unbound pin。
 */
export class SessionPinUnboundError extends Error {
  readonly code = ERR_SESSION_PIN_UNBOUND
  readonly retryable = false
  readonly action = 'reset_session' as const
  /**
   * 客户端在收到这个错误后**应该**采取的恢复策略:
   *   - 'force_repin' — 客户端可以选择对同一 session 重发请求并打 `x-force-repin: 1`
   *     头(scheduler 会强制 repin 到新账号,session_id 不变)。这是"保留对话历史"
   *     的路径,前端默认走这条 —— 用户感知层面只是"上一轮失败,自动重试一次"。
   *
   * 注意:`action='reset_session'` 仍然在 body 里,作为**fallback 语义**给老前端
   * (不识别 retry_strategy 字段)用 —— 老客户端继续走"开新会话"路径,新客户端
   * 走 force_repin 路径,两边都不会卡死。
   */
  readonly retryStrategy = 'force_repin' as const
  constructor(message = 'session pin has been unbound; retry with x-force-repin: 1 to keep conversation history') {
    super(message)
    this.name = 'SessionPinUnboundError'
  }
}

/**
 * v3 反关联根治 — session pin 指向的 account 暂时不可用(active 池里找不到)。
 *
 * 触发场景:
 *   - pin.status='active' 但 pin.account_id 当前 status != 'active'(短暂 cooldown
 *     / token AEAD 损坏 / 并发刚被 disable 还没 cascade 完 csap)。
 *   - 跟 SessionPinUnboundError 区分:Unbound 是终态(账号死了),Unavailable 是
 *     瞬时态(账号可能马上恢复或马上被 cascade 标 unbound)。
 *
 * HTTP 映射:503 Service Unavailable + retryable=true。前端 backoff retry,
 * 几秒后:
 *   - 账号恢复 → 命中同一 pin 继续服务
 *   - 账号确认死 → cascade 完成 → 下次 retry 命中 unbound → 转 409 提示 reset
 */
export class SessionPinTemporarilyUnavailableError extends Error {
  readonly code = ERR_SESSION_PIN_UNAVAILABLE
  readonly retryable = true
  /**
   * 距离 pin 上的账号恢复 active 还需要等多久(毫秒)。
   *   - 来自 `readAccountRecoveryHint`(读 cooldown_until - now)。
   *   - `0` 表示"几乎立即可重试"(account 在 SELECT 和重读之间刚 flip 回 active,
   *     或 cooldown_until 已过期但 status 还没翻);scheduler pick() facade 的
   *     immediateRetries 路径会吞掉,不让客户端拿到 Retry-After=0 这种奇怪值。
   *
   * HTTP 层做 `Math.max(1, Math.ceil(retryAfterMs / 1000))` 转 Retry-After 秒,
   * **同时**在 body 里给 `retry_after_ms` 精确字段供新客户端用。
   */
  readonly retryAfterMs: number
  /**
   * 客户端用尽 Retry-After 后还失败时**应该**怎么办的 hint:
   *   - 'force_repin_after_retry' — 等 retryAfterMs 后重试一次;若仍 503,改打
   *     `x-force-repin: 1` 强制切号(此时 cooldown 多半已 cascade 成 banned/
   *     disabled,server 会走 self-heal cascade → 抛 409 unbound,客户端再走
   *     force_repin 路径关闭循环)。
   *
   * 这是给客户端"用户体验补丁层"用的:让前端可以无 UI 自动闭环,boss 看到的就是
   * "请求慢了一会儿但成功了",而不是"反复转圈"。
   */
  readonly fallbackStrategy = 'force_repin_after_retry' as const
  /**
   * server 侧 retryAfterMs 合法上限:24h。
   *
   * 远超 cooldown 设计区间(秒~分钟级),此处仅作为防御性 cap 阻断 NaN/Infinity 或上游
   * 计算出离谱值时把"Retry-After: NaN" / 巨大整数泄漏给 HTTP 层。命中 cap 等价于
   * 表达"非常长别等了,直接 fallback 走 force_repin",客户端 UX 仍然闭环。
   */
  static readonly MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'SessionPinTemporarilyUnavailableError'
    // NaN / Infinity / -Infinity 一律归 0(走 immediate retry 路径),避免 HTTP 层
    // Retry-After 出现 "NaN" 或 body retry_after_ms=null。有限值再 floor + clamp。
    this.retryAfterMs = Number.isFinite(retryAfterMs)
      ? Math.min(
          SessionPinTemporarilyUnavailableError.MAX_RETRY_AFTER_MS,
          Math.max(0, Math.floor(retryAfterMs)),
        )
      : 0
  }
}

/**
 * pick() facade 的内部短 sleep helper。提取出来便于将来注入 fake timer 测试,
 * 同时表达"这是 server 内部 short-spin 等待,不是业务定时器"的意图。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * scheduler.pick() 的 session-pin 三态执行模式。
 *
 *   - 'off'     — 默认:不查 pin,行为完全等价旧 scheduler(向后兼容路径)
 *   - 'observe' — 上线灰度态:跑常规 WRH,选号后**额外**查一次 pin 对比"WRH 选择 vs
 *                历史 pin 是否一致",仅打点日志(metric `session_pin_observe`)。
 *                不写 csap(避免还没自信前固化错绑)。
 *   - 'enforce' — 根治态:查 pin → 命中 active 直接复用;命中 unbound 抛
 *                SessionPinUnboundError;miss 走"既往足迹优先"WRH + race-safe INSERT
 *                持久化 pin。
 *
 * 灰度路线:off → observe(收集 backfill 后实际命中率 + 不一致率)→ enforce。
 */
export type SessionPinMode = 'off' | 'observe' | 'enforce'

/** 单账号同时 in-flight 请求默认上限。防止单账号被 Anthropic 风控。 */
export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 10

/**
 * 反封复盘 2026-08 — 配额感知主动退避阈值(百分比)。
 *
 * 账号的 5h / 7d 滚动配额利用率(quota_5h_pct / quota_7d_pct,从 Anthropic 响应头
 * 被动上报)达到/超过该阈值时,**直接从候选池剔除**(不是仅降权),让它歇到配额
 * 窗口滚动恢复 —— 而不是一路把请求打到上游 429。反复撞限额是"规避限额"的封号
 * 画像;主动退避把这个信号消掉。
 *
 * 与 computeAccountWeight 里的 quotaFactor(50→95% 线性降权)分工:降权是"少用",
 * 这里是"到顶就不用"。阈值默认 95(留一点余量给 header 上报抖动),env 可调。
 * NULL(未上报,如 codex/grok)不受影响 —— SQL 用 `IS NULL OR < 阈值`。
 */
export const DEFAULT_QUOTA_BACKOFF_PCT = 95

/**
 * 解析 `CLAUDE_ACCOUNT_QUOTA_BACKOFF_PCT`。只接受 1..100 的整数;非法回退 95。
 * 设为 100 等于实质关闭主动退避(只有真正 100% 才剔除)。
 */
export function parseQuotaBackoffPctEnv(
  raw: string | undefined = process.env.CLAUDE_ACCOUNT_QUOTA_BACKOFF_PCT,
): number {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_QUOTA_BACKOFF_PCT
  const n = Number.parseInt(raw, 10)
  if (n < 1 || n > 100) return DEFAULT_QUOTA_BACKOFF_PCT
  return n
}

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

/** 泄漏槽 reaper 默认 TTL:30min(远大于任何合法单 turn,偏向 under-reap)。 */
export const DEFAULT_SLOT_LEASE_TTL_MS = 30 * 60_000
/** 泄漏槽 reaper TTL 名义上界:24h(实际上界 = max(floor, 此值),保证 ≥ floor)。 */
export const SLOT_LEASE_TTL_CEIL_MS = 24 * 60 * 60_000

/**
 * 读 `CODEX_SESSION_MAX_MS` 作 TTL 下界因子。本地复刻 userChatBridge 的解析语义
 * (避免 scheduler→bridge import 环):有限且 ≥1000 才采用,否则默认 600s。
 */
function readCodexSessionMaxMsFloor(
  raw: string | undefined = process.env.CODEX_SESSION_MAX_MS,
): number {
  if (!raw) return 600_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1000 ? n : 600_000
}

/**
 * 解析 `ACCOUNT_SLOT_LEASE_TTL_MS`:纯正整数字符串(ms)才采用,否则 undefined(交 sanitize 回落)。
 */
export function parseSlotLeaseTtlEnv(
  raw: string | undefined = process.env.ACCOUNT_SLOT_LEASE_TTL_MS,
): number | undefined {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * 归一化泄漏槽 TTL。
 *
 * floor = max(CODEX_SESSION_MAX_MS, 30min) —— reaper 必须晚于 Codex bridge 600s timer,
 *   否则会抢在 bridge 之前误回收**活跃** Codex turn 的槽 → 过并发。
 * ceil  = max(floor, 24h) —— 名义上界 24h,但若运维把 CODEX_SESSION_MAX_MS 设成 >24h,
 *   上界抬到 floor,保证 `ttl ≥ floor ≥ CODEX_SESSION_MAX_MS` 恒成立(Codex 计划审 Blocking 4)。
 * 非法/非 SafeInteger/未配 → 默认 30min,再被 floor 夹上去。
 */
export function sanitizeSlotLeaseTtl(
  n: number | undefined,
  codexFloor: number = readCodexSessionMaxMsFloor(),
): number {
  const floor = Math.max(codexFloor, DEFAULT_SLOT_LEASE_TTL_MS)
  const ceil = Math.max(floor, SLOT_LEASE_TTL_CEIL_MS)
  let configured = n
  if (configured === undefined) configured = parseSlotLeaseTtlEnv()
  if (
    configured === undefined ||
    !Number.isSafeInteger(configured) ||
    configured <= 0
  ) {
    configured = DEFAULT_SLOT_LEASE_TTL_MS
  }
  return Math.min(Math.max(configured, floor), ceil)
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
  /** Optional account group filter. When set, only active accounts in this group are eligible. */
  groupId?: bigint | string | null
  /**
   * Phase 6 H6 不变量执行模式。`true` 时 scheduler 把 `account_uuid IS NULL`
   * 的候选从 WRH 入选集剔除(对应 `PHASE6_ACCOUNT_UUID_ENFORCE === 'fail_closed'`)。
   *
   * 池过滤后若**所有** active 都被 NULL 剔除 → 抛 `AccountPoolUnavailableError('no_uuid')`
   * (复用 503 POOL_UNAVAILABLE 契约,见 0070 plan §2.4/§5.5.3)。
   *
   * 默认 false:Phase 5 / off / fail_open 语义不变。
   */
  enforceAccountUuid?: boolean
  /**
   * v3 反关联根治 — chat_session_account_pin 表的执行模式。
   *
   * 仅在 `provider='claude'` + 真实 chat 调用路径生效;codex 容器绑定 / DeepSeek
   * 等其他路径调用方不传(default 'off')。
   *
   * 三态语义见 `SessionPinMode`。
   *
   * 'observe' / 'enforce' 模式必须**同时**提供 `userId` 和 `sessionId`,否则
   * pin 锚定无效。pick() 内部会校验,缺失视为 'off' 行为 + warn 日志。
   *
   * 默认 'off':保持旧 WRH-only 调度,不查 / 不写 pin 表。
   */
  pinMode?: SessionPinMode
  /**
   * v3 反关联根治 — 已认证用户 id。`pinMode != 'off'` 时必传(BREAKING:新 caller
   * 需穿线 userId)。`pinMode='off'` 时可省。
   *
   * 来源:外接 API key 路径走 req.user.id;web/CCB 容器路径走 OAuth 会话 user。
   * scheduler 不自己拿 — caller 在 hot path 注入。
   */
  userId?: bigint
  /**
   * v3 反关联根治 UX 闭环 — 客户端"强制 repin"信号。
   *
   * 来源:HTTP 层把请求头 `x-force-repin: 1` 翻译成此布尔。语义:
   *   "上一轮拿到 409 SessionPinUnbound 后,客户端选择保留 session_id 继续对话,
   *    要求 scheduler **绕过** pin prelude(不读 csap.status='unbound' 不抛 409),
   *    走反扩散 WRH 选号 + 用 INSERT…ON CONFLICT (user_id, session_id) DO UPDATE
   *    覆盖原 unbound 行为 active。"
   *
   * 跟 pinMode 的关系:仅在 pinMode='enforce' 时有意义;其它模式下被静默忽略。
   *
   * 设计动机:不让用户为反风控买单。force_repin 让 backend 把"账号死了换一个"
   * 这步完全吸收到一次请求里,用户端感知层只多了一次"自动重试",没有"reset 对话"
   * 的体验断裂。
   *
   * 默认 false:老 caller / 第一次请求 / non-pin 路径全部走原 prelude。
   */
  forceRepin?: boolean
}

export interface PickResult {
  account_id: bigint
  /**
   * 本次 pick 的 per-slot 租约 id(唯一,不复用)。release/releasePickResult/finalizer
   * 必须原样回传以精确还槽。绝不可用 account_id 还槽(那会误伤同账号其它在途租约)。
   */
  slotId: string
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
   * 出口绑定**权威源**(account 自身列,不受 JOIN active-filter 影响)。A2 fail-closed:
   * 已绑账号(egress_proxy_id 或 egress_host_uuid 非 null)若解析不出 dispatcher,
   * upstream 必须拒发,绝不退默认出口。区别于上面已被 active-filter 置 null 的
   * egress_proxy/egress_target(解析结果)。0055 起 claude 账号 egress_proxy_id 恒非 null。
   */
  egress_proxy_id: bigint | null
  egress_host_uuid: string | null
  /**
   * 反风控锚定:该账号永久绑定的客户端 device_id(64 字符小写 hex)。
   * 由 0067 migration 注入 schema DEFAULT + NOT NULL + CHECK + UNIQUE。
   * anthropicProxy 选号后用此值重写出站 body.metadata.user_id.device_id,
   * 让 Anthropic 网关看到稳定的 "account_uuid ↔ device_id" 一对一绑定。
   */
  pinned_user_id: string
  /**
   * 反风控锚定 Phase 6:该账号在 Anthropic 端的真 OAuth account UUID。
   * 由 0070 migration 加列(初始 NULL,回填脚本 `backfill-account-uuid.ts`
   * 渐进填充)。`null` 语义见 `PHASE6_ACCOUNT_UUID_ENFORCE` 三态:
   *   - off:hook 不跑,字段不被使用(向后兼容)
   *   - fail_open:hook 跑,null 时跳过重写,保留 builder HMAC 占位
   *   - fail_closed:scheduler 已在候选集层面过滤掉 null,不可能返到这里
   *
   * 调用方读取此字段必须配合 `PHASE6_ACCOUNT_UUID_ENFORCE` flag 行为分支。
   */
  account_uuid: string | null
  /**
   * v3 反关联根治 — 该账号绑定的稳定客户端 persona(伪装客户端身份)。
   *
   * 来源:`claude_accounts.persona` 列(0073/0074 migration)。**0073 之后、backfill
   * 之前**的窗口里部分账号可能是 NULL,upstream 层落到 NULL 分支时:
   *   - 不注入 stainless 头(buildSafeUpstreamHeaders allowlist 自然落地 undici 默认)
   *   - log.warn `account_persona_missing`(ops grep 监测 backfill 进度)
   *
   * 0074 SET NOT NULL 后此字段就一定非 null;但 runtime 仍按 `Persona | null` 设计,
   * 防止 schema drift 时强类型崩。
   */
  persona: import('./persona.js').Persona | null
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
  /** pick() 返回的同一 slotId,精确还槽。 */
  slotId: string
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
  /**
   * 注入 per-slot 租约 id 生成器;默认 `crypto.randomUUID()`。
   *
   * **必须与 `ephemeralKey` 分离**:ephemeralKey 是"无 sessionId 时的 WRH key"生成器,
   * 测试里常被注入成确定性函数。slotId 复用它会在同账号并发时 `Map.set` 覆盖 → under-count,
   * 破坏 per-slot 幂等/无别名不变量。本 dep 独立,测试可注入单调计数器保证唯一。
   */
  slotIdFn?: () => string
  /** 注入"当前时间"(用于测试 subscription_end_at 因子);默认 `() => new Date()` */
  now?: () => Date
  /**
   * 单账号同时 in-flight 请求上限。未传则读 `CLAUDE_ACCOUNT_MAX_CONCURRENT`,
   * 再 fallback `DEFAULT_MAX_CONCURRENT_PER_ACCOUNT`(10)。
   */
  maxConcurrent?: number
  /**
   * 泄漏槽 reaper TTL(ms)。未传则读 `ACCOUNT_SLOT_LEASE_TTL_MS`,再 fallback 30min。
   * 经 `sanitizeSlotLeaseTtl` 夹到 [max(CODEX_SESSION_MAX_MS,30min), max(同下界,24h)]。
   */
  slotLeaseTtlMs?: number
  /**
   * 配额感知主动退避阈值(百分比)。未传则读 `CLAUDE_ACCOUNT_QUOTA_BACKOFF_PCT`,
   * 再 fallback `DEFAULT_QUOTA_BACKOFF_PCT`(95)。见 loadCandidates。
   */
  quotaBackoffPct?: number
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
  /**
   * 反风控锚定 Phase 6:OAuth account 真 UUID(0070 migration)。
   * 回填未跑完时为 null;`enforceAccountUuid=true` 时 pick() 会过滤掉 null 候选。
   */
  account_uuid: string | null
  /**
   * v3 反关联根治 — 该账号的稳定客户端 persona JSONB(0073/0074 migration)。
   * SELECT 出来时 pg 把 jsonb 反序列化为 object;0073 之后 0074 NOT NULL 之前可能为 null。
   */
  persona: import('./persona.js').Persona | null
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
   * 单账号 per-slot 租约集 — `accountId → (slotId → acquiredAtMs)`。
   *
   * 取代旧的"匿名计数" `Map<accountId, number>`(B6+B7 根治):
   *   - count(id) = inner.size;cap 判定 O(1)
   *   - acquireSlot(id) 发唯一 slotId + 记 acquiredAtMs;releaseSlot(id, slotId) 精确还槽
   *   - slotId 唯一不复用 → 重复/错配 release 只是幂等 no-op,绝不误伤同账号其它在途租约
   *   - reaper 按 acquiredAtMs 兜底回收"活进程内泄漏"的槽(见 reapExpiredSlots)
   *
   * 一致性边界(B6 技术债):本字段是**进程内**状态,只在同一 AccountScheduler 实例内严格
   * 满足 size(id) ≤ maxConcurrent。多实例(蓝绿/双 master)不汇总 → 真实上限 N×cap。
   * 按 boss 决策**暂不建分布式租约**:双 master 仅在 hot-standby 切机瞬时出现,靠切换 SOP
   * quiesce 账号池兜底。**偿还触发=未来转常态双活**(届时把 slot 后端做成 Redis SETNX+TTL,
   * slotId 即天然分布式租约 key)。详见 docs/B6B7_ACCOUNT_SLOT_LEASE_DESIGN.md §6。
   *
   * TOCTOU 安全:`filter → pickWRH → acquireSlot` 在 pick() 循环内的一个同步块里完成,
   * 中间没有 await —— Node 单线程协作调度下两个并发 pick() 只能在 await 边界
   * 交错,因此硬上限成立。
   */
  private readonly slots = new Map<string, Map<string, number>>()
  /** per-slot 租约 id 生成器(独立于 ephemeralKey,保证唯一)。 */
  private readonly slotIdFn: () => string
  /**
   * 泄漏槽 TTL(ms):reaper 回收 acquiredAt 早于 now-ttl 的租约。
   * 下界 max(CODEX_SESSION_MAX_MS, 30min) 保证永远晚于 Codex bridge 600s timer,不抢跑。
   */
  readonly slotLeaseTtlMs: number
  /** 单账号同时 in-flight 请求上限。 */
  readonly maxConcurrent: number
  /** 配额感知主动退避阈值(百分比);利用率 ≥ 此值的账号剔出候选。 */
  readonly quotaBackoffPct: number

  constructor(deps: SchedulerDeps) {
    this.health = deps.health
    this.keyFn = deps.keyFn ?? loadKmsKey
    this.hash = deps.hash ?? defaultHash
    this.ephemeralKey = deps.ephemeralKey ?? randomUUID
    this.slotIdFn = deps.slotIdFn ?? randomUUID
    this.now = deps.now ?? (() => new Date())
    this.maxConcurrent = sanitizeMaxConcurrent(deps.maxConcurrent)
    this.slotLeaseTtlMs = sanitizeSlotLeaseTtl(deps.slotLeaseTtlMs)
    this.quotaBackoffPct =
      deps.quotaBackoffPct !== undefined &&
      Number.isInteger(deps.quotaBackoffPct) &&
      deps.quotaBackoffPct >= 1 &&
      deps.quotaBackoffPct <= 100
        ? deps.quotaBackoffPct
        : parseQuotaBackoffPctEnv()
  }

  /**
   * 当前 in-flight 计数。测试/监控用;非测试路径不要依赖返回值做判断。
   */
  getInflight(accountId: bigint | string): number {
    return this.slots.get(String(accountId))?.size ?? 0
  }

  /**
   * 同步占一个 slot,返回唯一 slotId。**必须在 pick() 循环的无 await 块内调用**
   * (与旧 incInflight 同位),以保住 TOCTOU 硬上限不变量。
   */
  private acquireSlot(id: string): string {
    let inner = this.slots.get(id)
    if (inner === undefined) {
      inner = new Map<string, number>()
      this.slots.set(id, inner)
    }
    let slotId = this.slotIdFn()
    // 防御(Codex 计划审 nice-to-have):slotIdFn 被错误注入成非唯一时重试至不碰撞,
    // 绝不 Map.set 覆盖既有 slot → under-count。randomUUID 实际碰撞概率可忽略。
    let guard = 0
    while (inner.has(slotId)) {
      if (++guard > 8) {
        throw new Error('acquireSlot: slotIdFn produced colliding ids repeatedly')
      }
      slotId = this.slotIdFn()
    }
    inner.set(slotId, this.now().getTime())
    return slotId
  }

  /** 精确还槽(幂等):删不存在的 slotId 无副作用;inner 空则删账号 entry 防 Map 膨胀。 */
  private releaseSlot(id: string, slotId: string): void {
    const inner = this.slots.get(id)
    if (inner === undefined) return
    inner.delete(slotId)
    if (inner.size === 0) this.slots.delete(id)
  }

  /**
   * Refresh an existing slot lease without changing concurrency. Long-running
   * coding turns use this heartbeat so the orphan reaper cannot reclaim a live
   * slot and accidentally admit another turn on the same subscription account.
   */
  renewCodexSlot(account_id: bigint | string, slotId: string): boolean {
    const inner = this.slots.get(String(account_id))
    if (inner === undefined || !inner.has(slotId)) return false
    inner.set(slotId, this.now().getTime())
    return true
  }

  /**
   * Rehydrate a server-owned durable slot after a browser bridge, Master
   * process, or the generic orphan reaper has forgotten its local mirror.
   * Existing identities are refreshed idempotently; durable truth is restored
   * even when it is already at/above the current configured cap so subsequent
   * allocations fail closed.
   */
  restoreCodexSlot(account_id: bigint | string, slotId: string): void {
    const id = String(account_id)
    let inner = this.slots.get(id)
    if (inner === undefined) {
      inner = new Map<string, number>()
      this.slots.set(id, inner)
    }
    inner.set(slotId, this.now().getTime())
  }

  /**
   * 回收"活进程内泄漏"的槽:acquiredAt 早于 `now - slotLeaseTtlMs` 的租约。返回回收数。
   *
   * **不调 health tracker** —— 超时是 ambiguous(泄漏 or 合法长 turn 已被别处释放只剩残影),
   * 按 transient_network/client_error 既定哲学不扣健康分,只释放容量。聚合回收数由 sweeper
   * (accountSlotReaper)log,供 ops 监测泄漏率。
   *
   * 迭代中 delete 安全:Map 迭代删当前/已访问 key 符合 ECMAScript 规范(只有 add 会有问题)。
   */
  reapExpiredSlots(nowMs: number = this.now().getTime()): number {
    let reaped = 0
    for (const [id, inner] of this.slots) {
      for (const [slotId, acquiredAt] of inner) {
        if (nowMs - acquiredAt > this.slotLeaseTtlMs) {
          inner.delete(slotId)
          reaped += 1
        }
      }
      if (inner.size === 0) this.slots.delete(id)
    }
    return reaped
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
  /**
   * 公共 pick() facade — 内部跑 retry budget:
   *
   *   1. 调 pickOnce(input) 跑一次完整的 prelude → WRH → postlude
   *   2. 若拿到 SessionPinTemporarilyUnavailableError(503):
   *       - retryAfterMs === 0 → 立刻重试(immediateRetries 计数,上限 3 防活锁)
   *       - retryAfterMs <= SHORT_BACKOFF_MS 且总等待 + remain <= HARD_TIMEOUT_MS
   *         → 内部 sleep(remain) 后重试(用户感知:慢一次 = OK)
   *       - 否则 → 把 error 抛出去,让 HTTP 层下发 Retry-After 让客户端 backoff
   *   3. 其它任何 error → 直接抛
   *
   * 设计动机(boss "反风控不能以牺牲用户体验为代价"):
   *   短 cooldown(typically 1-3 秒)在 server 内部吃掉,客户端只感觉到"这一轮慢";
   *   长 cooldown 才把 Retry-After 透到客户端,避免持有连接超时。这是把 anti-fraud
   *   切换成本吸收到 backend 而不是甩给用户的核心闭环。
   */
  async pick(input: PickInput): Promise<PickResult> {
    /** server 内部最长 sleep 长度;超过此值就把控制权交还给客户端走 Retry-After。 */
    const SHORT_BACKOFF_MS = 3000
    /** pick() 总耗时上限(含 sleep + DB 往返);超过就 throw,防 HTTP 连接超时。 */
    const HARD_TIMEOUT_MS = 5000
    /** retryAfterMs=0 路径的硬上限,防 server 内 active-loop spin。 */
    const MAX_IMMEDIATE_RETRIES = 3
    /**
     * immediate-retry 耗尽后透给客户端的最小 retryAfterMs(1 秒)。
     *
     * 不能继续抛 retryAfterMs=0:HTTP 层会把 0 写进 body 的 retry_after_ms 字段,
     * 客户端拿到"retry_after_ms: 0"很可能立刻 busy-retry,等于把 server 的 spin loop
     * 转嫁给客户端,绕过我们 MAX_IMMEDIATE_RETRIES 的活锁防护。归一成 1s 给前端
     * 一次"喘一口气再试"的明确信号,符合 boss "反风控不能以牺牲用户体验为代价"。
     */
    const IMMEDIATE_EXHAUSTED_HINT_MS = 1000
    const start = this.now().getTime()
    let immediateRetries = 0
    while (true) {
      try {
        return await this.pickOnce(input)
      } catch (err) {
        if (!(err instanceof SessionPinTemporarilyUnavailableError)) throw err
        const remain = err.retryAfterMs
        if (remain === 0) {
          // 账号"几乎可用"(ready / cooldown_until 已过)— short-spin retry
          // 用真实计数器而非 elapsed 判定,防 fake clock 测试或 sleep 实现失真。
          if (immediateRetries >= MAX_IMMEDIATE_RETRIES) {
            // 归一 retryAfterMs:0 → 1000ms,防客户端拿到 retry_after_ms=0 busy-retry
            throw new SessionPinTemporarilyUnavailableError(
              `${err.message} (immediate retries exhausted, falling back to client retry)`,
              IMMEDIATE_EXHAUSTED_HINT_MS,
            )
          }
          immediateRetries += 1
          await sleep(10)
          continue
        }
        const elapsed = this.now().getTime() - start
        if (remain <= SHORT_BACKOFF_MS && elapsed + remain <= HARD_TIMEOUT_MS) {
          // 短 cooldown 内部吃掉,用户端感知只是慢一次
          await sleep(remain)
          continue
        }
        // 长 cooldown / 已用完预算 → 把 503 透到客户端
        throw err
      }
    }
  }

  /**
   * pick() 的单次原子尝试:走完 prelude → WRH → postlude 不跑 retry budget。
   *
   * 抛 SessionPinTemporarilyUnavailableError 时由外层 pick() facade 判定是 sleep
   * retry 还是透传给 HTTP 层。其它错误一律向上传递。
   *
   * `forceRepin=true` 路径:
   *   - 跳过 readPin(不管 csap.status=unbound 还是 active 都不读,统一当 pin miss)
   *   - postlude 用 `INSERT ... ON CONFLICT DO UPDATE SET status='active' WHERE
   *     chat_session_account_pin.status='unbound'` —— 只接受"unbound→active"翻转,
   *     active 行不动(让"用户已经 pinned 到 X 想强切"的 noop 路径仍保留 sticky)。
   *
   * @throws `AccountPoolUnavailableError` 当无 active 账号 / 全部候选都失效
   * @throws `TypeError` 当 `mode=agent` 缺 sessionId
   */
  private async pickOnce(input: PickInput): Promise<PickResult> {
    if (input.mode === 'agent') {
      if (!input.sessionId || input.sessionId.length === 0) {
        throw new TypeError('sessionId required when mode=agent')
      }
    } else if (input.mode !== 'chat') {
      throw new TypeError(`unknown mode: ${String(input.mode)}`)
    }

    const provider: AccountProvider = input.provider ?? 'claude'
    const enforceAccountUuid = input.enforceAccountUuid === true
    // pin 三态归一化:enforce/observe 缺 userId 或 sessionId → 自动降级 off + warn
    // (不抛错;让旧 caller 路径继续工作,缺参数视为没启用 pin)
    const pinMode = this.resolvePinMode(input)
    // forceRepin 仅在 enforce 路径有意义,其它模式静默忽略
    const forceRepin = input.forceRepin === true && pinMode === 'enforce'

    const allActive = await this.selectActiveCandidates(provider, input.groupId ?? null)
    if (allActive.length === 0) {
      throw new AccountPoolUnavailableError('no_active')
    }
    // Phase 6 H6 候选过滤:fail_closed 模式下排除 account_uuid IS NULL 的脏数据,
    // 防止外接 ApiKey 路径上 metadata.account_uuid 跟 OAuth account 真 uuid 错位。
    // off / fail_open 模式不过滤(builder HMAC 占位会兜底)。
    const pool: CandidateRow[] = enforceAccountUuid
      ? allActive.filter((c) => c.account_uuid !== null)
      : allActive
    if (pool.length === 0) {
      // 必为 enforceAccountUuid=true 路径(allActive>0 但 eligible=0)
      throw new AccountPoolUnavailableError('no_uuid')
    }

    // ─────────────────────────────────────────────────────────────────
    // Pin prelude (enforce/observe 模式;off / forceRepin 整段跳过)
    //
    // 读 chat_session_account_pin (userId, sessionId):
    //   - enforce + status=unbound → 抛 SessionPinUnboundError(409,前端 reset)
    //   - enforce + status=active  → 直接用 pin.account_id,不走 WRH(强 sticky)
    //     · 若该 account 不在 active pool → handlePinnedAccountUnavailable
    //   - enforce + pin missing    → 走"既往足迹优先"WRH,选完用 INSERT race-safe pin
    //   - observe                  → 不强制走 pin,只在选完后对比 WRH 结果 vs pin 命中
    //                                打 metric;不写 csap
    //   - forceRepin               → 跳过整段 prelude,统一当 pin miss 走反扩散 WRH;
    //                                postlude 用 DO UPDATE 翻 unbound→active
    // ─────────────────────────────────────────────────────────────────
    let pin: { account_id: bigint; status: 'active' | 'unbound' } | null = null
    if (pinMode !== 'off' && !forceRepin) {
      // pinMode != 'off' 路径已在 resolvePinMode 保证 userId+sessionId 双备
      pin = await this.readPin(input.userId!, input.sessionId!)
      if (pinMode === 'enforce') {
        if (pin?.status === 'unbound') {
          throw new SessionPinUnboundError()
        }
        if (pin?.status === 'active') {
          // 强 sticky:绕过 WRH 直接选这个账号
          const pinned = await this.pickPinnedAccount(pin.account_id, pool)
          if (pinned !== null) return pinned
          // pool 里没有这个 account — 必须区分终态(cascade self-heal + 409)和
          // 瞬时态(503 with retryAfterMs)。统一走 handlePinnedAccountUnavailable。
          await this.handlePinnedAccountUnavailable(
            input.userId!,
            input.sessionId!,
            pin.account_id,
            'pin_hit',
          )
          // 上面 helper 一定 throw — 此 return 不会执行,只为类型收敛
          throw new Error('unreachable')
        }
        // enforce + pin miss → fall through to WRH 但选号集要"既往足迹优先"
      }
      // observe: pin 留着,选完打 metric;不影响 WRH 路径
    }

    // ─────────────────────────────────────────────────────────────────
    // WRH 候选集:enforce + (pin miss || forceRepin) 时优先"用户既往足迹账号"(反扩散)。
    //
    // 设计动机(boss "降低风控风险" requirement):
    //   该 user 既然之前用过 account A/B,Anthropic 早把这些账号跟该用户的对话历史
    //   联系起来了;现在 A/B 都死了 → 用户走 force_repin 在同 session 继续 → 我们应该优先在 A/B/...
    //   这些"已暴露给用户"的账号里选,而**不是**把对话历史新鲜扩散到一个干净账号上。
    //
    //   只在"用户既往足迹账号仍有 active 子集"时缩窄候选;若 history ∩ pool = ∅
    //   (这个用户的所有账号都死了),退化到整个 pool — 不能让用户卡死。
    // ─────────────────────────────────────────────────────────────────
    let wrhPool: CandidateRow[] = pool
    if (pinMode === 'enforce' && (pin === null || forceRepin)) {
      const historyIds = await this.readUserHistoryAccountIds(input.userId!)
      if (historyIds.size > 0) {
        const filtered = pool.filter((c) => historyIds.has(BigInt(c.id)))
        if (filtered.length > 0) wrhPool = filtered
        // else: 既往足迹账号全都死了 → 退化到全池(不能让用户没号可用)
      }
      // else: 这个用户在 csap 里没历史(首次 chat) → 用全池
    }

    // WRH key:有 sessionId 走强 sticky;没有则生成一次性 randomUUID(分布上仍按
    // weight 加权,等价旧 chat 模式语义)。**整个 pick() 调用共享同一个 key**,
    // 这样下面重选循环(vanish/AEAD quarantine)在剩余候选集里仍是稳定的。
    const wrhKey = input.sessionId && input.sessionId.length > 0
      ? input.sessionId
      : this.ephemeralKey()

    const result = await this.runWRHLoop(wrhPool, wrhKey)

    // ─────────────────────────────────────────────────────────────────
    // Pin postlude
    //
    //   - enforce + pin miss:race-safe INSERT(ON CONFLICT DO NOTHING)。
    //     · 若 INSERT 命中(我们是 winner):直接返回 result
    //     · 若 ON CONFLICT(并发请求已抢先 INSERT):读取 winner,**释放**当前 result,
    //       尝试切到 winner 的账号。winner 不在 pool → 503 retry。
    //   - enforce + forceRepin:INSERT ... ON CONFLICT DO UPDATE WHERE status='unbound'
    //     (只接受 unbound→active 翻转)。同样 race-aware:
    //     · winner === attempted → 我们的 result 生效
    //     · winner ≠ attempted → release self,切到 winner
    //   - observe:不写 csap,只对比 WRH 选择跟 pin(如果有)是否一致,打 metric。
    //   - off:无 postlude。
    // ─────────────────────────────────────────────────────────────────
    if (pinMode === 'enforce' && (pin === null || forceRepin)) {
      // 必须包 try/catch:writePinOnMissOrReadWinner / writePinForceRepinOrReadWinner
      // 在 winner.status='unbound' 或 INSERT race ambiguous 时会 throw — 外层若不
      // release,持有的 result 会泄漏 inflight 计数 + 已解密 token buffer。
      let winner: bigint
      try {
        winner = forceRepin
          ? await this.writePinForceRepinOrReadWinner(
              input.userId!,
              input.sessionId!,
              result.account_id,
            )
          : await this.writePinOnMissOrReadWinner(
              input.userId!,
              input.sessionId!,
              result.account_id,
            )
      } catch (err) {
        this.releasePickResult(result)
        throw err
      }
      if (winner === result.account_id) {
        return result
      }
      // race lost — 切换到 winner
      this.releasePickResult(result)
      const switched = await this.pickPinnedAccount(winner, pool)
      if (switched !== null) return switched
      // race-winner 也不在 pool — 进 handlePinnedAccountUnavailable(可能 terminal
      // self-heal → 409,可能 transient → 503 with retryAfterMs)。
      await this.handlePinnedAccountUnavailable(
        input.userId!,
        input.sessionId!,
        winner,
        'race_lost',
      )
      throw new Error('unreachable')
    }
    if (pinMode === 'observe') {
      // best-effort metric;吞错防止影响主路径
      void this.observePinConsistency(
        input.userId!,
        input.sessionId!,
        result.account_id,
        pin,
      ).catch(() => {
        /* metric only, never block pick */
      })
    }
    return result
  }

  /**
   * pin 命中但账号不在 active pool(或 race-winner 同理)时的统一决策点:
   *
   *   1. 读 claude_accounts.status + cooldown_until — 拿 AccountRecoveryHint
   *   2. terminal('banned'/'disabled') → self-heal:把该账号所有 active csap 行翻
   *      'unbound'(等价于 store 端 cascade 但发生在读路径,关闭 race window),
   *      然后抛 SessionPinUnboundError(409 reset_session)。
   *      ※ HTTP 层把 SessionPinUnboundError 翻译成 409 + retry_strategy='force_repin',
   *      新前端会自动重发带 x-force-repin:1 关闭 UX 循环。
   *   3. transient('cooldown') → 抛 SessionPinTemporarilyUnavailableError(retryAfterMs=
   *      cooldown_until - now)。pick() facade 内部短 sleep 重试或透到客户端 Retry-After。
   *   4. ready('active' / null) → retryAfterMs=0 — pick() facade immediateRetries 接住。
   *
   * @throws SessionPinUnboundError | SessionPinTemporarilyUnavailableError(永远 throw)
   */
  private async handlePinnedAccountUnavailable(
    userId: bigint,
    sessionId: string,
    accountId: bigint,
    context: 'pin_hit' | 'race_lost',
  ): Promise<never> {
    const hint: AccountRecoveryHint | null = await readAccountRecoveryHint(
      accountId,
      this.now,
    )
    if (hint?.kind === 'terminal') {
      // Self-heal:race window — accounts.status='banned' 已经 cascade 过 csap,但
      // 若此 csap 是 mid-INSERT 后插入 / 跨 tx race,可能仍 active。这里幂等 UPDATE
      // 单行(由 user_id+session_id PK 锁住),保证下一次同 session 不会再走 active-pin
      // 路径打到同 banned 账号。
      //
      // ※ `account_id = $3` 至关重要:防 race —— 假设本次 pick 观测到 active pin = A
      // 是 terminal,但在 pick → here 之间并发请求已经把 csap 翻成 unbound 并 force_repin
      // 到 active B,这里若只按 (user_id, session_id, active) 匹配会把 B 误杀。
      // 加 account_id 让 self-heal 只翻"我看到的那个 terminal 绑定"。
      try {
        await query(
          `UPDATE chat_session_account_pin
              SET status = 'unbound', updated_at = NOW()
            WHERE user_id = $1
              AND session_id = $2
              AND status = 'active'
              AND account_id = $3`,
          [userId, sessionId, accountId],
        )
      } catch {
        /* best-effort;失败时下次 pick 仍会再次走到这里再 self-heal */
      }
      throw new SessionPinUnboundError(
        `pin account ${accountId} terminal (status=${hint.status}); csap self-healed to 'unbound' (${context})`,
      )
    }
    if (hint?.kind === 'transient') {
      throw new SessionPinTemporarilyUnavailableError(
        `pinned account ${accountId} in cooldown; retry after ${hint.retryAfterMs}ms (${context})`,
        hint.retryAfterMs,
      )
    }
    // ready (account=active 但 pool 里没看到 / inflight cap)或 null(账号被删 race):
    // retryAfterMs=0,让 pick() facade 走 immediateRetries 路径短 spin。
    throw new SessionPinTemporarilyUnavailableError(
      `pinned account ${accountId} not in active pool but status=ready (likely inflight cap or pool-refresh race); retry (${context})`,
      0,
    )
  }

  /**
   * pin 模式归一化:enforce/observe 缺 userId 或 sessionId → 降级 off + warn。
   *
   * 为什么是"降级"而不是"抛错":
   *   pin 是新功能,灰度发布时旧 caller 暂未穿线 userId/sessionId 也要能跑;
   *   缺参数在生产里至多丢失"反扩散收益",不应让用户对话直接 5xx。
   *   warn 日志让灰度期可以 ops grep 检测哪些 caller 还没改造。
   */
  private resolvePinMode(input: PickInput): SessionPinMode {
    const requested = input.pinMode ?? 'off'
    if (requested === 'off') return 'off'
    const hasUser = input.userId !== undefined
    const hasSession = input.sessionId !== undefined && input.sessionId.length > 0
    if (!hasUser || !hasSession) {
      // eslint-disable-next-line no-console -- warn-only, ops 灰度可见性
      console.warn(
        `[scheduler.pick] pinMode=${requested} requested but userId=${
          hasUser ? '✓' : '✗'
        } sessionId=${hasSession ? '✓' : '✗'} — degrading to 'off'`,
      )
      return 'off'
    }
    return requested
  }

  /** 从 claude_accounts 取 active 候选 — 抽出来便于 pick() / observe 路径共享 */
  private async selectActiveCandidates(
    provider: AccountProvider,
    groupId: bigint | string | null,
  ): Promise<CandidateRow[]> {
    const params: unknown[] = [provider]
    const where = ["status = 'active'", 'provider = $1']
    if (groupId !== null) {
      params.push(String(groupId))
      where.push(`group_id = $${params.length}`)
    }
    if (provider === 'codex' || provider === 'grok') {
      params.push(provider === 'codex' ? getCodexAccountRuntimeChannel() : getRuntimeChannel())
      where.push(`runtime_channel = $${params.length}`)
    }
    // 反封复盘 2026-08 — 配额感知主动退避:5h / 7d 利用率达到阈值的账号直接剔除候选,
    // 歇到窗口滚动恢复(pct 由响应头回落),而不是被 WRH 低权重选中后一路打到 429。
    // NULL(未上报)保留在池内。pin-hit 命中被剔除账号 → pickPinnedAccount 返 null →
    // handlePinnedAccountUnavailable 走 ready→503 retry(不再把请求推到已耗尽账号)。
    params.push(this.quotaBackoffPct)
    const pctIdx = params.length
    where.push(
      `(quota_5h_pct IS NULL OR quota_5h_pct < $${pctIdx})`,
      `(quota_7d_pct IS NULL OR quota_7d_pct < $${pctIdx})`,
    )
    const res = await query<CandidateRow>(
      `SELECT id::text AS id, plan, health_score,
              quota_5h_pct, quota_7d_pct, subscription_end_at,
              pinned_user_id,
              account_uuid::text AS account_uuid,
              persona
       FROM claude_accounts
       WHERE ${where.join(' AND ')}
       ORDER BY id`,
      params,
    )
    return res.rows
  }

  /**
   * 跑 WRH + inflight cap + vanished/AEAD quarantine 重选循环。
   *
   * 整个老 pick() 的核心,搬到 helper 让 pick() 的 pin 控制流读起来清晰。
   *
   * @throws `AccountPoolBusyError` 当所有候选都 inflight cap
   * @throws `AccountPoolUnavailableError` 当候选被 vanish/AEAD 掏空
   */
  private async runWRHLoop(
    initialPool: CandidateRow[],
    wrhKey: string,
  ): Promise<PickResult> {
    const now = this.now()
    let pool = initialPool
    let vanished = 0
    let quarantined = 0
    while (pool.length > 0) {
      const available = pool.filter(
        (c) => (this.slots.get(c.id)?.size ?? 0) < this.maxConcurrent,
      )
      if (available.length === 0) break

      const chosen = pickWRH(available, wrhKey, now, this.hash)
      // 同步 reserve 槽位 —— 必须在下一个 await(getTokenForUse)之前完成
      const slotId = this.acquireSlot(chosen.id)
      try {
        // requireActiveStatus: 把"select active pool → token decrypt"之间被另一
        // 进程 ban/disabled 的账号在 SQL 层即 fail-closed → null。null 路径继续走
        // vanished 计数 + 剔除再选(语义与"账号被删"统一)。
        const tok = await getTokenForUse(chosen.id, this.keyFn, {
          requireActiveStatus: true,
        })
        if (tok) {
          return {
            account_id: BigInt(chosen.id),
            slotId,
            plan: tok.plan,
            token: tok.token,
            refresh: tok.refresh,
            expires_at: tok.expires_at,
            egress_proxy: tok.egress_proxy,
            egress_target: tok.egress_target,
            egress_proxy_id: tok.egress_proxy_id,
            egress_host_uuid: tok.egress_host_uuid,
            pinned_user_id: chosen.pinned_user_id,
            account_uuid: chosen.account_uuid,
            persona: chosen.persona,
          }
        }
        // 账号在 SELECT 和 readToken 之间被并发删/ban/disabled,剔除再选
        this.releaseSlot(chosen.id, slotId)
        vanished += 1
        pool = pool.filter((c) => c.id !== chosen.id)
      } catch (err) {
        this.releaseSlot(chosen.id, slotId)
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
      `drained: vanished=${vanished} (deleted between SELECT and readToken), ` +
        `aead_quarantined=${quarantined} (decryption failed → auto-disabled)`,
    )
  }

  /**
   * 读 chat_session_account_pin —— pin 命中 enforce 路径的强 sticky 锚。
   *
   * 返回 null = 没记录(首次 chat / 新 session);
   *      {status:'active'}  = 历史 pin 仍有效;
   *      {status:'unbound'} = pin 已 cascade unbind(账号被 ban),enforce 模式抛 409。
   */
  private async readPin(
    userId: bigint,
    sessionId: string,
  ): Promise<{ account_id: bigint; status: 'active' | 'unbound' } | null> {
    const res = await query<{ account_id: string; status: 'active' | 'unbound' }>(
      `SELECT account_id::text AS account_id, status
       FROM chat_session_account_pin
       WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    )
    if (res.rows.length === 0) return null
    const row = res.rows[0]
    return { account_id: BigInt(row.account_id), status: row.status }
  }

  /**
   * 读取该用户**既往足迹账号** — 反扩散的关键。
   *
   * pin miss 时优先在这些账号里选号;若全死,退化到整池。
   * 返回 Set<bigint> 而非 Array,O(1) 候选过滤。
   *
   * 只读 status='active' 的 csap 行?**不**:unbound 也算"已暴露给该用户",
   * Anthropic 已经把这个用户的对话历史跟该 account 关联了。我们要避免的是
   * 把历史 spread 到"该用户从未碰过的干净账号",所以 unbound 行也要算进 history。
   */
  private async readUserHistoryAccountIds(userId: bigint): Promise<Set<bigint>> {
    const res = await query<{ account_id: string }>(
      `SELECT DISTINCT account_id::text AS account_id
       FROM chat_session_account_pin
       WHERE user_id = $1`,
      [userId],
    )
    return new Set(res.rows.map((r) => BigInt(r.account_id)))
  }

  /**
   * 给定一个目标 account_id,直接在候选池里选它(绕过 WRH);用于 pin hit
   * 或 race-lost 切换路径。
   *
   * 注意:仍要走 inflight cap 检查 + 解密 token + AEAD 失败兜底;只是不跑 WRH。
   *
   * 返回 null 表示该 account 当前不在 pool / 解密失败 / cap 命中,调用方决策
   * 是抛 SessionPinTemporarilyUnavailableError 还是 fall through。
   */
  private async pickPinnedAccount(
    targetId: bigint,
    pool: CandidateRow[],
  ): Promise<PickResult | null> {
    const targetIdStr = targetId.toString()
    const chosen = pool.find((c) => c.id === targetIdStr)
    if (chosen === undefined) return null
    if ((this.slots.get(chosen.id)?.size ?? 0) >= this.maxConcurrent) return null

    // 同步 reserve 槽位 —— 与 runWRHLoop 同位,await(getTokenForUse)前完成
    const slotId = this.acquireSlot(chosen.id)
    try {
      // requireActiveStatus: 同 runWRHLoop 路径 — pin hit 不能拿已 ban/disabled
      // 账号的 token。null → 上层判定 SessionPinTemporarilyUnavailable / fall through。
      const tok = await getTokenForUse(chosen.id, this.keyFn, {
        requireActiveStatus: true,
      })
      if (!tok) {
        this.releaseSlot(chosen.id, slotId)
        return null
      }
      return {
        account_id: BigInt(chosen.id),
        slotId,
        plan: tok.plan,
        token: tok.token,
        refresh: tok.refresh,
        expires_at: tok.expires_at,
        egress_proxy: tok.egress_proxy,
        egress_target: tok.egress_target,
        egress_proxy_id: tok.egress_proxy_id,
        egress_host_uuid: tok.egress_host_uuid,
        pinned_user_id: chosen.pinned_user_id,
        account_uuid: chosen.account_uuid,
        persona: chosen.persona,
      }
    } catch (err) {
      this.releaseSlot(chosen.id, slotId)
      if (err instanceof AeadError) {
        void updateAccount(
          chosen.id,
          {
            status: 'disabled',
            last_error: `AEAD decryption failed at pickPinnedAccount(): ${err.message}`.slice(0, 500),
          },
          this.keyFn,
        ).catch(() => {})
        return null
      }
      throw err
    }
  }

  /**
   * Race-safe pin INSERT:
   *   - 我们是第一个 → INSERT 命中,返回 attempted accountId
   *   - 并发 caller 已抢先 INSERT → ON CONFLICT DO NOTHING(0 rows),
   *     回头读已存在的 winner accountId + status 返回
   *
   * 调用方比较 winner === attempted 判定 race 输赢;同时检查 status:
   *   - 'active' → 切到 winner 账号
   *   - 'unbound' → 抛 SessionPinUnboundError(409 reset_session)
   *
   * status 防御性兜底(Codex 终审 WARN 3):正常流水线 readPin 已经在
   * 顶端拦住 unbound 行,不应再走到 INSERT 路径;但如果未来逻辑变化
   * 或并发模型变(pick 流水线被拆/cascade 改 INSERT 等),让 winner-read
   * 一并读 status 可以避免"已 unbound 行被当成 active winner 继续服务"
   * 的二阶 bug。代价仅一个 SELECT 多读一列。
   */
  private async writePinOnMissOrReadWinner(
    userId: bigint,
    sessionId: string,
    attempted: bigint,
  ): Promise<bigint> {
    const ins = await query<{ account_id: string }>(
      `INSERT INTO chat_session_account_pin (user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id, session_id) DO NOTHING
       RETURNING account_id::text AS account_id`,
      [userId, sessionId, attempted],
    )
    if (ins.rows.length > 0) {
      return BigInt(ins.rows[0].account_id)
    }
    // race lost — 读取 winner + status
    const sel = await query<{ account_id: string; status: 'active' | 'unbound' }>(
      `SELECT account_id::text AS account_id, status
       FROM chat_session_account_pin
       WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    )
    if (sel.rows.length === 0) {
      // 极罕见:INSERT race 期间 winner 又被并发 DELETE。视为暂时不可用让前端 retry。
      // retryAfterMs=0 → pick() facade immediateRetries 路径接住,不让客户端拿到
      // Retry-After=0 这种奇怪值。
      throw new SessionPinTemporarilyUnavailableError(
        `pin INSERT race ambiguous: ON CONFLICT but no row visible on read`,
        0,
      )
    }
    const row = sel.rows[0]
    if (row.status === 'unbound') {
      // 已 cascade 解绑:不能把 caller 切到这个 winner(账号已死),触发前端 409 重置。
      throw new SessionPinUnboundError(
        `pin race-winner exists but status='unbound' (account banned/disabled mid-INSERT)`,
      )
    }
    return BigInt(row.account_id)
  }

  /**
   * forceRepin 专用 race-safe pin upsert:
   *   - INSERT 一行 status='active'
   *   - ON CONFLICT (user_id, session_id) DO UPDATE SET status='active', account_id=EXCLUDED
   *     **WHERE chat_session_account_pin.status='unbound'**
   *   - 命中三种情况之一:
   *       a) 我们是 winner:INSERT 命中或 UPDATE 命中(已 unbound 翻为 active)→ 返回 attempted
   *       b) WHERE 不匹配(行已 active,可能是被并发 force_repin 抢先翻或本来就 active)→
   *          DO UPDATE 0 rows,RETURNING 空 → 我们 race-lost。回头读 winner + status:
   *           - active → 切到 winner
   *           - unbound → 不可能(WHERE 已过滤),防御性当 SessionPinUnboundError
   *
   * 跟 writePinOnMissOrReadWinner 的关键差异:
   *   - writePinOnMissOrReadWinner 用 DO NOTHING,期望"无 row 存在"才插
   *   - 这个用 DO UPDATE … WHERE status='unbound',期望"row 存在但是 unbound"也接管
   *   - 两个 path 都把 winner 决议交给 RETURNING,保证 race-safe
   */
  private async writePinForceRepinOrReadWinner(
    userId: bigint,
    sessionId: string,
    attempted: bigint,
  ): Promise<bigint> {
    const ins = await query<{ account_id: string; is_insert: boolean }>(
      `INSERT INTO chat_session_account_pin (user_id, session_id, account_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id, session_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             status = 'active',
             updated_at = NOW()
         WHERE chat_session_account_pin.status = 'unbound'
       RETURNING account_id::text AS account_id, (xmax = 0) AS is_insert`,
      [userId, sessionId, attempted],
    )
    if (ins.rows.length > 0) {
      // INSERT 命中(xmax=0)或 UPDATE 命中(WHERE status='unbound' 翻成 active);
      // 两条路径都返回我们 attempted 的 account_id。
      return BigInt(ins.rows[0].account_id)
    }
    // RETURNING 空 = INSERT 走 CONFLICT 路径但 WHERE 不匹配,说明:
    //   - 该 (user, session) 行已 active(被并发 force_repin 抢先,或本来就 active)
    //     → race-lost,读 winner 切过去
    //   - 或读路径自己刚把它 self-heal 到 unbound 但行又被并发 force_repin 翻回 active
    //     (同语义,仍是 race-lost)
    const sel = await query<{ account_id: string; status: 'active' | 'unbound' }>(
      `SELECT account_id::text AS account_id, status
       FROM chat_session_account_pin
       WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    )
    if (sel.rows.length === 0) {
      // 极罕见 race:CONFLICT 后行又被并发 DELETE。retryAfterMs=0 → immediateRetries 接住。
      throw new SessionPinTemporarilyUnavailableError(
        `force_repin upsert race ambiguous: CONFLICT but no row visible on read`,
        0,
      )
    }
    const row = sel.rows[0]
    if (row.status === 'unbound') {
      // 防御性:WHERE status='unbound' 应该已经过滤进 UPDATE,理论不会读到 unbound row。
      // 防未来 schema/逻辑漂移留个 actionable error。
      throw new SessionPinUnboundError(
        `force_repin reached unbound row that WHERE clause should have UPDATE'd; possible cascade race`,
      )
    }
    return BigInt(row.account_id)
  }

  /**
   * 释放一个已 pick 但不会被上层 release() 处理的 PickResult。
   *
   * 用于 race-lost 切换:当 caller 决定切到 winner 账号时,**手里这个**结果(losers)
   * 已经 acquireSlot + 解密了 token,但不会真发请求 → 必须按 slotId 还槽 + 销毁 token,
   * 防止泄漏。
   *
   * 不调 health tracker(没真发请求,onSuccess/onFailure 都不应触发)。
   */
  private releasePickResult(r: PickResult): void {
    this.releaseSlot(r.account_id.toString(), r.slotId)
    r.token.fill(0)
    r.refresh?.fill(0)
  }

  /**
   * Observe 模式 metric:WRH 选择 vs pin 命中是否一致。
   *
   * 用于 enforce 上线前灰度阶段评估:
   *   - "pin 在 active 池里跟 WRH 一致" → enforce 不会改变行为
   *   - "pin 跟 WRH 不一致" → enforce 后会强 sticky 到 pin,流量分布会变
   *   - "pin miss" → enforce 后会写 pin,首次 chat 行为不变
   *
   * 失败吞错(可能 DB 短暂闪断),不应阻断主路径。
   */
  private async observePinConsistency(
    _userId: bigint,
    _sessionId: string,
    wrhChoice: bigint,
    pin: { account_id: bigint; status: 'active' | 'unbound' } | null,
  ): Promise<void> {
    let outcome: 'pin_miss' | 'pin_unbound' | 'consistent' | 'divergent'
    if (pin === null) outcome = 'pin_miss'
    else if (pin.status === 'unbound') outcome = 'pin_unbound'
    else if (pin.account_id === wrhChoice) outcome = 'consistent'
    else outcome = 'divergent'
    // metric: 通过 console 日志注入 — ops scrape 用关键字 session_pin_observe
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        evt: 'session_pin_observe',
        outcome,
        wrh_account: wrhChoice.toString(),
        pin_account: pin?.account_id.toString() ?? null,
        pin_status: pin?.status ?? null,
      }),
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
   *     await scheduler.release({account_id:p.account_id, slotId:p.slotId, result:{kind:"success"}});
   *   } catch (err) {
   *     await scheduler.release({
   *       account_id:p.account_id,
   *       slotId:p.slotId,
   *       result:{kind:"failure", error:String(err)},
   *     });
   *     throw err;
   *   } finally {
   *     p.token.fill(0); p.refresh?.fill(0);
   *   }
   *   ```
   */
  async release(input: ReleaseInput): Promise<void> {
    // 先按 slotId 精确还槽(幂等,健康 tracker 抛错也不能让 slot 永久占用)
    this.releaseSlot(String(input.account_id), input.slotId)
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
   *   - 仅按 maxConcurrent 卡 slot 数
   *
   * 调用契约:
   *   - 每条 codex inbound 独立成对调用 acquire / release(plan G7 严格单飞)
   *   - **返回 slotId,release 必须原样回传**(精确还槽,且让 reaper 兜底泄漏)
   *   - 抛 AccountPoolBusyError → bridge 转 error 帧 fast-fail,不 fallback
   *
   * @throws `AccountPoolBusyError` 当 slot 数 >= maxConcurrent
   */
  acquireCodexSlot(account_id: bigint | string): string {
    const id = String(account_id)
    const cur = this.slots.get(id)?.size ?? 0
    if (cur >= this.maxConcurrent) {
      throw new AccountPoolBusyError(
        `codex account ${id} at per-account concurrency cap (max=${this.maxConcurrent})`,
      )
    }
    // 与 pick() 同步块语义一致 —— 当前 fn 是 sync,确实在 await 边界之外完成
    return this.acquireSlot(id)
  }

  /**
   * 释放一个 codex per-account 并发槽(按 slotId 精确还,幂等)。
   *
   * 不调 health.onSuccess / onFailure(plan 决策 J2:bridge 用真实 turn 出参
   * 决定健康分,不在这里挂)。
   */
  releaseCodexSlot(account_id: bigint | string, slotId: string): void {
    this.releaseSlot(String(account_id), slotId)
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
  /** Optional official_oauth+codex group filter. */
  groupId?: bigint | string | null
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
  return pickOfficialOAuthAccountForBindingInTx(client, 'codex', sessionId, deps)
}

export async function pickOfficialOAuthAccountForBindingInTx(
  client: PoolClient,
  provider: 'codex' | 'grok',
  sessionId: string,
  deps: PickCodexBindingDeps = {},
): Promise<PickedCodexBinding | null> {
  if (!sessionId || sessionId.length === 0) {
    throw new TypeError('sessionId required for pickCodexAccountForBindingInTx')
  }
  const hash = deps.hash ?? defaultHash

  const params: unknown[] = []
  const where = ["status = 'active'", `provider = $1`]
  params.push(provider)
  // 0098 channel 划分(M1b):codex 账号池权威按 runtime_channel 归属,picker 使用 Codex account-pool channel。
  // 默认仍是本 runtime channel；设置 OC_CODEX_ACCOUNT_RUNTIME_CHANNEL=v5 时,
  // v3 容器可消费 v5-owned 账号池,但容器 runtime_channel 不随之改变。
  params.push(provider === 'codex' ? getCodexAccountRuntimeChannel() : getRuntimeChannel())
  where.push(`runtime_channel = $${params.length}`)
  if (deps.groupId !== undefined && deps.groupId !== null) {
    params.push(String(deps.groupId))
    where.push(`group_id = $${params.length}`)
  }

  const res = await client.query<{ id: string; plan: AccountPlan; health_score: number }>(
    `SELECT id::text AS id, plan, health_score
     FROM claude_accounts
     WHERE ${where.join(' AND ')}
     ORDER BY id`,
    params,
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
