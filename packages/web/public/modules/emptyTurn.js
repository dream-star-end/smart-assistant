// Empty-turn classification — pure, no DOM / browser deps so it's unit-testable.
// (websocket.js itself can't be imported under node: its dep graph touches
// localStorage/document at module load — see wsThinkingTextInterleave.test.ts.)
// Tested by __tests__/emptyTurnClassify.test.ts.
//
// An "empty turn" is an isFinal turn that produced NO user-facing answer — e.g.
// a GLM turn that emits only a thinking block then end_turn, or a real backend
// fault that returns isFinal on a dead subprocess. Either way the user is left
// with a "已读" badge and nothing to show, so we surface a single non-alarmist
// notice (real faults stay visible; healthy end_turns read as info).
//
// `thinking` is deliberately NOT an answer: a reasoning-only turn looks blank to
// the user. Counting thinking as content is exactly what used to silently
// swallow these turns (the GLM screenshot bug).
//
// Two role sets, INTENTIONALLY not identical:
//   • answer roles  → whether THIS turn produced an answer (thinking excluded)
//   • activity check → whether the PRIOR turn was alive, only to pick fallback
//     wording when stopReason is absent (thinking counts as activity)

export const EMPTY_TURN_ANSWER_ROLES = new Set([
  'assistant', 'tool', 'agent-group', 'delegate-progress', 'plan', 'goal', 'permission',
])

// Block kinds (frame.blocks[].kind) used as a fast PRE-RENDER lookahead hint for
// "this turn already produced an answer block". Deliberately a conservative
// WHITELIST, not "anything but thinking": thinking is never an answer, and
// update-ish kinds (tool_result / tool_output_tail / delegate_progress) are
// omitted because before render we can't tell whether they'll actually create a
// visible message (tool_result/tail `continue` when no matching tool exists;
// delegate_progress sometimes only updates an existing card, but its fallback
// path DOES create a visible row). Those cases are resolved AUTHORITATIVELY
// after render by classifyEmptyTurn's EMPTY_TURN_ANSWER_ROLES scan over the
// rendered messages — so omitting them here is safe: it can only make the
// lookahead a no-op, never silently suppress (or force) a real notice.
export const ANSWER_BLOCK_KINDS = new Set(['text', 'tool_use', 'plan', 'goal'])

/** Count answer-bearing blocks in a frame's block list (see ANSWER_BLOCK_KINDS). */
export function countAnswerBlocks(blocks) {
  if (!Array.isArray(blocks)) return 0
  let n = 0
  for (const b of blocks) if (b && ANSWER_BLOCK_KINDS.has(b.kind)) n++
  return n
}

export function emptyTurnNoticeText(stopReason, priorTurnHadContent) {
  switch (stopReason) {
    case 'end_turn':
      return '模型本轮主动结束(通常表示它判断不需要再回复或上下文已表达完整)。可继续追问。'
    case 'pause_turn':
      return '模型暂停了本轮(通常因长任务超时),可直接重新发送让它继续。'
    case 'max_tokens':
      return '本轮输出达到 token 上限,内容可能不完整。可让它"继续"。'
    case 'refusal':
      return '模型拒绝回复本轮内容。'
    case 'tool_use':
      // stop_reason=tool_use but no answer block → tool_use stream was cut
      return '工具调用流意外中断,请重试。'
    case 'stop_sequence':
      return '模型命中停止序列结束本轮。'
    default:
      if (stopReason) return `模型本轮无内容输出 (stop_reason=${stopReason})。可重试或继续追问。`
      if (priorTurnHadContent) return '模型本轮未输出新内容,可继续追问或重新提问。'
      return '未收到回复 — 服务端标记已完成,但没有生成任何内容。请重试。'
  }
}

/**
 * Decide whether an isFinal turn that produced no answer should surface an
 * empty-turn notice, and with what wording. Pure — no DOM / state mutation.
 *
 * @param {object}   p
 * @param {Array}    p.messages        sess.messages (in order)
 * @param {string}   p.targetMsgId     the user message this turn is replying to
 * @param {boolean}  p.hasAnswerOutput answer-bearing output already seen this
 *                                     turn (counted ahead of render or mid-stream)
 * @param {string=}  p.stopReason      Anthropic stop_reason from frame.meta
 * @returns {{insert:boolean, text?:string, soft?:boolean, stopReason?:(string|null)}}
 */
export function classifyEmptyTurn({ messages, targetMsgId, hasAnswerOutput, stopReason }) {
  if (hasAnswerOutput) return { insert: false }
  if (!Array.isArray(messages)) return { insert: false }
  const targetIdx = messages.findIndex((m) => m && m.id === targetMsgId)
  if (targetIdx < 0) return { insert: false }
  // Did any answer-bearing message land after the target user msg? (thinking
  // excluded — a rendered thinking card is not an answer.)
  for (let i = targetIdx + 1; i < messages.length; i++) {
    if (EMPTY_TURN_ANSWER_ROLES.has(messages[i]?.role)) return { insert: false }
  }
  // Prior-turn activity → only picks fallback wording (thinking counts here).
  let priorTurnHadContent = false
  for (let i = targetIdx - 1; i >= 0; i--) {
    const r = messages[i]?.role
    if (r === 'user') break
    if (r === 'thinking' || EMPTY_TURN_ANSWER_ROLES.has(r)) {
      priorTurnHadContent = true
      break
    }
  }
  return {
    insert: true,
    text: emptyTurnNoticeText(stopReason, priorTurnHadContent),
    soft: priorTurnHadContent || !!stopReason,
    stopReason: stopReason ?? null,
  }
}
