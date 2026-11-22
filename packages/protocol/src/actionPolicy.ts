/**
 * External Action Four-Tier Permission Policy Schema & Default Safe Policy.
 *
 * Tiers (ordered by restrictiveness):
 *   allow          — execute immediately without extra confirmation
 *   ai_review      — read-only strong-model pre-review (verified strong model only;
 *                    uncertain/error/timeout/missing-attestation fails safe to human_approval)
 *   human_approval — require explicit human confirmation before execution
 *   deny           — hard block; never execute
 */

export const ACTION_POLICY_TIERS = ['allow', 'ai_review', 'human_approval', 'deny'] as const
export type ActionPolicyTier = (typeof ACTION_POLICY_TIERS)[number]

export const ACTION_POLICY_CATEGORIES = [
  'connector_write',
  'site_publish',
  'site_delete',
  'destructive_shell',
  'browser_submit',
  'browser_login_handoff',
  'custom',
] as const
export type ActionPolicyCategory = (typeof ACTION_POLICY_CATEGORIES)[number]

export interface ActionPolicyMatcher {
  /** Exact category or list of categories. */
  category?: ActionPolicyCategory | ActionPolicyCategory[]
  /** Tool name exact or `*` wildcard glob (case-insensitive). */
  tool?: string | string[]
  /** Regex pattern(s) tested against command / action descriptor. */
  commandPattern?: string | string[]
  /** Target resource (connector provider, site slug, domain, etc.) glob. */
  target?: string | string[]
}

export interface ActionPolicyRule {
  id: string
  description?: string
  category?: ActionPolicyCategory
  tier: ActionPolicyTier
  match: ActionPolicyMatcher
  reason?: string
  /** Higher priority wins; ties break by rule order. Default 0. */
  priority?: number
  /** Defaults to true. */
  enabled?: boolean
}

export interface ActionPolicyAiReviewConfig {
  /**
   * Verified strong model id for read-only pre-review, or `'inherit'` to inherit
   * the caller's active main strong model. Weak or unrecognized models fail safe.
   */
  model?: 'inherit' | string
  /** Max wall-clock ms before AbortController cancellation & escalation. Default 12000. */
  timeoutMs?: number
  /** Minimum reviewer confidence in [0, 1] required to allow. Default 0.85. */
  minConfidence?: number
}

export interface ActionPolicyDocument {
  version: 1
  /** Tier when no rule matches. Defaults to 'allow'. */
  defaultTier?: ActionPolicyTier
  /** Whether user rules extend DEFAULT_ACTION_POLICY (default true). */
  extendsDefaults?: boolean
  /** Fallback tier when YAML config is malformed/empty/unreadable (never 'allow'). */
  onConfigError?: 'human_approval' | 'deny'
  aiReview?: ActionPolicyAiReviewConfig
  rules: ActionPolicyRule[]
}

export interface ActionPolicyRequest {
  toolName: string
  command?: string
  category?: ActionPolicyCategory
  target?: string
  args?: Record<string, unknown>
  /** Active main strong model id for ai_review inheritance. */
  mainModel?: string
  sessionKey?: string
}

export interface AiReviewOutcome {
  verdict: 'allow' | 'escalate' | 'deny'
  reviewerModel: string
  confidence?: number
  reason: string
  readOnlyEnforced?: boolean
  escalatedFromError?: boolean
}

export interface ActionPolicyEvaluation {
  tier: ActionPolicyTier
  initialTier: ActionPolicyTier
  matchedRuleId: string | null
  category: ActionPolicyCategory | null
  reason: string
  configError?: boolean
  aiReview?: AiReviewOutcome
}

export const ACTION_POLICY_TIER_SEVERITY: Readonly<Record<ActionPolicyTier, number>> = {
  allow: 0,
  ai_review: 1,
  human_approval: 2,
  deny: 3,
}

export const ACTION_CATEGORY_RISK_ORDER: readonly ActionPolicyCategory[] = [
  'destructive_shell',
  'connector_write',
  'site_delete',
  'browser_login_handoff',
  'site_publish',
  'browser_submit',
  'custom',
]

export function isActionPolicyTier(value: unknown): value is ActionPolicyTier {
  return typeof value === 'string' && (ACTION_POLICY_TIERS as readonly string[]).includes(value)
}

export function isActionPolicyCategory(value: unknown): value is ActionPolicyCategory {
  return (
    typeof value === 'string' &&
    (ACTION_POLICY_CATEGORIES as readonly string[]).includes(value)
  )
}

export function compareActionPolicyTier(a: ActionPolicyTier, b: ActionPolicyTier): number {
  return ACTION_POLICY_TIER_SEVERITY[a] - ACTION_POLICY_TIER_SEVERITY[b]
}

export const DEFAULT_ACTION_POLICY: Readonly<ActionPolicyDocument> = Object.freeze<ActionPolicyDocument>({
  version: 1,
  defaultTier: 'allow',
  extendsDefaults: true,
  onConfigError: 'human_approval',
  aiReview: {
    model: 'inherit',
    timeoutMs: 12_000,
    minConfidence: 0.85,
  },
  rules: [
    {
      id: 'default-destructive-shell-catastrophic',
      description: 'Hard block catastrophic root/device wipe shell commands',
      category: 'destructive_shell',
      tier: 'deny',
      priority: 1000,
      match: {
        tool: ['Bash', 'Shell', 'oc_bash'],
        commandPattern: [
          '(?:^|[;&|\\n])\\s*(?:sudo\\s+)?rm\\b[^\\n;|&]*(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\\s+-f|-f\\s+-r|--recursive[^\\n;|&]*--force|--force[^\\n;|&]*--recursive)[^\\n;|&]*\\s+(?:/(?:\\s|$|;|&|\\|)|/\\*|~(?:/\\s|/?$)|\\$HOME(?:/\\s|/?$))',
          '(?:^|[;&|\\n])\\s*(?:sudo\\s+)?mkfs(?:\\.[a-z0-9]+)?\\b',
          '(?:^|[;&|\\n])\\s*(?:sudo\\s+)?dd\\b[^\\n;|&]*\\bof=/dev/(?:sd|nvme|vd|hd|disk)',
          ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:',
        ],
      },
      reason: 'Catastrophic destructive shell command is permanently blocked by default action policy.',
    },
    {
      id: 'default-destructive-shell-approval',
      description: 'Require human approval for force-push, hard reset, or recursive force removal',
      category: 'destructive_shell',
      tier: 'human_approval',
      priority: 900,
      match: {
        category: 'destructive_shell',
      },
      reason: 'Destructive shell command (force push / rm -rf / hard reset) requires human approval.',
    },
    {
      id: 'default-connector-plugin-write',
      description: 'Require human approval for oc-connect and oc-plugin external write operations',
      category: 'connector_write',
      tier: 'human_approval',
      priority: 850,
      match: {
        category: 'connector_write',
      },
      reason: 'External connector/plugin write action requires human approval.',
    },
    {
      id: 'default-site-delete',
      description: 'Require human approval for deleting or unpublishing a site via oc-site',
      category: 'site_delete',
      tier: 'human_approval',
      priority: 850,
      match: {
        category: 'site_delete',
      },
      reason: 'Deleting or unpublishing a site via oc-site requires human approval.',
    },
    {
      id: 'default-site-publish',
      description: 'Run strong-model read-only AI review before publishing a site via oc-site',
      category: 'site_publish',
      tier: 'ai_review',
      priority: 800,
      match: {
        category: 'site_publish',
      },
      reason: 'Publishing a site via oc-site requires strong-model read-only AI pre-review.',
    },
    {
      id: 'default-browser-login-handoff',
      description: 'Require human approval / live takeover for browser login, 2FA, or captcha handoff',
      category: 'browser_login_handoff',
      tier: 'human_approval',
      priority: 850,
      match: {
        category: 'browser_login_handoff',
      },
      reason: 'Browser login/2FA/captcha takeover requires explicit human handoff and approval.',
    },
    {
      id: 'default-browser-form-submit',
      description: 'Run strong-model read-only AI review before browser form submission or checkout',
      category: 'browser_submit',
      tier: 'ai_review',
      priority: 800,
      match: {
        category: 'browser_submit',
      },
      reason: 'Browser form submission requires strong-model read-only AI pre-review.',
    },
  ],
})

/**
 * Quote-aware shell command splitter: splits compound pipelines (`;`, `&&`, `||`, `|`, `\n`)
 * and extracts `$(...)` / backtick subshells so EVERY action in a compound command is
 * evaluated independently and the strictest tier wins.
 */
export function splitShellCommandSegments(command: string): string[] {
  if (!command || !command.trim()) return []
  const segments: string[] = []
  const subshells: string[] = []

  let cur = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  const flush = () => {
    const trimmed = cur.trim()
    if (trimmed) segments.push(trimmed)
    cur = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1] ?? ''

    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      cur += ch
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      cur += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      cur += ch
      continue
    }

    // Extract `$( ... )` subshells (outside single quotes)
    if (!inSingle && ch === '$' && next === '(') {
      let depth = 1
      let j = i + 2
      let inner = ''
      while (j < command.length && depth > 0) {
        const c = command[j]!
        if (c === '(') depth += 1
        else if (c === ')') depth -= 1
        if (depth > 0) inner += c
        j += 1
      }
      if (inner.trim()) subshells.push(inner.trim())
      cur += command.slice(i, j)
      i = j - 1
      continue
    }

    // Extract backtick subshells (outside single quotes)
    if (!inSingle && ch === '`') {
      let j = i + 1
      let inner = ''
      while (j < command.length && command[j] !== '`') {
        inner += command[j]!
        j += 1
      }
      if (inner.trim()) subshells.push(inner.trim())
      cur += command.slice(i, j + 1)
      i = j
      continue
    }

    if (!inSingle && !inDouble) {
      if (ch === ';' || ch === '\n') {
        flush()
        continue
      }
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        flush()
        i += 1
        continue
      }
      if (ch === '|') {
        flush()
        continue
      }
    }

    cur += ch
  }
  flush()

  // Recursively expand any captured subshells
  for (const sub of subshells) {
    for (const part of splitShellCommandSegments(sub)) {
      if (!segments.includes(part)) segments.push(part)
    }
  }
  return segments
}

/** Normalize quoted command wrapper prefixes like `bash -c "..."` or `sh -lc '...'` for inspection. */
function unwrapShellSubcommand(segment: string): string {
  const m = /^(?:sudo\s+)?(?:env\s+(?:\w+=\S+\s+)*)?(?:ba|z|da)?sh\s+-[a-zA-Z]*c\s+(['"])([\s\S]+)\1\s*$/i.exec(
    segment.trim(),
  )
  return m ? m[2]! : segment
}

/**
 * Extract structured target (provider / site slug / url) from a shell command segment
 * matching real CLI argument contracts:
 *   - `oc-connect <provider> ...` / `oc-plugin <provider> ...` -> `<provider>`
 *   - `oc-site publish <path> --slug <slug>` -> `<slug>` ONLY from `--slug` (NEVER `<path>`!)
 *   - `oc-site delete|rm|remove|destroy|unpublish|info <slug>` -> `--slug <slug>` or positional `<slug>`
 *   - `oc-browser ... https://...` -> URL
 */
export function extractCommandTarget(command: string | undefined): string | undefined {
  if (!command || !command.trim()) return undefined
  const s = unwrapShellSubcommand(command).trim()

  const conn = /\b(?:oc-connect|oc-plugin)\s+(?:call\s+|write\s+)?([a-zA-Z0-9._:-]+)\b/i.exec(s)
  if (conn?.[1] && !conn[1].startsWith('-')) return conn[1]

  if (/\boc-site\b/i.test(s)) {
    // Named `--slug <val>` or `--slug=<val>` takes precedence across all oc-site subcommands.
    const namedSlug = /\boc-site\b[^\n;|&]*--slug(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/i.exec(s)
    const slugVal = namedSlug?.[1] ?? namedSlug?.[2] ?? namedSlug?.[3]
    if (slugVal && !slugVal.startsWith('-')) return slugVal

    // `oc-site publish|deploy|release <local-path>`: positional arg is a local directory/file path,
    // NOT a site slug. Return undefined unless `--slug` was explicitly provided.
    if (/\boc-site\s+(?:publish|deploy|release)\b/i.test(s)) {
      return undefined
    }

    // `oc-site delete|rm|remove|destroy|unpublish|info <slug>`: positional arg IS the site slug.
    const siteDel = /\boc-site\s+(?:delete|rm|remove|destroy|unpublish|info)\s+(?:--[a-z-]+(?:=|\s+)\S+\s+)*([a-zA-Z0-9._:-]+)/i.exec(s)
    if (siteDel?.[1] && !siteDel[1].startsWith('-')) return siteDel[1]
    return undefined
  }

  const browserUrl = /\boc-browser\b[^\n;|&]*(https?:\/\/[^\s'"]+)/i.exec(s)
  if (browserUrl?.[1]) return browserUrl[1]

  return undefined
}

const DESTRUCTIVE_SHELL_SEGMENT_RE =
  /\bgit\s+push\b[^\n;|&]*(?:--force(?:-with-lease)?|\s-f\b|\s\+\S+)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+(?:-[a-zA-Z]*f[a-zA-Z]*d|-[a-zA-Z]*d[a-zA-Z]*f|-f\s+-d|-d\s+-f)|(?:^|\s)(?:sudo\s+)?(?:rm\b[^\n;|&]*(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r|--recursive[^\n;|&]*--force|--force[^\n;|&]*--recursive)|mkfs(?:\.[a-z0-9]+)?\b|dd\b[^\n;|&]*\bof=\/dev\/)|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i

function classifySingleSegmentCategories(toolLower: string, rawSegment: string): ActionPolicyCategory[] {
  const seg = unwrapShellSubcommand(rawSegment)
  const found: ActionPolicyCategory[] = []

  if (DESTRUCTIVE_SHELL_SEGMENT_RE.test(seg)) {
    found.push('destructive_shell')
  }
  if (
    /\b(?:oc-connect|oc-plugin)\b[^\n;|&]*\b(?:write|send|post|create|update|delete|remove|mutate|reply|comment|publish|execute|invoke-write|propose-write)\b/i.test(
      seg,
    ) ||
    /^(?:oc[-_]?connect|oc[-_]?plugin|connector)[-_:]?write$/i.test(toolLower)
  ) {
    found.push('connector_write')
  }
  if (/\boc-site\b[^\n;|&]*\b(?:delete|rm|remove|destroy|unpublish)\b/i.test(seg)) {
    found.push('site_delete')
  }
  if (/\boc-site\b[^\n;|&]*\b(?:publish|deploy|release)\b/i.test(seg)) {
    found.push('site_publish')
  }
  if (
    /\boc-browser\b[^\n;|&]*\b(?:login|signin|sign-in|auth|2fa|mfa|otp|captcha|handoff|takeover)\b/i.test(
      seg,
    ) ||
    toolLower === 'browser_handoff'
  ) {
    found.push('browser_login_handoff')
  }
  if (
    /\boc-browser\b[^\n;|&]*\b(?:submit|checkout|pay|purchase|place-order|confirm-order|send-form)\b/i.test(
      seg,
    )
  ) {
    found.push('browser_submit')
  }
  return found
}

/**
 * Return ALL matched canonical categories across all segments in a request,
 * ordered from highest risk to lowest risk.
 */
export function classifyActionCategories(req: ActionPolicyRequest): ActionPolicyCategory[] {
  const found = new Set<ActionPolicyCategory>()
  if (req.category && isActionPolicyCategory(req.category)) {
    found.add(req.category)
  }
  const toolLower = (req.toolName ?? '').toLowerCase()
  const cmd = req.command ?? ''

  if (!cmd.trim()) {
    for (const c of classifySingleSegmentCategories(toolLower, '')) found.add(c)
  } else {
    const segments = splitShellCommandSegments(cmd)
    for (const seg of segments) {
      const inner = unwrapShellSubcommand(seg)
      const subParts = inner !== seg ? splitShellCommandSegments(inner) : [seg]
      for (const part of subParts) {
        for (const c of classifySingleSegmentCategories(toolLower, part)) {
          found.add(c)
        }
      }
    }
  }

  return ACTION_CATEGORY_RISK_ORDER.filter((c) => found.has(c))
}

/** Return the highest-risk canonical category for a request, or null if none matched. */
export function classifyActionCategory(req: ActionPolicyRequest): ActionPolicyCategory | null {
  return classifyActionCategories(req)[0] ?? null
}

function isStringOrStringArray(v: unknown): v is string | string[] {
  if (typeof v === 'string') return v.trim().length > 0
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim().length > 0)
}

const ALLOWED_ROOT_KEYS = new Set([
  'version',
  'defaultTier',
  'extendsDefaults',
  'onConfigError',
  'aiReview',
  'rules',
])
const ALLOWED_AI_REVIEW_KEYS = new Set(['model', 'timeoutMs', 'minConfidence'])
const ALLOWED_RULE_KEYS = new Set([
  'id',
  'description',
  'category',
  'tier',
  'match',
  'reason',
  'priority',
  'enabled',
])
const ALLOWED_MATCH_KEYS = new Set(['category', 'tool', 'commandPattern', 'target'])

export type ValidateActionPolicyResult =
  | { ok: true; policy: ActionPolicyDocument }
  | { ok: false; errors: string[] }

/**
 * Strictly validate a parsed action-policy document (from `~/.openclaude/action-policy.yaml`).
 * Rejects unknown root/rule/match/aiReview keys, missing/null `rules`, unsupported version,
 * and broken regexes so a typo can never silently weaken a restriction.
 */
export function validateActionPolicyDocument(raw: unknown): ValidateActionPolicyResult {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['action-policy root must be a YAML mapping/object'] }
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      errors.push(`unknown top-level key "${key}" in action-policy`)
    }
  }

  if (obj.version !== 1) {
    errors.push(`unsupported or missing action-policy version: ${String(obj.version)} (expected 1)`)
  }
  if (obj.defaultTier !== undefined && !isActionPolicyTier(obj.defaultTier)) {
    errors.push(`invalid defaultTier: ${String(obj.defaultTier)}`)
  }
  if (obj.extendsDefaults !== undefined && typeof obj.extendsDefaults !== 'boolean') {
    errors.push('extendsDefaults must be a boolean')
  }
  if (
    obj.onConfigError !== undefined &&
    obj.onConfigError !== 'human_approval' &&
    obj.onConfigError !== 'deny'
  ) {
    errors.push(`invalid onConfigError: ${String(obj.onConfigError)} (expected human_approval | deny)`)
  }

  let aiReview: ActionPolicyAiReviewConfig | undefined
  if (obj.aiReview !== undefined) {
    if (!obj.aiReview || typeof obj.aiReview !== 'object' || Array.isArray(obj.aiReview)) {
      errors.push('aiReview must be an object')
    } else {
      const ar = obj.aiReview as Record<string, unknown>
      for (const key of Object.keys(ar)) {
        if (!ALLOWED_AI_REVIEW_KEYS.has(key)) {
          errors.push(`unknown key "aiReview.${key}"`)
        }
      }
      if (ar.model !== undefined && (typeof ar.model !== 'string' || !ar.model.trim())) {
        errors.push('aiReview.model must be a non-empty string or "inherit"')
      }
      if (
        ar.timeoutMs !== undefined &&
        (typeof ar.timeoutMs !== 'number' || !Number.isFinite(ar.timeoutMs) || ar.timeoutMs < 500 || ar.timeoutMs > 120_000)
      ) {
        errors.push('aiReview.timeoutMs must be a number between 500 and 120000')
      }
      if (
        ar.minConfidence !== undefined &&
        (typeof ar.minConfidence !== 'number' || !Number.isFinite(ar.minConfidence) || ar.minConfidence < 0 || ar.minConfidence > 1)
      ) {
        errors.push('aiReview.minConfidence must be a number between 0 and 1')
      }
      aiReview = {
        ...(typeof ar.model === 'string' ? { model: ar.model.trim() } : {}),
        ...(typeof ar.timeoutMs === 'number' ? { timeoutMs: ar.timeoutMs } : {}),
        ...(typeof ar.minConfidence === 'number' ? { minConfidence: ar.minConfidence } : {}),
      }
    }
  }

  if (!Array.isArray(obj.rules)) {
    errors.push('rules must be an explicit array (missing or null rules is rejected fail-closed)')
    return { ok: false, errors }
  }
  const rawRules = obj.rules

  const seenIds = new Set<string>()
  const rules: ActionPolicyRule[] = []
  for (let i = 0; i < rawRules.length; i++) {
    const r = rawRules[i]
    const prefix = `rules[${i}]`
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`${prefix} must be an object`)
      continue
    }
    const rec = r as Record<string, unknown>
    let unknownKey = false
    for (const key of Object.keys(rec)) {
      if (!ALLOWED_RULE_KEYS.has(key)) {
        errors.push(`${prefix}: unknown rule key "${key}"`)
        unknownKey = true
      }
    }
    if (unknownKey) continue

    if (typeof rec.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rec.id)) {
      errors.push(`${prefix}.id must match /^[A-Za-z0-9._:-]{1,128}$/`)
      continue
    }
    if (seenIds.has(rec.id)) {
      errors.push(`${prefix}.id "${rec.id}" is duplicated`)
      continue
    }
    seenIds.add(rec.id)

    if (!isActionPolicyTier(rec.tier)) {
      errors.push(`${prefix}.tier must be one of: ${ACTION_POLICY_TIERS.join(', ')}`)
      continue
    }
    if (rec.category !== undefined && !isActionPolicyCategory(rec.category)) {
      errors.push(`${prefix}.category is invalid: ${String(rec.category)}`)
      continue
    }
    if (rec.priority !== undefined && (typeof rec.priority !== 'number' || !Number.isFinite(rec.priority))) {
      errors.push(`${prefix}.priority must be a finite number`)
      continue
    }
    if (rec.enabled !== undefined && typeof rec.enabled !== 'boolean') {
      errors.push(`${prefix}.enabled must be a boolean`)
      continue
    }
    if (!rec.match || typeof rec.match !== 'object' || Array.isArray(rec.match)) {
      errors.push(`${prefix}.match must be an object`)
      continue
    }
    const m = rec.match as Record<string, unknown>
    let unknownMatchKey = false
    for (const key of Object.keys(m)) {
      if (!ALLOWED_MATCH_KEYS.has(key)) {
        errors.push(`${prefix}.match: unknown restriction key "${key}"`)
        unknownMatchKey = true
      }
    }
    if (unknownMatchKey) continue

    const matcher: ActionPolicyMatcher = {}
    let hasAnyCondition = false

    if (m.category !== undefined) {
      const cats = Array.isArray(m.category) ? m.category : [m.category]
      if (cats.length === 0 || !cats.every(isActionPolicyCategory)) {
        errors.push(`${prefix}.match.category contains invalid category`)
        continue
      }
      matcher.category = Array.isArray(m.category) ? (cats as ActionPolicyCategory[]) : (cats[0] as ActionPolicyCategory)
      hasAnyCondition = true
    }
    if (m.tool !== undefined) {
      if (!isStringOrStringArray(m.tool)) {
        errors.push(`${prefix}.match.tool must be a non-empty string or string[]`)
        continue
      }
      matcher.tool = m.tool
      hasAnyCondition = true
    }
    if (m.target !== undefined) {
      if (!isStringOrStringArray(m.target)) {
        errors.push(`${prefix}.match.target must be a non-empty string or string[]`)
        continue
      }
      matcher.target = m.target
      hasAnyCondition = true
    }
    if (m.commandPattern !== undefined) {
      if (!isStringOrStringArray(m.commandPattern)) {
        errors.push(`${prefix}.match.commandPattern must be a non-empty string or string[]`)
        continue
      }
      const patterns = Array.isArray(m.commandPattern) ? m.commandPattern : [m.commandPattern]
      let badRegex = false
      for (const pat of patterns) {
        try {
          new RegExp(pat, 'i')
        } catch (err) {
          errors.push(`${prefix}.match.commandPattern invalid regex "${pat}": ${(err as Error).message}`)
          badRegex = true
        }
      }
      if (badRegex) continue
      matcher.commandPattern = m.commandPattern
      hasAnyCondition = true
    }

    if (!hasAnyCondition) {
      errors.push(`${prefix}.match must specify at least one condition (category, tool, commandPattern, or target)`)
      continue
    }

    rules.push({
      id: rec.id,
      ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
      ...(rec.category !== undefined ? { category: rec.category as ActionPolicyCategory } : {}),
      tier: rec.tier,
      match: matcher,
      ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
      ...(typeof rec.priority === 'number' ? { priority: rec.priority } : {}),
      ...(typeof rec.enabled === 'boolean' ? { enabled: rec.enabled } : {}),
    })
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    policy: {
      version: 1,
      defaultTier: (obj.defaultTier as ActionPolicyTier | undefined) ?? 'allow',
      extendsDefaults: (obj.extendsDefaults as boolean | undefined) ?? true,
      onConfigError: (obj.onConfigError as 'human_approval' | 'deny' | undefined) ?? 'human_approval',
      ...(aiReview ? { aiReview } : {}),
      rules,
    },
  }
}

export function sortActionPolicyRules(rules: readonly ActionPolicyRule[]): ActionPolicyRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const pa = a.rule.priority ?? 0
      const pb = b.rule.priority ?? 0
      if (pb !== pa) return pb - pa
      return a.index - b.index
    })
    .map((entry) => entry.rule)
}

export function mergeActionPolicyWithDefaults(userPolicy: ActionPolicyDocument): ActionPolicyDocument {
  if (userPolicy.extendsDefaults === false) {
    return {
      ...userPolicy,
      rules: sortActionPolicyRules(userPolicy.rules),
    }
  }
  const userIds = new Set(userPolicy.rules.map((r) => r.id))
  const mergedRules = [
    ...userPolicy.rules,
    ...DEFAULT_ACTION_POLICY.rules.filter((r) => !userIds.has(r.id)),
  ]
  return {
    version: 1,
    defaultTier: userPolicy.defaultTier ?? DEFAULT_ACTION_POLICY.defaultTier ?? 'allow',
    extendsDefaults: true,
    onConfigError: userPolicy.onConfigError ?? DEFAULT_ACTION_POLICY.onConfigError ?? 'human_approval',
    aiReview: {
      ...DEFAULT_ACTION_POLICY.aiReview,
      ...userPolicy.aiReview,
    },
    rules: sortActionPolicyRules(mergedRules),
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchesGlobList(value: string | undefined, matcher: string | string[]): boolean {
  if (!value) return false
  const list = Array.isArray(matcher) ? matcher : [matcher]
  return list.some((pat) => globToRegExp(pat.trim()).test(value.trim()))
}

function matchesRegexList(value: string | undefined, matcher: string | string[]): boolean {
  if (!value) return false
  const list = Array.isArray(matcher) ? matcher : [matcher]
  return list.some((pat) => {
    try {
      return new RegExp(pat, 'i').test(value)
    } catch {
      return false
    }
  })
}

export function matchActionPolicyRuleInProtocol(
  rule: ActionPolicyRule,
  req: ActionPolicyRequest,
  resolvedCategories: readonly ActionPolicyCategory[],
): boolean {
  if (rule.enabled === false) return false
  const m = rule.match
  if (m.category !== undefined) {
    const cats = Array.isArray(m.category) ? m.category : [m.category]
    if (!resolvedCategories.some((c) => cats.includes(c))) return false
  }
  if (m.tool !== undefined && !matchesGlobList(req.toolName, m.tool)) return false
  if (m.target !== undefined) {
    const effectiveTarget = req.target ?? extractCommandTarget(req.command)
    if (!matchesGlobList(effectiveTarget, m.target)) return false
  }
  if (m.commandPattern !== undefined && !matchesRegexList(req.command, m.commandPattern)) return false
  return true
}

export function evaluateActionPolicyDocumentSync(
  request: ActionPolicyRequest,
  policy: ActionPolicyDocument,
): { evaluation: ActionPolicyEvaluation; matchedRule: ActionPolicyRule | null } {
  const sortedPolicy = { ...policy, rules: sortActionPolicyRules(policy.rules) }
  const evalOne = (candidate: ActionPolicyRequest) => {
    const resolvedCategories = classifyActionCategories(candidate)
    const effective: ActionPolicyRequest = {
      ...candidate,
      target: candidate.target ?? extractCommandTarget(candidate.command),
    }
    let matchedRule: ActionPolicyRule | null = null
    for (const rule of sortedPolicy.rules) {
      if (matchActionPolicyRuleInProtocol(rule, effective, resolvedCategories)) {
        matchedRule = rule
        break
      }
    }
    const tier: ActionPolicyTier = matchedRule?.tier ?? sortedPolicy.defaultTier ?? 'allow'
    const reason =
      matchedRule?.reason ??
      (matchedRule
        ? `Matched action-policy rule "${matchedRule.id}" (${matchedRule.tier}).`
        : `No action-policy rule matched; default tier "${tier}".`)
    return {
      matchedRule,
      evaluation: {
        tier,
        initialTier: tier,
        matchedRuleId: matchedRule?.id ?? null,
        category: matchedRule?.category ?? resolvedCategories[0] ?? null,
        reason,
      },
    }
  }

  const candidates: ActionPolicyRequest[] = []
  if (request.command && request.command.trim()) {
    for (const seg of splitShellCommandSegments(request.command)) {
      candidates.push({
        ...request,
        command: seg,
        target: request.target ?? extractCommandTarget(seg),
      })
    }
  }
  candidates.push(request)

  let strictest = evalOne(candidates[0]!)
  for (let i = 1; i < candidates.length; i++) {
    const next = evalOne(candidates[i]!)
    if (compareActionPolicyTier(next.evaluation.tier, strictest.evaluation.tier) > 0) {
      strictest = next
    }
  }
  return strictest
}
