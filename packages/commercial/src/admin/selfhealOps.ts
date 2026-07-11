/**
 * v5 自愈体系切片① — admin 修复审计后端(读列表 / 详情 / 手动 resolve)。
 *
 * incident/repair 是永久 ops-ledger(见 auditRetention PERMANENT_OPS_LEDGER_TABLES)。
 * 本模块只读展示(keyset 分页)+ admin 手动 resolve;detail 经 redactSensitive 脱敏,
 * 绝不原样吐任意 JSON(RFC [解 M9])。
 *
 * 手动 resolve 语义(RFC B2-final):**admin resolve = CAS 关 condition + resolve incident**——
 * 只 resolve incident 而不关 condition 会被 reconciler 下轮据 condition 当前值立即重开。
 * 故同事务内 writeCondition(firing=false) + resolveIncident(source='admin') + writeAdminAudit
 * (mode='tx' fail-closed:审计失败回滚)。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { redactSensitive } from "./auditRedact.js";
import { writeAdminAudit } from "./audit.js";
import { writeCondition } from "../selfheal/conditions.js";
import { resolveIncident } from "../selfheal/incidents.js";

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
    detail: redactSensitive(r.detail),
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
      detail: redactSensitive(e.detail),
      created_at: e.created_at.toISOString(),
    }));
  }

  return { incident: serialize(incR.rows[0]), repairs, events };
}

// ─── admin 手动 resolve(tx:关 condition + resolve incident + audit fail-closed)──

export type AdminResolveOutcome = "resolved" | "not_found" | "already_resolved";

export interface AdminResolveInput {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function adminResolveIncident(
  id: string,
  input: AdminResolveInput,
): Promise<{ outcome: AdminResolveOutcome; rev?: number }> {
  if (!ID_RE.test(id)) throw new RangeError("invalid id");
  return tx(async (client: PoolClient) => {
    const cur = await client.query<{ condition_key: string; status: string }>(
      `SELECT condition_key, status FROM incidents WHERE id = $1::bigint FOR UPDATE`,
      [id],
    );
    if (cur.rows.length === 0) return { outcome: "not_found" as const };
    if (cur.rows[0].status === "resolved") return { outcome: "already_resolved" as const };
    const conditionKey = cur.rows[0].condition_key;

    // 1) 关 condition(CAS firing→false),防 reconciler 下轮据当前值重开。
    //    读当前 mode/level/snapshot 保持不变,只翻 firing。condition 缺失则跳过(incident 无源可关)。
    const condR = await client.query<{ mode: string; level: string | null; snapshot: unknown; firing: boolean }>(
      `SELECT mode, level, snapshot, firing FROM admin_alert_rule_state WHERE rule_id = $1 FOR UPDATE`,
      [conditionKey],
    );
    if (condR.rows.length > 0 && condR.rows[0].firing) {
      const c = condR.rows[0];
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
          observedAt: new Date(),
        },
        client,
      );
    }

    // 2) resolve incident(source='admin')。
    const res = await resolveIncident(id, "admin", client);

    // 3) 审计 tx fail-closed(审计失败 → 整个 tx 回滚,resolve 不生效)。
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "incident.resolve",
      target: `incident:${id}`,
      after: { condition_key: conditionKey, resolve_source: "admin", rev: res.rev },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    return { outcome: "resolved" as const, rev: res.rev };
  });
}
