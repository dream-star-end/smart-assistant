/**
 * Structured JSON logger for the OpenClaude gateway.
 *
 * Zero dependencies — writes JSON lines to stdout/stderr.
 * Each log entry carries optional traceId, agentId, sessionKey for correlation.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_NUM: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Minimum log level (configurable via OPENCLAUDE_LOG_LEVEL env) */
const minLevel: number = LEVEL_NUM[(process.env.OPENCLAUDE_LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVEL_NUM.info

export interface LogContext {
  module?: string
  traceId?: string
  agentId?: string
  sessionKey?: string
  [key: string]: unknown
}

function write(level: LogLevel, msg: string, ctx?: LogContext, error?: unknown): void {
  if (LEVEL_NUM[level] < minLevel) return

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  }

  if (ctx) {
    if (ctx.module) entry.module = ctx.module
    if (ctx.traceId) entry.traceId = ctx.traceId
    if (ctx.agentId) entry.agentId = ctx.agentId
    if (ctx.sessionKey) entry.sessionKey = ctx.sessionKey
    // Copy extra fields (skip standard ones already handled)
    for (const [k, v] of Object.entries(ctx)) {
      if (k !== 'module' && k !== 'traceId' && k !== 'agentId' && k !== 'sessionKey' && v !== undefined) {
        entry[k] = v
      }
    }
  }

  if (error instanceof Error) {
    entry.error = error.message
    entry.stack = error.stack
  } else if (error !== undefined) {
    entry.error = String(error)
  }

  const line = JSON.stringify(entry)
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

/** Create a child logger with preset context fields. */
export function createLogger(baseCtx: LogContext) {
  return {
    debug: (msg: string, ctx?: LogContext) => write('debug', msg, { ...baseCtx, ...ctx }),
    info: (msg: string, ctx?: LogContext) => write('info', msg, { ...baseCtx, ...ctx }),
    warn: (msg: string, ctx?: LogContext, error?: unknown) => write('warn', msg, { ...baseCtx, ...ctx }, error),
    error: (msg: string, ctx?: LogContext, error?: unknown) => write('error', msg, { ...baseCtx, ...ctx }, error),
  }
}

export type Logger = ReturnType<typeof createLogger>

/** Root logger — use createLogger() for module-specific loggers. */
export const log = createLogger({ module: 'gateway' })
