/**
 * Which trace id an HTTP request carries (phase 3 plan v3.6 §7.1, OCV5-564).
 *
 * - The header is `x-openclaude-trace-id` (protocol TRACE_ID_HEADER, shared with Go node-agent and
 *   its contract cases). `x-trace-id` is accepted as an alias for one release cycle (smoke-v3.sh and
 *   older callers send it); when both are present the canonical header wins.
 * - Without a valid header the router still binds a generated id under `traceId` for one release
 *   cycle (old log readers expect the key), marked `traceIdOrigin: "generated"` so it is never
 *   mistaken for a turn trace. After that cycle only header-provided ids are bound; the request
 *   itself is identified by `requestId` (x-request-id).
 */
import type { IncomingHttpHeaders } from 'node:http'
import { TRACE_ID_HEADER, newTraceId, parseTraceIdCandidate } from '@openclaude/protocol'

export const LEGACY_TRACE_ID_HEADER = 'x-trace-id'

export type TraceIdOrigin = 'header' | 'legacy-header' | 'generated'

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function resolveRequestTrace(headers: IncomingHttpHeaders): {
  traceId: string
  traceIdOrigin: TraceIdOrigin
} {
  const canonical = parseTraceIdCandidate(first(headers[TRACE_ID_HEADER]))
  if (canonical.ok) return { traceId: canonical.traceId, traceIdOrigin: 'header' }
  const legacy = parseTraceIdCandidate(first(headers[LEGACY_TRACE_ID_HEADER]))
  if (legacy.ok) return { traceId: legacy.traceId, traceIdOrigin: 'legacy-header' }
  return { traceId: newTraceId(), traceIdOrigin: 'generated' }
}
