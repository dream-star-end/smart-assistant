/**
 * v5 自愈体系切片② 块A — 崩溃安全派单(全局 singleflight)+ 隧道 POST + 取消通知。
 *
 * 职责(网络/派单层;状态机时序看护在 sweeper.ts):
 *   - dispatchRepair(incidentId):事务内 INSERT codex_repairs(pending)(受 0133
 *     ux_repair_singleflight 全局唯一索引保护,重叠 tick 第二个 INSERT 23505 丢弃)→ 提交 →
 *     经隧道 POST 个人版 receiver → 202 才 CAS pending→dispatched(RFC §2 崩溃安全派单)。
 *   - redispatchPending:POST 后置位前崩溃留下的 pending 行,重启后重发(个人版按 repairId
 *     幂等去重,重发是正确且唯一正解)。
 *   - postCancel:timeout/cancel 时经隧道通知个人版终止 codex 会话(个人版 cancel 端点由块B 实现,
 *     本模块只按契约 POST + 解释其确认)。
 *
 * 保险丝(消误动/防轰炸):
 *   - 同 incident 累计 ≥2 次失败(failed/timeout/verification_failed)→ 停派 + ops 升级告警。
 *   - 同 event_type(policy.match_key,回落 condition_key)30min 冷却 → 不重复派单。
 *   - 派单总闸 OC_SELFHEAL_DISPATCH_DISABLED 默认视为禁用(调用方 sweeper 已 gate;本模块再以
 *     "URL/HMAC 缺失即跳过"兜底,env 缺省安全)。
 *
 * 防注入:webhook body **只含 id**(`{repairId, incidentId, attempt}`),绝不塞自由文本
 * ops_detail;codex 要上下文自己经 capability 拉结构化脱敏 context(见 repairContext.ts)。
 * 隧道内叠加防重放签名:X-Selfheal-Ts/Nonce/Sig(HMAC over ts.nonce.repairId.bodySha256)。
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query as _query, tx as _tx } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { safeEnqueueAlert as _safeEnqueueAlert, type AlertEventInput } from "../admin/alertOutbox.js";

/**
 * ops 升级告警 event_type。**债**:这两个键尚未登记 alertEvents.ts EVENT_META(块A 文件所有权
 * 不含该文件);集成者应登记到 'ops' 组以进事件目录/静默 UI。当前即便未登记也能送达:
 * 空过滤通道订阅全部事件 + enqueueAlert 零订阅时 inbox 兜底,boss 必有落点(见 alertOutbox)。
 */
export const OPS_REPAIR_FAILED = "ops.repair_failed";
export const OPS_REPAIR_TIMEOUT = "ops.repair_timeout";

/** 保险丝阈值。 */
const FAILED_ATTEMPT_FUSE = 2;
function cooldownMs(): number {
  const raw = Number(process.env.OC_SELFHEAL_REPAIR_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
}

/** singleflight 活跃态(与 0133 ux_repair_singleflight WHERE 子句严格一致)。 */
export const ACTIVE_REPAIR_STATUSES = [
  "pending",
  "dispatched",
  "acked",
  "running",
  "verifying",
  "cancel_requested",
  "cancelling",
] as const;

/** 计入"失败保险丝"的终态(区别于 cancelled / verification_inconclusive 这类非失败终态)。 */
const FAILED_TERMINAL_STATUSES = ["failed", "timeout", "verification_failed"] as const;

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface DispatcherDeps {
  query?: typeof _query;
  tx?: typeof _tx;
  fetch?: FetchLike;
  now?: () => number;
  logger?: Logger;
  enqueueAlert?: (event: AlertEventInput) => void;
}

export type DispatchOutcome =
  | { status: "dispatched"; repairId: string; attempt: number }
  | { status: "pending_post_failed"; repairId: string; attempt: number }
  | { status: "skipped"; reason: string };

export interface CancelDelivery {
  /** 网络/签发是否成功(2xx)。false = 失败(fail-closed,不释放槽)。 */
  ok: boolean;
  /** 个人版确认 codex 会话已终止 → 可释放 singleflight 槽(置 cancelled)。 */
  terminated: boolean;
  /** 个人版已受理 cancel 但尚未确认终止(→ cancelling,下轮再问)。 */
  accepted: boolean;
  httpStatus?: number;
}

// ─── env / 签名 helpers ────────────────────────────────────────────────

function dispatchBaseUrl(): string | null {
  const u = process.env.OC_SELFHEAL_DISPATCH_URL;
  return u && u.length > 0 ? u.replace(/\/+$/, "") : null;
}
function webhookSecret(): string | null {
  const s = process.env.OC_SELFHEAL_WEBHOOK_HMAC;
  return s && s.length > 0 ? s : null;
}
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
/** X-Selfheal-Sig = hex(HMAC-SHA256(secret, `${ts}.${nonce}.${repairId}.${bodySha256}`))。 */
function signWebhook(secret: string, ts: string, nonce: string, repairId: string, bodySha: string): string {
  return createHmac("sha256", secret).update(`${ts}.${nonce}.${repairId}.${bodySha}`).digest("hex");
}

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; text: () => Promise<string> }> {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, text: () => res.text() };
}

// ─── 派单 POST(webhook body 只含 id)──────────────────────────────────

interface PostResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

async function postSigned(
  path: string,
  bodyObj: Record<string, unknown>,
  repairId: string,
  okStatus: (s: number) => boolean,
  deps: Required<Pick<DispatcherDeps, "fetch" | "now" | "logger">>,
): Promise<{ res: PostResult; rawText: string | null }> {
  const base = dispatchBaseUrl();
  const secret = webhookSecret();
  if (!base || !secret) {
    return { res: { ok: false, error: "dispatch url/secret not configured" }, rawText: null };
  }
  const body = JSON.stringify(bodyObj);
  const ts = String(deps.now());
  const nonce = randomBytes(16).toString("hex");
  const sig = signWebhook(secret, ts, nonce, repairId, sha256Hex(body));
  try {
    const res = await deps.fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Selfheal-Ts": ts,
        "X-Selfheal-Nonce": nonce,
        "X-Selfheal-Sig": sig,
      },
      body,
    });
    let rawText: string | null = null;
    try {
      rawText = await res.text();
    } catch {
      /* body 读失败不致命 */
    }
    return { res: { ok: okStatus(res.status), httpStatus: res.status }, rawText };
  } catch (err) {
    return {
      res: { ok: false, error: (err as Error)?.message ?? String(err) },
      rawText: null,
    };
  }
}

// ─── dispatchRepair ────────────────────────────────────────────────────

interface IncidentPolicyRow {
  id: string;
  condition_key: string;
  status: string;
  event_type: string;
}

function resolveDeps(deps: DispatcherDeps) {
  return {
    query: deps.query ?? _query,
    tx: deps.tx ?? _tx,
    fetch: deps.fetch ?? defaultFetch,
    now: deps.now ?? (() => Date.now()),
    logger: deps.logger ?? rootLogger.child({ subsys: "selfheal", module: "dispatcher" }),
    enqueueAlert: deps.enqueueAlert ?? _safeEnqueueAlert,
  };
}

/**
 * 崩溃安全派单单个 incident 的修复。返回 outcome(dispatched / pending_post_failed / skipped)。
 * 幂等且并发安全:singleflight 唯一索引 + 保险丝 + 冷却在 DB/读侧兜住重叠。
 */
export async function dispatchRepair(
  incidentId: string,
  deps: DispatcherDeps = {},
): Promise<DispatchOutcome> {
  const d = resolveDeps(deps);
  if (!/^[1-9][0-9]{0,19}$/.test(incidentId)) return { status: "skipped", reason: "bad_incident_id" };
  if (!dispatchBaseUrl() || !webhookSecret()) {
    d.logger.warn("selfheal_dispatch_not_configured");
    return { status: "skipped", reason: "not_configured" };
  }

  // 1) 读 incident + policy(event_type)。
  const incR = await d.query<IncidentPolicyRow>(
    `SELECT i.id::text AS id, i.condition_key AS condition_key, i.status AS status,
            COALESCE(p.match_key, i.condition_key) AS event_type
       FROM incidents i
       LEFT JOIN incident_policies p ON p.id = i.policy_id
      WHERE i.id = $1::bigint`,
    [incidentId],
  );
  const inc = incR.rows[0];
  if (!inc) return { status: "skipped", reason: "incident_not_found" };
  if (inc.status === "resolved") return { status: "skipped", reason: "incident_resolved" };
  const eventType = inc.event_type;

  // 2) 保险丝:同 incident 累计失败 ≥2 → 停派 + 升级告警。
  const failedR = await d.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM codex_repairs
      WHERE incident_id = $1::bigint AND status = ANY($2::text[])`,
    [incidentId, FAILED_TERMINAL_STATUSES as unknown as string[]],
  );
  const failedCount = Number(failedR.rows[0]?.n ?? 0);
  if (failedCount >= FAILED_ATTEMPT_FUSE) {
    d.logger.warn("selfheal_dispatch_fuse_blown", { incidentId, eventType, failedCount });
    d.enqueueAlert({
      event_type: OPS_REPAIR_FAILED,
      severity: "critical",
      title: `自愈修复连续失败,已停派待人工:${eventType}`,
      body:
        `incident=\`${incidentId}\` event=\`${eventType}\` 已累计 ${failedCount} 次修复失败,` +
        `自愈派单保险丝已熔断,不再自动重试。请人工介入排查。`,
      payload: { incident_id: incidentId, event_type: eventType, failed_count: failedCount },
      dedupe_key: `${OPS_REPAIR_FAILED}:${incidentId}`,
    });
    return { status: "skipped", reason: "fuse_failed" };
  }

  // 3) 冷却:同 event_type 30min 内已有派单记录 → 跳过(防轰炸)。
  const cd = cooldownMs();
  if (cd > 0) {
    const since = new Date(d.now() - cd);
    const coolR = await d.query<{ one: number }>(
      `SELECT 1 AS one FROM codex_repairs r
         JOIN incidents i2 ON i2.id = r.incident_id
         LEFT JOIN incident_policies p2 ON p2.id = i2.policy_id
        WHERE COALESCE(p2.match_key, i2.condition_key) = $1 AND r.created_at > $2
        LIMIT 1`,
      [eventType, since],
    );
    if (coolR.rows.length > 0) return { status: "skipped", reason: "cooldown" };
  }

  // 4) singleflight INSERT(pending)。attempt = incident 现有最大 attempt+1。
  //    受 ux_repair_singleflight(全表活跃至多一行)+ UNIQUE(incident_id,attempt) 保护:
  //    任何重叠 → 23505 → 丢弃(视为已有活跃修复在进行)。
  let created: { id: string; attempt: number };
  try {
    created = await d.tx(async (client: PoolClient) => {
      const ins = await client.query<{ id: string; attempt: number }>(
        `INSERT INTO codex_repairs (incident_id, status, attempt, tier, created_at, updated_at)
         SELECT $1::bigint, 'pending', COALESCE(MAX(attempt),0)+1, 'tier2', NOW(), NOW()
           FROM codex_repairs WHERE incident_id = $1::bigint
         RETURNING id::text AS id, attempt`,
        [incidentId],
      );
      return { id: ins.rows[0].id, attempt: Number(ins.rows[0].attempt) };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return { status: "skipped", reason: "singleflight_conflict" };
    }
    throw err;
  }

  // 5) 隧道 POST(body 只含 id)。202 → CAS pending→dispatched;失败留 pending 待 redispatch。
  const { res: postRes } = await postSigned(
    "/api/webhooks/v5-selfheal",
    { repairId: created.id, incidentId, attempt: created.attempt },
    created.id,
    (s) => s === 202,
    { fetch: d.fetch, now: d.now, logger: d.logger },
  );

  if (!postRes.ok) {
    d.logger.warn("selfheal_dispatch_post_failed", {
      repairId: created.id,
      incidentId,
      httpStatus: postRes.httpStatus,
      error: postRes.error,
    });
    return { status: "pending_post_failed", repairId: created.id, attempt: created.attempt };
  }

  await markDispatched(created.id, incidentId, d);
  return { status: "dispatched", repairId: created.id, attempt: created.attempt };
}

/** POST 成功后:CAS pending→dispatched + 记 event + incident open→repairing(仅信号,不影响 WS)。 */
async function markDispatched(
  repairId: string,
  incidentId: string,
  d: ReturnType<typeof resolveDeps>,
): Promise<void> {
  await d.tx(async (client: PoolClient) => {
    const cas = await client.query(
      `UPDATE codex_repairs
          SET status = 'dispatched', dispatched_at = NOW(), updated_at = NOW()
        WHERE id = $1::bigint AND status = 'pending'`,
      [repairId],
    );
    if ((cas.rowCount ?? 0) === 0) return; // 已被推进(如快速 ack),不覆盖
    await client.query(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'dispatched', $2, '{}'::jsonb)`,
      [repairId, "已派单至个人版 codex(隧道 POST 202)"],
    );
    await client.query(
      `UPDATE incidents SET status = 'repairing', updated_at = NOW()
        WHERE id = $1::bigint AND status = 'open'`,
      [incidentId],
    );
  });
}

/**
 * 重发 POST 后置位前崩溃留下的 pending 修复(dispatched_at IS NULL)。个人版按 repairId 幂等,
 * 重发是正确且唯一正解。每轮至多处理一条(singleflight 保证活跃至多一行)。
 */
export async function redispatchPending(deps: DispatcherDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  if (!dispatchBaseUrl() || !webhookSecret()) return 0;
  const pend = await d.query<{ id: string; incident_id: string; attempt: number }>(
    `SELECT id::text AS id, incident_id::text AS incident_id, attempt
       FROM codex_repairs
      WHERE status = 'pending' AND dispatched_at IS NULL
      ORDER BY id ASC LIMIT 5`,
  );
  let n = 0;
  for (const row of pend.rows) {
    const { res } = await postSigned(
      "/api/webhooks/v5-selfheal",
      { repairId: row.id, incidentId: row.incident_id, attempt: Number(row.attempt) },
      row.id,
      (s) => s === 202,
      { fetch: d.fetch, now: d.now, logger: d.logger },
    );
    if (res.ok) {
      await markDispatched(row.id, row.incident_id, d);
      n++;
    }
  }
  return n;
}

// ─── 取消通知(隧道 → 个人版 cancel 端点)────────────────────────────────

/**
 * 经隧道 POST 个人版 cancel 端点(块B 实现),请求终止某 repair 的 codex 会话。
 * 契约:`POST ${OC_SELFHEAL_DISPATCH_URL}/api/webhooks/v5-selfheal-cancel`,同 webhook HMAC 头,
 *   body `{ repairId, incidentId, reason }`;返回 200 `{ terminated: boolean, accepted?: boolean }`。
 * 语义:terminated=true → 已确认终止(sweeper 据此释放 singleflight 槽置 cancelled);
 *   accepted=true/terminated=false → 已受理未确认(→ cancelling,下轮再问);
 *   非 2xx / 网络失败 → ok=false(**fail-closed:不释放槽**,旧 root 进程可能仍跑)。
 */
export async function postCancel(
  input: { repairId: string; incidentId: string; reason: string },
  deps: DispatcherDeps = {},
): Promise<CancelDelivery> {
  const d = resolveDeps(deps);
  const { res, rawText } = await postSigned(
    "/api/webhooks/v5-selfheal-cancel",
    { repairId: input.repairId, incidentId: input.incidentId, reason: input.reason.slice(0, 500) },
    input.repairId,
    (s) => s >= 200 && s < 300,
    { fetch: d.fetch, now: d.now, logger: d.logger },
  );
  if (!res.ok) {
    return { ok: false, terminated: false, accepted: false, httpStatus: res.httpStatus };
  }
  let terminated = false;
  let accepted = true;
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText) as { terminated?: unknown; accepted?: unknown };
      terminated = parsed.terminated === true;
      if (typeof parsed.accepted === "boolean") accepted = parsed.accepted;
    } catch {
      /* 无 JSON body:视为已受理未确认 */
    }
  }
  return { ok: true, terminated, accepted, httpStatus: res.httpStatus };
}
