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
 *
 * 批1b(dormant:无 release request 即零行为):⑥release delivery(fuse 未 engaged 时交付
 *   due queued 请求 → 202 accepted / 409 manual_required / 423|5xx 退避)⑦release watch
 *   (accepted/deploying 停滞只告警不改状态)⑧熔断双侧收敛(v5 已清 → 投递个人版 fuse-clear)
 *   ⑨熔断 engaged → durable critical 告警(F13①,每次 engagement 至多一次,dedupe)。
 *   另:cancel 步(④)按 cancel webhook 的 release 裁决收口 release request(F2/R2-1:cancelled/not_found/
 *   idempotent[200] → 置 cancelled;too_late[200] → 留给 receipt;repair_mismatch[409] → 仅告警不收口)。
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
  postReleaseDelivery as _postReleaseDelivery,
  postFuseClear as _postFuseClear,
  ACTIVE_REPAIR_STATUSES,
  OPS_REPAIR_TIMEOUT,
  OPS_REPAIR_FAILED,
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
  postReleaseDelivery?: typeof _postReleaseDelivery;
  postFuseClear?: typeof _postFuseClear;
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
  /** 批1b:release request 交付受理数(202 → accepted)。 */
  releaseDelivered: number;
  /** 批1b:交付被个人版权威复核拒 → manual_required 数。 */
  releaseManualRequired: number;
  /** 批1b:release watch 步告警数(accepted/deploying 停滞)。 */
  releaseWatchAlerts: number;
  /** 批1b:熔断双侧收敛(个人版已 ack)次数。 */
  fuseConverged: number;
  /** 批1b F2:cancel webhook 裁决收口 release request 置 cancelled 的次数。 */
  releaseCancelled: number;
  /** 批1b F13①:熔断 engaged 首次 durable 告警(每次 engagement 至多一次)次数。 */
  fuseAlerts: number;
}

interface VerifyingRow {
  id: string;
  incident_id: string;
  tier: string;
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
  const postReleaseDelivery = deps.postReleaseDelivery ?? _postReleaseDelivery;
  const postFuseClear = deps.postFuseClear ?? _postFuseClear;
  const resolveIncident = deps.resolveIncident ?? _resolveIncident;
  const enqueue = deps.enqueueAlert ?? _safeEnqueueAlert;
  const out: RepairSweepResult = {
    redispatched: 0, dispatched: 0, succeeded: 0, verificationFailed: 0,
    inconclusive: 0, cancelRequested: 0, cancelled: 0, errors: 0,
    releaseDelivered: 0, releaseManualRequired: 0, releaseWatchAlerts: 0, fuseConverged: 0,
    releaseCancelled: 0, fuseAlerts: 0,
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
      `SELECT r.id::text AS id, r.incident_id::text AS incident_id, r.tier,
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
          // 新观测探测已过 → 修复成功 + resolve incident。归因按 tier:
          // tier1 确定性运维动作=source='auto';tier2 代码修复=source='codex'。
          const resolveSource = row.tier === "tier1" ? "auto" : "codex";
          const done = await tx(async (client: PoolClient) => {
            const cas = await client.query(
              `UPDATE codex_repairs SET status='succeeded', finished_at=NOW(), updated_at=NOW()
                WHERE id=$1::bigint AND status='verifying'`,
              [row.id],
            );
            if ((cas.rowCount ?? 0) === 0) return false;
            await appendRepairEvent(client, row.id, "note", "探测确认已恢复,修复成功");
            await resolveIncident(row.incident_id, resolveSource, client);
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
                AND NOT EXISTS (
                  SELECT 1 FROM selfheal_release_requests rr
                   WHERE rr.repair_id = codex_repairs.id
                     AND rr.status IN ('queued','accepted','deploying')
                )`,
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
    // 批1b:一并取该 repair 的最新 release request rrid(存在则 postCancel 带 rrid,
    // 个人版据此兼取消 release job,§3.2;不存在 → 原 repair 级 cancel 语义不变)。
    const cr = await query<{ id: string; incident_id: string; status: string; release_request_id: string | null }>(
      `SELECT r.id::text AS id, r.incident_id::text AS incident_id, r.status,
              (SELECT rr.release_request_id FROM selfheal_release_requests rr
                WHERE rr.repair_id = r.id ORDER BY rr.id DESC LIMIT 1) AS release_request_id
         FROM codex_repairs r WHERE r.status IN ('cancel_requested','cancelling')`,
    );
    for (const row of cr.rows) {
      try {
        const del = await postCancel(
          {
            repairId: row.id,
            incidentId: row.incident_id,
            reason: "selfheal_timeout",
            releaseRequestId: row.release_request_id,
          },
          { query, tx, now, logger: log },
        );
        // 批1b F2(R2-1)+R3-1:按 cancel webhook 的 release 裁决收口 release request 行(仍活跃时)。
        //   cancelled/not_found[200] → 个人版不会再部署该 release → CAS 请求置 cancelled;
        //   idempotent[200] → job 已在个人版终态(deployed/deploy_failed/deploy_unknown/cancelled…):
        //     该行的归宿由它**自己的终态回调**决定(outbox 必然已有一条),这里不 CAS——否则会把
        //     "已部署但回调在途"的行错标 cancelled,再靠 receipt-胜-cancel 兜底自愈,徒增撕裂窗口;
        //   too_late[200](个人版已 pre-claim 部署)→ 不动,交 receipt(deployed/deploy_failed)裁决,
        //     repair 在 cancel 途中被 deployed receipt 收口到 verifying(selfhealRepairs.ts R2-1②);
        //   repair_mismatch[409] → 契约校验失败(rrid 不属于该 repair),不收口,仅在下方 !del.ok 分支告警。
        if (
          row.release_request_id &&
          (del.releaseCancel === "cancelled" || del.releaseCancel === "not_found")
        ) {
          const rrid = row.release_request_id;
          const finalized = await tx(async (client: PoolClient) => {
            const cas = await client.query(
              `UPDATE selfheal_release_requests
                  SET status='cancelled', updated_at=NOW(), resolved_at=NOW(), resolved_by='selfheal_cancel'
                WHERE release_request_id=$1 AND status IN ('queued','accepted')`,
              [rrid],
            );
            if ((cas.rowCount ?? 0) === 0) return false;
            await appendReleaseEvent(client, row.id, "note",
              `cancel webhook 裁决=${del.releaseCancel},release request 置 cancelled`, rrid, "cancelled");
            return true;
          });
          if (finalized) out.releaseCancelled++;
        }
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
          // 失联/失败(含 409 repair_mismatch):fail-closed,不释放槽(旧 root 进程可能仍跑),下轮再试。
          // releaseCancel 一并记录:repair_mismatch = 契约校验失败(rrid↔repair 绑定不符),需人工核查。
          log.warn("selfheal_cancel_delivery_failed", {
            repairId: row.id, httpStatus: del.httpStatus, releaseCancel: del.releaseCancel,
          });
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
      // 派单优先级(P4):critical(及等待>2h 的 warning 提级)先派,同级按最老。
      // 保留"顺序尝试所有候选"不 LIMIT——熔断/冷却挡住的候选不能挡住后续事故。
      const cand = await query<{ id: string }>(
        `SELECT i.id::text AS id
           FROM incidents i JOIN incident_policies p ON p.id = i.policy_id
          WHERE i.status IN ('open','repairing')
            AND p.auto_repair = TRUE AND p.enabled = TRUE
          ORDER BY
            CASE
              WHEN i.severity = 'critical'
                OR (i.severity = 'warning' AND i.opened_at < NOW() - INTERVAL '2 hours') THEN 0
              WHEN i.severity = 'warning' THEN 1
              ELSE 2
            END,
            i.opened_at ASC, i.id ASC`,
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

  // ⑥ release delivery(批1b,§6.2):fuse 未 engaged 时交付 due queued 请求。
  //    dormant:无 queued 请求即零行为(release request 表仅在 boss 放行后有行)。
  try {
    const MAX_PER_TICK = 10;
    for (let i = 0; i < MAX_PER_TICK; i++) {
        // 原子认领 + 租约推进(指数退避 cap 10min):并发/重叠 tick SKIP LOCKED 不重复交付。
        // Fuse predicate lives in the SAME statement snapshot as the claim;
        // an earlier SELECT followed by UPDATE could claim after a concurrent
        // deploy_unknown had already engaged the global gate.
        // 注:SET 里的 next_delivery_at 表达式引用 delivery_attempts 的**旧值**(PG 语义),
        // RETURNING 返回自增后的新值。
        const claim = await query<{
          id: string; release_request_id: string; repair_id: string; incident_id: string;
          approved_sha: string; base_sha: string | null; deploy_plan_hash: string | null;
          manifest_hash: string | null; delivery_attempts: number;
        }>(
          `UPDATE selfheal_release_requests
              SET delivery_attempts = delivery_attempts + 1,
                  next_delivery_at = NOW() + make_interval(secs =>
                    LEAST(600::double precision, 30 * power(2, LEAST(delivery_attempts, 20)))),
                  updated_at = NOW()
            WHERE id = (
              SELECT id FROM selfheal_release_requests
               WHERE status = 'queued' AND next_delivery_at <= NOW()
                 AND NOT EXISTS (
                   SELECT 1 FROM selfheal_release_fuse_epochs
                    WHERE cleared_at IS NULL
                 )
               ORDER BY next_delivery_at ASC, id ASC
               LIMIT 1 FOR UPDATE SKIP LOCKED
            )
              AND NOT EXISTS (
                SELECT 1 FROM selfheal_release_fuse_epochs
                 WHERE cleared_at IS NULL
              )
            RETURNING id::text AS id, release_request_id, repair_id::text AS repair_id,
                      incident_id::text AS incident_id, approved_sha, base_sha,
                      deploy_plan_hash, manifest_hash, delivery_attempts`,
        );
        const rr = claim.rows[0];
        if (!rr) break;
        try {
          const del = await postReleaseDelivery(
            {
              repairId: rr.repair_id,
              incidentId: rr.incident_id,
              releaseRequestId: rr.release_request_id,
              approvedSha: rr.approved_sha,
              baseSha: rr.base_sha,
              deployPlanHash: rr.deploy_plan_hash,
              manifestHash: rr.manifest_hash,
            },
            { query, tx, now, logger: log },
          );
          if (del.outcome === "accepted") {
            const done = await tx(async (client: PoolClient) => {
              const cas = await client.query(
                `UPDATE selfheal_release_requests
                    SET status='accepted', delivered_at=NOW(), updated_at=NOW()
                  WHERE id=$1::bigint AND status='queued'`,
                [rr.id],
              );
              if ((cas.rowCount ?? 0) === 0) return false;
              await appendReleaseEvent(client, rr.repair_id, "note",
                "release 已交付个人版(202 accepted),等待部署", rr.release_request_id, "accepted");
              return true;
            });
            if (done) out.releaseDelivered++;
          } else if (del.outcome === "authority_mismatch") {
            const done = await tx(async (client: PoolClient) => {
              const cas = await client.query(
                `UPDATE selfheal_release_requests
                    SET status='manual_required', failure_reason=$2, updated_at=NOW(), resolved_at=NOW()
                  WHERE id=$1::bigint AND status='queued'`,
                [rr.id, del.reason ?? "authority_mismatch"],
              );
              if ((cas.rowCount ?? 0) === 0) return false;
              await appendReleaseEvent(client, rr.repair_id, "note",
                `release 交付被个人版权威复核拒(${del.reason ?? "authority_mismatch"}),转人工`,
                rr.release_request_id, "manual_required");
              return true;
            });
            if (done) {
              out.releaseManualRequired++;
              alertReleaseManual(enqueue, rr.incident_id, rr.repair_id, rr.release_request_id, del.reason);
            }
          } else if (del.outcome === "retry" && Number(rr.delivery_attempts) > 24) {
            // fuse_engaged / retry:保持 queued(已租约退避);仅长时重投失败告警,继续重试。
            alertReleaseStalled(enqueue, rr.incident_id, rr.repair_id, rr.release_request_id,
              `delivery_retry_${rr.delivery_attempts}`);
          }
        } catch (err) {
          out.errors++;
          log.warn("selfheal_release_delivery_failed",
            { releaseRequestId: rr.release_request_id, err: (err as Error)?.message });
        }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_release_delivery_scan_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ⑦ release watch(批1b,§6.2):accepted>30min 无 deploying / deploying>120min 无终态 →
  //    **只告警不改状态**(个人版是执行权威)。alert outbox 按 dedupe_key 去重,不每 tick 轰炸。
  try {
    const stalled = await query<{
      release_request_id: string; repair_id: string; incident_id: string; stage: string;
    }>(
      `SELECT release_request_id, repair_id::text AS repair_id, incident_id::text AS incident_id,
              CASE WHEN status='accepted' THEN 'accepted_no_deploying' ELSE 'deploying_no_terminal' END AS stage
         FROM selfheal_release_requests
        WHERE (status='accepted'  AND updated_at < NOW() - INTERVAL '30 minutes')
           OR (status='deploying' AND updated_at < NOW() - INTERVAL '120 minutes')`,
    );
    for (const s of stalled.rows) {
      alertReleaseStalled(enqueue, s.incident_id, s.repair_id, s.release_request_id, s.stage);
      out.releaseWatchAlerts++;
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_release_watch_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ⑧ 熔断双侧收敛(批1b,§6.2):每个 v5 epoch 已清且个人版未 ack → 投递 exact
  //    fuse-clear。不能扫 singleton:清 A 会立刻把 singleton 投影到仍 engaged 的 B,
  //    但 A 的个人版 clear obligation 仍必须独立完成。
  try {
    const epochs = await query<{
      reason: string | null;
      clear_reason: string | null;
      cleared_by: string | null;
      release_request_id: string;
      cleared_at: Date;
    }>(
      `SELECT reason, clear_reason, cleared_by, release_request_id, cleared_at
         FROM selfheal_release_fuse_epochs
        WHERE cleared_at IS NOT NULL AND personal_ack_at IS NULL
        ORDER BY cleared_at ASC, release_request_id ASC
        LIMIT 10`,
    );
    for (const epoch of epochs.rows) {
      const del = await postFuseClear(
        {
          reason: epoch.clear_reason ?? epoch.reason ?? "fuse cleared by admin",
          clearedBy: epoch.cleared_by ?? "admin",
          expectedReleaseRequestId: epoch.release_request_id,
        },
        { query, tx, now, logger: log },
      );
      if (del.ok) {
        const converged = await tx(async (client: PoolClient) => {
          // Global lock order is singleton → epoch (callbacks, admin clear and
          // the rolling-upgrade triggers use the same order).
          await client.query(`SELECT 1 FROM selfheal_release_fuse WHERE id = 1 FOR UPDATE`);
          const cas = await client.query(
            `UPDATE selfheal_release_fuse_epochs SET personal_ack_at = NOW()
              WHERE release_request_id = $1 AND cleared_at IS NOT NULL
                AND personal_ack_at IS NULL`,
            [epoch.release_request_id],
          );
          if ((cas.rowCount ?? 0) === 0) return false;
          // Keep the singleton's legacy/UI ack field coherent only when it is
          // still projecting this cleared epoch. Epoch ledger remains authority.
          await client.query(
            `UPDATE selfheal_release_fuse SET personal_ack_at = NOW()
              WHERE id = 1 AND engaged = FALSE AND release_request_id = $1`,
            [epoch.release_request_id],
          );
          return true;
        });
        if (converged) out.fuseConverged++;
      }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_fuse_converge_failed", { err: (err as Error)?.message ?? String(err) });
  }

  // ⑨ 熔断 engaged → durable critical 告警(F13①)。callback 端 uncertainty 只在同事务落
  //    critical repair 事件(不做非事务 enqueue);此处把它接上 sweeper 既有告警出口(alert outbox)。
  //    dedupe 以本次 engagement(release_request_id / engaged_at)为界,每次 engage 至多告警一次
  //    (fuse 保持 engaged 直到人工清;沿用 dispatcher 保险丝"outbox 已有该 dedupe_key 即永久跳过")。
  try {
    const fe = await query<{ reason: string | null; release_request_id: string | null; engaged_at: Date | null }>(
      `SELECT reason, release_request_id, engaged_at FROM selfheal_release_fuse
        WHERE id = 1 AND engaged = TRUE`,
    );
    const frow = fe.rows[0];
    if (frow) {
      const disc = frow.release_request_id ?? (frow.engaged_at ? String(frow.engaged_at.getTime()) : "engaged");
      const dedupe = `${OPS_REPAIR_FAILED}:release_fuse_engaged:${disc}`;
      const already = await query<{ one: number }>(
        `SELECT 1 AS one FROM admin_alert_outbox WHERE event_type = $1 AND dedupe_key = $2 LIMIT 1`,
        [OPS_REPAIR_FAILED, dedupe],
      );
      if (already.rows.length === 0) {
        enqueue({
          event_type: OPS_REPAIR_FAILED,
          severity: "critical",
          title: "自愈 Tier2 release uncertainty 熔断已拉起，禁自动部署待人工裁决",
          body:
            `release=\`${frow.release_request_id ?? "-"}\` 已因部署/canonical 收敛不确定 engage 全局 Tier2 部署熔断` +
            `(${frow.reason ?? ""});请人工按 /version·deploy_state·远端 ref 裁决后走 fuse-clear 审计流。`,
          payload: { release_request_id: frow.release_request_id, reason: frow.reason, kind: "release_fuse_engaged" },
          dedupe_key: dedupe,
        });
        out.fuseAlerts++;
      }
    }
  } catch (err) {
    out.errors++;
    log.warn("selfheal_fuse_alert_failed", { err: (err as Error)?.message ?? String(err) });
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

/**
 * 批1b:追加 release 生命周期事件(detail 必带 releaseRequestId+releasePhase,供
 * getReleaseRequest 关联查询 detail->>'releaseRequestId'=rrid)。kind 走 'note'(CHECK 合法)。
 */
async function appendReleaseEvent(
  client: PoolClient,
  repairId: string,
  kind: string,
  message: string,
  releaseRequestId: string,
  releasePhase: string,
): Promise<void> {
  await client.query(
    `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
     VALUES ($1::bigint, $2, $3, $4::jsonb)`,
    [repairId, kind, message.slice(0, 4000), JSON.stringify({ releaseRequestId, releasePhase })],
  );
}

/** 批1b:交付被个人版权威复核拒 → manual_required(critical 告警,人工介入)。 */
function alertReleaseManual(
  enqueue: (e: AlertEventInput) => void,
  incidentId: string,
  repairId: string,
  rrid: string,
  reason?: string,
): void {
  enqueue({
    event_type: OPS_REPAIR_FAILED,
    severity: "critical",
    title: "自愈放行被个人版权威复核拒,转人工",
    body:
      `incident=\`${incidentId}\` repair=\`${repairId}\` release=\`${rrid}\` 交付被个人版权威复核拒` +
      `(${reason ?? "authority_mismatch"}),已置 manual_required,请人工复核放行。`,
    payload: { incident_id: incidentId, repair_id: repairId, release_request_id: rrid, reason: reason ?? null },
    dedupe_key: `${OPS_REPAIR_FAILED}:release_manual:${rrid}`,
  });
}

/** 批1b:release 交付/部署停滞(watch 步 / 长时重投失败)告警(outbox 按 dedupe_key 去重)。 */
function alertReleaseStalled(
  enqueue: (e: AlertEventInput) => void,
  incidentId: string,
  repairId: string,
  rrid: string,
  stage: string,
): void {
  enqueue({
    event_type: OPS_REPAIR_TIMEOUT,
    severity: "critical",
    title: "自愈放行/部署停滞,待人工复核",
    body:
      `incident=\`${incidentId}\` repair=\`${repairId}\` release=\`${rrid}\` 阶段=\`${stage}\` 长时无进展,` +
      `请人工核对个人版 release worker / deploy 状态。`,
    payload: { incident_id: incidentId, repair_id: repairId, release_request_id: rrid, stage },
    dedupe_key: `${OPS_REPAIR_TIMEOUT}:release_stalled:${rrid}:${stage}`,
  });
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
