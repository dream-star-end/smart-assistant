/**
 * OpenClaude per-turn telemetry emitter.
 *
 * Writes `_oc_telemetry` ndjson lines to stdout so the OpenClaude gateway
 * (subprocessRunner) can tee them into TelemetryChannel and correlate them
 * with the CCB result row. See docs/ccb-telemetry-refactor-plan.md for the
 * R1–R9 design rules and event schema.
 *
 * Diagnostic-only:
 *   - No CCB production code reads `getDiagnostics()` or branches on emit
 *     success / failure.
 *   - All emits are best-effort, wrapped in try/catch, and silently dropped
 *     when the emitter is not configured, the output-format gate is not met,
 *     or the env kill-switch is set.
 */
import { ndjsonSafeStringify } from '../cli/ndjsonSafeStringify'

const DISABLED = process.env.OC_TELEMETRY_DISABLED === '1' // R9 kill-switch
const SCHEMA_VERSION = 1
const MAX_FIELD_BYTES = 1024
const MAX_ARRAY_LEN = 50
const MAX_EVENT_BYTES = 8192

export type Sink = (line: string) => void

interface ConfigureOptions {
  outputFormat?: string
  verbose?: boolean
  sink?: Sink
  sessionIdProvider?: () => string | undefined
}

let sink: Sink | null = null
let outputFormat: string | undefined
let verbose = false
let getSessionId: () => string | undefined = () => undefined
let droppedCount = 0
let emittedCount = 0
let sinkErrorCount = 0

export function configureTelemetry(opts: ConfigureOptions): void {
  outputFormat = opts.outputFormat
  verbose = !!opts.verbose
  if (opts.sink) {
    sink = opts.sink
  } else {
    sink = (line: string) => {
      process.stdout.write(line)
    }
  }
  if (opts.sessionIdProvider) getSessionId = opts.sessionIdProvider
}

export function getDiagnostics(): {
  droppedCount: number
  emittedCount: number
  sinkErrorCount: number
  configured: boolean
} {
  return {
    droppedCount,
    emittedCount,
    sinkErrorCount,
    configured: sink !== null,
  }
}

/** R1: emission failures never propagate; R5: only emit in stream-json+verbose; R9 env kill-switch. */
export function emit(event: string, data: Record<string, unknown> = {}): void {
  if (DISABLED) return
  if (outputFormat !== 'stream-json' || !verbose) return
  if (!sink) return // configureTelemetry has not run yet (early phase)
  try {
    const sanitized = sanitizeData(data)
    const payload = {
      type: '_oc_telemetry',
      schemaVersion: SCHEMA_VERSION,
      event,
      session_id: getSessionId(),
      data: sanitized,
      ts: Date.now(),
    }
    const json = ndjsonSafeStringify(payload)
    if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) {
      droppedCount++
      return
    }
    try {
      sink(`${json}\n`)
      emittedCount++
    } catch {
      sinkErrorCount++
    }
  } catch {
    // Serialization / sanitization threw before sink was invoked — do not
    // inflate emittedCount. Count as sinkError for diagnostics parity.
    sinkErrorCount++
  }
}

function sanitizeData(input: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated:depth]'
  if (input === null || input === undefined) return input
  if (typeof input === 'string') {
    return Buffer.byteLength(input, 'utf8') > MAX_FIELD_BYTES
      ? `${input.slice(0, Math.floor(MAX_FIELD_BYTES / 4))}…[truncated]`
      : input
  }
  if (typeof input === 'number' || typeof input === 'boolean') return input
  if (Array.isArray(input)) {
    const truncated = input.length > MAX_ARRAY_LEN
    const arr = input.slice(0, MAX_ARRAY_LEN).map((v) => sanitizeData(v, depth + 1))
    if (truncated) (arr as unknown as { _truncatedFromN: number })._truncatedFromN = input.length
    return arr
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(input as Record<string, unknown>)) {
      out[k] = sanitizeData((input as Record<string, unknown>)[k], depth + 1)
    }
    return out
  }
  return undefined // function / symbol / etc. dropped
}

/** Test-only: reset internal state between test cases. */
export function _resetForTests(): void {
  sink = null
  outputFormat = undefined
  verbose = false
  getSessionId = () => undefined
  droppedCount = 0
  emittedCount = 0
  sinkErrorCount = 0
}
