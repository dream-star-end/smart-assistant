/**
 * 连接器平台 · 声明式凭据袋(RFC §3 bind 层)。
 *
 * 手写 v1 store 把 secret 形状按四个 provider 硬编码(SECRET_SCHEMAS[provider])。声明式平台
 * 的凭据形状必须**由 auth_contract 驱动**:一个 `DeclarativeSecretBag = Record<source, string>`,
 * key 只能取该 authMode 允许的 credential source 名。本模块是"authMode → 凭据袋形状"与
 * "bag ↔ 引擎 ResolvedCredentials"的单一映射,新增 authMode 只在这里扩。
 *
 * **两种形状,别混用**(oauth2 切片 B 引入的关键区分):
 *   - `requiredBindSources(contract)` = **用户直填**的 source(前端表单字段 / catalog 投影)。
 *     oauth2-auth-code:用户在 OAuth start 表单填 client_id + client_secret(BYOA),
 *     access_token/refresh_token 由授权流程获得,用户不直填。
 *   - `storedBagSources(contract)` = **落库**的袋形状(执行期 decryptBagFromRow 复校验的权威)。
 *     oauth2-auth-code:access_token(执行凭据)+ client_id/client_secret(供日后 refresh 轮换)
 *     + 可选 refresh_token(上游可能不回)。
 *   static-token / token-exchange 两者恰好相等(用户填什么就存什么),oauth2 则不等 —— 这正是
 *   过去把两者当成一件事会出错的地方。
 */

import { ConnectorError } from '../errors.js'
import type { AuthModeValue, ClientProvisioningT, ExecContractT } from '../spec/types.js'
import type { ResolvedCredentials } from './placement.js'

/** 用户 bind 时直填 / 落库的凭据袋(明文,仅在 master 内存活;落库前 AEAD 加密)。 */
export type DeclarativeSecretBag = Record<string, string>

const MAX_SECRET_LEN = 4096
// biome-ignore lint/suspicious/noControlCharactersInRegex: 凭据值会进 header,禁 CR/LF/控制符
const HAS_CONTROL = /[\x00-\x1f\x7f]/

/**
 * oauth2 契约的 client 供给模式 —— **单一读取口**(禁止各处散写
 * `contract.oauth2?.clientProvisioning ?? 'byoa'`:那种隐式默认值一旦漂移就是"platform 连接器
 * 被当成 byoa 处理"的安全事故)。契约缺 oauth2 块 = 编译器不变量被破坏 → INTERNAL fail-closed。
 *
 * 非 oauth2 契约调用本函数 = 编程错误(它们没有 client 概念)。
 */
export function oauth2ClientProvisioning(contract: ExecContractT): ClientProvisioningT {
  if (contract.authMode !== 'oauth2-auth-code')
    throw new ConnectorError('INTERNAL', 'clientProvisioning queried on non-oauth2 contract')
  const cfg = contract.oauth2
  if (cfg === undefined)
    throw new ConnectorError('INTERNAL', 'oauth2 contract has no oauth2 config')
  return cfg.clientProvisioning
}

/** token-exchange:交换请求引用的规范 source 去重(client_id/client_secret/refresh_token 等)。 */
function exchangeSources(contract: ExecContractT): string[] {
  if (contract.tokenAcquisition === undefined)
    throw new ConnectorError('INTERNAL', 'token-exchange contract missing tokenAcquisition')
  return [
    ...new Set<string>(
      Object.values(contract.tokenAcquisition.exchangeRequest.credentialFieldNames),
    ),
  ]
}

/**
 * 某 contract 下**用户 bind 时必须直填**的 credential source 名集合(前端表单 / catalog 投影)。
 *   static-token → ['access_token'](单一长期 token,直接作 API 凭据)。
 *   oauth2-auth-code → **按 clientProvisioning 分叉**:
 *     - byoa     → ['client_id','client_secret'](用户自建应用的 client 凭据;access/refresh token
 *                  由授权码流程获得 —— 用户填的 ≠ 落库的,见 storedBagSources);
 *     - platform → **[]**(平台已注册 App,用户一键授权、什么都不填)。
 *   token-exchange → 交换请求引用的规范 source 去重;引擎据此换 access_token,用户不直填 token。
 *   其它 authMode:后续切片按各自 bind 流程接。
 */
export function requiredBindSources(contract: ExecContractT): string[] {
  switch (contract.authMode) {
    case 'static-token':
      return ['access_token']
    case 'oauth2-auth-code':
      return oauth2ClientProvisioning(contract) === 'platform' ? [] : ['client_id', 'client_secret']
    case 'token-exchange':
      return exchangeSources(contract)
    default:
      throw new ConnectorError(
        'BAD_REQUEST',
        `authMode ${contract.authMode} bind not supported yet`,
      )
  }
}

/** 落库凭据袋的形状(required 必须全在,optional 可有可无;其余键一律拒)。 */
export interface StoredBagSources {
  required: string[]
  optional: string[]
}

/**
 * 某 contract 下**落库**(connections.secret_enc)的凭据袋形状 —— 执行期解密复校验的单一权威。
 *   static-token → 用户填的那一个 token 原样存。
 *   token-exchange → 交换输入原样存(每次执行按需换 access_token,换回的进 token 缓存表)。
 *   oauth2-auth-code → **按 clientProvisioning 分叉**:
 *     - byoa     → access_token(必须,执行凭据)+ client_id/client_secret(必须,日后 refresh
 *                  轮换要用)+ refresh_token(**可选**:上游可能不下发,如 GitHub 默认不回);
 *     - platform → **只有 access_token**(必须)+ refresh_token(可选)。client 凭据留在平台表
 *                  (connector_platform_oauth_apps),**绝不复制进每个用户的连接袋** —— 一份 secret
 *                  存 N 份加密副本毫无收益,只会把泄露面按用户数放大;将来 refresh 轮换时引擎
 *                  照样能从平台表现取。
 */
export function storedBagSources(contract: ExecContractT): StoredBagSources {
  switch (contract.authMode) {
    case 'static-token':
      return { required: ['access_token'], optional: [] }
    case 'token-exchange':
      return { required: exchangeSources(contract), optional: [] }
    case 'oauth2-auth-code':
      return oauth2ClientProvisioning(contract) === 'platform'
        ? { required: ['access_token'], optional: ['refresh_token'] }
        : {
            required: ['access_token', 'client_id', 'client_secret'],
            optional: ['refresh_token'],
          }
    default:
      throw new ConnectorError(
        'BAD_REQUEST',
        `authMode ${contract.authMode} bind not supported yet`,
      )
  }
}

/**
 * 严格校验凭据袋:键 ⊆ required∪optional **且** required ⊆ 键(必填一个不缺、未知键一个不许);
 * 每值为非空有界字符串、无控制符/CRLF。失败一律 BAD_REQUEST(不带值,防泄漏)。
 */
export function validateSecretBag(
  bag: unknown,
  requiredSources: readonly string[],
  optionalSources: readonly string[] = [],
): asserts bag is DeclarativeSecretBag {
  if (bag === null || typeof bag !== 'object' || Array.isArray(bag))
    throw new ConnectorError('BAD_REQUEST', 'secret bag must be an object')
  const record = bag as Record<string, unknown>
  const keys = Object.keys(record)
  const required = new Set(requiredSources)
  const allowed = new Set([...requiredSources, ...optionalSources])
  // ① 未知键一律拒(防塞入 driver 不认识 / placement 硬拒的 source)。
  for (const k of keys) {
    if (!allowed.has(k)) throw new ConnectorError('BAD_REQUEST', `unexpected secret source ${k}`)
    const v = record[k]
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SECRET_LEN)
      throw new ConnectorError(
        'BAD_REQUEST',
        `secret source ${k} must be a bounded non-empty string`,
      )
    if (HAS_CONTROL.test(v))
      throw new ConnectorError('BAD_REQUEST', `secret source ${k} has control char`)
  }
  // ② 必填一个不缺(缺 → 执行期才炸不如 bind/解密期挡)。
  for (const need of required) {
    if (!Object.hasOwn(record, need))
      throw new ConnectorError('BAD_REQUEST', `secret source ${need} missing`)
  }
}

/**
 * 凭据袋 → 引擎 driver 的 ResolvedCredentials。**只映射可作 API placement 的 source**
 * (access_token / client_id / auxiliary);client_secret / refresh_token **结构上不进这里**
 * (§3.3,driver placement 亦硬拒)—— oauth2 的袋里虽然存着它们,但注入层永远看不到。
 */
export function bagToResolvedCredentials(
  authMode: AuthModeValue,
  bag: DeclarativeSecretBag,
): ResolvedCredentials {
  switch (authMode) {
    case 'static-token':
      return { accessToken: bag.access_token }
    case 'oauth2-auth-code':
      // client_id 是公开标识(非凭据),某些上游要求随 API 请求带上;client_secret/refresh_token 不给。
      // **platform 模式的袋里结构上就没有 client_id**(client 凭据留平台表)→ 只出 accessToken。
      // 判据取自袋形状本身(袋已由 storedBagSources 校验过),故与 clientProvisioning 天然一致。
      return {
        accessToken: bag.access_token,
        ...(bag.client_id !== undefined ? { clientId: bag.client_id } : {}),
      }
    default:
      throw new ConnectorError('BAD_REQUEST', `authMode ${authMode} not injectable yet`)
  }
}
