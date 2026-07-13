/**
 * 连接器 Contract 内核 · 确定性 canonical bytes + sha256。
 *
 * 复用既有 `connectors/canonicalJson.ts`(canonicalization_version=1:键排序 +
 * UTF-8 稳定 stringify,跨键序稳定)—— 不另造第二套规范化。spec_hash /
 * exec_contract_hash / 签名覆盖字节全部经此,保证"同内容不同键序 → 同 bytes / 同 hash"。
 */

import { createHash } from 'node:crypto'
import { canonicalStringify } from '../canonicalJson.js'

/** 确定性 canonical UTF-8 字节(键排序递归稳定)。 */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalStringify(value), 'utf8')
}

/** sha256(bytes) → 小写 hex。 */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** sha256(canonicalBytes(value)) → 小写 hex(spec_hash / exec_contract_hash 用)。 */
export function canonicalSha256Hex(value: unknown): string {
  return sha256Hex(canonicalBytes(value))
}
