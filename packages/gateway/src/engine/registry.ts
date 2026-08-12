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
import { CODEX_ENGINE_MODEL_IDS, GROK_ENGINE_MODEL_IDS } from '@openclaude/protocol'
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
 * model → engine 映射。M1a 起登记 gpt-5.5 → 'codex'(app-server 形态,factory 由
 * engine/codexAdapter.ts 注册)。入站帧的模型合法性仍由 ALLOWED_INBOUND_MODELS /
 * resolveExecutionModel 收口(server.ts),本表只回答"合法模型跑哪个底座"。
 *
 * P0 计费旁路封堵:codex 系模型集合的单一权威上收到
 * `@openclaude/protocol` CODEX_ENGINE_MODEL_IDS(master bridge 的 codex turn
 * 分类必须与本判定同构,两处不允许各自硬编码)。新增 codex 系模型改 protocol
 * 一处即可,本表机械派生。
 */
const MODEL_ENGINE_MAP: Record<string, string> = Object.fromEntries(
  [
    ...CODEX_ENGINE_MODEL_IDS.map((id) => [id, 'codex'] as const),
    ...GROK_ENGINE_MODEL_IDS.map((id) => [id, 'grok'] as const),
  ],
)

/**
 * master 权威在 engine 判定上的**覆盖入参**。两个来源、同一形状:
 *
 *   - `'bridge_signed'`:bridge turn 的签名 execution descriptor(方案 §2);
 *   - `'local_catalog'`:本地路径(cron/synthetic/delegate/wechat/prewarm)从 master
 *     catalog 投影现取的判定(方案 §3)。
 *
 * 两者都是 **master 的判定结果**,对 engine 判定等权 —— 区别只在投递方式(签名 envelope
 * vs 容器现拉投影),所以 registry 不区分。形状故意只取 engine + canonicalModel:registry
 * 不需要认识整个 descriptor。有它 → 本地 baked MODEL_ENGINE_MAP 一律不看。
 */
export interface EngineAuthorityOverride {
  readonly engine: 'ccb' | 'codex' | 'grok'
  readonly canonicalModel: string
  /** 诊断/审计用(不参与判定)。 */
  readonly source?: 'bridge_signed' | 'local_catalog'
}

/** engine 判定的 flag 门(托管 + `OC_MODEL_AUTHORITY=1` 时由 sessionManager 传入)。 */
export interface ResolveEngineOpts {
  /**
   * true → **必须**有 master 权威(签名 descriptor 或 local catalog 投影),否则拒。
   *
   * 这条是本批的"第二信任源"总闸:flag 开启后,容器镜像里 baked 的 MODEL_ENGINE_MAP
   * 不再是任何 turn 的判定源 —— 有权威就用权威,没权威就**不许跑**(不存在"回落 baked
   * 尽力跑"的第三分支,那正是 catalog 漂移 → 免费/越权执行的入口,R1-B1)。
   */
  readonly requireAuthority?: boolean
}

/**
 * 托管环境 + flag 开启,但这一路 runner 创建既没有签名 descriptor 也没有 catalog 投影。
 *
 * 这**不是**用户错误,而是**代码错误**:某个 runner 创建入口没有先取 catalog 投影
 * (server.ts `resolveLocalExecutionIfEnforced` / `_localExecOverride`)。之所以做成
 * fail-closed 抛错而不是静默回落 baked:回落 = 悄悄恢复第二信任源(执行/计费旁路),
 * 而抛错会在第一个 turn 就把漏掉的入口炸出来。**新增 runner 创建入口时看见这个错,
 * 就是提示你漏了 catalog 判定。**
 */
export class ModelAuthorityRequiredError extends Error {
  readonly code = 'MODEL_AUTHORITY_REQUIRED' as const
  constructor(detail: string) {
    super(`[engine] model authority required but absent — fail-closed (${detail})`)
    this.name = 'ModelAuthorityRequiredError'
  }
}

/**
 * 判定该 agent/model 应由哪个 engine 执行。只判定 id,不校验注册表 ——
 * fail-closed 收在 `createEngine`(判定与构造分离,便于测试)。
 *
 * **判定优先级(方案 §2/§3 判定单点化)**:
 *   0. `opts.requireAuthority`(托管 + flag 开)且**无** authority → 抛
 *      ModelAuthorityRequiredError。即:要么有签名 descriptor,要么有 local catalog
 *      投影,二者皆无 → 拒。baked 表在 flag 开启后不再是任何 turn 的判定源。
 *   1. `authority`(master 签名 descriptor **或** local catalog 投影)存在 → 它就是
 *      唯一权威。本地 baked 的 MODEL_ENGINE_MAP **不参与** —— 这正是本批次要消灭的
 *      第二信任源:容器自己查表会与 master 的 catalog 漂移(新模型/engine 迁移在两侧
 *      不同步生效)。
 *   2. 无 authority 且 flag 未开(个人版 / 过渡期)→ 现状 baked 判定,零变化。
 *
 * `agent.provider === 'codex-native'` 是 agent 级**硬 pin**。与 authority 冲突时
 * (pin=codex 而 master 判的是 ccb)**fail-closed 抛错**,不静默取任一侧:那是配置事故
 * (agent manifest 与 catalog 对该 agent 的模型认知不一致),静默降级会让计费(按 master
 * 的 engine 预扣)与执行(按 pin 落 codex)分裂 —— 正是 P0 计费旁路的形状。
 */
export function resolveEngine(
  model: string | undefined,
  agent: Pick<AgentDef, 'id' | 'provider' | 'runnerKind'>,
  authority?: EngineAuthorityOverride,
  opts?: ResolveEngineOpts,
): string {
  // 门 0 先于一切(含 codex-native pin):flag 开启后,**没有 master 权威就不判定**。
  // 放在 pin 分支之前是有意的 —— pin 会无条件返回 'codex',若让它先返回,一个漏接
  // catalog 的入口就能在 flag 开启后继续 spawn codex runner(= 本批要关的旁路)。
  if (opts?.requireAuthority === true && authority === undefined) {
    throw new ModelAuthorityRequiredError(
      `agent='${agent.id}' model='${model ?? '(default)'}' — local runner creation must first resolve the master catalog projection (server.ts resolveLocalExecutionIfEnforced)`,
    )
  }
  if (agent.provider === 'codex-native') {
    // 仅 app-server 形态(缺省视为 app-server);'exec' legacy 路径不复活,
    // 未知 runnerKind 同样 fail-closed —— 防配置 typo 静默落错底座。
    if (agent.runnerKind !== undefined && agent.runnerKind !== 'app-server') {
      throw new Error(
        `[engine] codex-native agent '${agent.id}' runnerKind '${agent.runnerKind}' not supported — fail-closed (only 'app-server')`,
      )
    }
    if (authority !== undefined && authority.engine !== 'codex') {
      throw new Error(
        `[engine] codex-native agent '${agent.id}' conflicts with signed authority ` +
          `(engine='${authority.engine}', model='${authority.canonicalModel}') — fail-closed`,
      )
    }
    return 'codex'
  }
  if (authority !== undefined) return authority.engine
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
