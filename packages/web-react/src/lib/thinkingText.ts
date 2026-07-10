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
