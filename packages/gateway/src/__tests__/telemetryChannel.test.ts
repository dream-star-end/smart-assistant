/**
 * Unit tests for TelemetryChannel (per-turn state aggregator for CCB
 * _oc_telemetry events).
 *
 * Design rules exercised (see docs/ccb-telemetry-refactor-plan.md):
 *   R7 — three-state ApiState + "skipped wins" conflict policy.
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type OcTelemetryEvent,
  TelemetryChannel,
} from '../telemetryChannel.js'

function mkEvent(
  event: string,
  data: Record<string, unknown> = {},
  ts = Date.now(),
): OcTelemetryEvent {
  return {
    type: '_oc_telemetry',
    schemaVersion: 1,
    event,
    session_id: 'sess-test',
    data,
    ts,
  }
}

describe('TelemetryChannel.getTurnSignals (R7 three-state)', () => {
  it("empty state → apiState='unknown'", () => {
    const ch = new TelemetryChannel()
    const s = ch.getTurnSignals()
    assert.equal(s.apiState, 'unknown')
    assert.equal(s.skipReason, null)
    assert.equal(s.willCallApiAt, null)
  })

  it("only turn.willCallApi → apiState='called' + willCallApiAt", () => {
    const ch = new TelemetryChannel()
    const ts = 1_700_000_000_000
    ch.ingest(mkEvent('turn.willCallApi', { model: 'opus' }, ts))
    const s = ch.getTurnSignals()
    assert.equal(s.apiState, 'called')
    assert.equal(s.willCallApiAt, ts)
    assert.equal(s.skipReason, null)
  })

  it("only turn.skipped → apiState='skipped' + reason", () => {
    const ch = new TelemetryChannel()
    ch.ingest(mkEvent('turn.skipped', { reason: 'shouldQuery=false' }))
    const s = ch.getTurnSignals()
    assert.equal(s.apiState, 'skipped')
    assert.equal(s.skipReason, 'shouldQuery=false')
    assert.equal(s.willCallApiAt, null)
  })

  it('skipped + called → skipped wins, conflictCount=1 (v3 defensive)', () => {
    const ch = new TelemetryChannel()
    ch.ingest(mkEvent('turn.willCallApi'))
    ch.ingest(mkEvent('turn.skipped', { reason: 'race' }))
    const s = ch.getTurnSignals()
    assert.equal(s.apiState, 'skipped')
    assert.equal(s.skipReason, 'race')
    assert.equal(ch.getConflictCount(), 1)
  })

  it('called-then-skipped and skipped-then-called both register conflict', () => {
    const a = new TelemetryChannel()
    a.ingest(mkEvent('turn.willCallApi'))
    a.ingest(mkEvent('turn.skipped'))
    assert.equal(a.getConflictCount(), 1)

    const b = new TelemetryChannel()
    b.ingest(mkEvent('turn.skipped'))
    b.ingest(mkEvent('turn.willCallApi'))
    assert.equal(b.getConflictCount(), 1)
    // Both end up with skipped winning
    assert.equal(a.getTurnSignals().apiState, 'skipped')
    assert.equal(b.getTurnSignals().apiState, 'skipped')
  })
})

describe('TelemetryChannel.ingest', () => {
  it('silently ignores unknown events (forward-compat)', () => {
    const ch = new TelemetryChannel()
    ch.ingest(mkEvent('turn.future.unknown', { foo: 1 }))
    assert.equal(ch.getTurnSignals().apiState, 'unknown')
    assert.equal(ch.getConflictCount(), 0)
  })

  it('skipped without reason yields skipReason=null (not undefined/crash)', () => {
    const ch = new TelemetryChannel()
    ch.ingest(mkEvent('turn.skipped', {}))
    assert.equal(ch.getTurnSignals().skipReason, null)
  })
})

describe('TelemetryChannel counters', () => {
  it('resetForNewTurn clears willCallApi and skipped but keeps counts', () => {
    const ch = new TelemetryChannel()
    ch.ingest(mkEvent('turn.willCallApi'))
    ch.ingest(mkEvent('turn.skipped'))
    ch.noteIncomplete()
    assert.equal(ch.getConflictCount(), 1)
    assert.equal(ch.getIncompleteCount(), 1)

    ch.resetForNewTurn()
    assert.equal(ch.getTurnSignals().apiState, 'unknown')
    // Persistent diagnostic counters survive reset.
    assert.equal(ch.getConflictCount(), 1)
    assert.equal(ch.getIncompleteCount(), 1)
  })

  it('noteIncomplete is monotonically counted', () => {
    const ch = new TelemetryChannel()
    ch.noteIncomplete()
    ch.noteIncomplete()
    ch.noteIncomplete()
    assert.equal(ch.getIncompleteCount(), 3)
  })
})
