/**
 * 连接器平台 · token 交换请求(RFC §3.4/§5:token-exchange 换 access_token)。
 *
 * `engineTokenExchange` 用连接里的**交换凭据**(client_id/client_secret/refresh_token)按契约声明的
 * exchangeRequest 组请求,发往 **token 受众** origin(≠api origin,受众隔离),解析 tokenOutputs 指针
 * 取 access_token/expiresIn/refreshToken/auxiliary。
 *
 * 凭据流向不变量:交换凭据只出现在**发往 token origin 的 body / basic-auth 头**里,绝不进声明模板、
 * 绝不发往 api origin。复用 pinnedHttpsFetch(SSRF/DNS 钉死/redirect:error/超时)+ 非 2xx 吞 body +
 * 全链脱敏(交换凭据 + 换回的 access_token 都进脱敏集)。成功判据 = 2xx 且 accessToken 指针解析出
 * 非空串;否则 UPSTREAM_AUTH_FAILED(providerErrorCode 仅日志,不透传)。
 */

import { ConnectorError } from '../errors.js'
import { normalizeHttpsOrigin, pinnedHttpsFetch } from '../outboundPolicy.js'
import {
  MAX_UPSTREAM_JSON_BYTES,
  mapFetchFailure,
  mapUpstreamStatus,
  readBoundedJson,
} from '../providers/shared.js'
import type { ExecContractT, TokenAcquisitionT, TokenOutputsT } from '../spec/types.js'
import type { EngineHttpDeps } from './driver.js'
import { resolveResultPointer } from './pointer.js'
import { redactSecrets } from './redact.js'

const TAG = 'engine-token'
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject CR/LF/control in exchange field values
const HAS_CONTROL = /[\x00-\x1f\x7f]/

export interface ExchangeOutputs {
  accessToken: string
  expiresInSec?: number
  refreshToken?: string
  auxiliary?: Record<string, string>
}

/** 契约受众里唯一 token origin(单 origin;多 origin 后续)。 */
function soleTokenOrigin(contract: ExecContractT): string {
  const origins = contract.credentialAudiencePolicy.tokenOrigins
  if (origins.length !== 1)
    throw new ConnectorError('BAD_REQUEST', 'token-exchange requires exactly one token origin')
  return origins[0]!
}

/** 交换字段值(凭据/静态)禁 CRLF/控制符(要进 body/header)。 */
function assertClean(v: string, what: string): string {
  if (HAS_CONTROL.test(v)) throw new ConnectorError('BAD_REQUEST', `control char in ${what}`)
  return v
}

/** 组交换请求的字段:credentialFieldNames(field→source)取凭据值 + staticFields + grant_type。 */
function buildFields(
  ex: TokenAcquisitionT['exchangeRequest'],
  inputs: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, source] of Object.entries(ex.credentialFieldNames)) {
    const v = inputs[source]
    if (typeof v !== 'string' || v.length === 0)
      throw new ConnectorError('BAD_REQUEST', `exchange input '${source}' missing`)
    out[field] = assertClean(v, `field ${field}`)
  }
  if (ex.staticFields) for (const [k, v] of Object.entries(ex.staticFields)) out[k] = assertClean(v, k)
  if (ex.grantValue !== undefined) out.grant_type = assertClean(ex.grantValue, 'grant_type')
  return out
}

export async function engineTokenExchange(opts: {
  contract: ExecContractT
  exchangeInputs: Record<string, string>
  deps?: EngineHttpDeps
}): Promise<ExchangeOutputs> {
  const { contract } = opts
  const ta: TokenAcquisitionT | undefined = contract.tokenAcquisition
  const tokenOutputs: TokenOutputsT | undefined = contract.tokenOutputs
  if (ta === undefined || tokenOutputs === undefined)
    throw new ConnectorError('INTERNAL', 'contract missing tokenAcquisition/tokenOutputs')
  const deps = opts.deps ?? {}
  // 脱敏集 = 全部交换凭据值(client_secret/refresh_token 等)。
  const secrets = Object.values(opts.exchangeInputs).filter((v) => v.length > 0)

  const origin = normalizeHttpsOrigin(soleTokenOrigin(contract))
  const ex = ta.exchangeRequest
  const fields = buildFields(ex, opts.exchangeInputs)

  const headers: Record<string, string> = {}
  let body: string | undefined
  let url = `${origin}${ex.path}`

  if (ex.encoding === 'json') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(fields)
  } else if (ex.encoding === 'form') {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(fields).toString()
  } else if (ex.encoding === 'query') {
    const qs = new URLSearchParams(fields).toString()
    url = qs ? `${url}?${qs}` : url
  } else {
    // basic-auth:client_id:client_secret 进 Authorization,其余字段进 form body。
    const id = opts.exchangeInputs.client_id
    const secret = opts.exchangeInputs.client_secret
    if (!id || !secret)
      throw new ConnectorError('BAD_REQUEST', 'basic-auth exchange needs client_id/client_secret')
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
    const rest: Record<string, string> = {}
    for (const [field, source] of Object.entries(ex.credentialFieldNames)) {
      if (source !== 'client_id' && source !== 'client_secret' && fields[field] !== undefined)
        rest[field] = fields[field]!
    }
    if (ex.staticFields) for (const [k, v] of Object.entries(ex.staticFields)) rest[k] = v
    if (ex.grantValue !== undefined) rest.grant_type = ex.grantValue
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(rest).toString()
  }

  let resp: unknown
  try {
    let res: Response
    try {
      res = await pinnedHttpsFetch(
        new URL(url),
        { method: ex.method, headers, ...(body !== undefined ? { body } : {}) },
        { resolver: deps.resolver, fetchImpl: deps.fetchImpl },
      )
    } catch (err) {
      throw mapFetchFailure(err, TAG)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw mapUpstreamStatus(res.status, TAG)
    }
    resp = await readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, TAG)
  } catch (err) {
    // 脱敏错误 message(凭据绝不进日志/对端)。
    const ce = err instanceof ConnectorError ? err : new ConnectorError('UPSTREAM_ERROR', 'token exchange failed')
    throw new ConnectorError(ce.code, redactSecrets(ce.message, secrets), ce.httpStatus)
  }

  // 成功判据:accessToken 指针解析出非空串。否则视作换取失败(不透传上游原文)。
  const at = resolveResultPointer(resp, tokenOutputs.accessToken)
  if (typeof at !== 'string' || at.length === 0)
    throw new ConnectorError('UPSTREAM_AUTH_FAILED', 'token exchange returned no access token')

  const out: ExchangeOutputs = { accessToken: at }
  if (tokenOutputs.expiresIn !== undefined) {
    const ev = resolveResultPointer(resp, tokenOutputs.expiresIn)
    const n = typeof ev === 'number' ? ev : typeof ev === 'string' ? Number(ev) : Number.NaN
    if (Number.isFinite(n) && n > 0) out.expiresInSec = Math.floor(n)
  }
  if (tokenOutputs.refreshToken !== undefined) {
    const rt = resolveResultPointer(resp, tokenOutputs.refreshToken)
    if (typeof rt === 'string' && rt.length > 0) out.refreshToken = rt
  }
  if (tokenOutputs.auxiliary !== undefined) {
    const aux: Record<string, string> = {}
    for (const [k, spec] of Object.entries(tokenOutputs.auxiliary)) {
      const av = resolveResultPointer(resp, spec.pointer)
      if (typeof av === 'string' && av.length > 0) aux[k] = av
    }
    if (Object.keys(aux).length > 0) out.auxiliary = aux
  }
  return out
}
