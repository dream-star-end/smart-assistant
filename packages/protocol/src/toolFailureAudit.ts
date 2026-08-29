/** Privacy-safe categories shared by the container reporter and commercial master. */
export const TOOL_FAILURE_ERROR_CLASSES_V4 = [
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

/** Schema v5 adds three classes. Frozen: do not add a fourth in this change. */
export const V5_ONLY_ERROR_CLASSES = ['empty_output', 'task_not_found', 'task_dead'] as const

export const TOOL_FAILURE_ERROR_CLASSES = [
  ...TOOL_FAILURE_ERROR_CLASSES_V4,
  ...V5_ONLY_ERROR_CLASSES,
] as const

export type ToolFailureErrorClass = (typeof TOOL_FAILURE_ERROR_CLASSES)[number]
export type ToolFailureErrorClassV4 = (typeof TOOL_FAILURE_ERROR_CLASSES_V4)[number]

const TOOL_FAILURE_ERROR_CLASS_SET = new Set<string>(TOOL_FAILURE_ERROR_CLASSES)
const TOOL_FAILURE_ERROR_CLASS_V4_SET = new Set<string>(TOOL_FAILURE_ERROR_CLASSES_V4)

export function isToolFailureErrorClass(value: unknown): value is ToolFailureErrorClass {
  return typeof value === 'string' && TOOL_FAILURE_ERROR_CLASS_SET.has(value)
}

export function isLegacyToolFailureErrorClass(value: unknown): value is ToolFailureErrorClassV4 {
  return typeof value === 'string' && TOOL_FAILURE_ERROR_CLASS_V4_SET.has(value)
}

export function projectClassToLegacy(errorClass: ToolFailureErrorClass): ToolFailureErrorClassV4 {
  return (V5_ONLY_ERROR_CLASSES as readonly string[]).includes(errorClass)
    ? 'other'
    : (errorClass as ToolFailureErrorClassV4)
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
  if (errorClass === 'other' || errorClass === 'empty_output') return 'unknown'
  return 'tool_error'
}

function classifyToolFailureText(value: string | undefined): ToolFailureErrorClass {
  if (!value?.trim()) return 'empty_output'
  if (
    /^TaskOutput: empty failed output task_id=\S+ engine=(cursor|grok) status=\S+$/i.test(value)
  ) {
    return 'empty_output'
  }
  if (
    /^No task found with ID: /i.test(value) ||
    /task (id )?(not found|does not exist)|unknown task/i.test(value)
  ) {
    return 'task_not_found'
  }
  if (
    /task (already )?(killed|exited|gone)\b/i.test(value) ||
    /^task \S+ already (completed|failed|killed|error)\b/i.test(value)
  ) {
    return 'task_dead'
  }
  const text = value.toLowerCase()
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
  if (errorClass === 'empty_output') {
    return { errorClass: 'empty_output', failureKind: 'unknown' }
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
 * Callers may hash the raw preview for exact grouping. Persist only the
 * allowlist short template or sentinel from `sanitizeToolFailureErrorMsg`.
 */
export function classifyToolFailureError(value: string | undefined): ToolFailureErrorClass {
  return classifyToolFailure({ outputPreview: value }).errorClass
}

export const TOOL_FAILURE_ERROR_MSG_MAX_CODE_POINTS = 240
export const TOOL_FAILURE_TRUNCATION_MARK = '…[truncated]'
export const TOOL_FAILED_EMPTY_SENTINEL = 'tool_failed:empty_output'
export const TOOL_FAILED_REDACTED_SENTINEL = 'tool_failed:redacted_output'

export type RedactedReason = 'empty' | 'unmatched_template' | 'secret_pattern' | 'sanitize_uncertain'

export const REDACTED_REASONS = [
  'empty',
  'unmatched_template',
  'secret_pattern',
  'sanitize_uncertain',
] as const

export function isRedactedReason(value: unknown): value is RedactedReason {
  return typeof value === 'string' && (REDACTED_REASONS as readonly string[]).includes(value)
}

export function codePointLength(value: string): number {
  return Array.from(value).length
}

export function truncateCodePoints(value: string, max = TOOL_FAILURE_ERROR_MSG_MAX_CODE_POINTS): string {
  const cps = Array.from(value)
  if (cps.length <= max) return value
  const mark = Array.from(TOOL_FAILURE_TRUNCATION_MARK)
  const keep = Math.max(0, max - mark.length)
  return cps.slice(0, keep).join('') + TOOL_FAILURE_TRUNCATION_MARK
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
}

const SECRET_RULES: Array<{ re: RegExp; replace: string | ((match: string, ...args: string[]) => string) }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/i, replace: '[redacted]' },
  { re: /-----BEGIN [A-Z ]+-----[\s\S]*$/i, replace: '[redacted]' },
  { re: /Authorization:\s+\S+(?:\s+\S+)*/i, replace: 'Authorization:[redacted]' },
  { re: /\bbearer\s+\S+/gi, replace: '[redacted]' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[redacted]' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: '[redacted]' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, replace: '[redacted]' },
  { re: /sk-[A-Za-z0-9._-]{8,}/g, replace: '[redacted]' },
  { re: /xai-[A-Za-z0-9._-]{8,}/g, replace: '[redacted]' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[redacted]' },
  { re: /AKIA[A-Z0-9]{16}/g, replace: '[redacted]' },
  { re: /postgres(?:ql)?:\/\/\S+/gi, replace: '[redacted]' },
  {
    re: /(password|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
    replace: (_match, name: string) => `${name}=[redacted]`,
  },
]

const HOME_PATH_RE = /\/home\/[^/\s]+/g

const ALLOWED_ERROR_TEMPLATES: RegExp[] = [
  /^tool_failed:(empty_output|redacted_output)$/,
  /unknown skill/i,
  /command not found|not recognized as (?:an internal|a) command/i,
  /cannot execute|not executable/i,
  /old_string.*not found|string to replace.*not found|file (?:was|has been) modified/i,
  /\benoent\b|no such file or directory|cannot find (?:the )?(?:file|path)/i,
  /\beacces\b|permission denied|operation not permitted/i,
  /timed? out|timeout|deadline exceeded/i,
  /\babort(?:ed)?\b|cancelled|canceled/i,
  /too many requests|rate.?limit|\bhttp\s*429\b|\bstatus\s*429\b/i,
  /service unavailable|bad gateway|\bhttp\s*50[23]\b/i,
  /\beconn(?:refused|reset|aborted)\b|\benotfound\b|network error|fetch failed|socket hang up|\bdns\b/i,
  /validation|invalid (?:input|argument|request)|schema error|bad request/i,
  /^No task found with ID: \S+/i,
  /^task \S+ already (completed|failed|killed|error)\b/i,
  /^TaskOutput: empty failed output task_id=\S+ engine=(cursor|grok) status=\S+$/i,
  /<retrieval_status>(not_found|already_terminal|timeout)<\/retrieval_status>/i,
]

function detectSecretBeforeRedaction(text: string): boolean {
  return SECRET_RULES.some((rule) => {
    rule.re.lastIndex = 0
    return rule.re.test(text)
  })
}

function applyOrderedRedaction(text: string): string {
  let next = text
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0
    next = next.replace(rule.re, rule.replace as (substring: string, ...args: string[]) => string)
  }
  return next.replace(HOME_PATH_RE, '/home/[user]')
}

function stillLooksSecret(text: string): boolean {
  return (
    /BEGIN /i.test(text) ||
    /bearer /i.test(text) ||
    /sk-/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text) ||
    /[A-Za-z0-9+/=]{40,}/.test(text)
  )
}

function matchesAllowedErrorTemplate(text: string): boolean {
  return ALLOWED_ERROR_TEMPLATES.some((re) => re.test(text))
}

export function synthesizeEmptyFailedToolPreview(args: {
  toolName: string
  engine: 'cursor' | 'grok'
  taskId?: string
  status?: string
}): string {
  if (args.toolName === 'TaskOutput') {
    const taskId = args.taskId?.trim() || 'unknown'
    const status = args.status?.trim() || 'failed'
    return `TaskOutput: empty failed output task_id=${taskId} engine=${args.engine} status=${status}`
  }
  return TOOL_FAILED_EMPTY_SENTINEL
}

export function sanitizeToolFailureErrorMsg(raw: string | undefined): {
  errorMsg: string
  redactedReason?: RedactedReason
} {
  try {
    if (!raw || !raw.trim()) {
      return { errorMsg: TOOL_FAILED_EMPTY_SENTINEL, redactedReason: 'empty' }
    }
    let text = stripAnsi(raw).replace(/\s+/g, ' ').trim()
    const hadSecret = detectSecretBeforeRedaction(text)
    text = applyOrderedRedaction(text)
    if (stillLooksSecret(text)) {
      return { errorMsg: TOOL_FAILED_REDACTED_SENTINEL, redactedReason: 'secret_pattern' }
    }
    if (!matchesAllowedErrorTemplate(text)) {
      return { errorMsg: TOOL_FAILED_REDACTED_SENTINEL, redactedReason: 'unmatched_template' }
    }
    const errorMsg = truncateCodePoints(text, TOOL_FAILURE_ERROR_MSG_MAX_CODE_POINTS)
    return hadSecret ? { errorMsg, redactedReason: 'secret_pattern' } : { errorMsg }
  } catch {
    return { errorMsg: TOOL_FAILED_REDACTED_SENTINEL, redactedReason: 'sanitize_uncertain' }
  }
}
