/**
 * v5 自愈状态机 sweeper。
 *
 * incident 生命周期是内部运维账本，绝不直接产生用户 WS、站内信或重连快照。升级前遗留的
 * incident_deliveries 每轮统一标 failed，避免旧版 all-user 投递被意外恢复。唯一用户通知出口
 * 是 userNoticeApproval：可信全自动修复完成 + 精确影响证据 + 企业微信审批后定向发送。
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

// B3:配置解析已收口 selfheal/config.ts;此处 re-export 保持既有 index barrel import。
export { isSelfhealDispatchDisabled };

const DEFAULT_INTERVAL_MS = 10_000;

export interface SweeperDeps {
  query?: typeof _query;
  tx?: typeof _tx;
  logger?: Logger;
}

export interface SweepResult {
  ws: number;
  inbox: number;
  errors: number;
}

/** 单次 sweep：先永久封存 legacy 用户投递，再推进内部修复状态机。 */
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
          WHERE i.status IN ('open','repairing')
            AND p.auto_repair = TRUE AND p.enabled = TRUE
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

// ─── leader sweeper lifecycle ───────────────────────────────────────

export interface IncidentSweeperHandle {
  stop(): Promise<void>;
  runNow(): Promise<SweepResult>;
}

export function startIncidentSweeper(
  opts: { intervalMs?: number; runOnStart?: boolean } & SweeperDeps,
): IncidentSweeperHandle {
  const interval = Math.max(2_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const log = opts.logger ?? rootLogger.child({ subsys: "selfheal", module: "sweeper" });
  let stopped = false;
  let inflight: Promise<SweepResult> | null = null;

  async function tick(): Promise<SweepResult> {
    if (inflight) return inflight;
    inflight = sweepOnce({ ...opts, logger: log })
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
  };
}
