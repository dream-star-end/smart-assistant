/**
 * Cursor CLI stderr/result text → tape-safe + log-safe detail.
 * Keeps the first-line root cause (e.g. Sand traffic is not supported) while
 * stripping secrets, absolute paths, and likely user content.
 */

const CURSOR_CLI_FAILURE_PREFIX = 'Cursor CLI failed'
export const CURSOR_CLI_FAILURE_DETAIL_MAX = 200
export const CURSOR_CLI_FAILURE_LOG_MAX = 2000

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

const ABSOLUTE_PATH_RE =
  /(?:file:\/\/)?(?:\/(?:home|opt|usr|var|tmp|root|Users|private|mnt|data)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+|\\\\[^\s"'`]+)/g

const USER_CONTENT_RULES: RegExp[] = [
  /<user\b[^>]*>[\s\S]*?<\/user>/gi,
  /(?:"(?:prompt|text|content|message|input)"\s*:\s*")((?:\\.|[^"\\]){40,})"/gi,
  /(?:prompt|user(?:[\s_-]*message)?)\s*[:=]\s*("[^"]{40,}"|'[^']{40,}')/gi,
]

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
}

function firstLine(value: string): string {
  const nl = value.search(/\r\n|\n|\r/)
  return (nl < 0 ? value : value.slice(0, nl)).trim()
}

function applySecrets(text: string): string {
  let next = text
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0
    next = next.replace(rule.re, rule.replace as (substring: string, ...args: string[]) => string)
  }
  return next
}

function stripUserContent(text: string): string {
  let next = text
  for (const re of USER_CONTENT_RULES) {
    re.lastIndex = 0
    next = next.replace(re, '[user]')
  }
  return next.replace(/"[^"]{80,}"/g, '"[user]"')
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return '…'
  return `${value.slice(0, max - 1)}…`
}

/** First-line CLI error with secrets/paths/user content removed. No length cap. */
export function sanitizeCursorCliError(raw: string): string {
  let text = firstLine(stripAnsi(String(raw ?? '')))
  if (!text) return ''
  text = applySecrets(text)
  text = text.replace(ABSOLUTE_PATH_RE, '[path]')
  text = stripUserContent(text)
  return text.replace(/\s+/g, ' ').trim()
}

export function formatCursorCliFailureDetail(raw: string): string {
  const sanitized = sanitizeCursorCliError(raw)
  const body = sanitized ? `${CURSOR_CLI_FAILURE_PREFIX}: ${sanitized}` : CURSOR_CLI_FAILURE_PREFIX
  return truncateChars(body, CURSOR_CLI_FAILURE_DETAIL_MAX)
}

export function formatCursorCliFailureLog(raw: string): string {
  const sanitized = sanitizeCursorCliError(raw)
  const body = sanitized ? `${CURSOR_CLI_FAILURE_PREFIX}: ${sanitized}` : CURSOR_CLI_FAILURE_PREFIX
  return truncateChars(body, CURSOR_CLI_FAILURE_LOG_MAX)
}
