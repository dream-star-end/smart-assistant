/**
 * 连接器 Contract 内核 · 签名唯一信任根(RFC §6.1 / §10.1)。
 *
 * 信任根 = 签名(删 DB-only 备选):`exec_contract` 附 `signature/key_id`,签名覆盖
 * `listingSlug + versionId + kind + specHash + execContractHash + compilerVersion +
 * policyVersion`。execute/载入必须**验签名 + 覆盖字段与连接/账本一致**,不是信 JSON
 * 里有个字段叫 signed。任一覆盖字段被篡改 → verify 必失败。
 *
 * 密钥派生:`HKDF(loadKmsKey(), info='connector-exec-contract-sign-v1')`,派生 key
 * 用后 zeroBuffer。`keyId` 供轮换 —— **仅 contract bytes 不变时可换 keyId 重签**
 * (keyId 不进签名覆盖字节,故重签不改 hash/语义版本,§6.1)。恒定时间比较验签。
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { loadKmsKey, zeroBuffer } from '../../crypto/keys.js'
import { canonicalBytes } from './canonical.js'
import { ConnectorSpecError } from './types.js'

/** keyId → HKDF info(轮换:新 keyId 追加新 info;旧 keyId 仍可验历史签名)。 */
const KEY_INFOS: Readonly<Record<string, string>> = {
  v1: 'connector-exec-contract-sign-v1',
}
export const CURRENT_SIGNING_KEY_ID = 'v1'

/**
 * 签名覆盖字段(canonical 顺序无关;这些字段任一变 → 签名变)。
 * `kind` 是 **DB 事实**(join listing 读到,不是硬编码常量,P0-2):签名/验签都用
 * DB 读到的真实 kind,listing.kind 被篡改则验签必失败。
 */
export interface ContractSignMeta {
  listingSlug: string
  versionId: number
  kind: string
  specHash: string
  execContractHash: string
  compilerVersion: number
  policyVersion: number
}

function deriveSignKey(keyId: string, env: NodeJS.ProcessEnv): Buffer {
  const info = KEY_INFOS[keyId]
  if (!info) {
    throw new ConnectorSpecError('SIGNATURE_INVALID', `unknown signing keyId: ${keyId}`)
  }
  const kms = loadKmsKey(env)
  try {
    return Buffer.from(hkdfSync('sha256', kms, Buffer.alloc(0), info, 32))
  } finally {
    zeroBuffer(kms)
  }
}

/** 覆盖字段的 canonical bytes(签名的输入)。keyId **不**在其中(允许重签换 keyId)。 */
function signBytes(meta: ContractSignMeta): Buffer {
  return canonicalBytes({
    listingSlug: meta.listingSlug,
    versionId: meta.versionId,
    kind: meta.kind,
    specHash: meta.specHash,
    execContractHash: meta.execContractHash,
    compilerVersion: meta.compilerVersion,
    policyVersion: meta.policyVersion,
  })
}

function hmacHex(meta: ContractSignMeta, keyId: string, env: NodeJS.ProcessEnv): string {
  const key = deriveSignKey(keyId, env)
  try {
    return createHmac('sha256', key).update(signBytes(meta)).digest('hex')
  } finally {
    zeroBuffer(key)
  }
}

export interface ContractSignature {
  signature: string // HMAC-SHA256 hex
  keyId: string
}

/** 用当前(或指定)signing key 对覆盖字段签名。 */
export function signContract(
  meta: ContractSignMeta,
  opts: { keyId?: string; env?: NodeJS.ProcessEnv } = {},
): ContractSignature {
  const keyId = opts.keyId ?? CURRENT_SIGNING_KEY_ID
  const env = opts.env ?? process.env
  return { signature: hmacHex(meta, keyId, env), keyId }
}

/**
 * 恒定时间验签。任一覆盖字段(specHash/execContractHash/policyVersion/versionId/
 * listingSlug/compilerVersion/kind)或 signature 被篡改 → false。未知 keyId → false。
 */
export function verifyContract(
  meta: ContractSignMeta,
  signature: string,
  keyId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!KEY_INFOS[keyId]) return false
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false
  let expected: string
  try {
    expected = hmacHex(meta, keyId, env)
  } catch {
    return false
  }
  const a = Buffer.from(signature, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
