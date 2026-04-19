/**
 * T-53 — Agent 订阅 DB 层。
 *
 * 纯 DB 模块,不依赖 dockerode、不依赖 http。由 http handler 调用,也由
 * lifecycle/provisioner 调用。测试可直接跑 pg。
 *
 * 提供:
 *   - openAgentSubscription:原子扣费 + INSERT agent_subscriptions + UPSERT agent_containers(status=provisioning)
 *   - getAgentStatus:读当前订阅 + 容器视图
 *   - cancelAgentSubscription:设 auto_renew=false
 *   - markContainerRunning / markContainerError:供 provisioner 写回状态
 *   - 几个 lifecycle 用到的 sweep 查询
 *
 * ### 关于幂等与并发
 * 开通走一个事务,顺序:
 *   1. `SELECT credits FROM users WHERE id=$1 FOR UPDATE`  —— 串行化同用户并发
 *   2. 预检活动订阅(partial UNIQUE idx_as_one_active_per_user 兜底)→ 409
 *   3. INSERT agent_subscriptions RETURNING id
 *   4. 手工扣费(inline,不走 billing/ledger.ts 的 debit,因为 debit 自己开 tx
 *      会脱离本 tx 边界,破坏原子性)
 *   5. UPSERT agent_containers(同用户 UNIQUE,老记录从 expired/removed 再次开通时需 ON CONFLICT)
 *
 * ### 关于容器 row 的 UPSERT 策略
 * agent_containers 有 `UNIQUE(user_id)` —— 每个用户一生一条。状态迁移:
 *   provisioning → running → stopped(订阅过期) → removed(volume GC) → provisioning(再订阅)
 * 因此"再次 open"要 DO UPDATE 重置字段。volume 名永远 `agent-u{uid}-*`,保持 stable。
 */

import type { PoolClient } from "pg";
import { tx, query } from "../db/queries.js";
import { volumeNamesFor } from "../agent-sandbox/volumes.js";

/** agent_subscriptions.status */
export type AgentSubscriptionStatus = "active" | "expired" | "canceled" | "suspended";

/** agent_containers.status */
export type AgentContainerStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "removed"
  | "error";

/** 01-SPEC F-5 MVP 唯一 plan */
export const AGENT_PLAN_BASIC = "basic" as const;
export type AgentPlan = typeof AGENT_PLAN_BASIC;

/** 默认价格(01-SPEC F-5):¥29 / 月 → 2900 分(1 积分 = 100 分)。 */
export const DEFAULT_AGENT_PLAN_PRICE_CREDITS = 2900n;
/** 默认订阅时长:30 天。 */
export const DEFAULT_AGENT_PLAN_DURATION_DAYS = 30;
/** 默认 volume GC 窗口:订阅到期后再保留 30 天,过了就删 volume(05-SEC §13)。 */
export const DEFAULT_AGENT_VOLUME_GC_DAYS = 30;

/** debit 失败:余额不足。复用 billing/ledger 的错误语义但本地 throw 轻便一些。 */
export class AgentInsufficientCreditsError extends Error {
  readonly code = "ERR_INSUFFICIENT_CREDITS" as const;
  readonly balance: bigint;
  readonly required: bigint;
  readonly shortfall: bigint;
  constructor(balance: bigint, required: bigint) {
    super(`insufficient credits: balance=${balance} required=${required}`);
    this.name = "AgentInsufficientCreditsError";
    this.balance = balance;
    this.required = required;
    this.shortfall = required - balance;
  }
}

/** 409:用户已有一个 active 订阅。 */
export class AgentAlreadyActiveError extends Error {
  readonly code = "ERR_AGENT_ALREADY_ACTIVE" as const;
  readonly subscription_id: bigint;
  readonly end_at: Date;
  constructor(subscriptionId: bigint, endAt: Date) {
    super(`user already has an active agent subscription (id=${subscriptionId})`);
    this.name = "AgentAlreadyActiveError";
    this.subscription_id = subscriptionId;
    this.end_at = endAt;
  }
}

/** 404:用户当前没有 active 订阅(/cancel 时用)。 */
export class AgentNotSubscribedError extends Error {
  readonly code = "ERR_AGENT_NOT_SUBSCRIBED" as const;
  constructor() {
    super("user has no active agent subscription");
    this.name = "AgentNotSubscribedError";
  }
}

function normUid(userId: bigint | number | string): string {
  if (typeof userId === "bigint") return userId.toString();
  if (typeof userId === "number") {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new TypeError(`user_id must be positive integer, got ${userId}`);
    }
    return String(userId);
  }
  if (!/^\d+$/.test(userId)) throw new TypeError(`user_id must be decimal digits, got ${userId}`);
  return userId;
}

function uidToInt(uidStr: string): number {
  // volumeNamesFor 只接受 number。postgres BIGSERIAL 理论上可以超过 Number.MAX_SAFE_INTEGER,
  // 但实际业务里 MVP 不可能有 2^53 个用户。越界直接抛 —— 比静默溢出好。
  const n = Number(uidStr);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`user_id out of safe integer range: ${uidStr}`);
  }
  return n;
}

export interface OpenAgentSubscriptionInput {
  userId: bigint | number | string;
  /** 开通价(单位:分 / credits 的最小刻度)。默认 2900(¥29)。 */
  priceCredits?: bigint;
  /** 订阅时长(天)。默认 30。 */
  durationDays?: number;
  /** 容器镜像 tag,如 `openclaude/agent-runtime:latest` */
  image: string;
  /** auto_renew 是否默认开(MVP false:手动续费模型) */
  autoRenew?: boolean;
}

export interface OpenAgentSubscriptionResult {
  subscription_id: bigint;
  container_id: bigint;
  start_at: Date;
  end_at: Date;
  /** 扣费后余额(分)。 */
  balance_after: bigint;
  /** 本次扣费 credit_ledger.id,便于审计 */
  ledger_id: bigint;
  /** agent_containers.docker_name(`agent-u{uid}`),caller 拿去查 docker inspect */
  docker_name: string;
  /** 两个 named volume 的名字,lifecycle 清理时要用 */
  workspace_volume: string;
  home_volume: string;
}

/**
 * 开通一个 agent 订阅(或在上次到期后续订)。
 *
 * 事务内:
 *   1. users FOR UPDATE(防止并发 debit)
 *   2. 预检无 active 订阅(409)
 *   3. INSERT agent_subscriptions RETURNING id, start_at, end_at
 *   4. UPDATE users.credits - priceCredits;余额不足抛
 *   5. INSERT credit_ledger (reason='agent_subscription', ref_type='agent_sub', ref_id=sub.id)
 *   6. UPSERT agent_containers:新建或在 expired/removed 基础上重置
 *
 * **不调用** docker(这是纯 DB 事务)。lifecycle/provisioner 拿到返回的 sub/container
 * 后,fire-and-forget 去 docker create + start。
 */
export async function openAgentSubscription(
  input: OpenAgentSubscriptionInput,
): Promise<OpenAgentSubscriptionResult> {
  const uidStr = normUid(input.userId);
  const uid = uidToInt(uidStr);
  const price = input.priceCredits ?? DEFAULT_AGENT_PLAN_PRICE_CREDITS;
  const duration = input.durationDays ?? DEFAULT_AGENT_PLAN_DURATION_DAYS;
  const autoRenew = input.autoRenew ?? false;
  if (price <= 0n) throw new TypeError(`priceCredits must be > 0, got ${price}`);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 365) {
    throw new TypeError(`durationDays must be in (0, 365], got ${duration}`);
  }
  if (typeof input.image !== "string" || input.image.trim().length === 0) {
    throw new TypeError("image is required (non-empty string)");
  }

  const volNames = volumeNamesFor(uid);

  return tx(async (client) => {
    // (1) 行锁:串行化同用户的并发 open(以及与 lifecycle 的竞态)
    const userRow = await client.query<{ credits: string; status: string }>(
      "SELECT credits::text AS credits, status FROM users WHERE id = $1 FOR UPDATE",
      [uidStr],
    );
    if (userRow.rows.length === 0) {
      throw new TypeError(`user not found: ${uidStr}`);
    }
    if (userRow.rows[0].status !== "active") {
      // 被封禁/删除的用户不允许开通 agent,走 401 由 caller 映射
      throw new AgentNotSubscribedError();
    }

    // (2) 预检 active 订阅。partial UNIQUE idx_as_one_active_per_user 仍会在 INSERT
    //     时兜底(23505),这里做显式查询是为了返回友好的 409 + end_at 让前端展示。
    const active = await client.query<{ id: string; end_at: Date }>(
      `SELECT id::text AS id, end_at
         FROM agent_subscriptions
        WHERE user_id = $1 AND status = 'active'
        LIMIT 1`,
      [uidStr],
    );
    if (active.rows.length > 0) {
      throw new AgentAlreadyActiveError(
        BigInt(active.rows[0].id),
        active.rows[0].end_at,
      );
    }

    // (3) INSERT 订阅。end_at = now + duration days(PG 层计算,避免客户端 tz 抖动)
    const subRow = await client.query<{
      id: string;
      start_at: Date;
      end_at: Date;
    }>(
      `INSERT INTO agent_subscriptions
          (user_id, plan, status, start_at, end_at, auto_renew)
       VALUES ($1, 'basic', 'active', NOW(), NOW() + ($2::int || ' days')::interval, $3)
       RETURNING id::text AS id, start_at, end_at`,
      [uidStr, duration, autoRenew],
    );
    const subId = BigInt(subRow.rows[0].id);

    // (4) 扣费:inline,保持在同一 tx 内。不复用 billing/ledger.ts 的 debit
    //     因为它自己 tx(),会脱离本事务边界 → 若后续 INSERT 失败无法回滚 debit。
    const balance = BigInt(userRow.rows[0].credits);
    if (balance < price) {
      throw new AgentInsufficientCreditsError(balance, price);
    }
    const newBalance = balance - price;
    await client.query(
      "UPDATE users SET credits = $1 WHERE id = $2",
      [newBalance.toString(), uidStr],
    );

    // (5) 流水
    const ledgerRow = await client.query<{ id: string }>(
      `INSERT INTO credit_ledger
          (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
       VALUES ($1, $2, $3, 'agent_subscription', 'agent_sub', $4, $5)
       RETURNING id::text AS id`,
      [
        uidStr,
        (-price).toString(),
        newBalance.toString(),
        subId.toString(),
        `agent subscription basic ×${duration}d`,
      ],
    );
    const ledgerId = BigInt(ledgerRow.rows[0].id);

    // (6) UPSERT 容器记录。user_id UNIQUE → ON CONFLICT DO UPDATE 重置字段,
    //     subscription_id 指到新订阅;volume 名复用旧值(若此用户上次 GC 已删 volume,
    //     下次 provision 会重新 ensureUserVolumes,docker 层幂等)
    const conRow = await client.query<{ id: string }>(
      `INSERT INTO agent_containers
          (user_id, subscription_id, docker_id, docker_name,
           workspace_volume, home_volume, image, status,
           last_started_at, last_stopped_at, volume_gc_at, last_error)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, 'provisioning',
               NULL, NULL, NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
           subscription_id = EXCLUDED.subscription_id,
           docker_id = NULL,
           docker_name = EXCLUDED.docker_name,
           workspace_volume = EXCLUDED.workspace_volume,
           home_volume = EXCLUDED.home_volume,
           image = EXCLUDED.image,
           status = 'provisioning',
           last_started_at = NULL,
           last_stopped_at = NULL,
           volume_gc_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       RETURNING id::text AS id`,
      [
        uidStr,
        subId.toString(),
        `agent-u${uid}`,
        volNames.workspace,
        volNames.home,
        input.image,
      ],
    );

    return {
      subscription_id: subId,
      container_id: BigInt(conRow.rows[0].id),
      start_at: subRow.rows[0].start_at,
      end_at: subRow.rows[0].end_at,
      balance_after: newBalance,
      ledger_id: ledgerId,
      docker_name: `agent-u${uid}`,
      workspace_volume: volNames.workspace,
      home_volume: volNames.home,
    };
  });
}

// ============================================================
// 读:状态
// ============================================================

export interface AgentStatusView {
  subscription: {
    id: string;
    plan: AgentPlan;
    status: AgentSubscriptionStatus;
    start_at: Date;
    end_at: Date;
    auto_renew: boolean;
    last_renewed_at: Date | null;
  } | null;
  container: {
    id: string;
    subscription_id: string;
    docker_id: string | null;
    docker_name: string;
    image: string;
    status: AgentContainerStatus;
    last_started_at: Date | null;
    last_stopped_at: Date | null;
    volume_gc_at: Date | null;
    last_error: string | null;
  } | null;
}

/**
 * 读用户当前(或最近一次)的 agent 状态。
 * - 订阅:返回 active 或最新的一条(展示给已过期用户)
 * - 容器:user_id 唯一,直接取
 */
export async function getAgentStatus(
  userId: bigint | number | string,
): Promise<AgentStatusView> {
  const uidStr = normUid(userId);

  // 订阅:优先 active,否则取最新一条(按 id DESC,BIGSERIAL 跟 commit 顺序一致)
  const subR = await query<{
    id: string; plan: string; status: string;
    start_at: Date; end_at: Date; auto_renew: boolean;
    last_renewed_at: Date | null;
  }>(
    `SELECT id::text AS id, plan, status, start_at, end_at, auto_renew, last_renewed_at
       FROM agent_subscriptions
      WHERE user_id = $1
      ORDER BY (status = 'active') DESC, id DESC
      LIMIT 1`,
    [uidStr],
  );

  const conR = await query<{
    id: string; subscription_id: string; docker_id: string | null;
    docker_name: string; image: string; status: string;
    last_started_at: Date | null; last_stopped_at: Date | null;
    volume_gc_at: Date | null; last_error: string | null;
  }>(
    `SELECT id::text AS id, subscription_id::text AS subscription_id,
            docker_id, docker_name, image, status,
            last_started_at, last_stopped_at, volume_gc_at, last_error
       FROM agent_containers
      WHERE user_id = $1
      LIMIT 1`,
    [uidStr],
  );

  return {
    subscription: subR.rows[0]
      ? {
          id: subR.rows[0].id,
          plan: subR.rows[0].plan as AgentPlan,
          status: subR.rows[0].status as AgentSubscriptionStatus,
          start_at: subR.rows[0].start_at,
          end_at: subR.rows[0].end_at,
          auto_renew: subR.rows[0].auto_renew,
          last_renewed_at: subR.rows[0].last_renewed_at,
        }
      : null,
    container: conR.rows[0]
      ? {
          id: conR.rows[0].id,
          subscription_id: conR.rows[0].subscription_id,
          docker_id: conR.rows[0].docker_id,
          docker_name: conR.rows[0].docker_name,
          image: conR.rows[0].image,
          status: conR.rows[0].status as AgentContainerStatus,
          last_started_at: conR.rows[0].last_started_at,
          last_stopped_at: conR.rows[0].last_stopped_at,
          volume_gc_at: conR.rows[0].volume_gc_at,
          last_error: conR.rows[0].last_error,
        }
      : null,
  };
}

// ============================================================
// 读:WS 连接 / RPC 访问前校验(T-54 Codex Finding F2)
// ============================================================

/**
 * 校验用户当前是否有资格连接自己的 agent 容器。
 *
 * 判定(全部满足 → ok=true):
 *   1. 用户有一条 status='active' 且 end_at > NOW() 的订阅
 *   2. 用户有一行 agent_containers,status ∈ {provisioning, running}
 *
 * 其余情况一律拒绝,避免:
 *   - 取消订阅但容器暂时还在 → 仍可连容器造成审计归属错乱
 *   - 容器处于 stopped/removed/error 状态 → 连上去也没用
 *
 * 失败返回 `{ok:false, code, message}`。code 用于 HTTP/WS 层映射(403/409)。
 */
export type AgentAccessDenyCode =
  | "NO_SUBSCRIPTION"
  | "SUBSCRIPTION_EXPIRED"
  | "NO_CONTAINER"
  | "CONTAINER_NOT_RUNNABLE";

export interface AgentAccessOk {
  ok: true;
  subscription_id: string;
  container_id: string;
  container_status: AgentContainerStatus;
  end_at: Date;
}
export interface AgentAccessDenied {
  ok: false;
  code: AgentAccessDenyCode;
  message: string;
}

export async function checkAgentAccess(
  userId: bigint | number | string,
): Promise<AgentAccessOk | AgentAccessDenied> {
  const uidStr = normUid(userId);
  const subR = await query<{ id: string; end_at: Date }>(
    `SELECT id::text AS id, end_at
       FROM agent_subscriptions
      WHERE user_id = $1 AND status = 'active'
      LIMIT 1`,
    [uidStr],
  );
  if (subR.rows.length === 0) {
    return { ok: false, code: "NO_SUBSCRIPTION", message: "user has no active agent subscription" };
  }
  if (subR.rows[0].end_at.getTime() <= Date.now()) {
    // 理论上 lifecycle 会 flip 到 expired;此处是兜底(比如刚过点但 sweep 还没跑)
    return { ok: false, code: "SUBSCRIPTION_EXPIRED", message: "subscription end_at is in the past" };
  }

  const conR = await query<{ id: string; status: string }>(
    "SELECT id::text AS id, status FROM agent_containers WHERE user_id = $1 LIMIT 1",
    [uidStr],
  );
  if (conR.rows.length === 0) {
    return { ok: false, code: "NO_CONTAINER", message: "no agent container row for user" };
  }
  const st = conR.rows[0].status as AgentContainerStatus;
  if (st !== "provisioning" && st !== "running") {
    return {
      ok: false,
      code: "CONTAINER_NOT_RUNNABLE",
      message: `container status is ${st}, not connectable`,
    };
  }
  return {
    ok: true,
    subscription_id: subR.rows[0].id,
    container_id: conR.rows[0].id,
    container_status: st,
    end_at: subR.rows[0].end_at,
  };
}

// ============================================================
// 写:取消(本期仍有效,auto_renew=false)
// ============================================================

export interface CancelAgentSubscriptionResult {
  subscription_id: bigint;
  end_at: Date;
  /** 操作前是否 auto_renew=true;若本就 false,依然 200(幂等) */
  was_auto_renew: boolean;
}

export async function cancelAgentSubscription(
  userId: bigint | number | string,
): Promise<CancelAgentSubscriptionResult> {
  const uidStr = normUid(userId);
  return tx(async (client) => {
    // 锁住 active 订阅防并发
    const r = await client.query<{ id: string; end_at: Date; auto_renew: boolean }>(
      `SELECT id::text AS id, end_at, auto_renew
         FROM agent_subscriptions
        WHERE user_id = $1 AND status = 'active'
        FOR UPDATE`,
      [uidStr],
    );
    if (r.rows.length === 0) {
      throw new AgentNotSubscribedError();
    }
    const subId = BigInt(r.rows[0].id);
    const was = r.rows[0].auto_renew;
    if (was) {
      await client.query(
        "UPDATE agent_subscriptions SET auto_renew = FALSE, updated_at = NOW() WHERE id = $1",
        [subId.toString()],
      );
    }
    return {
      subscription_id: subId,
      end_at: r.rows[0].end_at,
      was_auto_renew: was,
    };
  });
}

// ============================================================
// 供 provisioner / lifecycle 回写状态的小工具
// ============================================================

/** provisioner 成功启动后回写 docker_id + status=running + last_started_at */
export async function markContainerRunning(
  userId: bigint | number | string,
  dockerId: string,
): Promise<void> {
  const uidStr = normUid(userId);
  await query(
    `UPDATE agent_containers
        SET docker_id = $2,
            status = 'running',
            last_started_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE user_id = $1`,
    [uidStr, dockerId],
  );
}

/** provisioner 失败时回写 status=error + last_error */
export async function markContainerError(
  userId: bigint | number | string,
  errorMsg: string,
): Promise<void> {
  const uidStr = normUid(userId);
  // last_error 列无长度约束(TEXT),但我们截一刀免得 LLM 吐 1MB 错信息
  const trimmed = errorMsg.length > 2048 ? errorMsg.slice(0, 2048) + "…" : errorMsg;
  await query(
    `UPDATE agent_containers
        SET status = 'error',
            last_error = $2,
            updated_at = NOW()
      WHERE user_id = $1`,
    [uidStr, trimmed],
  );
}

// ============================================================
// lifecycle 用到的 sweep 查询
// ============================================================

export interface ExpiredSubscriptionRow {
  subscription_id: bigint;
  user_id: bigint;
  end_at: Date;
}

/**
 * 取一批 end_at < NOW() 且 status='active' 的订阅,置 expired 并返回列表。
 *
 * UPDATE ... RETURNING 在一个语句内拿走记录,避免 "先 SELECT 再 UPDATE" 的竞态
 * (两个 lifecycle tick 恰好同时扫到同一条)。
 *
 * 返回给 caller 的列表里,caller 再逐条对容器做 stop(docker 层)+ 置 volume_gc_at(DB 层)。
 */
export async function markExpiredSubscriptions(
  limit = 100,
): Promise<ExpiredSubscriptionRow[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError(`limit must be in (0, 10000], got ${limit}`);
  }
  const r = await query<{ id: string; user_id: string; end_at: Date }>(
    `UPDATE agent_subscriptions
        SET status = 'expired', updated_at = NOW()
      WHERE id IN (
        SELECT id FROM agent_subscriptions
         WHERE status = 'active' AND end_at < NOW()
         ORDER BY end_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id::text AS id, user_id::text AS user_id, end_at`,
    [limit],
  );
  return r.rows.map((row) => ({
    subscription_id: BigInt(row.id),
    user_id: BigInt(row.user_id),
    end_at: row.end_at,
  }));
}

/**
 * 订阅过期后,把对应容器记录置 stopped,并写 volume_gc_at = NOW() + gcDays 天。
 * 若容器记录不存在(理论不会,open 时一定 UPSERT 过),noop。
 */
export async function markContainerStoppedAfterExpiry(
  userId: bigint | number | string,
  gcDays: number,
): Promise<void> {
  if (!Number.isInteger(gcDays) || gcDays <= 0 || gcDays > 365) {
    throw new TypeError(`gcDays must be in (0, 365], got ${gcDays}`);
  }
  const uidStr = normUid(userId);
  await query(
    `UPDATE agent_containers
        SET status = 'stopped',
            last_stopped_at = NOW(),
            volume_gc_at = NOW() + ($2::int || ' days')::interval,
            updated_at = NOW()
      WHERE user_id = $1 AND status IN ('provisioning','running','error')`,
    [uidStr, gcDays],
  );
}

export interface GcCandidateRow {
  container_id: bigint;
  user_id: bigint;
  workspace_volume: string;
  home_volume: string;
  volume_gc_at: Date;
}

/**
 * 原子"认领"一批 volume_gc_at < NOW() 且 status='stopped' 的容器,准备 GC。
 *
 * 并发安全:走 `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`,
 * 与 markExpiredSubscriptions 同构。多个 lifecycle tick 并发跑时,每一行只会被一个
 * tick 认领,不会 double-GC。
 *
 * 认领方式:把 `volume_gc_at` 置为 NULL —— 等价于"已被某 tick 拿走处理"。
 *   - 若 tick 后续 docker removeContainer / removeUserVolumes / markContainerRemoved
 *     全部成功,则 status 变 removed,本行再也不会出现在候选中。
 *   - 若 docker 层失败,lifecycle 会 **自动重置** volume_gc_at 回 NOW+gcRetryHours,
 *     见 lifecycle.ts 的 restoreVolumeGcAfterFailure。
 *
 * 为什么不直接在查询里一步 `status='removed'`:volume 是在 docker 层删,若删不掉而
 * DB 标成 removed,实际 volume 会永久泄漏且 CLI 也看不到(查询只扫 stopped)。
 */
export async function listVolumeGcCandidates(
  limit = 100,
): Promise<GcCandidateRow[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError(`limit must be in (0, 10000], got ${limit}`);
  }
  const r = await query<{
    id: string; user_id: string;
    workspace_volume: string; home_volume: string;
    volume_gc_at: Date;
  }>(
    `UPDATE agent_containers
        SET volume_gc_at = NULL, updated_at = NOW()
      WHERE id IN (
        SELECT id FROM agent_containers
         WHERE status = 'stopped'
           AND volume_gc_at IS NOT NULL
           AND volume_gc_at < NOW()
         ORDER BY volume_gc_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
    RETURNING id::text       AS id,
              user_id::text  AS user_id,
              workspace_volume,
              home_volume,
              (updated_at - INTERVAL '0 second') AS volume_gc_at`,
    [limit],
  );
  return r.rows.map((row) => ({
    container_id: BigInt(row.id),
    user_id: BigInt(row.user_id),
    workspace_volume: row.workspace_volume,
    home_volume: row.home_volume,
    volume_gc_at: row.volume_gc_at,
  }));
}

/**
 * docker GC 失败时,把 volume_gc_at 恢复到一个将来的点,等下一轮再试。
 * 如果不做这件事,行就永远停在 `volume_gc_at IS NULL`(已认领)状态,被遗忘。
 */
export async function restoreVolumeGcAfterFailure(
  userId: bigint | number | string,
  retryAfterSeconds: number,
): Promise<void> {
  const uidStr = normUid(userId);
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds <= 0) {
    throw new TypeError(`retryAfterSeconds must be > 0, got ${retryAfterSeconds}`);
  }
  await query(
    `UPDATE agent_containers
        SET volume_gc_at = NOW() + ($2::int || ' seconds')::interval,
            updated_at = NOW()
      WHERE user_id = $1 AND status = 'stopped' AND volume_gc_at IS NULL`,
    [uidStr, retryAfterSeconds],
  );
}

/** GC 成功后把 status=removed 固化。 */
export async function markContainerRemoved(
  userId: bigint | number | string,
): Promise<void> {
  const uidStr = normUid(userId);
  await query(
    `UPDATE agent_containers
        SET status = 'removed', docker_id = NULL, updated_at = NOW()
      WHERE user_id = $1 AND status = 'stopped'`,
    [uidStr],
  );
}

/**
 * _客户端 tx 版本_:若调用方已有 tx,可以传入 client 共用。
 * 目前仅 openAgentSubscriptionWithClient 使用到;但对将来在一个更大事务里 open + provision
 * 是有用的 hook。为了减少暴露面,暂不 export。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _reserved(_client: PoolClient): Promise<void> { /* reserved */ }
