/** Synchronous display/export matcher; the prediction parser stays on demand. */
export const NEXT_TYPES = new Set(["next", "prediction"]);
const NEXT_HEAD = '{"type":"next"';

/**
 * 这个 ui 块是不是输入预测(不显示)。`partial` = 还在流式生成:类型名还没写完、但可能是 next 时
 * 也算,免得块尾先闪出一个骨架再消失。
 */
export function isNextBlockCode(code: string, partial = false): boolean {
  const compact = code.replace(/\s+/g, "");
  if (partial && NEXT_HEAD.startsWith(compact)) return true;
  const m = /^\{"type":"([a-z_]+)"/i.exec(compact);
  return !!m && NEXT_TYPES.has(m[1]!.toLowerCase());
}

