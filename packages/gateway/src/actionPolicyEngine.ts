/**
 * Action Policy Engine — evaluates external actions against the 4-tier
 * permission policy (`allow | ai_review | human_approval | deny`).
 *
 * Config source: `~/.openclaude/action-policy.yaml` (or `OPENCLAUDE_ACTION_POLICY_PATH`).
 *   - Missing file (`ENOENT`): uses `DEFAULT_ACTION_POLICY`.
 *   - Empty file, unreadable file, invalid YAML, or invalid schema (including unknown
 *     restriction keys): strictly fail-closed (never silently degrades to `allow`).
 *
 * Compound shell commands:
 *   - Split into individual segments (`;`, `&&`, `||`, `|`, `\n`, subshells), each
 *     evaluated independently, taking the STRICTEST resulting tier (`deny > human_approval > ai_review > allow`).
 *
 * `ai_review` strong-model read-only pre-review hook contract:
 *   - Model MUST match the verified strong-model allowlist (or caller-provided `trustedStrongModels`)
 *     AND must not match weak/mini patterns. Unknown model names fail safe to `human_approval`.
 *   - Passes `signal: AbortSignal` and cancels via `AbortController.abort()` on timeout.
 *   - Reviewer MUST attest `readOnlyEnforced: true`, echo matching `modelUsed`, and supply
 *     a finite numeric `confidence >= minConfidence` for `verdict: 'allow'`.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  DEFAULT_ACTION_POLICY,
  classifyActionCategories,
  compareActionPolicyTier,
  extractCommandTarget,
  splitShellCommandSegments,
  validateActionPolicyDocument,
  type ActionPolicyCategory,
  type ActionPolicyDocument,
  type ActionPolicyEvaluation,
  type ActionPolicyRequest,
  type ActionPolicyRule,
  type ActionPolicyTier,
  type AiReviewOutcome,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'

export const ACTION_POLICY_FILENAME = 'action-policy.yaml'
export const ACTION_POLICY_PATH_ENV = 'OPENCLAUDE_ACTION_POLICY_PATH'
export const ACTION_POLICY_ENABLED_ENV = 'OPENCLAUDE_ACTION_POLICY'

const DEFAULT_AI_REVIEW_TIMEOUT_MS = 12_000
const DEFAULT_AI_REVIEW_MIN_CONFIDENCE = 0.85

/**
 * Weak / lightweight model patterns always rejected for `ai_review`.
 */
const WEAK_MODEL_RE =
  /(?:^|[/._:-])(?:haiku|mini|nano|tiny|small|lite|flash|flash-lite|3\.5-turbo|gpt-3\.5|4o-mini|o1-mini|o3-mini|o4-mini|claude-3-haiku|claude-3-5-haiku|claude-haiku|gemini-[^/]*flash|qwen-?turbo|deepseek-lite)(?:$|[/._:-])/i

/**
 * Verified strong model families allowed for `ai_review`.
 * Unrecognized model identifiers are NOT assumed strong (fail-safe to `human_approval`).
 */
const VERIFIED_STRONG_MODEL_PATTERNS: readonly RegExp[] = [
  /(?:^|[/._:-])claude-(?:opus|sonnet)-(?:4|3[._-]7)(?:[/._:-]|$)/i,
  /(?:^|[/._:-])claude-(?:4|3[._-]7)-(?:opus|sonnet)(?:[/._:-]|$)/i,
  /(?:^|[/._:-])(?:cursor-)?(?:opus|fable)(?:[/._:-]|$)/i,
  /(?:^|[/._:-])gpt-(?:5|6|4\.1|4\.5)(?:[/._:-]|$)/i,
  /(?:^|[/._:-])o(?:1|3|4)(?:[-_]pro)?(?:$|[/._:-])/i,
  /(?:^|[/._:-])gemini-(?:2\.5|3(?:\.\d+)?)-pro(?:[/._:-]|$)/i,
  /(?:^|[/._:-])deepseek-(?:r1|reasoner)(?:[/._:-]|$)/i,
  /(?:^|[/._:-])grok-(?:4|3)(?:[/._:-]|$)/i,
]

export function isWeakModelId(modelId: string | undefined | null): boolean {
  if (!modelId || typeof modelId !== 'string') return false
  const trimmed = modelId.trim()
  if (!trimmed) return false
  return WEAK_MODEL_RE.test(trimmed)
}

export function isVerifiedStrongReviewModel(
  modelId: string | undefined | null,
  trustedStrongModels?: readonly string[],
): boolean {
  if (!modelId || typeof modelId !== 'string') return false
  const trimmed = modelId.trim()
  if (!trimmed || isWeakModelId(trimmed)) return false
  if (trustedStrongModels && trustedStrongModels.some((m) => m.trim().toLowerCase() === trimmed.toLowerCase())) {
    return true
  }
  return VERIFIED_STRONG_MODEL_PATTERNS.some((re) => re.test(trimmed))
}

export function resolveActionPolicyPath(
  overridePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (overridePath && overridePath.trim()) return overridePath.trim()
  const fromEnv = env[ACTION_POLICY_PATH_ENV]?.trim()
  if (fromEnv) return fromEnv
  const home = env.OPENCLAUDE_HOME?.trim() || paths.home
  return join(home, ACTION_POLICY_FILENAME)
}

export function isActionPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ACTION_POLICY_ENABLED_ENV] ?? 'on').trim().toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false')
}

export interface LoadedActionPolicy {
  ok: boolean
  source: 'default' | 'file' | 'invalid'
  path: string
  policy: ActionPolicyDocument
  warnings: string[]
  error?: string
}

function mergePolicyWithDefaults(userPolicy: ActionPolicyDocument): ActionPolicyDocument {
  if (userPolicy.extendsDefaults === false) {
    return {
      ...userPolicy,
      rules: sortRules(userPolicy.rules),
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
    rules: sortRules(mergedRules),
  }
}

function sortRules(rules: readonly ActionPolicyRule[]): ActionPolicyRule[] {
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

export function loadActionPolicy(opts?: {
  policyPath?: string
  env?: NodeJS.ProcessEnv
  onWarn?: (message: string) => void
}): LoadedActionPolicy {
  const path = resolveActionPolicyPath(opts?.policyPath, opts?.env)

  let rawText: string
  try {
    rawText = readFileSync(path, 'utf8')
  } catch (err) {
    // Distinguish genuine ENOENT ("never configured") from EACCES/EISDIR/other read failures.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        ok: true,
        source: 'default',
        path,
        policy: {
          ...DEFAULT_ACTION_POLICY,
          rules: sortRules(DEFAULT_ACTION_POLICY.rules),
        },
        warnings: [],
      }
    }
    const error = `failed to read ${path}: ${(err as Error).message}`
    opts?.onWarn?.(`[action-policy] ${error} (fail-closed)`)
    return {
      ok: false,
      source: 'invalid',
      path,
      policy: {
        ...DEFAULT_ACTION_POLICY,
        rules: sortRules(DEFAULT_ACTION_POLICY.rules),
      },
      warnings: [error],
      error,
    }
  }

  // An existing but empty file is treated as a corrupted/truncated config (fail-closed),
  // distinct from a never-created file (ENOENT -> safe defaults).
  if (!rawText.trim()) {
    const error = `${path} exists but is empty; failing closed`
    opts?.onWarn?.(`[action-policy] ${error}`)
    return {
      ok: false,
      source: 'invalid',
      path,
      policy: {
        ...DEFAULT_ACTION_POLICY,
        rules: sortRules(DEFAULT_ACTION_POLICY.rules),
      },
      warnings: [error],
      error,
    }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(rawText)
  } catch (err) {
    const error = `invalid YAML in ${path}: ${(err as Error).message}`
    opts?.onWarn?.(`[action-policy] ${error} (fail-closed)`)
    return {
      ok: false,
      source: 'invalid',
      path,
      policy: {
        ...DEFAULT_ACTION_POLICY,
        rules: sortRules(DEFAULT_ACTION_POLICY.rules),
      },
      warnings: [error],
      error,
    }
  }

  const validated = validateActionPolicyDocument(parsed)
  if (!validated.ok) {
    const error = `invalid schema in ${path}: ${validated.errors.join('; ')}`
    opts?.onWarn?.(`[action-policy] ${error} (fail-closed)`)
    return {
      ok: false,
      source: 'invalid',
      path,
      policy: {
        ...DEFAULT_ACTION_POLICY,
        rules: sortRules(DEFAULT_ACTION_POLICY.rules),
      },
      warnings: validated.errors,
      error,
    }
  }

  return {
    ok: true,
    source: 'file',
    path,
    policy: mergePolicyWithDefaults(validated.policy),
    warnings: [],
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchesGlobList(value: string | undefined, matcher: string | string[]): boolean {
  if (!value) return false
  const list = Array.isArray(matcher) ? matcher : [matcher]
  return list.some((pat) => globToRegex(pat.trim()).test(value.trim()))
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

export function matchActionPolicyRule(
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
  if (m.tool !== undefined) {
    if (!matchesGlobList(req.toolName, m.tool)) return false
  }
  if (m.target !== undefined) {
    const effectiveTarget = req.target ?? extractCommandTarget(req.command)
    if (!matchesGlobList(effectiveTarget, m.target)) return false
  }
  if (m.commandPattern !== undefined) {
    if (!matchesRegexList(req.command, m.commandPattern)) return false
  }
  return true
}

export interface AiReviewContext {
  request: ActionPolicyRequest
  matchedRule: ActionPolicyRule | null
  category: ActionPolicyCategory | null
  /** Verified strong reviewer model id. Never a weak or unverified model. */
  reviewerModel: string
  /** Read-only enforcement marker — reviewer must disable all mutating/exec tools. */
  readOnly: true
  timeoutMs: number
  /** AbortSignal aborted immediately when timeoutMs elapses. */
  signal: AbortSignal
}

export interface AiReviewHookResponse {
  verdict: 'allow' | 'escalate' | 'deny'
  /** Required finite number in [0, 1] for `verdict: 'allow'`. */
  confidence?: number
  reason: string
  /** Must echo the actual strong model used by the reviewer transport. */
  modelUsed?: string
  /** Must be `true` to attest that the reviewer executed with tools disabled / read-only. */
  readOnlyEnforced?: boolean
}

export type AiReviewHook = (ctx: AiReviewContext) => Promise<AiReviewHookResponse>

export interface EvaluateActionPolicyOptions {
  loaded?: LoadedActionPolicy
  policyPath?: string
  env?: NodeJS.ProcessEnv
  /** Active main strong model id if not already set on `request.mainModel`. */
  mainModel?: string
  /** Optional explicit allowlist of trusted enterprise strong model aliases. */
  trustedStrongModels?: readonly string[]
  /** Strong-model read-only pre-review hook for `ai_review` tier. */
  aiReviewHook?: AiReviewHook
  /** Override invalid-config fail-closed tier (defaults to 'human_approval'; never 'allow'). */
  invalidConfigFallback?: 'human_approval' | 'deny'
  onWarn?: (message: string) => void
}

export function resolveAiReviewModel(
  policy: ActionPolicyDocument,
  request: ActionPolicyRequest,
  fallbackMainModel?: string,
  trustedStrongModels?: readonly string[],
): { ok: true; model: string } | { ok: false; reason: string } {
  const configured = policy.aiReview?.model?.trim()
  const inherited = request.mainModel?.trim() || fallbackMainModel?.trim() || ''

  const chosen = !configured || configured === 'inherit' ? inherited : configured
  if (!chosen) {
    return {
      ok: false,
      reason:
        'ai_review requires a verified strong model or inherited main strong model; none provided (fail-safe escalating to human_approval).',
    }
  }
  if (!isVerifiedStrongReviewModel(chosen, trustedStrongModels)) {
    return {
      ok: false,
      reason: `ai_review rejected unverified/weak model "${chosen}"; verified strong model required (fail-safe escalating to human_approval).`,
    }
  }
  return { ok: true, model: chosen }
}

function evaluateSingleRequestStatic(
  request: ActionPolicyRequest,
  policy: ActionPolicyDocument,
): { evaluation: ActionPolicyEvaluation; matchedRule: ActionPolicyRule | null } {
  const resolvedCategories = classifyActionCategories(request)
  const effectiveRequest: ActionPolicyRequest = {
    ...request,
    target: request.target ?? extractCommandTarget(request.command),
  }

  let matchedRule: ActionPolicyRule | null = null
  for (const rule of policy.rules) {
    if (matchActionPolicyRule(rule, effectiveRequest, resolvedCategories)) {
      matchedRule = rule
      break
    }
  }

  const tier: ActionPolicyTier = matchedRule?.tier ?? policy.defaultTier ?? 'allow'
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

/**
 * Synchronous static evaluation across all segments of compound commands,
 * taking the STRICTEST tier (`deny > human_approval > ai_review > allow`).
 */
export function evaluateActionPolicyStatic(
  request: ActionPolicyRequest,
  loaded: LoadedActionPolicy,
  invalidConfigFallback?: 'human_approval' | 'deny',
): { evaluation: ActionPolicyEvaluation; matchedRule: ActionPolicyRule | null } {
  const policy = loaded.policy
  const candidates: ActionPolicyRequest[] = []

  if (request.command && request.command.trim()) {
    const segments = splitShellCommandSegments(request.command)
    for (const seg of segments) {
      candidates.push({
        ...request,
        command: seg,
        target: request.target ?? extractCommandTarget(seg),
      })
    }
  }
  // Always include the full request so explicit structured category/target or multi-line rules match.
  candidates.push(request)

  let strictest = evaluateSingleRequestStatic(candidates[0]!, policy)
  for (let i = 1; i < candidates.length; i++) {
    const next = evaluateSingleRequestStatic(candidates[i]!, policy)
    if (compareActionPolicyTier(next.evaluation.tier, strictest.evaluation.tier) > 0) {
      strictest = next
    }
  }

  if (!loaded.ok) {
    const fallback = invalidConfigFallback ?? policy.onConfigError ?? 'human_approval'
    const tier: ActionPolicyTier = strictest.evaluation.tier === 'deny' ? 'deny' : fallback
    const reason = `Action policy config invalid (${loaded.error ?? 'parse error'}); failing closed to ${tier}.`
    return {
      matchedRule: strictest.matchedRule,
      evaluation: {
        tier,
        initialTier: tier,
        matchedRuleId: strictest.evaluation.matchedRuleId,
        category: strictest.evaluation.category,
        reason,
        configError: true,
      },
    }
  }

  return strictest
}

async function runWithAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`ai_review timed out after ${timeoutMs}ms`)
          controller.abort(err)
          reject(err)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Full async evaluation including verifiable strong-model read-only `ai_review` hook.
 * Guarantees fail-safe escalation to `human_approval` on any uncertainty, unverified model,
 * model mismatch, missing readOnlyEnforced attestation, missing/low confidence, timeout, or error.
 */
export async function evaluateActionPolicy(
  request: ActionPolicyRequest,
  opts: EvaluateActionPolicyOptions = {},
): Promise<ActionPolicyEvaluation> {
  const loaded =
    opts.loaded ??
    loadActionPolicy({
      policyPath: opts.policyPath,
      env: opts.env,
      onWarn: opts.onWarn,
    })

  const { evaluation, matchedRule } = evaluateActionPolicyStatic(
    request,
    loaded,
    opts.invalidConfigFallback,
  )

  if (evaluation.tier !== 'ai_review') {
    return evaluation
  }

  const modelResolution = resolveAiReviewModel(
    loaded.policy,
    request,
    opts.mainModel,
    opts.trustedStrongModels,
  )
  if (!modelResolution.ok) {
    const aiReview: AiReviewOutcome = {
      verdict: 'escalate',
      reviewerModel: 'unassigned',
      reason: modelResolution.reason,
      escalatedFromError: true,
    }
    return {
      ...evaluation,
      tier: 'human_approval',
      reason: modelResolution.reason,
      aiReview,
    }
  }

  const reviewerModel = modelResolution.model
  const timeoutMs = loaded.policy.aiReview?.timeoutMs ?? DEFAULT_AI_REVIEW_TIMEOUT_MS
  const minConfidence = loaded.policy.aiReview?.minConfidence ?? DEFAULT_AI_REVIEW_MIN_CONFIDENCE

  if (!opts.aiReviewHook) {
    const reason =
      'ai_review read-only reviewer hook is not configured; fail-safe escalating to human_approval.'
    return {
      ...evaluation,
      tier: 'human_approval',
      reason,
      aiReview: {
        verdict: 'escalate',
        reviewerModel,
        reason,
        escalatedFromError: true,
      },
    }
  }

  try {
    const hookResult = await runWithAbortTimeout(
      (signal) =>
        opts.aiReviewHook!({
          request,
          matchedRule,
          category: evaluation.category,
          reviewerModel,
          readOnly: true,
          timeoutMs,
          signal,
        }),
      timeoutMs,
    )

    const actualModel = hookResult.modelUsed?.trim() ?? ''
    if (
      !actualModel ||
      actualModel !== reviewerModel ||
      !isVerifiedStrongReviewModel(actualModel, opts.trustedStrongModels)
    ) {
      const reason = `ai_review reviewer model attestation failed (expected "${reviewerModel}", got "${actualModel || 'missing'}"); fail-safe escalating to human_approval.`
      return {
        ...evaluation,
        tier: 'human_approval',
        reason,
        aiReview: {
          verdict: 'escalate',
          reviewerModel: actualModel || 'missing',
          reason,
          escalatedFromError: true,
        },
      }
    }

    if (hookResult.verdict === 'deny') {
      return {
        ...evaluation,
        tier: 'deny',
        reason: hookResult.reason || 'Blocked by strong-model ai_review.',
        aiReview: {
          verdict: 'deny',
          reviewerModel: actualModel,
          ...(hookResult.confidence !== undefined ? { confidence: hookResult.confidence } : {}),
          readOnlyEnforced: hookResult.readOnlyEnforced === true,
          reason: hookResult.reason || 'Blocked by strong-model ai_review.',
        },
      }
    }

    if (hookResult.verdict === 'allow') {
      if (hookResult.readOnlyEnforced !== true) {
        const reason =
          'ai_review allow lacked readOnlyEnforced=true attestation; fail-safe escalating to human_approval.'
        return {
          ...evaluation,
          tier: 'human_approval',
          reason,
          aiReview: {
            verdict: 'escalate',
            reviewerModel: actualModel,
            readOnlyEnforced: false,
            reason,
            escalatedFromError: true,
          },
        }
      }
      if (
        typeof hookResult.confidence !== 'number' ||
        !Number.isFinite(hookResult.confidence) ||
        hookResult.confidence < minConfidence
      ) {
        const reason = `ai_review confidence (${String(hookResult.confidence)}) missing or below threshold (${minConfidence}); escalating to human_approval.`
        return {
          ...evaluation,
          tier: 'human_approval',
          reason,
          aiReview: {
            verdict: 'escalate',
            reviewerModel: actualModel,
            ...(typeof hookResult.confidence === 'number' ? { confidence: hookResult.confidence } : {}),
            readOnlyEnforced: true,
            reason,
          },
        }
      }
      return {
        ...evaluation,
        tier: 'allow',
        reason: hookResult.reason || `Approved by read-only ai_review (${actualModel}).`,
        aiReview: {
          verdict: 'allow',
          reviewerModel: actualModel,
          confidence: hookResult.confidence,
          readOnlyEnforced: true,
          reason: hookResult.reason || `Approved by read-only ai_review (${actualModel}).`,
        },
      }
    }

    const reason = hookResult.reason || 'ai_review escalated action to human_approval.'
    return {
      ...evaluation,
      tier: 'human_approval',
      reason,
      aiReview: {
        verdict: 'escalate',
        reviewerModel: actualModel,
        ...(typeof hookResult.confidence === 'number' ? { confidence: hookResult.confidence } : {}),
        readOnlyEnforced: hookResult.readOnlyEnforced === true,
        reason,
        ...(hookResult.verdict !== 'escalate' ? { escalatedFromError: true } : {}),
      },
    }
  } catch (err) {
    const reason = `ai_review failed (${(err as Error).message}); fail-safe escalating to human_approval.`
    return {
      ...evaluation,
      tier: 'human_approval',
      reason,
      aiReview: {
        verdict: 'escalate',
        reviewerModel,
        reason,
        escalatedFromError: true,
      },
    }
  }
}

export interface ActionPolicyEngine {
  readonly policyPath: string
  getLoadedPolicy(): LoadedActionPolicy
  reload(): LoadedActionPolicy
  evaluate(
    request: ActionPolicyRequest,
    overrides?: { mainModel?: string; aiReviewHook?: AiReviewHook },
  ): Promise<ActionPolicyEvaluation>
}

export function createActionPolicyEngine(opts?: {
  policyPath?: string
  env?: NodeJS.ProcessEnv
  defaultMainModel?: string
  trustedStrongModels?: readonly string[]
  aiReviewHook?: AiReviewHook
  invalidConfigFallback?: 'human_approval' | 'deny'
  onWarn?: (message: string) => void
}): ActionPolicyEngine {
  const policyPath = resolveActionPolicyPath(opts?.policyPath, opts?.env)
  let cachedMtimeMs: number | null | undefined = undefined
  let cachedLoaded: LoadedActionPolicy | null = null

  function currentMtimeMs(): number | null {
    try {
      return statSync(policyPath).mtimeMs
    } catch {
      return null
    }
  }

  function loadFresh(): LoadedActionPolicy {
    cachedMtimeMs = currentMtimeMs()
    cachedLoaded = loadActionPolicy({
      policyPath,
      env: opts?.env,
      onWarn: opts?.onWarn,
    })
    return cachedLoaded
  }

  return {
    policyPath,
    getLoadedPolicy(): LoadedActionPolicy {
      const mtime = currentMtimeMs()
      if (cachedLoaded && mtime === cachedMtimeMs) return cachedLoaded
      return loadFresh()
    },
    reload(): LoadedActionPolicy {
      return loadFresh()
    },
    async evaluate(request, overrides) {
      const loaded = this.getLoadedPolicy()
      return evaluateActionPolicy(request, {
        loaded,
        mainModel: overrides?.mainModel ?? opts?.defaultMainModel,
        trustedStrongModels: opts?.trustedStrongModels,
        aiReviewHook: overrides?.aiReviewHook ?? opts?.aiReviewHook,
        invalidConfigFallback: opts?.invalidConfigFallback,
        onWarn: opts?.onWarn,
      })
    },
  }
}
