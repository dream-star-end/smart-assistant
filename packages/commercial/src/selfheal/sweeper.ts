/**
 * v5 自愈体系切片① — incident deliveries sweeper:durable 投递(WS + inbox)。
 *
 * 消费 incident_deliveries(status='pending'):claim(claimed_at 租约 CAS)→ 投递 → 标 sent。
 *   - channel='ws':调注入的 broadcastAll / broadcastToUsers(at-least-once,前端按 rev 幂等)。
 *   - channel='inbox':**同 PG 事务**内 INSERT inbox_messages(source_type/source_id/source_phase
 *     幂等键 = 最终防线)+ 标 delivery sent(M-inbox-atomic:消除崩溃窗口)。仅 audience='all'
 *     建 inbox delivery(见 incidents.insertDeliveries)。opened/updated→level='warning'(写异常),
 *     resolved→level='info'(恢复通知)。
 *
 * 另维护内存 activeIncidents 快照(每 tick 刷新),供 bridge accept 补发(index.ts 暴露 getter)。
 *
 * autoRepair 派单 + 修复状态机时序看护 = **切片②ⓐ**(本文件 sweepRepairsOnce):env
 * OC_SELFHEAL_DISPATCH_DISABLED 默认视为 disabled(未设=关);启用后每 tick 跑
 *   ①redispatchPending(崩溃残留 pending 重发)②verify freshness fence(verifying→succeeded/
 *   verification_failed/inconclusive)③timeout 看护(ack 5min/总 90min 超预算→cancel 流)
 *   ④cancel 中间态推进(隧道通知个人版,失联 fail-closed 不释放槽)⑤autoRepair 派单
 *   (policy.auto_repair 且全局无活跃修复 → dispatchRepair)。派单/回调网络层在 repairDispatcher。
 */

import type { PoolClient } from "pg";
import { query as _query, tx as _tx } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { safeEnqueueAlert as _safeEnqueueAlert, type AlertEventInput } from "../admin/alertOutbox.js";
import { resolveIncident as _resolveIncident } from "./incidents.js";
import {
  dispatchRepair as _dispatchRepair,
  redispatchPending as _redispatchPending,
  postCancel as _postCancel,
  ACTIVE_REPAIR_STATUSES,
  OPS_REPAIR_TIMEOUT,
} from "./repairDispatcher.js";
import {
  isSelfhealDispatchDisabled,
  ackBudgetMs,
  totalBudgetMs,
} from "./config.js";

// B3:配置解析已收口 selfheal/config.ts;此处 re-export 保持既有 import 站点
// (index barrel / bridge)不动。
export { isSelfhealDispatchDisabled };

const DEFAULT_INTERVAL_MS = 10_000;
const CLAIM_LEASE = "2 minutes";
const CLAIM_BATCH = 50;
const RECOVERY_MESSAGE = "相关功能已恢复正常,感谢您的耐心等待。";

/** WS 帧(protocol SysIncident / web-react IncidentWire 契约,字段/类型严格对齐)。 */
export interface IncidentPayload {
  type: "sys.incident";
  incidentId: string;
  rev: number;
  status: "open" | "resolved";
  severity: "info" | "warning" | "critical";
  surface: string;
  title: string;
  message: string;
  ts: number;
}

export type BroadcastAllFn = (payload: unknown) => number;
export type BroadcastToUsersFn = (uids: string[], payload: unknown) => number;

/** One active incident in the backfill snapshot: its WS payload plus the routing
 *  facts needed to filter visibility per user. */
export interface ActiveIncidentEntry {
  payload: IncidentPayload;
  audience: string;
  /** Materialized recipient uids for audience='user_ids' (empty otherwise). */
  recipients: Set<string>;
}

/**
 * Per-user visibility filter for the post-auth backfill (Codex B2 — a global
 * snapshot leaked targeted incidents to every reconnecting user). Rules:
 *   - audience='all'           → visible to everyone;
 *   - audience='user_ids'      → visible ONLY to a materialized recipient;
 *   - audience='surface_cohort'/anything else → visible to NOBODY (fail closed:
 *     cohort attribution isn't materialized, so we never leak a targeted incident
 *     by treating it as broadcast).
 */
export function visibleIncidentsForUser(
  entries: ActiveIncidentEntry[],
  uid: string,
): IncidentPayload[] {
  return entries
    .filter((e) => e.audience === "all" || (e.audience === "user_ids" && e.recipients.has(uid)))
    .map((e) => e.payload);
}

export interface SweeperDeps {
  broadcastAll: BroadcastAllFn;
  broadcastToUsers: BroadcastToUsersFn;
  query?: typeof _query;
  tx?: typeof _tx;
  logger?: Logger;
}

interface IncidentRow {
  id: string;
  rev: string;
  status: "open" | "repairing" | "resolved";
  severity: "info" | "warning" | "critical";
  surface: string;
  audience: string;
  user_title: string;
  user_message: string;
}
interface ClaimedDeliveryRow {
  id: string;
  incident_id: string;
  incident_rev: string;
  channel: "ws" | "inbox";
  phase: "opened" | "updated" | "resolved";
}

function buildPayload(inc: IncidentRow, deliveryRev: number, phase: string): IncidentPayload {
  const status: "open" | "resolved" = phase === "resolved" ? "resolved" : "open";
  return {
    type: "sys.incident",
    incidentId: inc.id,
    rev: deliveryRev,
    status,
    severity: inc.severity,
    surface: inc.surface,
    title: inc.user_title,
    message: status === "resolved" ? RECOVERY_MESSAGE : inc.user_message,
    ts: Date.now(),
  };
}

export interface SweepResult {
  ws: number;
  inbox: number;
  errors: number;
}

/**
 * 单次 sweep。幂等(claim 租约 + delivery 唯一键 + inbox source 幂等键)。
 */
export async function sweepOnce(deps: SweeperDeps): Promise<SweepResult> {
  const query = deps.query ?? _query;
  const tx = deps.tx ?? _tx;
  const log = deps.logger ?? rootLogger.child({ subsys: "selfheal", module: "sweeper" });
  const out: SweepResult = { ws: 0, inbox: 0, errors: 0 };

  // Legacy incident deliveries are permanently retired. Mark any pre-upgrade
  // residue failed before doing repair-state housekeeping; never replay an old
  // all-user WS/inbox notice after the new approval gate is installed.
  await query(`UPDATE incident_deliveries SET status='failed', claimed_at=NOW()
    WHERE status='pending'`);
  const claimed = { rows: [] as ClaimedDeliveryRow[] };

  // 注意:claimed 为空**不 early-return**——修复状态机看护(verify fence/timeout/
  // cancel 推进)与 nonce 保洁必须每 tick 跑,否则"无 pending 投递"的安静时段里
  // cancel/verify 永远卡住(收尾批修:此前 early-return 让 repair sweep 饿死)。
  if (claimed.rows.length > 0) {
    // 批量取 incident 详情(payload materialize)。
    const incidentIds = [...new Set(claimed.rows.map((d) => d.incident_id))];
    const incR = await query<IncidentRow>(
      `SELECT id::text AS id, rev::text AS rev, status, severity, surface, audience,
              user_title, user_message
         FROM incidents WHERE id = ANY($1::bigint[])`,
      [incidentIds],
    );
    const incById = new Map<string, IncidentRow>();
    for (const r of incR.rows) incById.set(r.id, r);

    for (const d of claimed.rows) {
      const inc = incById.get(d.incident_id);
      if (!inc) {
        // 理论不可达(FK CASCADE);标 sent 防死循环。
        await query(`UPDATE incident_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1::bigint`, [d.id]);
        continue;
      }
      const payload = buildPayload(inc, Number(d.incident_rev), d.phase);
      try {
        if (d.channel === "ws") {
          await deliverWs(query, deps, inc, d.id, payload);
          out.ws++;
        } else {
          await deliverInbox(tx, inc, d, payload);
          out.inbox++;
        }
      } catch (err) {
        out.errors++;
        // 失败留 pending(claimed_at 租约到期后重投,at-least-once);不置 failed 以免丢投递。
        log.warn("selfheal_delivery_failed", {
          delivery: d.id,
          channel: d.channel,
          err: (err as Error)?.message ?? String(err),
        });
      }
    }
  }

  // M3:webhook nonce 保洁(selfheal_webhook_nonces,ts 窗口 ±2min << 10min 保留余量)。
  // 失败只 warn,不拖垮主链。
  try {
    await query(`DELETE FROM selfheal_webhook_nonces WHERE seen_at < NOW() - INTERVAL '10 minutes'`);
  } catch (err) {
    log.warn("selfheal_nonce_retention_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // 切片②ⓐ:修复派单 + 状态机时序看护(默认关闭,env 缺省安全)。永不因其失败拖垮投递主链。
  if (!isSelfhealDispatchDisabled()) {
    try {
      await sweepRepairsOnce({ query, tx, logger: log });
    } catch (err) {
      out.errors++;
      log.warn("selfheal_repair_sweep_failed", { err: (err as Error)?.message ?? String(err) });
    }
  }

  return out;
}

/** WS 投递:按 audience 分流 broadcastAll / broadcastToUsers;完成后标 sent(fire-and-forget,0 在线仍算送达)。 */
async function deliverWs(
  query: typeof _query,
  deps: SweeperDeps,
  inc: IncidentRow,
  deliveryId: string,
  payload: IncidentPayload,
): Promise<void> {
  if (inc.audience === "user_ids") {
    const recips = await query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM incident_recipients WHERE incident_id = $1::bigint`,
      [inc.id],
    );
    deps.broadcastToUsers(recips.rows.map((r) => r.user_id), payload);
  } else if (inc.audience === "all") {
    deps.broadcastAll(payload);
  } else {
    // surface_cohort: cohort attribution not implemented → fail CLOSED. NEVER
    // broadcast a targeted incident to every user (Codex B2). The incident still
    // exists for admins; realtime targeted delivery awaits cohort materialization
    // (RFC M-recipients). Marked sent below to avoid a delivery retry loop.
    deps.logger?.warn("selfheal_ws_surface_cohort_failclosed", {
      incidentId: payload.incidentId,
    });
  }
  await query(`UPDATE incident_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1::bigint`, [deliveryId]);
}

/**
 * inbox 投递:同事务 INSERT inbox(source 幂等键)+ 标 delivery sent。
 * created_by = MIN active admin(与 inboxPostHandler / writeSystemInbox 系统收件人语义一致;
 * inbox_messages.created_by 有 FK → users,不硬编码 1,现解析更稳)。无 admin → 跳过 inbox
 * (WS 已覆盖在线用户),标 sent 防死循环。
 */
async function deliverInbox(
  tx: typeof _tx,
  inc: IncidentRow,
  d: ClaimedDeliveryRow,
  payload: IncidentPayload,
): Promise<void> {
  const resolved = payload.status === "resolved";
  const level = resolved ? "info" : "warning";
  const title = (resolved ? `${inc.user_title}(已恢复)` : inc.user_title).slice(0, 190) || inc.surface;
  const body = (resolved ? RECOVERY_MESSAGE : inc.user_message).slice(0, 16000) || title;
  // L1(收尾批):'updated' 相位的 inbox 幂等键带上 incident_rev——同一 incident 的
  // 多次 update(severity/文案升级)各落一条站内信;同 rev 重放仍只一条。
  // opened/resolved 每 incident 语义唯一,保持裸相位不变。
  const sourcePhase = d.phase === "updated" ? `updated:${d.incident_rev}` : d.phase;
  await tx(async (client: PoolClient) => {
    const adminR = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1`,
    );
    const createdBy = adminR.rows[0]?.id;
    if (createdBy) {
      await client.query(
        `INSERT INTO inbox_messages
           (audience, user_id, title, body_md, level, created_by, source_type, source_id, source_phase)
         VALUES ('all', NULL, $1, $2, $3, $4::bigint, 'incident', $5::bigint, $6)
         ON CONFLICT (source_type, source_id, source_phase) WHERE source_type IS NOT NULL
           DO NOTHING`,
        [title, body, level, createdBy, inc.id, sourcePhase],
      );
    }
    await client.query(
      `UPDATE incident_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1::bigint`,
      [d.id],
    );
  });
}

// ─── 切片②ⓐ:修复派单 + 状态机时序看护 ─────────────────────────────────
// ack 预算(dispatched 未 ack)/ 总预算(created 起)超限 → cancel 流。
// 数值解析收口 selfheal/config.ts(B3):ackBudgetMs / totalBudgetMs 从那里 import。

export interface RepairSweepDeps {
  query?: typeof _query;
  tx?: typeof _tx;
  logger?: Logger;
  now?: () => number;
  /** 注入以便测试(默认走 repairDispatcher 真实现)。 */
  dispatchRepair?: typeof _dispatchRepair;
  redispatchPending?: typeof _redispatchPending;
  postCancel?: typeof _postCancel;
  resolveIncident?: typeof _resolveIncident;
  enqueueAlert?: (event: AlertEventInput) => void;
}

export interface RepairSweepResult {
  redispatched: number;
  dispatched: number;
  succeeded: number;
  verificationFailed: number;
  inconclusive: number;
  cancelRequested: number;
  cancelled: number;
  errors: number;
}

interface VerifyingRow {
  id: string;
  incident_id: string;
  verify_after: Date | null;
  verify_deadline: Date | null;
  firing: boolean | null;
  observed_at: Date | null;
}
interface WatchRow {
  id: string;
  incident_id: string;
  status: string;
  created_at: Date;
  dispatched_at: Date | null;
}

/**
 * 单轮修复对账。幂等、可重复调用。仅在 dispatch 启用时由 sweepOnce 调(env 缺省安全)。
 * 五步(见文件头);全部 DB CAS,重叠/崩溃安全。返回本轮计数(测试断言 + 日志)。
 */
export async function sweepRepairsOnce(deps: RepairSweepDeps = {}): Promise<RepairSweepResult> {
  const query = deps.query ?? _query;
  const tx = deps.tx ?? _tx;
  const log = deps.logger ?? rootLogger.child({ subsys: "selfheal", module: "repairSweep" });
  const now = deps.now ?? (() => Date.now());
  const dispatchRepair = deps.dispatchRepair ?? _dispatchRepair;
  const redispatchPending = deps.redispatchPending ?? _redispatchPending;
  const postCancel = deps.postCancel ?? _postCancel;
  const resolveIncident = deps.resolveIncident ?? _resolveIncident;
  const enqueue = deps.enqueueAlert ?? _safeEnqueueAlert;
  const out: RepairSweepResult = {
    redispatched: 0, dispatched: 0, succeeded: 0, verificationFailed: 0,
    inconclusive: 0, cancelRequested: 0, cancelled: 0, errors: 0,
  };

  // ① redispatch:POST 后置位前崩溃留下的 pending。
  try {
    out.redispatched = await redispatchPending({ query, tx, now, logger: log });
  } catch (err) {
    out.errors++;
    log.warn("selfheal_redispatch_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ② verify freshness fence:verifying 修复只有 observed_at>verify_after 的新观测有裁决资格。
  try {
    const vr = await query<VerifyingRow>(
      `SELECT r.id::text AS id, r.incident_id::text AS incident_id,
              r.verify_after, r.verify_deadline, c.firing, c.observed_at
         FROM codex_repairs r
         JOIN incidents i ON i.id = r.incident_id
         LEFT JOIN admin_alert_rule_state c ON c.rule_id = i.condition_key
        WHERE r.status = 'verifying'`,
    );
    const nowMs = now();
    for (const row of vr.rows) {
      try {
        const verifyAfter = row.verify_after ? row.verify_after.getTime() : null;
        const observedAt = row.observed_at ? row.observed_at.getTime() : null;
        const fresh = verifyAfter !== null && observedAt !== null && observedAt > verifyAfter;
        const deadlinePassed = row.verify_deadline !== null && nowMs > row.verify_deadline.getTime();
        if (fresh && row.firing === false) {
          // 新观测探测已过 → 修复成功 + resolve incident(source='codex')。
          const done = await tx(async (client: PoolClient) => {
            const cas = await client.query(
              `UPDATE codex_repairs SET status='succeeded', finished_at=NOW(), updated_at=NOW()
                WHERE id=$1::bigint AND status='verifying'`,
              [row.id],
            );
            if ((cas.rowCount ?? 0) === 0) return false;
            await appendRepairEvent(client, row.id, "note", "探测确认已恢复,修复成功");
            await resolveIncident(row.incident_id, "codex", client);
            return true;
          });
          if (done) out.succeeded++;
        } else if (fresh && row.firing === true) {
          if (deadlinePassed) {
            const failed = await terminalCas(tx, row.id, "verification_failed",
              "验证期新观测仍 firing 且已过 verify_deadline,判定验证失败");
            if (failed) { out.verificationFailed++; alertVerifyFailed(enqueue, row.incident_id, row.id); }
          }
        } else if (deadlinePassed) {
          // 无新观测且已过 deadline → inconclusive(非失败,不 resolve 不重罚)。
          const inc = await terminalCas(tx, row.id, "verification_inconclusive",
            "verify_deadline 内无新观测,验证结果不确定");
          if (inc) out.inconclusive++;
        }
      } catch (err) {
        out.errors++;
        log.warn("selfheal_verify_fence_failed", { repairId: row.id, err: (err as Error)?.message });
      }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_verify_scan_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ③ timeout 看护:dispatched/acked/running 超预算 → 进 cancel 流(cancel_requested)。
  try {
    const wr = await query<WatchRow>(
      `SELECT id::text AS id, incident_id::text AS incident_id, status, created_at, dispatched_at
         FROM codex_repairs WHERE status IN ('dispatched','acked','running')`,
    );
    const nowMs = now();
    const ackB = ackBudgetMs();
    const totalB = totalBudgetMs();
    for (const row of wr.rows) {
      const overTotal = nowMs - row.created_at.getTime() > totalB;
      const overAck =
        row.status === "dispatched" &&
        row.dispatched_at !== null &&
        nowMs - row.dispatched_at.getTime() > ackB;
      if (!overTotal && !overAck) continue;
      try {
        const reqd = await tx(async (client: PoolClient) => {
          const cas = await client.query(
            `UPDATE codex_repairs SET status='cancel_requested', updated_at=NOW()
              WHERE id=$1::bigint AND status IN ('dispatched','acked','running')
                AND COALESCE(detail->>'release_claimed','') <> 'true'`,
            [row.id],
          );
          if ((cas.rowCount ?? 0) === 0) return false;
          await appendRepairEvent(client, row.id, "timeout",
            overAck ? "超 ack 预算未响应,请求取消" : "超总预算未完成,请求取消");
          return true;
        });
        if (reqd) {
          out.cancelRequested++;
          alertTimeout(enqueue, row.incident_id, row.id, overAck ? "ack" : "total");
        }
      } catch (err) {
        out.errors++;
        log.warn("selfheal_timeout_cas_failed", { repairId: row.id, err: (err as Error)?.message });
      }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_timeout_scan_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ④ cancel 中间态推进:cancel_requested/cancelling → 隧道通知个人版。
  //    确认终止才置 cancelled(释放 singleflight 槽);失联/失败 → 保持(fail-closed 不释放)。
  try {
    const cr = await query<{ id: string; incident_id: string; status: string }>(
      `SELECT id::text AS id, incident_id::text AS incident_id, status
         FROM codex_repairs WHERE status IN ('cancel_requested','cancelling')`,
    );
    for (const row of cr.rows) {
      try {
        const del = await postCancel(
          { repairId: row.id, incidentId: row.incident_id, reason: "selfheal_timeout" },
          { query, tx, now, logger: log },
        );
        if (del.terminated) {
          const done = await tx(async (client: PoolClient) => {
            const cas = await client.query(
              `UPDATE codex_repairs SET status='cancelled', finished_at=NOW(), updated_at=NOW()
                WHERE id=$1::bigint AND status IN ('cancel_requested','cancelling')`,
              [row.id],
            );
            if ((cas.rowCount ?? 0) === 0) return false;
            await appendRepairEvent(client, row.id, "cancel", "个人版确认 codex 会话已终止,释放槽");
            return true;
          });
          if (done) out.cancelled++;
        } else if (del.ok && del.accepted && row.status === "cancel_requested") {
          await tx(async (client: PoolClient) => {
            await client.query(
              `UPDATE codex_repairs SET status='cancelling', updated_at=NOW()
                WHERE id=$1::bigint AND status='cancel_requested'`,
              [row.id],
            );
            await appendRepairEvent(client, row.id, "cancel", "个人版已受理取消,等待终止确认");
          });
        } else if (!del.ok) {
          // 失联/失败:fail-closed,不释放槽(旧 root 进程可能仍跑),下轮再试。
          log.warn("selfheal_cancel_delivery_failed", { repairId: row.id, httpStatus: del.httpStatus });
        }
      } catch (err) {
        out.errors++;
        log.warn("selfheal_cancel_progress_failed", { repairId: row.id, err: (err as Error)?.message });
      }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_cancel_scan_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ⑤ autoRepair 派单:全局无活跃修复(singleflight)时,取 policy.auto_repair 的活跃 incident 派单。
  try {
    const active = await query<{ one: number }>(
      `SELECT 1 AS one FROM codex_repairs WHERE status = ANY($1::text[]) LIMIT 1`,
      [ACTIVE_REPAIR_STATUSES as unknown as string[]],
    );
    if (active.rows.length === 0) {
      const cand = await query<{ id: string }>(
        `SELECT i.id::text AS id
           FROM incidents i JOIN incident_policies p ON p.id = i.policy_id
          WHERE i.status IN ('open','repairing') AND p.auto_repair = TRUE
          ORDER BY i.opened_at ASC`,
      );
      for (const c of cand.rows) {
        const r = await dispatchRepair(c.id, { query, tx, now, logger: log });
        if (r.status === "dispatched") { out.dispatched++; break; }
        if (r.status !== "skipped") break; // 已建 pending(占槽),本轮到此为止
      }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_autorepair_failed", { err: (err as Error)?.message ?? String(err) });
  }

  return out;
}

/** 追加 repair 进度事件(同 client 事务)。 */
async function appendRepairEvent(
  client: PoolClient,
  repairId: string,
  kind: string,
  message: string,
): Promise<void> {
  await client.query(
    `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
     VALUES ($1::bigint, $2, $3, '{}'::jsonb)`,
    [repairId, kind, message.slice(0, 4000)],
  );
}

/** verifying → 非成功终态 CAS(verification_failed / verification_inconclusive)+ 记 note。 */
async function terminalCas(
  tx: typeof _tx,
  repairId: string,
  status: "verification_failed" | "verification_inconclusive",
  note: string,
): Promise<boolean> {
  return tx(async (client: PoolClient) => {
    const cas = await client.query(
      `UPDATE codex_repairs SET status=$2, finished_at=NOW(), updated_at=NOW()
        WHERE id=$1::bigint AND status='verifying'`,
      [repairId, status],
    );
    if ((cas.rowCount ?? 0) === 0) return false;
    await appendRepairEvent(client, repairId, "note", note);
    return true;
  });
}

function alertVerifyFailed(enqueue: (e: AlertEventInput) => void, incidentId: string, repairId: string): void {
  enqueue({
    event_type: OPS_REPAIR_TIMEOUT,
    severity: "critical",
    title: "自愈修复验证失败,待人工复核",
    body: `incident=\`${incidentId}\` repair=\`${repairId}\` codex 报告修复但探测仍未恢复,判定验证失败。`,
    payload: { incident_id: incidentId, repair_id: repairId, kind: "verification_failed" },
    dedupe_key: `${OPS_REPAIR_TIMEOUT}:verify_failed:${repairId}`,
  });
}

function alertTimeout(
  enqueue: (e: AlertEventInput) => void,
  incidentId: string,
  repairId: string,
  kind: "ack" | "total",
): void {
  enqueue({
    event_type: OPS_REPAIR_TIMEOUT,
    severity: "critical",
    title: "自愈修复超时,已请求取消",
    body:
      `incident=\`${incidentId}\` repair=\`${repairId}\` 超${kind === "ack" ? " ack " : "总"}预算未完成,` +
      `已发起取消并等待个人版终止确认。`,
    payload: { incident_id: incidentId, repair_id: repairId, kind: `timeout_${kind}` },
    dedupe_key: `${OPS_REPAIR_TIMEOUT}:timeout:${repairId}`,
  });
}

// ─── activeIncidents 内存快照(供 bridge accept 补发)──────────────────

export interface IncidentReconcilerSnapshotHandle {
  stop(): Promise<void>;
  runNow(): Promise<SweepResult>;
  /**
   * 当前活跃(未 resolved)incident 中**该 uid 可见**的 WS payload 快照,供 bridge
   * 鉴权后补发。可见性 = audience='all' 或(audience='user_ids' 且 uid 在
   * incident_recipients)。surface_cohort 未 materialize 归因 → 对任何具体用户
   * fail-closed 不可见(绝不把定向事故补发给全站,Codex B2)。
   */
  getActiveIncidentsForUser(uid: string): IncidentPayload[];
}

export function startIncidentSweeper(
  opts: { intervalMs?: number; runOnStart?: boolean } & SweeperDeps,
): IncidentReconcilerSnapshotHandle {
  const interval = Math.max(2_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const query = opts.query ?? _query;
  const log = opts.logger ?? rootLogger.child({ subsys: "selfheal", module: "sweeper" });
  let stopped = false;
  let inflight: Promise<SweepResult> | null = null;
  // Per-incident snapshot carries audience + materialized recipients so the
  // bridge re-send can be filtered PER USER (Codex B2 — a global array leaked
  // targeted incidents to every reconnecting user).
  let activeSnapshot: ActiveIncidentEntry[] = [];

  async function refreshActive(): Promise<void> {
    try {
      const r = await query<IncidentRow>(
        `SELECT id::text AS id, rev::text AS rev, status, severity, surface, audience,
                user_title, user_message
           FROM incidents WHERE status <> 'resolved'`,
      );
      const entries: ActiveIncidentEntry[] = [];
      for (const inc of r.rows) {
        const payload = buildPayload(inc, Number(inc.rev), "opened");
        let recipients = new Set<string>();
        if (inc.audience === "user_ids") {
          const rr = await query<{ user_id: string }>(
            `SELECT user_id::text AS user_id FROM incident_recipients WHERE incident_id = $1::bigint`,
            [inc.id],
          );
          recipients = new Set(rr.rows.map((x) => x.user_id));
        }
        entries.push({ payload, audience: inc.audience, recipients });
      }
      activeSnapshot = entries;
    } catch (err) {
      log.warn("selfheal_active_snapshot_refresh_failed", {
        err: (err as Error)?.message ?? String(err),
      });
    }
  }

  async function tick(): Promise<SweepResult> {
    if (inflight) return inflight;
    inflight = (async () => {
      await refreshActive();
      return sweepOnce({ ...opts, logger: log });
    })()
      .then((r) => {
        if (r.ws || r.inbox || r.errors) {
          log.info("selfheal_sweep", { ws: r.ws, inbox: r.inbox, errors: r.errors });
        }
        return r;
      })
      .catch((err) => {
        log.warn("selfheal_sweep_tick_failed", { err: (err as Error)?.message ?? String(err) });
        return { ws: 0, inbox: 0, errors: 0 } as SweepResult;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void tick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();
  if (opts.runOnStart) void tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inflight) await inflight;
    },
    runNow: tick,
    // Per-user visibility filter (Codex B2) — see visibleIncidentsForUser.
    getActiveIncidentsForUser: (uid: string) => visibleIncidentsForUser(activeSnapshot, uid),
  };
}

/**
 * 每槽只读 active incident 快照。与 leader-only sweeper 分离：双 master 下 follower 也要
 * 在 WS 鉴权后补发本用户可见事故，但绝不能 claim delivery / 推进 repair 状态机。
 */
export interface IncidentSnapshotHandle {
  stop(): Promise<void>;
  runNow(): Promise<void>;
  getActiveIncidentsForUser(uid: string): IncidentPayload[];
}

export function startIncidentSnapshot(opts: {
  intervalMs?: number;
  query?: typeof _query;
  logger?: Logger;
} = {}): IncidentSnapshotHandle {
  const interval = Math.max(2_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const query = opts.query ?? _query;
  const log = opts.logger ?? rootLogger.child({ subsys: "selfheal", module: "snapshot" });
  let stopped = false;
  let inflight: Promise<void> | null = null;
  let activeSnapshot: ActiveIncidentEntry[] = [];

  async function refresh(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await query<IncidentRow>(
        `SELECT id::text AS id, rev::text AS rev, status, severity, surface, audience,
                user_title, user_message
           FROM incidents WHERE status <> 'resolved'`,
      );
      const entries: ActiveIncidentEntry[] = [];
      for (const inc of r.rows) {
        const payload = buildPayload(inc, Number(inc.rev), "opened");
        let recipients = new Set<string>();
        if (inc.audience === "user_ids") {
          const rr = await query<{ user_id: string }>(
            `SELECT user_id::text AS user_id FROM incident_recipients WHERE incident_id=$1::bigint`,
            [inc.id],
          );
          recipients = new Set(rr.rows.map((x) => x.user_id));
        }
        entries.push({ payload, audience: inc.audience, recipients });
      }
      activeSnapshot = entries;
    })()
      .catch((err) => {
        log.warn("selfheal_snapshot_refresh_failed", {
          err: (err as Error)?.message ?? String(err),
        });
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (!stopped) void refresh();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inflight) await inflight;
    },
    runNow: refresh,
    getActiveIncidentsForUser: (uid) => visibleIncidentsForUser(activeSnapshot, uid),
  };
}
