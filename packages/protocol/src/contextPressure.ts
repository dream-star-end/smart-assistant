import { type Static, Type } from '@sinclair/typebox'

/** Ratios describe one measured boundary, never cumulative billed tokens. */
export const ContextPressure = Type.Object({
  engine: Type.String(),
  scope: Type.Union([Type.Literal('launch_prompt'), Type.Literal('native_context')]),
  dimension: Type.Union([Type.Literal('transport_bytes'), Type.Literal('tokens')]),
  level: Type.Union([Type.Literal('warning'), Type.Literal('critical')]),
  usedRatio: Type.Number({ minimum: 0 }),
})
export type ContextPressure = Static<typeof ContextPressure>

/** A completed context transformation. file_reference is not a summary. */
export const ContextCompaction = Type.Object({
  engine: Type.String(),
  scope: Type.Union([Type.Literal('launch_prompt'), Type.Literal('native_context')]),
  strategy: Type.Union([Type.Literal('history_suffix'), Type.Literal('file_reference')]),
  beforeBytes: Type.Integer({ minimum: 0 }),
  afterBytes: Type.Integer({ minimum: 0 }),
  droppedEntries: Type.Integer({ minimum: 0 }),
})
export type ContextCompaction = Static<typeof ContextCompaction>

export type ContextObservation =
  | { kind: 'context_pressure'; pressure: ContextPressure }
  | { kind: 'context_compacted'; compaction: ContextCompaction }

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
