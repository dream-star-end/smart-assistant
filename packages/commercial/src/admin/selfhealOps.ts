/**
 * v5 自愈体系切片① — admin 修复审计后端(读列表 / 详情 / 手动 resolve)。
 *
 * incident/repair 是永久 ops-ledger(见 auditRetention PERMANENT_OPS_LEDGER_TABLES)。
 * 本模块只读展示(keyset 分页)+ admin 手动 resolve;detail 经 redactOpsPayload 脱敏
 * (M4:key 级 + 值级字符串清洗),绝不原样吐任意 JSON(RFC [解 M9])。
 *
 * 手动 resolve 语义(收尾批 H1b,mode-aware 判定表;以 condition.mode 为准,
 * policy.resolve_mode 不参与分支——mode 是"能否被探测推翻"的检测权威属性):
 *   | condition 状态              | 动作                                        | resolution |
 *   |----------------------------|---------------------------------------------|------------|
 *   | 存在且 firing,mode='probe' | suppressCondition(operator 列)+ resolve   | suppressed_until_clear |
 *   | 存在且 firing,latched/spike| writeCondition(firing=false) 关 + resolve   | condition_closed |
 *   | 不存在或已 !firing          | 仅 resolve                                   | condition_already_clear |
 * 理由:probe 类 condition 把 firing 改 false 是"说谎",≤2min 内会被下一轮真实观测
 * 推翻 → incident 重开 → resolve 风暴(H1b 根因)。suppression 压制投影不篡改检测
 * 权威,condition 真实恢复(true→false 翻转)时 write_alert_condition 自动清压制。
 * 全部同事务 + writeAdminAudit(mode='tx' fail-closed:审计失败回滚)。
 *
 * 收尾批新增:
 *   - listConditions(suppressed 过滤)/ adminUnsuppressCondition(误压回滚,audit tx)。
 *   - adminReleaseRepair:boss 一键放行 pending_release 的 Tier2 部署 →
 *     repairDispatcher.postRelease 经隧道通知个人版(见该函数头契约)。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { redactOpsPayload } from "../selfheal/redact.js";
import { writeAdminAudit } from "./audit.js";
import {
  writeCondition,
  suppressCondition,
  unsuppressCondition,
} from "../selfheal/conditions.js";
import { resolveIncident } from "../selfheal/incidents.js";
import { postRelease as _postRelease } from "../selfheal/repairDispatcher.js";

export const INCIDENTS_DEFAULT_LIMIT = 50;
export const INCIDENTS_MAX_LIMIT = 200;

const ID_RE = /^[1-9][0-9]{0,19}$/;
const STATUS_VALUES = ["open", "repairing", "resolved"] as const;
export type ListStatus = (typeof STATUS_VALUES)[number];

export interface IncidentRowView {
  id: string;
  dedupe_key: string;
  condition_key: string;
  policy_id: string | null;
  status: string;
  severity: string;
  surface: string;
  audience: string;
  user_title: string;
  user_message: string;
  ops_detail: string | null;
  rev: string;
  resolve_source: string | null;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface IncidentRow {
  id: string;
  dedupe_key: string;
  condition_key: string;
  policy_id: string | null;
  status: string;
  severity: string;
  surface: string;
  audience: string;
  user_title: string;
  user_message: string;
  ops_detail: string | null;
  rev: string;
  resolve_source: string | null;
  opened_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

function serialize(r: IncidentRow): IncidentRowView {
  return {
    id: r.id,
    dedupe_key: r.dedupe_key,
    condition_key: r.condition_key,
    policy_id: r.policy_id,
    status: r.status,
    severity: r.severity,
    surface: r.surface,
    audience: r.audience,
    user_title: r.user_title,
    user_message: r.user_message,
    ops_detail: r.ops_detail,
    rev: r.rev,
    resolve_source: r.resolve_source,
    opened_at: r.opened_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    resolved_at: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

export interface ListIncidentsInput {
  status?: string;
  before?: string; // keyset:id < before
  limit?: number;
}

export async function listIncidents(
  input: ListIncidentsInput,
): Promise<{ rows: IncidentRowView[]; next_before: string | null }> {
  let limit = input.limit ?? INCIDENTS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = INCIDENTS_DEFAULT_LIMIT;
  if (limit > INCIDENTS_MAX_LIMIT) limit = INCIDENTS_MAX_LIMIT;

  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    if (!(STATUS_VALUES as readonly string[]).includes(input.status)) {
      throw new RangeError("invalid status");
    }
    params.push(input.status);
    where.push(`status = $${params.length}`);
  }
  if (input.before !== undefined) {
    if (!ID_RE.test(input.before)) throw new RangeError("invalid before");
    params.push(input.before);
    where.push(`id < $${params.length}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  const r = await query<IncidentRow>(
    // qualify ORDER BY(SELECT 有 id::text AS id,避免按 text 别名排)。
    `SELECT id::text AS id, dedupe_key, condition_key, policy_id::text AS policy_id,
            status, severity, surface, audience, user_title, user_message, ops_detail,
            rev::text AS rev, resolve_source, opened_at, updated_at, resolved_at
       FROM incidents
       ${whereClause}
      ORDER BY incidents.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.map(serialize);
  const next = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: next };
}

// ─── detail:incident + repairs + events(脱敏)──────────────────────

export interface RepairView {
  id: string;
  incident_id: string;
  status: string;
  attempt: number;
  tier: string;
  summary: string | null;
  detail: unknown; // 已脱敏
  fail_reason: string | null;
  verify_after: string | null;
  verify_deadline: string | null;
  dispatched_at: string | null;
  acked_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface RepairEventView {
  id: string;
  repair_id: string;
  kind: string;
  message: string;
  detail: unknown; // 已脱敏
  created_at: string;
}
export interface IncidentDetail {
  incident: IncidentRowView;
  repairs: RepairView[];
  events: RepairEventView[];
}

export async function getIncidentDetail(id: string): Promise<IncidentDetail | null> {
  if (!ID_RE.test(id)) throw new RangeError("invalid id");
  const incR = await query<IncidentRow>(
    `SELECT id::text AS id, dedupe_key, condition_key, policy_id::text AS policy_id,
            status, severity, surface, audience, user_title, user_message, ops_detail,
            rev::text AS rev, resolve_source, opened_at, updated_at, resolved_at
       FROM incidents WHERE id = $1::bigint`,
    [id],
  );
  if (incR.rows.length === 0) return null;

  const repR = await query<{
    id: string; incident_id: string; status: string; attempt: number; tier: string;
    summary: string | null; detail: unknown; fail_reason: string | null;
    verify_after: Date | null; verify_deadline: Date | null; dispatched_at: Date | null;
    acked_at: Date | null; finished_at: Date | null; created_at: Date; updated_at: Date;
  }>(
    `SELECT id::text AS id, incident_id::text AS incident_id, status, attempt, tier,
            summary, detail, fail_reason, verify_after, verify_deadline, dispatched_at,
            acked_at, finished_at, created_at, updated_at
       FROM codex_repairs WHERE incident_id = $1::bigint ORDER BY id DESC`,
    [id],
  );
  const repairs: RepairView[] = repR.rows.map((r) => ({
    id: r.id,
    incident_id: r.incident_id,
    status: r.status,
    attempt: Number(r.attempt),
    tier: r.tier,
    summary: r.summary,
    detail: redactOpsPayload(r.detail),
    fail_reason: r.fail_reason,
    verify_after: r.verify_after ? r.verify_after.toISOString() : null,
    verify_deadline: r.verify_deadline ? r.verify_deadline.toISOString() : null,
    dispatched_at: r.dispatched_at ? r.dispatched_at.toISOString() : null,
    acked_at: r.acked_at ? r.acked_at.toISOString() : null,
    finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  let events: RepairEventView[] = [];
  if (repairs.length > 0) {
    const evR = await query<{
      id: string; repair_id: string; kind: string; message: string;
      detail: unknown; created_at: Date;
    }>(
      `SELECT id::text AS id, repair_id::text AS repair_id, kind, message, detail, created_at
         FROM codex_repair_events
        WHERE repair_id = ANY($1::bigint[])
        ORDER BY id ASC`,
      [repairs.map((r) => r.id)],
    );
    events = evR.rows.map((e) => ({
      id: e.id,
      repair_id: e.repair_id,
      kind: e.kind,
      message: e.message,
      detail: redactOpsPayload(e.detail),
      created_at: e.created_at.toISOString(),
    }));
  }

  return { incident: serialize(incR.rows[0]), repairs, events };
}

// ─── admin 手动 resolve(tx:mode-aware 处置 condition + resolve + audit fail-closed)──

export type AdminResolveOutcome = "resolved" | "not_found" | "already_resolved";
/** 处置结果(H1b 判定表,见文件头);响应/审计双带,前端据此区分 toast 文案。 */
export type AdminResolveResolution =
  | "suppressed_until_clear"
  | "condition_closed"
  | "condition_already_clear";

export interface AdminResolveInput {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function adminResolveIncident(
  id: string,
  input: AdminResolveInput,
): Promise<{ outcome: AdminResolveOutcome; rev?: number; resolution?: AdminResolveResolution }> {
  if (!ID_RE.test(id)) throw new RangeError("invalid id");
  return tx(async (client: PoolClient) => {
    const cur = await client.query<{ condition_key: string; status: string }>(
      `SELECT condition_key, status FROM incidents WHERE id = $1::bigint FOR UPDATE`,
      [id],
    );
    if (cur.rows.length === 0) return { outcome: "not_found" as const };
    if (cur.rows[0].status === "resolved") return { outcome: "already_resolved" as const };
    const conditionKey = cur.rows[0].condition_key;

    // 1) mode-aware 处置 condition(判定表见文件头;condition 缺失/已 !firing → 仅 resolve)。
    const condR = await client.query<{ mode: string; level: string | null; snapshot: unknown; firing: boolean }>(
      `SELECT mode, level, snapshot, firing FROM admin_alert_rule_state WHERE rule_id = $1 FOR UPDATE`,
      [conditionKey],
    );
    let resolution: AdminResolveResolution = "condition_already_clear";
    if (condR.rows.length > 0 && condR.rows[0].firing) {
      const c = condR.rows[0];
      if (c.mode === "probe") {
        // probe:探测每轮重写 firing,writeCondition(false) 会被下轮真实观测推翻 →
        // 风暴。压制投影(operator 列),condition 真实恢复时函数自动清。
        await suppressCondition(conditionKey, String(input.adminId), client);
        resolution = "suppressed_until_clear";
      } else {
        // latched/spike:无周期探测重写,CAS 关 firing 是权威且稳定的处置。
        const snapshot =
          c.snapshot && typeof c.snapshot === "object" && !Array.isArray(c.snapshot)
            ? (c.snapshot as Record<string, unknown>)
            : null;
        await writeCondition(
          conditionKey,
          {
            mode: (c.mode as "probe" | "latched" | "spike") ?? "probe",
            firing: false,
            level: (c.level as "info" | "warning" | "critical") ?? "warning",
            snapshot,
            // observedAt 缺省 → PG NOW():以 PG 时钟为单一权威,免 node↔PG 时钟偏差
            // 触发 0134 乱序 no-op 守卫(admin 写被当旧观测丢弃)。
            observedAt: null,
          },
          client,
        );
        resolution = "condition_closed";
      }
    }

    // 2) resolve incident(source='admin';同事务把活跃修复推进 cancel_requested,见 incidents.ts)。
    const res = await resolveIncident(id, "admin", client);

    // 3) 审计 tx fail-closed(审计失败 → 整个 tx 回滚,resolve 不生效)。
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "incident.resolve",
      target: `incident:${id}`,
      after: { condition_key: conditionKey, resolve_source: "admin", rev: res.rev, resolution },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    return { outcome: "resolved" as const, rev: res.rev, resolution };
  });
}

// ─── conditions 视图 + unsuppress(H1b 运维面)────────────────────────

export interface ConditionRowView {
  condition_key: string;
  firing: boolean;
  mode: string;
  level: string | null;
  observed_at: string | null;
  occurrence_count: string;
  suppressed_until_clear: boolean;
  suppressed_at: string | null;
  suppressed_by: string | null;
}

const CONDITIONS_LIST_LIMIT = 500;

/** 列 condition 当前值(suppressedOnly=true 只列被压制的;admin「已压制」区块用)。 */
export async function listConditions(
  input: { suppressedOnly?: boolean } = {},
): Promise<{ rows: ConditionRowView[] }> {
  const where = input.suppressedOnly ? `WHERE COALESCE(suppressed_until_clear, FALSE)` : "";
  const r = await query<{
    condition_key: string; firing: boolean; mode: string; level: string | null;
    observed_at: Date | null; occurrence_count: string | null;
    suppressed_until_clear: boolean | null; suppressed_at: Date | null; suppressed_by: string | null;
  }>(
    `SELECT rule_id AS condition_key, firing, mode, level, observed_at,
            occurrence_count::text AS occurrence_count,
            suppressed_until_clear, suppressed_at, suppressed_by
       FROM admin_alert_rule_state
       ${where}
      ORDER BY rule_id ASC
      LIMIT ${CONDITIONS_LIST_LIMIT}`,
  );
  return {
    rows: r.rows.map((c) => ({
      condition_key: c.condition_key,
      firing: c.firing,
      mode: c.mode,
      level: c.level,
      observed_at: c.observed_at ? c.observed_at.toISOString() : null,
      occurrence_count: c.occurrence_count ?? "0",
      suppressed_until_clear: Boolean(c.suppressed_until_clear),
      suppressed_at: c.suppressed_at ? c.suppressed_at.toISOString() : null,
      suppressed_by: c.suppressed_by,
    })),
  };
}

export type UnsuppressOutcome = "unsuppressed" | "not_suppressed" | "not_found";

/**
 * 解除误压(audit tx fail-closed)。解除后下轮 reconciler 若 condition 仍 firing
 * 会重新 open incident——这正是"我压错了,恢复告警"的语义。
 */
export async function adminUnsuppressCondition(
  conditionKey: string,
  input: AdminResolveInput,
): Promise<{ outcome: UnsuppressOutcome }> {
  if (typeof conditionKey !== "string" || conditionKey.length === 0 || conditionKey.length > 512) {
    throw new RangeError("invalid conditionKey");
  }
  return tx(async (client: PoolClient) => {
    const outcome = await unsuppressCondition(conditionKey, client);
    if (outcome !== "unsuppressed") return { outcome };
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "condition.unsuppress",
      target: `condition:${conditionKey}`,
      after: { condition_key: conditionKey },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { outcome };
  });
}

// ─── repair 一键放行(§B:pending_release → 个人版 releaseApproved)────

export type ReleaseOutcome = "released" | "not_found" | "conflict" | "delivery_failed";

/**
 * pending_release 标记契约(跨仓,个人版 broker.notifyPendingRelease 同步):
 * 个人版在 Tier2 修复 verify 过、等待放行时上报
 * `POST .../progress { message, detail: { phase: 'pending_release', ... } }`,
 * 本端以 codex_repair_events(kind='progress' AND detail->>'phase'='pending_release')
 * 判定"待放行"。放行门:repair 当前 status='running' 且存在该事件。
 */
export async function adminReleaseRepair(
  repairId: string,
  input: AdminResolveInput,
): Promise<{ outcome: ReleaseOutcome; httpStatus?: number; reason?: string }> {
  if (!ID_RE.test(repairId)) throw new RangeError("invalid id");
  // 1) 放行门校验(读侧;个人版 releaseApproved 会再重验 pending_release 记录+ancestry)。
  const r = await query<{ id: string; incident_id: string; status: string; pending_release: boolean }>(
    `SELECT r.id::text AS id, r.incident_id::text AS incident_id, r.status,
            EXISTS (
              SELECT 1 FROM codex_repair_events e
               WHERE e.repair_id = r.id AND e.kind = 'progress'
                 AND e.detail->>'phase' = 'pending_release'
            ) AS pending_release
       FROM codex_repairs r WHERE r.id = $1::bigint`,
    [repairId],
  );
  const row = r.rows[0];
  if (!row) return { outcome: "not_found" };
  if (row.status !== "running" || !row.pending_release) {
    return {
      outcome: "conflict",
      reason: row.status !== "running" ? `repair is ${row.status}` : "no pending_release event",
    };
  }

  // 2) 经隧道通知个人版 releaseApproved(网络操作在事务外;失败 = durable 状态零变化,可重试)。
  const del = await _postRelease({ repairId: row.id, incidentId: row.incident_id });
  if (!del.ok) return { outcome: "delivery_failed", httpStatus: del.httpStatus };

  // 3) 成功后同事务:进度事件 + audit(tx fail-closed)。
  await tx(async (client: PoolClient) => {
    await client.query(
      `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
       VALUES ($1::bigint, 'note', $2, '{}'::jsonb)`,
      [repairId, "管理员一键放行,已通知个人版执行部署(release webhook 2xx)"],
    );
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "repair.release",
      target: `repair:${repairId}`,
      after: { repair_id: repairId, incident_id: row.incident_id },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  });
  return { outcome: "released", httpStatus: del.httpStatus };
}
