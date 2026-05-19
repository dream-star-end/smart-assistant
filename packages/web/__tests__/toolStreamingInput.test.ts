/**
 * Tests for the tool_use partial-streaming render data path:
 *
 *   gateway partial frame → msg.partialJson → _safeInput → renderer reads
 *
 * Covers the priority order in `messages.js:_safeInput`:
 *   1. msg.inputJson (final frame)               wins
 *   2. parsePartialJson(msg.partialJson)         while partial
 *   3. JSON.parse(msg.inputPreview)              legacy fallback
 *   4. null                                      nothing usable
 *
 * Crucial invariants:
 *   - "rAF pending + final arrives" race: once `inputJson` is populated,
 *     it MUST shadow any earlier partialJson, so the deferred re-render
 *     paints truth.
 *   - "Old gateway, new web": frames have neither partialJson nor (yet)
 *     inputJson; fallback to inputPreview parse, behavior identical to
 *     pre-streaming clients.
 *   - "Old gateway with bad-JSON inputPreview": graceful null, no throw.
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { parsePartialJson } from '../public/modules/partialJson.js'

const MESSAGES_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'messages.js'),
  'utf-8',
)

// Extract just the `_safeInput` function. Same column-0 closing brace trick
// the other consistency tests use, kept local to avoid coupling.
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
  return lines.slice(headerIdx, endIdx + 1).join('\n').replace(/^export\s+/, '')
}

const _safeInputFn = extractTopLevelFn(MESSAGES_SRC, '_safeInput')

// Build a closure that resolves the parsePartialJson identifier _safeInput
// references, then exposes the function for tests.
const _safeInput = new Function(
  'parsePartialJson',
  `${_safeInputFn}; return _safeInput;`,
)(parsePartialJson) as (msg: any) => any

describe('_safeInput priority', () => {
  it('returns final inputJson when present (winning over partialJson)', () => {
    const msg = {
      inputJson: { file_path: '/x', new_string: 'final' },
      partialJson: '{"file_path":"/x","new_string":"par',
      inputPreview: '{"file_path":"/x","new_string":"par',
    }
    assert.deepEqual(_safeInput(msg), { file_path: '/x', new_string: 'final' })
  })

  it('returns tolerant-parsed partialJson when no inputJson', () => {
    const msg = {
      partialJson: '{"file_path":"/x","old_string":"hel',
      inputPreview: '{"file_path":"/x","old_string":"hel',
    }
    assert.deepEqual(_safeInput(msg), { file_path: '/x', old_string: 'hel' })
  })

  it('legacy fallback: JSON.parse(inputPreview) when partialJson absent (old gateway)', () => {
    const msg = { inputPreview: '{"file_path":"/x"}' }
    assert.deepEqual(_safeInput(msg), { file_path: '/x' })
  })

  it('legacy fallback returns null on un-parseable inputPreview (no throw)', () => {
    const msg = { inputPreview: '{"file_path":"/x"' }
    assert.equal(_safeInput(msg), null)
  })

  it('returns null when nothing is present', () => {
    assert.equal(_safeInput({}), null)
  })

  it('treats inputJson === null as absent (falls through to partialJson)', () => {
    const msg = {
      inputJson: null,
      partialJson: '{"a":"b"}',
    }
    assert.deepEqual(_safeInput(msg), { a: 'b' })
  })

  it('partialJson empty string falls through to inputPreview', () => {
    const msg = {
      partialJson: '',
      inputPreview: '{"a":"b"}',
    }
    assert.deepEqual(_safeInput(msg), { a: 'b' })
  })
})

describe('partial-stream → final transition (the race-safety contract)', () => {
  it('partial state renders a useful object; final state shadows it', () => {
    // Simulate websocket.js mutation order:
    //   t0: first input_json_delta arrives
    const msg: any = {
      partialJson: '{"file_path":"/tmp/a.ts","new_string":"hel',
      inputPreview: '{"file_path":"/tmp/a.ts","new_string":"hel',
      _partial: true,
    }
    let view = _safeInput(msg)
    assert.equal(view.file_path, '/tmp/a.ts')
    assert.equal(view.new_string, 'hel')

    //   t1: more deltas accumulate
    msg.partialJson = '{"file_path":"/tmp/a.ts","new_string":"hello world'
    view = _safeInput(msg)
    assert.equal(view.new_string, 'hello world')

    //   t2: final frame arrives — inputJson is set, _partial flipped.
    //       Any pending rAF firing AFTER this moment must still paint
    //       the FINAL view, not the stale partialJson (race contract).
    msg.inputJson = { file_path: '/tmp/a.ts', new_string: 'hello world!' }
    msg._partial = false
    view = _safeInput(msg)
    assert.deepEqual(view, { file_path: '/tmp/a.ts', new_string: 'hello world!' })
  })
})

describe('unknown / generic tool partial input does not corrupt rendering', () => {
  it('parser still extracts top-level fields for any tool name', () => {
    // The renderer dispatch in messages.js falls through to _renderGeneric
    // for tools without a case (e.g. MultiEdit, custom MCP); _safeInput
    // still returns useful structured data so generic JSON view shows
    // something rather than the raw cumulative preview string.
    const msg = {
      partialJson: '{"path":"/x","mode":"replace","count":3',
    }
    const view = _safeInput(msg)
    assert.equal(view.path, '/x')
    assert.equal(view.mode, 'replace')
    // count is mid-token (no terminator) so omitted — final frame fills it in.
    assert.equal(view.count, undefined)
  })
})
