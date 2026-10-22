/**
 * The one redaction implementation (phase 3 plan v3.6 §3.6 `redact`, §7.8).
 *
 * - Credential keys are redacted everywhere, always (`token`, `password`, `cookie`, `authorization`,
 *   `apiKey`, `x-api-key`, …). Keys are compared after normalising case and `-`/camelCase to `_`, so
 *   `accessToken`, `Access-Token` and `access_token` are the same key. Counters such as
 *   `input_tokens` or `max_tokens` are not credentials and stay.
 * - Payload keys (`body`, `content`, `text`, `delta`, `system`, `messages`, `prompt`, …) are a
 *   per-logger policy: commercial redacts them today; the gateway keeps its normal diagnostics.
 * - Free text (strings anywhere in the value, `Error.message`, `stack`) is scanned for credential
 *   formats (bearer/basic headers, JWTs, provider key prefixes, URL userinfo, secret query
 *   parameters), e-mail addresses and phone numbers.
 * - Bounded: depth, string length, array length and keys per object are capped; cycles, BigInt,
 *   functions and symbols never throw.
 */

export const REDACTED = '<redacted>'

/** Normalised (snake_case, lower) credential keys: always redacted. */
export const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'secret',
  'secret_hash',
  'secret_key',
  'client_secret',
  'session_secret',
  'jwt_secret',
  'webhook_secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'bearer_token',
  'session_token',
  'csrf_token',
  'container_token',
  'anthropic_auth_token',
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'api_key',
  'apikey',
  'x_api_key',
  'private_key',
  'signing_key',
  'encryption_key',
  'credentials',
  'credential',
])

/** Key suffixes that mark a credential (`github_token`, `db_password`, `stripe_secret`). */
const CREDENTIAL_SUFFIXES = ['_token', '_secret', '_password', '_api_key', '_private_key']

/** Payload keys commercial redacts today (its former SENSITIVE_KEYS minus the credentials above). */
export const PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'prompt_body',
  'prompt_text',
  'messages',
  'system',
  'system_prompt',
  'user_message',
  'assistant_message',
  'raw_request',
  'raw_response',
  'request_body',
  'response_body',
  'body',
  'content',
  'text',
  'delta',
])

export interface RedactPolicy {
  /** Redact PAYLOAD_KEYS too (commercial: yes; gateway: no). Default false. */
  payload?: boolean
  /** Extra normalised keys to redact for this logger. */
  extraKeys?: Iterable<string>
}

export interface RedactLimits {
  /** total values visited per redact() call; the rest becomes '<truncated:nodes>' */
  maxNodes: number
  /** total string characters scanned per redact() call; later strings become '<truncated:size>' */
  maxTotalText: number
  maxDepth: number
  maxString: number
  maxArray: number
  maxKeys: number
}

export const DEFAULT_LIMITS: RedactLimits = {
  maxNodes: 5000,
  maxTotalText: 256 * 1024,
  maxDepth: 8,
  maxString: 8192,
  maxArray: 100,
  maxKeys: 200,
}

/** `accessToken` / `Access-Token` / `access token` → `access_token`. */
export function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase()
}

/**
 * The forms a key is compared in: camelCase split (`accessToken` → `access_token`) and plain
 * lowercase (`passWord` → `password`, `TOKEN` → `token`), both with `-`/space/`.` → `_`. A key
 * matches when either form does, so case-insensitive matching is never lost to the camel split.
 */
function keyForms(key: string): [string, string] {
  return [normalizeKey(key), key.replace(/[-\s.]+/g, '_').toLowerCase()]
}

export function isCredentialKey(key: string): boolean {
  return keyForms(key).some(
    (k) => CREDENTIAL_KEYS.has(k) || CREDENTIAL_SUFFIXES.some((s) => k.endsWith(s)),
  )
}

// Credential keys recognised in free-text `key=value` / `"key": value` pairs: like isCredentialKey,
// any identifier (camelCase, snake_case or kebab-case, up to 40 leading characters) that ends in a
// credential word, so `refreshToken`, `x-api-key` and `db_password` match. The trailing \b keeps
// counters out (`max_tokens`, `token_count`, `tokensEstimate`).
const TEXT_KEYS = `[A-Za-z0-9_-]{0,40}?(?:${[
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'api[_-]?key',
  '(?:private|signing|encryption)[_-]?key',
  'authorization',
  'credentials?',
  'cookie',
].join('|')})`

// Order matters: specific formats first, then the generic ones.
// Cost model: every scan runs over at most maxString + SCAN_MARGIN characters (redactText cuts
// first), so worst-case cost is bounded whatever the input length. Within that, only structural
// prefixes are length-bounded (URL scheme, e-mail parts as the RFCs allow, whitespace); credential
// VALUES never are, so a long token cannot slip past a pattern by being long. No pattern has nested
// or overlapping repetition.
const TEXT_PATTERNS: [RegExp, string][] = [
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>'],
  // JWT (three base64url parts, the first two start with eyJ)
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '<redacted:jwt>'],
  // provider keys: sk-…, sk-ant-…, ghp_/gho_/ghs_/github_pat_, xox?-, AKIA…, AIza…
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, '<redacted:key>'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '<redacted:key>'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '<redacted:key>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted:key>'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '<redacted:key>'],
  // URL userinfo: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  // secret-looking query/form parameters
  [
    /([?&;](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|client_secret|password|passwd|sig|signature|auth|code)=)[^&#\s"']+/gi,
    '$1<redacted>',
  ],
  // Cookie / Set-Cookie header values: every pair up to the end of the line (a cookie header is a
  // `;`-separated list, so the generic key=value value would stop after the first pair)
  [/(\b(?:set[-_]?)?cookie\s*:\s*)(?!["'])[^\r\n]+/gi, '$1<redacted>'],
  // key=value / key: value pairs in free text for credential keys, including JSON text
  // ("password":"…"), quoted values with spaces (password="correct horse battery staple") and a
  // quote that is never closed (runs to the end of the scanned text)
  [
    new RegExp(
      `(["']?\\b(?:${TEXT_KEYS})\\b["']?\\s*[=:]\\s*)(?:"(?:[^"\\\\]|\\\\.)*(?:"|$)|'(?:[^'\\\\]|\\\\.)*(?:'|$)|[^\\s"',;&}]+)`,
      'gi',
    ),
    '$1"<redacted>"',
  ],
  // phone: CN mobile (11 digits) and E.164. Alphanumeric boundaries on both sides, so digit runs
  // inside hex ids (trace ids, hashes), longer numbers and epoch milliseconds are left alone.
  [/(?<![0-9A-Za-z.])1[3-9]\d{9}(?![0-9A-Za-z])/g, '<phone>'],
  [/(?<![0-9A-Za-z+])\+\d{1,3}[\s-]?\d{6,14}(?![0-9A-Za-z])/g, '<phone>'],
]

const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isWord = (c: number) => isAlnum(c) || c === 95 // \w
// [A-Za-z0-9._%+-]
const isLocal = (c: number) =>
  isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45
const DOMAIN_AT = /[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/y

/**
 * E-mail addresses → `<email>`, anchored at each `@` instead of trying a local part at every word
 * boundary (that regex form costs ~64 steps per character on text like `a.a.a.…`). Same matches as
 * /\b[A-Za-z0-9._%+-]{1,64}@<domain>\b/: the leftmost local-part start within 64 characters that
 * sits on a word boundary. Linear: each `@` looks at most 64 characters back.
 */
function redactEmails(s: string): string {
  let at = s.indexOf('@')
  if (at < 0) return s
  let out = ''
  let last = 0
  while (at >= 0) {
    let start = at
    while (start > last && at - start < 64 && isLocal(s.charCodeAt(start - 1))) start--
    let p = start
    // \b before p: word-ness differs between s[p-1] (or start of text) and s[p]
    while (p < at && (p > 0 && isWord(s.charCodeAt(p - 1))) === isWord(s.charCodeAt(p))) p++
    let dm: RegExpExecArray | null = null
    if (p < at) {
      DOMAIN_AT.lastIndex = at + 1
      dm = DOMAIN_AT.exec(s)
    }
    if (dm) {
      out += `${s.slice(last, p)}<email>`
      last = at + 1 + dm[0].length
      at = s.indexOf('@', last)
    } else at = s.indexOf('@', at + 1)
  }
  return out + s.slice(last)
}

/** How far past `maxString` a long string is scanned, so a short match crossing the cut is whole. */
const SCAN_MARGIN = 1024

// A credential that runs into the cut (its terminator, e.g. the `@` of URL userinfo, the closing
// quote or a JWT's last part, lies past the scanned text) is redacted from its start to the end of
// the kept head. Each pattern is anchored at the end and starts at a specific prefix.
const DANGLING: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]*$/i, '$1<redacted>'],
  [new RegExp(`(["']?\\b(?:${TEXT_KEYS})\\b["']?\\s*[=:]\\s*)["']?[^"']*$`, 'i'), '$1<redacted>'],
  [/\b(Bearer|Basic)\s+\S*$/i, '$1 <redacted>'],
  [/\beyJ[A-Za-z0-9_.-]*$/, '<redacted:jwt>'],
  [/\b(?:sk-|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|AIza)[A-Za-z0-9_-]*$/, '<redacted:key>'],
]

/**
 * Redact credential formats, e-mail addresses and phone numbers inside free text. A long string is
 * cut to `maxString + SCAN_MARGIN` and scanned, then cut to `maxString` and the kept head is swept
 * for a credential running into the cut.
 */
export function redactText(text: string, maxString = DEFAULT_LIMITS.maxString): string {
  const cut = text.length > maxString
  let s = cut ? text.slice(0, maxString + SCAN_MARGIN) : text
  for (const [re, rep] of TEXT_PATTERNS) s = s.replace(re, rep)
  s = redactEmails(s)
  if (!cut) return s
  let head = s.slice(0, maxString)
  for (const [re, rep] of DANGLING) head = head.replace(re, rep)
  return `${head}…<truncated:${text.length}>`
}

export interface Redactor {
  (value: unknown): unknown
  /** True when this key's value would be replaced. */
  redactsKey(key: string): boolean
}

export function createRedactor(
  policy: RedactPolicy = {},
  limits: Partial<RedactLimits> = {},
): Redactor {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const extra = new Set([...(policy.extraKeys ?? [])].map(normalizeKey))
  const redactsKey = (key: string) => {
    if (isCredentialKey(key)) return true
    return keyForms(key).some((k) => extra.has(k) || (!!policy.payload && PAYLOAD_KEYS.has(k)))
  }
  let nodes = 0
  let textBudget = 0
  const walk = (v: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (++nodes > lim.maxNodes) return '<truncated:nodes>'
    if (typeof v === 'string') {
      textBudget -= Math.min(v.length, lim.maxString + 1024)
      return textBudget < 0 ? `<truncated:size:${v.length}>` : redactText(v, lim.maxString)
    }
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'function' || typeof v === 'symbol') return `<${typeof v}>`
    if (typeof v !== 'object') return String(v)
    if (seen.has(v)) return '<cyclic>'
    if (depth >= lim.maxDepth) return '<truncated:depth>'
    seen.add(v)
    try {
      if (v instanceof Error) return errorToFields(v, (x) => walk(x, depth + 1, seen))
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? '<invalid date>' : v.toISOString()
      if (Array.isArray(v)) {
        const out = v.slice(0, lim.maxArray).map((x) => walk(x, depth + 1, seen))
        if (v.length > lim.maxArray) out.push(`<truncated:${v.length - lim.maxArray} more>`)
        return out
      }
      if (v instanceof Map) return walk(Object.fromEntries(v), depth, seen)
      if (v instanceof Set) return walk([...v], depth, seen)
      if (ArrayBuffer.isView(v)) return `<binary:${(v as ArrayBufferView).byteLength}>`
      const out: Record<string, unknown> = {}
      let n = 0
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (n++ >= lim.maxKeys) {
          out['<truncated>'] = `${Object.keys(v).length - lim.maxKeys} more keys`
          break
        }
        out[k] = redactsKey(k) ? REDACTED : walk(x, depth + 1, seen)
      }
      return out
    } finally {
      seen.delete(v)
    }
  }
  const r = ((value: unknown) => {
    nodes = 0
    textBudget = lim.maxTotalText
    return walk(value, 0, new WeakSet())
  }) as Redactor
  r.redactsKey = redactsKey
  return r
}

/**
 * An Error as plain fields: name, message, code, stack and the cause chain (each through `inner`,
 * so text is scanned and depth is bounded by the caller's walk).
 */
export function errorToFields(err: Error, inner: (x: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: inner(err.message) }
  const code = (err as { code?: unknown }).code
  if (code !== undefined) out.code = inner(code)
  const details = (err as { details?: unknown }).details
  if (details !== undefined) out.details = inner(details)
  if (err.stack) out.stack = inner(err.stack)
  if (err.cause !== undefined) out.cause = inner(err.cause)
  return out
}

/** Credential keys and free text only (no payload policy): safe default for any value. */
export const redact: Redactor = createRedactor()
