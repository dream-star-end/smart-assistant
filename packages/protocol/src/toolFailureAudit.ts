/** Privacy-safe categories shared by the container reporter and commercial master. */
export const TOOL_FAILURE_ERROR_CLASSES = [
  'unknown_skill',
  'command_not_found',
  'file_not_found',
  'permission_denied',
  'timeout',
  'cancelled',
  'validation_error',
  'rate_limited',
  'service_unavailable',
  'network_error',
  'other',
] as const

export type ToolFailureErrorClass = (typeof TOOL_FAILURE_ERROR_CLASSES)[number]

const TOOL_FAILURE_ERROR_CLASS_SET = new Set<string>(TOOL_FAILURE_ERROR_CLASSES)

export function isToolFailureErrorClass(value: unknown): value is ToolFailureErrorClass {
  return typeof value === 'string' && TOOL_FAILURE_ERROR_CLASS_SET.has(value)
}

/**
 * Reduce a raw tool error to a bounded, non-sensitive operational category.
 * Callers may hash the raw preview for exact grouping, but must never persist it.
 */
export function classifyToolFailureError(value: string | undefined): ToolFailureErrorClass {
  const text = value?.toLowerCase() ?? ''
  if (/unknown skill/.test(text)) return 'unknown_skill'
  if (/command not found|not recognized as (?:an internal|a) command/.test(text)) {
    return 'command_not_found'
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
