/**
 * Tests for the append-only `partialJsonDelta` + `partialJsonOffset` wire
 * protocol the web client uses to accumulate a streaming tool_use's input
 * JSON. The gateway emits each Anthropic SSE `input_json_delta` chunk as a
 * frame carrying ONLY the new chars + the offset (= accumulator length
 * BEFORE the delta). This avoids the O(n²) bandwidth and 64 KiB cap of the
 * old cumulative protocol so Edit/Write bodies stream the whole way through.
 *
 * Helper under test: `_applyPartialJsonDelta(current, block)` exported from
 * websocket.js. Pure function — extracted by source slicing using the same
 * column-0 closing-brace trick as the sibling consistencyAfterRefresh /
 * wsMultiBlockRebind tests.
 *
 * The append-validation contract:
 *   - offset === current.length        → APPEND       (action: 'set')
 *   - offset !== current.length        → DEGRADE      (action: 'drop')
 *   - no delta fields on frame         → NO-OP        (action: 'keep')
 *
 * Edge cases covered: in-order append, duplicate frame, out-of-order frame,
 * late join into mid-stream (offset > 0 starting from null), final frame
 * without delta fields, content_block_start (no delta yet), empty current
 * buffer treated as 0-length.
 *
 * Run: npx tsx --test packages/web/__tests__/wsPartialJsonDelta.test.ts
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

const _src = extractTopLevelFn(WS_SRC, '_applyPartialJsonDelta')
const _applyPartialJsonDelta = new Function(
  `${_src}; return _applyPartialJsonDelta;`,
)() as (
  current: string | null | undefined,
  block: { partialJsonDelta?: unknown; partialJsonOffset?: unknown },
) => { action: 'set' | 'drop' | 'keep'; value?: string }

describe('_applyPartialJsonDelta — append validation', () => {
  it('appends when offset === current.length (in-order frame)', () => {
    const r1 = _applyPartialJsonDelta(null, { partialJsonDelta: '{"a":1', partialJsonOffset: 0 })
    assert.deepEqual(r1, { action: 'set', value: '{"a":1' })

    const r2 = _applyPartialJsonDelta(r1.value, { partialJsonDelta: ',"b":2}', partialJsonOffset: 6 })
    assert.deepEqual(r2, { action: 'set', value: '{"a":1,"b":2}' })
  })

  it('treats null / undefined / empty current as 0-length', () => {
    const targets = [null, undefined, '']
    for (const cur of targets) {
      const r = _applyPartialJsonDelta(cur as any, { partialJsonDelta: 'x', partialJsonOffset: 0 })
      assert.deepEqual(r, { action: 'set', value: 'x' }, `cur=${JSON.stringify(cur)}`)
    }
  })

  it('drops on duplicate frame (offset < current.length)', () => {
    // T0: delta="abc" offset=0 → set "abc"
    // T1: delta="def" offset=3 → set "abcdef"
    // T2: dup of T1 (same offset=3) → current.length=6, mismatch → drop
    const r = _applyPartialJsonDelta('abcdef', { partialJsonDelta: 'def', partialJsonOffset: 3 })
    assert.deepEqual(r, { action: 'drop' })
  })

  it('drops on out-of-order / future frame (offset > current.length)', () => {
    // Frame for offset 10 arrives while we only have 3 chars buffered.
    const r = _applyPartialJsonDelta('abc', { partialJsonDelta: 'X', partialJsonOffset: 10 })
    assert.deepEqual(r, { action: 'drop' })
  })

  it('drops on late join: new card seed with offset > 0', () => {
    // New card path: pass null as current. Frame carries offset 42 because
    // the client reconnected mid-stream. We can't reconstruct the prefix.
    const r = _applyPartialJsonDelta(null, {
      partialJsonDelta: 'ome content',
      partialJsonOffset: 42,
    })
    assert.deepEqual(r, { action: 'drop' })
  })

  it('keeps current unchanged when frame has no delta fields', () => {
    // content_block_start: no delta or offset yet.
    const r1 = _applyPartialJsonDelta(null, {})
    assert.deepEqual(r1, { action: 'keep' })

    // final frame: no delta fields (web reads inputJson instead).
    const r2 = _applyPartialJsonDelta('{"a":1}', { inputJson: { a: 1 } } as any)
    assert.deepEqual(r2, { action: 'keep' })

    // partial frame missing offset → defensive: keep.
    const r3 = _applyPartialJsonDelta('{"a":1', { partialJsonDelta: ',"b":2' } as any)
    assert.deepEqual(r3, { action: 'keep' })

    // partial frame missing delta string → defensive: keep.
    const r4 = _applyPartialJsonDelta('{"a":1', { partialJsonOffset: 6 } as any)
    assert.deepEqual(r4, { action: 'keep' })
  })

  it('rejects non-string delta / non-number offset (defensive)', () => {
    const r1 = _applyPartialJsonDelta('abc', { partialJsonDelta: 123 as any, partialJsonOffset: 3 })
    assert.deepEqual(r1, { action: 'keep' })

    const r2 = _applyPartialJsonDelta('abc', { partialJsonDelta: 'def', partialJsonOffset: '3' as any })
    assert.deepEqual(r2, { action: 'keep' })

    const r3 = _applyPartialJsonDelta('abc', { partialJsonDelta: null as any, partialJsonOffset: 3 })
    assert.deepEqual(r3, { action: 'keep' })
  })
})

describe('_applyPartialJsonDelta — realistic stream simulation', () => {
  it('a 5-delta Edit stream accumulates correctly', () => {
    // Simulate gateway emitting 5 deltas for an Edit tool input.
    const deltas = [
      '{"file_path":"/tmp/a.ts"',
      ',"old_string":"hello"',
      ',"new_string":"hello',
      ' world"',
      '}',
    ]
    let buf: string | null = null
    for (const d of deltas) {
      const offset = (buf ?? '').length
      const r = _applyPartialJsonDelta(buf, { partialJsonDelta: d, partialJsonOffset: offset })
      assert.equal(r.action, 'set', `delta ${JSON.stringify(d)} should set`)
      buf = (r as { action: 'set'; value: string }).value
    }
    assert.equal(
      buf,
      '{"file_path":"/tmp/a.ts","old_string":"hello","new_string":"hello world"}',
    )
    // Sanity: the accumulated buffer parses as the final JSON snapshot.
    assert.deepEqual(JSON.parse(buf!), {
      file_path: '/tmp/a.ts',
      old_string: 'hello',
      new_string: 'hello world',
    })
  })

  it('a duplicate frame mid-stream degrades; further out-of-order frames keep dropping', () => {
    let buf: string | null = null
    buf = (_applyPartialJsonDelta(buf, { partialJsonDelta: '{"a":', partialJsonOffset: 0 }) as any).value
    buf = (_applyPartialJsonDelta(buf, { partialJsonDelta: '1,', partialJsonOffset: 5 }) as any).value
    assert.equal(buf, '{"a":1,')

    // Dup of last frame replays — offset=5 but current.length=7. Drop.
    const dup = _applyPartialJsonDelta(buf, { partialJsonDelta: '1,', partialJsonOffset: 5 })
    assert.equal(dup.action, 'drop')
    // After caller `delete existing.partialJson`, simulate the live stream
    // continuing with the next forward delta (offset=7). Because buf was
    // wiped, cur.length=0 ≠ 7 → drop. Renderer is now committed to
    // inputPreview/inputJson for this block until the final frame.
    const later = _applyPartialJsonDelta(null, { partialJsonDelta: '"b":2}', partialJsonOffset: 7 })
    assert.equal(later.action, 'drop')
  })

  it('recovers after a drop when a clean offset=0 frame arrives (ring replay scenario)', () => {
    // Documents the intentional re-seed semantics: drop is a per-frame
    // decision. If the WS replays the full stream from the top (e.g.
    // ring-buffer replay after a reconnect), the offset=0 frame finds an
    // empty buffer and seeds; subsequent in-order frames append normally.
    // This avoids stalling realtime rendering until the final inputJson.
    let buf: string | null = null
    buf = (_applyPartialJsonDelta(buf, { partialJsonDelta: 'abc', partialJsonOffset: 0 }) as any).value
    buf = (_applyPartialJsonDelta(buf, { partialJsonDelta: 'def', partialJsonOffset: 3 }) as any).value
    assert.equal(buf, 'abcdef')

    // Dup of T1 → drop. Caller deletes existing.partialJson.
    const dup = _applyPartialJsonDelta(buf, { partialJsonDelta: 'def', partialJsonOffset: 3 })
    assert.equal(dup.action, 'drop')
    buf = null

    // Full replay restarts at offset 0 — re-seed permitted.
    const reseed = _applyPartialJsonDelta(buf, { partialJsonDelta: 'abc', partialJsonOffset: 0 })
    assert.deepEqual(reseed, { action: 'set', value: 'abc' })
    buf = (reseed as { value: string }).value

    const next = _applyPartialJsonDelta(buf, { partialJsonDelta: 'def', partialJsonOffset: 3 })
    assert.deepEqual(next, { action: 'set', value: 'abcdef' })
  })
})
