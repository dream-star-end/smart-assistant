/**
 * 连接器平台 · 统一 HTTP egress driver —— **唯一 HTTP 出口**(RFC §4)。
 *
 * 一切 REST action / (后续)token exchange / refresh 的每步 HTTP 网络都必经
 * `engineHttpRequest`。它是**凭据流向不变量的引擎级单一强制点**:
 *
 *   1. `buildRequestPlan` → canonical plan(path/query/body 按 URL component 构造,
 *      CRLF/原型污染构造期拒);
 *   2. **凭据流向不变量**:plan.origin 必须 ∈ 该 credentialAudience 的 policy origin 集,
 *      否则 `OUTBOUND_BLOCKED` 且**凭据结构上不注入**(在注入前就 return);
 *   3+5. **SSRF**:复用 `pinnedHttpsFetch`(https + `resolvePinnedAddress` 全 A/AAAA
 *      global-unicast + IP 钉死 + TLS servername=hostname + `redirect:'error'` + 超时),
 *      不重写 SSRF 逻辑;
 *   4. `injectCredentials`(仅在 origin 匹配后);`upload` 受众不带凭据;
 *   6. `readBoundedJson` + 结果硬限(256KB/深8/数组200)+ `cleanActionResult` allowlist 剥字段;
 *   7. **全链脱敏**:错误/日志/返回 result 里 exact-match 抹掉每个凭据 secret 值;
 *      HTTP 错误不带完整 URL(redactUrl 去 query,微信系 token 在 query)。
 *
 * 注入次序说明(faithful to invariant):凭据的**唯一注入门**是第2步的 audience-origin
 * 匹配(RFC §4 步骤3:"origin ∉ audience → 凭据不注入")。injectCredentials 在匹配通过
 * 后执行,随即交给 `pinnedHttpsFetch`;后者在**发出任何字节前**独立跑完 DNS/IP/redirect
 * SSRF 闸,一旦 SSRF 失败连接即被拒,注入到本地 header 对象的凭据从不离开进程 —— 故
 * "SSRF 失败 = 零凭据外泄"成立,无需在 SSRF 与注入之间再插一次 DNS 解析。
 */

import { ConnectorError, toConnectorError } from '../errors.js'
import { type DnsResolver, pinnedHttpsFetch } from '../outboundPolicy.js'
import {
  MAX_UPSTREAM_JSON_BYTES,
  enforceResultLimits,
  isMaybeDelivered,
  mapFetchFailure,
  mapUpstreamStatus,
  markMaybeDelivered,
  readBoundedJson,
} from '../providers/shared.js'
import type {
  CredentialAudienceValue,
  CredentialAudiencePolicyT,
  ExecActionT,
  ExecContractT,
} from '../spec/types.js'
import {
  type InjectedRequest,
  type ResolvedCredentials,
  collectSecretValues,
  injectCredentials,
} from './placement.js'
import { buildRequestPlan, redactedPlan } from './requestPlan.js'
import { redactDeep, redactSecrets } from './redact.js'

const DRIVER_TAG = 'engine'

/** 原型污染键(结果投影时同样拒)。 */
const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_PROJECT_DEPTH = 32

/**
 * 结果 allowlist 投影(RFC §4 步骤6:按 execAction.result **剥字段**)。
 *
 * ExecContract 里 `result` 是**纯 JSON schema**(载入即验签后无 TypeBox `Kind` 符号),
 * 故不能用 registry.cleanActionResult(那依赖 TypeBox Value,对无 Kind 的 schema 会抛
 * `Unknown type`)。这里按标准 JSON Schema 语义做**结构化白名单投影**(与 Value.Clean
 * 剥字段语义一致):
 *   - object:只保留 `properties` 里声明的键;`additionalProperties:false` → 丢未知键;
 *     `additionalProperties` 为子 schema → 递归保留;为 true/缺省 → 保留(遵循 JSON Schema)。
 *     污染键(__proto__/prototype/constructor)一律丢。
 *   - array:按 `items` 递归每个元素。
 *   - 标量/类型不匹配:原样返回(结果类型强校验非本切片安全边界,留给执行层)。
 * 这样上游回显在**白名单外字段**的 canary 结构上被剥掉;白名单内字段的 canary 由
 * 后续 redactDeep 再抹。
 */
export function projectResultAllowlist(schema: unknown, value: unknown, depth = 0): unknown {
  if (depth > MAX_PROJECT_DEPTH || schema === null || typeof schema !== 'object') return value
  const s = schema as Record<string, unknown>
  if (s.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props =
      s.properties !== null && typeof s.properties === 'object'
        ? (s.properties as Record<string, unknown>)
        : {}
    const additional = s.additionalProperties
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (POLLUTION_KEYS.has(k)) continue
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        out[k] = projectResultAllowlist(props[k], v, depth + 1)
      } else if (additional !== null && typeof additional === 'object') {
        out[k] = projectResultAllowlist(additional, v, depth + 1)
      } else if (additional === false) {
        // 未知键 + strict → 丢弃(allowlist)。
      } else {
        out[k] = v // additionalProperties true / 缺省 → 保留(标准 JSON Schema 语义)。
      }
    }
    return out
  }
  if (s.type === 'array' && Array.isArray(value)) {
    const items = s.items
    if (items !== null && typeof items === 'object') {
      return value.map((el) => projectResultAllowlist(items, el, depth + 1))
    }
    return value
  }
  return value
}

/** 审计/诊断日志 sink(driver 在调用前已对字段脱敏)。 */
export type EngineLogger = (event: string, fields: Record<string, unknown>) => void

export interface EngineHttpDeps {
  /** DNS 解析器注入点(测试注入 rebinding / 多址表)。 */
  resolver?: DnsResolver
  /** fetch 注入点(测试指向受控本地服务器)。 */
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  /** 脱敏后的审计日志 sink(默认无)。 */
  logger?: EngineLogger
}

export interface EngineHttpRequestInput {
  /** 执行权威(载入即验签的 ExecContract)。 */
  contract: ExecContractT
  /** 目标 action(effect/request/result/placements 已签)。 */
  action: ExecActionT
  /** 本次调用的凭据受众(api/token/authorization/upload)。 */
  credentialAudience: CredentialAudienceValue
  /**
   * 目标 origin —— **独立于 audience 集**传入(真实系统里来自审签的 API base /
   * 用户绑定 host / 上游回跳)。driver 用 audience 集**校验**它,故不变量才可强制。
   */
  targetOrigin: string
  /** 引擎解析出的凭据(切片②为测试静态 canary)。 */
  resolvedCreds: ResolvedCredentials
  /** action 入参(materialize path/query/body 用)。 */
  params: unknown
  deps?: EngineHttpDeps
}

/** credentialAudience → policy 对应 origin 集。 */
function audienceOriginSet(
  policy: CredentialAudiencePolicyT,
  aud: CredentialAudienceValue,
): readonly string[] {
  switch (aud) {
    case 'api':
      return policy.apiOrigins
    case 'token':
      return policy.tokenOrigins
    case 'authorization':
      return policy.authorizationOrigins
    case 'upload':
      return policy.unauthenticatedUploadOrigins
  }
}

/** upload 受众:直传对象存储,**不带凭据**。 */
function toUnauthenticatedRequest(plan: {
  method: string
  targetUrl: string
  headers: Record<string, string>
  body?: string
}): InjectedRequest {
  return {
    method: plan.method,
    targetUrl: plan.targetUrl,
    headers: { ...plan.headers },
    ...(plan.body !== undefined ? { body: plan.body } : {}),
    sensitiveValues: [],
  }
}

/** 以脱敏后的 message 重建 ConnectorError(保留 code/status/maybeDelivered)。 */
function redactError(ce: ConnectorError, secrets: readonly string[]): ConnectorError {
  const msg = redactSecrets(ce.message, secrets)
  const out = new ConnectorError(ce.code, msg, ce.httpStatus)
  if (isMaybeDelivered(ce)) markMaybeDelivered(out)
  return out
}

/**
 * 唯一 HTTP 出口。返回**脱敏 + allowlist 剥字段后**的 result。任何失败抛脱敏过的
 * ConnectorError(code 稳定,message 无凭据/无完整 URL)。
 */
export async function engineHttpRequest(input: EngineHttpRequestInput): Promise<unknown> {
  const { contract, action, credentialAudience, targetOrigin, resolvedCreds, params } = input
  const deps = input.deps ?? {}
  const log = deps.logger
  // 基础脱敏集(凭据 secret 值);注入后并入实际注入值。
  let secrets: string[] = collectSecretValues(resolvedCreds)

  try {
    // ① 构造 canonical plan(CRLF/污染构造期拒)。
    const plan = buildRequestPlan(action, params, targetOrigin)
    // 审计:脱敏、注入前的 plan(结构上无凭据)。
    log?.('engine.request.plan', { action: action.id, plan: redactedPlan(plan, secrets) })

    // ② 凭据流向不变量:origin ∈ audience 集,否则不注入直接 OUTBOUND_BLOCKED。
    const allowed = audienceOriginSet(contract.credentialAudiencePolicy, credentialAudience)
    if (!allowed.includes(plan.origin)) {
      log?.('engine.request.blocked', {
        action: action.id,
        reason: 'origin-not-in-audience',
        audience: credentialAudience,
        origin: plan.origin,
      })
      throw new ConnectorError(
        'OUTBOUND_BLOCKED',
        `origin not in ${credentialAudience} audience`,
      )
    }

    // ③+④ 注入凭据(仅 origin 匹配后到达)。upload 受众永不带凭据。
    const injected =
      credentialAudience === 'upload'
        ? toUnauthenticatedRequest(plan)
        : injectCredentials(plan, action.apiCredentialPlacements, resolvedCreds)
    if (injected.sensitiveValues.length > 0) secrets = [...secrets, ...injected.sensitiveValues]

    // ⑤ SSRF + 发送:复用 pinnedHttpsFetch(全 DNS 校验 + IP 钉死 + redirect:error + 超时)。
    let res: Response
    try {
      res = await pinnedHttpsFetch(
        new URL(injected.targetUrl),
        {
          method: injected.method,
          headers: injected.headers,
          ...(injected.body !== undefined ? { body: injected.body } : {}),
        },
        { resolver: deps.resolver, fetchImpl: deps.fetchImpl },
      )
    } catch (err) {
      throw mapFetchFailure(err, DRIVER_TAG)
    }

    // ⑥ 响应:非 2xx 吞 body(绝不读 → 上游 body 里的 token 结构上进不来)。
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw mapUpstreamStatus(res.status, DRIVER_TAG)
    }
    const raw = await readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, DRIVER_TAG)

    // 结果 allowlist 剥字段(白名单外字段丢弃)+ 硬限(256KB/深8/数组200)。
    const cleaned = projectResultAllowlist(action.result, raw)
    enforceResultLimits(cleaned)

    // ⑦ 全链脱敏返回值(上游若把 token 回显进白名单字段,也抹掉)。
    const safeResult = redactDeep(cleaned, secrets)
    log?.('engine.request.ok', { action: action.id, status: res.status })
    return safeResult
  } catch (err) {
    const ce = err instanceof ConnectorError ? err : toConnectorError(err)
    const safe = redactError(ce, secrets)
    log?.('engine.request.error', {
      action: action.id,
      code: safe.code,
      message: safe.message,
    })
    throw safe
  }
}
