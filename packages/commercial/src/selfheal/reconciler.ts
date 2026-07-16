/**
 * v5 自愈体系切片① — incidentReconciler:alert_conditions 当前值 → incidents 投影。
 *
 * **level-triggered 对账**(RFC 核心正确性):每 tick 读 condition 当前值,不依赖翻转沿。
 *   - condition firing=true 且 policy 命中且无活跃 incident → openIncident(materialize 文案)。
 *   - 活跃 incident 的 condition firing=false → resolveIncident(source='probe')。
 *     即使 monitor state 文件丢失、恢复沿丢失,下轮 condition 当前值仍驱动 resolve(根治"永不 resolve")。
 *   - condition.level 变(desired severity 变)且 incident open → updateIncident + rev++。
 *
 * manual resolve_mode 的 incident 同样"靠 condition 被关"才 resolve(admin/codex CAS 关 condition
 * → 下轮 reconciler 据 condition firing=false resolve),reconciler 不区分 mode(投影是单向的)。
 *
 * v5-owned gate(index.ts:runtimeChannel==='v5';**不是** controlPlaneEnabled——v5 是 follower
 * 会真空,RFC 已论证)。单实例运行;openIncident ON CONFLICT + resolveIncident CAS 兜并发。
 */

import type { PoolClient } from "pg";
import { query as _query, tx as _tx } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { safeEnqueueAlert as _safeEnqueueAlert } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";
import { coerceConditionLevel } from "./conditions.js";
import { matchPolicy as _matchPolicy, type IncidentPolicy } from "./policy.js";
import {
  openIncident,
  updateIncident,
  resolveIncident,
  resolveIncidentByProbe,
  maxSeverity,
  type IncidentSeverity,
} from "./incidents.js";

const DEFAULT_INTERVAL_MS = 10_000;

interface ConditionRow {
  condition_key: string;
  firing: boolean;
  level: string | null;
  snapshot: unknown;
  /** H1b suppression:operator 压制投影(fake query 缺省 undefined → falsy,向后兼容)。 */
  suppressed?: boolean;
}
interface ActiveIncidentRow {
  id: string;
  condition_key: string;
  severity: IncidentSeverity;
  audience: string;
}

export interface ReconcileDeps {
  query?: typeof _query;
  tx?: typeof _tx;
  matchPolicy?: (conditionKey: string) => Promise<IncidentPolicy | null>;
  safeEnqueueAlert?: typeof _safeEnqueueAlert;
  logger?: Logger;
}

export interface ReconcileResult {
  opened: string[];
  updated: string[];
  resolved: string[];
  errors: Array<{ key: string; err: string }>;
}

function parseSnapshot(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function opsBody(kind: string, conditionKey: string, policy: IncidentPolicy, severity: string): string {
  const hint = policy.repairHint ? `\n\n运维定位:${policy.repairHint}` : "";
  return `[自愈事故·${kind}] ${policy.userTitle}\n\ncondition=\`${conditionKey}\` surface=${policy.surface} severity=${severity}${hint}`;
}

/**
 * 单次对账。幂等、可重复调用。返回本轮 opened/updated/resolved(用于测试断言与日志)。
 */
export async function reconcileOnce(deps: ReconcileDeps = {}): Promise<ReconcileResult> {
  const query = deps.query ?? _query;
  const tx = deps.tx ?? _tx;
  const matchPolicy = deps.matchPolicy ?? _matchPolicy;
  const enqueue = deps.safeEnqueueAlert ?? _safeEnqueueAlert;
  const result: ReconcileResult = { opened: [], updated: [], resolved: [], errors: [] };

  const condsR = await query<ConditionRow>(
    `SELECT rule_id AS condition_key, firing, level, snapshot,
            COALESCE(suppressed_until_clear, FALSE) AS suppressed
       FROM admin_alert_rule_state`,
  );
  const conditionsByKey = new Map<string, ConditionRow>();
  for (const c of condsR.rows) conditionsByKey.set(c.condition_key, c);

  const activeR = await query<ActiveIncidentRow>(
    `SELECT id::text AS id, condition_key, severity, audience
       FROM incidents WHERE status <> 'resolved'`,
  );
  const activeByKey = new Map<string, ActiveIncidentRow>();
  for (const a of activeR.rows) activeByKey.set(a.condition_key, a);

  // 1) firing 的 condition → open / update。
  //    suppressed(H1b)不投影:operator 已知悉,压制直到 condition 真实恢复
  //    (write_alert_condition 在 true→false 翻转时自动清 suppression)。
  for (const c of condsR.rows) {
    if (!c.firing || c.suppressed) continue;
    let policy: IncidentPolicy | null;
    try {
      policy = await matchPolicy(c.condition_key);
    } catch (err) {
      result.errors.push({ key: c.condition_key, err: (err as Error)?.message ?? String(err) });
      continue;
    }
    if (!policy) continue; // 非用户可感,不进 incident
    const desired = maxSeverity(coerceConditionLevel(c.level), policy.severityFloor);
    const snapshot = parseSnapshot(c.snapshot);
    const existing = activeByKey.get(c.condition_key);
    try {
      if (!existing) {
        const r = await tx((client: PoolClient) =>
          openIncident(
            c.condition_key,
            policy!,
            { severity: desired, opsDetail: policy!.repairHint, snapshot },
            client,
          ),
        );
        if (r.created) {
          result.opened.push(c.condition_key);
          enqueue({
            event_type: EVENTS.OPS_INCIDENT_OPENED,
            severity: desired,
            title: `自愈事故打开:${policy.userTitle}`,
            body: opsBody("打开", c.condition_key, policy, desired),
            payload: { incident_id: r.incidentId, condition_key: c.condition_key, surface: policy.surface },
            dedupe_key: `${EVENTS.OPS_INCIDENT_OPENED}:${r.incidentId}`,
          });
        }
      } else if (existing.severity !== desired) {
        const r = await tx((client: PoolClient) =>
          updateIncident(
            existing.id,
            {
              severity: desired,
              userTitle: policy!.userTitle,
              userMessage: policy!.userMessage,
              opsDetail: policy!.repairHint,
            },
            client,
          ),
        );
        if (r.updated) result.updated.push(c.condition_key);
      }
    } catch (err) {
      result.errors.push({ key: c.condition_key, err: (err as Error)?.message ?? String(err) });
    }
  }

  // 2) 活跃 incident 的 condition **存在且显式 firing=false** → resolve(level-triggered)。
  //    condition 行**缺失**视为 unknown/stale(行被删 / 检测器空档),**不** resolve——
  //    在"缺失即恢复"下会发假恢复通知、把仍在异常的事故错误关闭(Codex H1)。宁可留 open。
  //    suppressed+firing(H1b)的遗留 open incident 同样 resolve(source='admin',幂等兜底:
  //    主路径是 adminResolveIncident 同事务 suppress+resolve,这里兜崩溃/竞态残留)。
  for (const inc of activeR.rows) {
    const cond = conditionsByKey.get(inc.condition_key);
    if (!cond) continue; // 缺失 = unknown,保持 open,不发假恢复
    const suppressed = Boolean(cond.suppressed);
    if (cond.firing === true && !suppressed) continue;
    const bySuppression = cond.firing === true && suppressed;
    try {
      // probe 收口走 verifying 守卫版:codex 归因窗口内不抢 resolve(归因
      // 让位给 sweeper 的 succeeded+codex 同事务收口);suppression 收口保持
      // 无守卫(admin 裁定必须能压过 verifying)。
      const r = await tx((client: PoolClient) =>
        bySuppression
          ? resolveIncident(inc.id, "admin", client)
          : resolveIncidentByProbe(inc.id, client),
      );
      if (r.resolved) {
        result.resolved.push(inc.condition_key);
        // 恢复通报文案从 policy 取(可能已随 condition 消失,尽力从缓存/表拿;拿不到则用通用文案)。
        let policy: IncidentPolicy | null = null;
        try {
          policy = await matchPolicy(inc.condition_key);
        } catch { /* 通报降级用通用文案 */ }
        enqueue(
          bySuppression
            ? {
                // 压制关闭 ≠ 恢复:据实通报,绝不发"已恢复"假话(condition 仍 firing)。
                event_type: EVENTS.OPS_INCIDENT_RESOLVED,
                severity: "info",
                title: `自愈事故已压制关闭:${policy?.userTitle ?? inc.condition_key}`,
                body: `[自愈事故·压制] condition=\`${inc.condition_key}\` 仍 firing,已被管理员压制(suppressed_until_clear),incident 关闭;condition 真实恢复后压制自动解除。`,
                payload: { incident_id: inc.id, condition_key: inc.condition_key, suppressed: true },
                dedupe_key: `${EVENTS.OPS_INCIDENT_RESOLVED}:${inc.id}`,
              }
            : {
                event_type: EVENTS.OPS_INCIDENT_RESOLVED,
                severity: "info",
                title: `自愈事故恢复:${policy?.userTitle ?? inc.condition_key}`,
                body: policy
                  ? opsBody("恢复", inc.condition_key, policy, "info")
                  : `[自愈事故·恢复] condition=\`${inc.condition_key}\` 已恢复。`,
                payload: { incident_id: inc.id, condition_key: inc.condition_key },
                dedupe_key: `${EVENTS.OPS_INCIDENT_RESOLVED}:${inc.id}`,
              },
        );
      }
    } catch (err) {
      result.errors.push({ key: inc.condition_key, err: (err as Error)?.message ?? String(err) });
    }
  }

  return result;
}

// ─── scheduler(照 providerHealthScheduler 模式:setInterval + unref + inflight 保护)──

export interface IncidentReconcilerHandle {
  stop(): Promise<void>;
  runNow(): Promise<ReconcileResult>;
}

export function startIncidentReconciler(
  opts: { intervalMs?: number; runOnStart?: boolean; _deps?: ReconcileDeps } = {},
): IncidentReconcilerHandle {
  const interval = Math.max(2_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const log = opts._deps?.logger ?? rootLogger.child({ subsys: "selfheal", module: "reconciler" });
  let stopped = false;
  let inflight: Promise<ReconcileResult> | null = null;

  async function tick(): Promise<ReconcileResult> {
    if (inflight) return inflight;
    inflight = reconcileOnce({ ...opts._deps, logger: log })
      .then((r) => {
        if (r.opened.length || r.resolved.length || r.updated.length || r.errors.length) {
          log.info("selfheal_reconcile", {
            opened: r.opened.length,
            updated: r.updated.length,
            resolved: r.resolved.length,
            errors: r.errors.length,
          });
        }
        for (const e of r.errors) log.warn("selfheal_reconcile_error", { key: e.key, err: e.err });
        return r;
      })
      .catch((err) => {
        log.warn("selfheal_reconcile_tick_failed", { err: (err as Error)?.message ?? String(err) });
        return { opened: [], updated: [], resolved: [], errors: [] } as ReconcileResult;
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
