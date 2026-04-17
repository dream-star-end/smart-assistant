/**
 * T-53 — Agent 订阅 HTTP 路由。
 *
 * POST /api/agent/open
 * GET  /api/agent/status
 * POST /api/agent/cancel
 *
 * ### 思路
 * - `open` 在事务内 debit + INSERT sub/container(status=provisioning),响应立刻回,
 *   202 Accepted + subscription_id + end_at + docker_name。
 *   之后异步触发 `provisionContainer` 去真 docker create + start,结果写回 DB,
 *   前端通过 `GET /status` 轮询 status 变化(provisioning → running / error)。
 *   **为什么 202 而非 201**:HTTP 返回时容器还没跑起来,只是"订阅已生效,正在开机"。
 *   202 语义最贴切。客户端据此决定 polling 策略。
 *
 * - `status` 纯读,返回订阅 + 容器快照。即使用户已过期,也返回最后一次订阅/容器
 *   记录(前端 UX:显示"已到期,可续订"+ volume_gc_at 提醒"X 天后清除数据")。
 *
 * - `cancel` 仅置 auto_renew=false,本期不受影响。4xx 时前端用返回体里的 end_at 做
 *   "您本期仍可使用到 X"的提示。
 *
 * ### Agent deps 缺失时
 * gateway 启动期 agent 镜像 / seccomp / rpc dir 没配齐时,`AgentDeps` 为 undefined,
 * 三个端点都返 503 AGENT_NOT_READY。已有订阅的用户仍然能查 status,但没 docker 配
 * 下 status 端点退化回只读订阅/容器 DB,这已经足够(dashboards 不至于白屏)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Docker from "dockerode";
import { HttpError, sendJson } from "./util.js";
import { requireAuth } from "./auth.js";
import {
  openAgentSubscription,
  getAgentStatus,
  cancelAgentSubscription,
  AgentAlreadyActiveError,
  AgentInsufficientCreditsError,
  AgentNotSubscribedError,
  provisionContainer,
  type LifecycleLogger,
  type ProvisionContainerOptions,
} from "../agent/index.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";

/**
 * HTTP handler 需要的 agent 运行时依赖。gateway 装配时若所有 env 到位就填完整,
 * 否则传 undefined(handler 返 503)。
 */
export interface AgentHttpDeps {
  /** dockerode 实例(provisionContainer / lifecycle 共用) */
  docker: Docker;
  /** 容器镜像(AGENT_IMAGE) */
  image: string;
  /** agent 专用 bridge 网络名(AGENT_NETWORK,带白名单校验见 config.ts) */
  network: string;
  /** 透明代理 URL(AGENT_PROXY_URL) */
  proxyUrl: string;
  /** seccomp profile JSON 内容(非路径,启动时 readFile) */
  seccompProfileJson: string;
  /** RPC socket host 父目录(绝对路径,启动时自愈 mkdirSync) */
  rpcSocketHostDir: string;
  /** 资源限制覆盖(可选) */
  limits?: ProvisionContainerOptions["limits"];
  /** 额外 env 注入给容器(可选) */
  extraEnv?: ProvisionContainerOptions["extraEnv"];
  /** 订阅价(单位:分),未传 → 默认 2900 (¥29) */
  priceCredits?: bigint;
  /** 订阅时长(天),未传 → 默认 30 */
  durationDays?: number;
  /** 日志(测试/观测) */
  logger?: LifecycleLogger;
}

/**
 * 在 handler 内把 uid 从 authedUser.id 转 number。其余 agent 层自己处理 bigint/string。
 */
function uidFromUser(user: { id: string }): number {
  const n = Number(user.id);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(500, "INTERNAL", `user id out of safe integer range: ${user.id}`);
  }
  return n;
}

/**
 * `CommercialHttpDeps` 以 `agentRuntime?: AgentHttpDeps` 挂载 —— agent 路由从这里读。
 */
export type CommercialHttpDepsWithAgent = CommercialHttpDeps & {
  agentRuntime?: AgentHttpDeps;
};

// ─── POST /api/agent/open ───────────────────────────────────────────

export async function handleAgentOpen(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithAgent,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const agent = deps.agentRuntime;
  if (!agent) {
    throw new HttpError(503, "AGENT_NOT_READY", "agent runtime is not configured");
  }

  // 开通:事务内 debit + INSERT。429/422/409 错误在此处映射。
  let result;
  try {
    result = await openAgentSubscription({
      userId: user.id,
      priceCredits: agent.priceCredits,
      durationDays: agent.durationDays,
      image: agent.image,
      autoRenew: false,
    });
  } catch (err) {
    if (err instanceof AgentAlreadyActiveError) {
      throw new HttpError(409, err.code, err.message, {
        issues: [
          { path: "subscription_id", message: err.subscription_id.toString() },
          { path: "end_at", message: err.end_at.toISOString() },
        ],
      });
    }
    if (err instanceof AgentInsufficientCreditsError) {
      throw new HttpError(402, err.code, err.message, {
        issues: [{ path: "shortfall", message: err.shortfall.toString() }],
      });
    }
    if (err instanceof AgentNotSubscribedError) {
      // open 走到 NotSubscribed 说明 users.status!=='active'(被封/删)→ 401
      throw new HttpError(401, "UNAUTHORIZED", "user is not active");
    }
    throw err;
  }

  // 异步 docker provision —— 不 await,不 rethrow,错误落 agent_containers.last_error
  const uid = uidFromUser(user);
  void provisionContainer(agent.docker, uid, {
    proxyUrl: agent.proxyUrl,
    seccompProfileJson: agent.seccompProfileJson,
    rpcSocketHostDir: agent.rpcSocketHostDir,
    network: agent.network,
    image: agent.image,
    limits: agent.limits,
    extraEnv: agent.extraEnv,
    logger: agent.logger,
  });

  // 202:请求已受理,容器还在开机。
  sendJson(res, 202, {
    subscription_id: result.subscription_id.toString(),
    container_id: result.container_id.toString(),
    status: "provisioning",
    start_at: result.start_at.toISOString(),
    end_at: result.end_at.toISOString(),
    balance_after: result.balance_after.toString(),
    ledger_id: result.ledger_id.toString(),
    docker_name: result.docker_name,
    workspace_volume: result.workspace_volume,
    home_volume: result.home_volume,
  });
}

// ─── GET /api/agent/status ──────────────────────────────────────────

export async function handleAgentStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithAgent,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  // agent_runtime 未配置也允许查状态 —— 前端要能显示"未订阅"态。
  const view = await getAgentStatus(user.id);
  sendJson(res, 200, {
    subscription: view.subscription
      ? {
          id: view.subscription.id,
          plan: view.subscription.plan,
          status: view.subscription.status,
          start_at: view.subscription.start_at.toISOString(),
          end_at: view.subscription.end_at.toISOString(),
          auto_renew: view.subscription.auto_renew,
          last_renewed_at: view.subscription.last_renewed_at?.toISOString() ?? null,
        }
      : null,
    container: view.container
      ? {
          id: view.container.id,
          subscription_id: view.container.subscription_id,
          docker_id: view.container.docker_id,
          docker_name: view.container.docker_name,
          image: view.container.image,
          status: view.container.status,
          last_started_at: view.container.last_started_at?.toISOString() ?? null,
          last_stopped_at: view.container.last_stopped_at?.toISOString() ?? null,
          volume_gc_at: view.container.volume_gc_at?.toISOString() ?? null,
          last_error: view.container.last_error,
        }
      : null,
  });
}

// ─── POST /api/agent/cancel ─────────────────────────────────────────

export async function handleAgentCancel(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDepsWithAgent,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  try {
    const r = await cancelAgentSubscription(user.id);
    sendJson(res, 200, {
      subscription_id: r.subscription_id.toString(),
      end_at: r.end_at.toISOString(),
      auto_renew: false,
      was_auto_renew: r.was_auto_renew,
    });
  } catch (err) {
    if (err instanceof AgentNotSubscribedError) {
      throw new HttpError(404, err.code, err.message);
    }
    throw err;
  }
}
