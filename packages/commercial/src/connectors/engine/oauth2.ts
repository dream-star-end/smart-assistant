/**
 * 连接器平台 · oauth2 授权码流引擎核心(RFC §3/§5)。切片 A:只做编译器+引擎两层,
 * 不碰 HTTP 路由 / 前端 / state store(那是后续切片)。
 *
 * 两个函数,受众隔离是唯一红线:
 *   - `buildAuthorizeUrl`:**纯函数**(不发网)。组浏览器授权跳转 URL,目标是 **authorization 受众**。
 *     只带公开标识(client_id / redirect_uri / state / scope / PKCE code_challenge),
 *     **绝不含 client_secret / code / code_verifier**。
 *   - `exchangeAuthCode`:**镜像 engineTokenExchange**。用 code + client_secret 发 POST 到
 *     **sole token origin**(≠authorize origin、≠api origin)换 access_token。交换凭据
 *     (code / client_secret / code_verifier)只出现在**发往 token origin 的 body / basic-auth 头**里,
 *     绝不进 authorize URL、绝不发 api origin。复用 pinnedHttpsFetch(SSRF/DNS 钉死/redirect:error/
 *     超时)+ 非 2xx 吞 body + 全链脱敏。成功判据 = 2xx 且 tokenOutputs.accessToken 指针解析出非空串;
 *     否则 UPSTREAM_AUTH_FAILED(上游原文/凭据绝不透传)。
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

    // 成功判据:accessToken 指针解析出非空串。否则视作换取失败(不透传上游原文)。
    const at = resolveResultPointer(resp, tokenOutputs.accessToken)
    if (typeof at !== 'string' || at.length === 0)
      throw new ConnectorError('UPSTREAM_AUTH_FAILED', 'oauth2 code exchange returned no access token')
    // 换回的 access_token/refresh_token 并入脱敏集(后续任何抛错都不泄漏它们)。
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
  } catch (err) {
    // 单一脱敏出口:任何抛出的 message 都抹掉凭据(code/client_secret/verifier/换回 token)。
    const ce =
      err instanceof ConnectorError
        ? err
        : new ConnectorError('UPSTREAM_ERROR', 'oauth2 code exchange failed')
    throw new ConnectorError(ce.code, redactSecrets(ce.message, secrets), ce.httpStatus)
  }
}
