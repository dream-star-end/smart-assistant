/**
 * @openclaude/kernel: L1 core (phase 3 plan v3.6 §3.1, §3.6). Zero-dependency mechanisms that every
 * server-side process shares. No `node:*` here; the Node-specific parts (AsyncLocalStorage, the
 * stdout/stderr sink) are in `@openclaude/kernel/node`.
 */
export const KERNEL_PACKAGE = '@openclaude/kernel'

export { REDACTED, createRedactor, isCredentialKey, redact, redactText } from './redact.js'
export type { RedactLimits, RedactPolicy, Redactor } from './redact.js'
export { AppError, errorCode, isAppError } from './errors.js'
export {
  LOG_LEVELS,
  createLevelRef,
  createLogger,
  parseLogLevel,
  registerLevelRef,
  registeredLogLevels,
  resetLogLevels,
  setLogLevels,
} from './log.js'
export type { Fields, LevelRef, LogLevel, LogRecord, Logger, LoggerOptions } from './log.js'
export { traceFields } from './trace.js'
export type { TraceContext } from './trace.js'
