/**
 * Delegate policy: inbound model allowlist and explicit-model check, gate/queue limits, per-turn hidden-delegation guard, run input shape, parent client-session resolution
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-533); server.ts re-exports
 * these names, so importers are unchanged.
 */
import { STATIC_KEY_INBOUND_MODEL_IDS, CODEX_ENGINE_MODEL_IDS, GROK_ENGINE_MODEL_IDS, CURSOR_ENGINE_MODEL_IDS, ZCODE_ENGINE_MODEL_IDS } from '@openclaude/protocol'
import { resolveExecutionModel } from './localExecution.js'

/**
 * 协议级允许的 InboundMessage.model 值(2026-04-26 v1.0.4 加)。
 *
 * 不查 deps.pricing(GatewayDeps 没 pricing;商用版 admin 启用列表是 host 概念,
 * 容器 gateway 拿不到)。新增模型时这里同步更新。安全意义:防止用户 prefs 残留
 * 已下线模型 / 恶意 frame 注入字符串让 CCB --model 拿到非法值导致 spawn 失败 →
 * session 卡死。运行时校验在 server.ts:WS handler 里;export 出来便于 unit test
 * 与未来抽 helper。
 *
 * 当前 commercial 暴露集合:
 *   - gpt-5.5 — codex agent 走 codex JSON-RPC(v5 从 picker dropGptForV5Channel,但入站仍受)
 *   - deepseek-v4-pro — master 侧 direct DeepSeek 静态 key 路由(入站/回放仍注册;执行下线由 catalog 决定,同 glm-5.1/5.2)
 *   - deepseek-v4-flash — provider-neutral 产品 id，master 侧实际走 OpenCode Go 静态 key 路由
 *     二者都在 claude-subscription agent 上跑即可,不需要切 agent
 *   - MiniMax-M3 — master 侧切到 MiniMax Token Plan Anthropic 兼容端点,
 *     同样跑 claude-subscription/non-codex agent,不进 codex-native
 *   - glm-5.1 / glm-5.2 / glm-5.3 — master 侧切到火山方舟 Ark Coding Plan Anthropic 兼容端点,
 *     同 non-codex;2026-08-22 起平台全局默认是 glm-5.3-zai,glm-5.3(ark) 不再做默认
 *
 * **Claude 官方模型(claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5)已全面下线**
 * (v3 + v5 均不支持),不在白名单;stale prefs / 构造帧带 Claude 模型会被拒,而不是路由到
 * 已下线的 Anthropic 上游。
 *
 * 静态 key 文本 provider 的字面量(deepseek-v4-flash/pro, MiniMax-M3, glm-5.1/5.2/5.3)从
 * @openclaude/protocol 注册表 STATIC_KEY_INBOUND_MODEL_IDS 注入,新增 provider 零改本处。
 */
export const ALLOWED_INBOUND_MODELS = new Set<string>([
  ...CODEX_ENGINE_MODEL_IDS,
  ...GROK_ENGINE_MODEL_IDS,
  ...CURSOR_ENGINE_MODEL_IDS,
  ...ZCODE_ENGINE_MODEL_IDS,
  ...STATIC_KEY_INBOUND_MODEL_IDS,
])

/**
 * delegate_task(s) 未显式指定 model 时的默认优先模型:先试 grok-build(上游 grok-4.6)。
 * 只在 selfhost 豁免门(isEngineLocalTurnExempt)开着时插入候选;catalog 无该行 / 不可路由
 * 会被 decideLocalExecution 的候选循环静默跳过,mint 失败则由 handleDelegateTask 回落到
 * DELEGATE_GROK_FALLBACK_MODEL(日志 delegate_grok_fallback)。显式 model 完全不受影响。
 */
export const DELEGATE_DEFAULT_PREFERRED_MODELS = ['grok-build'] as const

export const DELEGATE_GROK_FALLBACK_MODEL = 'deepseek-v4-flash'

/**
 * Fail-loud for an explicit delegate `--model` slug against the baked inbound set.
 *
 * - absent / empty → inherit, no-op
 * - known baked slug → no-op
 * - unknown → throws `DELEGATE_MODEL_UNKNOWN` (does not inherit)
 *
 * Does **not** consult the model catalog. Catalog outages stay
 * `MODEL_CATALOG_UNAVAILABLE` on the `OC_MODEL_AUTHORITY=1` path; mixing
 * the two would collapse "master unreachable" into "typo". Catalog-only
 * slugs remain the flag-on `decideLocalExecution` path.
 */
export function assertKnownExplicitDelegateModel(model: string | undefined | null): void {
  if (typeof model !== 'string' || model === '') return
  resolveExecutionModel(model, undefined, undefined, { explicit: true })
}

/** 同时排队者上限:内存高压期每个等待者都挂着一条 HTTP 请求,不设上限会把
 *  "排队"本身堆成第二波雪崩;超出直接按原闸形状立即拒。 */
export const DELEGATE_QUEUE_MAX_WAITERS = 8

// ── 团队模式审查任务书 ──────────────────────────────────────────────────────
// 2026-09-04 起两套模板(执行验收 / 审议对比)+ 成员证据块,全部在 teamMode.ts
// (buildTeamReviewContext);server.ts 只负责从队长会话取证据(_pendingAgentGroups)喂进去。

/** 资源闸拦截原因 —— 两道闸共用一个判定/拒绝收口,避免两套并行机制。 */
export type DelegateGateBlock =
  | { kind: 'concurrency' }
  | { kind: 'memory'; pct: number; limitPct: number }

/** P2 债C — `_runDelegateTask` 的结构化入参(HTTP 壳从请求 body 组装;gateway 硬编排
 *  review pass 直接构造)。把委派执行核心与 HTTP req/res 解耦,让编排能内部直调同一路径
 *  拿到结构化结果(verdict/output),不必伪造 req/res。 */
export interface RunDelegateInput {
  allowSelf?: boolean
  targetAgentId: string
  goal: string
  context?: string
  sourceAgent?: string
  toolsets?: unknown
  /** 父会话 sessionKey(容器内部键):委派归因 + 进度回传 + per-parent 分桶的解析源。 */
  traceId?: string
  parentTraceId?: string
  parentSessionKey?: string
  streamProgress?: boolean
  depth: number
  /** P2 批次4 — 子任务思考量级(low/medium/high),透传给 delegate session 的
   *  sessions.submit effortLevel(参照顶层会话 safeEffortLevel 传法)。缺省/非法 →
   *  undefined,不动子会话 runner 的默认 effort(= 该成员默认档位)。 */
  effort?: string
  /** gateway 硬编排触发的隐藏审查员委派。影响:runLog isReview / 资源闸走保留槽 + 免
   *  per-parent 桶 / 完成后解析结构化 verdict / 不置位"本 turn 有非隐藏委派"跟踪。 */
  isReview?: boolean
  /** 覆盖默认 `agent:<id>:delegate:...`。taskboard 巡检必须传入 buildPatrolSessionKey()。 */
  sessionKey?: string
  projectId?: string
  workspaceCwd?: string
  runContext?: import('./runContextPersist.js').RunContextDescriptor
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
  /** 覆盖默认 channel 'delegate'。taskboard 传 'taskboard',且不得加入
   *  MASTER_SINK_PERSIST_CHANNELS,否则巡检文本会写进 client_sessions 刷屏。 */
  channel?: string
  /** 可选的本次无活动超时。只按真实 child activity 续租,不是总运行时长上限。 */
  idleTimeoutMs?: number
  /** 可选:覆盖目标成员默认模型的 catalog 型号。审查委派忽略(审查员型号由 gateway 选)。 */
  model?: string
  /** Internal taskboard adapter only; HTTP request bodies never set this. */
  modelPolicy?: 'taskboard-stage-agent-auto'
  /** Internal root guard owner, distinct from real ancestry and billing. */
  delegationGuardOwnerKey?: string
  taskboardControl?: import('./taskboard/runControl.js').TaskboardRunControl
  /** 2026-09-04 团队模式:审查任务书模板(execution 验收 / deliberation 审议对比)。
   *  仅审查委派读取;非法/缺省 → execution。只影响提示词,不影响闸与计费。 */
  reviewMode?: string
  /** HTTP/MCP 可选续跑:已通过 DelegateResumeRegistry 占用的钥匙。 */
  resumable?: boolean
  /** 本次是否新 mint。早退时要 drop binding,避免占 cap。 */
  resumeMinted?: boolean
  /** send_to_agent: child 完成后把结论注入父 webchat 并新开父 turn。 */
  callbackOnComplete?: 'origin-inject'
  /** Captured while the delegate parent chain is still live; nested parents are ephemeral. */
  callbackOriginSessionKey?: string
  callbackOriginUserId?: string
  /** Async handle returned to the send_to_agent tool, used as exact UI correlation. */
  backgroundJobId?: string
  /** Captured at claimQueued; never re-read from the store at terminal. */
  claimToken?: string
  fencingEpoch?: number
  /** SM: slot already reserved at Enqueue, skip the waiter loop. */
  capacityReserved?: boolean
  /** SM: the exact opts `_admitDelegateCreate` reserved with (slot or waiter). Every release
   *  of that reservation must use these — never a re-derived bucket key — or the per-parent
   *  running counter drifts and locks the parent out(2026-09-06 槽位泄漏事故:早退未释放)。 */
  capacitySlotOpts?: { parentBucketKey?: string; isReview?: boolean }
  idempotencyKey?: string
  _leaseTimer?: ReturnType<typeof setInterval>
}

// ── hidden 系统 agent 串行委派熔断 ──────────────────────────────────────────
/** 同一父 turn 内对 hidden 系统 agent(隐藏审查员)的委派次数硬上限。
 *
 *  P2 债C 后语义变更:审查触发权威已从 prompt 软约束**收归 gateway 硬编排**
 *  (dispatchInbound teamMode-main-webchat 的 review pass),队长 preamble 不再自觉
 *  调用 hidden-reviewer。本熔断因此从"拦队长 prompt 级串行重试"变为**硬编排重试的
 *  后备保险**:硬编排自身把迭代封顶在 OPENCLAUDE_TEAM_REVIEW_MAX_ROUNDS(默认 2)轮,
 *  本上限(默认 3,env OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN 可配)是更外层的绝对护栏
 *  ——即便编排逻辑有 bug 或未来放宽轮数,单 turn 对审查员的委派也不会失控(每轮 review
 *  都是全新 delegate session 全额计费)。delegation depth 只管嵌套、MAX_CONCURRENT_DELEGATIONS
 *  只管并行,都拦不住串行重试,这里是第三条腿。 */
export const MAX_HIDDEN_DELEGATIONS_PER_TURN = 3

/** P2 批次4 — 普通成员(队长直接委派的已安装 agent,非 hidden 非 review)每 turn
 *  委派次数上限。消"串行无上限"债:队长可以持续 fan-out,但单 turn 不该无界地把
 *  同一批成员反复委派(失控的串行重试/发散拆分会烧钱且拖长 turn)。超限返回结构化
 *  错误引导队长收敛(见 _runDelegateTask member guard 分支),不是静默失败。默认 8,
 *  env 可配(下限 1);比 hidden 熔断默认值宽,因为正常复杂任务的合理 fan-out 会多于审查。 */
export const MEMBER_DELEGATIONS_PER_TURN_DEFAULT = 8

/** 「每 turn、按父会话」的委派计数器 —— 一套通用机制,当前服务两条策略:
 *   1. hidden 审查员串行熔断(_hiddenDelegateGuard,上限 env 可配默认 MAX_HIDDEN_DELEGATIONS_PER_TURN);
 *   2. P2 批次4 普通成员每 turn 委派上限(_memberDelegateGuard,env 可配默认 8)。
 *  两者机制完全一致(仅上限值与计数范围不同),故复用同一个类而非另起并行实现。
 *
 *  计数键 = **父会话 sessionKey**,依据:delegate 请求(mcp-memory
 *  handleDelegateTaskToAgent)只携带 parentSessionKey(取自 OPENCLAUDE_SESSION_KEY env)
 *  和 x-delegation-depth 头,请求里拿不到任何 turn 级标识,因此退而按父会话维度计数,
 *  turn 边界由 dispatchInbound 在同一 sessionKey 收到下一条用户消息时调用 resetForParent
 *  划定。子 delegate 会话的 sessionKey 自带时间戳(一次性,不能当计数键),但它作为"父"
 *  再委派时天然就是 turn 粒度,其计数在该 delegate 请求收尾时清理。TTL 惰性清扫兜底
 *  cron/task 等永远等不到下一条用户消息的父会话 —— 既防 Map 泄漏,也防"额度永久锁死"。 */
export class PerTurnDelegationGuard {
  private counts = new Map<string, { count: number; touchedAt: number }>()

  constructor(
    private readonly limit = MAX_HIDDEN_DELEGATIONS_PER_TURN,
    /** 与平台 12h logical-turn 安全窗口对齐，只兜计数 Map 泄漏/永久锁死。 */
    private readonly staleMs = 12 * 60 * 60_000,
  ) {}

  /** 为一次 hidden 委派占额度:未达上限 → 计数 +1 放行;已达上限 → 拒绝。
   *  `limit` 缺省用构造时上限;生产 hidden 路径传入 call-time env 解析值。 */
  tryAcquire(parentKey: string, now = Date.now(), limit = this.limit): boolean {
    this.prune(now)
    const entry = this.counts.get(parentKey)
    if (!entry) {
      this.counts.set(parentKey, { count: 1, touchedAt: now })
      return true
    }
    if (entry.count >= limit) return false
    entry.count++
    entry.touchedAt = now
    return true
  }

  /** 父会话开启新用户 turn / 父 delegate 会话收尾时清零。 */
  resetForParent(parentKey: string): void {
    this.counts.delete(parentKey)
  }

  /** 只读:该父键本 turn 已占用的额度(团队模式「组队却未送审」可观测用)。 */
  countFor(parentKey: string): number {
    return this.counts.get(parentKey)?.count ?? 0
  }

  private prune(now: number): void {
    for (const [key, entry] of this.counts) {
      if (now - entry.touchedAt > this.staleMs) this.counts.delete(key)
    }
  }
}

/**
 * delegate 计费归因 — 解析"父**客户端**会话 id"(usage_records.parent_session_id
 * 的落库值)。优先级(能拿到 web-* 就绝不落内部键):
 *
 *   1. `progressPeerId`:父会话在内存且是 webchat → 其 peerId 即客户端会话 id
 *      (web-*,userChatBridge sessionKey 模板 `agent:<aid>:webchat:dm:<id>` 的
 *      第 4 段来源)。
 *   2. `parentRepoSessionId`:嵌套 delegate(父是 delegate 会话)→ 其
 *      repoSessionId 在创建时继承自根 webchat 会话的 peerId,仍是 web-*。
 *   3. parentSessionKey 形如 webchat 键 → 直接截取第 4 段(父会话不在内存 ——
 *      如 gateway 重启后 —— 的兜底,不依赖 session map)。
 *   4. 原样返回 parentSessionKey(容器内部会话键,如 cron/webhook 父或更老格式;
 *      master 侧原样落库,映射链依赖本注释)。
 *   5. 都拿不到 → undefined(usage_records.parent_session_id 落 NULL,行上仍有
 *      mode='delegate' + delegate_agent_id 可归因到"某次委派")。
 *
 * 纯函数,便于单测;调用点唯一(handleDelegateTask)。
 */
export function resolveDelegateParentClientSessionId(args: {
  progressPeerId?: string
  parentRepoSessionId?: string
  parentSessionKey?: unknown
}): string | undefined {
  if (args.progressPeerId) return args.progressPeerId
  if (args.parentRepoSessionId) return args.parentRepoSessionId
  const key = args.parentSessionKey
  if (typeof key !== 'string' || !key) return undefined
  const webchat = /^agent:[^:]+:webchat:dm:(.+)$/.exec(key)
  return webchat?.[1] ?? key
}
