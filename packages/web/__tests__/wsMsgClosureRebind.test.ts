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

const _computeUndoInsertIdxSrc = extractTopLevelFn(MSGS_SRC, '_computeUndoInsertIdx')
const _computeUndoInsertIdx = new Function(
  `${_computeUndoInsertIdxSrc}; return _computeUndoInsertIdx;`,
)() as (messages: any[], prevMsgId: string | null) => number

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

describe('_computeUndoInsertIdx', () => {
  it('null prevMsgId → insert at head (was first row)', () => {
    assert.equal(_computeUndoInsertIdx([{ id: 'a' }, { id: 'b' }], null), 0)
  })
  it('predecessor in middle → insert after it', () => {
    assert.equal(
      _computeUndoInsertIdx([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'b'),
      2,
    )
  })
  it('predecessor at end → insert at tail', () => {
    assert.equal(_computeUndoInsertIdx([{ id: 'a' }, { id: 'b' }], 'b'), 2)
  })
  it('predecessor also gone (rare race) → append at end', () => {
    // messages.length === 2, fallback returns 2 (tail append)
    assert.equal(_computeUndoInsertIdx([{ id: 'a' }, { id: 'c' }], 'b'), 2)
  })
  it('single-element array, predecessor at head → insert at idx 1', () => {
    assert.equal(_computeUndoInsertIdx([{ id: 'a' }], 'a'), 1)
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

  it('del handler uses splice(...,1)[0] + removedMsg + undo by removedMsg + duplicate guard', () => {
    // Stable anchor: from `else if (action === 'del')` to the end of the
    // assistant actions click handler (`el.appendChild(actions)`).
    const startIdx = MSGS_SRC.indexOf("else if (action === 'del')")
    assert.ok(startIdx > 0, "del branch anchor missing")
    const tailIdx = MSGS_SRC.indexOf('el.appendChild(actions)', startIdx)
    assert.ok(tailIdx > startIdx, "actions tail anchor missing")
    const region = MSGS_SRC.slice(startIdx, tailIdx)

    // Live row capture from splice (not closure msg)
    assert.match(region, /sess\.messages\.splice\(\s*idx\s*,\s*1\s*\)\s*\[\s*0\s*\]/)
    assert.match(region, /removedMsg/)
    // Undo splices removedMsg, never the closure msg
    assert.match(region, /splice\(\s*insertIdx\s*,\s*0\s*,\s*removedMsg\s*\)/)
    // Duplicate guard against sync re-introducing same-id msg
    assert.match(region, /sess\.messages\.some\([\s\S]*?m\.id\s*===\s*removedMsg\.id/)
  })

  it('exportMessageDocx/Tex receive liveMsg, not closure msg', () => {
    assert.match(MSGS_SRC, /exportMessageDocx\(\s*liveMsg/)
    assert.match(MSGS_SRC, /exportMessageTex\(\s*liveMsg/)
    assert.doesNotMatch(MSGS_SRC, /exportMessageDocx\(\s*msg\s*,/)
    assert.doesNotMatch(MSGS_SRC, /exportMessageTex\(\s*msg\s*,/)
  })

  it('copy/save/tts paths all use _findMsgIdx + liveMsg resolve pattern', () => {
    const findIdxCalls = (MSGS_SRC.match(/_findMsgIdx\(sess,\s*msg\)/g) || []).length
    // Expected sites: error-card copy(1) + assistant copy(1) + save click(1) + regen(1) + tts(1) + del(1) + user-status(1) = 7
    assert.ok(findIdxCalls >= 6, `expected >=6 _findMsgIdx call sites, found ${findIdxCalls}`)
    const liveMsgPatterns = (
      MSGS_SRC.match(/const\s+liveMsg\s*=\s*_idx\s*>=\s*0\s*\?\s*sess\.messages\[_idx\]\s*:\s*msg/g) || []
    ).length
    // 4+ live-resolve sites: error copy / assistant copy / save / tts
    assert.ok(liveMsgPatterns >= 4, `expected >=4 liveMsg resolve sites, found ${liveMsgPatterns}`)
  })
})
