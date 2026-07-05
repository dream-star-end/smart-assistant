/**
 * T-16 — 商业化模块的 HTTP 路由器(无框架,基于 node:http)。
 *
 * 暴露 `createCommercialHandler(deps)` → `(req, res) => Promise<boolean>`。
 * 返回 `true` 表示该路由由商业化模块处理(已写完响应),
 * `false` 表示路径不匹配,调用方应 fall through 到下层 handler。
 *
 * 设计:
 *   - 关心的前缀:/api/auth/* + /api/me
 *   - 派发前统一:setSecurityHeaders + ensureRequestId + 写 X-Request-Id 响应头
 *   - 派发后:HttpError → 标准错误响应;未捕获异常 → 500 INTERNAL
 *   - body 解析在 handler 里调用 readJsonBody(失败抛 HttpError)
 *
 * 不在本文件:
 *   - CORS:由 gateway 层统一处理(目前暂不开放跨域;Web 同源)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
// V3 S12e CG9 — contract D (deploy smoke) trace-id child binding on HTTP
// request logger. master HTTP segment is the ONLY commercial path that reads
// X-Trace-Id here (WS bridge has its own X-Connection-Trace-Id flow).
import { newTraceId, parseTraceIdCandidate } from '@openclaude/protocol'
import { writeAdminAudit } from '../admin/audit.js'
import { incrGatewayRequest } from '../admin/metrics.js'
import { requireAdminVerifyDb } from '../admin/requireAdmin.js'
import { verifyCommercialJwtSync } from '../auth/jwtSync.js'
import { dialTunnelSocket as defaultTunnelDial } from '../compute-pool/nodeAgentClient.js'
import { getHostById as computePoolGetHostById } from '../compute-pool/queries.js'
import { getPool } from '../db/index.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import {
  handleAdminMarketplacePending,
  handleAdminMarketplaceReview,
  handleAdminMarketplaceReviewBatch,
  handleAdminMarketplaceRevoke,
  handleMarketplaceAgentPublish,
  handleMarketplaceDetail,
  handleMarketplaceInstall,
  handleMarketplaceInstalled,
  handleMarketplaceInstalledScope,
  handleMarketplaceMyAgents,
  handleMarketplaceMyPublishes,
  handleMarketplacePublish,
  handleMarketplaceUnlist,
  handleMarketplaceUninstall,
  handleMarketplaceWithdrawPublish,
} from '../marketplace/marketplaceRoutes.js'
import { handleMarketplaceSearch } from '../marketplace/marketplaceSearch.js'
import { isActiveAdmin, isInMaintenance } from '../middleware/maintenanceMode.js'
import { ContainerUnreadyError } from '../ws/userChatBridge.js'
import {
  handleAdminCreateAccountGroup,
  handleAdminCreateRelayCredential,
  handleAdminDeleteAccountGroup,
  handleAdminDeleteRelayCredential,
  handleAdminGetAccountGroup,
  handleAdminListAccountGroups,
  handleAdminPatchAccountGroup,
  handleAdminPatchRelayCredential,
  handleAdminPutAccountGroupModels,
} from './admin/accountGroups.js'
import {
  handleAdminAccountsStats,
  handleAdminCreateAccount,
  handleAdminDeleteAccount,
  handleAdminGetAccount,
  handleAdminListAccounts,
  handleAdminListRefreshEvents,
  handleAdminOAuthExchange,
  handleAdminOAuthStart,
  handleAdminPatchAccount,
  handleAdminResetAccountCooldown,
} from './admin/accounts.js'
import { handleAdminListAudit } from './admin/audit.js'
import {
  handleAdminAgentContainerAction,
  handleAdminContainerLogs,
  handleAdminContainersStats,
  handleAdminListAgentContainers,
} from './admin/containers.js'
import {
  handleAdminCreateEgressProxy,
  handleAdminDeleteEgressProxy,
  handleAdminGetEgressProxy,
  handleAdminListEgressProxies,
  handleAdminPatchEgressProxy,
} from './admin/egressProxies.js'
import {
  handleAdminExportLedgerCsv,
  handleAdminExportOrdersCsv,
  handleAdminExportUsersCsv,
} from './admin/export.js'
import { handleAdminAckFeedback, handleAdminListFeedback } from './admin/feedback.js'
import {
  handleAdminCreateInbox,
  handleAdminDeleteInbox,
  handleAdminGetInboxEmailConfig,
  handleAdminListInbox,
} from './admin/inbox.js'
import { handleAdminListLedger } from './admin/ledger.js'
import {
  handleAdminGetLiterature,
  handleAdminPatchLiterature,
  handleAdminTestLiterature,
} from './admin/literature.js'
import { handleAdminMetrics } from './admin/metrics.js'
import { handleAdminRemoveUserModelGrant } from './admin/modelGrants.js'
import { handleAdminGetOrder, handleAdminListOrders, handleAdminOrdersKpi } from './admin/orders.js'
import { handleAdminListPlans, handleAdminPatchPlan } from './admin/plans.js'
import { handleAdminListPricing, handleAdminPatchPricing } from './admin/pricing.js'
import { handleAdminGetSession } from './admin/sessions.js'
import {
  handleAdminGetSetting,
  handleAdminListSettings,
  handleAdminPutSetting,
} from './admin/settings.js'
// S3 §6.2 终局:admin handler 直接从各拆分文件 import,admin.ts barrel 已删。
import {
  handleAdminAdjustCredits,
  handleAdminGetUser,
  handleAdminListUsers,
  handleAdminPatchUser,
  handleAdminUsersStats,
} from './admin/users.js'
import {
  handleAdminAlertsAckRule,
  handleAdminAlertsCreateSilence,
  handleAdminAlertsCreateTelegramChannel,
  handleAdminAlertsDeleteChannel,
  handleAdminAlertsDeleteSilence,
  handleAdminAlertsIlinkPoll,
  handleAdminAlertsIlinkQrcode,
  handleAdminAlertsListChannels,
  handleAdminAlertsListEvents,
  handleAdminAlertsListOutbox,
  handleAdminAlertsListRuleStates,
  handleAdminAlertsListSilences,
  handleAdminAlertsPatchChannel,
  handleAdminAlertsRetryOutbox,
  handleAdminAlertsTestChannel,
  handleListEventCoverage,
} from './adminAlerts.js'
import { handleAdminAgentAudit } from './adminAudit.js'
import {
  handleAdminAddComputeHost,
  handleAdminBaselineVersion,
  handleAdminComputeHostAction,
  handleAdminComputeHostGetSubresource,
  handleAdminDistributeImageToAllHosts,
  handleAdminListComputeHosts,
} from './adminComputeHosts.js'
import {
  handleAdminDiagnostics,
  handleAdminStatsAccountPool,
  handleAdminStatsAlertEvents7d,
  handleAdminStatsAlertsSummary,
  handleAdminStatsDau,
  handleAdminStatsFunnel,
  handleAdminStatsHostsUtilization,
  handleAdminStatsLifetime,
  handleAdminStatsRequestSeries,
  handleAdminStatsRevenueByDay,
  handleAdminStatsSignupsByDay,
} from './adminStats.js'
import { handleAgentCancel, handleAgentOpen, handleAgentStatus } from './agent.js'
// V3 CC 外接 plan Phase 4(2026-05-18):用户自管 CC API key 的管理面 endpoints。
import { handleCreateMyApiKey, handleListMyApiKeys, handleRevokeMyApiKey } from './apiKeyAdmin.js'
import { getBearerToken, getSessionCookieToken } from './authHelpers.js'
import { handleClientErrorReport } from './clientErrors.js'
import { containerApiProxy, matchContainerApiProxyRoute } from './containerApiProxy.js'
import { containerFileProxy } from './containerFileProxy.js'
import {
  handleDeleteMyGithub,
  handleDeleteSessionGithubSelection,
  handleGetMyGithub,
  handleGetSessionGithubSelection,
  handleListMyGithubBranches,
  handleListMyGithubRepos,
  handlePutSessionGithubSelection,
} from './githubApi.js'
import {
  type CommercialHttpDeps,
  type RequestContext,
  handleCheckVerification,
  handleClearSession,
  handleConfirmPasswordReset,
  handleCountMyInboxUnread,
  handleCreateSession,
  handleDeleteResearchLibraryDoc,
  handleGetMyPreferences,
  handleGetMyUsage,
  handleGetPublicConfig,
  handleListMyInbox,
  handleListPublicModels,
  handleListResearchLibrary,
  handleLogin,
  handleLogout,
  handleMarkInboxRead,
  handleMe,
  handleMediaSign,
  handleMediaSigned,
  handlePatchMyPreferences,
  handleReadAllInbox,
  handleRefresh,
  handleRegister,
  handleRequestPasswordReset,
  handleResendVerification,
  handleSubmitFeedback,
  handleUploadResearchLibraryDoc,
  handleVerifyEmail,
} from './handlers.js'
import { handleGithubCallback, handleGithubStart } from './oauthGithub.js'
import { handleLinuxdoCallback, handleLinuxdoStart } from './oauthLinuxdo.js'
import { handleCreateHupi, handleGetOrder, handleHupiCallback, handleListPlans } from './payment.js'
import {
  handleBuyPack,
  handleGetMySubscription,
  handleListSubscriptionPlans,
  handleSubscribe,
  handleUpgrade,
} from './subscription.js'
import {
  handleCreateRemoteHost,
  handleDeleteRemoteHost,
  handleGetRemoteHost,
  handleListRemoteHosts,
  handlePatchRemoteHost,
  handleRemoteHostAction,
} from './remoteHosts.js'
import { requireActiveAccountVerifyDb, requireUserVerifyDb } from './requireUser.js'
import { defaultTunnelFetchHealthz } from './tunnelHealthzProbe.js'
import {
  HttpError,
  REQUEST_ID_HEADER,
  clientIpOf,
  ensureRequestId,
  sendError,
  setSecurityHeaders,
  userAgentOf,
} from './util.js'
import { handleWechatLivePage, handleWechatLiveSnapshot } from './wechatLive.js'

/**
 * **P0 — v3 multi-tenant leak firewall** (2026-04-22)
 *
 * v3 gateway 走 host-scope singleton 存储(`$OPENCLAUDE_HOME/agents/main/*`、
 * `$OPENCLAUDE_HOME/cron.yaml`、sqlite `client_sessions` 的历史桶),大量端点从个人版
 * 继承下来,**没有按 userId 做 partition**。在商业版 v3 下这意味着:
 *
 *   1. 付费用户 A 调 `/api/agents/main/memory/user` → 读/写 host 的
 *      `~/.openclaude/agents/main/USER.md`,跨用户串号。
 *   2. `/api/cron` / `/api/tasks` / `/api/webhooks/:id` / `/api/agents/:id/delegate`
 *      / `/api/agents/:id/message` **允许注入 prompt**,host 侧 agent 会拿到这串 prompt
 *      做 Bash 等动作 —— 付费用户直接在 HOST 上拿到 shell(RCE)。
 *   3. `/api/usage` / `/api/usage/events` / `/api/runs` / `/api/doctor` / `/api/config`
 *      / `/api/webhooks` 返 host 全局的计量、运行日志、配置、webhook 密钥 —— 跨用户
 *      信息泄漏。
 *   4. `/api/search` 跨 user 搜 session,返对方聊天记录片段。
 *
 * 正确的每用户空间隔离是在容器内做(`docker run` 把 per-user volume 挂进 agent 容器,
 * agent 侧 MCP `create_reminder/memory/skills` 都走容器本地 127.0.0.1:18789 的
 * personal-version gateway,天然按容器隔离)。**host gateway 这边完全不应该被商业用户
 * 访问到这批路径** —— 把它们直接 403 掉。
 *
 * **策略**:
 *   - 请求路径命中 `BLOCKED_FOR_USER_RULES` 里任意一条(+ 方法匹配)时,验 JWT:
 *     - commercial user → 403 FORBIDDEN(不泄露 endpoint 存在)
 *     - commercial admin → DB double-check(role=admin && status=active,
 *       撤权立即生效);通过则 fall through 给 gateway 自己的 handler(保留运维调试)
 *       **+ 额外写一条 admin_audit 事件**(action=blocked_route_bypass)
 *     - 无 / 非法 / 过期 / 签名错 → fall through 给 gateway.checkHttpAuth 正常拒
 *
 * **设计**:**一定要精确到 method**。gateway 里一堆路径是只读也是写的同路径二义。
 * 比如 `/api/agents` GET 只列表(低风险)但 POST 能创建 host agent(高风险);
 * `/api/webhooks/:id` DELETE / POST 不同语义。用 `methods ⊇ method` 过滤。
 *
 * **不在本表里的放行项**:
 *   - `/api/sessions` / `/api/sessions/list` / `/api/sessions/:id` —— 这三个 gateway 自己按 userId
 *     过滤(`getUserId` → `c:${sub}`),commercial 用户拿到的是自己名下的 session。
 *     **但** `/api/sessions/unclaimed` 和 `/api/sessions/claim` 在本表里拦 —— 前者列出所有未绑
 *     userId 的历史 session(default 桶 / legacy 个人版数据),后者把任意 sessionId 迁给调用者;
 *     付费用户用它能把别人的聊天记录"认领"过来。
 *   - `/api/wechat/*` —— 多租户 per-user 绑定(getUserId 作 key)
 *   - `/api/changelog` / `/api/healthz` / `/api/feedback` —— 读 changelog / 健康 / 反馈
 *   - `/api/auth/claude/*` —— OAuth 引导,admin 独享,gateway 层自己再做 admin-only
 *
 * **`/api/file` + `/api/media/*` 为何也拦**:
 *   - `/api/file?path=...` 走 `agentCwds` 白名单 —— 但 `agentsConfig.agents` 是 HOST 全局
 *     的 agents,commercial 付费用户用它能读 HOST 主 agent(admin 的 main)cwd 下任何文件。
 *     该端点给付费用户(容器内)访问"无意义"—— 容器 media 路径在 HOST 上 404,所以拦了
 *     只是把"已经 404"的变成"403" —— 不影响任何合法用例,堵上一条跨租户读盘缝隙。
 *   - `/api/media/:file` 服务 HOST uploads/ 和 MCP generated/ —— 跨用户可见。
 *
 * **`/v1/*` 为何全拦**:
 *   - `/v1/chat/completions` 在 handleOpenAIRequest 里调 `sessions.submit(...)`,把 POST body
 *     里的 prompt 喂给 HOST main agent → 付费用户直接在 HOST 上拿 Bash。`/v1/models` 信息
 *     泄漏较轻,但合并拦简化策略。v3 付费用户走 WebChat WS → userChatBridge → 容器,根本不
 *     需要 HOST `/v1/*`。admin 仍可 bypass 用于运维探活。
 *
 * **`/metrics` + `/api/doctor` 去方法限制**:
 *   - `/metrics` 吐 HOST 全局 Prometheus(accounts/sessions/agent_audit 等),任何方法都应拦。
 *   - `/api/doctor` 原来限 `GET`,但 gateway 对 `POST /api/doctor` 不校验 method → 落空。
 *     改为全方法拦,admin bypass 审计后 fall through(gateway 自己只认 GET,其他 method 自然 404)。
 *
 * **为什么对 `/api/agents(/...)?` 整个分支"宁可错杀"**:
 *   v3 web UI 已经全部走 WS(client_sessions 分区 + docker bridge → 容器 18789),
 *   **不再直接 fetch /api/agents/:id/...**;即便历史 JS 代码里还有 fetch 残留(`agents.js`
 *   和 `memory.js` 2026-04-22 已决定下线),我们宁可 403 + PR2 前端移除入口,也不留
 *   任何 host-agent 写口给付费用户。
 */
interface BlockedForUserRule {
  re: RegExp
  /** 若 undefined = 所有方法都拦。否则只对枚举方法拦,其他方法放行(fall through)。 */
  methods?: ReadonlySet<string>
  /** 审计 / 日志里的可读 endpoint label,不带动态段 */
  label: string
}

const M = (...methods: string[]) => new Set(methods)

const BLOCKED_FOR_USER_RULES: readonly BlockedForUserRule[] = [
  // ─── host agent RCE 面 ───
  // /api/agents GET(列表 host agents)+ POST(创建 host agent);两者都不该给 user
  { re: /^\/api\/agents$/, label: '/api/agents' },
  // /api/agents/:id GET/PUT/DELETE —— 读 host agent 元信息、改 model/persona、删 agent
  { re: /^\/api\/agents\/[^/]+$/, label: '/api/agents/:id' },
  // /api/agents/:id/persona GET/PUT —— 读/写 host agent CLAUDE.md
  { re: /^\/api\/agents\/[^/]+\/persona$/, label: '/api/agents/:id/persona' },
  // /api/agents/:id/message POST + /api/agents/:id/delegate POST —— host agent 执行 prompt = RCE
  { re: /^\/api\/agents\/[^/]+\/(message|delegate)$/, label: '/api/agents/:id/(message|delegate)' },
  // 内存 / 技能(host singleton 存储)
  { re: /^\/api\/agents\/[^/]+\/memory\/(memory|user)$/, label: '/api/agents/:id/memory/*' },
  { re: /^\/api\/agents\/[^/]+\/skills(\/[A-Za-z0-9_\-]+)?$/, label: '/api/agents/:id/skills' },
  // 用户级共享技能库(host singleton 存储);付费用户只能经 container proxy 操作自己容器
  { re: /^\/api\/skills(\/[A-Za-z0-9_\-]+)?$/, label: '/api/skills' },
  // SkillOpt 训练(/api/skills/:name/train + /api/skill-training/*):同样落 host singleton
  // 存储 + 起 host 主 agent 会话 = RCE/越权,付费用户必须经 container proxy(见 bridge
  // allowlist)。这里 block host 兜底,防 proxy 关闭/admin 绕过时落到 master host。
  { re: /^\/api\/skills\/[A-Za-z0-9_\-]+\/train$/, label: '/api/skills/:name/train' },
  { re: /^\/api\/skill-training\/.+$/, label: '/api/skill-training/*' },
  // NOTE: /api/marketplace/* is deliberately NOT in this table. This table 403s
  // *commercial browser users*, but the marketplace is a browser-facing feature
  // those exact users must reach. Agent-bypass is enforced structurally instead:
  // marketplace is absent from BRIDGE_API_ALLOWLIST (a closed allowlist), so a
  // container cannot proxy to it, and the handlers require a browser user JWT a
  // container never holds. See the routes registration below.
  // Agent teams 也写 host singleton agents.yaml；付费用户只能通过 container proxy
  // 操作自己容器内的 teams，不能落到 master host。
  { re: /^\/api\/agent-teams$/, label: '/api/agent-teams' },
  { re: /^\/api\/agent-teams\/[A-Za-z0-9_-]+$/, label: '/api/agent-teams/:id' },
  // team run：发起(POST .../:id/runs) + 观察(GET /api/team-runs, /api/team-runs/:id) +
  // 停止(POST /api/team-runs/:id/stop)。finalize 只由容器内 leader MCP 调 127.0.0.1，不经此代理。
  { re: /^\/api\/agent-teams\/[A-Za-z0-9_-]+\/runs$/, label: '/api/agent-teams/:id/runs' },
  { re: /^\/api\/team-runs$/, label: '/api/team-runs' },
  { re: /^\/api\/team-runs\/[A-Za-z0-9_-]+$/, label: '/api/team-runs/:id' },
  { re: /^\/api\/team-runs\/[A-Za-z0-9_-]+\/stop$/, label: '/api/team-runs/:id/stop' },
  // finalize：**不**在 bridge allowlist(不代理到容器),但要在此 block 表 403 普通用户,
  // 防其落到 host finalize route(Codex 审)。容器内 leader MCP 走 127.0.0.1 不经本 router。
  { re: /^\/api\/team-runs\/[A-Za-z0-9_-]+\/finalize$/, label: '/api/team-runs/:id/finalize' },

  // ─── host cron / tasks / webhooks(所有方法,prompt 注入 = RCE)───
  { re: /^\/api\/cron(\/[^/]+)?$/, label: '/api/cron' },
  { re: /^\/api\/tasks(\/[A-Za-z0-9_\-]+)?$/, label: '/api/tasks' },
  { re: /^\/api\/tasks-executions$/, label: '/api/tasks-executions' },
  { re: /^\/api\/webhooks$/, label: '/api/webhooks' }, // GET 列表 leak secret
  { re: /^\/api\/webhooks\/[A-Za-z0-9_\-]+$/, label: '/api/webhooks/:id' }, // POST = host prompt 执行,DELETE = 删除 host webhook

  // ─── 全局 host 信息泄漏面 ───
  // /api/doctor 不限方法 —— gateway 里没显式校验 method,写成 "GET only" 会被 POST/HEAD 绕过。
  // 全方法拦,admin bypass 后由 gateway 自己决定要不要接(不接就 404,也安全)。
  { re: /^\/api\/doctor$/, label: '/api/doctor' },
  { re: /^\/api\/runs$/, methods: M('GET'), label: '/api/runs' },
  { re: /^\/api\/usage$/, methods: M('GET'), label: '/api/usage' },
  { re: /^\/api\/usage\/events$/, methods: M('GET'), label: '/api/usage/events' },
  { re: /^\/api\/config$/, label: '/api/config' }, // GET dumps gateway config + auth info
  // /metrics 吐 host 全局 Prometheus(含 accounts/sessions/agent_audit 统计),不分方法。
  { re: /^\/metrics$/, label: '/metrics' },

  // ─── 跨 user session FTS ───
  { re: /^\/api\/search$/, label: '/api/search' },

  // ─── session 迁移(跨租户认领别人历史 session)───
  // /api/sessions/unclaimed 列所有 default 桶未绑定 session,/api/sessions/claim 把任意
  // sessionId 迁给调用者 —— 付费用户借此拿到 legacy 个人版 / 其他用户遗留的聊天记录。
  // 正常用途只给 admin 运维(初次迁移 v2→v3 / default 桶清理)。
  { re: /^\/api\/sessions\/(unclaimed|claim)$/, label: '/api/sessions/(unclaimed|claim)' },

  // ─── HOST 文件访问(跨租户读 admin 主 agent cwd / HOST uploads / MCP generated)───
  // 详见大注释「/api/file + /api/media/* 为何也拦」段落。
  { re: /^\/api\/file$/, label: '/api/file' },
  { re: /^\/api\/media\/.+$/, label: '/api/media/:file' },

  // ─── HOST RCE 面(OpenAI 兼容层,POST body.prompt → sessions.submit → host main agent)───
  // 覆盖 /v1/chat/completions、/v1/models;后者仅列模型但合并策略拦更简。admin bypass。
  { re: /^\/v1\/.+$/, label: '/v1/*' },
]

function matchBlockedRule(path: string, method: string): BlockedForUserRule | null {
  for (const rule of BLOCKED_FOR_USER_RULES) {
    if (!rule.re.test(path)) continue
    if (rule.methods && !rule.methods.has(method)) continue
    return rule
  }
  return null
}

/**
 * v3 file proxy PROXY 路径。命中的请求:
 *   - user role + DB status=active → containerFileProxy 代理到容器
 *   - admin / 无 JWT / 过期 → fall through 给 BLOCKED 继续走(admin bypass / 401)
 *   - user banned → 403 FORBIDDEN(terminal)
 *
 * 排在 BLOCKED_FOR_USER_RULES 之前。BLOCKED 里的 /api/file + /api/media/* 仍保留
 * 作为 feature flag OFF 时 + POST/PUT/DELETE 兜底的路径。
 */
interface ProxyForUserRule {
  re: RegExp
  methods: ReadonlySet<string>
  label: string
}
const PROXY_FOR_USER_RULES: readonly ProxyForUserRule[] = [
  { re: /^\/api\/file$/, methods: M('GET'), label: '/api/file' },
  { re: /^\/api\/media\/.+$/, methods: M('GET'), label: '/api/media/:file' },
]

function matchProxyRule(path: string, method: string, enabled: boolean): ProxyForUserRule | null {
  if (!enabled) return null
  for (const rule of PROXY_FOR_USER_RULES) {
    if (!rule.re.test(path)) continue
    if (!rule.methods.has(method)) continue
    return rule
  }
  return null
}

export type CommercialHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/**
 * 从 req 抽 bearer token(header / cookie)—— 匹配 gateway/server.ts `extractToken`
 * 对 HTTP 请求的 fallback 顺序。WS `sec-websocket-protocol` 不在这里抽,BLOCKED 路径
 * 都是 HTTP REST,没有 WS upgrade。
 *
 * 导出给 middleware/maintenanceMode 复用(同一 token 提取逻辑,避免漂移)。
 *
 * **策略**:Bearer header 优先,缺则回落到 `oc_session` cookie。这是 WS auth /
 * maintenanceMode / 普通 REST 的默认。v1.0.159 起,`/api/media-sign` 因 boss
 * 把 HttpOnly cookie 定为浏览器会话权威源(消除 split-brain),走自己的 **cookie
 * 优先 + Bearer 兜底 + dual verify** 策略,不复用本 helper —— 见 handleMediaSign。
 *
 * 实现细节:Bearer / Cookie 各自的字面量解析下放到 `authHelpers.ts`,本函数只
 * 拼策略 + bearer-first 默认。
 *
 * **行为微调(v1.0.159)**:旧 inline 实现 `Authorization` 非空就直接当 token 用
 * (含 `Basic xxx` / 其他 scheme),后续 verify 必然失败 → 等同 401。新版 `getBearerToken`
 * 只在严格匹配 `^Bearer\s+` 时返回 token,其他 scheme → 空 → 回落 cookie 再试一次。
 * 不构成安全漏洞(cookie 自身仍走 verify),也跟"Bearer 兜底"语义更对齐。
 * 注:此 helper 跟 `/api/media-sign` 的 cookie-first 策略**反向**,两条路径各自
 * doc 自洽,不互相覆盖。
 */
export function extractTokenFromReq(req: IncomingMessage): string {
  const bearer = getBearerToken(req)
  if (bearer) return bearer
  return getSessionCookieToken(req)
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
) => Promise<void>

/**
 * B2 — `/api/admin/*` 路由层 admin gate 的**例外白名单**(method-aware,`"METHOD path"`)。
 * 仅列自带鉴权、不能被 requireAdminVerifyDb 拦的机器路由:
 *   - `GET /api/admin/metrics`:Prometheus 抓取,走 COMMERCIAL_METRICS_BEARER 或 admin JWT
 *     (见 http/admin/metrics.ts;其 JWT 回落已升级为 requireAdminVerifyDb)。
 * method-aware:非 GET 的 /api/admin/metrics(如 POST,method-mismatch)**不**在白名单内,
 * 仍先过 admin gate → 不向非 admin 泄露该路由/method 存在性。
 * 新增 admin 路由默认被 gate;要豁免必须显式进此白名单(可见、可审)。
 */
const ADMIN_SELF_AUTH_ROUTES = new Set<string>(['GET /api/admin/metrics'])

interface Route {
  method: string
  /**
   * 精确路径。动态参数路由(如 `/api/payment/orders/:order_no`)用 `pathPrefix` 字段,
   * 不在这里出现。
   */
  path?: string
  /**
   * 前缀匹配:path 以 `pathPrefix` 开头的请求都会命中。Handler 自己从 url 中抽参数。
   * 用于少数带路径变量的 GET 接口。同一 method 多个 prefix 顺序即优先级。
   */
  pathPrefix?: string
  handler: RouteHandler
}

export function createCommercialHandler(
  deps: CommercialHttpDeps,
  options: {
    /** 测试可注入特定 logger;默认走 rootLogger.child({ subsys: "commercial" }) */
    logger?: Logger
  } = {},
): CommercialHandler {
  const httpLogger = options.logger ?? rootLogger.child({ subsys: 'commercial' })
  const routes: Route[] = [
    { method: 'POST', path: '/api/auth/register', handler: handleRegister },
    { method: 'POST', path: '/api/auth/login', handler: handleLogin },
    { method: 'POST', path: '/api/auth/refresh', handler: handleRefresh },
    { method: 'POST', path: '/api/auth/logout', handler: handleLogout },
    { method: 'POST', path: '/api/auth/verify-email', handler: handleVerifyEmail },
    { method: 'POST', path: '/api/auth/resend-verification', handler: handleResendVerification },
    { method: 'GET', path: '/api/auth/check-verification', handler: handleCheckVerification },
    {
      method: 'POST',
      path: '/api/auth/request-password-reset',
      handler: handleRequestPasswordReset,
    },
    {
      method: 'POST',
      path: '/api/auth/confirm-password-reset',
      handler: (req, res) => handleConfirmPasswordReset(req, res),
    },
    // LINUX DO Connect (LDC) SSO —— 一键登录入口 / OAuth callback
    //   start:GET 顶层导航,302 → connect.linux.do/oauth2/authorize
    //   callback:GET 顶层导航,LDC 把用户带回来,落库 + 签 token + 302 → /?source=linuxdo
    //   失败一律 302 → /?login=1&oauth_error=<code>(SPA 接管 toast)
    { method: 'GET', path: '/api/auth/linuxdo/start', handler: handleLinuxdoStart },
    { method: 'GET', path: '/api/auth/linuxdo/callback', handler: handleLinuxdoCallback },
    // GitHub OAuth 账号关联 —— 已登录用户将本地账号与 GitHub 账号绑定
    //   start:POST(需 Bearer JWT),返回 JSON { authorizeUrl, state } + Set-Cookie state
    //   callback:GET(GitHub 回跳),落库 github_links + 302 → /?github_linked=1
    //   失败一律 302 → /?github_error=<code>(SPA 接管 toast)
    { method: 'POST', path: '/api/auth/github/start', handler: handleGithubStart },
    { method: 'GET', path: '/api/auth/github/callback', handler: handleGithubCallback },
    // v3 file proxy: 用 Bearer access token 换一个 HttpOnly `oc_session` cookie,
    // 让 `<a href>` / `<img>` 等原生下载链接能携带身份(见 handlers.ts 详注)
    { method: 'POST', path: '/api/auth/session', handler: handleCreateSession },
    { method: 'POST', path: '/api/auth/session/logout', handler: handleClearSession },
    // v3 signed media URL —— iOS Safari + CF SameSite=Strict cookie drop 修复
    //   /api/media-sign  (POST, Bearer)  → 把绝对路径数组换成 signed URL map
    //   /api/media-signed (GET, anon)    → HMAC + DB active 校验后转发到容器
    // 详见 handlers.ts handleMediaSign / handleMediaSigned 注释。
    { method: 'POST', path: '/api/media-sign', handler: handleMediaSign },
    { method: 'GET', path: '/api/media-signed', handler: handleMediaSigned },
    { method: 'GET', path: '/wx/live', handler: handleWechatLivePage },
    { method: 'GET', path: '/api/wechat/live', handler: handleWechatLiveSnapshot },
    { method: 'GET', path: '/api/me', handler: handleMe },
    // V3 Phase 2 Task 2G: 用户偏好(主题/默认模型/effort/通知/快捷键)
    { method: 'GET', path: '/api/me/preferences', handler: handleGetMyPreferences },
    { method: 'PATCH', path: '/api/me/preferences', handler: handlePatchMyPreferences },
    // 使用消耗统计(含 summary / sessions 分页 / ledger 分页 / savings)
    { method: 'GET', path: '/api/me/usage', handler: handleGetMyUsage },
    // V3 CC 外接 plan Phase 4(2026-05-18):用户自管 CC 外接 API key 的管理面。
    //   GET    /api/me/api-keys           → list 未撤销 key(无 secret)
    //   POST   /api/me/api-keys { label } → 创建,**返完整明文一次**
    //   DELETE /api/me/api-keys/:id       → 软撤销
    // DELETE 用 pathPrefix + handler 内 regex 抠 :id(同 /api/me/messages/:id/read 范本)。
    // exact path 注册在 prefix 之前(matchRoute exact-first),不会冲突。
    { method: 'GET', path: '/api/me/api-keys', handler: handleListMyApiKeys },
    { method: 'POST', path: '/api/me/api-keys', handler: handleCreateMyApiKey },
    { method: 'DELETE', pathPrefix: '/api/me/api-keys/', handler: handleRevokeMyApiKey },
    // 用户文献库(research_documents 管理面):列表 / 上传入库(raw bytes) / 删单篇。
    // 详见 handlers.ts 对应 handler 注释;数据逻辑在 research/library.ts。
    { method: 'GET', path: '/api/me/research/library', handler: handleListResearchLibrary },
    { method: 'POST', path: '/api/me/research/library', handler: handleUploadResearchLibraryDoc },
    { method: 'DELETE', pathPrefix: '/api/me/research/library/', handler: handleDeleteResearchLibraryDoc },
    { method: 'GET', path: '/api/public/config', handler: handleGetPublicConfig },
    { method: 'GET', path: '/api/public/models', handler: handleListPublicModels },
    // V3 Phase 2 Task 2F: 容器/前端按 spec 用 /api/models;沿用 /api/public/models 同一 handler
    { method: 'GET', path: '/api/models', handler: handleListPublicModels },
    { method: 'GET', path: '/api/payment/plans', handler: handleListPlans },
    { method: 'POST', path: '/api/payment/hupi/create', handler: handleCreateHupi },
    { method: 'POST', path: '/api/payment/hupi/callback', handler: handleHupiCallback },
    // v5 灰度独立回调路径:虎皮椒服务器回调不带 X-OC-V5-Secret/oc_v5 cookie,共享路径会被
    // Caddy 默认路由送进 v3 —— 而 v3 的 markOrderPaid 对 kind 零感知,会把 v5 的
    // subscription/upgrade/pack 订单按「永久钱包充值」错误履约(订阅未开通+期内额度变永久)。
    // v5 订单 notifyUrl 指到本路径(HUPIJIAO_CALLBACK_URL env),Caddy 按 path 定向 18790。
    // 同一 handler:验签/幂等/kind 分支履约逻辑不变。
    { method: 'POST', path: '/api/payment/hupi/callback-v5', handler: handleHupiCallback },
    { method: 'GET', pathPrefix: '/api/payment/orders/', handler: handleGetOrder },
    // 月度订阅（0096）。订单轮询复用 /api/payment/orders/:order_no；履约走 hupi/callback。
    { method: 'GET', path: '/api/subscription/plans', handler: handleListSubscriptionPlans },
    { method: 'GET', path: '/api/subscription/me', handler: handleGetMySubscription },
    { method: 'POST', path: '/api/subscription/subscribe', handler: handleSubscribe },
    { method: 'POST', path: '/api/subscription/upgrade', handler: handleUpgrade },
    { method: 'POST', path: '/api/subscription/pack', handler: handleBuyPack },
    // T-53 Agent 订阅
    { method: 'POST', path: '/api/agent/open', handler: handleAgentOpen },
    { method: 'GET', path: '/api/agent/status', handler: handleAgentStatus },
    { method: 'POST', path: '/api/agent/cancel', handler: handleAgentCancel },
    // ── Skill marketplace (B2) — browser-only user/admin routes ──
    // These serve commercial browser users (requireAuth / requireAdminVerifyDb).
    // Agent-bypass is enforced structurally, NOT via BLOCKED_FOR_USER_RULES (that
    // table would 403 the very users we serve): /api/marketplace/* is absent from
    // BRIDGE_API_ALLOWLIST so a container can't proxy to it, and these handlers
    // require a browser user JWT a container never holds.
    {
      method: 'POST',
      path: '/api/marketplace/publish',
      handler: (req, res) => handleMarketplacePublish(req, res, deps),
    },
    {
      method: 'GET',
      path: '/api/marketplace/search',
      handler: (req, res) => handleMarketplaceSearch(req, res, deps),
    },
    {
      method: 'POST',
      path: '/api/marketplace/agent/publish',
      handler: (req, res) => handleMarketplaceAgentPublish(req, res, deps),
    },
    {
      method: 'GET',
      path: '/api/marketplace/my-agents',
      handler: (req, res) => handleMarketplaceMyAgents(req, res, deps),
    },
    {
      method: 'POST',
      path: '/api/marketplace/install',
      handler: (req, res) => handleMarketplaceInstall(req, res, deps),
    },
    {
      method: 'GET',
      path: '/api/marketplace/installed',
      handler: (req, res) => handleMarketplaceInstalled(req, res, deps),
    },
    {
      method: 'PATCH',
      pathPrefix: '/api/marketplace/installed/',
      handler: (req, res) => handleMarketplaceInstalledScope(req, res, deps),
    },
    {
      method: 'GET',
      path: '/api/marketplace/my-publishes',
      handler: (req, res) => handleMarketplaceMyPublishes(req, res, deps),
    },
    {
      method: 'POST',
      pathPrefix: '/api/marketplace/my-publishes/',
      handler: (req, res) => handleMarketplaceWithdrawPublish(req, res, deps),
    },
    {
      method: 'DELETE',
      pathPrefix: '/api/marketplace/installed/',
      handler: (req, res) => handleMarketplaceUninstall(req, res, deps),
    },
    {
      method: 'POST',
      pathPrefix: '/api/marketplace/',
      handler: (req, res) => handleMarketplaceUnlist(req, res, deps),
    },
    // detail by slug — prefix; exact /installed (+ later /search) match first
    {
      method: 'GET',
      pathPrefix: '/api/marketplace/',
      handler: (req, res) => handleMarketplaceDetail(req, res, deps),
    },
    {
      method: 'GET',
      path: '/api/admin/marketplace/pending',
      handler: (req, res) => handleAdminMarketplacePending(req, res, deps),
    },
    {
      method: 'POST',
      path: '/api/admin/marketplace/review-batch',
      handler: (req, res) => handleAdminMarketplaceReviewBatch(req, res, deps),
    },
    {
      method: 'POST',
      pathPrefix: '/api/admin/marketplace/',
      handler: (req, res) =>
        (req.url ?? '').includes('/revoke')
          ? handleAdminMarketplaceRevoke(req, res, deps)
          : handleAdminMarketplaceReview(req, res, deps),
    },
    // FEATURE_REMOTE_SSH —— 用户远程执行机 CRUD + test + reset-fingerprint。
    //   列表 / 创建走 exact path;读/改/删/action 走 prefix(handler 自抽 :id)。
    //   POST prefix 同时承载 /:id/test 和 /:id/reset-fingerprint,handler 内按 suffix 派发。
    { method: 'GET', path: '/api/remote-hosts', handler: handleListRemoteHosts },
    { method: 'POST', path: '/api/remote-hosts', handler: handleCreateRemoteHost },
    { method: 'GET', pathPrefix: '/api/remote-hosts/', handler: handleGetRemoteHost },
    { method: 'PATCH', pathPrefix: '/api/remote-hosts/', handler: handlePatchRemoteHost },
    { method: 'DELETE', pathPrefix: '/api/remote-hosts/', handler: handleDeleteRemoteHost },
    { method: 'POST', pathPrefix: '/api/remote-hosts/', handler: handleRemoteHostAction },
    // T-54 Agent 审计(超管)
    { method: 'GET', path: '/api/admin/agent-audit', handler: handleAdminAgentAudit },
    // T-60 超管 API —— 用户管理
    { method: 'GET', path: '/api/admin/users', handler: handleAdminListUsers },
    // R2:exact path 在 pathPrefix 之前优先匹配,避免被 /users/:id 吞掉。
    { method: 'GET', path: '/api/admin/users/stats', handler: handleAdminUsersStats },
    // 动态路径用 pathPrefix。/api/admin/users/:id/credits 优先匹配,
    // 后退到 /api/admin/users/:id(GET/PATCH)。Handler 自己区分。
    { method: 'POST', pathPrefix: '/api/admin/users/', handler: handleAdminAdjustCredits },
    { method: 'GET', pathPrefix: '/api/admin/users/', handler: handleAdminGetUser },
    { method: 'PATCH', pathPrefix: '/api/admin/users/', handler: handleAdminPatchUser },
    // 0049 model-grants:DELETE /api/admin/users/:id/model-grants/:model_id —— 撤销授权
    // /api/admin/users/ prefix 下目前只这一个 DELETE 子资源,handler 自带 path 校验
    { method: 'DELETE', pathPrefix: '/api/admin/users/', handler: handleAdminRemoveUserModelGrant },
    // T-60 超管审计记录
    { method: 'GET', path: '/api/admin/audit', handler: handleAdminListAudit },
    // T-60 超管定价
    { method: 'GET', path: '/api/admin/pricing', handler: handleAdminListPricing },
    { method: 'PATCH', pathPrefix: '/api/admin/pricing/', handler: handleAdminPatchPricing },
    // DeepXiv 文献检索(平台级,单例) — exact-path 在 test 子资源之前
    { method: 'GET', path: '/api/admin/literature', handler: handleAdminGetLiterature },
    { method: 'PATCH', path: '/api/admin/literature', handler: handleAdminPatchLiterature },
    { method: 'POST', path: '/api/admin/literature/test', handler: handleAdminTestLiterature },
    // T-60 超管充值套餐
    { method: 'GET', path: '/api/admin/plans', handler: handleAdminListPlans },
    { method: 'PATCH', pathPrefix: '/api/admin/plans/', handler: handleAdminPatchPlan },
    // T-60 超管账号池
    { method: 'GET', path: '/api/admin/accounts', handler: handleAdminListAccounts },
    { method: 'POST', path: '/api/admin/accounts', handler: handleAdminCreateAccount },
    // R3:exact path 在 pathPrefix 之前精确命中(matchRoute exact-first)
    { method: 'GET', path: '/api/admin/accounts/stats', handler: handleAdminAccountsStats },
    // M6/P1-9 — refresh 历史 exact path,必须排在 pathPrefix 之前
    {
      method: 'GET',
      path: '/api/admin/accounts/refresh-events',
      handler: handleAdminListRefreshEvents,
    },
    // OAuth 引导:exact path 必须排在 prefix 之前(prefix 才能 fall through)
    { method: 'POST', path: '/api/admin/accounts/oauth/start', handler: handleAdminOAuthStart },
    {
      method: 'POST',
      path: '/api/admin/accounts/oauth/exchange',
      handler: handleAdminOAuthExchange,
    },
    // R3:reset-cooldown 子资源。pathPrefix 命中 /accounts/,handler 内部用 regex 抠
    //  `/accounts/:id/reset-cooldown`;POST 会先匹配到这条(method 一致),
    //  adjustCredits 走的是不同 prefix。
    {
      method: 'POST',
      pathPrefix: '/api/admin/accounts/',
      handler: handleAdminResetAccountCooldown,
    },
    { method: 'GET', pathPrefix: '/api/admin/accounts/', handler: handleAdminGetAccount },
    { method: 'PATCH', pathPrefix: '/api/admin/accounts/', handler: handleAdminPatchAccount },
    { method: 'DELETE', pathPrefix: '/api/admin/accounts/', handler: handleAdminDeleteAccount },
    // T-60 超管账号池分组 / API 中转站凭据
    { method: 'GET', path: '/api/admin/account-groups', handler: handleAdminListAccountGroups },
    { method: 'POST', path: '/api/admin/account-groups', handler: handleAdminCreateAccountGroup },
    // credential 子资源必须排在通用 group prefix 前,否则被 /:id 解析吞掉。
    {
      method: 'PATCH',
      pathPrefix: '/api/admin/account-groups/relay-credentials/',
      handler: handleAdminPatchRelayCredential,
    },
    {
      method: 'DELETE',
      pathPrefix: '/api/admin/account-groups/relay-credentials/',
      handler: handleAdminDeleteRelayCredential,
    },
    {
      method: 'PUT',
      pathPrefix: '/api/admin/account-groups/',
      handler: handleAdminPutAccountGroupModels,
    },
    {
      method: 'POST',
      pathPrefix: '/api/admin/account-groups/',
      handler: handleAdminCreateRelayCredential,
    },
    {
      method: 'GET',
      pathPrefix: '/api/admin/account-groups/',
      handler: handleAdminGetAccountGroup,
    },
    {
      method: 'PATCH',
      pathPrefix: '/api/admin/account-groups/',
      handler: handleAdminPatchAccountGroup,
    },
    {
      method: 'DELETE',
      pathPrefix: '/api/admin/account-groups/',
      handler: handleAdminDeleteAccountGroup,
    },
    // V3 — Egress Proxy Pool(决策 P/Q/R)
    // exact path 在 prefix 之前命中(matchRoute exact-first)
    { method: 'GET', path: '/api/admin/egress-proxies', handler: handleAdminListEgressProxies },
    { method: 'POST', path: '/api/admin/egress-proxies', handler: handleAdminCreateEgressProxy },
    { method: 'GET', pathPrefix: '/api/admin/egress-proxies/', handler: handleAdminGetEgressProxy },
    {
      method: 'PATCH',
      pathPrefix: '/api/admin/egress-proxies/',
      handler: handleAdminPatchEgressProxy,
    },
    {
      method: 'DELETE',
      pathPrefix: '/api/admin/egress-proxies/',
      handler: handleAdminDeleteEgressProxy,
    },
    // T-60 超管 Agent 容器
    { method: 'GET', path: '/api/admin/agent-containers', handler: handleAdminListAgentContainers },
    // R4:exact path 在 pathPrefix 之前(matchRoute exact-first)
    {
      method: 'GET',
      path: '/api/admin/agent-containers/stats',
      handler: handleAdminContainersStats,
    },
    // R4:GET /:id/logs(handler 内部 regex 匹配,其它 GET 子路径回 404)
    {
      method: 'GET',
      pathPrefix: '/api/admin/agent-containers/',
      handler: handleAdminContainerLogs,
    },
    {
      method: 'POST',
      pathPrefix: '/api/admin/agent-containers/',
      handler: handleAdminAgentContainerAction,
    },
    // T-60 超管积分流水
    // P1-5: `.csv` 是写路由(写 audit),与 GET `/ledger` 共存。matchRoute 用 exact-first,
    // 两条 exact 互不干扰,顺序无关。
    { method: 'GET', path: '/api/admin/ledger.csv', handler: handleAdminExportLedgerCsv },
    { method: 'GET', path: '/api/admin/ledger', handler: handleAdminListLedger },
    // M8.4 / P2-20 超管 CSV 导出 + 诊断 endpoint(三处都写 admin_audit)
    { method: 'GET', path: '/api/admin/users.csv', handler: handleAdminExportUsersCsv },
    { method: 'GET', path: '/api/admin/orders.csv', handler: handleAdminExportOrdersCsv },
    { method: 'GET', path: '/api/admin/diagnostics', handler: handleAdminDiagnostics },
    // T-62 Prometheus 指标
    { method: 'GET', path: '/api/admin/metrics', handler: handleAdminMetrics },
    // T-60 R1 Dashboard 聚合(只读,requireAdmin JWT only)
    { method: 'GET', path: '/api/admin/stats/dau', handler: handleAdminStatsDau },
    {
      method: 'GET',
      path: '/api/admin/stats/revenue-by-day',
      handler: handleAdminStatsRevenueByDay,
    },
    {
      method: 'GET',
      path: '/api/admin/stats/signups-by-day',
      handler: handleAdminStatsSignupsByDay,
    },
    {
      method: 'GET',
      path: '/api/admin/stats/funnel',
      handler: handleAdminStatsFunnel,
    },
    {
      method: 'GET',
      path: '/api/admin/stats/request-series',
      handler: handleAdminStatsRequestSeries,
    },
    {
      method: 'GET',
      path: '/api/admin/stats/alerts-summary',
      handler: handleAdminStatsAlertsSummary,
    },
    { method: 'GET', path: '/api/admin/stats/account-pool', handler: handleAdminStatsAccountPool },
    // P2 Plan v10 — 虚机利用率分布 + 7d 告警事件分布(dashboard 重排新增)
    {
      method: 'GET',
      path: '/api/admin/stats/hosts-utilization',
      handler: handleAdminStatsHostsUtilization,
    },
    {
      method: 'GET',
      path: '/api/admin/stats/alert-events-7d',
      handler: handleAdminStatsAlertEvents7d,
    },
    // 运营至今累计指标(无窗口)。前端 dashboard 首屏 + 手动刷新触发,不进 30s 轮询。
    {
      method: 'GET',
      path: '/api/admin/stats/lifetime',
      handler: handleAdminStatsLifetime,
    },
    // V3 Phase 4H 超管运行时设置(allowlist + per-key zod)
    { method: 'GET', path: '/api/admin/settings', handler: handleAdminListSettings },
    { method: 'GET', pathPrefix: '/api/admin/settings/', handler: handleAdminGetSetting },
    { method: 'PUT', pathPrefix: '/api/admin/settings/', handler: handleAdminPutSetting },
    // T-63 超管告警(WeChat 推送)—— exact path 在前,prefix 在后
    { method: 'GET', path: '/api/admin/alerts/events', handler: handleAdminAlertsListEvents },
    // P3 — 事件覆盖矩阵(EVENT_META + channel join + 30d outbox 最近一次)
    { method: 'GET', path: '/api/admin/alerts/events/coverage', handler: handleListEventCoverage },
    { method: 'GET', path: '/api/admin/alerts/channels', handler: handleAdminAlertsListChannels },
    {
      method: 'POST',
      path: '/api/admin/alerts/ilink/qrcode',
      handler: handleAdminAlertsIlinkQrcode,
    },
    { method: 'POST', path: '/api/admin/alerts/ilink/poll', handler: handleAdminAlertsIlinkPoll },
    { method: 'GET', path: '/api/admin/alerts/outbox', handler: handleAdminAlertsListOutbox },
    { method: 'GET', path: '/api/admin/alerts/silences', handler: handleAdminAlertsListSilences },
    { method: 'POST', path: '/api/admin/alerts/silences', handler: handleAdminAlertsCreateSilence },
    {
      method: 'GET',
      path: '/api/admin/alerts/rule-states',
      handler: handleAdminAlertsListRuleStates,
    },
    // M8.3/P2-21:outbox 行手动重试 + rule firing ack。handler 自己校验
    // path 后缀 /retry / /ack,非匹配翻 404。
    {
      method: 'POST',
      pathPrefix: '/api/admin/alerts/outbox/',
      handler: handleAdminAlertsRetryOutbox,
    },
    {
      method: 'POST',
      pathPrefix: '/api/admin/alerts/rules/',
      handler: handleAdminAlertsAckRule,
    },
    // /api/admin/alerts/channels/:id   (PATCH / DELETE)
    // /api/admin/alerts/channels/:id/test (POST) —— handler 自己校验后缀
    // exact route 优先于 prefix(router 先 exact 后 prefix),保证 /telegram
    // 不会被 :id dispatcher 吞掉。
    {
      method: 'POST',
      path: '/api/admin/alerts/channels/telegram',
      handler: handleAdminAlertsCreateTelegramChannel,
    },
    {
      method: 'PATCH',
      pathPrefix: '/api/admin/alerts/channels/',
      handler: handleAdminAlertsPatchChannel,
    },
    {
      method: 'DELETE',
      pathPrefix: '/api/admin/alerts/channels/',
      handler: handleAdminAlertsDeleteChannel,
    },
    {
      method: 'POST',
      pathPrefix: '/api/admin/alerts/channels/',
      handler: handleAdminAlertsTestChannel,
    },
    // /api/admin/alerts/silences/:id   (DELETE)
    {
      method: 'DELETE',
      pathPrefix: '/api/admin/alerts/silences/',
      handler: handleAdminAlertsDeleteSilence,
    },
    // V3 D.3 多机 compute_hosts 管理(超管)
    //   exact path 优先于 pathPrefix(matchRoute exact-first),所以
    //   /compute-hosts 和 /compute-hosts/add 不会被 prefix handler 吞掉。
    //   pathPrefix GET 在 handler 内部 switch action(bootstrap-log / containers / 404)。
    //   pathPrefix POST 按 action 分发 drain / remove / quarantine-clear。
    { method: 'GET', path: '/api/admin/v3/compute-hosts', handler: handleAdminListComputeHosts },
    { method: 'POST', path: '/api/admin/v3/compute-hosts/add', handler: handleAdminAddComputeHost },
    { method: 'GET', path: '/api/admin/v3/baseline-version', handler: handleAdminBaselineVersion },
    // V3: 把 OC_RUNTIME_IMAGE 推到所有 ready remote host(同步等返回 per-host result)
    // 单 host 路径在 prefix POST handler 里(action=distribute-image)
    {
      method: 'POST',
      path: '/api/admin/v3/distribute-image',
      handler: handleAdminDistributeImageToAllHosts,
    },
    {
      method: 'GET',
      pathPrefix: '/api/admin/v3/compute-hosts/',
      handler: handleAdminComputeHostGetSubresource,
    },
    {
      method: 'POST',
      pathPrefix: '/api/admin/v3/compute-hosts/',
      handler: handleAdminComputeHostAction,
    },
    // P1-2 用户反馈入库(commercial 接管;gateway/server.ts:1325 那段对 commercial 已是死路)
    //   匿名 / 已登录均可,IP 限流防 spam(handler 内 enforceRateLimit)
    { method: 'POST', path: '/api/feedback', handler: handleSubmitFeedback },
    // 2026-06-18 前端问题自动上报(commercial 接管;结构化日志按 traceId 落 journald)
    //   匿名 / 已登录均可,IP 限流(handler 内 enforceRateLimit,比 feedback 宽)
    { method: 'POST', path: '/api/client-errors', handler: handleClientErrorReport },
    // P0-3 订单 admin —— exact path 在 prefix 之前(matchRoute exact-first)
    //   /api/admin/orders/kpi 必须排前,否则会被 /api/admin/orders/ prefix 吞成 ORDER_NOT_FOUND
    { method: 'GET', path: '/api/admin/orders', handler: handleAdminListOrders },
    { method: 'GET', path: '/api/admin/orders/kpi', handler: handleAdminOrdersKpi },
    { method: 'GET', pathPrefix: '/api/admin/orders/', handler: handleAdminGetOrder },
    // P1-2 反馈 admin —— GET 列表 / POST :id/ack
    { method: 'GET', path: '/api/admin/feedback', handler: handleAdminListFeedback },
    { method: 'POST', pathPrefix: '/api/admin/feedback/', handler: handleAdminAckFeedback },
    // 站内信(in-app messages)用户侧
    //   GET  /api/me/messages                    → 列表 + unread_count
    //   GET  /api/me/messages/unread_count       → 仅 unread_count(polling 用)
    //   POST /api/me/messages/:id/read           → 标记单条已读(handler 自己 regex 抠 :id)
    //   POST /api/me/messages/read_all           → 一次清完
    //   exact 排在 pathPrefix 前(matchRoute exact-first),:id/read 走 prefix 兜底
    // GitHub 集成 — link 元信息 + repos/branches 列表 + per-session 选择
    //   exact path 排在 prefix 之前(matchRoute exact-first)
    //   /api/me/github          → link meta(GET / DELETE)
    //   /api/me/github/repos    → 列 repos(GET exact)
    //   /api/me/github/repos/:owner/:repo/branches → 列 branches(GET prefix,handler 内 regex)
    //   /api/me/sessions/:sid/github-selection     → session 选择(GET / PUT / DELETE,prefix + handler regex)
    { method: 'GET', path: '/api/me/github', handler: handleGetMyGithub },
    { method: 'DELETE', path: '/api/me/github', handler: handleDeleteMyGithub },
    { method: 'GET', path: '/api/me/github/repos', handler: handleListMyGithubRepos },
    { method: 'GET', pathPrefix: '/api/me/github/repos/', handler: handleListMyGithubBranches },
    { method: 'GET', pathPrefix: '/api/me/sessions/', handler: handleGetSessionGithubSelection },
    { method: 'PUT', pathPrefix: '/api/me/sessions/', handler: handlePutSessionGithubSelection },
    {
      method: 'DELETE',
      pathPrefix: '/api/me/sessions/',
      handler: handleDeleteSessionGithubSelection,
    },
    { method: 'GET', path: '/api/me/messages', handler: handleListMyInbox },
    { method: 'GET', path: '/api/me/messages/unread_count', handler: handleCountMyInboxUnread },
    { method: 'POST', path: '/api/me/messages/read_all', handler: handleReadAllInbox },
    { method: 'POST', pathPrefix: '/api/me/messages/', handler: handleMarkInboxRead },
    // 站内信 admin 侧
    //   GET    /api/admin/messages              → 列表(只读 requireAdmin)
    //   POST   /api/admin/messages              → 创建(requireAdminVerifyDb)
    //   DELETE /api/admin/messages/:id          → 删除(requireAdminVerifyDb)
    //   GET    /api/admin/messages/email-config → 邮件 worker 状态探测(Plan C)
    //                                              **必须在 DELETE prefix 之前注册**
    //                                              否则 GET /messages/email-config 匹配不上.
    //                                              注:GET /api/admin/messages/email-config 走
    //                                              path 完全匹配,不是 prefix,所以独立项即可.
    { method: 'GET', path: '/api/admin/messages', handler: handleAdminListInbox },
    {
      method: 'GET',
      path: '/api/admin/messages/email-config',
      handler: handleAdminGetInboxEmailConfig,
    },
    { method: 'POST', path: '/api/admin/messages', handler: handleAdminCreateInbox },
    { method: 'DELETE', pathPrefix: '/api/admin/messages/', handler: handleAdminDeleteInbox },

    // ── /api/admin/sessions/:id —— admin 只读看用户对话内容 ────────────────
    //   GET /api/admin/sessions/:id[?user_id=:userId]
    //   - rendering session_id 是 TEXT(UUID/nanoid),handler 自带正则校验
    //   - 不写 admin_audit("3 不留痕")
    //   - 详见 admin/sessions.ts header comment
    { method: 'GET', pathPrefix: '/api/admin/sessions/', handler: handleAdminGetSession },
  ]
  // 所有命中的前缀,fallback 时通过它判断是否要兜底 405 / 404
  const prefixes = [
    '/api/auth/',
    '/api/me',
    '/api/public/',
    '/api/models', // V3 2F: alias of /api/public/models, GET only
    '/api/payment/',
    '/api/subscription/',
    '/api/agent/',
    '/api/admin/',
    // 匹配 exact `/api/remote-hosts` 与 prefix `/api/remote-hosts/`
    '/api/remote-hosts',
    // P0/P1:commercial user 的 memory/skills/tasks/agent 管理 API 由 master
    // 安全代理到用户自己的容器,维护期应统一 503。
    '/api/agents',
    '/api/cron',
    '/api/tasks',
    '/api/tasks-executions',
    // P1-2 (2026-04-25):commercial 接管 /api/feedback POST,阻止 fall through
    // 到 gateway/server.ts:1325 的文件落盘 handler
    '/api/feedback',
    // 2026-06-18:commercial 接管 /api/client-errors POST,阻止 fall through 到 gateway
    '/api/client-errors',
    // v3 signed media URL —— 同样商业化管,维护期闸门必须覆盖到,否则维护期
    // 用户仍能通过签好的 URL drain 容器文件
    '/api/media-sign',
    '/api/media-signed',
    // WeChat 免登录实时过程页 + 对应只读 JSON 快照 API。
    // 注意:绑定/配对接口(`/api/wechat/binding`, `/api/wechat/pair/*`)
    // 仍由 gateway 自己处理,必须 fall through；这里不能写成 `/api/wechat/`。
    '/wx/live',
    '/api/wechat/live',
    // Skill marketplace (B2). Browser-only commercial routes registered above;
    // must be in `prefixes` so isOurs() is true and the routes actually
    // dispatch (otherwise commercialHandler returns false and falls through).
    // Covers exact `/api/marketplace` + prefix `/api/marketplace/*`; admin
    // marketplace is already covered by `/api/admin/`.
    '/api/marketplace',
    // V3 CC 外接 plan Phase 3(2026-05-18)— public-facing
    // `POST /api/anthropic/v1/messages`。必须列在这里,让:
    //   - maintenance gate(L802 起)能把维护期请求统一 503;
    //   - 末尾 isOurs 兜底命中,无 route 命中时返 404 而非 fall through 给 gateway。
    // 实际 dispatch 由 pre-route adapter 处理(见下方 `CC 外接 endpoint` 块)。
    '/api/anthropic/',
  ]

  return async function commercialHandler(req, res): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    // ── V3 Phase 4H+ maintenance 闸门 ────────────────────────────────────
    //
    // **必须是 commercial handler 的第一步**,早于 file proxy / BLOCKED 分支:
    //   - file proxy:`/api/file` / `/api/media/*` 在维护期也得被 503,否则
    //     付费用户仍能把容器里的文件 drain 出来,维护"停掉所有业务"的意图被绕过。
    //   - BLOCKED (host-scope P0 防火墙):本来就会 403,但 Codex R1 IMPORTANT:
    //     维护期语义应是 503 MAINTENANCE 而不是 403 FORBIDDEN —— 前端对这两个码
    //     的提示 / toast 文案不一样,用户看到 503 会明白"系统正在维护",看到 403
    //     会以为自己被封了。统一用 503 更好。
    //   - 仅对"商业化管路径"做闸门:gateway 自身的路径(如 `/ws`、`/healthz`、
    //     host-scope 读接口等)不在本 handler 处理范围内,isOurs==false 的路径
    //     fall through 给下层 handler 照常走 —— 维护期 health check 必须能过,
    //     cloudflared / k8s liveness 才不会误判。
    //
    // allowlist(维护期也能通):
    //   - /api/admin/*        —— admin 后台必须能用(否则 admin 无法关回维护)
    //   - /api/public/config  —— 前端要读 maintenance 标志才能显示 banner
    //   - /api/auth/logout    —— 已登录用户应该能登出
    //   - /api/auth/refresh   —— 不因短暂维护把所有在线用户强踢 token 过期
    //
    // 这里**先检查 isOurs**,把 "不关心的路径(如 /ws 、/healthz)" 留给下层。
    const isOursForMaintenance = prefixes.some((p) => path === p || path.startsWith(p))
    const isAllowlistForMaintenance =
      path.startsWith('/api/admin/') ||
      path === '/api/public/config' ||
      path === '/api/auth/logout' ||
      path === '/api/auth/refresh'
    if (isOursForMaintenance && !isAllowlistForMaintenance && (await isInMaintenance())) {
      const token = extractTokenFromReq(req)
      const adminOk = await isActiveAdmin(req, token, deps.jwtSecret)
      if (!adminOk) {
        setSecurityHeaders(res)
        const requestId = ensureRequestId(req)
        res.setHeader(REQUEST_ID_HEADER, requestId)
        httpLogger
          .child({ requestId, route: '__maintenance__', method, path })
          .warn('maintenance_block')
        sendError(res, 503, 'MAINTENANCE', '服务正在维护中,请稍后再试', requestId, undefined, {
          'Retry-After': 60,
        })
        incrGatewayRequest('__maintenance__', method, res.statusCode)
        return true
      }
    }

    // ── CC 外接 endpoint(V3 CC 外接 plan Phase 3,2026-05-18)─────────────
    //
    // **精确 match POST /api/anthropic/v1/messages**;其它路径/方法 fall through,
    // 最终走 BLOCKED / isOurs / 404 兜底 —— 不让任何非法 path/method 借 url 重写
    // 渗进 anthropic proxy handler。
    //
    // 为什么是 `/api/anthropic/` 命名空间:`BLOCKED_FOR_USER_RULES` 里 `/^\/v1\/.+$/`
    // 已经把所有 bare /v1/* 公网请求 403,直接暴露 `/v1/messages` 会被自己的护栏拦。
    // 命名空间映射对 CC CLI 透明:`ANTHROPIC_BASE_URL=https://.../api/anthropic` →
    // CLI 拼出 `.../api/anthropic/v1/messages`。
    //
    // adapter 职责(纯 router 层 url 重写,**不**污染 handler 抽象):
    //   1. method + path 双精确;命中才接管,否则继续往后
    //   2. `req.url` 从 `/api/anthropic/v1/messages` 改写成 `/v1/messages`,
    //      让 handler 内部硬编码的 `url.pathname === "/v1/messages"` 白名单照过
    //   3. 合成 ctx:`{ hostUuid: "external-api-key", boundIp: "external-api-key" }`
    //      —— 两个字段都是 sentinel,跟容器路径的真实 (UUID, IP) 形态显式区分。
    //      ApiKeyIdentityStrategy 内部不调 recordHostRequest(plan §4 invariant #6),
    //      hostUuid 仅进 log child;boundIp 在公网链路一般是 Caddy/loopback,既不
    //      参与安全也不指示访客来源 —— 用 sentinel 明确表态"此路径无容器绑定 IP"
    //      (Codex Phase 3 plan-review MINOR 2 采纳)。
    //
    // **装配失败语义**(Codex Phase 3 plan-review MINOR 1 采纳):
    //   - `deps.externalApiKeyProxy` 注入 → 正常分发
    //   - 未注入 → 同一精确路径返 **503 EXTERNAL_PROXY_UNAVAILABLE** + log + metric
    //     而**不是** 404。部署故障不该伪装成"用户 URL 写错了",保留运维可见性。
    if (method === 'POST' && path === '/api/anthropic/v1/messages') {
      setSecurityHeaders(res)
      const requestId = ensureRequestId(req)
      res.setHeader(REQUEST_ID_HEADER, requestId)
      const ccLog = (options.logger ?? rootLogger.child({ subsys: 'commercial' })).child({
        requestId,
        route: '__cc_external__',
        method,
        path,
        clientIp: clientIpOf(req),
      })
      if (!deps.externalApiKeyProxy) {
        ccLog.error('cc_external_proxy_not_assembled')
        sendError(
          res,
          503,
          'EXTERNAL_PROXY_UNAVAILABLE',
          'external api key endpoint not available',
          requestId,
        )
        incrGatewayRequest('__cc_external__', method, res.statusCode)
        return true
      }
      // url 重写:handler 内部白名单只认 "/v1/messages"。保留 query string
      // (anthropic CLI 不带 query,但稳妥起见处理)。
      const original = req.url ?? '/api/anthropic/v1/messages'
      const qIdx = original.indexOf('?')
      req.url = qIdx >= 0 ? `/v1/messages${original.slice(qIdx)}` : '/v1/messages'
      // requestId 贯通:proxy handler 内部会再调一次 ensureRequestId。若入站没有
      // x-request-id,router 这里生成的 id 与 proxy 内部又生成的 id 不一致,
      // log/response header 会被劈成两半。把 router 的 id 写回 req.headers 让
      // proxy 内部的 ensureRequestId 直接复用,保证一次请求一个 id(Codex Phase 3
      // 代码审查 MINOR 采纳)。
      req.headers[REQUEST_ID_HEADER] = requestId
      try {
        await deps.externalApiKeyProxy(req, res, {
          hostUuid: 'external-api-key',
          boundIp: 'external-api-key',
        })
      } catch (err) {
        // handler 内部已 catch + sendJsonError,到这只能是真异常
        handleError(err, res, requestId, ccLog)
      }
      incrGatewayRequest('__cc_external__', method, res.statusCode)
      return true
    }

    // ── P0/P1 v3 user-container API proxy ──────────────────────────────
    // Host-scope personal-version APIs (/api/agents, /api/cron, /api/tasks)
    // are dangerous on the master singleton, but are safe and useful when
    // executed inside the caller's own isolated container. Normal users hit
    // this proxy; admins deliberately fall through to the existing host/admin
    // bypass path for operational debugging.
    if (deps.v3Supervisor && deps.bridgeSecret && matchContainerApiProxyRoute(path, method)) {
      setSecurityHeaders(res)
      const requestId = ensureRequestId(req)
      res.setHeader(REQUEST_ID_HEADER, requestId)
      const apiProxyLog = (options.logger ?? rootLogger.child({ subsys: 'commercial' })).child({
        requestId,
        route: '__container_api_proxy__',
        method,
        path,
        clientIp: clientIpOf(req),
      })
      const token = extractTokenFromReq(req)
      const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null
      if (!claims) {
        // Let BLOCKED_FOR_USER_RULES / gateway auth produce the canonical 401.
      } else if (claims.role === 'admin' && req.headers['x-oc-host-scope'] === '1') {
        // 显式宿主范围(仅 admin,须带 X-OC-Host-Scope: 1):保留 host 级运维调试语义,
        // fall through 到原 admin bypass。默认不再静默落宿主 —— 否则 admin 账号的
        // 管理中心(记忆/定时/技能)读写的是宿主 gateway,与其容器内 agent 的同名数据
        // 完全分裂(2026-07-02 会话 45faa1d3… 实测:面板显示宿主平台任务,agent 却说
        // 没有任务)。用户范围 API 的权威源必须恒为「调用者自己的容器」,admin 也不例外。
      } else {
        // user + admin 都按「自己的容器」验证/代理(admin 也是平台的普通使用者;
        // requireUserVerifyDb 硬编码 role='user',会把 admin 挡成 403)。
        const verified = await requireActiveAccountVerifyDb(
          claims.sub,
          ['user', 'admin'],
          deps.v3Supervisor.pool,
        )
        if (!verified) {
          apiProxyLog.warn('container_api_proxy_user_inactive', { sub: claims.sub })
          sendError(res, 403, 'FORBIDDEN', 'user account not active', requestId)
          incrGatewayRequest('__container_api_proxy__', method, res.statusCode)
          return true
        }
        if (deps.ensureContainerReady) {
          try {
            await deps.ensureContainerReady(BigInt(claims.sub))
          } catch (err) {
            if (err instanceof ContainerUnreadyError) {
              sendError(
                res,
                503,
                'CONTAINER_UNREADY',
                `container not ready: ${err.reason}`,
                requestId,
                undefined,
                { 'Retry-After': err.retryAfterSec },
              )
              incrGatewayRequest('__container_api_proxy__', method, res.statusCode)
              return true
            }
            handleError(err, res, requestId, apiProxyLog)
            incrGatewayRequest('__container_api_proxy__', method, res.statusCode)
            return true
          }
        }
        const ctx: RequestContext = {
          requestId,
          clientIp: clientIpOf(req),
          authBoundIp: req.socket.remoteAddress ?? 'unknown',
          userAgent: userAgentOf(req),
          log: apiProxyLog,
        }
        const startedAt = Date.now()
        try {
          const selfHostIdForProxy = deps.v3Supervisor.selfHostId
          await containerApiProxy(
            req,
            res,
            ctx,
            {
              v3: deps.v3Supervisor,
              bridgeSecret: deps.bridgeSecret,
              selfHostId: selfHostIdForProxy,
              getHostById: computePoolGetHostById,
              tunnelDial: defaultTunnelDial,
            },
            BigInt(claims.sub),
          )
        } catch (err) {
          handleError(err, res, requestId, apiProxyLog)
        }
        incrGatewayRequest('__container_api_proxy__', method, res.statusCode)
        apiProxyLog.info('http_request', {
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        })
        return true
      }
      // fall through to BLOCKED_FOR_USER_RULES for admin/no-token cases
    }

    // ── v3 file proxy PROXY 路径(Stage 4 feature flag ON 时启用)──
    //
    // 必须排在 BLOCKED_FOR_USER_RULES 之前:
    //   - Flag ON + user role + DB active → containerFileProxy 转发到容器
    //   - Flag ON + admin → fall through(BLOCKED 会走 admin bypass 分支)
    //   - Flag ON + user banned → 403 FORBIDDEN(terminal)
    //   - Flag ON + 无 / 过期 / 伪造 JWT → fall through(BLOCKED 会 401)
    //   - Flag OFF → 整个 PROXY 块不介入,仍走 BLOCKED(与上线前一致)
    //
    // deps.v3Supervisor + deps.bridgeSecret 都必须就位才启用 —— 任意缺失视作未启用。
    const proxyRule =
      deps.v3Supervisor && deps.bridgeSecret
        ? matchProxyRule(path, method, !!deps.fileProxyEnabled)
        : null
    if (proxyRule) {
      setSecurityHeaders(res)
      const requestId = ensureRequestId(req)
      res.setHeader(REQUEST_ID_HEADER, requestId)
      const proxyLog = (options.logger ?? rootLogger.child({ subsys: 'commercial' })).child({
        requestId,
        route: '__file_proxy__',
        rule: proxyRule.label,
        method,
        path,
        clientIp: clientIpOf(req),
      })
      const token = extractTokenFromReq(req)
      const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null
      if (!claims) {
        // 无 / 过期 / 伪造 → fall through 给 BLOCKED(最终 401)
        // 不在这里 return true:让 BLOCKED 分支写响应
      } else if (claims.role === 'admin') {
        // admin → 走 BLOCKED 的 admin bypass(保留运维查盘能力)
        // 同样 fall through
      } else {
        // commercial user:DB double-check status=active
        const verified = await requireUserVerifyDb(claims.sub, deps.v3Supervisor!.pool)
        if (!verified) {
          proxyLog.warn('file_proxy_user_inactive', { sub: claims.sub })
          sendError(res, 403, 'FORBIDDEN', 'user account not active', requestId)
          incrGatewayRequest('__file_proxy__', method, res.statusCode)
          return true
        }
        proxyLog.info('file_proxy_dispatch', { sub: claims.sub })

        // v1.0.192 冷启动护栏 —— `/api/file` + `/api/media/:file` 与
        // `/api/media-signed` 同一底层 containerFileProxy,容器 stopped 时同样
        // 翻 503 CONTAINER_NOT_RUNNING。这里调 deps.ensureContainerReady 触发
        // 与 WS bridge + signed URL 共享的 sharedEnsureRunning per-uid singleflight。
        // 时机:user active DB 校验通过后(避免给无权 / admin / 无 token 用户白
        // 触发 docker provision)。admin / 无 token 已在上面分支 fall through。
        if (deps.ensureContainerReady) {
          try {
            await deps.ensureContainerReady(BigInt(claims.sub))
          } catch (err) {
            if (err instanceof ContainerUnreadyError) {
              sendError(
                res,
                503,
                'CONTAINER_UNREADY',
                `container not ready: ${err.reason}`,
                requestId,
                undefined,
                { 'Retry-After': err.retryAfterSec },
              )
              incrGatewayRequest('__file_proxy__', method, res.statusCode)
              return true
            }
            handleError(err, res, requestId, proxyLog)
            incrGatewayRequest('__file_proxy__', method, res.statusCode)
            return true
          }
        }

        const ctx: RequestContext = {
          requestId,
          clientIp: clientIpOf(req),
          authBoundIp: req.socket.remoteAddress ?? 'unknown',
          userAgent: userAgentOf(req),
          log: proxyLog,
        }
        const startedAt = Date.now()
        try {
          // 多 host wiring:selfHostId 从 v3Supervisor.selfHostId 透传(单机 monolith
          // 时为 undefined,containerFileProxy 自动走本地分支);tunnelDial / getHostById /
          // capabilityProbe.tunnelFetchHealthz 三件套用 compute-pool 默认实现。
          const selfHostIdForProxy = deps.v3Supervisor!.selfHostId
          await containerFileProxy(
            req,
            res,
            ctx,
            {
              v3: deps.v3Supervisor!,
              bridgeSecret: deps.bridgeSecret!,
              selfHostId: selfHostIdForProxy,
              getHostById: computePoolGetHostById,
              tunnelDial: defaultTunnelDial,
              capabilityProbe: {
                selfHostId: selfHostIdForProxy,
                tunnelFetchHealthz: (hostId, cid, timeoutMs) =>
                  defaultTunnelFetchHealthz(hostId, cid, timeoutMs, {
                    getHostById: computePoolGetHostById,
                  }),
              },
            },
            BigInt(claims.sub),
          )
        } catch (err) {
          // containerFileProxy 内部已 catch,这里兜底
          handleError(err, res, requestId, proxyLog)
        }
        incrGatewayRequest('__file_proxy__', method, res.statusCode)
        const durationMs = Date.now() - startedAt
        proxyLog.info('http_request', { status: res.statusCode, durationMs })
        return true
      }
      // fall through 到 BLOCKED 分支 —— 不写 res,让 BLOCKED 接管
    }

    // ── P0 v3 多租户越权防火墙 ──
    // 见 BLOCKED_FOR_USER_RULES 注释。在 `isOurs` 前就做,保证 host-scope endpoint
    // 在 gateway 自己的 handler 执行前被拦。method-scoped 匹配 —— rule.methods 为空 =
    // 所有方法都拦;有值 = 只拦枚举方法。
    const blockedRule = matchBlockedRule(path, method)
    if (blockedRule) {
      setSecurityHeaders(res)
      const requestId = ensureRequestId(req)
      res.setHeader(REQUEST_ID_HEADER, requestId)
      const blockLog = (options.logger ?? rootLogger.child({ subsys: 'commercial' })).child({
        requestId,
        route: '__blocked_for_user__',
        rule: blockedRule.label,
        method,
        path,
        clientIp: clientIpOf(req),
      })
      const token = extractTokenFromReq(req)
      const claims = verifyCommercialJwtSync(token, deps.jwtSecret)
      if (claims) {
        if (claims.role === 'admin') {
          // admin: DB double-check(role/status 撤权立即生效),通过后 fall through
          try {
            const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
            blockLog.info('blocked_for_user_admin_bypass', {
              sub: claims.sub,
              adminId: admin.id,
            })
            // admin bypass 审计:写 admin_audit,方便事后查"谁在 host 敏感路由上动手"。
            // 失败不影响放行(best-effort);审计写失败仅记 warn,避免"DB 故障导致 admin
            // 运维路径被误杀"。
            writeAdminAudit(getPool(), {
              adminId: admin.id,
              action: 'blocked_route_bypass',
              target: `${method} ${blockedRule.label}`,
              before: null,
              after: { path },
              ip: clientIpOf(req),
              userAgent: userAgentOf(req),
            }).catch((err) => {
              blockLog.warn('admin_audit_write_failed', {
                err: err instanceof Error ? err.message : String(err),
              })
            })
            // 不 return true —— 让 gateway 自己的 handler 继续处理
            return false
          } catch (err) {
            // admin 身份 DB 失效 → 403(不是 401,token 本身有效,是身份被撤)
            handleError(err, res, requestId, blockLog)
            incrGatewayRequest('__blocked_for_user__', method, res.statusCode)
            return true
          }
        }
        // 普通付费用户:直接 403
        blockLog.warn('blocked_for_user', { sub: claims.sub })
        sendError(
          res,
          403,
          'FORBIDDEN',
          'this endpoint is not available in commercial mode',
          requestId,
        )
        incrGatewayRequest('__blocked_for_user__', method, res.statusCode)
        return true
      }
      // 无 commercial JWT:可能是 legacy 单 token / 无 token / 非法 token。
      // 不在这里拦 —— fall through 给 gateway 自己的 auth 层按正常 401/403 流程处理。
      return false
    }

    const isOurs = prefixes.some((p) => path === p || path.startsWith(p))
    if (!isOurs) return false

    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    // 1) 精确匹配 —— 同一 path 下可能有多个 method(例:PATCH + GET /api/admin/users/:id)
    const exactCandidates = routes.filter((r) => r.path !== undefined && r.path === path)
    // 2) 前缀匹配(仅在精确不中时尝试)。T-60 同 prefix 下 GET/PATCH/POST 并存,必须
    //    在 candidates 里挑 method 匹配项;否则拿到首个(可能是 POST)就抛 405。
    const prefixCandidates =
      exactCandidates.length === 0
        ? routes.filter((r) => r.pathPrefix !== undefined && path.startsWith(r.pathPrefix))
        : []
    const candidates = exactCandidates.length > 0 ? exactCandidates : prefixCandidates
    const route = candidates.find((r) => r.method === method)
    // route label —— 同时给 metrics 与 access log 使用
    const labelRoute =
      route?.path ??
      route?.pathPrefix ??
      candidates[0]?.path ??
      candidates[0]?.pathPrefix ??
      '__unmatched__'

    // V3 2I-1:在 dispatch 前派生 per-request logger,挂进 ctx;
    // 任何下游 handler / preCheck / proxy / finalize 都通过 ctx.log 派生子 logger,
    // requestId 自然贯穿,且基底 binding(route/method/clientIp)一次性写明
    //
    // V3 S12e CG9 — extract X-Trace-Id header (turn-level trace, contract D
    // smoke canary). master-canonical fallback: if the client sent garbage,
    // newTraceId() so reqLog ALWAYS has a traceId binding — that's what
    // verify_trace_propagation in smoke-v3.sh greps for. Plan §510 spec.
    const rawTrace = req.headers['x-trace-id']
    const traceCand = parseTraceIdCandidate(Array.isArray(rawTrace) ? rawTrace[0] : rawTrace)
    const traceId = traceCand.ok ? traceCand.traceId : newTraceId()
    const reqLog: Logger = httpLogger.child({
      requestId,
      route: labelRoute,
      method,
      clientIp: clientIpOf(req),
      traceId,
    })

    const ctx: RequestContext = {
      requestId,
      clientIp: clientIpOf(req),
      // 稳定出口 IP —— 不经任何反代 header 解析,给 auth bound_ip 用。
      // Caddy 反代时 = 127.0.0.1,直连 = 公网 IP。详见 RequestContext 的 JSDoc。
      authBoundIp: req.socket.remoteAddress ?? 'unknown',
      userAgent: userAgentOf(req),
      log: reqLog,
    }

    const startedAt = Date.now()
    try {
      if (candidates.length === 0) {
        throw new HttpError(404, 'NOT_FOUND', 'endpoint not found')
      }
      // B2 — 路由层 admin 鉴权边界(根因:此前每个 admin handler 自觉调 requireAdmin,
      // 新增路由漏调即静默裸奔)。凡 /api/admin/* 一律先过 requireAdminVerifyDb
      // (JWT + DB role/status 复核),让"未鉴权的 admin 路由"在结构上不可表达;
      // 顺带把只读 admin 路由也升级到 DB 复核(关闭降权后 JWT 未过期仍可读的窗口,B5)。
      // 放在 405 之前:对 /api/admin/* 的错误 method 也先要 admin 身份,不向非 admin
      // 泄露路由/method 存在性。例外:自带鉴权的机器路由用 method-aware 白名单跳过
      // (GET /api/admin/metrics 走 COMMERCIAL_METRICS_BEARER / JWT,见 http/admin/metrics.ts)。
      if (
        labelRoute.startsWith('/api/admin/') &&
        !ADMIN_SELF_AUTH_ROUTES.has(`${route?.method ?? method} ${labelRoute}`)
      ) {
        await requireAdminVerifyDb(req, deps.jwtSecret)
      }
      if (!route) {
        // method mismatch:返合并后的 Allow 头(该 path 下所有已定义 method)
        const allowed = [...new Set(candidates.map((r) => r.method))].join(', ')
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method ${method} not allowed`, {
          extraHeaders: { Allow: allowed },
        })
      }
      await route.handler(req, res, ctx, deps)
    } catch (err) {
      handleError(err, res, requestId, reqLog)
    }
    // T-62 metrics:route label 严格用 "声明的 path/pathPrefix"。
    //   - 405 (method mismatch):仍有 candidates → 取首个的声明 label,Prometheus
    //     能区分 "path X 的 405" vs "path Y 的 405"。
    //   - 404 (无 candidates):落到固定 `__unmatched__`,**不要**把原始 path 刷
    //     进 label —— `/api/admin/foo-<uuid>` 之类会让 label 基数爆掉。
    //   status 直接拿响应对象实际写出的码,对齐真实 401/403/402/5xx。
    incrGatewayRequest(labelRoute, method, res.statusCode)
    // V3 2I-1:access log 一行,含 status / 耗时。错误已经在 handleError 内
    // 用 error 级别详记过(含异常)。这条统一收尾。
    const durationMs = Date.now() - startedAt
    reqLog.info('http_request', { status: res.statusCode, durationMs })
    return true
  }
}

function handleError(err: unknown, res: ServerResponse, requestId: string, log: Logger): void {
  if (res.headersSent) {
    // 响应已发出,无能为力 — 关连接
    log.warn('http_response_after_headers_sent', { err: errorSummary(err) })
    res.destroy()
    return
  }
  if (err instanceof HttpError) {
    // 预期内的业务错(401/403/404/4xx 大多在这里):记 warn,不拉警报
    log.warn('http_error', { status: err.status, code: err.code, message: err.message })
    sendError(res, err.status, err.code, err.message, requestId, err.issues, err.extraHeaders)
    return
  }
  // 未捕获 → 500;记 error 级别,带 stack
  log.error('http_unhandled_error', { err: errorSummary(err) })
  sendError(res, 500, 'INTERNAL', 'internal server error', requestId)
}

function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { value: String(err) }
}
