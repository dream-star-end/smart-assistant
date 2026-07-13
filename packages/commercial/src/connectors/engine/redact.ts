/**
 * 连接器平台 · 引擎 driver 全链脱敏(RFC §4 步骤6 / §3.3 query 脱敏)。
 *
 * driver **所有对外输出**(error.message / 审计日志 / redactedPlan / 返回 result)
 * 必经此文件。两条纪律:
 *   - `redactSecrets`:exact substring 抹掉每个凭据 secret 值(不是正则/模糊匹配 ——
 *     token 里可能含正则元字符,split/join 做字面量 replace-all,无 ReDoS)。
 *   - `redactUrl`:去掉 query + userinfo + fragment(微信系 token 在 query → HTTP
 *     错误/日志绝不含完整 URL,RFC §4);保留 origin+path 供诊断。
 *
 * 二者叠加使用:凡要记录 URL,先 `redactUrl` 去 query,再 `redactSecrets` 抹路径/host
 * 里可能残留的 secret,双保险。
 */

export const REDACTED = '[REDACTED]'

/** 递归脱敏最大深度(防深度炸弹;超过即原样返回,不递归)。 */
const MAX_REDACT_DEPTH = 64

/**
 * 把 text 里**精确出现**的每个 secret 值替换为 `[REDACTED]`。
 * - 字面量 replace-all(split/join),不解释正则元字符。
 * - 空串 secret 跳过(否则会在每个字符间插入 REDACTED)。
 */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const s of secretValues) {
    if (typeof s !== 'string' || s.length === 0) continue
    if (out.includes(s)) out = out.split(s).join(REDACTED)
  }
  return out
}

/**
 * 去掉 URL 的 query / fragment / userinfo,只留 `scheme://host[:port]/path`。
 * 不可解析时退化为按 `#`/`?` 截断(fail-safe:宁可多截也不泄漏 query)。
 */
export function redactUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return rawUrl
  try {
    const u = new URL(rawUrl)
    u.search = ''
    u.hash = ''
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    const noHash = rawUrl.split('#')[0] ?? rawUrl
    return noHash.split('?')[0] ?? noHash
  }
}

/**
 * 深度脱敏任意 JSON 值(返回 result 出口用):对每个字符串字段跑 `redactSecrets`。
 * 键名不脱敏(来自 result allowlist schema,非 secret)。结构保持不变。
 */
export function redactDeep<T>(value: T, secretValues: readonly string[]): T {
  if (secretValues.length === 0) return value
  return walk(value, secretValues, 0) as T
}

function walk(v: unknown, secrets: readonly string[], depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return v
  if (typeof v === 'string') return redactSecrets(v, secrets)
  if (Array.isArray(v)) return v.map((x) => walk(x, secrets, depth + 1))
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, secrets, depth + 1)
    }
    return out
  }
  return v
}
