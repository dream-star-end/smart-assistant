/**
 * Fix B per-segment row id — frontend new-behavior test.
 *
 * Replaces the @baseline-v7.4 baseline lock in
 * `syncTextToolTextOrderBaseline.test.ts` (kept for git-history reference).
 *
 * After Fix B:
 *   - gateway emits `text₁` and `text₂` as two distinct messageIds
 *     `srv-...-tN-s0` and `srv-...-tN-s1`, each with its own ts;
 *   - sync-merge's id-union + ts-sort interleaves the tool row naturally
 *     between them, so the user-visible order matches the live emit order:
 *       [user, asst-s0, tool, asst-s1]
 *   - `_dropLegacyClientStreamRows` discriminates assistant/thinking by
 *     role (not id suffix), so per-segment ids still get cleaned up when
 *     a server-authored copy lands.
 *
 * Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §5.1
 *
 * Run: npx tsx --test packages/web/__tests__/syncFixBSegmentOrder.test.ts
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

describe('Fix B sync: text → tool → text turn interleaves naturally via per-segment ids', () => {
  it('two assistant segments + tool row sort as [user, asst-s0, tool, asst-s1]', () => {
    const T_USER = 1_700_000_000_000
    const T_S0 = 1_700_000_000_100 // text₁ first token
    const T_TOOL = 1_700_000_000_300 // tool arrival
    const T_S1 = 1_700_000_000_500 // text₂ first token

    const local = [
      { id: 'usr-1', role: 'user', text: 'q', ts: T_USER },
      {
        id: 'srv-peer1-agent1-t5-s0',
        role: 'assistant',
        text: 'text₁ ',
        ts: T_S0,
        _source: 'client',
      },
      {
        id: 'srv-peer1-agent1-t5-tool-tu_abc',
        role: 'tool',
        text: '(tool output)',
        ts: T_TOOL,
        _source: 'client',
      },
      {
        id: 'srv-peer1-agent1-t5-s1',
        role: 'assistant',
        text: 'text₂',
        ts: T_S1,
        _source: 'client',
      },
    ]

    const server = [
      {
        id: 'srv-peer1-agent1-t5-s0',
        role: 'assistant',
        text: 'text₁ ',
        ts: T_S0,
        _source: 'server',
        _seq: 10,
      },
      {
        id: 'srv-peer1-agent1-t5-tool-tu_abc',
        role: 'tool',
        text: '(tool output)',
        ts: T_TOOL,
        _source: 'server',
        _seq: 11,
      },
      {
        id: 'srv-peer1-agent1-t5-s1',
        role: 'assistant',
        text: 'text₂',
        ts: T_S1,
        _source: 'server',
        _seq: 12,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]

    const merged = _mergeServerAuthoredIntoLocal(server, local)

    const ids = merged.map((m) => m.id)
    assert.deepEqual(
      ids,
      [
        'usr-1',
        'srv-peer1-agent1-t5-s0',
        'srv-peer1-agent1-t5-tool-tu_abc',
        'srv-peer1-agent1-t5-s1',
      ],
      'tool card interleaves between the two assistant segments via ts-sort',
    )

    const lastSeg = merged.find((m) => m.id === 'srv-peer1-agent1-t5-s1')
    assert.ok(lastSeg, 'last assistant segment present')
    assert.deepEqual(
      lastSeg.usage,
      { input_tokens: 10, output_tokens: 5 },
      'usage rides on the last segment only',
    )
    const firstSeg = merged.find((m) => m.id === 'srv-peer1-agent1-t5-s0')
    assert.equal(firstSeg.usage, undefined, 'usage NOT on first segment')
  })

  it('thinking segments interleave with tools the same way (role=thinking)', () => {
    const T_TH0 = 1_700_000_000_100
    const T_TOOL = 1_700_000_000_300
    const T_TH1 = 1_700_000_000_500

    const local = [
      {
        id: 'srv-peer1-agent1-t5-thinking-s0',
        role: 'thinking',
        text: 'pondering... ',
        ts: T_TH0,
        _source: 'client',
      },
      {
        id: 'srv-peer1-agent1-t5-tool-tu_x',
        role: 'tool',
        text: '(tool output)',
        ts: T_TOOL,
        _source: 'client',
      },
      {
        id: 'srv-peer1-agent1-t5-thinking-s1',
        role: 'thinking',
        text: 'continuing thought',
        ts: T_TH1,
        _source: 'client',
      },
    ]

    const server = local.map((m, i) => ({
      ...m,
      _source: 'server',
      _seq: 10 + i,
    }))

    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m) => m.id),
      [
        'srv-peer1-agent1-t5-thinking-s0',
        'srv-peer1-agent1-t5-tool-tu_x',
        'srv-peer1-agent1-t5-thinking-s1',
      ],
    )
  })
})
