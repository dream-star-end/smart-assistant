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

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  sendError,
  setSecurityHeaders,
  clientIpOf,
  userAgentOf,
} from "./util.js";
import {
  handleRegister,
  handleLogin,
  handleRefresh,
  handleLogout,
  handleVerifyEmail,
  handleResendVerification,
  handleCheckVerification,
  handleRequestPasswordReset,
  handleConfirmPasswordReset,
  handleMe,
  handleListPublicModels,
  handleGetPublicConfig,
  handleGetMyPreferences,
  handlePatchMyPreferences,
  handleGetMyUsage,
  handleCreateSession,
  handleClearSession,
  type CommercialHttpDeps,
  type RequestContext,
} from "./handlers.js";
import { containerFileProxy } from "./containerFileProxy.js";
import { requireUserVerifyDb } from "./requireUser.js";
import {
  handleListPlans,
  handleCreateHupi,
  handleHupiCallback,
  handleGetOrder,
} from "./payment.js";
import {
  handleAgentOpen,
  handleAgentStatus,
  handleAgentCancel,
} from "./agent.js";
import { handleAdminAgentAudit } from "./adminAudit.js";
import {
  handleAdminListUsers,
  handleAdminUsersStats,
  handleAdminGetUser,
  handleAdminPatchUser,
  handleAdminAdjustCredits,
  handleAdminListAudit,
  handleAdminListPricing,
  handleAdminPatchPricing,
  handleAdminListPlans,
  handleAdminPatchPlan,
  handleAdminListAccounts,
  handleAdminAccountsStats,
  handleAdminGetAccount,
  handleAdminCreateAccount,
  handleAdminPatchAccount,
  handleAdminDeleteAccount,
  handleAdminResetAccountCooldown,
  handleAdminOAuthStart,
  handleAdminOAuthExchange,
  handleAdminListAgentContainers,
  handleAdminAgentContainerAction,
  handleAdminListLedger,
  handleAdminMetrics,
  handleAdminListSettings,
  handleAdminGetSetting,
  handleAdminPutSetting,
} from "./admin.js";
import {
  handleAdminStatsDau,
  handleAdminStatsRevenueByDay,
  handleAdminStatsRequestSeries,
  handleAdminStatsAlertsSummary,
  handleAdminStatsAccountPool,
} from "./adminStats.js";
import {
  handleAdminAlertsListEvents,
  handleAdminAlertsListChannels,
  handleAdminAlertsIlinkQrcode,
  handleAdminAlertsIlinkPoll,
  handleAdminAlertsPatchChannel,
  handleAdminAlertsDeleteChannel,
  handleAdminAlertsTestChannel,
  handleAdminAlertsListOutbox,
  handleAdminAlertsListSilences,
  handleAdminAlertsCreateSilence,
  handleAdminAlertsDeleteSilence,
  handleAdminAlertsListRuleStates,
} from "./adminAlerts.js";
import { incrGatewayRequest } from "../admin/metrics.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { verifyCommercialJwtSync } from "../auth/jwtSync.js";
import { requireAdminVerifyDb } from "../admin/requireAdmin.js";
import { writeAdminAudit } from "../admin/audit.js";
import { getPool } from "../db/index.js";

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
  re: RegExp;
  /** 若 undefined = 所有方法都拦。否则只对枚举方法拦,其他方法放行(fall through)。 */
  methods?: ReadonlySet<string>;
  /** 审计 / 日志里的可读 endpoint label,不带动态段 */
  label: string;
}

const M = (...methods: string[]) => new Set(methods);

const BLOCKED_FOR_USER_RULES: readonly BlockedForUserRule[] = [
  // ─── host agent RCE 面 ───
  // /api/agents GET(列表 host agents)+ POST(创建 host agent);两者都不该给 user
  { re: /^\/api\/agents$/, label: "/api/agents" },
  // /api/agents/:id GET/PUT/DELETE —— 读 host agent 元信息、改 model/persona、删 agent
  { re: /^\/api\/agents\/[^/]+$/, label: "/api/agents/:id" },
  // /api/agents/:id/persona GET/PUT —— 读/写 host agent CLAUDE.md
  { re: /^\/api\/agents\/[^/]+\/persona$/, label: "/api/agents/:id/persona" },
  // /api/agents/:id/message POST + /api/agents/:id/delegate POST —— host agent 执行 prompt = RCE
  { re: /^\/api\/agents\/[^/]+\/(message|delegate)$/, label: "/api/agents/:id/(message|delegate)" },
  // 内存 / 技能(host singleton 存储)
  { re: /^\/api\/agents\/[^/]+\/memory\/(memory|user)$/, label: "/api/agents/:id/memory/*" },
  { re: /^\/api\/agents\/[^/]+\/skills(\/[A-Za-z0-9_\-]+)?$/, label: "/api/agents/:id/skills" },

  // ─── host cron / tasks / webhooks(所有方法,prompt 注入 = RCE)───
  { re: /^\/api\/cron(\/[^/]+)?$/, label: "/api/cron" },
  { re: /^\/api\/tasks(\/[A-Za-z0-9_\-]+)?$/, label: "/api/tasks" },
  { re: /^\/api\/tasks-executions$/, label: "/api/tasks-executions" },
  { re: /^\/api\/webhooks$/, label: "/api/webhooks" }, // GET 列表 leak secret
  { re: /^\/api\/webhooks\/[A-Za-z0-9_\-]+$/, label: "/api/webhooks/:id" }, // POST = host prompt 执行,DELETE = 删除 host webhook

  // ─── 全局 host 信息泄漏面 ───
  // /api/doctor 不限方法 —— gateway 里没显式校验 method,写成 "GET only" 会被 POST/HEAD 绕过。
  // 全方法拦,admin bypass 后由 gateway 自己决定要不要接(不接就 404,也安全)。
  { re: /^\/api\/doctor$/, label: "/api/doctor" },
  { re: /^\/api\/runs$/, methods: M("GET"), label: "/api/runs" },
  { re: /^\/api\/usage$/, methods: M("GET"), label: "/api/usage" },
  { re: /^\/api\/usage\/events$/, methods: M("GET"), label: "/api/usage/events" },
  { re: /^\/api\/config$/, label: "/api/config" }, // GET dumps gateway config + auth info
  // /metrics 吐 host 全局 Prometheus(含 accounts/sessions/agent_audit 统计),不分方法。
  { re: /^\/metrics$/, label: "/metrics" },

  // ─── 跨 user session FTS ───
  { re: /^\/api\/search$/, label: "/api/search" },

  // ─── session 迁移(跨租户认领别人历史 session)───
  // /api/sessions/unclaimed 列所有 default 桶未绑定 session,/api/sessions/claim 把任意
  // sessionId 迁给调用者 —— 付费用户借此拿到 legacy 个人版 / 其他用户遗留的聊天记录。
  // 正常用途只给 admin 运维(初次迁移 v2→v3 / default 桶清理)。
  { re: /^\/api\/sessions\/(unclaimed|claim)$/, label: "/api/sessions/(unclaimed|claim)" },

  // ─── HOST 文件访问(跨租户读 admin 主 agent cwd / HOST uploads / MCP generated)───
  // 详见大注释「/api/file + /api/media/* 为何也拦」段落。
  { re: /^\/api\/file$/, label: "/api/file" },
  { re: /^\/api\/media\/.+$/, label: "/api/media/:file" },

  // ─── HOST RCE 面(OpenAI 兼容层,POST body.prompt → sessions.submit → host main agent)───
  // 覆盖 /v1/chat/completions、/v1/models;后者仅列模型但合并策略拦更简。admin bypass。
  { re: /^\/v1\/.+$/, label: "/v1/*" },
];

function matchBlockedRule(path: string, method: string): BlockedForUserRule | null {
  for (const rule of BLOCKED_FOR_USER_RULES) {
    if (!rule.re.test(path)) continue;
    if (rule.methods && !rule.methods.has(method)) continue;
    return rule;
  }
  return null;
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
  re: RegExp;
  methods: ReadonlySet<string>;
  label: string;
}
const PROXY_FOR_USER_RULES: readonly ProxyForUserRule[] = [
  { re: /^\/api\/file$/, methods: M("GET"), label: "/api/file" },
  { re: /^\/api\/media\/.+$/, methods: M("GET"), label: "/api/media/:file" },
];

function matchProxyRule(path: string, method: string, enabled: boolean): ProxyForUserRule | null {
  if (!enabled) return null;
  for (const rule of PROXY_FOR_USER_RULES) {
    if (!rule.re.test(path)) continue;
    if (!rule.methods.has(method)) continue;
    return rule;
  }
  return null;
}

export type CommercialHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

/**
 * 从 req 抽 bearer token(header / cookie)—— 匹配 gateway/server.ts `extractToken`
 * 对 HTTP 请求的 fallback 顺序。WS `sec-websocket-protocol` 不在这里抽,BLOCKED 路径
 * 都是 HTTP REST,没有 WS upgrade。
 */
function extractTokenFromReq(req: IncomingMessage): string {
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  if (authHeader) return authHeader;
  const cookieHeader = req.headers.cookie ?? "";
  const cookies = cookieHeader.split(";").reduce(
    (acc, c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) acc[k] = v.join("=");
      return acc;
    },
    {} as Record<string, string>,
  );
  return cookies.oc_session || "";
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
) => Promise<void>;

interface Route {
  method: string;
  /**
   * 精确路径。动态参数路由(如 `/api/payment/orders/:order_no`)用 `pathPrefix` 字段,
   * 不在这里出现。
   */
  path?: string;
  /**
   * 前缀匹配:path 以 `pathPrefix` 开头的请求都会命中。Handler 自己从 url 中抽参数。
   * 用于少数带路径变量的 GET 接口。同一 method 多个 prefix 顺序即优先级。
   */
  pathPrefix?: string;
  handler: RouteHandler;
}

export function createCommercialHandler(
  deps: CommercialHttpDeps,
  options: {
    /** 测试可注入特定 logger;默认走 rootLogger.child({ subsys: "commercial" }) */
    logger?: Logger;
  } = {},
): CommercialHandler {
  const httpLogger = options.logger ?? rootLogger.child({ subsys: "commercial" });
  const routes: Route[] = [
    { method: "POST", path: "/api/auth/register", handler: handleRegister },
    { method: "POST", path: "/api/auth/login", handler: handleLogin },
    { method: "POST", path: "/api/auth/refresh", handler: handleRefresh },
    { method: "POST", path: "/api/auth/logout", handler: handleLogout },
    { method: "POST", path: "/api/auth/verify-email", handler: (req, res) => handleVerifyEmail(req, res) },
    { method: "POST", path: "/api/auth/resend-verification", handler: handleResendVerification },
    { method: "GET",  path: "/api/auth/check-verification",  handler: handleCheckVerification },
    { method: "POST", path: "/api/auth/request-password-reset", handler: handleRequestPasswordReset },
    { method: "POST", path: "/api/auth/confirm-password-reset", handler: (req, res) => handleConfirmPasswordReset(req, res) },
    // v3 file proxy: 用 Bearer access token 换一个 HttpOnly `oc_session` cookie,
    // 让 `<a href>` / `<img>` 等原生下载链接能携带身份(见 handlers.ts 详注)
    { method: "POST", path: "/api/auth/session", handler: handleCreateSession },
    { method: "POST", path: "/api/auth/session/logout", handler: handleClearSession },
    { method: "GET", path: "/api/me", handler: handleMe },
    // V3 Phase 2 Task 2G: 用户偏好(主题/默认模型/effort/通知/快捷键)
    { method: "GET",   path: "/api/me/preferences", handler: handleGetMyPreferences },
    { method: "PATCH", path: "/api/me/preferences", handler: handlePatchMyPreferences },
    // 使用消耗统计(含 summary / sessions 分页 / ledger 分页 / savings)
    { method: "GET",   path: "/api/me/usage",       handler: handleGetMyUsage },
    { method: "GET", path: "/api/public/config", handler: handleGetPublicConfig },
    { method: "GET", path: "/api/public/models", handler: handleListPublicModels },
    // V3 Phase 2 Task 2F: 容器/前端按 spec 用 /api/models;沿用 /api/public/models 同一 handler
    { method: "GET", path: "/api/models", handler: handleListPublicModels },
    { method: "GET", path: "/api/payment/plans", handler: handleListPlans },
    { method: "POST", path: "/api/payment/hupi/create", handler: handleCreateHupi },
    { method: "POST", path: "/api/payment/hupi/callback", handler: handleHupiCallback },
    { method: "GET", pathPrefix: "/api/payment/orders/", handler: handleGetOrder },
    // T-53 Agent 订阅
    { method: "POST", path: "/api/agent/open", handler: handleAgentOpen },
    { method: "GET", path: "/api/agent/status", handler: handleAgentStatus },
    { method: "POST", path: "/api/agent/cancel", handler: handleAgentCancel },
    // T-54 Agent 审计(超管)
    { method: "GET", path: "/api/admin/agent-audit", handler: handleAdminAgentAudit },
    // T-60 超管 API —— 用户管理
    { method: "GET",   path: "/api/admin/users",       handler: handleAdminListUsers },
    // R2:exact path 在 pathPrefix 之前优先匹配,避免被 /users/:id 吞掉。
    { method: "GET",   path: "/api/admin/users/stats", handler: handleAdminUsersStats },
    // 动态路径用 pathPrefix。/api/admin/users/:id/credits 优先匹配,
    // 后退到 /api/admin/users/:id(GET/PATCH)。Handler 自己区分。
    { method: "POST",  pathPrefix: "/api/admin/users/", handler: handleAdminAdjustCredits },
    { method: "GET",   pathPrefix: "/api/admin/users/", handler: handleAdminGetUser },
    { method: "PATCH", pathPrefix: "/api/admin/users/", handler: handleAdminPatchUser },
    // T-60 超管审计记录
    { method: "GET",   path: "/api/admin/audit",       handler: handleAdminListAudit },
    // T-60 超管定价
    { method: "GET",   path: "/api/admin/pricing",        handler: handleAdminListPricing },
    { method: "PATCH", pathPrefix: "/api/admin/pricing/", handler: handleAdminPatchPricing },
    // T-60 超管充值套餐
    { method: "GET",   path: "/api/admin/plans",          handler: handleAdminListPlans },
    { method: "PATCH", pathPrefix: "/api/admin/plans/",   handler: handleAdminPatchPlan },
    // T-60 超管账号池
    { method: "GET",    path: "/api/admin/accounts",         handler: handleAdminListAccounts },
    { method: "POST",   path: "/api/admin/accounts",         handler: handleAdminCreateAccount },
    // R3:exact path 在 pathPrefix 之前精确命中(matchRoute exact-first)
    { method: "GET",    path: "/api/admin/accounts/stats",   handler: handleAdminAccountsStats },
    // OAuth 引导:exact path 必须排在 prefix 之前(prefix 才能 fall through)
    { method: "POST",   path: "/api/admin/accounts/oauth/start",    handler: handleAdminOAuthStart },
    { method: "POST",   path: "/api/admin/accounts/oauth/exchange", handler: handleAdminOAuthExchange },
    // R3:reset-cooldown 子资源。pathPrefix 命中 /accounts/,handler 内部用 regex 抠
    //  `/accounts/:id/reset-cooldown`;POST 会先匹配到这条(method 一致),
    //  adjustCredits 走的是不同 prefix。
    { method: "POST",   pathPrefix: "/api/admin/accounts/",  handler: handleAdminResetAccountCooldown },
    { method: "GET",    pathPrefix: "/api/admin/accounts/",  handler: handleAdminGetAccount },
    { method: "PATCH",  pathPrefix: "/api/admin/accounts/",  handler: handleAdminPatchAccount },
    { method: "DELETE", pathPrefix: "/api/admin/accounts/",  handler: handleAdminDeleteAccount },
    // T-60 超管 Agent 容器
    { method: "GET",  path: "/api/admin/agent-containers",        handler: handleAdminListAgentContainers },
    { method: "POST", pathPrefix: "/api/admin/agent-containers/", handler: handleAdminAgentContainerAction },
    // T-60 超管积分流水
    { method: "GET", path: "/api/admin/ledger", handler: handleAdminListLedger },
    // T-62 Prometheus 指标
    { method: "GET", path: "/api/admin/metrics", handler: handleAdminMetrics },
    // T-60 R1 Dashboard 聚合(只读,requireAdmin JWT only)
    { method: "GET", path: "/api/admin/stats/dau",             handler: handleAdminStatsDau },
    { method: "GET", path: "/api/admin/stats/revenue-by-day",  handler: handleAdminStatsRevenueByDay },
    { method: "GET", path: "/api/admin/stats/request-series",  handler: handleAdminStatsRequestSeries },
    { method: "GET", path: "/api/admin/stats/alerts-summary",  handler: handleAdminStatsAlertsSummary },
    { method: "GET", path: "/api/admin/stats/account-pool",    handler: handleAdminStatsAccountPool },
    // V3 Phase 4H 超管运行时设置(allowlist + per-key zod)
    { method: "GET", path: "/api/admin/settings",         handler: handleAdminListSettings },
    { method: "GET", pathPrefix: "/api/admin/settings/",  handler: handleAdminGetSetting },
    { method: "PUT", pathPrefix: "/api/admin/settings/",  handler: handleAdminPutSetting },
    // T-63 超管告警(WeChat 推送)—— exact path 在前,prefix 在后
    { method: "GET",    path: "/api/admin/alerts/events",        handler: handleAdminAlertsListEvents },
    { method: "GET",    path: "/api/admin/alerts/channels",      handler: handleAdminAlertsListChannels },
    { method: "POST",   path: "/api/admin/alerts/ilink/qrcode",  handler: handleAdminAlertsIlinkQrcode },
    { method: "POST",   path: "/api/admin/alerts/ilink/poll",    handler: handleAdminAlertsIlinkPoll },
    { method: "GET",    path: "/api/admin/alerts/outbox",        handler: handleAdminAlertsListOutbox },
    { method: "GET",    path: "/api/admin/alerts/silences",      handler: handleAdminAlertsListSilences },
    { method: "POST",   path: "/api/admin/alerts/silences",      handler: handleAdminAlertsCreateSilence },
    { method: "GET",    path: "/api/admin/alerts/rule-states",   handler: handleAdminAlertsListRuleStates },
    // /api/admin/alerts/channels/:id   (PATCH / DELETE)
    // /api/admin/alerts/channels/:id/test (POST) —— handler 自己校验后缀
    { method: "PATCH",  pathPrefix: "/api/admin/alerts/channels/", handler: handleAdminAlertsPatchChannel },
    { method: "DELETE", pathPrefix: "/api/admin/alerts/channels/", handler: handleAdminAlertsDeleteChannel },
    { method: "POST",   pathPrefix: "/api/admin/alerts/channels/", handler: handleAdminAlertsTestChannel },
    // /api/admin/alerts/silences/:id   (DELETE)
    { method: "DELETE", pathPrefix: "/api/admin/alerts/silences/", handler: handleAdminAlertsDeleteSilence },
  ];
  // 所有命中的前缀,fallback 时通过它判断是否要兜底 405 / 404
  const prefixes = [
    "/api/auth/",
    "/api/me",
    "/api/public/",
    "/api/models", // V3 2F: alias of /api/public/models, GET only
    "/api/payment/",
    "/api/agent/",
    "/api/admin/",
  ];

  return async function commercialHandler(req, res): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

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
        : null;
    if (proxyRule) {
      setSecurityHeaders(res);
      const requestId = ensureRequestId(req);
      res.setHeader(REQUEST_ID_HEADER, requestId);
      const proxyLog = (options.logger ?? rootLogger.child({ subsys: "commercial" })).child({
        requestId,
        route: "__file_proxy__",
        rule: proxyRule.label,
        method,
        path,
        clientIp: clientIpOf(req),
      });
      const token = extractTokenFromReq(req);
      const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null;
      if (!claims) {
        // 无 / 过期 / 伪造 → fall through 给 BLOCKED(最终 401)
        // 不在这里 return true:让 BLOCKED 分支写响应
      } else if (claims.role === "admin") {
        // admin → 走 BLOCKED 的 admin bypass(保留运维查盘能力)
        // 同样 fall through
      } else {
        // commercial user:DB double-check status=active
        const verified = await requireUserVerifyDb(claims.sub, deps.v3Supervisor!.pool);
        if (!verified) {
          proxyLog.warn("file_proxy_user_inactive", { sub: claims.sub });
          sendError(res, 403, "FORBIDDEN", "user account not active", requestId);
          incrGatewayRequest("__file_proxy__", method, res.statusCode);
          return true;
        }
        proxyLog.info("file_proxy_dispatch", { sub: claims.sub });
        const ctx: RequestContext = {
          requestId,
          clientIp: clientIpOf(req),
          authBoundIp: req.socket.remoteAddress ?? "unknown",
          userAgent: userAgentOf(req),
          log: proxyLog,
        };
        const startedAt = Date.now();
        try {
          await containerFileProxy(
            req,
            res,
            ctx,
            {
              v3: deps.v3Supervisor!,
              bridgeSecret: deps.bridgeSecret!,
            },
            BigInt(claims.sub),
          );
        } catch (err) {
          // containerFileProxy 内部已 catch,这里兜底
          handleError(err, res, requestId, proxyLog);
        }
        incrGatewayRequest("__file_proxy__", method, res.statusCode);
        const durationMs = Date.now() - startedAt;
        proxyLog.info("http_request", { status: res.statusCode, durationMs });
        return true;
      }
      // fall through 到 BLOCKED 分支 —— 不写 res,让 BLOCKED 接管
    }

    // ── P0 v3 多租户越权防火墙 ──
    // 见 BLOCKED_FOR_USER_RULES 注释。在 `isOurs` 前就做,保证 host-scope endpoint
    // 在 gateway 自己的 handler 执行前被拦。method-scoped 匹配 —— rule.methods 为空 =
    // 所有方法都拦;有值 = 只拦枚举方法。
    const blockedRule = matchBlockedRule(path, method);
    if (blockedRule) {
      setSecurityHeaders(res);
      const requestId = ensureRequestId(req);
      res.setHeader(REQUEST_ID_HEADER, requestId);
      const blockLog = (options.logger ?? rootLogger.child({ subsys: "commercial" })).child({
        requestId,
        route: "__blocked_for_user__",
        rule: blockedRule.label,
        method,
        path,
        clientIp: clientIpOf(req),
      });
      const token = extractTokenFromReq(req);
      const claims = verifyCommercialJwtSync(token, deps.jwtSecret);
      if (claims) {
        if (claims.role === "admin") {
          // admin: DB double-check(role/status 撤权立即生效),通过后 fall through
          try {
            const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
            blockLog.info("blocked_for_user_admin_bypass", {
              sub: claims.sub,
              adminId: admin.id,
            });
            // admin bypass 审计:写 admin_audit,方便事后查"谁在 host 敏感路由上动手"。
            // 失败不影响放行(best-effort);审计写失败仅记 warn,避免"DB 故障导致 admin
            // 运维路径被误杀"。
            writeAdminAudit(getPool(), {
              adminId: admin.id,
              action: "blocked_route_bypass",
              target: `${method} ${blockedRule.label}`,
              before: null,
              after: { path },
              ip: clientIpOf(req),
              userAgent: userAgentOf(req),
            }).catch((err) => {
              blockLog.warn("admin_audit_write_failed", {
                err: err instanceof Error ? err.message : String(err),
              });
            });
            // 不 return true —— 让 gateway 自己的 handler 继续处理
            return false;
          } catch (err) {
            // admin 身份 DB 失效 → 403(不是 401,token 本身有效,是身份被撤)
            handleError(err, res, requestId, blockLog);
            incrGatewayRequest("__blocked_for_user__", method, res.statusCode);
            return true;
          }
        }
        // 普通付费用户:直接 403
        blockLog.warn("blocked_for_user", { sub: claims.sub });
        sendError(
          res,
          403,
          "FORBIDDEN",
          "this endpoint is not available in commercial mode",
          requestId,
        );
        incrGatewayRequest("__blocked_for_user__", method, res.statusCode);
        return true;
      }
      // 无 commercial JWT:可能是 legacy 单 token / 无 token / 非法 token。
      // 不在这里拦 —— fall through 给 gateway 自己的 auth 层按正常 401/403 流程处理。
      return false;
    }

    const isOurs = prefixes.some((p) => path === p || path.startsWith(p));
    if (!isOurs) return false;

    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    // 1) 精确匹配 —— 同一 path 下可能有多个 method(例:PATCH + GET /api/admin/users/:id)
    const exactCandidates = routes.filter((r) => r.path !== undefined && r.path === path);
    // 2) 前缀匹配(仅在精确不中时尝试)。T-60 同 prefix 下 GET/PATCH/POST 并存,必须
    //    在 candidates 里挑 method 匹配项;否则拿到首个(可能是 POST)就抛 405。
    const prefixCandidates = exactCandidates.length === 0
      ? routes.filter((r) => r.pathPrefix !== undefined && path.startsWith(r.pathPrefix))
      : [];
    const candidates = exactCandidates.length > 0 ? exactCandidates : prefixCandidates;
    const route = candidates.find((r) => r.method === method);
    // route label —— 同时给 metrics 与 access log 使用
    const labelRoute =
      route?.path ?? route?.pathPrefix ??
      candidates[0]?.path ?? candidates[0]?.pathPrefix ??
      "__unmatched__";

    // V3 2I-1:在 dispatch 前派生 per-request logger,挂进 ctx;
    // 任何下游 handler / preCheck / proxy / finalize 都通过 ctx.log 派生子 logger,
    // requestId 自然贯穿,且基底 binding(route/method/clientIp)一次性写明
    const reqLog: Logger = httpLogger.child({
      requestId,
      route: labelRoute,
      method,
      clientIp: clientIpOf(req),
    });

    const ctx: RequestContext = {
      requestId,
      clientIp: clientIpOf(req),
      // 稳定出口 IP —— 不经任何反代 header 解析,给 auth bound_ip 用。
      // Caddy 反代时 = 127.0.0.1,直连 = 公网 IP。详见 RequestContext 的 JSDoc。
      authBoundIp: req.socket.remoteAddress ?? "unknown",
      userAgent: userAgentOf(req),
      log: reqLog,
    };

    const startedAt = Date.now();
    try {
      if (candidates.length === 0) {
        throw new HttpError(404, "NOT_FOUND", "endpoint not found");
      }
      if (!route) {
        // method mismatch:返合并后的 Allow 头(该 path 下所有已定义 method)
        const allowed = [...new Set(candidates.map((r) => r.method))].join(", ");
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `method ${method} not allowed`, {
          extraHeaders: { Allow: allowed },
        });
      }
      await route.handler(req, res, ctx, deps);
    } catch (err) {
      handleError(err, res, requestId, reqLog);
    }
    // T-62 metrics:route label 严格用 "声明的 path/pathPrefix"。
    //   - 405 (method mismatch):仍有 candidates → 取首个的声明 label,Prometheus
    //     能区分 "path X 的 405" vs "path Y 的 405"。
    //   - 404 (无 candidates):落到固定 `__unmatched__`,**不要**把原始 path 刷
    //     进 label —— `/api/admin/foo-<uuid>` 之类会让 label 基数爆掉。
    //   status 直接拿响应对象实际写出的码,对齐真实 401/403/402/5xx。
    incrGatewayRequest(labelRoute, method, res.statusCode);
    // V3 2I-1:access log 一行,含 status / 耗时。错误已经在 handleError 内
    // 用 error 级别详记过(含异常)。这条统一收尾。
    const durationMs = Date.now() - startedAt;
    reqLog.info("http_request", { status: res.statusCode, durationMs });
    return true;
  };
}

function handleError(
  err: unknown,
  res: ServerResponse,
  requestId: string,
  log: Logger,
): void {
  if (res.headersSent) {
    // 响应已发出,无能为力 — 关连接
    log.warn("http_response_after_headers_sent", { err: errorSummary(err) });
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    // 预期内的业务错(401/403/404/4xx 大多在这里):记 warn,不拉警报
    log.warn("http_error", { status: err.status, code: err.code, message: err.message });
    sendError(res, err.status, err.code, err.message, requestId, err.issues, err.extraHeaders);
    return;
  }
  // 未捕获 → 500;记 error 级别,带 stack
  log.error("http_unhandled_error", { err: errorSummary(err) });
  sendError(res, 500, "INTERNAL", "internal server error", requestId);
}

function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
