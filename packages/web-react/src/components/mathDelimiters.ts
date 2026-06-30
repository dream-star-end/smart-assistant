/**
 * 归一化 LaTeX 数学定界符,使 remark-math 能解析:
 *   `\(...\)` → `$...$`(行内)、`\[...\]` → `$$...$$`(行间)。
 *
 * 很多模型(GLM/DeepSeek 等)爱用 LaTeX 风格的 `\(`/`\[` 而非 markdown 的 `$`/`$$`,而
 * remark-math 默认**只认 `$`** → 公式被当纯文本、露出反斜杠和括号(如响应 #f3c5d40c 的
 * 泰勒展开)。转换前先把代码块/行内代码抽出占位,避免把代码里的 `\(` `\[` 误转,转换完再
 * 还原;占位符用 NUL 包裹索引(markdown 文本绝不含 NUL,杜绝与正文如"值 3 是"碰撞)。
 * 无 LaTeX 定界符 → 原样返回(零开销快路径)。纯函数,无副作用,绝不抛。
 */
export function normalizeMathDelimiters(src: string): string {
  if (!src.includes("\\(") && !src.includes("\\[")) return src;
  const stash: string[] = [];
  const protect = (m: string) => `\u0000${stash.push(m) - 1}\u0000`;
  // 保护代码,避免代码里的 \( \[ 被误转:
  //  ① 围栏块:≥3 个 ` 或 ~ 开,惰性配到**同标记闭合**;未闭合则吃到 EOF(流式渲染中代码块
  //     常未闭合,必须覆盖,否则流式时代码里的 \( 会被改写)。
  //  ② 行内 code span:任意长度反引号 run 开,惰性配到**同长反引号 run**闭(支持 ``含`单反引号`` )。
  let s = src.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2/g, protect);
  // 行间(显示)公式:\[ … \] → $$ … $$(非贪婪配对最近的 \])。
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`);
  // 行内公式:\( … \) → $ … $。
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`);
  // 还原代码占位。
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
  return s;
}
