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
 *
 * 误伤防护(Codex R1 MAJOR#3 + R2 修):`max_tokens` 类计数字段不靠正则排除
 * (复数 lookahead 会放过 `access_tokens` 等复数凭据名)。放行规则收紧为:
 *   - boolean:1 bit 装不下凭据,恒放行;
 *   - number:仅当 key 命中 TOKEN_COUNT_KEY_RE(明确的 token 计数字段形状)才
 *     放行——`{password: 123456}` 这类数值型口令照脱;
 *   - string/对象/数组命中敏感 key 一律脱敏。
 */

/** 命中即候选脱敏的 key 模式(大小写不敏感)。有意宽:审计里宁可多脱不可漏脱。 */
export const SENSITIVE_KEY_RE =
  /(secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?key|signing[_-]?key|token)/i;

/**
 * token 计数字段 allowlist(Codex R2):数值放行仅限这些形状——
 * `max_tokens`/`input_tokens`/`cache_read_tokens`/`tokens_per_credit`/
 * `token_count`/`token_limit` 等;命中敏感 RE 的其余数值(如数值型口令)照脱。
 */
export const TOKEN_COUNT_KEY_RE =
  /(^|[_-])[a-z0-9_-]*tokens?([_-](per|count|used|limit|budget|remaining)[a-z0-9_-]*)?$/i;

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
 *  - 对象:key 命中 SENSITIVE_KEY_RE 且值经 isRedactableValue 判定 → 整值替换为
 *    元信息(嵌套在敏感 key 下的一切都视为敏感);boolean 恒放行,number 仅
 *    TOKEN_COUNT_KEY_RE 计数形状放行(`max_tokens: 4096` 的审计价值必须保留)。
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
    if (SENSITIVE_KEY_RE.test(k) && isRedactableValue(k, v)) {
      // 已是调用点级脱敏产物(如 literature_config 的 {set,len,last4})→ 不二次包裹。
      out[k] = isAlreadyRedactedShape(v) ? v : redactedMetaFor(v);
    } else {
      out[k] = redactSensitive(v, depth + 1);
    }
  }
  return out;
}

/**
 * 值是否需要脱敏(key 已命中敏感 RE 的前提下):
 *   - boolean → 恒放行(1 bit 装不下凭据);
 *   - number → 仅 token 计数形状的 key 放行(数值型口令/PIN 照脱,Codex R2);
 *   - null/undefined → 无内容;
 *   - string/对象/数组 → 脱。
 */
function isRedactableValue(k: string, v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return false;
  if (typeof v === "number") return !TOKEN_COUNT_KEY_RE.test(k);
  return typeof v === "string" || typeof v === "object";
}

/**
 * 识别调用点已自行脱敏的形状,避免把 {set,len,last4} / {__redacted} 再包一层。
 * Codex R1 MAJOR#3 + R2 修:必须**逐字段验类型与长度**,包括 __redacted:true
 * 对象——`{__redacted:true, raw:"<明文>"}` 夹带未知字段一律不信任,整体照脱。
 * 合法形状 = 全部字段落在 {__redacted:true, set/masked:boolean, len/length:number,
 * last4:≤4字符 string} 内且非空对象;任一字段类型不符/出现未知字段 → 照常脱敏。
 */
function isAlreadyRedactedShape(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  for (const k of keys) {
    switch (k) {
      case "__redacted":
        if (o[k] !== true) return false;
        break;
      case "set":
      case "masked":
        if (typeof o[k] !== "boolean") return false;
        break;
      case "len":
      case "length":
        if (typeof o[k] !== "number") return false;
        break;
      case "last4":
        if (typeof o[k] !== "string" || (o[k] as string).length > 4) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}
