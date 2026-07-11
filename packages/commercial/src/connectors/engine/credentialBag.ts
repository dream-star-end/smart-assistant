/**
 * 连接器平台 · 声明式凭据袋(RFC §3 bind 层)。
 *
 * 手写 v1 store 把 secret 形状按四个 provider 硬编码(SECRET_SCHEMAS[provider])。声明式平台
 * 的凭据形状必须**由 auth_contract 驱动**:一个 `DeclarativeSecretBag = Record<source, string>`,
 * key 只能取该 authMode 需要用户提供的 credential source 名。本模块是"authMode → 需要哪些 source"
 * 与"bag ↔ 引擎 ResolvedCredentials"的单一映射,新增 authMode 只在这里扩。
 *
 * slice③ 只落 static-token(用户提供一个长期 token,source 名 `access_token`);其余 authMode
 * 在后续切片接入(oauth 的 token 由流程获得而非用户直填,故 requiredBindSources 为空)。
 */

import { ConnectorError } from '../errors.js'
import type { AuthModeValue, ExecContractT } from '../spec/types.js'
import type { ResolvedCredentials } from './placement.js'

/** 用户 bind 时直填的凭据袋(明文,仅在 master 内存活;落库前 AEAD 加密)。 */
export type DeclarativeSecretBag = Record<string, string>

const MAX_SECRET_LEN = 4096
// biome-ignore lint/suspicious/noControlCharactersInRegex: 凭据值会进 header,禁 CR/LF/控制符
const HAS_CONTROL = /[\x00-\x1f\x7f]/

/**
 * 某 contract 下**用户 bind 时必须直填**的 credential source 名集合。
 *   static-token → ['access_token'](单一长期 token,直接作 API 凭据)。
 *   token-exchange → 交换请求引用的规范 source 去重(client_id/client_secret/refresh_token 等);
 *     这些是**交换输入**,引擎据此换 access_token,用户不直填 access_token。
 *   其它 authMode:后续切片按各自 bind 流程接。
 */
export function requiredBindSources(contract: ExecContractT): string[] {
  switch (contract.authMode) {
    case 'static-token':
      return ['access_token']
    case 'token-exchange': {
      if (contract.tokenAcquisition === undefined)
        throw new ConnectorError('INTERNAL', 'token-exchange contract missing tokenAcquisition')
      const set = new Set<string>(
        Object.values(contract.tokenAcquisition.exchangeRequest.credentialFieldNames),
      )
      return [...set]
    }
    default:
      throw new ConnectorError('BAD_REQUEST', `authMode ${contract.authMode} bind not supported yet`)
  }
}

/**
 * 严格校验凭据袋:key 恰等于 requiredSources(不多不少)、每值为非空有界字符串、无控制符/CRLF。
 * 失败一律 BAD_REQUEST(不带值,防泄漏)。
 */
export function validateSecretBag(
  bag: unknown,
  requiredSources: readonly string[],
): asserts bag is DeclarativeSecretBag {
  if (bag === null || typeof bag !== 'object' || Array.isArray(bag))
    throw new ConnectorError('BAD_REQUEST', 'secret bag must be an object')
  const keys = Object.keys(bag as Record<string, unknown>)
  const need = new Set(requiredSources)
  if (keys.length !== need.size)
    throw new ConnectorError('BAD_REQUEST', 'secret bag key set mismatch')
  for (const k of keys) {
    if (!need.has(k)) throw new ConnectorError('BAD_REQUEST', `unexpected secret source ${k}`)
    const v = (bag as Record<string, unknown>)[k]
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SECRET_LEN)
      throw new ConnectorError('BAD_REQUEST', `secret source ${k} must be a bounded non-empty string`)
    if (HAS_CONTROL.test(v))
      throw new ConnectorError('BAD_REQUEST', `secret source ${k} has control char`)
  }
}

/**
 * 凭据袋 → 引擎 driver 的 ResolvedCredentials。**只映射可作 API placement 的 source**
 * (access_token / client_id / auxiliary);client_secret / refresh_token 结构上不进这里
 * (§3.3,driver placement 亦硬拒)。slice③ static-token:access_token → accessToken。
 */
export function bagToResolvedCredentials(
  authMode: AuthModeValue,
  bag: DeclarativeSecretBag,
): ResolvedCredentials {
  switch (authMode) {
    case 'static-token':
      return { accessToken: bag.access_token }
    default:
      throw new ConnectorError('BAD_REQUEST', `authMode ${authMode} not injectable yet`)
  }
}
