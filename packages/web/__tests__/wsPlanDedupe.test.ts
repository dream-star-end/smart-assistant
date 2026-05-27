/**
 * Tests for Codex plan-card identity helpers. The websocket stream may receive
 * multiple updates for one plan; sync/refresh must not preserve stale duplicate
 * plan rows from the same turn.
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

const helperSrc = [
  '_isPlanTurnBoundary',
  '_planTurnStart',
  '_planTurnEnd',
  '_safePlanIdPart',
  '_planMessageId',
  '_planMsgTime',
  '_planMsgRank',
  '_comparePlanMsg',
  '_coalescePlanMessagesInTurn',
]
  .map((name) => extractTopLevelFn(WS_SRC, name))
  .join('\n')

const { _planMessageId, _coalescePlanMessagesInTurn } = new Function(
  `${helperSrc}; return { _planMessageId, _coalescePlanMessagesInTurn };`,
)() as {
  _planMessageId: (blockId: string, turnStart: number) => string
  _coalescePlanMessagesInTurn: (messages: any[], blockId: string, anchor: any) => any
}

describe('Codex plan websocket helpers', () => {
  it('derives a deterministic id from blockId and turn group', () => {
    assert.equal(_planMessageId('codex-plan-t1', 3), 'plan:codex-plan-t1:g3')
    assert.equal(_planMessageId('codex plan/奇怪', 0), 'plan:codex_plan___:g0')
  })

  it('coalesces same-turn duplicate plan rows and keeps the strongest row', () => {
    const messages = [
      { id: 'u1', role: 'user', ts: 100 },
      {
        id: 'p-partial',
        role: 'plan',
        blockId: 'codex-plan-t1',
        ts: 210,
        completedAt: 210,
        _partial: true,
        steps: [
          { step: 'a', status: 'completed' },
          { step: 'b', status: 'pending' },
        ],
      },
      {
        id: 'p-final',
        role: 'plan',
        blockId: 'codex-plan-t1',
        ts: 200,
        completedAt: 300,
        _partial: false,
        steps: [
          { step: 'a', status: 'completed' },
          { step: 'b', status: 'completed' },
        ],
      },
    ]

    const kept = _coalescePlanMessagesInTurn(messages, 'codex-plan-t1', messages[1])
    assert.equal(kept.id, 'p-final')
    assert.deepEqual(
      messages.map((m) => m.id),
      ['u1', 'p-final'],
    )
  })

  it('does not coalesce legacy blockIds across different user turns', () => {
    const messages = [
      { id: 'u1', role: 'user', ts: 100 },
      { id: 'p1', role: 'plan', blockId: 'codex-plan', ts: 200 },
      { id: 'u2', role: 'user', ts: 300 },
      { id: 'p2', role: 'plan', blockId: 'codex-plan', ts: 400 },
    ]

    const kept = _coalescePlanMessagesInTurn(messages, 'codex-plan', messages[3])
    assert.equal(kept.id, 'p2')
    assert.deepEqual(
      messages.map((m) => m.id),
      ['u1', 'p1', 'u2', 'p2'],
    )
  })
})
