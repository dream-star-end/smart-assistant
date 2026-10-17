// OCV5-482: the deploy smoke's exact-answer check matches the product. The master prompt has
// every answer end with one ```ui {"type":"next"} input-prediction block, which the web renders
// as a next-question hint, not as answer text. Only that one trailing, well-formed block is
// dropped before the exact comparison. A block in the middle, a fence glued to the answer line,
// another block type or malformed JSON is left in place, so the exact check still fails.

const TRAILING_PREDICTION = /\n {0,3}(`{3,}|~{3,})ui[ \t]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/

export function answerTextForExactCheck(text) {
  const m = TRAILING_PREDICTION.exec(text)
  if (!m) return text
  let block
  try { block = JSON.parse(m[2]) } catch { return text }
  if (!block || typeof block !== 'object' || Array.isArray(block)
    || block.type !== 'next' || typeof block.text !== 'string') return text
  const rest = text.slice(0, m.index)
  if (/(`{3,}|~{3,})ui/i.test(rest)) return text
  return rest.trimEnd()
}
