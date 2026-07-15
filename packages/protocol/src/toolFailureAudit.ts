/** Privacy-safe categories shared by the container reporter and commercial master. */
export const TOOL_FAILURE_ERROR_CLASSES = [
  'unknown_skill',
  'command_not_found',
  'not_executable',
  'file_not_found',
  'permission_denied',
  'edit_conflict',
  'timeout',
  'cancelled',
  'validation_error',
  'rate_limited',
  'service_unavailable',
  'network_error',
  'process_exit',
  'other',
] as const

export type ToolFailureErrorClass = (typeof TOOL_FAILURE_ERROR_CLASSES)[number]

const TOOL_FAILURE_ERROR_CLASS_SET = new Set<string>(TOOL_FAILURE_ERROR_CLASSES)

export function isToolFailureErrorClass(value: unknown): value is ToolFailureErrorClass {
  return typeof value === 'string' && TOOL_FAILURE_ERROR_CLASS_SET.has(value)
}

export const TOOL_FAILURE_KINDS = [
  'process_exit',
  'timeout',
  'cancelled',
  'tool_error',
  'external',
  'unknown',
] as const

export type ToolFailureKind = (typeof TOOL_FAILURE_KINDS)[number]

const TOOL_FAILURE_KIND_SET = new Set<string>(TOOL_FAILURE_KINDS)

export function isToolFailureKind(value: unknown): value is ToolFailureKind {
  return typeof value === 'string' && TOOL_FAILURE_KIND_SET.has(value)
}

export const TOOL_TERMINATION_REASONS = [
  'exit_code',
  'timeout',
  'cancelled',
  'signal',
  'tool_error',
  'unknown',
] as const

export type ToolTerminationReason = (typeof TOOL_TERMINATION_REASONS)[number]

const TOOL_TERMINATION_REASON_SET = new Set<string>(TOOL_TERMINATION_REASONS)

export function isToolTerminationReason(value: unknown): value is ToolTerminationReason {
  return typeof value === 'string' && TOOL_TERMINATION_REASON_SET.has(value)
}

export function isToolExitCode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255
}

export interface ToolFailureClassification {
  errorClass: ToolFailureErrorClass
  failureKind: ToolFailureKind
}

function kindForClass(errorClass: ToolFailureErrorClass): ToolFailureKind {
  if (errorClass === 'timeout') return 'timeout'
  if (errorClass === 'cancelled') return 'cancelled'
  if (
    errorClass === 'command_not_found' ||
    errorClass === 'not_executable' ||
    errorClass === 'process_exit'
  )
    return 'process_exit'
  if (
    errorClass === 'rate_limited' ||
    errorClass === 'service_unavailable' ||
    errorClass === 'network_error'
  )
    return 'external'
  if (errorClass === 'other') return 'unknown'
  return 'tool_error'
}

function classifyToolFailureText(value: string | undefined): ToolFailureErrorClass {
  const text = value?.toLowerCase() ?? ''
  if (/unknown skill/.test(text)) return 'unknown_skill'
  if (/command not found|not recognized as (?:an internal|a) command/.test(text)) {
    return 'command_not_found'
  }
  if (/cannot execute|not executable/.test(text)) return 'not_executable'
  if (
    /old_string.*not found|string to replace.*not found|file (?:was|has been) modified/.test(text)
  ) {
    return 'edit_conflict'
  }
  if (/\benoent\b|no such file or directory|cannot find (?:the )?(?:file|path)/.test(text)) {
    return 'file_not_found'
  }
  if (/\beacces\b|permission denied|operation not permitted/.test(text)) {
    return 'permission_denied'
  }
  if (/timed? out|timeout|deadline exceeded/.test(text)) return 'timeout'
  if (/\babort(?:ed)?\b|cancelled|canceled/.test(text)) return 'cancelled'
  if (/too many requests|rate.?limit|\bhttp\s*429\b|\bstatus\s*429\b/.test(text)) {
    return 'rate_limited'
  }
  if (/service unavailable|bad gateway|\bhttp\s*50[23]\b|\bstatus\s*50[23]\b/.test(text)) {
    return 'service_unavailable'
  }
  if (
    /\beconn(?:refused|reset|aborted)\b|\benotfound\b|network error|fetch failed|socket hang up|\bdns\b/.test(
      text,
    )
  ) {
    return 'network_error'
  }
  if (/validation|invalid (?:input|argument|request)|schema error|bad request/.test(text)) {
    return 'validation_error'
  }
  return 'other'
}

/**
 * Single privacy-safe failure classifier. Engine-authored termination metadata
 * fixes the failure kind; bounded text heuristics only refine the error class
 * where the engine supplies no more specific class. Callers must leave
 * structured fields undefined when their engine does not expose them.
 */
export function classifyToolFailure(input: {
  outputPreview?: string
  exitCode?: number
  terminationReason?: ToolTerminationReason
}): ToolFailureClassification {
  if (input.terminationReason === 'timeout') {
    return { errorClass: 'timeout', failureKind: 'timeout' }
  }
  if (input.terminationReason === 'cancelled') {
    return { errorClass: 'cancelled', failureKind: 'cancelled' }
  }
  if (input.terminationReason === 'signal') {
    return { errorClass: 'process_exit', failureKind: 'process_exit' }
  }
  if (isToolExitCode(input.exitCode) && input.exitCode !== 0) {
    if (input.exitCode === 127) {
      return { errorClass: 'command_not_found', failureKind: 'process_exit' }
    }
    if (input.exitCode === 126) {
      return { errorClass: 'not_executable', failureKind: 'process_exit' }
    }
    return { errorClass: 'process_exit', failureKind: 'process_exit' }
  }
  const errorClass = classifyToolFailureText(input.outputPreview)
  if (input.terminationReason === 'exit_code') {
    return { errorClass: 'process_exit', failureKind: 'process_exit' }
  }
  if (input.terminationReason === 'tool_error') {
    return { errorClass, failureKind: 'tool_error' }
  }
  if (input.terminationReason === 'unknown') {
    return { errorClass, failureKind: 'unknown' }
  }
  return { errorClass, failureKind: kindForClass(errorClass) }
}

/**
 * Reduce a raw tool error to a bounded, non-sensitive operational category.
 * Callers may hash the raw preview for exact grouping, but must never persist it.
 */
export function classifyToolFailureError(value: string | undefined): ToolFailureErrorClass {
  return classifyToolFailure({ outputPreview: value }).errorClass
}
