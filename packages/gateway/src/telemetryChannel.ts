// TelemetryChannel — per-turn sink for OpenClaude telemetry events emitted by
// CCB over the `_oc_telemetry` side-channel.
//
// Design rules (see docs/ccb-telemetry-refactor-plan.md):
//   R7  If telemetry signals are missing (`apiState === 'unknown'`), Gateway
//       falls back to the legacy PHANTOM_TURN heuristic. Never fail closed.
//   R9  One TelemetryChannel instance is created per turn and is dropped at
//       turn end by sessionManager's `detach()`. Resetting between turns is
//       caller responsibility via `resetForNewTurn()` for multi-turn reuse.

/** v3: three-state to disambiguate "no data" from "data says not-called". */
export type ApiState = 'called' | 'skipped' | 'unknown'

export interface OcTelemetryEvent {
  type: '_oc_telemetry'
  schemaVersion: number
  event: string
  session_id?: string
  data: Record<string, unknown>
  ts: number
}

export interface TurnSignals {
  apiState: ApiState
  /** When apiState === 'skipped', the CCB-reported reason (e.g. slash cmd). */
  skipReason: string | null
  /** When apiState === 'called', the Date.now() at which CCB fired willCallApi. */
  willCallApiAt: number | null
}

export class TelemetryChannel {
  private willCallApi?: OcTelemetryEvent
  private skipped?: OcTelemetryEvent
  private apiResponse?: OcTelemetryEvent
  private lastToolPreUse?: OcTelemetryEvent
  private toolErrors: OcTelemetryEvent[] = []
  private sessionStart?: OcTelemetryEvent
  private sessionEnd?: OcTelemetryEvent
  private incompleteCount = 0
  private conflictCount = 0

  ingest(ev: OcTelemetryEvent): void {
    switch (ev.event) {
      case 'turn.willCallApi':
        this.willCallApi = ev
        // Defensive: in current CCB (serial single-subprocess) called+skipped
        // in the same turn cannot happen. If it ever does, we keep "skipped
        // wins" semantics and bump conflictCount so the anomaly shows up in
        // diagnostics rather than silently flipping phantom judgment.
        if (this.skipped) this.conflictCount++
        break
      case 'turn.skipped':
        this.skipped = ev
        if (this.willCallApi) this.conflictCount++
        break
      case 'turn.apiResponse':
        // Complement to willCallApi — fires after stream end with final
        // usage/cost/stopReason. Overwrites on multi-attempt retries; consumer
        // reads getTurnApiResponse() exactly once at onFinish.
        this.apiResponse = ev
        break
      case 'tool.preUse':
        // Only last one is retained — intended use is "what tool is ccb
        // currently running" for progress hint, not audit trail.
        this.lastToolPreUse = ev
        break
      case 'tool.error':
        // All tool errors in the turn are retained (bounded by CCB event
        // emission rate + MAX_EVENT_BYTES + sanitize). Cap retention at 32 to
        // prevent unbounded growth if a bug causes an error loop.
        if (this.toolErrors.length < 32) this.toolErrors.push(ev)
        break
      case 'session.start':
        this.sessionStart = ev
        break
      case 'session.end':
        this.sessionEnd = ev
        break
      // Unknown events are silently ignored (forward-compat with future
      // schemaVersion upgrades that add new event names).
    }
  }

  /** Last-seen tool.preUse this turn (for progress hint / typing state). */
  getLastToolPreUse(): OcTelemetryEvent | undefined {
    return this.lastToolPreUse
  }

  /** All tool.error events recorded this turn (capped at 32). */
  getToolErrors(): ReadonlyArray<OcTelemetryEvent> {
    return this.toolErrors
  }

  /** Final turn.apiResponse (tokens/cost/stopReason) if received. */
  getTurnApiResponse(): OcTelemetryEvent | undefined {
    return this.apiResponse
  }

  /** session.start if received during this channel's lifetime. */
  getSessionStart(): OcTelemetryEvent | undefined {
    return this.sessionStart
  }

  /** session.end if received during this channel's lifetime. */
  getSessionEnd(): OcTelemetryEvent | undefined {
    return this.sessionEnd
  }

  /**
   * Collapse the per-turn state into signals that sessionManager uses for
   * phantom-turn judgment. Called exactly once at `onFinish`.
   */
  getTurnSignals(): TurnSignals {
    // Priority: skipped > called > unknown. Reasoning: a CCB "turn.skipped"
    // emission is the strongest possible statement that no API call should
    // have happened this turn (cost=0 & block=0 are expected, not anomalous).
    if (this.skipped) {
      return {
        apiState: 'skipped',
        skipReason:
          typeof this.skipped.data.reason === 'string'
            ? (this.skipped.data.reason as string)
            : null,
        willCallApiAt: null,
      }
    }
    if (this.willCallApi) {
      return {
        apiState: 'called',
        skipReason: null,
        willCallApiAt: this.willCallApi.ts,
      }
    }
    return { apiState: 'unknown', skipReason: null, willCallApiAt: null }
  }

  resetForNewTurn(): void {
    this.willCallApi = undefined
    this.skipped = undefined
    this.apiResponse = undefined
    this.lastToolPreUse = undefined
    this.toolErrors = []
    // NOTE: sessionStart/sessionEnd intentionally NOT reset — they are
    // subprocess-lifecycle events, not per-turn. resetForNewTurn() is only
    // used in reused-channel paths; per-turn channels are constructed fresh.
  }

  /** willCallApi was fired but the turn never produced a final.result row. */
  noteIncomplete(): void {
    this.incompleteCount++
  }

  getIncompleteCount(): number {
    return this.incompleteCount
  }

  getConflictCount(): number {
    return this.conflictCount
  }
}
