/**
 * 连接器平台 · oauth2 授权码流引擎核心(RFC §3/§5)。切片 A:只做编译器+引擎两层,
 * 不碰 HTTP 路由 / 前端 / state store(那是后续切片)。
 *
 * 三个函数,受众隔离是唯一红线:
 *   - `buildAuthorizeUrl`:**纯函数**(不发网)。组浏览器授权跳转 URL,目标是 **authorization 受众**。
 *     只带公开标识(client_id / redirect_uri / state / scope / PKCE code_challenge),
 *     **绝不含 client_secret / code / code_verifier**。
 *   - `exchangeAuthCode`:**镜像 engineTokenExchange**。用 code + client_secret 发 POST 到
 *     **sole token origin**(≠authorize origin、≠api origin)换 access_token。交换凭据
 *     (code / client_secret / code_verifier)只出现在**发往 token origin 的 body / basic-auth 头**里,
 *     绝不进 authorize URL、绝不发 api origin。复用 pinnedHttpsFetch(SSRF/DNS 钉死/redirect:error/
 *     超时)+ 非 2xx 吞 body + 全链脱敏。成功判据 = 2xx 且 tokenOutputs.accessToken 指针解析出非空串;
 *     否则 UPSTREAM_AUTH_FAILED(上游原文/凭据绝不透传)。
 *   - `refreshOauth2Token`:**镜像 exchangeAuthCode**(RFC 6749 §6)。用 refresh_token + client_secret
 *     换新 access_token,同样只发 **token 受众** origin。与 exchange 的唯一语义差别:上游 4xx
 *     (refresh_token 被吊销/过期)→ **RELINK_REQUIRED**(不是 UPSTREAM_AUTH_FAILED)—— 语义是
 *     "这条连接再也自愈不了,必须让用户重新授权"。
 */

import { ConnectorError } from '../errors.js'
import { normalizeHttpsOrigin, pinnedHttpsFetch } from '../outboundPolicy.js'
import {
  MAX_UPSTREAM_JSON_BYTES,
  mapFetchFailure,
  mapUpstreamStatus,
  readBoundedJson,
} from '../providers/shared.js'
import type { ExecContractT, Oauth2ConfigT, TokenOutputsT } from '../spec/types.js'
import type { EngineHttpDeps } from './driver.js'
import { resolveResultPointer } from './pointer.js'
import { redactSecrets } from './redact.js'
import type { ExchangeOutputs } from './tokenExchange.js'

const TAG = 'engine-oauth2'
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject CR/LF/control in oauth2 params
const HAS_CONTROL = /[\x00-\x1f\x7f]/

/** buildAuthorizeUrl 组装的核心协议参数名:fixedExtraParams 不得覆盖(否则可篡改 client_id 等)。 */
const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
])

/** 取 contract.oauth2(缺失=编程错误:非 oauth2 契约误入本模块)。 */
function requireOauth2(contract: ExecContractT): Oauth2ConfigT {
  const cfg = contract.oauth2
  if (cfg === undefined) throw new ConnectorError('INTERNAL', 'contract has no oauth2 config')
  return cfg
}

/** 完整 https URL → { 解析出的 URL, 归一化 origin(host+port,经单一权威 normalizeHttpsOrigin) }。 */
function endpointOrigin(rawUrl: string): { url: URL; origin: string } {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new ConnectorError('BAD_REQUEST', 'oauth2 endpoint is not a valid url')
  }
  // normalizeHttpsOrigin 会强制 https/无 userinfo/小写 host 等;非法直接 OUTBOUND_BLOCKED。
  const origin = normalizeHttpsOrigin(`${u.protocol}//${u.host}`)
  return { url: u, origin }
}

/** 值禁 CRLF/控制符(要进 URL query / body / header)。 */
function assertClean(v: string, what: string): string {
  if (typeof v !== 'string' || HAS_CONTROL.test(v))
    throw new ConnectorError('BAD_REQUEST', `control char in ${what}`)
  return v
}

// ─── buildAuthorizeUrl(纯函数;发往 authorization 受众,零凭据) ─────────────

export interface BuildAuthorizeUrlOpts {
  /** OAuth 客户端公开标识(非凭据,不脱敏)。 */
  clientId: string
  /** 回跳地址;必须 https。 */
  redirectUri: string
  /** CSRF/会话绑定的不透明 state。 */
  state: string
  /** PKCE code_challenge(S256 派生);pkce='required' 时必传。 */
  pkceChallenge?: string
}

/**
 * 组授权 URL:`${authorizeEndpoint}?response_type=code&client_id=…&redirect_uri=…&state=…`
 * `[&scope=…][&code_challenge=…&code_challenge_method=S256]` + fixedExtraParams。
 * **纯函数**(不发网):只拼串。**绝不接触 client_secret**。
 */
export function buildAuthorizeUrl(contract: ExecContractT, opts: BuildAuthorizeUrlOpts): string {
  const cfg = requireOauth2(contract)
  // 受众隔离(运行期二次断言,双保险):authorize 端点 origin 必须 ∈ authorizationOrigins。
  const { url, origin } = endpointOrigin(cfg.authorizeEndpoint)
  if (!contract.credentialAudiencePolicy.authorizationOrigins.includes(origin))
    throw new ConnectorError(
      'OUTBOUND_BLOCKED',
      'authorize endpoint origin not in authorization audience',
    )
  // redirect_uri 必须 https(且无 CRLF)。
  assertClean(opts.redirectUri, 'redirectUri')
  let redirect: URL
  try {
    redirect = new URL(opts.redirectUri)
  } catch {
    throw new ConnectorError('BAD_REQUEST', 'redirectUri is not a valid url')
  }
  if (redirect.protocol !== 'https:')
    throw new ConnectorError('BAD_REQUEST', 'redirectUri must be https')

  // URLSearchParams 保序 + 自动百分号编码(拒 CRLF 已前置到 assertClean)。
  const params = new URLSearchParams()
  params.set('response_type', 'code')
  params.set('client_id', assertClean(opts.clientId, 'clientId'))
  params.set('redirect_uri', opts.redirectUri)
  params.set('state', assertClean(opts.state, 'state'))
  if (cfg.scopes !== undefined && cfg.scopes.length > 0) {
    for (const s of cfg.scopes) assertClean(s, 'scope')
    params.set('scope', cfg.scopes.join(cfg.scopeSeparator))
  }
  // PKCE:required 必须带 challenge;带了就加(optional 也允许)。
  if (
    cfg.pkce === 'required' &&
    (opts.pkceChallenge === undefined || opts.pkceChallenge.length === 0)
  )
    throw new ConnectorError('BAD_REQUEST', 'pkce required but no code_challenge provided')
  if (opts.pkceChallenge !== undefined && opts.pkceChallenge.length > 0) {
    params.set('code_challenge', assertClean(opts.pkceChallenge, 'pkceChallenge'))
    params.set('code_challenge_method', 'S256')
  }
  // fixedExtraParams:核心协议参数不可被覆盖(RESERVED_AUTHORIZE_PARAMS 跳过)。
  if (cfg.fixedExtraParams !== undefined) {
    for (const [k, v] of Object.entries(cfg.fixedExtraParams)) {
      if (RESERVED_AUTHORIZE_PARAMS.has(k)) continue
      params.set(k, assertClean(v, `extra ${k}`))
    }
  }
  // 保留 authorizeEndpoint 原样 origin+path,附加组好的 query(端点已在编译期保证无自带 query)。
  url.search = params.toString()
  return url.toString()
}

// ─── exchangeAuthCode(镜像 engineTokenExchange;发往 sole token origin) ──────

export interface ExchangeAuthCodeOpts {
  contract: ExecContractT
  /** 授权回跳带回的 authorization code(一次性交换凭据)。 */
  code: string
  clientId: string
  clientSecret: string
  /** 必须与 authorize 阶段一致(RFC 6749 §4.1.3)。 */
  redirectUri: string
  /** PKCE code_verifier(pkce 流程时)。 */
  pkceVerifier?: string
  deps?: EngineHttpDeps
}

/**
 * 用 code + client_secret 换 access_token。发 POST 到 sole token origin(受众隔离铁律)。
 * body = application/x-www-form-urlencoded(oauth2 标准),含 grant_type=authorization_code、code、
 * redirect_uri、code_verifier(若有);client 凭据按 clientAuth 走 basic 头或 body。
 */
export async function exchangeAuthCode(opts: ExchangeAuthCodeOpts): Promise<ExchangeOutputs> {
  const { contract } = opts
  const cfg = requireOauth2(contract)
  const tokenOutputs: TokenOutputsT | undefined = contract.tokenOutputs
  if (tokenOutputs === undefined)
    throw new ConnectorError('INTERNAL', 'contract missing tokenOutputs')

  // 脱敏集:code + client_secret + pkceVerifier(换回的 token 解析后并入)。全链错误 message 经此抹除。
  const secrets: string[] = [opts.code, opts.clientSecret, opts.pkceVerifier ?? ''].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )

  try {
    // 受众隔离(运行期铁律):token 端点 origin 必须 ∈ tokenOrigins,否则 client_secret 绝不发出。
    const { url, origin } = endpointOrigin(cfg.tokenEndpoint)
    if (!contract.credentialAudiencePolicy.tokenOrigins.includes(origin))
      throw new ConnectorError('BAD_REQUEST', 'token endpoint origin not in token audience')

    // 组 form body(oauth2 标准 application/x-www-form-urlencoded)。
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code: assertClean(opts.code, 'code'),
      redirect_uri: assertClean(opts.redirectUri, 'redirect_uri'),
    }
    if (opts.pkceVerifier !== undefined && opts.pkceVerifier.length > 0)
      fields.code_verifier = assertClean(opts.pkceVerifier, 'code_verifier')

    const clientId = assertClean(opts.clientId, 'client_id')
    const clientSecret = assertClean(opts.clientSecret, 'client_secret')
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (cfg.clientAuth === 'basic') {
      // basic-auth 型:client_id:client_secret 进 Authorization Basic,其余进 body。
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    } else {
      // body 型(form/json → oauth2 交换仍 form 编码):client_id + client_secret 进 body。
      fields.client_id = clientId
      fields.client_secret = clientSecret
    }
    const body = new URLSearchParams(fields).toString()

    // 经 pinnedHttpsFetch(SSRF/DNS 钉死/redirect:error/超时);非 2xx 吞 body(绝不读上游原文)。
    let res: Response
    try {
      res = await pinnedHttpsFetch(
        url,
        { method: 'POST', headers, body },
        { resolver: opts.deps?.resolver, fetchImpl: opts.deps?.fetchImpl },
      )
    } catch (err) {
      throw mapFetchFailure(err, TAG)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw mapUpstreamStatus(res.status, TAG)
    }
    const resp = await readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, TAG)

    // 成功判据 + tokenOutputs 指针解析(与 refresh 共用单一权威,见 parseTokenOutputs)。
    return parseTokenOutputs(resp, tokenOutputs, secrets, 'oauth2 code exchange')
  } catch (err) {
    // 单一脱敏出口:任何抛出的 message 都抹掉凭据(code/client_secret/verifier/换回 token)。
    const ce =
      err instanceof ConnectorError
        ? err
        : new ConnectorError('UPSTREAM_ERROR', 'oauth2 code exchange failed')
    throw new ConnectorError(ce.code, redactSecrets(ce.message, secrets), ce.httpStatus)
  }
}

/**
 * 上游 token 响应 → ExchangeOutputs(**exchange 与 refresh 的单一解析权威**,消除两份漂移)。
 * 成功判据 = tokenOutputs.accessToken 指针解析出非空串;否则 UPSTREAM_AUTH_FAILED(不透传上游原文)。
 * 换回的 access_token / refresh_token **就地并入 secrets**(调用方的脱敏集),后续任何抛错都不泄漏。
 */
function parseTokenOutputs(
  resp: unknown,
  tokenOutputs: TokenOutputsT,
  secrets: string[],
  what: string,
): ExchangeOutputs {
  const at = resolveResultPointer(resp, tokenOutputs.accessToken)
  if (typeof at !== 'string' || at.length === 0)
    throw new ConnectorError('UPSTREAM_AUTH_FAILED', `${what} returned no access token`)
  secrets.push(at)

  const out: ExchangeOutputs = { accessToken: at }
  if (tokenOutputs.expiresIn !== undefined) {
    const ev = resolveResultPointer(resp, tokenOutputs.expiresIn)
    const n = typeof ev === 'number' ? ev : typeof ev === 'string' ? Number(ev) : Number.NaN
    if (Number.isFinite(n) && n > 0) out.expiresInSec = Math.floor(n)
  }
  if (tokenOutputs.refreshToken !== undefined) {
    const rt = resolveResultPointer(resp, tokenOutputs.refreshToken)
    if (typeof rt === 'string' && rt.length > 0) {
      out.refreshToken = rt
      secrets.push(rt)
    }
  }
  if (tokenOutputs.auxiliary !== undefined) {
    const aux: Record<string, string> = {}
    for (const [k, auxSpec] of Object.entries(tokenOutputs.auxiliary)) {
      const av = resolveResultPointer(resp, auxSpec.pointer)
      if (typeof av === 'string' && av.length > 0) aux[k] = av
    }
    if (Object.keys(aux).length > 0) out.auxiliary = aux
  }
  return out
}

// ─── refreshOauth2Token(镜像 exchangeAuthCode;发往 token 受众) ────────────────

/**
 * refresh 请求里**允许出现的规范凭据 source**。`refreshFieldNames` 的 value 只能取这四个之一 ——
 * 未知 source 一律 BAD_REQUEST(fail-closed:不允许作者把任意袋字段塞进 refresh 请求)。
 */
const REFRESH_SOURCES: ReadonlySet<string> = new Set([
  'grant_type',
  'refresh_token',
  'client_id',
  'client_secret',
])

/** RFC 6749 §6:grant_type 的固定值(字段**名**可被 refreshFieldNames 改,**值**不可)。 */
const REFRESH_GRANT_VALUE = 'refresh_token'

/**
 * `refreshFieldNames`(可选)的语义 —— **与 tokenAcquisition.credentialFieldNames 同构**:
 * `Record<线上字段名, 规范 source 名>`(key 受 QueryName pattern 约束因为它要进 body/query;
 * value 是引擎内部的规范 source 名)。本函数把它**反转**成 `source → 线上字段名` 供组包用。
 *
 * 未声明 → 默认恒等映射(线上字段名 == 规范名,即 RFC 6749 标准形状)。声明了 → 逐 source 覆盖
 * 默认(只覆盖出现的那些)。同一 source 被映射到两个线上字段名 = 歧义 → BAD_REQUEST。
 */
function refreshWireNames(cfg: Oauth2ConfigT): Record<string, string> {
  const wire: Record<string, string> = {
    grant_type: 'grant_type',
    refresh_token: 'refresh_token',
    client_id: 'client_id',
    client_secret: 'client_secret',
  }
  if (cfg.refreshFieldNames === undefined) return wire
  const seen = new Set<string>()
  for (const [field, source] of Object.entries(cfg.refreshFieldNames)) {
    if (!REFRESH_SOURCES.has(source))
      throw new ConnectorError('BAD_REQUEST', `refreshFieldNames source '${source}' not allowed`)
    if (seen.has(source))
      throw new ConnectorError('BAD_REQUEST', `refreshFieldNames maps source '${source}' twice`)
    seen.add(source)
    wire[source] = assertClean(field, `refresh field ${source}`)
  }
  return wire
}

export interface RefreshOauth2TokenOpts {
  contract: ExecContractT
  /** 长期凭据:换新 access_token 用;轮换型 provider 用完即失效(调用方须落新的)。 */
  refreshToken: string
  clientId: string
  clientSecret: string
  deps?: EngineHttpDeps
}

/**
 * 用 refresh_token 换新 access_token(RFC 6749 §6)。端点 = `refreshEndpoint ?? tokenEndpoint`
 * (RFC:refresh 通常就打 token 端点)。
 *
 * 与 exchangeAuthCode 逐条对齐的不变量:
 *   - **受众隔离**:端点 origin 必须 ∈ credentialAudiencePolicy.tokenOrigins,否则 BAD_REQUEST 且
 *     **请求根本不发出**(编译期 validateOauth2Endpoint 已校验过 refreshEndpoint,这里是运行期双保险:
 *     契约若被篡改/漂移,client_secret 与 refresh_token 一个字节也不会离开进程);
 *   - 凭据只出现在**发往 token origin 的 body / basic-auth 头**里;
 *   - pinnedHttpsFetch(SSRF/DNS 钉死/redirect:error/超时);非 2xx **吞 body**(绝不读上游原文);
 *   - 单一脱敏出口:抛出的 message 必抹掉 refresh_token / client_secret / 换回的新 token。
 *
 * **错误语义(与 exchange 的唯一差别)**:上游 4xx = refresh_token 被吊销/过期/client 被删 →
 * `RELINK_REQUIRED`(这条连接已无法自愈,必须让用户重新授权)。例外:408/429 是**瞬态**
 * (超时/限流),照 mapUpstreamStatus 映射 —— 把限流当成"需要重新授权"会无谓地毁掉一条好连接。
 */
export async function refreshOauth2Token(opts: RefreshOauth2TokenOpts): Promise<ExchangeOutputs> {
  const { contract } = opts
  const cfg = requireOauth2(contract)
  const tokenOutputs: TokenOutputsT | undefined = contract.tokenOutputs
  if (tokenOutputs === undefined)
    throw new ConnectorError('INTERNAL', 'contract missing tokenOutputs')

  // 脱敏集:refresh_token + client_secret(换回的新 token 由 parseTokenOutputs 并入)。
  const secrets: string[] = [opts.refreshToken, opts.clientSecret].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )

  try {
    // 端点:显式 refreshEndpoint 优先,否则打 token 端点(RFC 6749 §6 的默认)。
    const raw =
      cfg.refreshEndpoint !== undefined && cfg.refreshEndpoint.length > 0
        ? cfg.refreshEndpoint
        : cfg.tokenEndpoint
    // 受众隔离(运行期铁律):不在 token 受众 → 凭据绝不发出。
    const { url, origin } = endpointOrigin(raw)
    if (!contract.credentialAudiencePolicy.tokenOrigins.includes(origin))
      throw new ConnectorError('BAD_REQUEST', 'refresh endpoint origin not in token audience')

    const wire = refreshWireNames(cfg)
    const clientId = assertClean(opts.clientId, 'client_id')
    const clientSecret = assertClean(opts.clientSecret, 'client_secret')

    // 两个 source 映射到**同一个线上字段名** = 后写的静默覆盖先写的(比如 client_id 顶掉
    // refresh_token)→ 发出一个语义错乱的请求。fail-closed:宁可不发。
    const fields: Record<string, string> = {}
    const setField = (name: string, value: string): void => {
      if (Object.hasOwn(fields, name))
        throw new ConnectorError('BAD_REQUEST', `refresh field name '${name}' collides`)
      fields[name] = value
    }
    setField(wire.grant_type!, REFRESH_GRANT_VALUE)
    setField(wire.refresh_token!, assertClean(opts.refreshToken, 'refresh_token'))

    const headers: Record<string, string> = {}
    if (cfg.clientAuth === 'basic') {
      // basic-auth 型:client_id:client_secret 进 Authorization Basic,绝不进 body。
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    } else {
      // body 型:client 凭据进 body(字段名可被 refreshFieldNames 覆盖)。
      setField(wire.client_id!, clientId)
      setField(wire.client_secret!, clientSecret)
    }

    // 编码按契约 refreshEncoding(clientAuth 决定 client 凭据**在哪**,refreshEncoding 决定 body **怎么编**)。
    let body: string
    if (cfg.refreshEncoding === 'json') {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(fields)
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(fields).toString()
    }

    let res: Response
    try {
      res = await pinnedHttpsFetch(
        url,
        { method: 'POST', headers, body },
        { resolver: opts.deps?.resolver, fetchImpl: opts.deps?.fetchImpl },
      )
    } catch (err) {
      throw mapFetchFailure(err, TAG)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      // 4xx(除瞬态 408/429)= refresh_token 已失效 → 这条连接自愈无望,必须重新授权。
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
        throw new ConnectorError(
          'RELINK_REQUIRED',
          `${TAG} refresh rejected by upstream (${res.status})`,
        )
      throw mapUpstreamStatus(res.status, TAG)
    }
    const resp = await readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, TAG)

    return parseTokenOutputs(resp, tokenOutputs, secrets, 'oauth2 token refresh')
  } catch (err) {
    // 单一脱敏出口:refresh_token / client_secret / 换回的新 token 绝不出现在 message 里。
    const ce =
      err instanceof ConnectorError
        ? err
        : new ConnectorError('UPSTREAM_ERROR', 'oauth2 token refresh failed')
    throw new ConnectorError(ce.code, redactSecrets(ce.message, secrets), ce.httpStatus)
  }
}
