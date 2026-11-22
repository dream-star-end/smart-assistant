/**
 * Cross-Family T2 Audit Model Verification Gate.
 *
 * Mechanically verifies that T2 independent code audits are executed by a strong model
 * from a DIFFERENT model family than the development model:
 *   1. Both `devModel` and `auditModel` must resolve to a recognized platform model family
 *      (aligned directly with `packages/protocol/src/engineModels.ts` & `boxApiModels.ts`;
 *      fail-closed on unknown or dynamic-routing slugs such as `cursor-auto`).
 *   2. `auditModel` must NOT be a weak/lightweight model (reuses `WEAK_MODEL_SLUG_RE` from
 *      `scripts/check-no-silent-model-downgrade.ts` + T2 lightweight-tier patterns).
 *   3. `devFamily !== auditFamily` (hard-bans same-family self-review such as
 *      `gpt-6.2-sol` -> `gpt-6.2-astra` or `antigravity-orchestrator-carbon` -> `antigravity-gemini-4-carbon`).
 *
 * CLI safety:
 *   - `--receipt <json>` and `--dev-model`/`--audit-model` are strictly mutually exclusive
 *     (passing both fails closed with exit 2 so CLI args can never silently override a receipt).
 *
 * Model selection pool guidance (`memory/2026-11-04-delegate-model-pool.md`):
 *   - Developed by OpenAI GPT (`openai-gpt`) -> audit with `antigravity-gemini-4-carbon`
 *   - Developed by any other family          -> audit with `gpt-6.2-astra`
 *
 * Usage:
 *   npx tsx scripts/check-cross-family-audit.ts --dev-model <slug> --audit-model <slug>
 *   npx tsx scripts/check-cross-family-audit.ts --receipt <path/to/receipt.json>
 *
 * Exit: 0 ok, 1 policy violation (same-family / weak audit model / unknown family), 2 CLI/IO error.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BOX_API_MODELS } from '../packages/protocol/src/boxApiModels.js'
import {
  ANTIGRAVITY_ENGINE_MODELS,
  CODEX_ENGINE_MODELS,
  CURSOR_ENGINE_MODELS,
  GROK_ENGINE_MODELS,
  ZCODE_ENGINE_MODELS,
} from '../packages/protocol/src/engineModels.js'
import { WEAK_MODEL_SLUG_RE } from './check-no-silent-model-downgrade.js'

export const MODEL_FAMILIES = [
  'openai-gpt',
  'anthropic-claude',
  'google-gemini',
  'xai-grok',
  'deepseek',
  'moonshot-kimi',
  'zhipu-glm',
  'minimax',
  'qwen',
  'step',
  'mimo',
  'cursor-composer',
] as const
export type ModelFamily = (typeof MODEL_FAMILIES)[number]

export type CrossFamilyViolationCode =
  | 'CROSS-FAMILY-UNKNOWN-MODEL'
  | 'CROSS-FAMILY-WEAK-AUDIT-MODEL'
  | 'CROSS-FAMILY-SAME-FAMILY-AUDIT'

export interface CrossFamilyAuditResult {
  ok: boolean
  devModel: string
  auditModel: string
  devFamily: ModelFamily | null
  auditFamily: ModelFamily | null
  auditModelWeak: boolean
  recommendedAuditModel: string
  violations: Array<{
    code: CrossFamilyViolationCode
    message: string
  }>
}

/**
 * Strip platform routing/proxy prefixes (e.g. `antigravity-`, `box-api-`, `box-`,
 * `cursor-`, `zai-coding-plan/`, `openai/`, `anthropic/`, `google/`, `xai/`, etc.)
 * to expose the underlying model family stem.
 */
const ROUTING_PREFIX_RE =
  /^(?:box-api-|box-|antigravity-|cursor-|zai-coding-plan\/|openrouter\/|opencodego\/|ark\/|scnet\/|zai\/|bailian\/|openai[/-]|anthropic[/-]|google[/-]|xai[/-]|deepseek\/|moonshot\/|zhipu\/|minimax\/|qwen\/|stepfun\/|xiaomi\/)/i

/**
 * Additional T2 lightweight/fast-tier model patterns supplementing `WEAK_MODEL_SLUG_RE`
 * (avoiding false positives on `MiniMax-M3` or flagship slugs).
 */
const EXTRA_T2_WEAK_MODEL_RE =
  /^(?:grok-[a-z0-9._-]*fast(?:-[a-z0-9._-]+)?|composer-[a-z0-9._-]*fast(?:-[a-z0-9._-]+)?|(?:kimi|moonshot|mimo|step|minimax|qwen)[a-z0-9._-]*(?:flash|lite|mini|nano|fast|air|turbo)(?:-[a-z0-9._-]+)?|gpt-[a-z0-9._-]*(?:mini|nano)(?:-[a-z0-9._-]+)?|gemini-[a-z0-9._-]*(?:flash|lite|nano)(?:-[a-z0-9._-]+)?|claude-[a-z0-9._-]*haiku(?:-[a-z0-9._-]+)?|deepseek-[a-z0-9._-]*(?:flash|lite)(?:-[a-z0-9._-]+)?|glm-[a-z0-9._-]*(?:flash|air|lite)(?:-[a-z0-9._-]+)?)$/i

const FAMILY_RULES: ReadonlyArray<{ family: ModelFamily; pattern: RegExp }> = [
  { family: 'openai-gpt', pattern: /^(?:gpt(?:[-._\d]|$)|chatgpt-|o[134](?:[-._]|$)|codex(?:[-._]|$))/i },
  { family: 'anthropic-claude', pattern: /^(?:claude(?:[-._]|$)|opus-|sonnet-|haiku-|fable(?:[-._\d]|$))/i },
  { family: 'google-gemini', pattern: /^(?:gemini(?:[-._\d]|$)|orchestrator-(?:carbon|neon)(?:[-._]|$))/i },
  { family: 'xai-grok', pattern: /^grok(?:[-._\d]|$)/i },
  { family: 'deepseek', pattern: /^deepseek(?:[-._\d]|$)/i },
  { family: 'moonshot-kimi', pattern: /^(?:kimi|moonshot)(?:[-._\d]|$)/i },
  { family: 'zhipu-glm', pattern: /^(?:glm|chatglm)(?:[-._\d]|$)/i },
  { family: 'minimax', pattern: /^minimax(?:[-._\d]|$)/i },
  { family: 'qwen', pattern: /^(?:qwen|qwq)(?:[-._\d]|$)/i },
  { family: 'step', pattern: /^step(?:[-._\d]|$)/i },
  { family: 'mimo', pattern: /^mimo(?:[-._\d]|$)/i },
  { family: 'cursor-composer', pattern: /^composer(?:[-._\d]|$)/i },
]

/**
 * Canonical protocol alias -> underlying upstream model id map built directly from
 * `packages/protocol/src/engineModels.ts` and `boxApiModels.ts`.
 * `null` explicitly marks dynamic/unspecified routers (e.g. `cursor-auto`) that MUST fail closed.
 */
const CANONICAL_UPSTREAM_MAP: ReadonlyMap<string, string | null> = (() => {
  const map = new Map<string, string | null>()
  for (const m of CODEX_ENGINE_MODELS) {
    map.set(m.id.toLowerCase(), ('cliModel' in m ? m.cliModel : m.id).toLowerCase())
  }
  for (const m of ANTIGRAVITY_ENGINE_MODELS) {
    const cliModels = m.cliModels as Readonly<Record<string, string>>
    const upstream = cliModels[m.defaultEffort] ?? Object.values(cliModels)[0] ?? null
    map.set(m.id.toLowerCase(), upstream ? upstream.toLowerCase() : null)
  }
  for (const m of CURSOR_ENGINE_MODELS) {
    map.set(m.id.toLowerCase(), m.upstreamModel ? m.upstreamModel.toLowerCase() : null)
  }
  for (const m of GROK_ENGINE_MODELS) {
    map.set(m.id.toLowerCase(), m.upstreamModel.toLowerCase())
  }
  for (const m of ZCODE_ENGINE_MODELS) {
    map.set(m.id.toLowerCase(), m.upstreamModel.toLowerCase())
  }
  for (const m of BOX_API_MODELS) {
    map.set(m.id.toLowerCase(), m.upstreamModel.toLowerCase())
  }
  return map
})()

export function normalizeModelSlug(rawSlug: string): string {
  let s = rawSlug.trim().toLowerCase()
  const mapped = CANONICAL_UPSTREAM_MAP.get(s)
  if (mapped === null) {
    return ''
  }
  if (typeof mapped === 'string') {
    s = mapped
  }
  // Strip repeated routing prefixes (e.g. `openai/gpt-6.2-astra` or `zai-coding-plan/glm-5.3`)
  for (let i = 0; i < 4; i++) {
    const next = s.replace(ROUTING_PREFIX_RE, '')
    if (next === s) break
    s = next
  }
  return s
}

/** Resolve a platform model slug to its canonical model family, or `null` if unknown/dynamic. */
export function resolveModelFamily(rawSlug: string): ModelFamily | null {
  const trimmed = rawSlug.trim()
  if (!trimmed) return null
  const normalized = normalizeModelSlug(trimmed)
  if (!normalized) return null
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.family
    }
  }
  return null
}

/** Determine whether a model slug is a weak/lightweight model forbidden for T2 audits. */
export function isWeakAuditModel(rawSlug: string): boolean {
  const trimmed = rawSlug.trim()
  if (!trimmed) return false
  if (WEAK_MODEL_SLUG_RE.test(trimmed)) return true
  const normalized = normalizeModelSlug(trimmed)
  if (!normalized) return false
  if (WEAK_MODEL_SLUG_RE.test(normalized)) return true
  return EXTRA_T2_WEAK_MODEL_RE.test(normalized)
}

/** Return the recommended T2 audit model per `memory/2026-11-04-delegate-model-pool.md`. */
export function recommendAuditModelFor(devFamily: ModelFamily | null): string {
  return devFamily === 'openai-gpt' ? 'antigravity-gemini-4-carbon' : 'gpt-6.2-astra'
}

export function verifyCrossFamilyAudit(
  devModel: string,
  auditModel: string,
): CrossFamilyAuditResult {
  const devSlug = devModel.trim()
  const auditSlug = auditModel.trim()
  const devFamily = resolveModelFamily(devSlug)
  const auditFamily = resolveModelFamily(auditSlug)
  const auditModelWeak = isWeakAuditModel(auditSlug)
  const recommendedAuditModel = recommendAuditModelFor(devFamily)
  const violations: CrossFamilyAuditResult['violations'] = []

  if (devFamily === null) {
    violations.push({
      code: 'CROSS-FAMILY-UNKNOWN-MODEL',
      message: `unrecognized dev model family for slug ${JSON.stringify(devSlug)} (fail-closed)`,
    })
  }
  if (auditFamily === null) {
    violations.push({
      code: 'CROSS-FAMILY-UNKNOWN-MODEL',
      message: `unrecognized audit model family for slug ${JSON.stringify(auditSlug)} (fail-closed)`,
    })
  }
  if (auditModelWeak) {
    violations.push({
      code: 'CROSS-FAMILY-WEAK-AUDIT-MODEL',
      message: `weak/lightweight model ${JSON.stringify(auditSlug)} is forbidden for T2 independent audit`,
    })
  }
  if (devFamily !== null && auditFamily !== null && devFamily === auditFamily) {
    violations.push({
      code: 'CROSS-FAMILY-SAME-FAMILY-AUDIT',
      message: `same-family T2 audit forbidden: devModel=${JSON.stringify(devSlug)} (${devFamily}) and auditModel=${JSON.stringify(auditSlug)} (${auditFamily}) belong to the same family`,
    })
  }

  return {
    ok: violations.length === 0,
    devModel: devSlug,
    auditModel: auditSlug,
    devFamily,
    auditFamily,
    auditModelWeak,
    recommendedAuditModel,
    violations,
  }
}

export function extractModelsFromReceipt(raw: unknown): { devModel: string; auditModel: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('receipt must be a JSON object')
  }
  const obj = raw as Record<string, unknown>
  const devCand =
    obj.devModel ?? obj.dev_model ?? obj.developerModel ?? obj.developer_model ?? obj.authorModel
  const auditCand =
    obj.auditModel ??
    obj.audit_model ??
    obj.auditorModel ??
    obj.auditor_model ??
    obj.reviewerModel ??
    obj.reviewer_model
  if (typeof devCand !== 'string' || !devCand.trim()) {
    throw new Error('receipt is missing non-empty string field `devModel` / `dev_model`')
  }
  if (typeof auditCand !== 'string' || !auditCand.trim()) {
    throw new Error('receipt is missing non-empty string field `auditModel` / `audit_model`')
  }
  return { devModel: devCand.trim(), auditModel: auditCand.trim() }
}

export function formatCrossFamilyError(res: CrossFamilyAuditResult): string {
  const lines: string[] = []
  for (const v of res.violations) {
    lines.push(`[GATE-ERROR] ${v.code}: ${v.message}`)
  }
  lines.push(
    `  Observed: dev=${JSON.stringify(res.devModel)} (${res.devFamily ?? 'UNKNOWN'}) vs audit=${JSON.stringify(res.auditModel)} (${res.auditFamily ?? 'UNKNOWN'})`,
  )
  lines.push('  Model pool guidance (memory/2026-11-04-delegate-model-pool.md):')
  lines.push(
    '    - GPT development (openai-gpt) -> use `antigravity-gemini-4-carbon` for T2 audit',
  )
  lines.push('    - All other families           -> use `gpt-6.2-astra` for T2 audit')
  lines.push(`  Recommended T2 audit model for this change: ${res.recommendedAuditModel}`)
  return lines.join('\n')
}

function main(argv: string[]): number {
  let devModel: string | undefined
  let auditModel: string | undefined
  let receiptPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dev-model') {
      const v = argv[++i]
      if (!v) {
        console.error('[cross-family-audit] --dev-model requires a model slug')
        return 2
      }
      devModel = v
    } else if (arg === '--audit-model') {
      const v = argv[++i]
      if (!v) {
        console.error('[cross-family-audit] --audit-model requires a model slug')
        return 2
      }
      auditModel = v
    } else if (arg === '--receipt') {
      const v = argv[++i]
      if (!v) {
        console.error('[cross-family-audit] --receipt requires a JSON file path')
        return 2
      }
      receiptPath = v
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: npx tsx scripts/check-cross-family-audit.ts (--dev-model <slug> --audit-model <slug> | --receipt <file.json>)',
      )
      return 0
    } else {
      console.error(`[cross-family-audit] unknown arg: ${arg}`)
      return 2
    }
  }

  // Strict mutual exclusion: CLI flags must never silently override a receipt file
  if (receiptPath !== undefined && (devModel !== undefined || auditModel !== undefined)) {
    console.error(
      '[cross-family-audit] FAIL-CLOSED: --receipt is mutually exclusive with --dev-model and --audit-model',
    )
    return 2
  }

  try {
    if (receiptPath) {
      const abs = path.resolve(receiptPath)
      if (!existsSync(abs)) {
        console.error(`[cross-family-audit] FAIL-CLOSED: receipt file not found: ${abs}`)
        return 2
      }
      const parsed: unknown = JSON.parse(readFileSync(abs, 'utf8'))
      const extracted = extractModelsFromReceipt(parsed)
      devModel = extracted.devModel
      auditModel = extracted.auditModel
    }

    if (!devModel || !auditModel) {
      console.error(
        '[cross-family-audit] provide both --dev-model and --audit-model, or --receipt <json>',
      )
      return 2
    }

    const res = verifyCrossFamilyAudit(devModel, auditModel)
    if (!res.ok) {
      console.error(formatCrossFamilyError(res))
      return 1
    }

    console.log(
      `[cross-family-audit] ok: dev=${res.devModel} (${res.devFamily}) -> audit=${res.auditModel} (${res.auditFamily})`,
    )
    return 0
  } catch (err) {
    console.error(`[cross-family-audit] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
