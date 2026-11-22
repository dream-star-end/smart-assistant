/**
 * Explicit model & effort resolution for Cron jobs (OCV5-825).
 *
 * Red lines:
 *  1. NEVER silently downgrade or substitute a cron job's intended model
 *     (whether from `job.model`, bound `agent.model`, or `config.defaults.model`)
 *     to another model such as `deepseek-v4-flash`.
 *  2. Only fall back to the platform default when NO model was specified
 *     (all of job/agent/config are omitted or `'auto'`).
 *  3. Reject engines that require a master-issued per-turn relay route
 *     (`antigravity`, `grok`, `zcode`) BEFORE consuming execution durability
 *     even when `OC_SELFHOST_ENGINE_LOCAL_TURNS=1`.
 *  4. Reject `resume='origin-session'` combined with explicit `model`/`effort`,
 *     because origin-session inherits the conversation's active model/effort.
 */
import {
  AGENT_MODEL_AUTO,
  PLATFORM_REASONING_EFFORTS,
  isAntigravityEngineModel,
  isCodexEngineModel,
  isCursorEngineModel,
  isGrokEngineModel,
  isZcodeEngineModel,
} from '@openclaude/protocol'
import type { AgentDef } from '@openclaude/storage'
import { ALLOWED_INBOUND_MODELS } from './delegatePolicy.js'
import {
  resolveExecutionModel,
  resolveLocalExecutionIfEnforced,
  type LocalExecutionDecision,
} from './localExecution.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import { localExecutionRejectCode } from './modelCatalogClient.js'

const ALLOWED_EFFORT_SET = new Set<string>(PLATFORM_REASONING_EFFORTS)
const MAX_MODEL_SLUG_LEN = 128

export const CRON_ORIGIN_MODEL_CONFLICT_MESSAGE =
  '续轮原会话 (origin-session) 自动继承原对话模型与档位，不支持同时指定 model 或 effort'

/**
 * Engines whose adapter hard-requires a master-issued per-turn relay route
 * (`setAntigravityRoute` / `setGrokRoute` / `setZcodeRoute`) that isolated
 * background cron turns cannot supply.
 */
export const CRON_MASTER_ROUTE_REQUIRED_ENGINES = new Set<string>(['antigravity', 'grok', 'zcode'])

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

/**
 * Returns a human-readable error message when an `origin-session` cron job
 * also specifies `model` or `effort`; otherwise `null`.
 */
export function checkCronOriginModelConflict(job: {
  resume?: string
  model?: unknown
  effort?: unknown
}): string | null {
  if (job.resume !== 'origin-session') return null
  const hasModel = typeof job.model === 'string' && job.model.trim().length > 0
  const hasEffort = typeof job.effort === 'string' && job.effort.trim().length > 0
  if (hasModel || hasEffort) return CRON_ORIGIN_MODEL_CONFLICT_MESSAGE
  return null
}

function normalizeIntendedModel(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed === AGENT_MODEL_AUTO) return undefined
  return trimmed
}

function masterRouteRequiredEngineOf(model: string): 'antigravity' | 'grok' | 'zcode' | null {
  if (isAntigravityEngineModel(model)) return 'antigravity'
  if (isGrokEngineModel(model)) return 'grok'
  if (isZcodeEngineModel(model)) return 'zcode'
  return null
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
  const explicitJobModel = normalizeIntendedModel(modelCheck.value)
  const explicitEffort = effortCheck.value

  // B2: Resolve the authoritative intended model (job -> agent -> config) FIRST.
  // Once an explicit intent exists at any layer, validate that exact model rather
  // than letting a retired/unroutable binding fall through into a fallback ladder.
  const agentIntendedModel = normalizeIntendedModel(args.agent.model)
  const configDefaultModel = normalizeIntendedModel(args.defaultModel)
  const intendedModel = explicitJobModel ?? agentIntendedModel ?? configDefaultModel
  const intendedSource: 'job' | 'agent' | 'config' | 'none' = explicitJobModel
    ? 'job'
    : agentIntendedModel
      ? 'agent'
      : configDefaultModel
        ? 'config'
        : 'none'

  if (isModelAuthorityRequired(env)) {
    try {
      // Pass `intendedModel` as explicit `model` so decideLocalExecution strictly
      // verifies it against the projection instead of falling back to deepseek-v4-flash.
      const decision = await resolveLocalExecutionIfEnforced({
        agent: args.agent,
        kind: 'turn',
        model: intendedModel,
        defaultModel: args.defaultModel,
        env,
      })
      if (decision && CRON_MASTER_ROUTE_REQUIRED_ENGINES.has(decision.engine)) {
        return {
          ok: false,
          code: 'CRON_ENGINE_ROUTE_REQUIRED',
          message:
            `Cron job "${args.jobId}" targets model "${decision.canonicalModel}" ` +
            `(${decision.engine} engine), which requires a master-issued interactive ` +
            `turn route unavailable to background cron turns. Please configure a ` +
            `supported model explicitly.`,
          retryable: false,
        }
      }
      return {
        ok: true,
        model: decision?.canonicalModel ?? explicitJobModel,
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

  // Flag-off path: strictly validate intended model when present (no silent
  // ladder fallback for retired/unknown job, agent, or config models).
  let effectiveModel: string
  if (intendedModel !== undefined) {
    if (!ALLOWED_INBOUND_MODELS.has(intendedModel)) {
      return {
        ok: false,
        code: intendedSource === 'job' ? 'DELEGATE_MODEL_UNKNOWN' : 'CRON_MODEL_UNAVAILABLE',
        message:
          `Cron job "${args.jobId}" targets ${intendedSource} model "${intendedModel}", ` +
          `which is unavailable or retired. Please update the cron job or agent model ` +
          `explicitly instead of silent downgrade.`,
        retryable: false,
      }
    }
    effectiveModel = intendedModel
  } else {
    // Only when no job/agent/config model was specified (or all were 'auto').
    effectiveModel = resolveExecutionModel(undefined, undefined)
  }

  // B3: Reject engines whose adapters hard-require a master-issued per-turn route
  // BEFORE execution (even if OC_SELFHOST_ENGINE_LOCAL_TURNS=1 is set).
  const routeRequiredEngine = masterRouteRequiredEngineOf(effectiveModel)
  if (routeRequiredEngine) {
    return {
      ok: false,
      code: 'CRON_ENGINE_ROUTE_REQUIRED',
      message:
        `Cron job "${args.jobId}" targets model "${effectiveModel}" ` +
        `(${routeRequiredEngine} engine), which requires a master-issued interactive ` +
        `turn route unavailable to background cron turns. Please configure a ` +
        `supported model explicitly.`,
      retryable: false,
    }
  }

  const needsEngineExemption =
    args.agent.provider === 'codex-native' ||
    isCodexEngineModel(effectiveModel) ||
    isCursorEngineModel(effectiveModel)

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
    model: explicitJobModel,
    effort: explicitEffort,
  }
}
