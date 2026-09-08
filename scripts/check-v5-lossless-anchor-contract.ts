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

// OCV5-189 deploy proof: cross-turn delegate billing materializes and settles by its own locator.
// A background delegate admitted in turn N drains its team card into turn N+1's tape
// (dlgcb-* callback / scheduled continuation). This proves the tape materializes, the
// sink and the reader agree on the anchor, the cross-turn billing is carried verbatim
// (parentTurnKey = turn N) into both the agent-group record and the settlement list, and
// the Phase-A → Phase-B settlement authority handshake accepts it. It is a source /
// authority contract proof: it does NOT execute a PG debit and does not claim to verify
// the final credit amount — attribution is done by the finalizer from the billing's own
// requestId/parentTurnKey, not from the enclosing tape.
{
  const sessionId = 'deploy-cross-turn-card'
  const currentTurnKey = 'c'.repeat(64)
  const earlierTurnKey = 'd'.repeat(64)
  const crossTurnBilling = {
    requestId: '1'.repeat(32),
    turnKey: 'e'.repeat(64),
    parentTurnKey: earlierTurnKey,
    parentSessionId: sessionId,
    delegateAgentId: 'auditor',
    engineSessionId: `oceng-${'f'.repeat(48)}`,
    status: 'success' as const,
    durationMs: 1,
    usage: { input_tokens: 3, output_tokens: 2 },
  }
  const rootBilling = {
    requestId: '2'.repeat(32),
    turnKey: currentTurnKey,
    engineSessionId: `oceng-${'9'.repeat(48)}`,
    status: 'success' as const,
    durationMs: 1,
    usage: { input_tokens: 5, output_tokens: 1 },
  }
  const basePayload = {
    sessionId,
    agentId: 'main',
    turnIndex: 3,
    clientMessageId: 'dlgcb-dlgjob-deploy-proof-1',
    status: 'completed' as const,
    turnKey: currentTurnKey,
    text: 'answer',
    createdAt: 1_788_837_723_365,
    agentGroups: [{
      runId: 'dlg-deploy-cross-turn',
      agentId: 'auditor',
      goal: 'cross-turn proof',
      status: 'ok' as const,
      completedAt: 1_788_837_723_000,
      engineBillings: [crossTurnBilling],
    }],
  }

  /** Replays the production two-phase authority handshake for one payload.
   *  Phase A (HTTP finalize, pgSessionsBackend visible path) persists the sink
   *  envelope's hash: settlementAuthorityHash({anchor, settlement.requestId,
   *  settlement.engineBillings}). Phase B (materialization worker, no envelope)
   *  re-derives canonical authority from the tape bytes with
   *  canonicalRequestId = engineBillings[0].requestId ?? payload.requestId and
   *  persistedRequestId = persistedBillings[0].requestId ?? payload.requestId,
   *  then runs assertSettlementMatchesCanonical against the persisted hash. */
  function proveTwoPhaseAuthority(
    payload: typeof basePayload & { requestId?: string; engineBilling?: typeof rootBilling },
  ) {
    const tape = buildLosslessTurnTapeRequests(payload)
    const settlement = tape.finalize.settlement!
    const materialized = materializeLosslessTurn(JSON.parse(tape.canonical.toString('utf8')))
    assert.equal(settlement.billingAnchorId, materialized.billingAnchorId)
    const persistedHash = settlementAuthorityHash({
      billingAnchorId: settlement.billingAnchorId,
      requestId: settlement.requestId ?? null,
      engineBillings: settlement.engineBillings,
    })
    const canonicalRequestId = materialized.engineBillings[0]?.requestId ?? payload.requestId ?? null
    const persistedRequestId = settlement.engineBillings[0]?.requestId ?? payload.requestId ?? null
    const canonicalHash = assertSettlementMatchesCanonical({
      canonicalAnchorId: materialized.billingAnchorId,
      canonicalRequestId,
      canonicalBillings: materialized.engineBillings,
      envelope: null,
      persistedHash,
      persistedAuthority: {
        billingAnchorId: settlement.billingAnchorId,
        requestId: persistedRequestId,
        engineBillings: settlement.engineBillings,
      },
      acceptedPersistedAuthorities: [],
    })
    assert.equal(canonicalHash, settlementAuthorityHash({
      billingAnchorId: materialized.billingAnchorId,
      requestId: canonicalRequestId,
      engineBillings: materialized.engineBillings,
    }))
    return { materialized, settlement }
  }

  // Shape of the real incident tape (webmts0diug8rfqdp turn 3): root Codex billing
  // plus a delegate card whose billing points at the previous turn.
  const withRoot = proveTwoPhaseAuthority({
    ...basePayload,
    requestId: rootBilling.requestId,
    engineBilling: rootBilling,
  })
  assert.deepEqual(withRoot.materialized.engineBillings, [rootBilling, crossTurnBilling])
  assert.equal(withRoot.materialized.engineBillings[1]?.parentTurnKey, earlierTurnKey)
  assert.deepEqual(withRoot.settlement.engineBillings, [rootBilling, crossTurnBilling])
  assert.ok(withRoot.materialized.records.some((record) => record.role === 'agent-group'))

  // Leader without its own engine billing (CCB/proxy-billed leader): the tape's only
  // billing is the cross-turn delegate; Phase B takes the persisted-authority upgrade
  // path and must still converge.
  const withoutRoot = proveTwoPhaseAuthority(basePayload)
  assert.deepEqual(withoutRoot.materialized.engineBillings, [crossTurnBilling])
  assert.equal(withoutRoot.materialized.engineBillings[0]?.parentTurnKey, earlierTurnKey)

  // Session boundary stays a hard rejection.
  assert.throws(
    () => materializeLosslessTurn({
      ...basePayload,
      agentGroups: [{
        ...basePayload.agentGroups[0]!,
        engineBillings: [{ ...crossTurnBilling, parentSessionId: 'another-session' }],
      }],
    }),
    /parent locator is invalid/,
  )
}

console.log('lossless-anchor-contract: PASS')
