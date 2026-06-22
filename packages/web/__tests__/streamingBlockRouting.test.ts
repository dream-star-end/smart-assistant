/**
 * Unit tests for websocket.js `_routeStreamingBlock` — the Phase 3
 * (agent-display-identity root-fix) stable-key router for text/thinking
 * streaming blocks. Verifies that a resumed/replayed stream re-homes onto the
 * SAME message via `${turnId}:${role}:${blockId}` instead of duplicating, with
 * legacy-pointer fallback + claim semantics.
 *
 * Source-extract + new Function() with a stubbed addMessage, following the
 * pattern in syncConflictMerge.test.ts (avoids pulling browser-global deps).
 *
 * Run: npx tsx --test packages/web/__tests__/streamingBlockRouting.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
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

const routeSrc = extractTopLevelFn(WS_SRC, '_routeStreamingBlock')

function makeRoute() {
  let n = 0
  const addMessage = (sess: any, role: string, text: string, extra: any) => {
    const msg = { id: `m-${++n}`, role, text: text || '', ...(extra || {}) }
    sess.messages.push(msg)
    return msg
  }
  return new Function('addMessage', `${routeSrc}; return _routeStreamingBlock;`)(addMessage) as (
    sess: any,
    role: string,
    block: any,
    turnId: string | null,
    extra?: any,
  ) => any
}

function mkSess(): any {
  return { id: 's1', messages: [], _blockIdToMsgId: new Map() }
}

describe('_routeStreamingBlock — keyed routing', () => {
  it('keyed: first block creates a message stamped with the routeKey + sets pointer', () => {
    const route = makeRoute()
    const sess = mkSess()
    const m = route(sess, 'assistant', { kind: 'text', blockId: 'msgA:0' }, 'srv-p-t1')
    assert.equal(sess.messages.length, 1)
    assert.equal(m.blockId, 'srv-p-t1:assistant:msgA:0')
    assert.equal(sess._streamingAssistant, m)
    assert.equal(sess._blockIdToMsgId.get('srv-p-t1:assistant:msgA:0'), m.id)
  })

  it('keyed: same routeKey reuses the SAME message (no duplicate)', () => {
    const route = makeRoute()
    const sess = mkSess()
    const blk = { kind: 'text', blockId: 'msgA:0' }
    const m1 = route(sess, 'assistant', blk, 'srv-p-t1')
    const m2 = route(sess, 'assistant', blk, 'srv-p-t1')
    assert.equal(m2, m1)
    assert.equal(sess.messages.length, 1)
  })

  it('text and thinking with the SAME raw blockId do not collide (kind in key)', () => {
    const route = makeRoute()
    const sess = mkSess()
    const ta = route(sess, 'assistant', { kind: 'text', blockId: 'm:0' }, 't1')
    const th = route(sess, 'thinking', { kind: 'thinking', blockId: 'm:0' }, 't1')
    assert.notEqual(ta, th)
    assert.equal(sess.messages.length, 2)
    assert.equal(ta.blockId, 't1:assistant:m:0')
    assert.equal(th.blockId, 't1:thinking:m:0')
  })

  it('refresh-rebuild: keyed frame reuses the persisted message instead of duplicating (core fix)', () => {
    const route = makeRoute()
    const sess = mkSess()
    // Simulate post-refresh: message restored from storage with its routeKey in
    // blockId, _blockIdToMsgId rebuilt from it, streaming pointer lost (null).
    sess.messages.push({
      id: 'm-old',
      role: 'assistant',
      text: 'partial',
      blockId: 't1:assistant:mA:0',
    })
    sess._blockIdToMsgId.set('t1:assistant:mA:0', 'm-old')
    sess._streamingAssistant = null
    const m = route(sess, 'assistant', { kind: 'text', blockId: 'mA:0' }, 't1')
    assert.equal(m.id, 'm-old')
    assert.equal(sess.messages.length, 1) // no duplicate bubble
  })
})

describe('_routeStreamingBlock — legacy fallback + claim', () => {
  it('no key: falls back to the streaming pointer (legacy behaviour preserved)', () => {
    const route = makeRoute()
    const sess = mkSess()
    const m1 = route(sess, 'assistant', { kind: 'text' }, null)
    assert.equal(m1.blockId, undefined)
    const m2 = route(sess, 'assistant', { kind: 'text' }, null)
    assert.equal(m2, m1) // reuses the open pointer, no duplicate
    assert.equal(sess.messages.length, 1)
  })

  it('half-legacy/half-keyed: a keyed frame CLAIMS the pointer-created message (no split)', () => {
    const route = makeRoute()
    const sess = mkSess()
    const legacy = route(sess, 'assistant', { kind: 'text' }, null) // old frame, no key
    assert.equal(legacy.blockId, undefined)
    const m = route(sess, 'assistant', { kind: 'text', blockId: 'mA:0' }, 't1') // keyed frame
    assert.equal(m, legacy) // claimed, not a new bubble
    assert.equal(legacy.blockId, 't1:assistant:mA:0')
    assert.equal(sess.messages.length, 1)
    assert.equal(sess._blockIdToMsgId.get('t1:assistant:mA:0'), legacy.id)
  })

  it('role guard: a map hit whose stored message has the wrong role is not reused', () => {
    const route = makeRoute()
    const sess = mkSess()
    // Dirty/foreign row: a thinking message stamped with an assistant routeKey.
    sess.messages.push({ id: 'm-x', role: 'thinking', blockId: 't1:assistant:mA:0' })
    sess._blockIdToMsgId.set('t1:assistant:mA:0', 'm-x')
    const m = route(sess, 'assistant', { kind: 'text', blockId: 'mA:0' }, 't1')
    assert.notEqual(m.id, 'm-x') // did not reuse the wrong-role message
    assert.equal(m.role, 'assistant')
  })

  it('keyed frame with a DIFFERENT blockId than the open pointer creates a new message', () => {
    const route = makeRoute()
    const sess = mkSess()
    const first = route(sess, 'assistant', { kind: 'text', blockId: 'mA:0' }, 't1')
    // a second content block (distinct blockId) with no tool boundary clearing
    // the pointer must NOT be merged into the first message.
    const second = route(sess, 'assistant', { kind: 'text', blockId: 'mA:1' }, 't1')
    assert.notEqual(second, first)
    assert.equal(sess.messages.length, 2)
    assert.equal(first.blockId, 't1:assistant:mA:0')
    assert.equal(second.blockId, 't1:assistant:mA:1')
  })

  it('unkeyed frame after a keyed message continues the open pointer (no split)', () => {
    const route = makeRoute()
    const sess = mkSess()
    const keyed = route(sess, 'assistant', { kind: 'text', blockId: 'mA:0' }, 't1')
    const cont = route(sess, 'assistant', { kind: 'text' }, null) // legacy/no-key frame
    assert.equal(cont, keyed) // continues the same message, no duplicate
    assert.equal(sess.messages.length, 1)
  })
})
