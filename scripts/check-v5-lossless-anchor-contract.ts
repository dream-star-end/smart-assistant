import assert from 'node:assert/strict'

import { buildLosslessTurnTapeRequests } from '../packages/gateway/src/v3MasterSink.js'
import { materializeLosslessTurn } from '../packages/commercial/src/http/losslessTurnTape.js'
import { assertSettlementMatchesCanonical, settlementAuthorityHash } from '../packages/commercial/src/db/visibleFinalize.js'

const payload = {
  sessionId: 'deploy-anchor-contract',
  agentId: 'tail_contract',
  turnIndex: 1,
  status: 'completed' as const,
  turnKey: 'a'.repeat(64),
  continuationOfTurnKey: 'b'.repeat(64),
  text: '',
  createdAt: 1_787_486_000_000,
  runtimeEvents: Array.from({ length: 4 }, (_, ordinal) => ({
    ordinal,
    observedAt: 1_787_486_000_000 + ordinal,
    source: 'ccb' as const,
    payload: { type: 'progress', ordinal },
  })),
}

function writer(batch: boolean) {
  const previous = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING
  if (batch) process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = '1'
  else Reflect.deleteProperty(process.env, 'LOSSLESS_TURN_TAPE_RUNTIME_BATCHING')
  try {
    return buildLosslessTurnTapeRequests(payload)
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'LOSSLESS_TURN_TAPE_RUNTIME_BATCHING')
    else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previous
  }
}

for (const mode of [false, true]) {
  const tape = writer(mode)
  const materialized = materializeLosslessTurn(JSON.parse(tape.canonical.toString('utf8')), {
    runtimeBatching: mode,
  })
  assert.equal(tape.finalize.settlement?.billingAnchorId, materialized.billingAnchorId)
  assert.ok(materialized.records.some((record) => record.id === materialized.billingAnchorId))
}

for (const [writeMode, readMode] of [[false, true], [true, false]] as const) {
  const tape = writer(writeMode)
  const persisted = tape.finalize.settlement!
  const materialized = materializeLosslessTurn(JSON.parse(tape.canonical.toString('utf8')), {
    runtimeBatching: readMode,
  })
  assert.notEqual(persisted.billingAnchorId, materialized.billingAnchorId)
  const persistedHash = settlementAuthorityHash({
    billingAnchorId: persisted.billingAnchorId,
    requestId: persisted.requestId ?? null,
    engineBillings: persisted.engineBillings,
  })
  assert.equal(assertSettlementMatchesCanonical({
    canonicalAnchorId: materialized.billingAnchorId,
    canonicalRequestId: null,
    canonicalBillings: materialized.engineBillings,
    persistedHash,
    persistedAuthority: {
      billingAnchorId: persisted.billingAnchorId,
      requestId: null,
      engineBillings: persisted.engineBillings,
    },
    acceptedPersistedAuthorities: [{
      billingAnchorId: persisted.billingAnchorId,
      requestId: null,
      engineBillings: persisted.engineBillings,
    }],
  }), settlementAuthorityHash({
    billingAnchorId: materialized.billingAnchorId,
    requestId: null,
    engineBillings: materialized.engineBillings,
  }))
}

console.log('lossless-anchor-contract: PASS')
