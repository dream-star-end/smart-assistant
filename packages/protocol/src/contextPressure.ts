import { type Static, Type } from '@sinclair/typebox'

export const ContextBreakdown = Type.Object({
  systemBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  memoryBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  skillsBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  projectBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  historyBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  toolsBytes: Type.Optional(Type.Integer({ minimum: 0 })),
})
export type ContextBreakdown = Static<typeof ContextBreakdown>

/** Ratios describe one measured boundary, never cumulative billed tokens. */
export const ContextPressure = Type.Object({
  engine: Type.String(),
  scope: Type.Union([Type.Literal('launch_prompt'), Type.Literal('native_context')]),
  dimension: Type.Union([Type.Literal('transport_bytes'), Type.Literal('tokens')]),
  level: Type.Union([Type.Literal('warning'), Type.Literal('critical')]),
  usedRatio: Type.Number({ minimum: 0 }),
  usedTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  windowTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  breakdown: Type.Optional(ContextBreakdown),
})
export type ContextPressure = Static<typeof ContextPressure>

const ContextCompactionCommon = {
  beforeTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  afterTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  summaryPreview: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()),
}

/** A completed context transformation. file_reference is not a summary. */
export const ContextCompaction = Type.Union([Type.Object({
  engine: Type.String(),
  scope: Type.Union([Type.Literal('launch_prompt'), Type.Literal('native_context')]),
  strategy: Type.Union([Type.Literal('history_suffix'), Type.Literal('file_reference')]),
  beforeBytes: Type.Integer({ minimum: 0 }),
  afterBytes: Type.Integer({ minimum: 0 }),
  droppedEntries: Type.Integer({ minimum: 0 }),
  ...ContextCompactionCommon,
}), Type.Object({
  engine: Type.String(),
  scope: Type.Literal('native_context'),
  strategy: Type.Union([Type.Literal('native_summary'), Type.Literal('checkpoint_reset')]),
  beforeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  afterBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  droppedEntries: Type.Optional(Type.Integer({ minimum: 0 })),
  ...ContextCompactionCommon,
})])
export type ContextCompaction = Static<typeof ContextCompaction>

export type ContextObservation =
  | { kind: 'context_pressure'; pressure: ContextPressure }
  | { kind: 'context_compacted'; compaction: ContextCompaction }

export { contextBytePressure } from './contextBytePressure.js'
