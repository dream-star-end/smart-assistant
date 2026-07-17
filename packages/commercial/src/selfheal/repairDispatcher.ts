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
 *
 * ── 跨仓契约(个人版 receiver/jobWorker 同步实现,不许漂移;收尾批 M3)────
 * 隧道内防重放签名头:X-Selfheal-Ts / X-Selfheal-Nonce / X-Selfheal-Sig,
 *   sig = hex(HMAC-SHA256(OC_SELFHEAL_WEBHOOK_HMAC,
 *           `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`))
 *   (METHOD 大写;path = URL pathname,无 query —— 签名绑路由,防跨端点重放)。
 * 端点路径:/api/webhooks/v5-selfheal(派单)/ -cancel(取消)/ -release(放行交付)。
 * cancel 响应(跨仓契约,个人版逐字同步 —— 批1b F2,R2-1 修订):
 *   200 `{terminated:boolean, accepted?:boolean,
 *         releaseCancel?:'cancelled'|'idempotent'|'not_found'|'too_late', releaseRequestId?:string}`
 *        —— 正常路径一律 200:repair 级(terminated/accepted)与 release 级(releaseCancel)两组裁决同体返回;
 *           **too_late(release job 已 pre-claim 部署)也走 200,不再是 409**。
 *   409 `{ok:false, releaseCancel:'repair_mismatch'}`(唯一 409:rrid 不属于该 repair 的契约校验失败)。
 *   `releaseCancel` 仅在 postCancel 携带 releaseRequestId(兼取消 release job)时有意义:
 *   cancelled/not_found/idempotent = 个人版不会再部署该 release(v5 sweeper 收口活跃行置 cancelled);
 *   too_late = 已在部署,v5 不动 release 行,交 deployed/deploy_failed receipt 裁决(repair 在 cancel
 *   途中被 deployed receipt 收口到 verifying,见 selfhealRepairs.ts R2-1②);repair_mismatch = 契约校验失败,不收口。
 * release 交付响应(批1b durable async intake,只认状态码,见 postReleaseDelivery):
 *   202 accepted / 409 authority_mismatch|conflict / 423 fuse_engaged / 其余=retry。
 *   真实部署裁决不同步返回,由个人版 release worker 异步 callback(§4)回传。
 * SSRF 钉死(M5):派单 URL 由 selfheal/config.assertSelfhealConfig 限定 loopback;
 * fetch 全部 redirect:'manual',3xx 一律按失败(okStatus 只认 2xx),重定向逃逸封死。
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query as _query, tx as _tx } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { safeEnqueueAlert as _safeEnqueueAlert, type AlertEventInput } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";
import { repairCooldownMs } from "./config.js";
import { SELFHEAL_DRILL_TRANSPORT, SELFHEAL_DRILL_RELEASE } from "./conditionKeys.js";

/**
 * 冷却豁免精确常量集(与个人版 broker drill 白名单同纪律):只认精确 conditionKey,
 * 绝不放宽到 `selfheal.drill:` 前缀。新增 drill 类型必须来这里显式扩表。
 * 演练要求连续可重跑(验收=连跑全过),其 incident/repair 生命周期由演练脚本持
 * advisory lock 串行编排,无轰炸面。
 */
const COOLDOWN_EXEMPT_CONDITIONS: ReadonlySet<string> = new Set([
  SELFHEAL_DRILL_TRANSPORT,
  SELFHEAL_DRILL_RELEASE,
]);

/**
 * ops 升级告警 event_type —— 单一真理源在 alertEvents.ts EVENTS(已登记 EVENT_META 'ops' 组,
 * 进事件目录/通道订阅/静默 UI)。此处仅按既有 import 站点(sweeper 等)习惯做同名 re-export,
 * 是引用别名而非第二份字面量。
 */
export const OPS_REPAIR_FAILED = EVENTS.OPS_REPAIR_FAILED;
export const OPS_REPAIR_TIMEOUT = EVENTS.OPS_REPAIR_TIMEOUT;

/** 保险丝阈值。 */
const FAILED_ATTEMPT_FUSE = 2;

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

/**
 * release job cancel 裁决(个人版跨仓契约 F2,R2-1 修订)。仅 postCancel 带 rrid 时非空。
 *   cancelled/idempotent/not_found → 200,sweeper CAS 活跃 release 行置 cancelled;
 *   too_late              → 200,release 已 pre-claim 部署,不动 release 行,交 receipt 裁决;
 *   repair_mismatch       → 409,rrid 不属于该 repair 的契约校验失败,不收口(仅告警)。
 */
export type ReleaseCancelVerdict = "cancelled" | "idempotent" | "not_found" | "too_late" | "repair_mismatch";

export interface CancelDelivery {
  /** 网络/签发是否成功(2xx)。false = 失败(fail-closed,不释放槽)。 */
  ok: boolean;
  /** 个人版确认 codex 会话已终止 → 可释放 singleflight 槽(置 cancelled)。 */
  terminated: boolean;
  /** 个人版已受理 cancel 但尚未确认终止(→ cancelling,下轮再问)。 */
  accepted: boolean;
  httpStatus?: number;
  /**
   * 批1b F2(R2-1 修订):附带 releaseRequestId 时,个人版对该 release job 的取消裁决。
   * 正常裁决(cancelled/idempotent/not_found/too_late)走 200;repair_mismatch 走 409。两者都解析。
   * cancelled/not_found/idempotent → sweeper 收口 release request 行置 cancelled;
   * too_late(个人版已 pre-claim 部署)→ 不动,交 receipt 裁决;repair_mismatch → 不收口(仅告警)。
   * 无 rrid / 无该字段 / 非法值 → null。
   */
  releaseCancel: ReleaseCancelVerdict | null;
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
/**
 * X-Selfheal-Sig(M3 路由绑定版):
 *   hex(HMAC-SHA256(secret, `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`))
 * METHOD 大写;path = URL pathname(无 query)。个人版 receiver / master claim-capability
 * 校验侧同一签名串(跨仓契约,见文件头)。
 */
function signWebhook(
  secret: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  repairId: string,
  bodySha: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}.${path}.${ts}.${nonce}.${repairId}.${bodySha}`)
    .digest("hex");
}

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; text: () => Promise<string> }> {
  // M5:redirect 'manual' —— 3xx 不跟随(okStatus 只认 2xx → 3xx 按失败),封死重定向出网逃逸。
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: "manual",
  });
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
  // 签名 path = 实际请求 URL 的 pathname(M3 路由绑定;base 约定为纯 host:port,
  // 见 config.validateDispatchUrl,故 pathname === path)。
  const fullUrl = `${base}${path}`;
  const signedPath = new URL(fullUrl).pathname;
  const sig = signWebhook(secret, "POST", signedPath, ts, nonce, repairId, sha256Hex(body));
  try {
    const res = await deps.fetch(fullUrl, {
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
    const fuseDedupeKey = `${OPS_REPAIR_FAILED}:${incidentId}`;
    // Outbox 的唯一索引只覆盖 pending/failed；sent 后同 key 可再次插入。
    // 保险丝是 incident 级终态升级，历史上发过一次就永久跳过，避免 sweeper
    // 每个 tick 都重新向企业微信推送同一条告警。
    const alertedR = await d.query<{ one: number }>(
      `SELECT 1 AS one FROM admin_alert_outbox
        WHERE event_type = $1 AND dedupe_key = $2
        LIMIT 1`,
      [OPS_REPAIR_FAILED, fuseDedupeKey],
    );
    if (alertedR.rows.length === 0) {
      d.enqueueAlert({
        event_type: OPS_REPAIR_FAILED,
        severity: "critical",
        title: `自愈修复连续失败,已停派待人工:${eventType}`,
        body:
          `incident=\`${incidentId}\` event=\`${eventType}\` 已累计 ${failedCount} 次修复失败,` +
          `自愈派单保险丝已熔断,不再自动重试。请人工介入排查。`,
        payload: { incident_id: incidentId, event_type: eventType, failed_count: failedCount },
        dedupe_key: fuseDedupeKey,
      });
    }
    return { status: "skipped", reason: "fuse_failed" };
  }

  // 3) 冷却:同 event_type 30min 内已有派单记录 → 跳过(防轰炸)。
  //    drill 豁免走精确常量集 COOLDOWN_EXEMPT_CONDITIONS(见其头注)。
  const cd = COOLDOWN_EXEMPT_CONDITIONS.has(eventType) ? 0 : repairCooldownMs();
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
  let created: { id: string; attempt: number } | null;
  try {
    created = await d.tx(async (client: PoolClient) => {
      // TOCTOU 收口(Codex H2):在同一条 INSERT…SELECT 里再核 incident 仍活跃 **且**
      // condition 仍 firing **且未被压制**(H1b:operator 压制中不派修)。若在步1读到
      // open 之后 condition 已恢复 / incident 被 resolve / 被压制,SELECT 返 0 行 →
      // 不插入 → 不派单(绝不对已恢复/已压制系统派 codex 改动)。
      // 授权路由在派单时快照到 repair(BLOCKER1):tier + action_opcode 同事务
      // 从 policy 冻结,此后 context 只读 repair 行——派单后改 policy 不影响已
      // 派 repair 的 tier/opcode。policy 无命中/未声明 → 保守 tier2(opcode NULL)。
      const ins = await client.query<{ id: string; attempt: number }>(
        `INSERT INTO codex_repairs (incident_id, status, attempt, tier, action_opcode, created_at, updated_at)
         SELECT i.id, 'pending', COALESCE(MAX(cr.attempt), 0) + 1,
                CASE WHEN p.execution_class = 'tier1' THEN 'tier1' ELSE 'tier2' END,
                CASE WHEN p.execution_class = 'tier1' THEN p.action_opcode ELSE NULL END,
                NOW(), NOW()
           FROM incidents i
           LEFT JOIN codex_repairs cr ON cr.incident_id = i.id
           LEFT JOIN incident_policies p ON p.id = i.policy_id
           LEFT JOIN admin_alert_rule_state c ON c.rule_id = i.condition_key
          WHERE i.id = $1::bigint
            AND i.status <> 'resolved'
            AND COALESCE(c.firing, FALSE) = TRUE
            AND NOT COALESCE(c.suppressed_until_clear, FALSE)
          GROUP BY i.id, p.execution_class, p.action_opcode
         RETURNING id::text AS id, attempt`,
        [incidentId],
      );
      return ins.rows[0] ? { id: ins.rows[0].id, attempt: Number(ins.rows[0].attempt) } : null;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return { status: "skipped", reason: "singleflight_conflict" };
    }
    throw err;
  }
  if (!created) {
    // incident 已 resolve / condition 已恢复(TOCTOU),不派单。
    return { status: "skipped", reason: "incident_recovered" };
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
 * 契约(R2-1 修订):`POST ${OC_SELFHEAL_DISPATCH_URL}/api/webhooks/v5-selfheal-cancel`,同 webhook HMAC 头,
 *   body `{ repairId, incidentId, reason }`(批1b:携带活跃 release request 时另加
 *   可选 `releaseRequestId` —— 个人版据此兼取消对应 release job,见 §3.2:未 pre-claim → cancelled;
 *   已 pre-claim → too_late 由 receipt 裁决)。
 *   响应:正常一律 200 `{ terminated, accepted?, releaseCancel?, releaseRequestId? }`(**too_late 也走 200**);
 *   唯一 409 `{ ok:false, releaseCancel:'repair_mismatch' }`(rrid 不属于该 repair 的契约校验失败)。
 * 解析两组字段(repair 级 + release 级),互不干扰:
 *   - repair 级(terminated/accepted)**只在 2xx 成功时**解释;terminated=true → 已确认终止(sweeper 据此
 *     释放 singleflight 槽置 cancelled);accepted=true/terminated=false → 已受理未确认(→ cancelling,下轮再问)。
 *   - release 级(releaseCancel)在 200 与 409 都解析透传(sweeper 据其收口 release request 行)。
 *   - 非 2xx / 网络失败 → repair 级 ok=false(**fail-closed:不释放槽**,旧 root 进程可能仍跑),
 *     releaseCancel 仍按 body 透传(如 409 repair_mismatch)。
 */
export async function postCancel(
  input: { repairId: string; incidentId: string; reason: string; releaseRequestId?: string | null },
  deps: DispatcherDeps = {},
): Promise<CancelDelivery> {
  const d = resolveDeps(deps);
  const body: Record<string, unknown> = {
    repairId: input.repairId,
    incidentId: input.incidentId,
    reason: input.reason.slice(0, 500),
  };
  // 不带 rrid = 原 repair 级 cancel 语义不变;带 rrid = 兼取消 release job(§3.2)。
  if (input.releaseRequestId) body.releaseRequestId = input.releaseRequestId;
  const { res, rawText } = await postSigned(
    "/api/webhooks/v5-selfheal-cancel",
    body,
    input.repairId,
    (s) => s >= 200 && s < 300,
    { fetch: d.fetch, now: d.now, logger: d.logger },
  );
  // F2(R2-1):releaseCancel 裁决在 200(cancelled/idempotent/not_found/too_late)与 409(repair_mismatch)
  // 都可能带,故无论 res.ok 都解析 body 取它;terminated/accepted(repair 级 cancel 语义)只在 2xx 成功时解释。
  let terminated = false;
  let accepted = true;
  let releaseCancel: ReleaseCancelVerdict | null = null;
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText) as { terminated?: unknown; accepted?: unknown; releaseCancel?: unknown };
      if (
        typeof parsed.releaseCancel === "string" &&
        (parsed.releaseCancel === "cancelled" ||
          parsed.releaseCancel === "idempotent" ||
          parsed.releaseCancel === "not_found" ||
          parsed.releaseCancel === "too_late" ||
          parsed.releaseCancel === "repair_mismatch")
      ) {
        releaseCancel = parsed.releaseCancel;
      }
      if (res.ok) {
        terminated = parsed.terminated === true;
        if (typeof parsed.accepted === "boolean") accepted = parsed.accepted;
      }
    } catch {
      /* 无 JSON body:视为已受理未确认;无 releaseCancel 裁决 */
    }
  }
  if (!res.ok) {
    // 非 2xx(含 409 repair_mismatch):repair 级 cancel fail-closed 不释放槽;releaseCancel 已解析透传。
    return { ok: false, terminated: false, accepted: false, httpStatus: res.httpStatus, releaseCancel };
  }
  return { ok: true, terminated, accepted, httpStatus: res.httpStatus, releaseCancel };
}

// ─── 放行交付(隧道 → 个人版 release 端点;批1b:durable async intake)────

/**
 * 交付裁决(sweeper delivery 步据此推进 release request 状态,见 §6.2)。
 *   - accepted:个人版 202 durable intake 已受理 → request queued→accepted。
 *   - authority_mismatch:个人版 409(本地权威复核不符 / rrid 冲突)→ manual_required。
 *   - fuse_engaged:个人版 423(本地熔断)→ 退避重投(request 保持 queued)。
 *   - retry:网络 / 5xx / 3xx / 配置缺失 → attempts++ 指数退避重投。
 */
export type ReleaseDeliveryOutcome = "accepted" | "authority_mismatch" | "fuse_engaged" | "retry";

export interface ReleaseDelivery {
  outcome: ReleaseDeliveryOutcome;
  httpStatus?: number;
  /** 网络/配置层错误(fetch 异常、URL/secret 未配置)。 */
  error?: string;
  /** 个人版 body.error / body.detail.reason;manual_required 时落 failure_reason 供展示。 */
  reason?: string;
}

/**
 * 经隧道 POST 个人版 release 端点,交付一个已放行的 release request(durable async intake)。
 * 契约:`POST ${OC_SELFHEAL_DISPATCH_URL}/api/webhooks/v5-selfheal-release`,与 dispatch
 *   完全相同的 HMAC 信任链(M3 路由绑定签名,repairId 作签名 id 分量),body(§3.1):
 *   `{ repairId, incidentId, releaseRequestId, approvedSha, baseSha, deployPlanHash, manifestHash }`。
 * 个人版处理(durable intake,立即返回,批1b 语义重写):
 *   1. 本地熔断 engaged            → 423 `{ok:false, error:'release_fuse_engaged'}`(v5 退避重投)
 *   2. 本地权威复核不符 / rrid 冲突 → 409 `{ok:false, error:'authority_mismatch'}`(v5 置 manual_required)
 *   3. 落 selfheal_release_jobs(received) → 202 `{ok:true, status:'accepted', releaseRequestId}`
 * v5 交付步只以 **HTTP 状态码** 定裁决(202/409/423/其余),body 仅取 error/reason 展示。
 * 真实部署裁决**不**在此同步返回,由个人版 release worker 异步经 callback(§4)回传。
 */
export async function postReleaseDelivery(
  input: {
    repairId: string;
    incidentId: string;
    releaseRequestId: string;
    approvedSha: string;
    baseSha: string | null;
    deployPlanHash: string | null;
    manifestHash: string | null;
  },
  deps: DispatcherDeps = {},
): Promise<ReleaseDelivery> {
  const d = resolveDeps(deps);
  const { res, rawText } = await postSigned(
    "/api/webhooks/v5-selfheal-release",
    {
      repairId: input.repairId,
      incidentId: input.incidentId,
      releaseRequestId: input.releaseRequestId,
      approvedSha: input.approvedSha,
      baseSha: input.baseSha,
      deployPlanHash: input.deployPlanHash,
      manifestHash: input.manifestHash,
    },
    input.repairId,
    (s) => s === 202,
    { fetch: d.fetch, now: d.now, logger: d.logger },
  );
  // body 用于取 error/reason 展示;裁决只认状态码。
  let body: { ok?: unknown; error?: unknown; status?: unknown; detail?: unknown } | null = null;
  if (rawText) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as { ok?: unknown; error?: unknown; status?: unknown; detail?: unknown };
      }
    } catch {
      /* body 非 JSON → reason 留空,按状态码裁决 */
    }
  }
  let reason: string | undefined;
  if (typeof body?.error === "string" && body.error.length > 0) reason = body.error;
  const detail = body?.detail;
  if (reason === undefined && typeof detail === "string" && detail.length > 0) {
    reason = detail;
  } else if (reason === undefined && detail !== null && typeof detail === "object") {
    const r = (detail as { reason?: unknown }).reason;
    if (typeof r === "string" && r.length > 0) reason = r;
  }

  const status = res.httpStatus;
  let outcome: ReleaseDeliveryOutcome;
  if (status === 202) outcome = "accepted";
  else if (status === 423) outcome = "fuse_engaged";
  else if (status === 409) outcome = "authority_mismatch";
  else outcome = "retry";

  if (outcome !== "accepted") {
    d.logger.warn("selfheal_release_delivery_nonaccepted", {
      repairId: input.repairId,
      releaseRequestId: input.releaseRequestId,
      httpStatus: status,
      outcome,
      reason,
      error: res.error,
    });
  }
  return { outcome, httpStatus: status, error: res.error, reason };
}

// ─── 熔断双侧收敛(隧道 → 个人版 fuse-clear 端点;§3.3)────────────────────

export interface FuseClearDelivery {
  /** 个人版 200 已清本地熔断 → v5 回填 personal_ack_at。 */
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

/**
 * 经隧道 POST 个人版 fuse-clear 端点,把 v5 侧已清除的熔断收敛到个人版本地熔断表。
 * 契约:`POST ${OC_SELFHEAL_DISPATCH_URL}/api/webhooks/v5-selfheal-fuse-clear`,同 HMAC
 *   信任链(repairId 固定串 "fuse" 复用签名串格式),body `{ repairId:'fuse', reason, clearedBy }`。
 * 个人版清本地熔断 + 记审计日志行,返回 200。2xx=成功;其余/网络异常=失败(下轮再收敛)。
 */
export async function postFuseClear(
  input: { reason: string; clearedBy: string },
  deps: DispatcherDeps = {},
): Promise<FuseClearDelivery> {
  const d = resolveDeps(deps);
  const { res } = await postSigned(
    "/api/webhooks/v5-selfheal-fuse-clear",
    { repairId: "fuse", reason: input.reason.slice(0, 500), clearedBy: input.clearedBy.slice(0, 128) },
    "fuse",
    (s) => s >= 200 && s < 300,
    { fetch: d.fetch, now: d.now, logger: d.logger },
  );
  return { ok: res.ok, httpStatus: res.httpStatus, error: res.error };
}
