import type { Logger } from '../logging/logger.js'

/** Passive stages: immutable request bindings, no payload, authority or stream changes. */
export function createPassiveRelayTiming(
  logger: Pick<Logger, 'info'> | undefined,
  identity: Readonly<Record<string, string | null>>,
  startedAt = performance.now(),
) {
  const captured = Object.freeze({ ...identity })
  const seen = new Set<string>()
  return (stage: string, fields?: { statusCode: number }) => {
    if (seen.has(stage)) return
    seen.add(stage)
    try {
      logger?.info('native_relay_stage_timing', {
        ...captured, stage, elapsedMs: performance.now() - startedAt, ...fields,
      })
    } catch { /* Telemetry must not change a relay's outcome. */ }
  }
}
