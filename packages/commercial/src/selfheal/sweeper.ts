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
 * autoRepair 派单 = **切片②**(repairDispatcher);此处留 stub,env OC_SELFHEAL_DISPATCH_DISABLED
 * 默认视为 disabled(未设=关)。
 */

import type { PoolClient } from "pg";
import { query as _query, tx as _tx } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";

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

/** 切片① 默认关闭派单;仅 OC_SELFHEAL_DISPATCH_DISABLED 显式为 '0'/'false' 才视为启用。 */
export function isSelfhealDispatchDisabled(): boolean {
  const v = (process.env.OC_SELFHEAL_DISPATCH_DISABLED ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false";
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

  const claimed = await query<ClaimedDeliveryRow>(
    `UPDATE incident_deliveries d SET claimed_at = NOW()
      WHERE d.id IN (
        SELECT id FROM incident_deliveries
         WHERE status = 'pending'
           AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '${CLAIM_LEASE}')
         ORDER BY id
         LIMIT ${CLAIM_BATCH}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id::text AS id, d.incident_id::text AS incident_id,
                d.incident_rev::text AS incident_rev, d.channel, d.phase`,
  );
  if (claimed.rows.length === 0) return out;

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

  // 派单 stub(切片②):默认关闭,不误动。
  await dispatchAutoRepairsStub(log);

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
  } else {
    // 'all' 与 'surface_cohort'(切片① 降级广播,TODO:接 cohort 归因)都走全站广播。
    deps.broadcastAll(payload);
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
        [title, body, level, createdBy, inc.id, d.phase],
      );
    }
    await client.query(
      `UPDATE incident_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1::bigint`,
      [d.id],
    );
  });
}

/**
 * 切片② repairDispatcher 占位。默认(env 未设)disabled → 直接返回。
 * 切片②:autoRepair policy 命中 incident → INSERT codex_repairs(pending)
 *   (受 ux_repair_singleflight 全局并发1 保护)→ 隧道 POST 个人版 → CAS pending→dispatched。
 */
async function dispatchAutoRepairsStub(log: Logger): Promise<void> {
  if (isSelfhealDispatchDisabled()) return;
  // TODO 切片② repairDispatcher:实现崩溃安全派单(见 RFC §2/§3)。切片① 不做,仅告警不误动。
  log.warn("selfheal_dispatch_enabled_but_stub_only");
}

// ─── activeIncidents 内存快照(供 bridge accept 补发)──────────────────

export interface IncidentReconcilerSnapshotHandle {
  stop(): void;
  runNow(): Promise<SweepResult>;
  /** 当前活跃(未 resolved)incident 的 WS payload 快照。bridge 在鉴权后补发。 */
  getActiveIncidents(): IncidentPayload[];
}

export function startIncidentSweeper(
  opts: { intervalMs?: number; runOnStart?: boolean } & SweeperDeps,
): IncidentReconcilerSnapshotHandle {
  const interval = Math.max(2_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const query = opts.query ?? _query;
  const log = opts.logger ?? rootLogger.child({ subsys: "selfheal", module: "sweeper" });
  let stopped = false;
  let inflight: Promise<SweepResult> | null = null;
  let activeSnapshot: IncidentPayload[] = [];

  async function refreshActive(): Promise<void> {
    try {
      const r = await query<IncidentRow>(
        `SELECT id::text AS id, rev::text AS rev, status, severity, surface, audience,
                user_title, user_message
           FROM incidents WHERE status <> 'resolved'`,
      );
      activeSnapshot = r.rows.map((inc) => buildPayload(inc, Number(inc.rev), "opened"));
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
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: tick,
    getActiveIncidents: () => activeSnapshot,
  };
}
