/**
 * Wave 2 — closure-stale `msg` ref guard (sync server-wins safety).
 *
 * When sync.js's 409 server-wins path overwrites sess.messages (sync.js:1392
 * "sess.messages was just overwritten"), DOM event handlers that captured
 * `msg` in a closure at build time become orphans — sess.messages.indexOf(msg)
 * returns -1. Click → silent no-op (regen/del) or stale-content read
 * (copy/save/tts).
 *
 * Fix: messages.js _findMsgIdx(sess, msg) resolves a fresh idx by id;
 * live-resolved msg is then used for both array ops and content reads.
 * Undo path captures the LIVE removedMsg from splice + a predecessor id,
 * with a duplicate guard against sync-driven re-introduction.
 *
 * This test file has TWO halves:
 *   A. Source-extract unit tests for the two helpers (decision tables)
 *   B. Static-source assertions that the call sites are wired correctly,
 *      including negative guards against regressing back to the
 *      closure-stale-ref patterns.
 *
 * Run: npx tsx --test packages/web/__tests__/wsMsgClosureRebind.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const MSGS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'messages.js'),
  'utf-8',
)

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

const _findMsgIdxSrc = extractTopLevelFn(MSGS_SRC, '_findMsgIdx')
const _findMsgIdx = new Function(
  `${_findMsgIdxSrc}; return _findMsgIdx;`,
)() as (sess: any, msg: any) => number

// 2026-06-18 — _computeUndoInsertIdx 随"删除消息+撤销"功能一并移除(消息操作栏的
// 删除按钮已改为反馈按钮),相关 undo 单测一并删除。

// ── A. Helper unit tests ──────────────────────────────────────────────────

describe('_findMsgIdx', () => {
  it('returns -1 when sess is null', () => {
    assert.equal(_findMsgIdx(null, { id: 'a' }), -1)
  })
  it('returns -1 when messages is not an array', () => {
    assert.equal(_findMsgIdx({ messages: 'x' }, { id: 'a' }), -1)
  })
  it('returns -1 when msg is null', () => {
    assert.equal(_findMsgIdx({ messages: [] }, null), -1)
  })
  it('fast path: ref match returns ref index', () => {
    const M = { id: 'a' }
    assert.equal(_findMsgIdx({ messages: [M] }, M), 0)
  })
  it('slow path: ref miss + id match (sync server-wins simulated)', () => {
    const msg_old = { id: 'b', text: 'old' }
    const msg_new = { id: 'b', text: 'new' }   // server-wins overwrote
    const sess = { messages: [{ id: 'a' }, msg_new] }
    // closure still holds msg_old; ref miss → fall back to id
    assert.equal(_findMsgIdx(sess, msg_old), 1)
  })
  it('returns -1 when ref miss and id also missing in array', () => {
    assert.equal(_findMsgIdx({ messages: [{ id: 'a' }] }, { id: 'z' }), -1)
  })
  it('returns -1 when msg has no id and is not in array (legacy ref-only)', () => {
    assert.equal(_findMsgIdx({ messages: [{ id: 'a' }] }, {}), -1)
  })
})

// ── B. Static-source assertions (Codex Round 2-3 blocker — wire test) ────

describe('messages.js call-site wiring', () => {
  it('sess.messages.indexOf(msg) appears exactly once in code (excl. comments), inside _findMsgIdx', () => {
    // Strip `// ...` line comments before counting so the literal pattern
    // inside the helper's header comment doesn't double-count.
    const codeOnly = MSGS_SRC.replace(/\/\/.*$/gm, '')
    const all = codeOnly.match(/sess\.messages\.indexOf\(msg\)/g) || []
    assert.equal(all.length, 1, 'unexpected indexOf(msg) outside helper')
    // The single occurrence must live inside _findMsgIdx
    assert.match(_findMsgIdxSrc, /sess\.messages\.indexOf\(msg\)/)
  })

  it('production handlers never read closure msg.text via known high-risk patterns', () => {
    // Negative: catches regression back to `const raw = msg.text || ''` / `const text = (msg.text || '')`
    assert.doesNotMatch(MSGS_SRC, /const\s+raw\s*=\s*msg\.text\s*\|\|\s*''/)
    assert.doesNotMatch(MSGS_SRC, /const\s+text\s*=\s*\(msg\.text\s*\|\|\s*''\)/)
  })

  it('删除快捷键已改为反馈:无 del 分支/按钮,feedback 分支带 per-message 上下文', () => {
    // 2026-06-18 契约变更:消息操作栏的"删除"(含 undo)整体下线,改为"反馈"图标。
    // 旧的 del 分支、删除按钮、undo splice 逻辑都不应再出现。
    assert.doesNotMatch(MSGS_SRC, /else if \(action === 'del'\)/, 'del branch should be gone')
    assert.doesNotMatch(MSGS_SRC, /data-action="del"/, 'del button should be gone')
    assert.doesNotMatch(MSGS_SRC, /removedMsg/, 'undo-by-removedMsg logic should be gone')
    // 反馈按钮 + 分支就位:正常消息走 `action === 'feedback'`,错误消息走
    // `btn.dataset.action === 'feedback'`,两者都经 _buildMsgFeedbackContext 传上下文。
    assert.match(MSGS_SRC, /data-action="feedback"/)
    assert.match(MSGS_SRC, /action === 'feedback'/)
    assert.match(MSGS_SRC, /_openMessageFeedback\?\.\(\s*_buildMsgFeedbackContext\(/)
  })

  it('exportMessageDocx/Tex receive liveMsg, not closure msg', () => {
    assert.match(MSGS_SRC, /exportMessageDocx\(\s*liveMsg/)
    assert.match(MSGS_SRC, /exportMessageTex\(\s*liveMsg/)
    assert.doesNotMatch(MSGS_SRC, /exportMessageDocx\(\s*msg\s*,/)
    assert.doesNotMatch(MSGS_SRC, /exportMessageTex\(\s*msg\s*,/)
  })

  it('copy/save/tts paths all use _findMsgIdx + liveMsg resolve pattern', () => {
    const findIdxCalls = (MSGS_SRC.match(/_findMsgIdx\(sess,\s*msg\)/g) || []).length
    // Expected sites (2026-06-18 后,del→feedback):error-card copy(1) + error-card
    // feedback(1) + assistant copy(1) + save click(1) + regen(1) + tts(1) +
    // assistant feedback(1) + user-status(1)。仍 >=6。
    assert.ok(findIdxCalls >= 6, `expected >=6 _findMsgIdx call sites, found ${findIdxCalls}`)
    const liveMsgPatterns = (
      MSGS_SRC.match(/const\s+liveMsg\s*=\s*_idx\s*>=\s*0\s*\?\s*sess\.messages\[_idx\]\s*:\s*msg/g) || []
    ).length
    // 4+ live-resolve sites: error copy / assistant copy / save / tts
    assert.ok(liveMsgPatterns >= 4, `expected >=4 liveMsg resolve sites, found ${liveMsgPatterns}`)
  })
})
