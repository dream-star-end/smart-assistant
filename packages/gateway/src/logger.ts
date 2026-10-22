/**
 * Structured JSON logger for the OpenClaude gateway: a thin wrapper over @openclaude/kernel's
 * logger (phase 3 plan v3.6 P1, §7.8; OCV5-550). The signature is unchanged, `(msg, ctx?, err?)`,
 * and so are the stdout/stderr split and the log-write timing.
 *
 * What the kernel adds: credential keys (token, password, cookie, authorization, apiKey, …) are
 * redacted at any depth, and free text (messages, string fields, error message and stack) is scanned
 * for credentials, e-mail addresses and phone numbers. Payload keys (body, content, text, …) are
 * not redacted here: the gateway's normal diagnostics stay. Errors also carry errorCode / cause.
 */

import {
  type Logger as KernelLogger,
  createLogger as createKernelLogger,
  createLevelRef,
  parseLogLevel,
  registerLevelRef,
} from '@openclaude/kernel'
import { measureLogWrite } from '@openclaude/protocol'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  module?: string
  traceId?: string
  agentId?: string
  sessionKey?: string
  [key: string]: unknown
}

/** Minimum level: OPENCLAUDE_LOG_LEVEL at start (default info); changeable while running. */
export const gatewayLogLevel = createLevelRef(parseLogLevel(process.env.OPENCLAUDE_LOG_LEVEL))
registerLevelRef('gateway', gatewayLogLevel)

const root: KernelLogger = createKernelLogger({
  level: gatewayLogLevel,
  sink: ({ level, line }) => {
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
    measureLogWrite(() => stream.write(`${line}\n`), Buffer.byteLength(line) + 1)
  },
})

/** Create a child logger with preset context fields. */
export function createLogger(baseCtx: LogContext) {
  const l = root.child(baseCtx)
  return {
    debug: (msg: string, ctx?: LogContext) => l.debug(msg, ctx),
    info: (msg: string, ctx?: LogContext) => l.info(msg, ctx),
    warn: (msg: string, ctx?: LogContext, error?: unknown) => l.warn(msg, ctx, error),
    error: (msg: string, ctx?: LogContext, error?: unknown) => l.error(msg, ctx, error),
  }
}

export type Logger = ReturnType<typeof createLogger>

/** Root logger — use createLogger() for module-specific loggers. */
export const log = createLogger({ module: 'gateway' })
