// 思考内容展示前的清洗。上游模型(实测 GPT-5.6 reasoning summary)会在段落间泄漏
// HTML 注释噪音(如结尾的 `<!-- -->`);ThinkingCard 是纯文本渲染,注释会原样示人,
// 且 UI 字体的连字(ligature)会把 `-->` 显示成 `→`,用户看到 `<!-- →` 残片。
// 流式安全:每次 delta 触发重渲都对**累计全文**重新清洗,注释跨 chunk 也能在
// 收齐后被剥掉;未闭合的尾部 `<!--…`(注释还没流完)先行隐藏,闭合后自然消失。
export function sanitizeThinkingText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "") // 完整注释
    .replace(/<!--[\s\S]*$/, "") // 尾部未闭合注释(流式中间态)
    .replace(/\n{3,}/g, "\n\n") // 剥除后遗留的连续空行收敛
    .replace(/\s+$/, "");
}

/**
 * 把一组 thinking 消息文本清洗成可渲染段落数组：逐条 sanitizeThinkingText、丢弃清洗后为空的段。
 * 渲染层把**连续的 role=thinking 行**合并成单张 ThinkingCard 时用它拼多段正文——codex 一轮会产出
 * 十几条几乎只含 `**英文标题**` 空正文的 thinking 消息，合并后逐段渲染，空段(仅注释/空白)直接扔掉。
 */
export function thinkingSegments(texts: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const clean = sanitizeThinkingText(t || "");
    if (clean) out.push(clean);
  }
  return out;
}

/**
 * 取一段文本里的**首个粗体标题**(`**标题**`)并剥去星号；无粗体或标题为空 → null。
 * 标题不跨行（`.` 不匹配换行），非贪婪取到最近的一对 `**`。
 */
export function firstBoldHeadline(text: string): string | null {
  const m = /\*\*(.+?)\*\*/.exec(text || "");
  if (!m) return null;
  const t = m[1].trim();
  return t.length > 0 ? t : null;
}

/**
 * 折叠态摘要：取「最新段」（最后一个非空段）的首个粗体标题。从后往前扫，返回首个含粗体标题的段
 * 的标题（末段偶尔无标题时优雅回退到更早的段）；全都没有粗体 → null（卡片维持"已思考"原状）。
 */
export function thinkingSummaryTitle(segments: string[]): string | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const h = firstBoldHeadline(segments[i]);
    if (h) return h;
  }
  return null;
}
