/**
 * 归一化 LaTeX 数学定界符,使 remark-math 能解析:
 *   `\(...\)` → `$...$`(行内)、`\[...\]` → `$$...$$`(行间)。
 *
 * 很多模型(GLM/DeepSeek 等)爱用 LaTeX 风格的 `\(`/`\[` 而非 markdown 的 `$`/`$$`,而
 * remark-math 默认**只认 `$`** → 公式被当纯文本、露出反斜杠和括号(如响应 #f3c5d40c 的
 * 泰勒展开)。转换前先把代码块/行内代码抽出占位,避免把代码里的 `\(` `\[` 误转,转换完再
 * 还原;占位符用 NUL 包裹索引(markdown 文本绝不含 NUL,杜绝与正文如"值 3 是"碰撞)。
 * 同一遍里还把**货币写法的 `$`** 转义成字面量(OCV5-421):remark-math 默认单个 `$` 即开行内
 * 公式,「基础版 $5，专业版 $10 每月」会把两个价格之间的整段吃成公式,连带后面真正的 `$E=mc^2$`
 * 也错位成纯文本。判定见 escapeCurrencyDollars。
 * 无 LaTeX 定界符、无 `$` → 原样返回(零开销快路径)。纯函数,无副作用,绝不抛。
 */
export function normalizeMathDelimiters(src: string): string {
  const hasLatex = src.includes("\\(") || src.includes("\\[");
  if (!hasLatex && !src.includes("$")) return src;
  const stash: string[] = [];
  const protect = (m: string) => `\u0000${stash.push(m) - 1}\u0000`;
  // 保护代码,避免代码里的 \( \[ 被误转:
  //  ① 围栏块:≥3 个 ` 或 ~ 开,惰性配到**同标记闭合**;未闭合则吃到 EOF(流式渲染中代码块
  //     常未闭合,必须覆盖,否则流式时代码里的 \( 会被改写)。
  //  ② 行内 code span:任意长度反引号 run 开,惰性配到**同长反引号 run**闭(支持 ``含`单反引号`` )。
  let s = src.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2/g, protect);
  s = escapeCurrencyDollars(s);
  // 行间(显示)公式:\[ … \] → $$ … $$(非贪婪配对最近的 \])。
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`);
  // 行内公式:\( … \) → $ … $。
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`);
  // 还原代码占位。
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
  return s;
}

/** 内含这些字符才算「像公式」:`$5 + x$`、`$2^n$`、`$a_i$` 仍按公式渲染。 */
const MATH_INNER = /[\\^_=+*/<>{}]/;

/**
 * `$` 紧跟数字、且不是 `$$`、未被反斜杠转义时,视为货币候选。同一行里往后找下一个单 `$`:
 * - 找不到 → 货币(未闭合的 `$` 本来也渲染不成公式);
 * - 找到,且两者之间纯数字(`$5$`)或含数学符号(`$2x+1$`、`$3^2$`)→ 保留为公式;
 * - 否则(`$5 and $10`、`$5，专业版 $10`、`$1,299起`)→ 货币,转义成 `\$`。
 * 只在已抽走代码的文本上调用。
 */
function escapeCurrencyDollars(s: string): string {
  if (!/\$\d/.test(s)) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "$" && s[i + 1] === "$") {
      // 行间公式定界符:原样跳过整段 $$…$$(或到 EOF)。
      const close = s.indexOf("$$", i + 2);
      const end = close < 0 ? s.length : close + 2;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "$") {
      const lineEnd = s.indexOf("\n", i + 1) < 0 ? s.length : s.indexOf("\n", i + 1);
      let close = -1;
      for (let j = i + 1; j < lineEnd; j++) {
        if (s[j] === "\\") { j++; continue; }
        if (s[j] === "$") { close = j; break; }
      }
      if (/\d/.test(s[i + 1] ?? "")) {
        const inner = close < 0 ? "" : s.slice(i + 1, close);
        const isMath = close >= 0 && s[close + 1] !== "$" && (/^[\d.,]+$/.test(inner) || MATH_INNER.test(inner));
        if (!isMath) {
          out += "\\$";
          i += 1;
          continue;
        }
      }
      // 普通行内公式(或保留的数字公式):原样带过到闭合 `$`,避免把公式内部的 `$数字` 再判一次。
      const end = close < 0 ? i + 1 : close + 1;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 流式中尚未闭合的行间公式起点(OCV5-421):代码外的 `$$` 个数为奇数时,返回最后一个 `$$` 的
 * 位置,调用方在此截断并显示「公式生成中」占位;否则 -1。半截 LaTeX 交给 KaTeX 只会画出红色
 * 报错文本,每个 delta 闪一次。代码块 / 行内代码里的 `$$` 不计。
 */
export function unclosedDisplayMathStart(src: string): number {
  if (!src.includes("$$")) return -1;
  const masked = src.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2/g, (m) => " ".repeat(m.length));
  let count = 0;
  let last = -1;
  for (let i = masked.indexOf("$$"); i >= 0; i = masked.indexOf("$$", i + 2)) {
    if (masked[i - 1] === "\\") continue;
    count++;
    last = i;
  }
  return count % 2 === 1 ? last : -1;
}
