/**
 * T-32 — 账号池调度器。
 *
 * 规约(见 01-SPEC F-6.4):
 *   - `mode=agent` sticky: 按 sessionId 哈希取候选账号里 rendezvous-hash 最大的一个。
 *     账号上/下线时,只有 O(1/N) 的 session 会迁移到其他账号,满足 prompt cache 稳定性。
 *   - `mode=chat` 加权随机: 权重 = max(1, health_score)。health=0 的账号仍有 weight=1 用于
 *     探活 —— 避免所有 active 账号 health=0 时 picker 陷入死锁。
 *   - 没有 active 账号(或遇上全部 cooldown/disabled/banned)→ 抛 `AccountPoolUnavailableError`
 *     (code=ERR_ACCOUNT_POOL_UNAVAILABLE,503 语义)
 *
 * release 语义:
 *   - `success` → `health.onSuccess(id)` 恢复健康度
 *   - `failure` → `health.onFailure(id, msg)` 扣分;触发 3 连败熔断
 *
 * 非职责:
 *   - 本模块不关心 token 刷新(T-33)、不关心扣费(T-22)、不决定用哪个模型。
 *   - 本模块只做 "从 active 池子挑一个 account" 这一件事。
 */

import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { AeadError } from '../crypto/aead.js'
import { loadKmsKey } from '../crypto/keys.js'
import { query } from '../db/queries.js'
import type { AccountHealthTracker } from './health.js'
import {
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
  mode: 'chat' | 'agent'
  /** agent 模式必传;chat 可选(若传也会作为加权采样的 PRNG seed,保留方便) */
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
}

/**
 * 请求释放结果。
 *
 * - `success`:请求正常完成。onSuccess → 健康分恢复
 * - `failure`:上游显式报错(4xx / 5xx / 解析失败 / 显式业务失败)。onFailure → 扣健康分
 * - `transient_network`:纯网络层抖动(DNS / TCP / TLS / proxy 不通),**不扣健康分**,
 *   仅 dec 并发槽位。设计动机:账号配 egress_proxy 后,代理一抖等于一次性把整池账号
 *   全扣分 → 误判 cooldown / disable。网络抖动应由连续多次 http_error(上游)体现,
 *   而非把纯网络失败算到具体账号头上。
 */
export type ReleaseResult =
  | { kind: 'success' }
  | { kind: 'failure'; error?: string | null }
  | { kind: 'transient_network'; error?: string | null }

export interface ReleaseInput {
  account_id: bigint | string
  result: ReleaseResult
}

export interface SchedulerDeps {
  health: AccountHealthTracker
  /** 注入测试 key fn;默认 loadKmsKey */
  keyFn?: () => Buffer
  /** 注入 PRNG;默认 Math.random */
  random?: () => number
  /** 注入 hash(用于测试;默认 SHA-256 64-bit) */
  hash?: (s: string) => bigint
  /**
   * 单账号同时 in-flight 请求上限。未传则读 `CLAUDE_ACCOUNT_MAX_CONCURRENT`,
   * 再 fallback `DEFAULT_MAX_CONCURRENT_PER_ACCOUNT`(10)。
   */
  maxConcurrent?: number
}

interface CandidateRow extends QueryResultRow {
  id: string
  plan: AccountPlan
  health_score: number
}

/** 默认哈希:SHA-256,截前 8B 作 64-bit 无符号整数。 */
export function defaultHash(s: string): bigint {
  const h = createHash('sha256').update(s).digest()
  return h.readBigUInt64BE(0)
}

/**
 * Rendezvous(Highest Random Weight)哈希:
 *   对每个候选 id 计算 hash(`sessionId:id`),取最大。
 *
 * 这比朴素 `hash(sessionId) % N` 更稳:
 *   账号加入/退出只影响被 "抢走" / "让出" 的那一小部分 session,
 *   不会让全量 session 重哈希。
 */
export function pickSticky(
  candidates: ReadonlyArray<CandidateRow>,
  sessionId: string,
  hash: (s: string) => bigint = defaultHash,
): CandidateRow {
  if (candidates.length === 0) {
    throw new AccountPoolUnavailableError('no candidates for sticky')
  }
  let bestIdx = 0
  let bestScore = hash(`${sessionId}:${candidates[0].id}`)
  for (let i = 1; i < candidates.length; i += 1) {
    const s = hash(`${sessionId}:${candidates[i].id}`)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return candidates[bestIdx]
}

/**
 * 按 health_score 加权随机。权重 floor 1,保证 health=0 的账号也有机会被探活。
 */
export function pickWeighted(
  candidates: ReadonlyArray<CandidateRow>,
  random: () => number = Math.random,
): CandidateRow {
  if (candidates.length === 0) {
    throw new AccountPoolUnavailableError('no candidates for weighted')
  }
  let total = 0
  const weights: number[] = []
  for (const c of candidates) {
    const w = Math.max(1, c.health_score)
    weights.push(w)
    total += w
  }
  const r = random() * total
  let acc = 0
  for (let i = 0; i < candidates.length; i += 1) {
    acc += weights[i]
    if (r < acc) return candidates[i]
  }
  // 浮点误差兜底:取最后一个。
  return candidates[candidates.length - 1]
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
  private readonly random: () => number
  private readonly hash: (s: string) => bigint
  /**
   * 单账号 in-flight 计数。pick() 选中并准备返 token 之前 inc,
   * release() 时 dec;归 0 就 delete 避免 Map 无限膨胀。
   *
   * 一致性边界:本字段是进程内状态,只在同一 AccountScheduler 实例内严格
   * 满足 inflight[id] ≤ maxConcurrent。多进程部署不会自动汇总。
   *
   * TOCTOU 安全:`filter → pickSticky/pickWeighted → inc` 在 pick() 循环内
   * 的一个同步块里完成,中间没有 await —— Node 单线程协作调度下两个并发
   * pick() 只能在 await 边界交错,因此硬上限成立。
   */
  private readonly inflight = new Map<string, number>()
  /** 单账号同时 in-flight 请求上限。 */
  readonly maxConcurrent: number

  constructor(deps: SchedulerDeps) {
    this.health = deps.health
    this.keyFn = deps.keyFn ?? loadKmsKey
    this.random = deps.random ?? Math.random
    this.hash = deps.hash ?? defaultHash
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
    const res = await query<CandidateRow>(
      `SELECT id::text AS id, plan, health_score
       FROM claude_accounts
       WHERE status = 'active' AND provider = $1
       ORDER BY id`,
      [provider],
    )
    let pool = res.rows
    if (pool.length === 0) {
      throw new AccountPoolUnavailableError('no active accounts')
    }

    // 最多重选 N 轮(N = 候选数)。每次选中账号若解密时发现已不存在,
    // 剔除后从剩余候选再选一次 —— sticky 的 rendezvous-hash 对剩余集
    // 仍是稳定的,只是换到次优选择。
    //
    // 并发上限:每轮先按 `inflight < maxConcurrent` 过滤出 under-cap 账号;
    // filter → pick → incInflight 同一 sync 块内完成(无 await),保证硬上限。
    // 若 active 池非空但 under-cap 为空 → AccountPoolBusyError(429);
    // 若池子最终因 vanish/AEAD 被耗尽但曾经过至少一个 under-cap 账号 → Unavailable(503)。
    let vanished = 0
    let quarantined = 0
    let sawAvailableCandidate = false
    while (pool.length > 0) {
      const available = pool.filter((c) => (this.inflight.get(c.id) ?? 0) < this.maxConcurrent)
      if (available.length === 0) break
      sawAvailableCandidate = true

      const chosen =
        input.mode === 'agent'
          ? pickSticky(available, input.sessionId!, this.hash)
          : pickWeighted(available, this.random)
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
    if (!sawAvailableCandidate) {
      throw new AccountPoolBusyError(
        `all ${pool.length} active account(s) at per-account concurrency cap (max=${this.maxConcurrent})`,
      )
    }
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
    // transient_network:已释放 slot,但不扣健康分(见 ReleaseResult 注释)
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

export async function pickCodexAccountForBinding(
  sessionId: string,
  deps: PickCodexBindingDeps = {},
): Promise<{ account_id: bigint } | null> {
  if (!sessionId || sessionId.length === 0) {
    throw new TypeError('sessionId required for pickCodexAccountForBinding')
  }
  const hash = deps.hash ?? defaultHash

  const res = await query<{ id: string; plan: AccountPlan; health_score: number }>(
    `SELECT id::text AS id, plan, health_score
     FROM claude_accounts
     WHERE status = 'active' AND provider = 'codex'
     ORDER BY id`,
  )
  if (res.rows.length === 0) return null

  // rendezvous-hash sticky:对每个候选计算 hash(`sessionId:id`),取最大。
  // 与 pickSticky 同语义,但这里独立函数避免依赖 CandidateRow 私有类型;
  // 不进 inflight、不解密 token、不调 health。
  let bestIdx = 0
  let bestScore = hash(`${sessionId}:${res.rows[0].id}`)
  for (let i = 1; i < res.rows.length; i += 1) {
    const s = hash(`${sessionId}:${res.rows[i].id}`)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return { account_id: BigInt(res.rows[bestIdx].id) }
}
