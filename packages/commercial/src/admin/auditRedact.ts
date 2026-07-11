/**
 * admin_audit before/after 中央脱敏钩子(审计体系整改批)。
 *
 * 动机:admin_audit 是 append-only 永久保留表,一旦密钥/令牌明文入库就永远删不掉
 * (DELETE 被 RULE 吞)。此前脱敏靠各调用点自觉(literature/research config 做了,
 * system_settings.set 全量 value 原样入库——实际缺口)。本模块在 writeAdminAudit
 * 入口统一深走 before/after,按 key 模式识别敏感值,调用点无需再各自记得脱敏
 * (已有的调用点级脱敏仍保留,双保险不冲突)。
 *
 * 脱敏语义:值替换为 `{ __redacted: true, len, last4? }` 元信息——保留"改没改/
 * 改成多长"的审计价值,丢弃明文。last4 只对 ≥12 字符的字符串给(短值给尾巴等于泄露)。
 */

/**
 * 命中即脱敏的 key 模式(大小写不敏感)。有意偏宽:审计里宁可多脱不可漏脱。
 * `token(?!s)` 排除复数——`max_tokens`/`input_tokens` 是计费/模型配置快照里的
 * 合法计数字段,脱掉它们等于抹掉审计价值;单数 `token`(access_token/bot_token…)
 * 才是凭据。裸 `key` 不匹配(太多普通含义),只匹配 api/private/access/signing 组合。
 */
export const SENSITIVE_KEY_RE =
  /(secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?key|signing[_-]?key|token(?!s))/i;

const MAX_DEPTH = 8;

export interface RedactedMeta {
  __redacted: true;
  len?: number;
  last4?: string;
}

function redactedMetaFor(v: unknown): RedactedMeta {
  if (typeof v === "string") {
    const meta: RedactedMeta = { __redacted: true, len: v.length };
    if (v.length >= 12) meta.last4 = v.slice(-4);
    return meta;
  }
  return { __redacted: true };
}

/**
 * 深拷贝并脱敏。原对象不被修改。
 *  - 对象:key 命中 SENSITIVE_KEY_RE 且值非 null/undefined → 整值替换为元信息
 *    (包括对象值——嵌套在敏感 key 下的一切都视为敏感)。
 *  - 数组:逐元素递归。
 *  - 深度超过 MAX_DEPTH 的子树整体替换为 "[depth-capped]"(防循环引用/深结构炸栈;
 *    审计快照约定只放受影响字段,正常不会到这个深度)。
 *  - 非对象标量原样返回。
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth-capped]";
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k) && v !== null && v !== undefined) {
      // 已是调用点级脱敏产物(如 literature_config 的 {set,len,last4})→ 不二次包裹。
      out[k] = isAlreadyRedactedShape(v) ? v : redactedMetaFor(v);
    } else {
      out[k] = redactSensitive(v, depth + 1);
    }
  }
  return out;
}

/**
 * 识别调用点已自行脱敏的形状,避免把 {set,len,last4} / {__redacted} 再包一层
 * 变成无意义的 {__redacted,len:N}。判定从宽:纯元信息小对象(全部 key 落在
 * 已知元信息字段集内)视为已脱敏。
 */
function isAlreadyRedactedShape(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length === 0) return false;
  const metaKeys = new Set(["__redacted", "set", "len", "last4", "length", "masked"]);
  return keys.every((k) => metaKeys.has(k));
}
