/**
 * Single source of truth for the four allowed delegation model families
 * (OpenAI/GPT, Google/Gemini, xAI/Grok, DeepSeek) and the strong-tier
 * scientific audit reviewer pool (OCV5-897).
 *
 * Foreground webchat remains governed solely by the model catalog; these
 * predicates constrain delegation (`billed_delegate`, prompt advertisement,
 * teamMode panel/reviewer selection, master delegate engine-billing admit)
 * and scientific-audit cross-family coverage (`oc-review collate --scientific-gate`).
 */

export const DELEGATE_ALLOWED_MODEL_FAMILIES = [
  'openai',
  'google',
  'xai',
  'deepseek',
] as const

export type DelegateAllowedModelFamily =
  (typeof DELEGATE_ALLOWED_MODEL_FAMILIES)[number]

const DELEGATE_ALLOWED_FAMILY_SET: ReadonlySet<string> = new Set(
  DELEGATE_ALLOWED_MODEL_FAMILIES,
)

export const SCIENTIFIC_AUDIT_STRONG_POOL_LABEL =
  'gpt-6.2-astra / gpt-6.2-sol、antigravity-gemini-4-neon / antigravity-gemini-4-carbon、grok-build、deepseek-v4-flash'

export type ScientificAuditRejectReason = 'family_not_allowed' | 'non_strong_tier'

export interface ScientificAuditEligibility {
  readonly eligible: boolean
  readonly family: string
  readonly reason?: ScientificAuditRejectReason
}

const STRONG_SCIENTIFIC_AUDIT_PATTERNS: Record<DelegateAllowedModelFamily, RegExp> = {
  openai: /^gpt-6\.2-(?:astra|sol)(?:-(?:1m|remote))?$/,
  google: /^(?:antigravity-)?gemini-4-(?:neon|carbon)(?:-(?:medium|high|xhigh|remote))?$/,
  xai: /^(?:grok-build|cursor-grok-4\.7-(?:high|xhigh|max))$/,
  deepseek: /^deepseek-v4-(?:flash|pro)$/,
}

const STRONG_SCIENTIFIC_PROVIDER_PREFIXES: Record<DelegateAllowedModelFamily, RegExp> = {
  openai: /^(?:openai|codex)\//,
  google: /^(?:google|antigravity)\//,
  xai: /^(?:xai|x-ai)\//,
  deepseek: /^deepseek\//,
}

/**
 * Deterministic canonical model family classification from authoritative model slug.
 *
 * Explicit exclusions checked before broad prefixes:
 * - `antigravity-gpt-oss-*` / `gpt-oss` → `'gpt_oss'` (not flagship GPT)
 * - `cursor-auto` → `'cursor_auto'` (auto-router, not xAI/Grok)
 * - `cursor-grok-*` → `'xai'` (same xAI family as `grok-build`)
 * - `antigravity-claude-*` / `box-claude-*` / `box-api-claude-*` / `cursor-opus-*` → `'anthropic'`
 */
export function resolveCanonicalModelFamily(model: string): string {
  const raw = model.trim().toLowerCase()
  if (!raw) return 'unknown'
  if (/cleanroom|sympy|octave|deterministic-verifier/.test(raw)) return 'cleanroom'
  if (/(?:^|[-_/:])(?:claude|anthropic|fable|opus|sonnet|haiku)(?:$|[-_/:.\d])/.test(raw)) {
    return 'anthropic'
  }
  if (/(?:^|[-_/:])gpt-oss(?:$|[-_/:.\d])/.test(raw)) return 'gpt_oss'
  if (raw === 'cursor-auto') return 'cursor_auto'
  if (/gemini|gemma|palm|google|antigravity-orchestrator/.test(raw)) return 'google'
  if (/grok|xai|x-ai/.test(raw)) return 'xai'
  if (/deepseek/.test(raw)) return 'deepseek'
  if (/kimi|moonshot|(?:^|[-_/:])k\d+(?:\.\d+)?(?:$|[-_/:])/.test(raw)) return 'moonshot'
  if (/qwen|tongyi|qwq/.test(raw)) return 'qwen'
  if (/glm|zhipu|chatglm/.test(raw)) return 'zhipu'
  if (/minimax|abab/.test(raw)) return 'minimax'
  if (/(?:^|[-_/:])mimo(?:$|[-_/:.\d])/.test(raw)) return 'mimo'
  if (/stepfun|(?:^|[-_/:])step(?:$|[-_/:.\d])/.test(raw)) return 'step'
  if (/longcat/.test(raw)) return 'longcat'
  if (/muse-spark/.test(raw)) return 'muse'
  if (/(?:^|[-_/:])beam(?:$|[-_/:.\d])/.test(raw)) return 'beam'
  if (
    /openai|codex|chatgpt|(?:^|[-_/:])gpt(?:$|[-_/:.\d])|(?:^|[-_/:])o[134](?:$|[-_/:.])/.test(raw)
  ) {
    return 'openai'
  }
  return raw
}

export function isAllowedDelegateModelFamily(
  family: string,
): family is DelegateAllowedModelFamily {
  return DELEGATE_ALLOWED_FAMILY_SET.has(family)
}

/** Whether a model slug belongs to the four allowed delegation families (Grok/Gemini/GPT/DeepSeek). */
export function isAllowedDelegateModel(model: string): boolean {
  return isAllowedDelegateModelFamily(resolveCanonicalModelFamily(model))
}

/**
 * Evaluate whether a reviewer model qualifies for the strong-tier scientific
 * cross-family audit pool (`oc-review collate --scientific-gate`).
 *
 * Non-4-family models fail with `family_not_allowed`; weaker/lightweight/fast
 * models inside the 4 families fail with `non_strong_tier`.
 */
export function evaluateScientificAuditReviewer(model: string): ScientificAuditEligibility {
  const raw = model.trim().toLowerCase()
  const family = resolveCanonicalModelFamily(raw)
  if (!isAllowedDelegateModelFamily(family)) {
    return { eligible: false, family, reason: 'family_not_allowed' }
  }
  const normalizedSlug = raw.replace(STRONG_SCIENTIFIC_PROVIDER_PREFIXES[family], '')
  if (STRONG_SCIENTIFIC_AUDIT_PATTERNS[family].test(normalizedSlug)) {
    return { eligible: true, family }
  }
  return { eligible: false, family, reason: 'non_strong_tier' }
}
