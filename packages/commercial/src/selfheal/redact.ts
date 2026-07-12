/**
 * v5 自愈体系收尾批(M4)— 自愈面自由文本脱敏清洗。
 *
 * 背景:auditRedact.redactSensitive 只按 **key 名**识别敏感字段,值内嵌的凭据
 * (codex 回传日志里 `Authorization: Bearer xxx` / `sk-...` / URL userinfo)会原样
 * 穿透。自愈链路的自由文本(repair detail/summary/context snapshot)全部出自
 * codex/探测器,可能夹带真实凭据 → 在 key 级脱敏之上叠加**值级字符串清洗**。
 *
 * 保守模式(只清高置信凭据形状,不动一般 hex/id):
 *   - `sk-\w{8,}`                 OpenAI/兼容 API key
 *   - `Bearer <token>`            Authorization 头值
 *   - `ghp_/gho_...`              GitHub token
 *   - `xoxb-/xoxa-/xoxp-...`      Slack token
 *   - `AKIA[0-9A-Z]{16}`          AWS access key id
 *   - URL userinfo(scheme://user:pass@host)
 *   - `password=/passwd=/secret=/token=/api_key=` 尾随值(query/env 形态)
 *
 * **不改全局 auditRedact**:admin 审计里长 hex 是合法 request id,全局值清洗会误伤;
 * 本模块只应用于自愈面出口(repairContext / selfhealRepairs safeDetail / selfhealOps
 * admin detail)。
 */

import { redactSensitive } from "../admin/auditRedact.js";

const MAX_DEPTH = 8;

/** [pattern, replacement] 保守清洗规则(见文件头)。全部带 g flag,幂等可重复应用。 */
const STRING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-\w{8,}/g, "[redacted:key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]"],
  [/\bgh[po]_\w+/g, "[redacted:key]"],
  [/\bxox[bap]-[\w-]+/g, "[redacted:key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted:key]"],
  // URL userinfo:scheme://user:pass@host → scheme://[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\/\s@:]+:[^\/\s@]+@/gi, "$1[redacted]@"],
  // password=xxx / secret=xxx / token=xxx / api_key=xxx 尾随值(env/query 形态)。
  [/\b(password|passwd|secret|token|api[_-]?key)\s*=\s*[^\s&"'`]+/gi, "$1=[redacted]"],
];

/** 清洗单个字符串(导出供 message 级写点直接用)。 */
export function scrubSecretsInString(s: string): string {
  let out = s;
  for (const [re, rep] of STRING_PATTERNS) out = out.replace(re, rep);
  return out;
}

function deepScrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubSecretsInString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth-capped]";
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepScrub(v, depth + 1);
  }
  return out;
}

/**
 * 自愈面统一脱敏出口:key 级(redactSensitive)+ 值级字符串清洗(深度遍历)。
 * 纯字符串入参同样清洗(redactSensitive 对标量是 no-op,值级规则接管)。
 */
export function redactOpsPayload(value: unknown): unknown {
  return deepScrub(redactSensitive(value), 0);
}
