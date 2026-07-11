/**
 * v5 自愈体系切片① — incident 生命周期(open → repairing → resolved)。
 *
 * incident 是 alert_conditions 的**只读派生投影**:reconciler 单向据 condition 当前值
 * open/resolve/update。全部走 DB 级 CAS + 幂等键,重叠 tick / 崩溃重放安全。
 *
 * 每次 open/resolve/update 在**同事务**内 INSERT incident_deliveries(durable outbox),
 * sweeper 再 at-least-once 投递 WS/inbox。delivery 唯一键 (incident_id, incident_rev, channel)
 * 挡重复。open 时 materialize incident_recipients 快照(open/resolved 用同一批)。
 *
 * 审计账本永久保留(见 auditRetention PERMANENT_OPS_LEDGER_TABLES),不进 admin_audit 合规域。
 */

import type { PoolClient } from "pg";
import type { IncidentPolicy } from "./policy.js";

export type IncidentStatus = "open" | "repairing" | "resolved";
export type IncidentSeverity = "info" | "warning" | "critical";
export type ResolveSource = "probe" | "codex" | "admin" | "auto";
export type DeliveryPhase = "opened" | "updated" | "resolved";

const SEVERITY_RANK: Record<IncidentSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** 取两个 severity 的较高者(info < warning < critical)。 */
export function maxSeverity(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ─── delivery materialize(同事务)────────────────────────────────────

/**
 * 为一次 incident 状态变化写 durable delivery 行(同事务)。
 *   - 'ws' 通道:所有 audience 都建(sweeper 按 audience 分流 broadcastAll/ToUsers)。
 *   - 'inbox' 通道:**仅 audience='all'** 建。inbox 唯一键 (source_type,source_id,source_phase)
 *     天然是"每 incident-phase 一条广播公告",与 audience='all' 语义闭合;定向 audience
 *     (user_ids/surface_cohort)的 per-recipient inbox 兜底需 per-user delivery 模型,
 *     归 **切片②**(此处 ws 已覆盖在线用户)。
 * 唯一键 (incident_id, incident_rev, channel) ON CONFLICT DO NOTHING 挡重叠 tick 重复。
 */
async function insertDeliveries(
  client: PoolClient,
  incidentId: string,
  rev: number,
  phase: DeliveryPhase,
  audience: string,
): Promise<void> {
  const channels: string[] = ["ws"];
  if (audience === "all") channels.push("inbox");
  for (const channel of channels) {
    await client.query(
      `INSERT INTO incident_deliveries (incident_id, incident_rev, channel, phase, status)
       VALUES ($1::bigint, $2::bigint, $3, $4, 'pending')
       ON CONFLICT (incident_id, incident_rev, channel) DO NOTHING`,
      [incidentId, rev, channel, phase],
    );
  }
}

/**
 * open 时把收件人快照钉进 incident_recipients(open/resolved 复用同一批)。
 *   - audience='all'        → 不填(广播,sweeper 走 broadcastAll)。
 *   - audience='user_ids'   → 从 condition snapshot 的 user_id / user_ids 提取。
 *   - audience='surface_cohort' → 切片① 暂等同广播(不 materialize),留 TODO:
 *       接明确 usage SQL(固定 lookback)按 surface 归因在线用户(RFC M-recipients)。
 */
async function materializeRecipients(
  client: PoolClient,
  incidentId: string,
  policy: IncidentPolicy,
  snapshot: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (policy.audience !== "user_ids") {
    // 'all' 广播 / 'surface_cohort'(切片① TODO 见下)均不 materialize。
    // TODO 切片②: surface_cohort → 明确 usage SQL 归因 + 固定 lookback,materialize 定向快照。
    return;
  }
  const ids = extractUserIds(snapshot);
  for (const uid of ids) {
    await client.query(
      `INSERT INTO incident_recipients (incident_id, user_id)
       VALUES ($1::bigint, $2::bigint)
       ON CONFLICT (incident_id, user_id) DO NOTHING`,
      [incidentId, uid],
    );
  }
}

function extractUserIds(snapshot: Record<string, unknown> | null | undefined): string[] {
  if (!snapshot) return [];
  const out = new Set<string>();
  const single = snapshot.user_id;
  if (typeof single === "string" || typeof single === "number") out.add(String(single));
  const many = snapshot.user_ids;
  if (Array.isArray(many)) {
    for (const v of many) {
      if (typeof v === "string" || typeof v === "number") out.add(String(v));
    }
  }
  // 仅保留纯数字 id(防脏 snapshot 注入非法值,::bigint 会抛)。
  return [...out].filter((s) => /^[0-9]+$/.test(s));
}

// ─── open ────────────────────────────────────────────────────────────

export interface OpenIncidentInput {
  severity: IncidentSeverity;
  opsDetail: string | null;
  /** 触发该 incident 的 condition 快照(materialize user_ids 收件人用)。 */
  snapshot?: Record<string, unknown> | null;
}

export interface OpenIncidentResult {
  incidentId: string;
  /** true=本次新建(已 materialize 收件人+opened delivery);false=已存在活跃 incident(no-op)。 */
  created: boolean;
  rev: number;
  severity: IncidentSeverity;
}

/**
 * 打开 incident(幂等):INSERT ON CONFLICT(活跃唯一索引 ux_incidents_active_key)。
 * 同 condition_key 至多一条未 resolved。新建时同事务 materialize 收件人 + opened delivery。
 */
export async function openIncident(
  conditionKey: string,
  policy: IncidentPolicy,
  input: OpenIncidentInput,
  client: PoolClient,
): Promise<OpenIncidentResult> {
  const ins = await client.query<{ id: string; rev: string }>(
    `INSERT INTO incidents
       (dedupe_key, condition_key, policy_id, status, severity, surface, audience,
        user_title, user_message, ops_detail)
     VALUES ($1, $1, $2::bigint, 'open', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
       DO NOTHING
     RETURNING id::text AS id, rev::text AS rev`,
    [
      conditionKey,
      policy.id,
      input.severity,
      policy.surface,
      policy.audience,
      policy.userTitle,
      policy.userMessage,
      input.opsDetail,
    ],
  );

  if (ins.rows.length > 0) {
    const row = ins.rows[0];
    const rev = Number(row.rev);
    await materializeRecipients(client, row.id, policy, input.snapshot);
    await insertDeliveries(client, row.id, rev, "opened", policy.audience);
    return { incidentId: row.id, created: true, rev, severity: input.severity };
  }

  // 已存在活跃 incident → no-op,回读现值。
  const cur = await client.query<{ id: string; rev: string; severity: IncidentSeverity }>(
    `SELECT id::text AS id, rev::text AS rev, severity
       FROM incidents WHERE dedupe_key = $1 AND status <> 'resolved'
      LIMIT 1`,
    [conditionKey],
  );
  const row = cur.rows[0];
  return {
    incidentId: row.id,
    created: false,
    rev: Number(row.rev),
    severity: row.severity,
  };
}

// ─── update(severity/文案变化 → rev++)────────────────────────────────

export interface UpdateIncidentResult {
  updated: boolean;
  rev: number;
}

/**
 * bump incident rev(condition.level 变导致 severity/文案变化时)。CAS WHERE status<>'resolved'。
 * 同事务写 updated delivery。
 */
export async function updateIncident(
  incidentId: string,
  fields: { severity: IncidentSeverity; userTitle: string; userMessage: string; opsDetail: string | null },
  audience: string,
  client: PoolClient,
): Promise<UpdateIncidentResult> {
  const r = await client.query<{ rev: string }>(
    `UPDATE incidents
        SET severity = $2, user_title = $3, user_message = $4, ops_detail = $5,
            rev = rev + 1, updated_at = NOW()
      WHERE id = $1::bigint AND status <> 'resolved'
      RETURNING rev::text AS rev`,
    [incidentId, fields.severity, fields.userTitle, fields.userMessage, fields.opsDetail],
  );
  if (r.rows.length === 0) return { updated: false, rev: 0 };
  const rev = Number(r.rows[0].rev);
  await insertDeliveries(client, incidentId, rev, "updated", audience);
  return { updated: true, rev };
}

// ─── resolve ─────────────────────────────────────────────────────────

export interface ResolveIncidentResult {
  resolved: boolean;
  rev: number;
}

/**
 * resolve incident(CAS:WHERE status<>'resolved',幂等)。rev++、置 resolved_at/resolve_source。
 * 同事务写 resolved delivery(供 sweeper 推恢复通知)。
 */
export async function resolveIncident(
  incidentId: string,
  source: ResolveSource,
  client: PoolClient,
): Promise<ResolveIncidentResult> {
  const r = await client.query<{ rev: string; audience: string }>(
    `UPDATE incidents
        SET status = 'resolved', resolved_at = NOW(), resolve_source = $2,
            rev = rev + 1, updated_at = NOW()
      WHERE id = $1::bigint AND status <> 'resolved'
      RETURNING rev::text AS rev, audience`,
    [incidentId, source],
  );
  if (r.rows.length === 0) return { resolved: false, rev: 0 };
  const rev = Number(r.rows[0].rev);
  await insertDeliveries(client, incidentId, rev, "resolved", r.rows[0].audience);
  return { resolved: true, rev };
}
