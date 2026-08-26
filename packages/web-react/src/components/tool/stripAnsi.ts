/**
 * 工具卡展示层剥 ANSI。
 *
 * Cursor / Grok / 终端工具的 stdout 常带 SGR 颜色码（vitest 的黄字耗时、ripgrep
 * 路径着色）。Web 不会解释 CSI，ESC 在文本节点里不可见，用户看到的就是 `[33m[2m`
 * 这种乱码。历史 tape 已经落了带 ESC 的正文，所以必须在展示层剥，刷新即可修旧卡。
 *
 * 模式对齐 ansi-regex@6（CSI + OSC），只剥控制序列，不碰正文里字面 `[33m`。
 */
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\u0007|\u001B\\|\u009C))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  if (!text) return text;
  if (!text.includes("\u001b") && !text.includes("\u009b")) return text;
  return text.replace(ANSI_RE, "");
}
