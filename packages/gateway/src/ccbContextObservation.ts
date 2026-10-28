import { ContextPressure, ContextCompaction, type ContextObservation } from '@openclaude/protocol'
import { Value } from '@sinclair/typebox/value'

/** Validate and project the SDK sideband onto the existing public contract.
 * Unknown properties (including any paths/content) never leave the parser. */
export function parseCcbContextObservation(raw: unknown): ContextObservation | null {
  if (!raw || typeof raw !== 'object') return null
  const event = raw as Record<string, unknown>
  if (event.kind === 'context_pressure' && Value.Check(ContextPressure, event.pressure)) {
    const { engine, scope, dimension, level, usedRatio } = event.pressure
    if (engine !== 'claude-code' || scope !== 'native_context' || dimension !== 'transport_bytes') return null
    return { kind: 'context_pressure', pressure: { engine, scope, dimension, level, usedRatio } }
  }
  if (event.kind === 'context_compacted' && Value.Check(ContextCompaction, event.compaction)) {
    const { engine, scope, strategy, beforeBytes, afterBytes, droppedEntries } = event.compaction
    if (engine !== 'claude-code' || scope !== 'native_context' || strategy !== 'file_reference' || droppedEntries !== 0) return null
    return { kind: 'context_compacted', compaction: { engine, scope, strategy, beforeBytes, afterBytes, droppedEntries } }
  }
  return null
}
