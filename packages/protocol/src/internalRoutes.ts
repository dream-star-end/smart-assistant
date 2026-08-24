/**
 * 内部(容器/egress/master 之间)`/internal/*` 路由的单一注册表。
 *
 * 背景:新增一条容器→master 内部路由要在多处手写同一路径字符串(gateway 调用方、
 * egress forwarder 例外清单、master dispatchInternal 挂载),漏一处就是线上
 * 403/404(send_to_agent、delegate grok-route 都出过事故)。本文件是"最小收敛
 * 第一步":路径常量收敛到 protocol(gateway 与 commercial 都被允许依赖这里,
 * 但两者禁止互相 import 生产代码),并由 commercial
 * `__tests__/internalRouteRegistry.test.ts` 的 contract test 锁一致性。
 *
 * 语义事实(**注册表只描述,不改变**,见 commercial egress/forwarder.ts):
 *   - `/internal/v3/*`:egress forwarder 默认全转 master(白名单化是明确的
 *     non-goal,不要在这里试图收紧)。
 *   - `/internal/v5/*`:控制专用面,forwarder 默认 403;唯一放行例外 =
 *     `egressForwardException` 标记的条目(当前只有 delegate grok-route 三条)。
 *   - `egressLocalIntercept`:split 模式下 egress 进程在 forwarder 之前本地
 *     处理(codex/grok/zcode relay、egress-health/stats),不经 master 控制口。
 *
 * 收录范围:仅 `/internal/*` 内部面;`/api/*` 浏览器面走 bridgeApiAllowlist /
 * containerApiProxy,另有 containerRouteInventory 契约,不在此处。
 */

// ── delegate grok-route(v5 面唯一 forwarder 放行例外)─────────────────────
export const DELEGATE_GROK_ROUTE_MINT_PATH = '/internal/v5/delegate/grok-route/mint'
export const DELEGATE_GROK_ROUTE_RELEASE_PATH = '/internal/v5/delegate/grok-route/release'
export const DELEGATE_GROK_ROUTE_RENEW_PATH = '/internal/v5/delegate/grok-route/renew'

/**
 * egress forwarder 的 v5 放行例外判定(精确路径,前缀兄弟仍拒)。
 * 与注册表 `egressForwardException` 标记同源;contract test 断言两者一致。
 */
export function isDelegateGrokRoutePath(path: string): boolean {
  return (
    path === DELEGATE_GROK_ROUTE_MINT_PATH ||
    path === DELEGATE_GROK_ROUTE_RELEASE_PATH ||
    path === DELEGATE_GROK_ROUTE_RENEW_PATH
  )
}

// ── v5 控制面其余路径 ───────────────────────────────────────────────────────
export const COST_EVENT_PATH = '/internal/v5/cost-event'
export const EGRESS_HEALTH_PATH = '/internal/v5/egress-health'
export const EGRESS_STATS_PATH = '/internal/v5/egress-stats'
export const GROK_RELAY_PREFIX = '/internal/v5/grok-relay'
export const ZCODE_RELAY_PREFIX = '/internal/v5/zcode-relay'
export const PROMPT_QUEUE_MUTATION_PATH = '/internal/v5/prompt-queue/mutation'
export const PROMPT_QUEUE_SNAPSHOT_PATH = '/internal/v5/prompt-queue/snapshot'
export const PROMPT_QUEUE_DETAIL_PATH = '/internal/v5/prompt-queue/detail'
export const PROMPT_QUEUE_CLAIM_PATH = '/internal/v5/prompt-queue/claim'

// ── v3 容器→master 面 ──────────────────────────────────────────────────────
export const CODEX_RELAY_PREFIX = '/internal/v3/codex-relay'
export const CODEX_TOKEN_REFRESH_PATH = '/internal/v3/codex/token-refresh'
export const TURN_LEASE_RENEW_PATH = '/internal/v3/turn-lease/renew'
export const MODEL_CATALOG_PATH = '/internal/v3/model-catalog'
export const MODEL_CATALOG_EPOCH_PATH = '/internal/v3/model-catalog-epoch'
export const SERVER_AUTHORED_PATH = '/internal/v3/server-authored-message'
export const TURN_TAPE_STATE_PATH = '/internal/v3/turn-tape-state'
export const MEMORY_USAGE_PATH = '/internal/v3/memory-usage'
export const TOOL_FAILURE_AUDIT_PATH = '/internal/v3/agent-audit/tool-failure'
export const TOOL_CALL_ROLLUP_PATH = '/internal/v3/agent-audit/tool-rollup'
export const TURN_OBSERVATION_PATH = '/internal/v3/turn-observation'
export const SKILL_USAGE_PATH = '/internal/v3/marketplace/skill-usage'
export const SKILL_FEEDBACK_PATH = '/internal/v3/marketplace/skill-feedback'
export const SKILL_SHADOW_PATH = '/internal/v3/skill-shadow'
export const PLATFORM_PROMPT_SLOTS_PATH = '/internal/v3/platform-prompt-slots'
export const PROJECT_CONTEXT_PATH = '/internal/v3/project-context'
export const CRON_INDEX_PATH = '/internal/v3/cron-index'
export const INBOX_POST_PATH = '/internal/v3/inbox-post'
export const INBOX_ALERT_PATH = '/internal/v3/inbox-alert'
export const AUTO_DREAM_POLICY_PATH = '/internal/v3/auto-dream-policy'
export const AUTO_DREAM_OPTIMIZER_ADMIT_PATH = '/internal/v3/auto-dream/admit'
export const AUTO_DREAM_OPTIMIZER_SETTLE_PATH = '/internal/v3/auto-dream/settle'
export const AUTO_DREAM_OPTIMIZER_ABANDON_PATH = '/internal/v3/auto-dream/abandon'
export const AUTO_DREAM_OPTIMIZER_FINDINGS_PATH = '/internal/v3/auto-dream/findings'
export const AUTO_DREAM_OPTIMIZER_ACTION_PATH = '/internal/v3/auto-dream/action'
export const WECHAT_OUTBOUND_PATH = '/internal/v3/wechat-outbound'
export const WECHAT_PROACTIVE_PATH = '/internal/v3/wechat-proactive'
export const QQ_OUTBOUND_PATH = '/internal/v3/qq-outbound'
export const QQ_PROACTIVE_PATH = '/internal/v3/qq-proactive'
/** master 挂载的市场 agent API 前缀(注意带尾斜杠,startsWith 匹配)。 */
export const MARKETPLACE_AGENT_PREFIX = '/internal/v3/marketplace/agent/'

// ── v3 master→容器 面(容器 gateway 18789 上服务;不经 egress forwarder)────
export const WECHAT_INBOUND_CONTAINER_PATH = '/internal/v3/wechat-inbound'
export const WECHAT_STOP_CONTAINER_PATH = '/internal/v3/wechat-stop'
export const WECHAT_INBOUND_COMPENSATE_PATH = '/internal/v3/wechat-inbound-compensate'
export const QQ_INBOUND_CONTAINER_PATH = '/internal/v3/qq-inbound'
export const QQ_INBOUND_COMPENSATE_PATH = '/internal/v3/qq-inbound-compensate'
export const QQ_STOP_CONTAINER_PATH = '/internal/v3/qq-stop'
export const TURN_REJECT_IF_ABSENT_PATH = '/internal/v3/turn-reject-if-absent'
export const TURN_DISPATCH_STATE_PATH = '/internal/v3/turn-dispatch-state'
export const RUNTIME_RECYCLE_DRAIN_PATH = '/internal/v3/runtime-recycle-drain'

// ── v3 容器 gateway loopback 本地面(容器内工具→gateway,不出容器边界)────────
export const MARKETPLACE_LOCAL_RELAY_PREFIX = '/internal/v3/marketplace/agent-local'
export const SKILL_LOCAL_RELAY_PREFIX = '/internal/v3/skill-local'

export type InternalRoutePlane = 'v3' | 'v5'
export type InternalRouteMatch = 'exact' | 'prefix'

export interface InternalRouteEntry {
  /** 精确路径或前缀(match='prefix' 时按 startsWith 语义;尾斜杠原样保留)。 */
  readonly path: string
  readonly match: InternalRouteMatch
  readonly plane: InternalRoutePlane
  /**
   * v5 面 egress forwarder 的放行例外(v5 默认 403)。加新例外必须同时:
   * ① forwarder 例外判定 ② master dispatchInternal 挂载 ③ 本标记,
   * contract test 会拦漏项。
   */
  readonly egressForwardException?: true
  /** split 模式下 egress 进程本地处理,不进 forwarder、不到 master 控制口。 */
  readonly egressLocalIntercept?: true
  /** 仅 OC_SELFHOST_ENGINE_LOCAL_TURNS=1 的 master 挂载(生产 fail-closed 404)。 */
  readonly selfhostOnly?: true
  /** 已核实的定义/消费点(审计定位用,非机器语义)。 */
  readonly sources: readonly string[]
}

export const INTERNAL_ROUTES = [
  // ── v5:delegate grok-route(forwarder 唯一放行例外;selfhost 门控挂载)──
  {
    path: DELEGATE_GROK_ROUTE_MINT_PATH,
    match: 'exact',
    plane: 'v5',
    egressForwardException: true,
    selfhostOnly: true,
    sources: ['gateway/src/delegateGrokRoute.ts', 'commercial/src/http/internalDelegateGrokRoute.ts'],
  },
  {
    path: DELEGATE_GROK_ROUTE_RELEASE_PATH,
    match: 'exact',
    plane: 'v5',
    egressForwardException: true,
    selfhostOnly: true,
    sources: ['gateway/src/delegateGrokRoute.ts', 'commercial/src/http/internalDelegateGrokRoute.ts'],
  },
  {
    path: DELEGATE_GROK_ROUTE_RENEW_PATH,
    match: 'exact',
    plane: 'v5',
    egressForwardException: true,
    selfhostOnly: true,
    sources: ['gateway/src/delegateGrokRoute.ts', 'commercial/src/http/internalDelegateGrokRoute.ts'],
  },
  // ── v5:控制专用/egress 本地面 ──────────────────────────────────────────
  {
    path: COST_EVENT_PATH,
    match: 'exact',
    plane: 'v5',
    sources: ['commercial/src/http/internalCostEvent.ts', 'commercial/src/egress/costEventSink.ts'],
  },
  {
    path: EGRESS_HEALTH_PATH,
    match: 'exact',
    plane: 'v5',
    egressLocalIntercept: true,
    sources: ['commercial/src/egress/main.ts'],
  },
  {
    path: EGRESS_STATS_PATH,
    match: 'exact',
    plane: 'v5',
    egressLocalIntercept: true,
    sources: ['commercial/src/egress/main.ts'],
  },
  {
    path: GROK_RELAY_PREFIX,
    match: 'prefix',
    plane: 'v5',
    egressLocalIntercept: true,
    sources: ['gateway/src/v5GrokRelay.ts', 'commercial/src/http/internalGrokRelay.ts'],
  },
  {
    path: ZCODE_RELAY_PREFIX,
    match: 'prefix',
    plane: 'v5',
    egressLocalIntercept: true,
    sources: ['gateway/src/v5ZcodeRelay.ts', 'commercial/src/billing/zcodeRouteContext.ts'],
  },
  // v5 prompt-queue:master dispatchInternal 挂载(flag 门控);**不是** forwarder
  // 放行例外 —— split 拓扑下容器经 forwarder 打到这些路径会 403(现状事实)。
  {
    path: PROMPT_QUEUE_MUTATION_PATH,
    match: 'exact',
    plane: 'v5',
    sources: ['gateway/src/promptQueueClient.ts', 'commercial/src/http/internalPromptQueue.ts'],
  },
  {
    path: PROMPT_QUEUE_SNAPSHOT_PATH,
    match: 'exact',
    plane: 'v5',
    sources: ['gateway/src/promptQueueClient.ts', 'commercial/src/http/internalPromptQueue.ts'],
  },
  {
    path: PROMPT_QUEUE_DETAIL_PATH,
    match: 'exact',
    plane: 'v5',
    sources: ['gateway/src/promptQueueClient.ts', 'commercial/src/http/internalPromptQueue.ts'],
  },
  {
    path: PROMPT_QUEUE_CLAIM_PATH,
    match: 'exact',
    plane: 'v5',
    sources: ['gateway/src/promptQueueClient.ts', 'commercial/src/http/internalPromptQueue.ts'],
  },
  // ── v3:容器→master(forwarder 默认转发)────────────────────────────────
  {
    path: CODEX_RELAY_PREFIX,
    match: 'prefix',
    plane: 'v3',
    egressLocalIntercept: true,
    sources: ['gateway/src/v3CodexRelay.ts', 'commercial/src/http/internalCodexRelay.ts'],
  },
  {
    path: CODEX_TOKEN_REFRESH_PATH,
    match: 'exact',
    plane: 'v3',
    egressLocalIntercept: true,
    sources: ['gateway/src/mcpVisionServer.ts', 'commercial/src/http/internalCodexTokenRefresh.ts'],
  },
  {
    path: TURN_LEASE_RENEW_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/masterTurnLease.ts', 'commercial/src/http/internalTurnLeaseRenew.ts'],
  },
  {
    path: MODEL_CATALOG_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/modelCatalogClient.ts', 'commercial/src/http/internalModelCatalog.ts'],
  },
  {
    path: MODEL_CATALOG_EPOCH_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/modelCatalogClient.ts', 'commercial/src/http/internalModelCatalog.ts'],
  },
  {
    path: SERVER_AUTHORED_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3MasterSink.ts', 'commercial/src/http/internalServerAuthored.ts'],
  },
  {
    path: TURN_TAPE_STATE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/turnDispatchInbox.ts', 'commercial/src/http/internalServerAuthored.ts'],
  },
  {
    path: MEMORY_USAGE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/memoryUsageReporter.ts', 'commercial/src/http/internalMemoryUsage.ts'],
  },
  {
    path: TOOL_FAILURE_AUDIT_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3ToolFailureReporter.ts', 'commercial/src/http/internalToolFailureAudit.ts'],
  },
  {
    path: TOOL_CALL_ROLLUP_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3ToolFailureReporter.ts', 'commercial/src/http/internalToolFailureAudit.ts'],
  },
  {
    path: TURN_OBSERVATION_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3ToolFailureReporter.ts', 'commercial/src/http/internalTurnObservation.ts'],
  },
  {
    path: SKILL_USAGE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/skillUsageReporter.ts', 'commercial/src/http/internalSkillUsage.ts'],
  },
  {
    path: SKILL_FEEDBACK_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/skillUsageReporter.ts', 'commercial/src/http/internalSkillFeedback.ts'],
  },
  {
    path: SKILL_SHADOW_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/skillShadowReporter.ts', 'commercial/src/http/internalSkillShadow.ts'],
  },
  {
    path: PLATFORM_PROMPT_SLOTS_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/promptSlots.ts', 'commercial/src/http/internalPlatformPromptSlots.ts'],
  },
  {
    path: PROJECT_CONTEXT_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/projectContextRuntime.ts', 'commercial/src/http/internalProjectContext.ts'],
  },
  {
    path: CRON_INDEX_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3CronIndexPush.ts', 'commercial/src/http/internalCronIndex.ts'],
  },
  {
    path: INBOX_POST_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3InboxPost.ts', 'commercial/src/http/internalInboxPost.ts'],
  },
  {
    path: INBOX_ALERT_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3InboxAlert.ts', 'commercial/src/http/internalInboxPost.ts'],
  },
  {
    path: AUTO_DREAM_POLICY_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/autoDreamPolicy.ts', 'commercial/src/http/internalAutoDreamPolicy.ts'],
  },
  {
    path: AUTO_DREAM_OPTIMIZER_ADMIT_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/autoDreamOptimizerClient.ts', 'commercial/src/http/internalAutoDreamOptimizer.ts'],
  },
  {
    path: AUTO_DREAM_OPTIMIZER_SETTLE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/autoDreamOptimizerClient.ts', 'commercial/src/http/internalAutoDreamOptimizer.ts'],
  },
  {
    path: AUTO_DREAM_OPTIMIZER_ABANDON_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/autoDreamOptimizerClient.ts', 'commercial/src/http/internalAutoDreamOptimizer.ts'],
  },
  {
    path: AUTO_DREAM_OPTIMIZER_FINDINGS_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/autoDreamOptimizerClient.ts', 'commercial/src/http/internalAutoDreamOptimizer.ts'],
  },
  {
    path: AUTO_DREAM_OPTIMIZER_ACTION_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/autoDreamOptimizerClient.ts', 'commercial/src/http/internalAutoDreamOptimizer.ts'],
  },
  {
    path: WECHAT_OUTBOUND_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3WechatOutbound.ts', 'commercial/src/wechat/outboundReceiver.ts'],
  },
  {
    path: WECHAT_PROACTIVE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3WechatProactive.ts', 'commercial/src/wechat/proactiveReceiver.ts'],
  },
  {
    path: QQ_OUTBOUND_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3WechatOutbound.ts', 'commercial/src/qqbot/receiver.ts'],
  },
  {
    path: QQ_PROACTIVE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/v3QqProactive.ts', 'commercial/src/qqbot/receiver.ts'],
  },
  {
    path: MARKETPLACE_AGENT_PREFIX,
    match: 'prefix',
    plane: 'v3',
    sources: ['gateway/src/v3MarketplaceRelay.ts', 'commercial/src/http/internalMarketplaceAgent.ts'],
  },
  // ── v3:master→容器(容器 gateway 18789 服务;两侧成对复制)────────────────
  {
    path: WECHAT_INBOUND_CONTAINER_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/wechat/inboundDispatcher.ts'],
  },
  {
    path: WECHAT_STOP_CONTAINER_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/wechat/inboundDispatcher.ts'],
  },
  {
    path: WECHAT_INBOUND_COMPENSATE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/wechat/inboundDispatcher.ts'],
  },
  {
    path: QQ_INBOUND_CONTAINER_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/qqbot/service.ts'],
  },
  {
    path: QQ_INBOUND_COMPENSATE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/qqbot/service.ts'],
  },
  {
    path: QQ_STOP_CONTAINER_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/qqbot/service.ts'],
  },
  {
    path: TURN_REJECT_IF_ABSENT_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/dispatch/containerDispatchClient.ts'],
  },
  {
    path: TURN_DISPATCH_STATE_PATH,
    match: 'exact',
    plane: 'v3',
    sources: [
      'gateway/src/server.ts',
      'gateway/src/turnDispatchInbox.ts',
      'commercial/src/dispatch/containerDispatchClient.ts',
    ],
  },
  {
    path: RUNTIME_RECYCLE_DRAIN_PATH,
    match: 'exact',
    plane: 'v3',
    sources: ['gateway/src/server.ts', 'commercial/src/agent-sandbox/v3ensureRunning.ts'],
  },
  // ── v3:容器 gateway loopback 本地 relay(不出容器;登记以锁扫描面)─────────
  {
    path: MARKETPLACE_LOCAL_RELAY_PREFIX,
    match: 'prefix',
    plane: 'v3',
    sources: ['gateway/src/v3MarketplaceRelay.ts'],
  },
  {
    path: SKILL_LOCAL_RELAY_PREFIX,
    match: 'prefix',
    plane: 'v3',
    sources: ['gateway/src/ocSkillLocalRelay.ts'],
  },
] as const satisfies readonly InternalRouteEntry[]

const routes: readonly InternalRouteEntry[] = INTERNAL_ROUTES

/** v5 面里 forwarder 显式放行的精确路径集合(供 forwarder/测试消费)。 */
export const EGRESS_FORWARD_EXCEPTION_PATHS: readonly string[] = routes
  .filter((entry) => entry.plane === 'v5' && entry.egressForwardException === true)
  .map((entry) => entry.path)

/** 一条具体路径是否被注册表覆盖(exact 相等,或落在 prefix 条目之下)。 */
export function isRegisteredInternalPath(path: string): boolean {
  return routes.some((entry) =>
    entry.match === 'exact'
      ? path === entry.path
      : path === entry.path ||
        path.startsWith(entry.path.endsWith('/') ? entry.path : `${entry.path}/`),
  )
}
