/**
 * 连接器平台 · 引擎 driver 之凭据注入(RFC §3.3 类型化多凭据注入)。
 *
 * `injectCredentials(plan, placements, resolvedCreds)` → 注入后 request。
 * **driver 在 origin 匹配 audience 之后**才调它(凭据流向不变量:origin 不匹配 → 根本
 * 不进这里,凭据结构上不注入)。三种 placement:
 *   - `authorization-bearer`(source 必 access_token)→ `Authorization: Bearer <token>`;
 *   - `header{name, valuePrefix?}`→ 通用头(运行期再断言 name ∉ {authorization, host}
 *     大小写不敏感;valuePrefix / 值禁 CR/LF);
 *   - `query{name}`→ query 参(记为敏感值,driver 脱敏时抹)。
 *
 * source 只能取引擎提供的 access_token / client_id / auxiliary.X;**client_secret /
 * refresh_token 运行期硬拒**(schema 已排除,这里是第二道保险,§3.3)。
 */

import { ConnectorError } from '../errors.js'
import type { ApiCredentialPlacementT } from '../spec/types.js'
import { type CanonicalRequestPlan, composeUrl } from './requestPlan.js'

/** 引擎解析出的凭据(测试期为静态注入的 canary)。 */
export interface ResolvedCredentials {
  accessToken?: string
  clientId?: string
  /** 存在但**绝不可**作 API placement source(§3.3);仅供 token 交换/刷新层。 */
  clientSecret?: string
  /** 同上,绝不可作 API placement。 */
  refreshToken?: string
  /** token 响应派生的有界辅助输出(如腾讯文档 openId)。 */
  auxiliary?: Record<string, string>
}

/** 注入凭据后的最终 request。 */
export interface InjectedRequest {
  method: string
  targetUrl: string
  headers: Record<string, string>
  body?: string
  /** 实际注入到 header/query 的凭据值(driver 脱敏集合并入)。 */
  sensitiveValues: string[]
}

const RESERVED_HEADERS: ReadonlySet<string> = new Set(['authorization', 'host'])
const HAS_CRLF = /[\r\n]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control chars in injected credential values
const HAS_CONTROL = /[\x00-\x1f\x7f]/

/**
 * 收集需要脱敏的凭据 secret 值(access_token / client_secret / refresh_token / aux)。
 * client_id 是公开标识,不入基础脱敏集;若它真被注入,由 sensitiveValues 兜住。
 */
export function collectSecretValues(creds: ResolvedCredentials): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push(v)
  }
  push(creds.accessToken)
  push(creds.clientSecret)
  push(creds.refreshToken)
  if (creds.auxiliary) for (const v of Object.values(creds.auxiliary)) push(v)
  return out
}

/**
 * 把 placement.source 解析为凭据值。**只接受引擎有限枚举**;client_secret/refresh_token/
 * 任意其它 → 运行期硬拒(BAD_REQUEST)。
 */
function resolveSource(source: string, creds: ResolvedCredentials): string {
  if (source === 'access_token') return required(creds.accessToken, 'access_token')
  if (source === 'client_id') return required(creds.clientId, 'client_id')
  const m = /^auxiliary\.([A-Za-z0-9_]{1,32})$/.exec(source)
  if (m) return required(creds.auxiliary?.[m[1] as string], source)
  // client_secret / refresh_token / 其它 → 结构上不可作 API placement(§3.3)。
  throw new ConnectorError('BAD_REQUEST', 'credential source not injectable')
}

function required(v: string | undefined, source: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new ConnectorError('BAD_REQUEST', `credential ${source} unavailable`)
  return v
}

/** 大小写不敏感地设置头;重复(同名已存在)→ 拒(防覆盖/走私)。 */
function setHeaderChecked(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower)
      throw new ConnectorError('BAD_REQUEST', `duplicate header ${name}`)
  }
  headers[name] = value
}

export function injectCredentials(
  plan: CanonicalRequestPlan,
  placements: readonly ApiCredentialPlacementT[],
  creds: ResolvedCredentials,
): InjectedRequest {
  const headers: Record<string, string> = { ...plan.headers }
  const query: Array<[string, string]> = [...plan.query]
  const sensitiveValues: string[] = []

  for (const p of placements) {
    const value = resolveSource(p.source, creds)
    if (HAS_CONTROL.test(value))
      throw new ConnectorError('BAD_REQUEST', 'credential value has control char')

    if (p.placement === 'authorization-bearer') {
      // 唯一可写 Authorization 的类型;运行期再确认 source(双保险)。
      if (p.source !== 'access_token')
        throw new ConnectorError('BAD_REQUEST', 'authorization-bearer requires access_token')
      setHeaderChecked(headers, 'Authorization', `Bearer ${value}`)
      sensitiveValues.push(value)
    } else if (p.placement === 'header') {
      const lower = p.name.toLowerCase()
      if (RESERVED_HEADERS.has(lower))
        throw new ConnectorError('BAD_REQUEST', `reserved header ${p.name}`)
      const prefix = p.valuePrefix ?? ''
      if (HAS_CRLF.test(prefix))
        throw new ConnectorError('BAD_REQUEST', 'valuePrefix contains CRLF')
      setHeaderChecked(headers, p.name, `${prefix}${value}`)
      sensitiveValues.push(value)
    } else {
      // query placement:记为敏感值,脱敏时抹(URL/日志/error)。
      query.push([p.name, value])
      sensitiveValues.push(value)
    }
  }

  const targetUrl =
    query.length === plan.query.length ? plan.targetUrl : composeUrl(plan.origin, plan.path, query)

  return {
    method: plan.method,
    targetUrl,
    headers,
    ...(plan.body !== undefined ? { body: plan.body } : {}),
    sensitiveValues,
  }
}
