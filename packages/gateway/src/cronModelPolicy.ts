/**
 * Explicit model & effort resolution for Cron jobs (OCV5-825).
 *
 * Red line: NEVER silently downgrade a cron job's model (e.g. swapping a Codex
 * agent/job to deepseek-v4-flash behind the user's back).
 *
 * Behavior:
 *  - Optional per-job `model` and `effort` are honored explicitly (backward
 *    compatible with legacy cron.yaml / JSON jobs that omit both fields).
 *  - When `OC_MODEL_AUTHORITY` is enforced, uses `kind: 'turn'` (never
 *    `'synthetic'`), so selfhost (`OC_SELFHOST_ENGINE_LOCAL_TURNS=1`) runs the
 *    exact requested strong model (including Codex/Antigravity/etc.), while
 *    non-exempt commercial environments fail closed with an explicit readable
 *    error instead of silently substituting a different model.
 *  - When `OC_MODEL_AUTHORITY` is off, validates explicit slugs and rejects
 *    non-CCB engines that lack local-turn exemption with a clear, actionable
 *    error rather than silently downgrading.
 */
import {
  PLATFORM_REASONING_EFFORTS,
  isAntigravityEngineModel,
  isCodexEngineModel,
  isCursorEngineModel,
  isGrokEngineModel,
  isZcodeEngineModel,
} from '@openclaude/protocol'
import type { AgentDef } from '@openclaude/storage'
import { assertKnownExplicitDelegateModel } from './delegatePolicy.js'
import {
  resolveExecutionModel,
  resolveLocalExecutionIfEnforced,
  type LocalExecutionDecision,
} from './localExecution.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import { localExecutionRejectCode } from './modelCatalogClient.js'

const ALLOWED_EFFORT_SET = new Set<string>(PLATFORM_REASONING_EFFORTS)
const MAX_MODEL_SLUG_LEN = 128

export type CronFieldValidation =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string }

export function normalizeCronModelField(raw: unknown): CronFieldValidation {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, error: 'model must be a string' }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: undefined }
  if (trimmed.length > MAX_MODEL_SLUG_LEN || /\s/.test(trimmed)) {
    return { ok: false, error: `invalid model "${trimmed.slice(0, 40)}"` }
  }
  return { ok: true, value: trimmed }
}

export function normalizeCronEffortField(raw: unknown): CronFieldValidation {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, error: 'effort must be a string' }
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return { ok: true, value: undefined }
  if (!ALLOWED_EFFORT_SET.has(trimmed)) {
    return {
      ok: false,
      error: `invalid effort "${trimmed}": must be one of ${PLATFORM_REASONING_EFFORTS.join(', ')}`,
    }
  }
  return { ok: true, value: trimmed }
}

export type CronModelResolution =
  | {
      ok: true
      model?: string
      effort?: string
      execution?: LocalExecutionDecision
    }
  | {
      ok: false
      code: string
      message: string
      retryable: boolean
    }

function isNonCcbModel(model: string): boolean {
  return (
    isCodexEngineModel(model) ||
    isGrokEngineModel(model) ||
    isCursorEngineModel(model) ||
    isZcodeEngineModel(model) ||
    isAntigravityEngineModel(model)
  )
}

export async function resolveCronJobExecution(args: {
  jobId: string
  explicitModel?: string
  explicitEffort?: string
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>
  defaultModel?: string | null
  env?: NodeJS.ProcessEnv
}): Promise<CronModelResolution> {
  const env = args.env ?? process.env
  const modelCheck = normalizeCronModelField(args.explicitModel)
  if (!modelCheck.ok) {
    return {
      ok: false,
      code: 'CRON_MODEL_INVALID',
      message: `Cron job "${args.jobId}" has invalid model: ${modelCheck.error}`,
      retryable: false,
    }
  }
  const effortCheck = normalizeCronEffortField(args.explicitEffort)
  if (!effortCheck.ok) {
    return {
      ok: false,
      code: 'CRON_EFFORT_INVALID',
      message: `Cron job "${args.jobId}" has invalid effort: ${effortCheck.error}`,
      retryable: false,
    }
  }
  const explicitModel = modelCheck.value
  const explicitEffort = effortCheck.value

  if (isModelAuthorityRequired(env)) {
    try {
      // Use kind='turn' (never 'synthetic') so decideLocalExecution NEVER
      // silently downgrades Codex/non-CCB models to deepseek-v4-flash.
      const decision = await resolveLocalExecutionIfEnforced({
        agent: args.agent,
        kind: 'turn',
        model: explicitModel,
        defaultModel: args.defaultModel,
        env,
      })
      return {
        ok: true,
        model: decision?.canonicalModel ?? explicitModel,
        effort: explicitEffort,
        execution: decision,
      }
    } catch (err) {
      const code = localExecutionRejectCode(err)
      if (!code) throw err
      const detail = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        code,
        message: detail,
        retryable: code === 'MODEL_CATALOG_UNAVAILABLE',
      }
    }
  }

  // Flag-off path: validate explicit model slug and fail explicitly (never
  // silently substitute a weaker model) when a non-CCB engine lacks local-turn
  // billing exemption.
  if (explicitModel) {
    try {
      assertKnownExplicitDelegateModel(explicitModel)
    } catch (err) {
      const code = localExecutionRejectCode(err)
      if (!code) throw err
      return {
        ok: false,
        code,
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      }
    }
  }

  const effectiveModel = resolveExecutionModel(
    explicitModel ?? args.agent.model,
    args.defaultModel,
    undefined,
    explicitModel ? { explicit: true } : undefined,
  )
  const needsEngineExemption =
    args.agent.provider === 'codex-native' || isNonCcbModel(effectiveModel)

  if (needsEngineExemption && !isEngineLocalTurnExempt(env)) {
    return {
      ok: false,
      code: 'CRON_ENGINE_UNSUPPORTED',
      message:
        `Cron job "${args.jobId}" resolved to model "${effectiveModel}" ` +
        `whose engine cannot run background cron turns without interactive billing ` +
        `(or OC_SELFHOST_ENGINE_LOCAL_TURNS=1). Please set an explicit supported ` +
        `model on this cron job instead of silent downgrade.`,
      retryable: false,
    }
  }

  return {
    ok: true,
    model: explicitModel,
    effort: explicitEffort,
  }
}
