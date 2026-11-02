/**
 * Local-execution decisions and execution-model resolution
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-484); server.ts re-exports
 * these names, so importers are unchanged.
 */
import { join, resolve } from 'node:path'
import {
  isAntigravityEngineModel,
  isCodexEngineModel,
  isCursorEngineModel,
  isGrokEngineModel,
  isZcodeEngineModel,
} from '@openclaude/protocol'
import type { AgentDef } from '@openclaude/storage'
import { suggestDelegateModels } from './delegateModelCatalogPrompt.js'
import { ALLOWED_INBOUND_MODELS, assertKnownExplicitDelegateModel } from './delegatePolicy.js'
import { isHostRoutableStaticModel } from './hostStaticProviders.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import {
  type LocalCatalogView,
  LocalExecutionRejected,
  getLocalCatalogView,
} from './modelCatalogClient.js'
import type { LiveRunnerSessionView } from './server.js'

/**
 * 纯函数:给定 per-uid 投影 + 执行意图 → 本地路径判定(真值表实现体,便于单测)。
 *
 * 候选阶梯与 `resolveExecutionModel` **同形**(caller model → agent.model → config 默认 →
 * 平台兜底),只是"这个模型能不能跑"的判定从 baked 白名单换成 catalog 投影 —— 于是
 * "agent.model 是个已下线/未授权模型"这类存量情况仍然优雅降级到平台默认(不回归),
 * 而"catalog 里 disabled / 该 uid 无授权"的模型则被真正拦下(baked 白名单拦不住)。
 */
export function decideLocalExecution(args: {
  view: LocalCatalogView
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>
  /** caller 显式指定的模型(cron 降级模型 / skill-train 模型 / inbound frame.model)。 */
  model?: string
  /**
   * 无票 inbound 且该 sessionKey 已有存活 runner 时,runner 当前实际在跑的 model。
   * 插在 caller model 之后、agent.model 之前:有显式 model 仍以 caller 为准(用户换模型
   * / 签名票路径不走这里);没有显式 model 时先沿用会话,避免 agent 默认改判引擎。
   * 该沿用对所有 engine 生效(含 CCB/Codex),是有意的会话连续性,不只是 cursor 专用。
   */
  liveSessionModel?: string
  /**
   * 无票取样命中正在替换/关闭的 session 时由 caller 传入(如 session_replacing)。
   * 有值则不把 liveSessionModel 插入候选,但仍打回退 warn。
   */
  liveSessionSkipReason?: string
  /** config.defaults.model。 */
  defaultModel?: string | null
  /**
   * 无显式 model 时、插在 liveSessionModel 之后 / agent.model 之前的优先候选(delegate 默认
   * grok-build 优先)。不可路由 / 非 ccb 且未豁免的条目由候选循环静默跳过。
   */
  preferredModels?: readonly string[]
  kind: LocalTurnKind
  env?: NodeJS.ProcessEnv
  /** 沿用会话模型失败并回退时调用(dispatchInbound 接到 this.log.warn)。 */
  warn?: (message: string, fields?: Record<string, unknown>) => void
}): LocalExecutionDecision {
  const { view, agent, kind } = args
  const env = args.env ?? process.env

  // ① provider 硬 pin:engine 恒 codex,换模型无效 → 本地 turn 一律拒(prewarm 除外)。
  if (
    agent.provider === 'codex-native' &&
    kind !== 'prewarm' &&
    kind !== 'auto_dream' &&
    // selfhost 豁免门开着时放行(modelAuthority.isEngineLocalTurnExempt,代价说明见彼处)。
    !isEngineLocalTurnExempt(env)
  ) {
    throw new LocalExecutionRejected(
      'DELEGATE_CODEX_UNSUPPORTED',
      // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-484); pre-existing there
      `agent '${agent.id}' is pinned to the codex engine, which cannot run on a local ` +
        // biome-ignore lint/style/noUnusedTemplateLiteral: moved verbatim from server.ts (OCV5-484); pre-existing there
        `(non-bridge) turn: codex billing needs a master-minted request id. Run it from a chat turn.`,
    )
  }

  const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined
  if (explicitModel) {
    const canonical = view.canonicalize(explicitModel)
    if (!view.isRoutable(canonical) || view.resolve(canonical)?.engine == null) {
      // 自愈提示:只从**可路由**集合里挑近邻(不泄露不可用/无权限型号),仅作建议不自动替换。
      const suggestions = suggestDelegateModels(explicitModel, view.models)
      const hint =
        suggestions.length > 0
          ? ` 你是不是想填: ${suggestions.map((s) => `'${s}'`).join(' / ')}?`
          : ' 系统提示「委派可用型号」段列出了可填的精确 slug。'
      throw new LocalExecutionRejected(
        'DELEGATE_MODEL_UNKNOWN',
        `model '${explicitModel}' is not in the current catalog projection (not inherited).` +
          `${hint} model 只能填精确 catalog slug,不要猜或截短;不填则用成员绑定型号。`,
      )
    }
  }
  const forcedSkipReason =
    typeof args.liveSessionSkipReason === 'string' && args.liveSessionSkipReason !== ''
      ? args.liveSessionSkipReason
      : undefined
  const liveSessionModel =
    forcedSkipReason === undefined &&
    typeof args.liveSessionModel === 'string' &&
    args.liveSessionModel !== ''
      ? args.liveSessionModel
      : undefined
  const ticketlessReuse = explicitModel === undefined
  let liveSkipReason: string | undefined = forcedSkipReason
  if (ticketlessReuse && liveSessionModel && liveSkipReason === undefined) {
    liveSkipReason = liveSessionModelUnusableReason(view, liveSessionModel)
  }

  const decorate = (decision: LocalExecutionDecision): LocalExecutionDecision => {
    if (!ticketlessReuse) return decision
    if (!liveSessionModel && forcedSkipReason === undefined) return decision
    if (liveSessionModel) {
      const liveCanonical = view.canonicalize(liveSessionModel)
      if (decision.canonicalModel === liveCanonical && liveSkipReason === undefined) return decision
    }
    const reason =
      liveSkipReason ??
      (liveSessionModel !== undefined
        ? liveSessionModelUnusableReason(view, liveSessionModel)
        : undefined) ??
      forcedSkipReason ??
      'unroutable'
    args.warn?.(TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN, {
      liveModel: liveSessionModel,
      reason,
      fallbackModel: decision.canonicalModel,
    })
    return { ...decision, liveSessionFallback: { from: liveSessionModel ?? '', reason } }
  }

  // ② 候选阶梯:归一 → 投影可用性 → engine,三件事**全取投影**。
  // 无票 inbound 把存活 runner 的 model 插在 agent.model 之前;有显式 model 时不插入
  // (用户换模型 / 带 model 的普通消息行为不变)。
  const candidates = explicitModel
    ? [explicitModel]
    : [
        ticketlessReuse && liveSessionModel && liveSkipReason === undefined
          ? liveSessionModel
          : undefined,
        ...(args.preferredModels ?? []),
        agent.model,
        args.defaultModel,
        ...EXECUTION_MODEL_FALLBACK_ROUTE,
      ]
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw === '') continue
    const canonicalModel = view.canonicalize(raw)
    if (!view.isRoutable(canonicalModel)) continue // 未 active / 未授权 / 未知 → 下一档
    const descriptor = view.resolve(canonicalModel)
    const engine = descriptor?.engine
    if (engine === undefined || descriptor == null) continue
    if (engine === 'ccb')
      return decorate({ canonicalModel, engine, supportsVision: descriptor.supportsVision })

    // codex 意图(engine 取自投影,不看 baked)。
    if (kind === 'prewarm' || kind === 'auto_dream') {
      return decorate({ canonicalModel, engine, supportsVision: descriptor.supportsVision })
    }
    if (kind === 'turn') {
      // selfhost 豁免门(OC_SELFHOST_ENGINE_LOCAL_TURNS=1)未开 -> 结构化拒(现状)。
      if (!isEngineLocalTurnExempt(env)) {
        // 无票沿用的会话模型若是 cursor/codex/grok,生产环境不能本地跑 —— 跳过它
        // 回退原阶梯(与修之前「直接走 agent 默认」同形),不要把整条 turn 拒掉。
        const isLiveOnlyCandidate =
          ticketlessReuse &&
          liveSessionModel !== undefined &&
          raw === liveSessionModel &&
          raw !== agent.model
        if (isLiveOnlyCandidate) {
          liveSkipReason = liveSkipReason ?? 'engine_local_turn_not_exempt'
          continue
        }
        throw new LocalExecutionRejected(
          'DELEGATE_CODEX_UNSUPPORTED',
          // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-484); pre-existing there
          `model '${canonicalModel}' runs on the ${engine} engine, which cannot run on a local ` +
            // biome-ignore lint/style/noUnusedTemplateLiteral: moved verbatim from server.ts (OCV5-484); pre-existing there
            `(non-bridge) turn: engine-reported billing needs a master-minted request id.`,
        )
      }
      // 豁免门开 -> 按投影 engine 放行执行(单租户自用部署接受该 turn 不走 master
      // 计费编排:usage 不结算,仍落 event/usage log 与 durable tape)。
      return decorate({ canonicalModel, engine, supportsVision: descriptor.supportsVision })
    }
    return decorate(downgradeSyntheticCodex(view, canonicalModel, args.defaultModel, env))
  }

  if (ticketlessReuse && (liveSessionModel || forcedSkipReason)) {
    const reason =
      liveSkipReason ??
      (liveSessionModel !== undefined
        ? liveSessionModelUnusableReason(view, liveSessionModel)
        : undefined) ??
      forcedSkipReason ??
      'unroutable'
    args.warn?.(TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN, {
      liveModel: liveSessionModel,
      reason,
      fallbackModel: '',
    })
  }
  throw new LocalExecutionRejected(
    'MODEL_NOT_AVAILABLE',
    `no routable model for agent '${agent.id}' in the current model catalog projection`,
  )
}

/**
 * 本地路径判定入口(**所有无 envelope 的 runner 创建入口在创建前调它**)。
 *
 *   - flag 未开 → `undefined`(调用方走现状 baked 判定,行为零变化);
 *   - flag 开 → 取 catalog 投影(TTL 30s + 单飞 + LKG,见 modelCatalogClient)并判定;
 *       · 投影拉不到 → 抛 `ModelCatalogUnavailableError`(**拒新 turn**,无 baked 回落);
 *       · 真值表拒 → 抛 `LocalExecutionRejected`(结构化 code)。
 *
 * 调用方拿到 decision 后:把 `canonicalModel` **同时**喂给 `getOrCreate({model, executionAuthority})`
 * 和 `submit(model)` —— 两处同源,避免 spawn 用 A、路由字段用 B。
 */
export async function resolveLocalExecutionIfEnforced(args: {
  catalog?: import('./gatewayRuntimeServices.js').CatalogRuntimePort
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>
  kind: LocalTurnKind
  model?: string
  liveSessionModel?: string
  liveSessionSkipReason?: string
  /** catalog 投影拉完后再取样,缩小「读 runner → await catalog → getOrCreate」窗口。 */
  resolveLiveSessionModel?: () => string | undefined
  /** 与 resolveLiveSessionModel 同时、在 catalog 之后取样。 */
  resolveLiveSessionSkipReason?: () => string | undefined
  defaultModel?: string | null
  /** 见 decideLocalExecution.preferredModels(仅 delegate 默认路径传)。 */
  preferredModels?: readonly string[]
  env?: NodeJS.ProcessEnv
  warn?: (message: string, fields?: Record<string, unknown>) => void
}): Promise<LocalExecutionDecision | undefined> {
  const env = args.env ?? process.env
  const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined
  // Explicit unknown slug fail-loud is unconditional. Flag-off uses the baked
  // inbound set (no catalog I/O). Flag-on still uses catalog projection below
  // so catalog-only slugs are not rejected by the baked snapshot.
  if (explicitModel && !isModelAuthorityRequired(env)) {
    assertKnownExplicitDelegateModel(explicitModel)
  }
  if (!isModelAuthorityRequired(env)) return undefined
  const view = await (args.catalog ? args.catalog.getRoutingView() : getLocalCatalogView())
  const liveSessionModel = args.resolveLiveSessionModel?.() ?? args.liveSessionModel
  const liveSessionSkipReason = args.resolveLiveSessionSkipReason?.() ?? args.liveSessionSkipReason
  return decideLocalExecution({ ...args, liveSessionModel, liveSessionSkipReason, view, env })
}

/** decision → getOrCreate 的执行覆盖入参(flag 未开 → `{}`,展开后零影响)。 */
export function localExecutionOverride(decision: LocalExecutionDecision | undefined): {
  model?: string
  executionAuthority?: {
    canonicalModel: string
    engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
    source: 'local_catalog'
  }
} {
  if (!decision) return {}
  return {
    model: decision.canonicalModel,
    executionAuthority: {
      canonicalModel: decision.canonicalModel,
      engine: decision.engine,
      source: 'local_catalog',
    },
  }
}

/** 本地路径判定结果:该 turn 的 canonical 模型 + engine(= getOrCreate/submit 的同源入参)。 */
export interface LocalExecutionDecision {
  /** catalog 归一后的 canonical model id(alias 已解析)。 */
  readonly canonicalModel: string
  /** 取自投影的 engine(不查 baked MODEL_ENGINE_MAP)。 */
  readonly engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  readonly supportsVision: boolean
  /** 非空 = 发生了 codex → 非 codex 降级('synthetic' kind);原模型供透明披露(MAJOR-2)。 */
  readonly downgradedFrom?: string
  /**
   * 无票 inbound 试图沿用存活 runner 的 model,但 catalog 不可用/未授权/豁免门未开
   * 而回退到原阶梯时的说明。成功沿用或冷启动(没有 liveSessionModel)时缺省。
   */
  readonly liveSessionFallback?: { readonly from: string; readonly reason: string }
}

// ─── 本地路径(无 envelope)的执行判定 —— 方案 §3 真值表 ─────────────────────
//
// 谁走这里:cron / webhook / scheduled task / inter-agent / openai-compat / skill-train /
// skill-eval / delegate / wechat inbound / boot pre-warm —— 所有**不经 bridge 签发
// authority** 的 runner 创建入口。它们此前按容器镜像里 baked 的两张表判定
// (ALLOWED_INBOUND_MODELS / MODEL_ENGINE_MAP),那是 master 之外的**第二信任源**:
// 与 catalog 必然漂移(新模型 / engine 迁移 / 撤销授权在两侧不同步生效),漂移方向恰好是
// "容器以为自己能跑" = 免费或越权执行。本批把判定源换成 master 的 per-uid catalog 投影。
//
// 三条硬语义:
//   1. **flag 未开 → 一行不动**(resolveLocalExecutionIfEnforced 返回 undefined,调用方
//      走现状 baked 判定)。个人版 / 过渡期零变化。
//   2. **投影拉不到 → 拒新 turn**(ModelCatalogUnavailableError 上抛,无 baked 回落,R1-B1)。
//   3. **codex 意图按 kind 分岔**(§3 真值表):
//        - 'synthetic'(cron/webhook/task/inter-agent/openai-compat)→ 既有语义:**降级**
//          为非 codex 兜底模型(这些是进程内合成首帧,拿不到 master 铸的 server-owned
//          requestId,落 codex 必被 CODEX_BILLING_GUARD 拒;降级让 cron 照常跑);
//        - 'turn'(delegate / wechat 等真实本地 turn / skill-train / skill-eval)→ **拒**,
//          结构化 DELEGATE_CODEX_UNSUPPORTED。现状是同样跑不了(晚期被 billing guard 拒),
//          本批把它提前到**创建 runner 之前**并给出稳定错误码 —— 不静默换模型:用户/队长
//          明确点了 codex,悄悄换成别的模型执行并计费是更坏的答案;
//        - 'prewarm'(boot / hello 预热)→ **不适用 codex 策略**:预热不执行 turn、不计费,
//          engine/model 照样取投影(不查 baked),但允许 codex —— 真正的 turn 一定带 envelope
//          (bridge)或被上面两条拦住,且 CODEX_BILLING_GUARD 仍是最后一道闸。拒预热只会
//          让 codex 会话丢掉预热(UX 回退),换不到任何安全收益。
//   4. **provider pin('codex-native')的本地 turn → 一律拒**:model 替换救不了它
//      (resolveEngine 的 pin 恒判 codex),与 resolveSyntheticTurnModel 现状(返回 undefined
//      → 保持 fail-closed)同向,只是把"晚期 guard 拒"提前成结构化错误。

/** 本地路径的 turn 语义分类(决定 codex 意图怎么处理,见上方真值表)。 */
export type LocalTurnKind = 'synthetic' | 'turn' | 'prewarm' | 'auto_dream'

/**
 * 把 agent/config 级模型收敛到平台真实支持的集合。
 *
 * ALLOWED_INBOUND_MODELS 只拦**入站帧**;但 agent.model(marketplace manifest / seed /
 * delegate 委派)会**绕过入站校验**,在 SessionManager.getOrCreate 里直接作为 CCB `--model`
 * spawn。已下线模型(如某个 stale 已安装 agent 里残留的 claude-*)会让 CCB 用不可路由的
 * --model 启动 → spawn 失败 / session 卡死。runner 创建是唯一收口点,这里把任何不在白名单的
 * 模型降级到平台默认(glm-5.3-zai),使"Claude 官方模型下线"在 agent 级路径上也真正生效。
 */
export function resolveExecutionModel(
  preferred: string | undefined | null,
  fallback: string | undefined | null,
  /**
   * master 签名的执行权威(方案 §2)。存在 → **直接用 descriptor.canonicalModel**,
   * 不过 ALLOWED_INBOUND_MODELS 这张 baked 白名单。
   *
   * 为什么不能再过白名单:baked 白名单是容器镜像里的第二信任源。catalog 里新 staged→active
   * 的模型(镜像没这一版)会被它降级成 glm-5.3 —— master 按新模型预扣/签发,容器却跑
   * 另一个模型,计费与执行分裂。descriptor 已经是「master 唯一判定者」的产物(active +
   * 有价 + capability schema 可理解),再拿旧白名单去二次审判它,等于让旧快照否决新快照。
   */
  authority?: { canonicalModel: string },
  opts?: { explicit?: boolean },
): string {
  if (authority !== undefined) return authority.canonicalModel
  if (
    opts?.explicit &&
    typeof preferred === 'string' &&
    preferred !== '' &&
    !ALLOWED_INBOUND_MODELS.has(preferred)
  ) {
    const suggestions = suggestDelegateModels(
      preferred,
      [...ALLOWED_INBOUND_MODELS].map((modelId) => ({ modelId, available: true })),
    )
    const hint =
      suggestions.length > 0
        ? ` 你是不是想填: ${suggestions.map((s) => `'${s}'`).join(' / ')}?`
        : ' 系统提示「委派可用型号」段列出了可填的精确 slug。'
    throw new LocalExecutionRejected(
      'DELEGATE_MODEL_UNKNOWN',
      `unknown explicit delegate model '${preferred}' (not inherited).${hint} model 只能填精确 catalog slug,不要猜或截短。`,
    )
  }
  for (const m of [preferred, fallback, ...EXECUTION_MODEL_FALLBACK_ROUTE]) {
    if (typeof m === 'string' && ALLOWED_INBOUND_MODELS.has(m)) return m
  }
  return EXECUTION_MODEL_FALLBACK
}

/** 平台执行模型兜底:V5 当前合法的静态 key 平台默认。 */
export const EXECUTION_MODEL_FALLBACK_ROUTE = [
  'deepseek-v4-flash',
  'glm-5.3-zai',
  'MiniMax-M3',
] as const

export function resolveSyntheticTurnModel(
  agent: Pick<AgentDef, 'id' | 'model' | 'provider'>,
  defaultModel: string | undefined | null,
): SyntheticTurnModel | undefined {
  // 硬 pin 的 codex-native:model 替换无效(见 registry.resolveEngine),保持 fail-closed。
  if (agent.provider === 'codex-native') return undefined
  const effective = resolveExecutionModel(agent.model, defaultModel)
  if (
    !isCodexEngineModel(effective) &&
    !isGrokEngineModel(effective) &&
    !isCursorEngineModel(effective) &&
    !isZcodeEngineModel(effective) &&
    !isAntigravityEngineModel(effective)
  )
    return undefined
  const raw = process.env.OPENCLAUDE_SYNTHETIC_TURN_MODEL?.trim()
  // env 兜底自身必须**非 codex 且在入站白名单内**,否则忽略回默认 —— 防"把 bug 换个门再引入"
  // (例如误配成 gpt-5.5 又绕回 codex,或配一个会被 resolveExecutionModel 收敛掉的下线模型)。
  const candidate =
    raw &&
    ALLOWED_INBOUND_MODELS.has(raw) &&
    !isCodexEngineModel(raw) &&
    !isGrokEngineModel(raw) &&
    !isCursorEngineModel(raw) &&
    !isZcodeEngineModel(raw) &&
    !isAntigravityEngineModel(raw)
      ? raw
      : SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT
  // ── routable 自检(MAJOR-1)──────────────────────────────────────────────
  // 兜底模型必须在当前进程形态下真正可达:host 上走静态 provider 平台直连,若该 provider 的
  // 平台 key 未经 commercial seam 注入(缺配 / 个人版),换成 deepseek-v4-flash 也是必 401。此时
  // **不降级**,返回 undefined 让 CODEX_BILLING_GUARD 按原样 fail-closed(Codex 明确:闸的显式
  // 错误优于换一个必 401 的模型)。容器身份 isHostRoutableStaticModel 恒 true(经 master
  // internal proxy 按模型名路由可达),不受影响。
  if (!isHostRoutableStaticModel(candidate)) return undefined
  return { model: candidate, originalModel: effective, downgraded: true }
}

/**
 * 服务端**合成首帧**(cron / webhook / scheduled task / inter-agent / openai-compat 等
 * gateway 进程内直接派发、不经 master bridge 计费编排的新会话首帧)的执行模型解析。
 *
 * 背景(P0 计费旁路封堵铁律的对偶面):codex engine(needsServerRequestId)的真扣费
 * 依赖 master bridge 铸造的 server-owned requestId + preCheck / inflight journal 编排
 * (见 sessionManager 的 CODEX_BILLING_GUARD)。这些合成路径是进程内首帧,拿不到也
 * 铸不出该 requestId —— 尤其 host 平台 agent(如 master 侧 `main`)的 cron **无 per-user
 * 计费主体(session 无 user_id = 无钱包)**,codex turn 落地会被 guard 100% fail-closed
 * 拒(线上实测 agent:main:cron:dm:* 全拒)。因此这类首帧不该落 codex:它既无法被编排,
 * 也没有可扣费的主体。
 *
 * 单一权威:codex 归属判定复用 `resolveExecutionModel`(收敛下线/缺省模型)+ protocol
 * `isCodexEngineModel`(codex 系模型集合的唯一权威),不另立第二套 gpt 集合。
 *
 * 语义(返回 `SyntheticTurnModel | undefined`):
 *   - agent/默认模型解析为**非 codex** → 返回 `undefined`,尊重原配置,合成路径行为不变;
 *   - 解析为 **codex(模型驱动)** → 返回 `{ model, originalModel, downgraded:true }`:`model` 是
 *     显式非 codex 兜底模型(env `OPENCLAUDE_SYNTHETIC_TURN_MODEL` 覆盖,默认 `deepseek-v4-flash`),
 *     `originalModel` 是若不降级本会落地的 codex 模型(供用户面/审计**透明披露**降级,不静默换
 *     模型 —— MAJOR-2)。同时补齐这些路径一直缺失的 `model` 路由字段(合成 inbound 铁律)。
 *   - agent.provider === 'codex-native'(**硬 pin**)→ 返回 `undefined`:model 替换救不了它
 *     (resolveEngine 的 provider pin 恒判 codex),这类 agent 的合成 turn 保持 fail-closed
 *     (显式 codex pin + 无扣费主体 = 按显式意图拒,不静默降级到 CCB)。当前 host `main`
 *     无 pin,不受此分支影响。
 *   - 兜底模型在**当前进程形态**下不可路由(host 无对应平台静态 key,见 hostStaticProviders)
 *     → 返回 `undefined`:换成一个必 401 的模型比闸的显式错误更糟,故保持 fail-closed(MAJOR-1)。
 */
export interface SyntheticTurnModel {
  /** 降级后实际执行的非 codex 模型(getOrCreate 决定 runner engine + submit 路由字段同源)。 */
  model: string
  /** 若不降级本会落地的 codex 执行模型 —— 用于对有计费主体路径透明披露"从什么降下来"。 */
  originalModel: string
  /** 恒 true:本结构只在真正发生 codex → 非 codex 降级时返回(undefined = 不干预)。 */
  downgraded: true
}

/**
 * 合成路径的 codex → 非 codex 降级(真值表 'synthetic' 分支)。
 *
 * 与 `resolveSyntheticTurnModel` 同一套兜底选择(env 覆盖 → deepseek-v4-flash → config 默认 →
 * 平台兜底),差别只在**每一级都必须过投影**(可路由 + 非 codex)——"换一个必 401 的模型"
 * 比闸的显式错误更糟(MAJOR-1 的同构结论):全部兜底都不可路由 → MODEL_NOT_AVAILABLE。
 */
export function downgradeSyntheticCodex(
  view: LocalCatalogView,
  from: string,
  defaultModel: string | null | undefined,
  env: NodeJS.ProcessEnv,
): LocalExecutionDecision {
  const override = env.OPENCLAUDE_SYNTHETIC_TURN_MODEL?.trim()
  const fallbacks = [
    override,
    SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT,
    defaultModel,
    ...EXECUTION_MODEL_FALLBACK_ROUTE,
  ]
  for (const raw of fallbacks) {
    if (typeof raw !== 'string' || raw === '') continue
    const canonicalModel = view.canonicalize(raw)
    if (!view.isRoutable(canonicalModel)) continue
    const descriptor = view.resolve(canonicalModel)
    const engine = descriptor?.engine
    if (engine !== 'ccb' || descriptor == null) continue // 兜底自身是 codex → 忽略
    return {
      canonicalModel,
      engine,
      supportsVision: descriptor.supportsVision,
      downgradedFrom: from,
    }
  }
  throw new LocalExecutionRejected(
    'MODEL_NOT_AVAILABLE',
    `synthetic turn intended codex ('${from}') but no routable non-codex fallback exists`,
  )
}

/**
 * 从内存中的存活 runner 读当前实际在跑的 model。
 * 优先 runner.model(进程正在用的),其次 session.model。
 * **不读** client_sessions.model_id(那只是 UI 恢复提示,不是执行权威)。
 * 命中正在替换/关闭 → undefined(等价冷启动,走原阶梯)。
 */
export function readLiveRunnerModel(
  session: LiveRunnerSessionView | undefined | null,
): string | undefined {
  if (!session) return undefined
  if (liveSessionReuseSkipReason(session) !== undefined) return undefined
  return peekLiveRunnerModel(session)
}

export function peekLiveRunnerModel(session: LiveRunnerSessionView): string | undefined {
  const runnerModel = session.runner?.model
  if (typeof runnerModel === 'string' && runnerModel !== '') return runnerModel
  const sessionModel = session.model
  if (typeof sessionModel === 'string' && sessionModel !== '') return sessionModel
  return undefined
}

/** 存活 runner 的 model 为何不能沿用。undefined = catalog 认为可路由。 */
export function liveSessionModelUnusableReason(
  view: LocalCatalogView,
  raw: string,
): string | undefined {
  const canonicalModel = view.canonicalize(raw)
  const descriptor = view.resolve(canonicalModel)
  if (descriptor == null) return 'not_in_projection'
  if (descriptor.available === false) return 'unavailable'
  if (!view.isRoutable(canonicalModel)) return 'unroutable'
  if (descriptor.engine === undefined) return 'no_engine'
  return undefined
}

/** session 正在替换/关闭 → 不得沿用其 model。 */
export function liveSessionReuseSkipReason(
  session: LiveRunnerSessionView | undefined | null,
): string | undefined {
  if (session?._replacing === true) return TICKETLESS_LIVE_SESSION_REPLACING_REASON
  return undefined
}

export const EXECUTION_MODEL_FALLBACK = EXECUTION_MODEL_FALLBACK_ROUTE[0]

export const SYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT = 'deepseek-v4-flash'

/** 无票 inbound 沿用会话模型失败时的可检索 warn 文案(字段:liveModel/reason/fallbackModel)。 */
export const TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN = '无票 inbound 沿用会话模型失败'

/** 无票 inbound 沿用会话模型失败:session 正在 getOrCreate 替换/关闭。 */
export const TICKETLESS_LIVE_SESSION_REPLACING_REASON = 'session_replacing'
