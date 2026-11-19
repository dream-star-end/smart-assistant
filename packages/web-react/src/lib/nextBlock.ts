/** Synchronous display/export matcher; the prediction parser stays on demand. */
const NEXT_HEADS = [
  '{"type":"next"',
  '{"type":"prediction"',
  '{"type":"input-prediction"',
  '{"type":"input_prediction"',
  '{"type":"next-input"',
  '{"type":"next_input"',
  '{"next":',
];
const NEXT_TYPE_RE = /^\{"type":"(?:next|prediction|input[-_]prediction|next[-_]input)"/i;
const OTHER_TYPE_RE = /"type":"(?!(?:next|prediction|input[-_]prediction|next[-_]input)")/i;

/**
 * 这个 ui 块是不是输入预测(不显示)。`partial` = 还在流式生成:类型名还没写完、但可能是 next 时
 * 也算,免得块尾先闪出一个骨架再消失。同时容忍模型偶发的简写(`{"next":...}`)或别名。
 */
export function isNextBlockCode(code: string, partial = false): boolean {
  const compact = code.replace(/\s+/g, "");
  if (partial && NEXT_HEADS.some((h) => h.startsWith(compact.toLowerCase()))) return true;
  if (NEXT_TYPE_RE.test(compact)) return true;
  return /^\{"next":/i.test(compact) && !OTHER_TYPE_RE.test(compact);
}

