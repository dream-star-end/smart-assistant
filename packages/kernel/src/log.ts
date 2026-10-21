/**
 * The one logger factory (phase 3 plan v3.6 §3.6 `log`, §7.8).
 *
 * - One JSON object per line; `ts`, `level` and `msg` are written last so no field can forge them.
 * - One signature for both former loggers: `log.info(msg, fields?, error?)` covers commercial's
 *   `(msg, fields)` and the gateway's `(msg, ctx, err)`; the old factories become thin wrappers.
 * - Every field, binding and error goes through `redact` (credential keys always; payload keys by
 *   this logger's policy; free text scanned; depth/length/key caps).
 * - The current trace context (from `kernel/node`'s AsyncLocalStorage, or any provider) is added
 *   automatically; explicit fields win.
 * - Levels can change at runtime: every logger reads a shared `LevelRef`.
 *
 * Zero dependencies and no `node:*`: the sink is injected (`kernel/node` provides stdout/stderr).
 */
import { type RedactLimits, type RedactPolicy, type Redactor, createRedactor } from './redact.js'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']
const RANK: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 }

export type Fields = Record<string, unknown>

/** `undefined`, empty or unknown → `fallback`. Case-insensitive; `warning` → `warn`. */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const v = raw?.trim().toLowerCase()
  if (v === 'warning') return 'warn'
  return (LOG_LEVELS as readonly string[]).includes(v ?? '') ? (v as LogLevel) : fallback
}

/** A level that can be changed while the process runs; all loggers created with it follow. */
export interface LevelRef {
  get(): LogLevel
  set(level: LogLevel): void
}

export function createLevelRef(initial: LogLevel = 'info'): LevelRef {
  let current = initial
  return {
    get: () => current,
    set: (l) => {
      if (!(l in RANK)) throw new TypeError(`unknown log level ${JSON.stringify(l)}`)
      current = l
    },
  }
}

export interface LogRecord {
  level: LogLevel
  line: string
}

export interface LoggerOptions {
  /** Where lines go. Required: kernel core does no I/O (see kernel/node's `stdSink`). */
  sink: (record: LogRecord) => void
  /** Shared, runtime-changeable level (default: a fresh ref at `info`). */
  level?: LevelRef
  /** Bound fields on every line (redacted once). */
  base?: Fields
  /** Payload policy and extra keys for this logger (credential keys are always redacted). */
  redact?: RedactPolicy
  limits?: Partial<RedactLimits>
  /** Trace context of the current async flow (kernel/node: `currentTraceFields`). */
  context?: () => Fields | undefined
  now?: () => string
}

export interface Logger {
  trace(msg: string, fields?: Fields, error?: unknown): void
  debug(msg: string, fields?: Fields, error?: unknown): void
  info(msg: string, fields?: Fields, error?: unknown): void
  warn(msg: string, fields?: Fields, error?: unknown): void
  error(msg: string, fields?: Fields, error?: unknown): void
  /** A logger whose lines also carry `bindings` (redacted once; child keys win). */
  child(bindings: Fields): Logger
  isLevelEnabled(level: LogLevel): boolean
}

const RESERVED = new Set(['ts', 'level', 'msg'])

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj)
  } catch {
    // redact() already removed cycles and BigInt; this only guards exotic toJSON throwers
    return JSON.stringify({ msg: '<unserializable log record>' })
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? createLevelRef()
  const r: Redactor = createRedactor(opts.redact, opts.limits)
  const now = opts.now ?? (() => new Date().toISOString())
  const make = (base: Fields): Logger => {
    const emit = (lvl: LogLevel, msg: string, fields?: Fields, error?: unknown) => {
      if (RANK[lvl] < RANK[level.get()]) return
      try {
        const ctx = opts.context?.()
        const entry: Fields = {}
        const put = (src: Fields | undefined) => {
          if (!src) return
          for (const [k, v] of Object.entries(src))
            if (v !== undefined && !RESERVED.has(k)) entry[k] = v
        }
        put(ctx ? (r(ctx) as Fields) : undefined)
        put(base)
        put(fields ? (r(fields) as Fields) : undefined)
        if (error !== undefined) {
          const e = r(error)
          // only an Error is flattened into error/errorCode/stack/cause; anything else (a string, a
          // plain object, a rejected value) is kept as `error`, redacted
          if (error instanceof Error && e && typeof e === 'object' && !Array.isArray(e)) {
            const ef = e as Fields
            entry.error = ef.message ?? ef.name
            if (ef.code !== undefined) entry.errorCode = ef.code
            if (ef.stack !== undefined) entry.stack = ef.stack
            if (ef.cause !== undefined) entry.cause = ef.cause
            if (ef.details !== undefined) entry.errorDetails = ef.details
          } else entry.error = e
        }
        entry.ts = now()
        entry.level = lvl
        entry.msg = r(String(msg))
        opts.sink({ level: lvl, line: safeStringify(entry) })
      } catch {
        // a log call never throws into the caller
      }
    }
    return {
      trace: (m, f, e) => emit('trace', m, f, e),
      debug: (m, f, e) => emit('debug', m, f, e),
      info: (m, f, e) => emit('info', m, f, e),
      warn: (m, f, e) => emit('warn', m, f, e),
      error: (m, f, e) => emit('error', m, f, e),
      child: (bindings) => make({ ...base, ...(r(bindings) as Fields) }),
      isLevelEnabled: (l) => RANK[l] >= RANK[level.get()],
    }
  }
  return make(opts.base ? (r(opts.base) as Fields) : {})
}
