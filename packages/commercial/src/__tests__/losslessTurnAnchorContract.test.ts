import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildLosslessTurnTapeRequests } from '../../../gateway/src/v3MasterSink.js'
import { materializeLosslessTurn } from '../http/losslessTurnTape.js'
import { assertSettlementMatchesCanonical, settlementAuthorityHash } from '../db/visibleFinalize.js'

const TURN_KEY = 'c'.repeat(64)
const CREATED_AT = 1_787_486_000_000

function base(extra: Record<string, unknown>): any {
  return {
    sessionId: 'web-anchor-contract',
    agentId: 'main',
    turnIndex: 7,
    status: 'completed',
    turnKey: TURN_KEY,
    text: '',
    createdAt: CREATED_AT,
    ...extra,
  }
}

function assertWriterReaderAnchor(payload: any, runtimeBatching: boolean): void {
  const previous = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING
  if (runtimeBatching) process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = '1'
  else Reflect.deleteProperty(process.env, 'LOSSLESS_TURN_TAPE_RUNTIME_BATCHING')
  try {
    const tape = buildLosslessTurnTapeRequests(payload)
    const raw = JSON.parse(tape.canonical.toString('utf8'))
    const materialized = materializeLosslessTurn(raw, { runtimeBatching })
    assert.equal(tape.finalize.settlement?.billingAnchorId, materialized.billingAnchorId)
    assert.ok(materialized.records.some((record) => record.id === materialized.billingAnchorId))
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'LOSSLESS_TURN_TAPE_RUNTIME_BATCHING')
    else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previous
  }
}

describe('lossless Phase-A/Phase-B billing anchor contract', () => {
  for (const runtimeBatching of [false, true]) {
    test(`structured-only plan/goal share one physical anchor (format ${runtimeBatching ? 3 : 2})`, () => {
      assertWriterReaderAnchor(base({
        structuredBlocks: [
          {
            kind: 'plan',
            blockId: 'plan-main',
            text: 'draft',
            partial: true,
            _ocObservedAt: CREATED_AT + 1,
            _ocEventOrdinal: 1,
          },
          {
            kind: 'goal',
            blockId: 'goal-main',
            platformGoalId: '11111111-1111-4111-8111-111111111111',
            objective: 'ship safely',
            status: 'complete',
            _ocObservedAt: CREATED_AT + 2,
            _ocEventOrdinal: 2,
          },
        ],
      }), runtimeBatching)
    })

    for (const count of [1, 3, 4, 128, 129]) {
      test(`runtime-only ${count} events share one physical anchor (format ${runtimeBatching ? 3 : 2})`, () => {
        assertWriterReaderAnchor(base({
          continuationOfTurnKey: 'd'.repeat(64),
          runtimeEvents: Array.from({ length: count }, (_, ordinal) => ({
            ordinal,
            observedAt: CREATED_AT + ordinal,
            source: 'ccb',
            payload: { type: 'progress', ordinal, exact: `event-${ordinal}` },
          })),
        }), runtimeBatching)
      })
    }

    test(`mixed thinking/tool/structured/runtime order shares anchor (format ${runtimeBatching ? 3 : 2})`, () => {
      assertWriterReaderAnchor(base({
        thinkingText: 'think',
        thinkingSegments: [{ index: 0, text: 'think', ts: CREATED_AT + 2, eventOrdinal: 2 }],
        tools: [{
          toolUseId: 'tool-1',
          blockId: 'tool-1',
          toolName: 'Read',
          inputJson: { file: 'x' },
          inputPreview: 'x',
          output: 'ok',
          isError: false,
          durationMs: 1,
          ts: CREATED_AT + 4,
          arrivedAt: CREATED_AT + 4,
          eventOrdinal: 4,
        }],
        structuredBlocks: [{
          kind: 'plan',
          blockId: 'plan-mixed',
          text: 'plan',
          partial: false,
          _ocObservedAt: CREATED_AT + 3,
          _ocEventOrdinal: 3,
        }],
        runtimeEvents: [1, 5, 6, 7].map((ordinal) => ({
          ordinal,
          observedAt: CREATED_AT + ordinal,
          source: 'gateway',
          payload: { type: 'progress', ordinal },
        })),
      }), runtimeBatching)
    })
  }
  for (const [writerBatching, readerBatching] of [[false, true], [true, false]] as const) {
    test(`rolling flag skew ${writerBatching ? 'on' : 'off'}→${readerBatching ? 'on' : 'off'} upgrades exact authority`, () => {
      const payload = base({
        continuationOfTurnKey: 'e'.repeat(64),
        runtimeEvents: Array.from({ length: 4 }, (_, ordinal) => ({
          ordinal,
          observedAt: CREATED_AT + ordinal,
          source: 'ccb',
          payload: { type: 'progress', ordinal },
        })),
      })
      const previous = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING
      if (writerBatching) process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = '1'
      else Reflect.deleteProperty(process.env, 'LOSSLESS_TURN_TAPE_RUNTIME_BATCHING')
      try {
        const tape = buildLosslessTurnTapeRequests(payload)
        const writer = tape.finalize.settlement!
        const reader = materializeLosslessTurn(JSON.parse(tape.canonical.toString('utf8')), {
          runtimeBatching: readerBatching,
        })
        assert.notEqual(writer.billingAnchorId, reader.billingAnchorId)
        const persistedHash = settlementAuthorityHash({
          billingAnchorId: writer.billingAnchorId,
          requestId: writer.requestId ?? null,
          engineBillings: writer.engineBillings,
        })
        const canonicalHash = settlementAuthorityHash({
          billingAnchorId: reader.billingAnchorId,
          requestId: null,
          engineBillings: reader.engineBillings,
        })
        assert.equal(assertSettlementMatchesCanonical({
          canonicalAnchorId: reader.billingAnchorId,
          canonicalRequestId: null,
          canonicalBillings: reader.engineBillings,
          persistedHash,
          persistedAuthority: {
            billingAnchorId: writer.billingAnchorId,
            requestId: writer.requestId ?? null,
            engineBillings: writer.engineBillings,
          },
          acceptedPersistedAuthorities: [{
            billingAnchorId: writer.billingAnchorId,
            requestId: writer.requestId ?? null,
            engineBillings: writer.engineBillings,
          }],
        }), canonicalHash)
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'LOSSLESS_TURN_TAPE_RUNTIME_BATCHING')
        else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previous
      }
    })
  }

})
