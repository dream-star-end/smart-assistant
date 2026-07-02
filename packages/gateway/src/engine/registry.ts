/**
 * registry — Engine 注册表 + factory(sessionManager.getOrCreate 的唯一收口)。
 *
 * 单一权威:model→engine 映射 + agentDef.provider 显式 pin,两者都在
 * `resolveEngine` 一处判定(与 resolveExecutionModel 同点收口 —— "白名单只拦
 * 入站帧、agent.model 绕过"的教训,见 v3-v5-claude-models-retired)。
 *
 * v5 硬闸语义升级(原 sessionManager.ts:1266 的 channel 判定):
 *   旧:v5 channel + provider='codex-native' → throw(其余 channel 静默落 CCB)
 *   新:resolveEngine 判定出的 engineId 未在注册表注册 → `createEngine` 一律
 *       fail-closed 抛错,不分 channel。M0 阶段 codex 未注册,v5 行为等价旧硬闸;
 *       且比旧实现更严 —— 任何 channel 都不会把 codex-native agent 误落到 CCB。
 *   codex-native 内部再按 runnerKind 收口:仅接受缺省 / 'app-server';
 *   'exec' 与未知 runnerKind 直接 fail-closed('codex exec' legacy 路径不复活)。
 */
import type { AgentDef } from '@openclaude/storage'
import type { SubprocessRunnerOpts } from '../subprocessRunner.js'
import type { EngineAdapter } from './engineAdapter.js'

/**
 * Engine factory 入参。M0 直接沿用 SubprocessRunnerOpts 的形状 —— 这些字段
 * (sessionKey/agentId/model/persona/mcp/toolsets/resume/effort/repo/…)本身就是
 * engine 中立的 spawn 语境,CCB 之外的底座各取所需。M1 若有 codex 专属项再泛化。
 */
export type EngineCreateOpts = SubprocessRunnerOpts

export type EngineFactory = (opts: EngineCreateOpts) => EngineAdapter

const engineFactories = new Map<string, EngineFactory>()

export function registerEngine(engineId: string, factory: EngineFactory): void {
  engineFactories.set(engineId, factory)
}

/** 已注册 engine 清单(诊断/测试用)。 */
export function registeredEngines(): string[] {
  return [...engineFactories.keys()]
}

/**
 * model → engine 映射(单一权威)。M1a 起登记 gpt-5.5 → 'codex'(app-server 形态,
 * factory 由 engine/codexAdapter.ts 注册)。入站帧的模型合法性仍由
 * ALLOWED_INBOUND_MODELS / resolveExecutionModel 收口(server.ts),本表只回答
 * "合法模型跑哪个底座";新增 codex 系模型在此登记即可,不散点 if/else。
 */
const MODEL_ENGINE_MAP: Record<string, string> = {
  'gpt-5.5': 'codex',
}

/**
 * 判定该 agent/model 应由哪个 engine 执行。只判定 id,不校验注册表 ——
 * fail-closed 收在 `createEngine`(判定与构造分离,便于测试)。
 */
export function resolveEngine(
  model: string | undefined,
  agent: Pick<AgentDef, 'id' | 'provider' | 'runnerKind'>,
): string {
  if (agent.provider === 'codex-native') {
    // 仅 app-server 形态(缺省视为 app-server);'exec' legacy 路径不复活,
    // 未知 runnerKind 同样 fail-closed —— 防配置 typo 静默落错底座。
    if (agent.runnerKind !== undefined && agent.runnerKind !== 'app-server') {
      throw new Error(
        `[engine] codex-native agent '${agent.id}' runnerKind '${agent.runnerKind}' not supported — fail-closed (only 'app-server')`,
      )
    }
    return 'codex'
  }
  return (model && MODEL_ENGINE_MAP[model]) || 'ccb'
}

/** 构造 engine adapter。未注册 engine → fail-closed 抛错(v5 硬闸的升级形态)。 */
export function createEngine(engineId: string, opts: EngineCreateOpts): EngineAdapter {
  const factory = engineFactories.get(engineId)
  if (!factory) {
    throw new Error(
      `[engine] no adapter registered for engine '${engineId}' — fail-closed (registered: ${registeredEngines().join(', ') || 'none'})`,
    )
  }
  return factory(opts)
}
