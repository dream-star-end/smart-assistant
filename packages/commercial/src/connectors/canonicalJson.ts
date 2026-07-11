/**
 * canonicalJson — 写账本参数的规范化序列化(canonicalization_version=1)。
 *
 * v1 规则(设计终稿 §2/§3):**键排序 + UTF-8 稳定 stringify**。
 *   - object 键按 UTF-16 code unit 升序排序(JS 默认字符串比较,确定性)
 *   - array 保序
 *   - 标量走 JSON.stringify(number 用 V8 shortest round-trip,确定性;-0 → "0")
 *   - 拒绝:undefined / function / symbol / bigint / 非有限 number / 循环引用 /
 *     非 plain object(Date、Map、Buffer 等 —— 参数必须先转成纯 JSON 值)
 *
 * 用途:
 *   - propose 时 canonicalStringify(params) → sha256 → params_hash(跨键序稳定)
 *   - 加密账本的明文即该 canonical 字符串(解密后 hash 复核完整性)
 *   - result_digest = sha256(canonicalStringify(result))
 *
 * 版本演进:改变任何规则必须 bump CANONICALIZATION_VERSION 并保留 v1 实现
 * (存量账本行按其 canonicalization_version 校验)。
 */

import { createHash } from 'node:crypto'

export const CANONICALIZATION_VERSION = 1

/** 序列化深度硬上限(防栈溢出;参数本身另有 depth 8 业务上限,在校验层)。 */
const MAX_DEPTH = 64

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function serialize(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'boolean') return JSON.stringify(value)
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalJsonError('non-finite number not allowed')
    }
    return JSON.stringify(value)
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new CanonicalJsonError(`value of type ${t} not allowed`)
  }
  // object / array
  if (depth >= MAX_DEPTH) throw new CanonicalJsonError('max depth exceeded')
  const obj = value as object
  if (seen.has(obj)) throw new CanonicalJsonError('circular reference')
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => serialize(item, depth + 1, seen))
      return `[${parts.join(',')}]`
    }
    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError('non-plain object not allowed (convert to plain JSON first)')
    }
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k]
      if (v === undefined) {
        // 与 JSON.stringify 对齐:undefined 属性省略。canonical 形态下"键存在但值
        // undefined"与"键不存在"等价 —— 序列化前应已过 TypeBox 严格校验,这里兜底。
        continue
      }
      parts.push(`${JSON.stringify(k)}:${serialize(v, depth + 1, seen)}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    seen.delete(obj)
  }
}

/** 规范化 stringify(v1)。抛 CanonicalJsonError 当值不可规范化。 */
export function canonicalStringify(value: unknown): string {
  return serialize(value, 0, new Set())
}

/** sha256(canonicalStringify(value)) → 32-byte Buffer(params_hash 落库格式)。 */
export function canonicalHash(value: unknown): Buffer {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest()
}

/** sha256 hex digest(result_digest 落库格式)。 */
export function canonicalDigestHex(value: unknown): string {
  return canonicalHash(value).toString('hex')
}
