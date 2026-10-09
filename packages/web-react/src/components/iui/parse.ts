/**
 * Intelligent UI(OCV5-361)—— ```ui 围栏里的 JSON 解析。
 *
 * 三条路径:
 *   - 严格:整块是一个合法 JSON 对象(允许首尾空白、对象后的多余文字被忽略)。
 *   - 宽容修复:去尾逗号后再试一次(模型最常见的手误)。
 *   - 半截补全(流式):把尚未写完的 JSON 截到最后一个「安全点」再补齐括号,
 *     让表格行、图表点能随生成逐步出现。正在写的字符串值会被临时闭合。
 * 任何失败都返回 ok:false,调用方降级为原文,绝不抛错。
 */

/** 单个 ui 块的大小上限:超过就按原文显示,避免超大块拖慢渲染。 */
export const IUI_MAX_BLOCK_BYTES = 64 * 1024;

export type ParseResult =
  | { ok: true; value: Record<string, unknown>; complete: boolean }
  | { ok: false; reason: "empty" | "too_large" | "not_object" | "invalid" };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 从首个 `{` 起找到与之配对的 `}`;找不到(半截)返回 null。 */
export function sliceFirstObject(source: string): string | null {
  const start = source.search(/\S/);
  if (start < 0 || source[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** 去掉 `,}` / `,]` 前的尾逗号(只在字符串外)。 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      const rest = text.slice(i + 1);
      const next = rest.search(/\S/);
      if (next >= 0 && (rest[next] === "}" || rest[next] === "]")) continue;
    }
    out += ch;
  }
  return out;
}

type Frame = { kind: "obj" | "arr"; state: "key" | "colon" | "value" | "comma" };

/**
 * 半截 JSON → 可解析的最长前缀 + 补齐的闭括号。
 * 「安全点」= 刚打开一个容器,或刚写完一个完整的值。写到一半的数字/字面量/键丢弃;
 * 写到一半的字符串**值**保留并临时闭合(流式时文字逐字出现)。
 */
export function completePartialJson(source: string): string | null {
  const start = source.search(/\S/);
  if (start < 0 || source[start] !== "{") return null;
  const stack: Frame[] = [];
  let safeLen = -1;
  let safeClosers = "";
  const closers = () =>
    stack
      .slice()
      .reverse()
      .map((f) => (f.kind === "obj" ? "}" : "]"))
      .join("");
  const markSafe = (endExclusive: number) => {
    safeLen = endExclusive;
    safeClosers = closers();
  };
  const valueDone = () => {
    const top = stack[stack.length - 1];
    if (top) top.state = "comma";
  };

  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === "{" || ch === "[") {
      if (top && top.state !== "value") return safeLen >= 0 ? source.slice(start, safeLen) + safeClosers : null;
      stack.push({ kind: ch === "{" ? "obj" : "arr", state: ch === "{" ? "key" : "value" });
      i += 1;
      markSafe(i);
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i += 1;
      if (stack.length === 0) return source.slice(start, i);
      valueDone();
      markSafe(i);
      continue;
    }
    if (ch === ",") {
      if (top) top.state = top.kind === "obj" ? "key" : "value";
      i += 1;
      continue;
    }
    if (ch === ":") {
      if (top) top.state = "value";
      i += 1;
      continue;
    }
    if (ch === '"') {
      const isKey = top?.kind === "obj" && top.state === "key";
      let j = i + 1;
      let esc = false;
      let closed = false;
      for (; j < source.length; j++) {
        const c = source[j]!;
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) {
        if (isKey || !top) break;
        // 正在写的字符串值:去掉悬空的转义/半个 \uXXXX,临时闭合。
        let body = source.slice(i + 1);
        body = body.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
        return `${source.slice(start, i)}"${body}"${closers()}`;
      }
      i = j + 1;
      if (isKey) {
        if (top) top.state = "colon";
      } else {
        valueDone();
        markSafe(i);
      }
      continue;
    }
    // 数字 / true / false / null
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(source.slice(i));
    if (!m) break;
    const end = i + m[0].length;
    if (end >= source.length) break; // 可能还没写完(如 "12" 后面还有 "3")
    i = end;
    valueDone();
    markSafe(i);
  }
  return safeLen >= 0 ? source.slice(start, safeLen) + safeClosers : null;
}

/**
 * 解析一个 ui 块。`allowPartial` = 消息仍在流式生成:严格解析失败时尝试半截补全。
 */
export function parseUiBlock(code: string, allowPartial: boolean): ParseResult {
  if (!code.trim()) return { ok: false, reason: "empty" };
  if (new TextEncoder().encode(code).length > IUI_MAX_BLOCK_BYTES) return { ok: false, reason: "too_large" };
  const first = code.search(/\S/);
  if (code[first] !== "{") return { ok: false, reason: "not_object" };

  const whole = sliceFirstObject(code);
  if (whole) {
    const strict = tryParseObject(whole) ?? tryParseObject(stripTrailingCommas(whole));
    if (strict) return { ok: true, value: strict, complete: true };
    if (!allowPartial) return { ok: false, reason: "invalid" };
  }
  if (!allowPartial) {
    // 已结束却没闭合:补全一次当作宽容修复(模型漏写最后的 `}` 很常见)。
    const repaired = completePartialJson(code);
    const v = repaired ? tryParseObject(repaired) ?? tryParseObject(stripTrailingCommas(repaired)) : null;
    return v ? { ok: true, value: v, complete: true } : { ok: false, reason: "invalid" };
  }
  const completed = completePartialJson(code);
  const v = completed ? tryParseObject(completed) ?? tryParseObject(stripTrailingCommas(completed)) : null;
  return v ? { ok: true, value: v, complete: false } : { ok: false, reason: "invalid" };
}
