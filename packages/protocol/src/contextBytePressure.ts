import type { ContextObservation, ContextPressure } from './contextPressure.js'

/** Shared by launch prompts and serialized native requests. */
export function contextBytePressure(
  engine: string,
  scope: ContextPressure['scope'],
  usedRatio: number,
): ContextObservation | undefined {
  if (usedRatio < 0.8) return undefined
  return { kind: 'context_pressure', pressure: {
    engine, scope, dimension: 'transport_bytes',
    level: usedRatio >= 1 ? 'critical' : 'warning', usedRatio,
  } }
}
