/**
 * v7 multi-text-block-per-turn rebind helper.
 *
 * Codex Round 4 blocker (2026-05-13): the gateway stamps ONE canonical
 * `messageId` per turn on ALL text blocks (text → tool_use → text again).
 * When the tool_use branch clears `sess._streamingAssistant`, the next
 * text delta arrives with the SAME id. The pre-fix websocket.js code
 * unconditionally called `addMessage(... { id: messageId })`, producing
 * a duplicate row with identical id. That:
 *   - breaks the v7 invariant "one logical message = one canonical id"
 *   - poisons `appendServerAuthoredPure` takeover (it replaces only the
 *     first match by id, leaving the duplicate client row behind)
 *
 * Fix: `_findOrCreateStreamingRow` first searches sess.messages for an
 * existing row with that id+role and returns it (rebind) instead of
 * creating a new one.
 *
 * Source-extract pattern: pull just the helper from websocket.js so we
 * don't have to load the whole browser-bound module.
 *
 * Run: npx tsx --test packages/web/__tests__/wsMultiBlockRebind.test.ts
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

const _src = extractTopLevelFn(WS_SRC, '_findOrCreateStreamingRow')
const _findOrCreateStreamingRow = new Function(
  `${_src}; return _findOrCreateStreamingRow;`,
)() as (
  sess: { messages: any[] },
  role: 'assistant' | 'thinking',
  messageId: string | undefined,
  create: (idOverride: { id?: string }) => any,
) => any

describe('_findOrCreateStreamingRow — v7 rebind', () => {
  it('no existing row + messageId → creates new row with that id', () => {
    const sess = { messages: [] as any[] }
    const created: any[] = []
    const row = _findOrCreateStreamingRow(
      sess, 'assistant', 'srv-peer1-t5',
      (idOverride) => {
        const m = { id: idOverride.id, role: 'assistant', text: '' }
        created.push(m)
        sess.messages.push(m)
        return m
      },
    )
    assert.equal(row.id, 'srv-peer1-t5')
    assert.equal(sess.messages.length, 1)
    assert.equal(created.length, 1, 'create factory called exactly once')
  })

  it('no existing row + NO messageId → creates new row WITHOUT id override (legacy m-* path)', () => {
    const sess = { messages: [] as any[] }
    const row = _findOrCreateStreamingRow(
      sess, 'assistant', undefined,
      (idOverride) => {
        const m = { id: idOverride.id ?? 'm-fallback-1', role: 'assistant', text: '' }
        sess.messages.push(m)
        return m
      },
    )
    assert.equal(row.id, 'm-fallback-1')
    assert.equal(sess.messages.length, 1)
  })

  // ── The codex blocker scenario ──
  it('REBIND: text → tool_use → text with same canonical messageId → ONE row, no duplicate', () => {
    const sess: any = { messages: [], _streamingAssistant: null }
    const create = (idOverride: { id?: string }) => {
      const m: any = { id: idOverride.id, role: 'assistant', text: '' }
      sess.messages.push(m)
      return m
    }

    // First text block arrives — no existing row
    sess._streamingAssistant = _findOrCreateStreamingRow(
      sess, 'assistant', 'srv-peer1-t5', create,
    )
    sess._streamingAssistant.text += 'before-tool '

    // tool_use clears the streaming pointer (mirrors websocket.js:2095)
    sess._streamingAssistant = null

    // Second text block arrives with SAME messageId
    sess._streamingAssistant = _findOrCreateStreamingRow(
      sess, 'assistant', 'srv-peer1-t5', create,
    )
    sess._streamingAssistant.text += 'after-tool'

    assert.equal(sess.messages.length, 1, 'must NOT create a duplicate row')
    assert.equal(sess.messages[0].id, 'srv-peer1-t5')
    assert.equal(sess.messages[0].text, 'before-tool after-tool')
  })

  it('REBIND scoped to role: an existing thinking row with the same id does NOT match assistant search', () => {
    // The thinking id is `srv-${peerId}-t${turn}-thinking` and assistant is
    // `srv-${peerId}-t${turn}` — they're distinct. But the role guard is the
    // backstop against any future id-overlap mistake (e.g. a parser bug).
    const sess: any = {
      messages: [{ id: 'srv-peer1-t5', role: 'thinking', text: 'pondering' }],
    }
    const create = (idOverride: { id?: string }) => {
      const m: any = { id: idOverride.id, role: 'assistant', text: '' }
      sess.messages.push(m)
      return m
    }
    const row = _findOrCreateStreamingRow(
      sess, 'assistant', 'srv-peer1-t5', create,
    )
    assert.equal(sess.messages.length, 2, 'role mismatch → new row created')
    assert.equal(row.role, 'assistant')
  })

  it('REBIND thinking: separate thinking id shared across multiple thinking blocks in a turn', () => {
    const sess: any = { messages: [], _streamingThinking: null }
    const create = (idOverride: { id?: string }) => {
      const m: any = { id: idOverride.id, role: 'thinking', text: '' }
      sess.messages.push(m)
      return m
    }

    sess._streamingThinking = _findOrCreateStreamingRow(
      sess, 'thinking', 'srv-peer1-t5-thinking', create,
    )
    sess._streamingThinking.text += 'first-think '

    // Some boundary clears the pointer (e.g. assistant text in between)
    sess._streamingThinking = null

    sess._streamingThinking = _findOrCreateStreamingRow(
      sess, 'thinking', 'srv-peer1-t5-thinking', create,
    )
    sess._streamingThinking.text += 'second-think'

    assert.equal(sess.messages.length, 1)
    assert.equal(sess.messages[0].id, 'srv-peer1-t5-thinking')
    assert.equal(sess.messages[0].text, 'first-think second-think')
  })

  it('does NOT rebind to a row whose role differs even if id matches (defense in depth)', () => {
    // If something ever wrote an assistant row with the thinking id (or vice
    // versa), the rebind must NOT cross roles — otherwise we'd append
    // thinking text into an assistant row.
    const sess: any = {
      messages: [{ id: 'srv-peer1-t5-thinking', role: 'assistant', text: 'oops cross-role' }],
    }
    const create = (idOverride: { id?: string }) => {
      const m: any = { id: idOverride.id, role: 'thinking', text: '' }
      sess.messages.push(m)
      return m
    }
    _findOrCreateStreamingRow(sess, 'thinking', 'srv-peer1-t5-thinking', create)
    assert.equal(sess.messages.length, 2)
    assert.equal(sess.messages[1].role, 'thinking')
  })

  it('returns the SAME object reference when rebinding (caller mutates `text` directly)', () => {
    const existing = { id: 'srv-peer1-t5', role: 'assistant', text: 'partial' }
    const sess: any = { messages: [existing] }
    const create = () => { throw new Error('factory MUST NOT be called on rebind') }
    const rebound = _findOrCreateStreamingRow(
      sess, 'assistant', 'srv-peer1-t5', create,
    )
    assert.equal(rebound, existing, 'same reference (so caller .text += ... works)')
  })
})
