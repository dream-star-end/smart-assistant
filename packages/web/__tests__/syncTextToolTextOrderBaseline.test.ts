/**
 * @baseline-v7.4 — Fix B per-segment row id baseline lock (frontend half).
 *
 * Captures the CURRENT (buggy) sync-merge behavior for a turn that emits
 * `text₁ → tool_use → text₂` from gateway:
 *
 *   - gateway stamps both text deltas with the same `srv-${peer}-${agent}-tN`
 *     id; frontend rolls them into a single assistant row whose ts =
 *     text₁ first-token ts.
 *   - tool gets its own `srv-...-tN-tool-${blockId}` row with later ts.
 *   - `_mergeServerAuthoredIntoLocal` does id-union then ts-sort
 *     (sync.js:362). Because the merged assistant row's ts < tool row's ts,
 *     output order is [assistant, tool] → user-visible order is
 *     "text₁text₂ ... [tool card]" — the tool card sits BELOW the text
 *     even though the live emit order was text₁ → tool → text₂.
 *
 * sync.js:354-361 already calls this out as the "Fix B (separate PR)"
 * technical debt comment.
 *
 * This baseline test will be flipped by Fix B (assistant becomes two rows
 * s0/s1 with distinct ts, ts-sort interleaves them with the tool row
 * naturally).
 *
 * Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §5.1
 *
 * Run: npx tsx --test packages/web/__tests__/syncTextToolTextOrderBaseline.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
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

const _SERVER_AUTH_KEYS_DECL =
  "const _SERVER_AUTH_KEYS = ['_seq', '_source', 'usage', '_truncated', '_errorCode', '_errorDetail'];"

const _combined =
  _SERVER_AUTH_KEYS_DECL +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_stableStringify') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_overlayServerAuthoritative') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_dropLegacyClientStreamRows') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_mergeServerAuthoredIntoLocal')

const { _mergeServerAuthoredIntoLocal } = new Function(
  `${_combined}; return { _mergeServerAuthoredIntoLocal };`,
)() as {
  _mergeServerAuthoredIntoLocal: (s: any[], l: any[]) => any[]
}

describe('@baseline-v7.4 sync: text → tool → text turn merges into wrong visual order', () => {
  it('BUGGY-BY-DESIGN: single assistant row + tool row → tool sorts BELOW text', () => {
    const T1 = 1_700_000_000_000 // text₁ first token
    const T2 = 1_700_000_000_500 // tool arrival
    // text₂ comes after tool, but gateway stamps it with same id as text₁,
    // so it gets merged into the existing assistant row whose ts stays at T1.

    const local = [
      { id: 'usr-1', role: 'user', text: 'q', ts: T1 - 1000 },
      // Single assistant row carrying the merged text₁+text₂ payload.
      {
        id: 'srv-peer1-agent1-t5',
        role: 'assistant',
        text: 'text₁ text₂',
        ts: T1,
        _source: 'client',
      },
      {
        id: 'srv-peer1-agent1-t5-tool-tu_abc',
        role: 'tool',
        text: '(tool output)',
        ts: T2,
        _source: 'client',
      },
    ]

    // Server-authored snapshot mirrors the same single-row shape.
    const server = [
      {
        id: 'srv-peer1-agent1-t5',
        role: 'assistant',
        text: 'text₁ text₂',
        ts: T1,
        _source: 'server',
        _seq: 10,
      },
      {
        id: 'srv-peer1-agent1-t5-tool-tu_abc',
        role: 'tool',
        text: '(tool output)',
        ts: T2,
        _source: 'server',
        _seq: 11,
      },
    ]

    const merged = _mergeServerAuthoredIntoLocal(server, local)

    const ids = merged.map((m) => m.id)
    assert.deepEqual(
      ids,
      [
        'usr-1',
        'srv-peer1-agent1-t5',         // <- assistant text (text₁+text₂ merged)
        'srv-peer1-agent1-t5-tool-tu_abc', // <- tool card sorts BELOW (ts > assistant ts)
      ],
      'BASELINE: tool card lands at the end because the merged assistant row ' +
        'keeps text₁ ts. After Fix B, assistant row splits into s0/s1 and ' +
        'the order becomes [user, asst-s0, tool, asst-s1].',
    )
  })
})
