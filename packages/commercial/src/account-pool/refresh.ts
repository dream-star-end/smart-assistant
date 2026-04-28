/**
 * T-33 — Claude OAuth Token 刷新。
 *
 * 规约(见 01-SPEC F-6.7,02-ARCH §2.7):
 *   - `shouldRefresh(expiresAt, now, skewMs)` — 纯函数:token 是否即将过期
 *   - `refreshAccountToken(accountId, deps)`:
 *       1. 读 refresh_token(解密明文 Buffer,用完清零)
 *       2. 调 OAuth refresh endpoint(form-urlencoded grant_type=refresh_token)
 *       3. 2xx + 返回含 access_token → 重新加密写回 DB,返回新 token Buffer
 *       4. 失败 → throw RefreshError(code 不同),账号是否禁用看错误类型
 *
 * 失败都通过 `RefreshError` 抛,调用方据 `code` 分类。
 * **禁用策略**(Codex review 1bacae8 收紧):
 *   - `account_not_found` — 读账号返 null(也许被并发删了),不禁(无可禁)
 *   - `no_refresh_token` — DB 里没 refresh_token,**禁用**(永久无法自救)
 *   - `network_transient` — fetch 抛(底层网络/DNS/TLS/代理不通)→ **不禁用**;
 *     按账号 egress_proxy 后,代理一抖等于全池烧光,代价过大;
 *     上层 scheduler.release 按 `kind:"transient_network"` 处理(H9):
 *     dec inflight slot 但**不扣健康分**,避免代理一抖就把整池账号连环 cooldown/disable
 *   - `http_error` — 上游返 4xx/5xx → **禁用**(显式服务端拒绝,通常是 token 真坏)
 *   - `bad_response` — 2xx 但 JSON 解析失败 / 缺 access_token,**禁用**
 *   - `persist_error` — 远端 refresh 成功了,但本地 updateAccount 抛了;
 *     为避免"本地仍是旧 token 但账号还 active"的失控场面,**一律禁用**并抛
 *
 * 安全规约:
 *   - 明文 refresh_token 仅短暂生存在 JS 字符串内(为 form-urlencode),encode 后立即失去引用
 *   - 调用方收到的 token Buffer **必须 `.fill(0)`**(同 getTokenForUse 规约)
 *   - 错误消息不回显 refresh_token / 密文
 */

import { EVENTS } from '../admin/alertEvents.js'
import { safeEnqueueAlert } from '../admin/alertOutbox.js'
import { loadKmsKey } from '../crypto/keys.js'
import type { AccountHealthTracker } from './health.js'
import { recordRefreshEvent } from './refreshEvents.js'
import { type AccountPlan, getTokenForUse, updateAccount } from './store.js'

/**
 * Fire-and-forget refresh-event 落库。失败仅 console.warn,不打断主流程。
 *
 * 安全规约(M6/P1-9):errMsg 必须是受控固定字符串字面量,
 * 严禁传入 raw err.message / response body — 可能含 proxy 凭据 / token 片段。
 * 调用点全部用 RefreshErrorCode 枚举手写字面量 errMsg。
 */
function safeRecordRefreshEvent(
  accountId: bigint | string,
  ok: boolean,
  errCode?: RefreshErrorCode,
  errMsg?: string,
): void {
  const p = ok
    ? recordRefreshEvent({ accountId, ok: true })
    : recordRefreshEvent({
        accountId,
        ok: false,
        errCode: errCode!,
        errMsg: errMsg!,
      })
  p.catch((err) => {
    // 历史落库失败不该影响主路径。仅 warn,不抛。
    // eslint-disable-next-line no-console
    console.warn(`[refresh] failed to record refresh event for account ${String(accountId)}:`, err)
  })
}

/** token 过期时间与当前时间差小于此值 → 应 refresh。5 分钟。 */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000

/** 默认 OAuth refresh endpoint。生产部署可通过 deps.endpoint 覆盖。
 *  与 Claude Code prod TOKEN_URL 对齐(constants/oauth.ts)。 */
export const DEFAULT_OAUTH_ENDPOINT = 'https://platform.claude.com/v1/oauth/token'

/** Claude Code 公共 OAuth client_id(constants/oauth.ts PROD_OAUTH_CONFIG.CLIENT_ID)。
 *  这个 client_id 是 Anthropic 给 Claude Code CLI 的固定 ID,所有 OAuth refresh 都得带。 */
export const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** Claude Code CLI 风格 User-Agent。Node fetch 默认 `undici/...` 是非 CC 指纹。
 *  与 gateway/server.ts 的 CLAUDE_OAUTH_USER_AGENT 同源同语义,共用 env 覆盖名。 */
export const CLAUDE_OAUTH_USER_AGENT = `claude-cli/${process.env.OPENCLAUDE_CC_VERSION_FOR_OAUTH || '2.1.888'} (external, cli)`

/** refresh 成功但服务器没给 expires_in/expires_at 时的保底:1 小时。 */
export const DEFAULT_FALLBACK_EXPIRES_MS = 60 * 60 * 1000

export type RefreshErrorCode =
  | 'account_not_found'
  | 'no_refresh_token'
  | 'http_error'
  | 'network_transient'
  | 'bad_response'
  | 'persist_error'

export class RefreshError extends Error {
  readonly code: RefreshErrorCode
  readonly status?: number
  constructor(
    code: RefreshErrorCode,
    message: string,
    opts?: { status?: number; cause?: unknown },
  ) {
    super(message, opts)
    this.name = 'RefreshError'
    this.code = code
    this.status = opts?.status
  }
}

/**
 * HTTP client 抽象。生产注入 `defaultHttp`(基于 fetch),测试用可控 mock。
 * 把"网络层"抽出来便于在集成测试里不真的去打 Anthropic。
 */
export interface RefreshHttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    /**
     * 可选 undici Dispatcher(常为 ProxyAgent),按账号粒度指定出口。
     * 默认实现透传给 fetch 的 dispatcher 字段(undici 实现 / Node 18+)。
     */
    dispatcher?: unknown,
  ): Promise<{ status: number; body: string }>
}

export interface RefreshedTokens {
  token: Buffer
  refresh: Buffer | null
  expires_at: Date
  plan: AccountPlan
}

export interface RefreshDeps {
  /** HTTP 客户端(默认 fetch 实现)。 */
  http?: RefreshHttpClient
  keyFn?: () => Buffer
  now?: () => Date
  endpoint?: string
  /** OAuth 公共客户端 id。给了就写进 form。 */
  clientId?: string
  /** 判"即将过期"的 skew;仅供 `shouldRefresh` 方便 threading。 */
  skewMs?: number
  /**
   * 若给,失败时用 `health.manualDisable(id, reason)` 禁用账号;
   * 否则降级为直接 UPDATE status='disabled'(避开 health 依赖)。
   */
  health?: AccountHealthTracker
  /**
   * 出口 dispatcher(undici ProxyAgent 等)。给则刷 token 也走该代理,
   * 否则走默认出口。chat orchestrator 应该按账号 egress_proxy 构造后透传进来。
   */
  dispatcher?: unknown
}

/**
 * 纯判断:token 是否应刷新。
 *
 * - `expiresAt === null` → 视为永不过期(refresh_token 流或未知期限),返 false
 * - 否则:`expiresAt - now ≤ skewMs` → true
 *
 * 调用方通常:先 pick → 再 shouldRefresh → 若 true 则先 refresh 再用。
 */
export function shouldRefresh(expiresAt: Date | null, now: Date, skewMs: number): boolean {
  if (expiresAt === null) return false
  return expiresAt.getTime() - now.getTime() <= skewMs
}

/** 基于全局 fetch 的默认实现。生产走 globalThis.fetch。 */
export const defaultHttp: RefreshHttpClient = {
  async post(url, headers, body, dispatcher) {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers,
      body,
    }
    if (dispatcher) init.dispatcher = dispatcher
    const res = await fetch(url, init)
    const text = await res.text()
    return { status: res.status, body: text }
  },
}

interface OAuthRefreshJson {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  expires_at?: unknown
  token_type?: unknown
}

function computeExpiresAt(parsed: OAuthRefreshJson, now: Date): Date {
  if (typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)) {
    return new Date(now.getTime() + parsed.expires_in * 1000)
  }
  if (typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at)) {
    // 兼容 epoch seconds 与 ms(> 1e12 视为 ms)
    const raw = parsed.expires_at
    return new Date(raw > 1e12 ? raw : raw * 1000)
  }
  return new Date(now.getTime() + DEFAULT_FALLBACK_EXPIRES_MS)
}

async function disableOnFailure(
  deps: RefreshDeps,
  accountId: bigint | string,
  reason: string,
): Promise<void> {
  // T-63 告警:账号 OAuth refresh 失败到需要 disable 的程度 —— warning,
  // 连续多账号撞上同一 reason 会被 dedupe 按分钟桶收敛。不阻塞 disable 主路径。
  safeEnqueueAlert({
    event_type: EVENTS.ACCOUNT_POOL_TOKEN_REFRESH_FAILED,
    severity: 'warning',
    title: '账号 refresh 失败被 disable',
    body: `账号 #${accountId} OAuth refresh 连续失败,已被自动降级为 disabled。reason=\`${reason}\``,
    payload: { account_id: String(accountId), reason },
    // 同一 reason + 同一分钟 → 合并
    dedupe_key: `account_pool.token_refresh_failed:${reason}:${new Date().toISOString().slice(0, 16)}`,
  })
  if (deps.health) {
    try {
      await deps.health.manualDisable(accountId, reason)
    } catch {
      /* 禁用尽力而为,不要把 refresh 的原错误覆盖掉 */
    }
    return
  }
  try {
    await updateAccount(
      accountId,
      { status: 'disabled', last_error: reason },
      deps.keyFn ?? loadKmsKey,
    )
  } catch {
    /* 同理 */
  }
}

/**
 * 单进程 per-account singleflight。
 *
 * **问题**:Anthropic refresh_token 轮换机制下,并发 N 个请求同时对同一账号触发
 * refresh → 先到的用旧 refresh_token 换到新 access+refresh,后到的再拿"旧 refresh_token"
 * 去换会被 Anthropic 判为 reuse → 返 4xx → `disableOnFailure` → **账号被自己烧了**。
 *
 * 本 Map 保证同一时刻同一 accountId 只有一个 in-flight refresh 协程,其他 waiter
 * 都 await 同一个 Promise。失败时每个 waiter 都会拿到同一个 rejection。
 *
 * **注意:仅保护本进程内并发**。横向扩到多 gateway 节点时必须加跨进程锁
 * (Redis SET NX / PG advisory lock),否则相同竞态会在跨进程层再次出现。
 * 当前 v3 商用版是单 gateway 部署,此层足够。扩容前必须升级此处(见 AUDIT_2026-04-25.md)。
 */
const refreshInflight = new Map<string, Promise<RefreshedTokens>>()

/**
 * Buffer 克隆 —— 每个 waiter 都要拿到独立副本。
 * 不 clone 的后果:waiter A 用完 `.fill(0)` 会把 waiter B 正在用的 token 也清零。
 */
function cloneTokens(r: RefreshedTokens): RefreshedTokens {
  return {
    token: Buffer.from(r.token),
    refresh: r.refresh !== null ? Buffer.from(r.refresh) : null,
    expires_at: r.expires_at,
    plan: r.plan,
  }
}

/**
 * 刷新账号 token。成功 → 写回 DB + 返新 token;失败 → throw RefreshError。
 * 是否禁用账号取决于错误类型,见文件头部"禁用策略"章节。
 *
 * 并发保护:同 accountId 的 in-flight refresh 会被合并(见 refreshInflight 注释)。
 *
 * @throws {@link RefreshError}
 */
export async function refreshAccountToken(
  accountId: bigint | string,
  deps: RefreshDeps = {},
): Promise<RefreshedTokens> {
  const key = String(accountId)
  const existing = refreshInflight.get(key)
  if (existing) {
    // 复用 in-flight Promise,但返回克隆后的 Buffer 避免多个 waiter 互相污染
    const r = await existing
    return cloneTokens(r)
  }
  const p = refreshAccountTokenInner(accountId, deps)
  refreshInflight.set(key, p)
  try {
    return await p
  } finally {
    refreshInflight.delete(key)
  }
}

async function refreshAccountTokenInner(
  accountId: bigint | string,
  deps: RefreshDeps,
): Promise<RefreshedTokens> {
  const http = deps.http ?? defaultHttp
  const keyFn = deps.keyFn ?? loadKmsKey
  const endpoint = deps.endpoint ?? DEFAULT_OAUTH_ENDPOINT
  const now = (deps.now ?? ((): Date => new Date()))()

  // 1. 读 refresh_token —— 同一 Buffer 用完立即清零
  const current = await getTokenForUse(accountId, keyFn)
  if (!current) {
    throw new RefreshError('account_not_found', `account ${String(accountId)} not found`)
  }
  // 我们只需 refresh_token;access_token Buffer 立即清零
  current.token.fill(0)
  if (!current.refresh) {
    await disableOnFailure(deps, accountId, 'refresh_no_token_on_record')
    safeRecordRefreshEvent(accountId, false, 'no_refresh_token', 'no refresh_token on record')
    throw new RefreshError(
      'no_refresh_token',
      `account ${String(accountId)} has no refresh_token on record`,
    )
  }
  const refreshStr = current.refresh.toString('utf8')
  current.refresh.fill(0)

  // 2. 调 OAuth refresh endpoint
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshStr,
  })
  // client_id 必须有,默认用 Claude Code 公共 client_id
  form.set('client_id', deps.clientId ?? DEFAULT_OAUTH_CLIENT_ID)

  let result: { status: number; body: string }
  try {
    result = await http.post(
      endpoint,
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': CLAUDE_OAUTH_USER_AGENT,
      },
      form.toString(),
      deps.dispatcher,
    )
  } catch (err) {
    // 网络层异常(DNS / TCP / TLS / proxy 不通)—— 区分于 http_error。
    // 账号**不 disable**(代理抖动时一次性烧整池代价过大)。
    // 更上层的 scheduler.release 应按 `kind:"transient_network"` 处理:
    // dec inflight 但**不扣健康分**(#H9)。连续多次可由 orchestrator 层再自行限流。
    // 不把底层 err.message 拼进 message:未来如果 endpoint 可带凭据,
    // 上游 fetch 错误的 url 片段可能泄露;完整异常走 cause 链。
    safeRecordRefreshEvent(accountId, false, 'network_transient', 'refresh network call failed')
    throw new RefreshError('network_transient', 'refresh network call failed', { cause: err })
  }

  if (result.status < 200 || result.status >= 300) {
    await disableOnFailure(deps, accountId, `refresh_http_${result.status}`)
    // err_msg 仅含 status 整数 — 安全(非敏感)。不写 result.body 避免泄露 token 残片。
    safeRecordRefreshEvent(accountId, false, 'http_error', `HTTP ${result.status}`)
    throw new RefreshError('http_error', `refresh endpoint returned ${result.status}`, {
      status: result.status,
    })
  }

  let parsed: OAuthRefreshJson
  try {
    parsed = JSON.parse(result.body)
  } catch (err) {
    await disableOnFailure(deps, accountId, 'refresh_bad_json')
    safeRecordRefreshEvent(accountId, false, 'bad_response', 'invalid JSON')
    throw new RefreshError('bad_response', 'refresh response body is not valid JSON', {
      cause: err,
    })
  }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    await disableOnFailure(deps, accountId, 'refresh_no_access_token')
    safeRecordRefreshEvent(accountId, false, 'bad_response', 'missing access_token')
    throw new RefreshError('bad_response', 'refresh response missing access_token')
  }

  const expiresAt = computeExpiresAt(parsed, now)
  const newAccessToken = parsed.access_token
  const newRefreshToken =
    typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : null

  // 3. 加密写回 DB
  // refresh_token 轮换:服务器返了新的就写入;没返则保留原值(patch.refresh = undefined)
  const patch: Parameters<typeof updateAccount>[1] = {
    token: newAccessToken,
    oauth_expires_at: expiresAt,
    last_error: null,
  }
  if (newRefreshToken !== null) {
    patch.refresh = newRefreshToken
  }
  // 持久化失败属于"必禁"档(见文件头规约):远端 token 已轮换,本地没存下,
  // 账号若仍 active 会继续发旧 token,场面失控,所以无条件 disableOnFailure。
  // 唯一例外:updateAccount 返 null 说明账号并发删了(不抛也无法禁用,
  // 就按 account_not_found 抛,不算 persist 错)。
  let updated: Awaited<ReturnType<typeof updateAccount>>
  try {
    updated = await updateAccount(accountId, patch, keyFn)
  } catch (err) {
    await disableOnFailure(deps, accountId, 'refresh_persist_error')
    safeRecordRefreshEvent(
      accountId,
      false,
      'persist_error',
      'failed to persist refreshed token to DB',
    )
    throw new RefreshError('persist_error', 'failed to persist refreshed token to DB', {
      cause: err,
    })
  }
  if (!updated) {
    // 账号在 refresh 成功 → updateAccount 之间被并发删了。FK CASCADE 已自动清理
    // 历史。不写新 event(写也会被 FK 拒)。
    throw new RefreshError(
      'account_not_found',
      `account ${String(accountId)} vanished after successful refresh`,
    )
  }

  // 成功路径 — 落历史。
  safeRecordRefreshEvent(accountId, true)

  return {
    token: Buffer.from(newAccessToken, 'utf8'),
    refresh: newRefreshToken !== null ? Buffer.from(newRefreshToken, 'utf8') : null,
    expires_at: expiresAt,
    plan: current.plan,
  }
}
