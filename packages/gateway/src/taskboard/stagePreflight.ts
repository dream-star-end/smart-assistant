import {
  AGENT_MODEL_AUTO,
  assertIdentityCompatReady,
  resolveIdentityCompat,
} from '@openclaude/protocol'
import {
  type AgentsConfig,
  fetchIdentityCompatProjection,
  resolveRuntimeExecutionAgent,
} from '@openclaude/storage'
import { isHiddenSystemAgentId } from '../agentVisibility.js'
import { DELEGATE_DEFAULT_PREFERRED_MODELS } from '../delegatePolicy.js'
import { resolveLocalExecutionIfEnforced } from '../localExecution.js'
import { isEngineLocalTurnExempt } from '../modelAuthority.js'
import { ModelCatalogUnavailableError } from '../modelCatalogClient.js'
import type { PipelineStage } from './domain.js'

export type TaskboardExecutionSpec = Pick<PipelineStage, 'kind' | 'agentId' | 'model'>
export type TaskboardStageIssue = {
  code: 'stage_agent_unavailable' | 'stage_model_unavailable' | 'execution_preflight_unavailable'
  message: string
  status: 422 | 503
}
export type TaskboardPreflight = (
  stages: readonly TaskboardExecutionSpec[],
) => Promise<readonly (TaskboardStageIssue | null)[]>

export class TaskboardPreflightError extends Error {
  constructor(readonly issue: TaskboardStageIssue) {
    super(issue.message)
    this.name = 'TaskboardPreflightError'
  }
}

const unavailable = (): TaskboardStageIssue => ({
  code: 'execution_preflight_unavailable',
  status: 503,
  message: '暂时无法核验执行助手，请稍后重试',
})
const missingAgent = (id?: string | null): TaskboardStageIssue => ({
  code: 'stage_agent_unavailable',
  status: 422,
  message: id
    ? `执行助手 ${id} 不可用，请在流程设置中重新选择已安装助手`
    : '请先在流程设置中选择执行助手',
})

/** Read-only: one authenticated identity/config read per batch, no admission or runner. */
export function createTaskboardPreflight(deps: {
  catalog?: import('../gatewayRuntimeServices.js').CatalogRuntimePort
  getAgentsConfig: () => Promise<AgentsConfig>
  defaultModel?: string | null
  getIdentityProjection?: typeof fetchIdentityCompatProjection
  resolveIdentityAgent?: typeof resolveRuntimeExecutionAgent
  resolveExecution?: typeof resolveLocalExecutionIfEnforced
  env?: NodeJS.ProcessEnv
}): TaskboardPreflight {
  return async (stages) => {
    const base = stages.map((stage) =>
      stage.kind !== 'ai'
        ? null
        : !stage.agentId?.trim() || isHiddenSystemAgentId(stage.agentId)
          ? missingAgent(stage.agentId)
          : null,
    )
    if (!stages.some((stage, index) => stage.kind === 'ai' && !base[index])) return base
    let cfg: AgentsConfig
    let projection: Awaited<ReturnType<typeof fetchIdentityCompatProjection>>
    try {
      ;[cfg, projection] = await Promise.all([
        deps.getAgentsConfig(),
        (deps.getIdentityProjection ?? fetchIdentityCompatProjection)(),
      ])
    } catch {
      return stages.map(
        (stage, index) => base[index] ?? (stage.kind === 'ai' ? unavailable() : null),
      )
    }
    const checked = new Map<string, Promise<TaskboardStageIssue | null>>()
    const env = deps.env ?? process.env
    const check = async (stage: TaskboardExecutionSpec): Promise<TaskboardStageIssue | null> => {
      const id = stage.agentId!
      const identity = projection ? resolveIdentityCompat(id, projection) : undefined
      try {
        if (identity) assertIdentityCompatReady(identity)
      } catch {
        return missingAgent(id)
      }
      const canonicalId = identity?.executionAgentId ?? id
      if (isHiddenSystemAgentId(canonicalId)) return missingAgent(id)
      let agent = cfg.agents.find((candidate) => candidate.id === canonicalId)
      if (!agent) return missingAgent(id)
      if (identity?.profile) {
        try {
          agent = (
            await (deps.resolveIdentityAgent ?? resolveRuntimeExecutionAgent)(
              agent,
              cfg,
              projection,
            )
          ).agent
        } catch {
          return missingAgent(id)
        }
      }
      const agentDefault = agent.model && agent.model !== AGENT_MODEL_AUTO ? agent.model : undefined
      const requestedModel = stage.model || agentDefault
      try {
        await (deps.resolveExecution ?? resolveLocalExecutionIfEnforced)({
          ...(deps.catalog ? { catalog: deps.catalog } : {}),
          agent: requestedModel ? { ...agent, model: requestedModel } : agent,
          kind: 'turn',
          model: requestedModel,
          defaultModel: deps.defaultModel,
          preferredModels:
            !requestedModel && isEngineLocalTurnExempt(env)
              ? DELEGATE_DEFAULT_PREFERRED_MODELS
              : undefined,
          env,
        })
      } catch (error) {
        return error instanceof ModelCatalogUnavailableError
          ? unavailable()
          : {
              code: 'stage_model_unavailable',
              status: 422,
              message: '阶段绑定的模型当前不可执行，请在流程设置中检查助手和模型',
            }
      }
      return null
    }
    return Promise.all(
      stages.map((stage, index) => {
        if (base[index] || stage.kind !== 'ai') return base[index]
        const key = JSON.stringify([stage.agentId, stage.model])
        let result = checked.get(key)
        if (!result) {
          result = check(stage)
          checked.set(key, result)
        }
        return result
      }),
    )
  }
}

export async function checkTaskboardStages(
  check: TaskboardPreflight | undefined,
  stages: readonly TaskboardExecutionSpec[],
): Promise<readonly (TaskboardStageIssue | null)[]> {
  if (!stages.some((stage) => stage.kind === 'ai')) return stages.map(() => null)
  if (!check) throw new TaskboardPreflightError(unavailable())
  const issues = await check(stages)
  if (!Array.isArray(issues) || issues.length !== stages.length)
    throw new TaskboardPreflightError(unavailable())
  for (const issue of issues) {
    if (
      issue !== null &&
      (!issue || typeof issue.message !== 'string' || ![422, 503].includes(issue.status))
    )
      throw new TaskboardPreflightError(unavailable())
  }
  return issues
}

export async function assertTaskboardStagesRunnable(
  check: TaskboardPreflight | undefined,
  stages: readonly TaskboardExecutionSpec[],
): Promise<void> {
  const issues = await checkTaskboardStages(check, stages)
  const issue = issues.find((value) => value !== null)
  if (issue) throw new TaskboardPreflightError(issue)
}
