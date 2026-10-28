import type { OutboundMessage, SessionContextPressure, SysContextCompacted } from '@openclaude/protocol'
import type { EngineContentEvent } from './engine/engineEvents.js'
import { _inheritOutboundRouting } from './turnFrames.js'

type ContextObservation = Extract<EngineContentEvent, { kind: 'context_pressure' | 'context_compacted' }>

export function buildContextObservationFrame(
  out: OutboundMessage & { _userId?: string },
  agentId: string,
  event: ContextObservation,
): (SessionContextPressure | SysContextCompacted) & { _userId?: string } {
  const routing = { ..._inheritOutboundRouting(out), agentId }
  return event.kind === 'context_pressure'
    ? { ...routing, type: 'session.context_pressure', ...event.pressure }
    : { ...routing, type: 'sys.context_compacted', ...event.compaction }
}
