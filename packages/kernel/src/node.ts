/**
 * @openclaude/kernel/node: the part of the kernel that needs node:* (phase 3 plan v3.6 §3.1).
 *
 * - `withTrace` / `currentTrace`: the trace context of the current async flow (AsyncLocalStorage).
 *   Nested `withTrace` merges onto the outer context. Measured on Node 20 (OCV5-560,
 *   scripts/arch-measure/als-overhead.mjs): 3–4.5 % CPU on turn-path-shaped work, above the 1 % budget
 *   of plan §11.1, so the master turn path passes trace fields explicitly (child loggers) instead.
 *   Re-measure after moving to Node >= 24 (AsyncContextFrame).
 * - `stdSink`: warn/error to stderr, the rest to stdout (the gateway's split; commercial wrote
 *   everything to stdout and keeps doing so through its own sink).
 * - `createNodeLogger`: createLogger with these two wired in.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { type LogRecord, type Logger, type LoggerOptions, createLogger } from './log.js'
import { type TraceContext, traceFields } from './trace.js'

export const KERNEL_NODE_ENTRY = '@openclaude/kernel/node'

const store = new AsyncLocalStorage<TraceContext>()

/** Run `fn` with `ctx` as the current trace context (merged onto an enclosing one). */
export function withTrace<T>(ctx: TraceContext, fn: () => T): T {
  const outer = store.getStore()
  return store.run(outer ? { ...outer, ...ctx } : ctx, fn)
}

export function currentTrace(): TraceContext | undefined {
  return store.getStore()
}

/** The current trace context as log fields (the `context` provider for createLogger). */
export function currentTraceFields(): Record<string, unknown> | undefined {
  return traceFields(store.getStore())
}

export function stdSink(record: LogRecord): void {
  const stream =
    record.level === 'warn' || record.level === 'error' ? process.stderr : process.stdout
  stream.write(`${record.line}\n`)
}

/** createLogger with the std sink and the ALS trace context, unless the caller passes its own. */
export function createNodeLogger(opts: Partial<LoggerOptions> = {}): Logger {
  return createLogger({ sink: stdSink, context: currentTraceFields, ...opts })
}
