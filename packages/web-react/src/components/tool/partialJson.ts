/**
 * 容错 JSON 解析器 —— gateway `tool_use` 帧 `partialJson` 字段（由 Anthropic SSE
 * `input_json_delta` 累加而成）的流式解析。
 *
 * 目的：在 tool_use 块闭合**之前**，从已到达的字节里尽量取出字段，驱动 Edit/Write
 * 等工具卡的边流边渲。这是 streaming UX 专用，不是通用 JSON parser，作用域刻意极小：
 *
 *   • 顶层必须是 JSON 对象，否则返回 {}。
 *   • 字符串值：连同当前正在键入的部分尾串一起取出；缓冲区边缘的半截转义（如末尾
 *     孤立的 `\`）从部分尾串里丢弃。
 *   • 数字 / bool / null：仅在完整时取出。
 *   • 对象 / 数组值：仅在括号配平且对该子串 strict JSON.parse 成功时取出，否则跳过
 *     该字段（绝不臆造半截嵌套结构）。
 *
 * 永不抛错。任何内部失败都返回到目前为止解析出的字段，或 {}（无任何可取字段时）。
 *
 * 端口自现网 packages/web/public/modules/partialJson.js（功能基线，逐字对齐语义）。
 */

const WS = /\s/;

type ScanString = { value: string; end: number; partial: boolean };

/**
 * @param s 原始 partial-JSON 缓冲区。
 * @returns 尽力解析出的字段对象；任何错误下为空对象。
 */
export function parsePartialJson(s: string): Record<string, unknown> {
  if (typeof s !== "string" || s.length === 0) return {};

  // 快路径：完整 JSON。
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    /* 落到部分扫描 */
  }

  // 慢路径：流式扫描。
  let i = 0;
  while (i < s.length && WS.test(s[i])) i++;
  if (s[i] !== "{") return {};
  i++; // 越过 `{`

  const out: Record<string, unknown> = {};
  while (i < s.length) {
    // 跳过条目间的空白 / 逗号。
    while (i < s.length && (WS.test(s[i]) || s[i] === ",")) i++;
    if (i >= s.length) break;
    if (s[i] === "}") break;

    // 解析 key（必须是完整字符串）。
    if (s[i] !== '"') break;
    const keyResult = scanStringTok(s, i);
    if (!keyResult || keyResult.partial) break; // 半截 key → 停
    const key = keyResult.value;
    i = keyResult.end;

    // 期望 ':'。
    while (i < s.length && WS.test(s[i])) i++;
    if (s[i] !== ":") break;
    i++;
    while (i < s.length && WS.test(s[i])) i++;
    if (i >= s.length) break;

    // 解析 value。
    const ch = s[i];
    if (ch === '"') {
      const v = scanStringTok(s, i);
      if (!v) break;
      out[key] = v.value;
      i = v.end;
      if (v.partial) break; // 半截字符串结束本次扫描
    } else if (ch === "{" || ch === "[") {
      const end = scanBalanced(s, i);
      if (end === -1) break; // 未配平 → 停，尾串属于该字段
      try {
        out[key] = JSON.parse(s.slice(i, end));
      } catch {
        /* 跳过字段 */
      }
      i = end;
    } else {
      // number / true / false / null —— 仅在被 `,` / `}` / 空白 终结时取出。
      const start = i;
      while (i < s.length && s[i] !== "," && s[i] !== "}" && !WS.test(s[i])) i++;
      if (i >= s.length) break; // 未终结的原始值
      const token = s.slice(start, i);
      if (token === "true") out[key] = true;
      else if (token === "false") out[key] = false;
      else if (token === "null") out[key] = null;
      else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
        const n = Number(token);
        if (Number.isFinite(n)) out[key] = n;
      }
      // 否则：无法识别 → 跳过字段
    }
  }
  return out;
}

/**
 * 从 `s[i]`（必须是 `"`）开始扫描一个 JSON 字符串。
 * 返回 { value, end, partial }，或对无望输入返回 null。
 * 末尾半截转义（孤立 `\` 或 `\u00` 片段）会被丢弃而非抛错。
 */
function scanStringTok(s: string, i: number): ScanString | null {
  if (s[i] !== '"') return null;
  let j = i + 1;
  let out = "";
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      return { value: out, end: j + 1, partial: false };
    }
    if (c === "\\") {
      if (j + 1 >= s.length) {
        // 末尾孤立 `\` —— 从部分值里丢弃。
        return { value: out, end: s.length, partial: true };
      }
      const esc = s[j + 1];
      if (esc === '"') {
        out += '"';
        j += 2;
      } else if (esc === "\\") {
        out += "\\";
        j += 2;
      } else if (esc === "/") {
        out += "/";
        j += 2;
      } else if (esc === "b") {
        out += "\b";
        j += 2;
      } else if (esc === "f") {
        out += "\f";
        j += 2;
      } else if (esc === "n") {
        out += "\n";
        j += 2;
      } else if (esc === "r") {
        out += "\r";
        j += 2;
      } else if (esc === "t") {
        out += "\t";
        j += 2;
      } else if (esc === "u") {
        if (j + 6 > s.length) {
          // 半截 \u 转义；丢弃。
          return { value: out, end: s.length, partial: true };
        }
        const hex = s.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { value: out, end: s.length, partial: true };
        }
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
      } else {
        // 未知转义 —— 两字符原样保留，让怪输入存活而非冻结流式 UI。
        out += c + esc;
        j += 2;
      }
    } else {
      out += c;
      j++;
    }
  }
  return { value: out, end: s.length, partial: true };
}

/**
 * 从 `s[i]` 开始扫描一段配平的 {…} 或 […] 子串。
 * 返回匹配闭合符**之后**的下标，或 -1（在 `s` 内未配平）。
 * 会跳过 JSON 字符串，使字符串内的括号不计入深度。
 */
function scanBalanced(s: string, i: number): number {
  const open = s[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return -1;
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      const sr = scanStringTok(s, j);
      if (!sr) return -1;
      if (sr.partial) return -1; // 内部半截字符串 → 放弃
      j = sr.end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}
