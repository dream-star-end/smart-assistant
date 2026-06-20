/**
 * Empty-turn classification + "never end a turn silently" contract.
 *
 * Root cause this guards (GLM screenshot bug, 2026-06): a turn that emits only
 * a `thinking` block and then end_turn produced NO user-facing answer, yet the
 * old detector counted `thinking` as content and silently swallowed the turn —
 * the user saw a 思考过程 card and nothing else, no notice. classifyEmptyTurn
 * now excludes thinking from "answer-bearing" output so these turns surface a
 * notice.
 *
 * The pure classifier is unit-tested by importing the standalone emptyTurn.js
 * module (websocket.js itself can't be imported under node — its dep graph
 * touches localStorage/document at load). The THINKING_SAFETY timeout changes
 * live inside that un-importable handler, so they're covered by a source
 * contract test (same approach as wsThinkingTextInterleave.test.ts).
 *
 * Run: npx tsx --test packages/web/__tests__/emptyTurnClassify.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  classifyEmptyTurn,
  emptyTurnNoticeText,
  EMPTY_TURN_ANSWER_ROLES,
  ANSWER_BLOCK_KINDS,
  countAnswerBlocks,
} from '../public/modules/emptyTurn.js'

const user = (id: string) => ({ id, role: 'user' })
const msg = (id: string, role: string) => ({ id, role })

describe('classifyEmptyTurn — thinking is not an answer', () => {
  it('thinking-only turn → inserts notice (the GLM screenshot bug)', () => {
    const messages = [user('u1'), msg('t1', 'thinking')]
    const r = classifyEmptyTurn({
      messages,
      targetMsgId: 'u1',
      hasAnswerOutput: false,
      stopReason: 'end_turn',
    })
    assert.equal(r.insert, true)
    assert.equal(r.text, emptyTurnNoticeText('end_turn', false))
    assert.equal(r.stopReason, 'end_turn')
  })

  it('thinking + assistant text → no notice', () => {
    const messages = [user('u1'), msg('t1', 'thinking'), msg('a1', 'assistant')]
    assert.equal(
      classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: false, stopReason: 'end_turn' }).insert,
      false,
    )
  })

  it('thinking + each answer-bearing role → no notice', () => {
    for (const role of ['tool', 'plan', 'goal', 'permission', 'agent-group', 'delegate-progress']) {
      const messages = [user('u1'), msg('t1', 'thinking'), msg('x', role)]
      assert.equal(
        classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: false }).insert,
        false,
        `role ${role} should suppress the notice`,
      )
    }
  })

  it('EMPTY_TURN_ANSWER_ROLES excludes thinking, includes assistant/tool', () => {
    assert.equal(EMPTY_TURN_ANSWER_ROLES.has('thinking'), false)
    assert.equal(EMPTY_TURN_ANSWER_ROLES.has('assistant'), true)
    assert.equal(EMPTY_TURN_ANSWER_ROLES.has('tool'), true)
  })
})

describe('classifyEmptyTurn — hasAnswerOutput (pre-render lookahead)', () => {
  it('final-frame text counted ahead of render → no notice (no spurious flag)', () => {
    // The answer block has been counted (_currentTurnAnswerCount>0) but not yet
    // rendered into messages — must NOT be flagged empty.
    const messages = [user('u1')]
    assert.equal(
      classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: true, stopReason: 'end_turn' }).insert,
      false,
    )
  })

  it('mid-stream assistant row open → no notice even with only a thinking card rendered', () => {
    const messages = [user('u1'), msg('t1', 'thinking')]
    assert.equal(
      classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: true }).insert,
      false,
    )
  })
})

describe('classifyEmptyTurn — wording & soft flag', () => {
  it('completely empty turn, no stopReason, no prior content → hard "未收到回复"', () => {
    const messages = [user('u1')]
    const r = classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: false })
    assert.equal(r.insert, true)
    assert.equal(r.soft, false)
    assert.match(r.text, /未收到回复/)
  })

  it('prior turn had content (thinking counts as activity) + no stopReason → soft "未输出新内容"', () => {
    const messages = [user('u0'), msg('a0', 'assistant'), user('u1'), msg('t1', 'thinking')]
    const r = classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: false })
    assert.equal(r.insert, true)
    assert.equal(r.soft, true)
    assert.match(r.text, /未输出新内容/)
  })

  it('stopReason always makes the notice soft (info-level, not a red error)', () => {
    const messages = [user('u1'), msg('t1', 'thinking')]
    assert.equal(
      classifyEmptyTurn({ messages, targetMsgId: 'u1', hasAnswerOutput: false, stopReason: 'end_turn' }).soft,
      true,
    )
  })
})

describe('classifyEmptyTurn — defensive no-ops', () => {
  it('targetMsgId not present → no notice', () => {
    assert.equal(
      classifyEmptyTurn({ messages: [user('u1')], targetMsgId: 'missing', hasAnswerOutput: false }).insert,
      false,
    )
  })
  it('messages not an array → no notice', () => {
    assert.equal(
      classifyEmptyTurn({ messages: null as unknown as [], targetMsgId: 'u1', hasAnswerOutput: false }).insert,
      false,
    )
  })
})

describe('emptyTurnNoticeText — stopReason wording table', () => {
  it('maps every known stop reason', () => {
    assert.match(emptyTurnNoticeText('end_turn', false), /主动结束/)
    assert.match(emptyTurnNoticeText('pause_turn', false), /暂停/)
    assert.match(emptyTurnNoticeText('max_tokens', false), /token 上限/)
    assert.match(emptyTurnNoticeText('refusal', false), /拒绝/)
    assert.match(emptyTurnNoticeText('tool_use', false), /工具调用流/)
    assert.match(emptyTurnNoticeText('stop_sequence', false), /停止序列/)
  })
  it('unknown stop reason echoes the raw code', () => {
    assert.match(emptyTurnNoticeText('weird_reason', false), /weird_reason/)
  })
})

describe('countAnswerBlocks — only NEW visible-message kinds count as answer', () => {
  it('counts text / tool_use / plan / goal', () => {
    assert.equal(
      countAnswerBlocks([{ kind: 'text' }, { kind: 'tool_use' }, { kind: 'plan' }, { kind: 'goal' }]),
      4,
    )
  })
  it('does NOT count thinking', () => {
    assert.equal(countAnswerBlocks([{ kind: 'thinking' }]), 0)
  })
  it('does NOT count update-only kinds (tool_result / tool_output_tail / delegate_progress)', () => {
    assert.equal(
      countAnswerBlocks([{ kind: 'tool_result' }, { kind: 'tool_output_tail' }, { kind: 'delegate_progress' }]),
      0,
    )
  })
  it('does NOT count unknown / malformed blocks', () => {
    assert.equal(countAnswerBlocks([{ kind: 'weird' }, { kind: undefined }, null]), 0)
  })
  it('mixed thinking + tool_result + text → 1 (only the text)', () => {
    assert.equal(countAnswerBlocks([{ kind: 'thinking' }, { kind: 'tool_result' }, { kind: 'text' }]), 1)
  })
  it('non-array → 0', () => {
    assert.equal(countAnswerBlocks(null), 0)
    assert.equal(countAnswerBlocks(undefined), 0)
  })
  it('ANSWER_BLOCK_KINDS is a whitelist (excludes thinking/tool_result)', () => {
    assert.equal(ANSWER_BLOCK_KINDS.has('thinking'), false)
    assert.equal(ANSWER_BLOCK_KINDS.has('tool_result'), false)
    assert.equal(ANSWER_BLOCK_KINDS.has('text'), true)
    assert.equal(ANSWER_BLOCK_KINDS.has('tool_use'), true)
  })
})

describe('websocket.js — THINKING_SAFETY timeout: liveness-aware and never silent (source contract)', () => {
  const WS = readFileSync(
    resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
    'utf-8',
  )

  it('rechecks _lastFrameAt and reschedules instead of killing a session that is still alive', () => {
    // A long compacting phase refreshes _lastFrameAt via turn_status frames but
    // does not reset this timer — so the fire path must reschedule when a frame
    // arrived within the window (otherwise it'd kill a live turn + show a bogus
    // "interrupted" notice).
    assert.match(WS, /sinceLastFrame\s*=\s*Date\.now\(\)\s*-\s*\(s\._lastFrameAt/)
    assert.match(WS, /sinceLastFrame\s*<\s*THINKING_SAFETY_MS/)
  })

  it('surfaces a visible in-conversation notice on real timeout (no silent teardown)', () => {
    assert.match(WS, /_emptyTurnTimeout:\s*true/)
    assert.match(WS, /addMessage\(\s*s,\s*'assistant'/)
  })

  it('dedups the timeout notice by target user-message id', () => {
    assert.match(WS, /_emptyTurnTargetMsgId/)
  })

  it('classifies the empty turn AFTER block render (post-render consumer, not pre-render)', () => {
    // The pre-render isFinal block must only CAPTURE the turn target; the single
    // classifyEmptyTurn call must live in the deferred consumer so it sees the
    // tool / delegate-progress cards a final-only frame renders during the block
    // loop (otherwise those get mis-flagged as empty). Lock: exactly one
    // classifyEmptyTurn call, and it sits inside the `if (_deferredEmptyNotice)`
    // consumer.
    const calls = (WS.match(/classifyEmptyTurn\(\{/g) || []).length
    assert.equal(calls, 1, 'exactly one classifyEmptyTurn call (post-render consumer)')
    assert.match(WS, /if \(_deferredEmptyNotice\) \{[\s\S]{0,260}classifyEmptyTurn\(\{/)
  })
})
