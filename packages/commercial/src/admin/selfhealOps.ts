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
 *
 * 批1b 重写(放行→部署 durable async):
 *   - adminReleaseRepair:boss 一键放行 → 单事务锁 repair + 结构化校验最新
 *     pending_release 事件 + 熔断检查 + INSERT selfheal_release_requests(唯一活跃
 *     约束保证同 repair 至多一条 queued/accepted/deploying)+ 永久审计 →
 *     **202 + releaseRequestId**(不再同步等个人版部署)。交付/回调各自异步驱动
 *     (交付=sweeper delivery 步 postReleaseDelivery;回调分流=http/internal/selfhealRepairs)。
 *     **废除 detail.release_claimed 第二权威**:唯一活跃请求由关系约束保证。
 *   - getReleaseRequest / getReleaseFuse / clearReleaseFuse:admin 读接口 + 熔断收敛。
 *   - getIncidentDetail:每 repair 附 releaseRequests[](§6.3 前端契约)。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { redactOpsPayload, scrubSecretsInString } from "../selfheal/redact.js";
import { writeAdminAudit } from "./audit.js";
import {
  writeCondition,
  suppressCondition,
  unsuppressCondition,
} from "../selfheal/conditions.js";
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

/** M4:自由文本出口清洗(null 透传;值级凭据形状见 selfheal/redact.ts)。 */
function scrubText(s: string | null): string | null {
  return s === null ? null : scrubSecretsInString(s);
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
    // M4:ops_detail 出自探测器自由文本,可能夹带凭据 → 出口清洗(列表+详情共用本序列化)。
    ops_detail: scrubText(r.ops_detail),
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

/**
 * release request 在 incident detail 里的摘要投影(§6.3 前端契约,字段名逐字对齐:
 * 前端据此渲染放行进度卡/manual reasons/失败原因)。
 */
export interface ReleaseRequestSummary {
  releaseRequestId: string;
  sourceEventId: string | null;
  status: string;
  approvedSha: string;
  baseSha: string | null;
  deployPlanHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}
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
  /** 批1b:该 repair 的 release request(202 异步放行账本;§6.3)。 */
  releaseRequests: ReleaseRequestSummary[];
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
  // 批1b:每 repair 的 release request(§6.3)。一次查全,按 repair_id 归组。
  const releaseByRepair = new Map<string, ReleaseRequestSummary[]>();
  if (repR.rows.length > 0) {
    const rrR = await query<{
      release_request_id: string; source_event_id: string | null; repair_id: string; status: string;
      approved_sha: string; base_sha: string | null; deploy_plan_hash: string | null;
      failure_reason: string | null; created_at: Date; updated_at: Date;
    }>(
      `SELECT release_request_id, source_event_id::text AS source_event_id,
              repair_id::text AS repair_id, status,
              approved_sha, base_sha, deploy_plan_hash, failure_reason, created_at, updated_at
         FROM selfheal_release_requests
        WHERE repair_id = ANY($1::bigint[])
        ORDER BY id ASC`,
      [repR.rows.map((r) => r.id)],
    );
    for (const rr of rrR.rows) {
      const arr = releaseByRepair.get(rr.repair_id) ?? [];
      arr.push({
        releaseRequestId: rr.release_request_id,
        sourceEventId: rr.source_event_id,
        status: rr.status,
        approvedSha: rr.approved_sha,
        baseSha: rr.base_sha,
        deployPlanHash: rr.deploy_plan_hash,
        failureReason: scrubText(rr.failure_reason),
        createdAt: rr.created_at.toISOString(),
        updatedAt: rr.updated_at.toISOString(),
      });
      releaseByRepair.set(rr.repair_id, arr);
    }
  }

  const repairs: RepairView[] = repR.rows.map((r) => ({
    id: r.id,
    incident_id: r.incident_id,
    status: r.status,
    attempt: Number(r.attempt),
    tier: r.tier,
    // M4:summary/fail_reason 是 codex 回传自由文本 → 与 detail 同口径出口清洗。
    summary: scrubText(r.summary),
    detail: redactOpsPayload(r.detail),
    fail_reason: scrubText(r.fail_reason),
    verify_after: r.verify_after ? r.verify_after.toISOString() : null,
    verify_deadline: r.verify_deadline ? r.verify_deadline.toISOString() : null,
    dispatched_at: r.dispatched_at ? r.dispatched_at.toISOString() : null,
    acked_at: r.acked_at ? r.acked_at.toISOString() : null,
    finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    releaseRequests: releaseByRepair.get(r.id) ?? [],
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
      // M4:event message 同为 codex 自由文本 → 出口清洗(detail 已过 redactOpsPayload)。
      message: scrubSecretsInString(e.message),
      detail: redactOpsPayload(e.detail),
      created_at: e.created_at.toISOString(),
    }));
  }

  return { incident: serialize(incR.rows[0]), repairs, events };
}

// ─── admin 手动 resolve(tx:mode-aware 处置 condition + resolve + audit fail-closed)──

export type AdminResolveOutcome = "resolved" | "not_found" | "already_resolved" | "deploy_in_progress";
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

    // 批1b F8:该 incident 有 status='deploying' 的 release request → 部署在途,admin 也不得
    // 手动 resolve(与 deployed/deploy_failed receipt 竞态)。在**任何** condition 处置之前
    // fail-closed 返回 deploy_in_progress,保持 tx 原子(不改 condition、不写审计、不 resolve)。
    // resolveIncident 内部虽也 defer,但那已在 condition 处置之后,会留半改现场;故此处早拦。
    const deploying = await client.query<{ one: number }>(
      `SELECT 1 AS one FROM selfheal_release_requests rr
         JOIN codex_repairs cr ON cr.id = rr.repair_id
        WHERE cr.incident_id = $1::bigint AND rr.status = 'deploying'
        LIMIT 1`,
      [id],
    );
    if (deploying.rows.length > 0) return { outcome: "deploy_in_progress" as const };

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

// ─── repair 一键放行 → release request(批1b:202 durable async)──────────

/**
 * pending_release 事件 detail 的结构化契约(跨仓,个人版 broker.handleCutover 冻结):
 *   { phase:'pending_release', sha:<40hex>, baseSha:<40hex|null>,
 *     deployPlanHash:<hex>, manifestHash:<hex>, classification?, verifyLayers?, changedFiles? }
 * 放行事务只信本地 durable 事件(个人版 intake 还会用 trusted cutover 记录再核一次)。
 */
interface PendingReleaseFrozen {
  approvedSha: string;
  baseSha: string | null;
  deployPlanHash: string;
  manifestHash: string;
  planDetail: Record<string, unknown>;
}

const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** 从最新 pending_release 事件 detail 结构化校验 + 冻结字段(缺/形态错 → null=malformed)。 */
function freezePendingRelease(detail: unknown): PendingReleaseFrozen | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  if (d.phase !== "pending_release") return null;
  const sha = typeof d.sha === "string" ? d.sha : "";
  if (!SHA40_RE.test(sha)) return null;
  const deployPlanHash = typeof d.deployPlanHash === "string" ? d.deployPlanHash : "";
  const manifestHash = typeof d.manifestHash === "string" ? d.manifestHash : "";
  if (!SHA256_RE.test(deployPlanHash) || !SHA256_RE.test(manifestHash)) return null;
  let baseSha: string | null = null;
  if (d.baseSha !== undefined && d.baseSha !== null) {
    if (typeof d.baseSha !== "string" || !SHA40_RE.test(d.baseSha)) return null;
    baseSha = d.baseSha;
  }
  return { approvedSha: sha, baseSha, deployPlanHash, manifestHash, planDetail: d };
}

export type ReleaseOutcome =
  | "queued"
  | "existing"
  | "not_found"
  | "conflict"
  | "malformed"
  | "fuse_engaged";

export interface AdminReleaseResult {
  outcome: ReleaseOutcome;
  releaseRequestId?: string;
  status?: string;
  reason?: string;
}

export interface AdminReleaseInput extends AdminResolveInput {
  expectedPendingReleaseEventId: string;
}

/**
 * 一键放行(批1b:202 异步)。单事务:
 *   1) SELECT … FOR UPDATE 锁 repair 行 → 校验 status='running'。
 *   2) 取最新 pending_release 事件,结构化冻结 sha/baseSha/deployPlanHash/manifestHash
 *      (phase='pending_release' 且 sha 40hex 且两 hash 非空;缺/形态错 → malformed 400)。
 *      事件不存在 → conflict(该 repair 未在待放行姿态)。
 *   3) 全局熔断 engaged → fuse_engaged 423。
 *   4) INSERT selfheal_release_requests(冻结字段全部来自事件 detail;唯一活跃索引
 *      冲突 → conflict 409:同 repair 已有 queued/accepted/deploying 请求)。
 *   5) writeAdminAudit(action='repair.release', outcome='queued', 含 rrid;tx fail-closed)。
 *   → 202 { releaseRequestId, status:'queued' }。
 * 真实部署由 delivery 步交付 + callback 回传,不在此同步等待(部署会重启 master)。
 * break-glass(个人版 root 直连路径)不经此门。
 */
export async function adminReleaseRepair(
  repairId: string,
  input: AdminReleaseInput,
): Promise<AdminReleaseResult> {
  if (!ID_RE.test(repairId)) throw new RangeError("invalid id");
  if (!ID_RE.test(input.expectedPendingReleaseEventId)) {
    throw new RangeError("invalid expectedPendingReleaseEventId");
  }
  try {
    return await tx(async (client: PoolClient) => {
      const rep = await client.query<{ id: string; incident_id: string; status: string }>(
        `SELECT id::text AS id, incident_id::text AS incident_id, status
           FROM codex_repairs WHERE id = $1::bigint FOR UPDATE`,
        [repairId],
      );
      const row = rep.rows[0];
      if (!row) return { outcome: "not_found" as const };
      // Load the exact event the admin reviewed. It is the idempotency key, so
      // a response-loss retry must still recover its original request even if
      // a newer pending_release event has since appeared.
      const evt = await client.query<{ id: string; detail: unknown }>(
        `SELECT id::text AS id, detail FROM codex_repair_events
          WHERE id = $2::bigint AND repair_id = $1::bigint AND kind = 'progress'
            AND detail->>'phase' = 'pending_release'
          LIMIT 1`,
        [repairId, input.expectedPendingReleaseEventId],
      );
      if (evt.rows.length === 0) {
        return { outcome: "conflict" as const, reason: "reviewed pending_release event not found" };
      }
      const sourceEvent = evt.rows[0];
      const frozen = freezePendingRelease(sourceEvent.detail);
      if (!frozen) {
        return {
          outcome: "malformed" as const,
          reason: "pending_release event detail malformed (phase/sha/deployPlanHash/manifestHash)",
        };
      }
      // The immutable source event is the logical idempotency key across every
      // terminal state. Response loss, concurrency, and later retries all
      // recover this one row; one reviewed event can never deploy twice.
      const prior = await client.query<{
        release_request_id: string;
        source_event_id: string | null;
        repair_id: string;
        status: string;
        approved_sha: string;
        base_sha: string | null;
        deploy_plan_hash: string | null;
        manifest_hash: string | null;
      }>(
        `SELECT release_request_id, source_event_id::text AS source_event_id,
                repair_id::text AS repair_id, status, approved_sha, base_sha,
                deploy_plan_hash, manifest_hash, created_at
           FROM selfheal_release_requests
          WHERE source_event_id = $1::bigint
             OR (
               source_event_id IS NULL AND repair_id = $2::bigint
               AND approved_sha = $3 AND base_sha IS NOT DISTINCT FROM $4::text
               AND deploy_plan_hash = $5 AND manifest_hash = $6
               AND created_at >= (
                 SELECT created_at FROM codex_repair_events WHERE id = $1::bigint
               )
             )
          ORDER BY (source_event_id IS NOT NULL) DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [
          sourceEvent.id,
          repairId,
          frozen.approvedSha,
          frozen.baseSha,
          frozen.deployPlanHash,
          frozen.manifestHash,
        ],
      );
      if (prior.rows.length > 0) {
        const p = prior.rows[0];
        const binds =
          p.repair_id === repairId &&
          p.approved_sha === frozen.approvedSha &&
          p.base_sha === frozen.baseSha &&
          p.deploy_plan_hash === frozen.deployPlanHash &&
          p.manifest_hash === frozen.manifestHash;
        if (!binds) {
          return {
            outcome: "conflict" as const,
            reason: "source event already bound to different frozen fields",
          };
        }
        if (p.source_event_id === null) {
          // Upgrade bridge for a pre-0174 ledger row that the migration could
          // not correlate (for example because of legacy timestamp drift).
          // Exact frozen tuple + repair binding is sufficient to consume the
          // reviewed event without creating a second deployment.
          await client.query(
            `UPDATE selfheal_release_requests
                SET source_event_id = $2::bigint
              WHERE release_request_id = $1 AND source_event_id IS NULL`,
            [p.release_request_id, sourceEvent.id],
          );
        }
        return {
          outcome: "existing" as const,
          releaseRequestId: p.release_request_id,
          status: p.status,
        };
      }
      // Only a NEW approval requires the repair to remain in the pending-release
      // running state. An exact source-event retry is handled above regardless
      // of the later repair/request terminal state, so response loss always
      // recovers the original rrid instead of creating ambiguity.
      if (row.status !== "running") {
        return { outcome: "conflict" as const, reason: `repair is ${row.status}` };
      }
      // A NEW approval must still target the latest pending_release event.
      // The repair row lock serializes progress writers, so this check remains
      // stable through the request insert below.
      const latest = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM codex_repair_events
          WHERE repair_id = $1::bigint AND kind = 'progress'
            AND detail->>'phase' = 'pending_release'
          ORDER BY id DESC LIMIT 1`,
        [repairId],
      );
      if (latest.rows[0]?.id !== sourceEvent.id) {
        return {
          outcome: "conflict" as const,
          reason: `pending_release event changed (latest=${latest.rows[0]?.id ?? "none"})`,
        };
      }
      // 全局熔断:engaged 时禁再放行(Tier2 新部署熔断,人工 clear 后才可放行)。
      const fuse = await client.query<{ engaged: boolean }>(
        `SELECT engaged FROM selfheal_release_fuse WHERE id = 1 FOR UPDATE`,
      );
      const pendingFuseEpoch = await client.query<{ engaged: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM selfheal_release_fuse_epochs WHERE cleared_at IS NULL
         ) AS engaged`,
      );
      if (fuse.rows[0]?.engaged || pendingFuseEpoch.rows[0]?.engaged) {
        return { outcome: "fuse_engaged" as const, reason: "release fuse engaged" };
      }
      // INSERT release request(冻结字段全部来自事件 detail;唯一活跃索引冲突 → 23505 → 409)。
      const ins = await client.query<{ release_request_id: string }>(
        `INSERT INTO selfheal_release_requests
           (repair_id, incident_id, requested_by, approved_sha, base_sha,
            deploy_plan_hash, manifest_hash, plan_detail, source_event_id)
         VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8::jsonb, $9::bigint)
         RETURNING release_request_id`,
        [
          repairId,
          row.incident_id,
          String(input.adminId),
          frozen.approvedSha,
          frozen.baseSha,
          frozen.deployPlanHash,
          frozen.manifestHash,
          JSON.stringify(frozen.planDetail),
          sourceEvent.id,
        ],
      );
      const rrid = ins.rows[0].release_request_id;
      await writeAdminAudit(client, {
        adminId: input.adminId,
        action: "repair.release",
        target: `repair:${repairId}`,
        after: {
          repair_id: repairId,
          incident_id: row.incident_id,
          release_request_id: rrid,
          source_event_id: sourceEvent.id,
          approved_sha: frozen.approvedSha,
          outcome: "queued",
        },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      return { outcome: "queued" as const, releaseRequestId: rrid, status: "queued" };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      // ux_selfheal_release_active:同 repair 已有活跃请求(queued/accepted/deploying)。
      return { outcome: "conflict", reason: "release request already active for this repair" };
    }
    throw err;
  }
}

// ─── release request / fuse 读接口 + 熔断收敛(§6.3)────────────────────

export interface ReleaseRequestView {
  releaseRequestId: string;
  sourceEventId: string | null;
  repairId: string;
  incidentId: string;
  status: string;
  requestedBy: string;
  approvedSha: string;
  baseSha: string | null;
  deployPlanHash: string | null;
  manifestHash: string | null;
  planDetail: unknown; // 已脱敏
  failureReason: string | null;
  deliveryAttempts: number;
  nextDeliveryAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
export interface ReleaseRequestDetail {
  request: ReleaseRequestView;
  events: RepairEventView[];
}

/** rrid 白名单:v5 UUID text / break-glass|auto 形态(仅字母数字下划线短横,cap 128)。 */
const RRID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** GET release request:行 + 关联 events(codex_repair_events 里 detail.releaseRequestId=rrid)。 */
export async function getReleaseRequest(rrid: string): Promise<ReleaseRequestDetail | null> {
  if (!RRID_RE.test(rrid)) throw new RangeError("invalid releaseRequestId");
  const r = await query<{
    release_request_id: string; source_event_id: string | null;
    repair_id: string; incident_id: string; status: string;
    requested_by: string; approved_sha: string; base_sha: string | null;
    deploy_plan_hash: string | null; manifest_hash: string | null; plan_detail: unknown;
    failure_reason: string | null; delivery_attempts: number; next_delivery_at: Date | null;
    delivered_at: Date | null; created_at: Date; updated_at: Date;
    resolved_at: Date | null; resolved_by: string | null;
  }>(
    `SELECT release_request_id, source_event_id::text AS source_event_id,
            repair_id::text AS repair_id, incident_id::text AS incident_id,
            status, requested_by, approved_sha, base_sha, deploy_plan_hash, manifest_hash,
            plan_detail, failure_reason, delivery_attempts, next_delivery_at, delivered_at,
            created_at, updated_at, resolved_at, resolved_by
       FROM selfheal_release_requests WHERE release_request_id = $1`,
    [rrid],
  );
  if (r.rows.length === 0) return null;
  const rr = r.rows[0];
  const evR = await query<{
    id: string; repair_id: string; kind: string; message: string; detail: unknown; created_at: Date;
  }>(
    `SELECT id::text AS id, repair_id::text AS repair_id, kind, message, detail, created_at
       FROM codex_repair_events
      WHERE repair_id = $1::bigint AND detail->>'releaseRequestId' = $2
      ORDER BY id ASC`,
    [rr.repair_id, rrid],
  );
  return {
    request: {
      releaseRequestId: rr.release_request_id,
      sourceEventId: rr.source_event_id,
      repairId: rr.repair_id,
      incidentId: rr.incident_id,
      status: rr.status,
      requestedBy: rr.requested_by,
      approvedSha: rr.approved_sha,
      baseSha: rr.base_sha,
      deployPlanHash: rr.deploy_plan_hash,
      manifestHash: rr.manifest_hash,
      planDetail: redactOpsPayload(rr.plan_detail),
      failureReason: scrubText(rr.failure_reason),
      deliveryAttempts: Number(rr.delivery_attempts),
      nextDeliveryAt: rr.next_delivery_at ? rr.next_delivery_at.toISOString() : null,
      deliveredAt: rr.delivered_at ? rr.delivered_at.toISOString() : null,
      createdAt: rr.created_at.toISOString(),
      updatedAt: rr.updated_at.toISOString(),
      resolvedAt: rr.resolved_at ? rr.resolved_at.toISOString() : null,
      resolvedBy: rr.resolved_by,
    },
    events: evR.rows.map((e) => ({
      id: e.id,
      repair_id: e.repair_id,
      kind: e.kind,
      message: scrubSecretsInString(e.message),
      detail: redactOpsPayload(e.detail),
      created_at: e.created_at.toISOString(),
    })),
  };
}

export interface ReleaseFuseView {
  engaged: boolean;
  reason: string | null;
  releaseRequestId: string | null;
  engagedAt: string | null;
  engagedBy: string | null;
  clearedAt: string | null;
  clearedBy: string | null;
  personalAckAt: string | null;
}

/** GET release fuse(全局 Tier2 部署熔断当前值)。 */
export async function getReleaseFuse(): Promise<ReleaseFuseView> {
  const r = await query<{
    engaged: boolean; reason: string | null; release_request_id: string | null;
    engaged_at: Date | null; engaged_by: string | null;
    cleared_at: Date | null; cleared_by: string | null; personal_ack_at: Date | null;
  }>(
    `SELECT engaged, reason, release_request_id, engaged_at, engaged_by,
            cleared_at, cleared_by, personal_ack_at
       FROM selfheal_release_fuse WHERE id = 1`,
  );
  const f = r.rows[0];
  return {
    engaged: Boolean(f?.engaged),
    reason: f?.reason ?? null,
    releaseRequestId: f?.release_request_id ?? null,
    engagedAt: f?.engaged_at ? f.engaged_at.toISOString() : null,
    engagedBy: f?.engaged_by ?? null,
    clearedAt: f?.cleared_at ? f.cleared_at.toISOString() : null,
    clearedBy: f?.cleared_by ?? null,
    personalAckAt: f?.personal_ack_at ? f.personal_ack_at.toISOString() : null,
  };
}

export type FuseClearOutcome =
  | "cleared"
  | "already_cleared"
  | "generation_mismatch"
  | "not_engaged";

/**
 * 清除全局熔断(带审计,tx fail-closed)。CAS engaged=TRUE → FALSE + cleared_at/by;
 * personal_ack_at 复位(sweeper fuse 双侧收敛步据 cleared_at 非空 ∧ personal_ack_at 空
 * 向个人版投递 fuse-clear,确认后回填)。熔断只拦 Tier2 新放行,不拦人工 rollback/recover。
 */
export async function clearReleaseFuse(
  input: AdminResolveInput & { reason?: string | null; expectedReleaseRequestId: string },
): Promise<{
  outcome: FuseClearOutcome;
  releaseRequestId?: string;
  clearedAt?: string;
  remainingReleaseRequestId?: string;
}> {
  if (!RRID_RE.test(input.expectedReleaseRequestId)) {
    throw new RangeError("invalid expectedReleaseRequestId");
  }
  return tx(async (client: PoolClient) => {
    // The singleton is a UI/current projection; selfheal_release_fuse_epochs is
    // the durable set of every unresolved uncertainty and every cleared epoch.
    // All writers lock the singleton first, then an epoch, preserving one lock
    // order while allowing a second deploy_unknown to survive behind the first.
    const cur = await client.query<{
      engaged: boolean;
      reason: string | null;
      release_request_id: string | null;
      engaged_at: Date | null;
      engaged_by: string | null;
      cleared_at: Date | null;
      cleared_by: string | null;
      personal_ack_at: Date | null;
    }>(
      `SELECT engaged, reason, release_request_id, engaged_at, engaged_by,
              cleared_at, cleared_by, personal_ack_at
         FROM selfheal_release_fuse WHERE id = 1 FOR UPDATE`,
    );
    const row = cur.rows[0];
    if (!row) throw new Error("release fuse singleton missing");

    // Upgrade-window bridge: a pre-0174 runtime may have changed only the
    // singleton after the migration committed. Fold that exact projection into
    // the epoch ledger before adjudicating this clear.
    if (row.release_request_id && row.engaged) {
      await client.query(
        `INSERT INTO selfheal_release_fuse_epochs
           (release_request_id, reason, engaged_at, engaged_by)
         VALUES ($1, $2, COALESCE($3, NOW()), COALESCE($4, 'legacy:pre-0174'))
         ON CONFLICT (release_request_id) DO NOTHING`,
        [row.release_request_id, row.reason, row.engaged_at, row.engaged_by],
      );
    } else if (row.release_request_id && row.cleared_at) {
      await client.query(
        `INSERT INTO selfheal_release_fuse_epochs
           (release_request_id, reason, engaged_at, engaged_by,
            cleared_at, cleared_by, clear_reason, personal_ack_at)
         VALUES ($1, $2, COALESCE($3, $5), COALESCE($4, 'legacy:pre-0174'),
                 $5, COALESCE($6, 'legacy:pre-0174'),
                 'materialized from pre-0174 release fuse', $7)
         ON CONFLICT (release_request_id) DO UPDATE
           SET cleared_at = COALESCE(selfheal_release_fuse_epochs.cleared_at, EXCLUDED.cleared_at),
               cleared_by = COALESCE(selfheal_release_fuse_epochs.cleared_by, EXCLUDED.cleared_by),
               clear_reason = COALESCE(
                 selfheal_release_fuse_epochs.clear_reason,
                 EXCLUDED.clear_reason
               ),
               personal_ack_at = COALESCE(
                 selfheal_release_fuse_epochs.personal_ack_at,
                 EXCLUDED.personal_ack_at
               )`,
        [
          row.release_request_id,
          row.reason,
          row.engaged_at,
          row.engaged_by,
          row.cleared_at,
          row.cleared_by,
          row.personal_ack_at,
        ],
      );
    }

    const epoch = await client.query<{
      reason: string | null;
      engaged_at: Date;
      engaged_by: string;
      cleared_at: Date | null;
      cleared_by: string | null;
      personal_ack_at: Date | null;
    }>(
      `SELECT reason, engaged_at, engaged_by, cleared_at, cleared_by, personal_ack_at
         FROM selfheal_release_fuse_epochs
        WHERE release_request_id = $1 FOR UPDATE`,
      [input.expectedReleaseRequestId],
    );
    const existing = epoch.rows[0];
    if (existing?.cleared_at) {
      const pending = await client.query<{
        release_request_id: string;
        reason: string | null;
        engaged_at: Date;
        engaged_by: string;
      }>(
        `SELECT release_request_id, reason, engaged_at, engaged_by
           FROM selfheal_release_fuse_epochs
          WHERE cleared_at IS NULL
          ORDER BY engaged_at ASC, release_request_id ASC
          LIMIT 1
          FOR UPDATE`,
      );
      const next = pending.rows[0];
      if (next) {
        await client.query(
          `UPDATE selfheal_release_fuse
              SET engaged=TRUE, reason=$2, release_request_id=$1, engaged_at=$3,
                  engaged_by=$4, cleared_at=NULL, cleared_by=NULL, personal_ack_at=NULL
            WHERE id=1`,
          [next.release_request_id, next.reason, next.engaged_at, next.engaged_by],
        );
      } else {
        await client.query(
          `UPDATE selfheal_release_fuse
              SET engaged=FALSE, reason=$2, release_request_id=$1, engaged_at=$3,
                  engaged_by=$4, cleared_at=$5, cleared_by=$6, personal_ack_at=$7
            WHERE id=1`,
          [
            input.expectedReleaseRequestId,
            existing.reason,
            existing.engaged_at,
            existing.engaged_by,
            existing.cleared_at,
            existing.cleared_by,
            existing.personal_ack_at,
          ],
        );
      }
      return {
        outcome: "already_cleared" as const,
        releaseRequestId: input.expectedReleaseRequestId,
        clearedAt: existing.cleared_at.toISOString(),
        ...(next ? { remainingReleaseRequestId: next.release_request_id } : {}),
      };
    }
    if (!existing) {
      return row?.engaged
        ? {
            outcome: "generation_mismatch" as const,
            releaseRequestId: row.release_request_id ?? undefined,
          }
        : { outcome: "not_engaged" as const };
    }
    if (!row?.engaged || row.release_request_id !== input.expectedReleaseRequestId) {
      return {
        outcome: "generation_mismatch" as const,
        releaseRequestId: row?.release_request_id ?? undefined,
      };
    }
    const cleared = await client.query<{ cleared_at: Date }>(
      `UPDATE selfheal_release_fuse_epochs
          SET cleared_at = NOW(), cleared_by = $2, clear_reason = $3,
              personal_ack_at = NULL
        WHERE release_request_id = $1 AND cleared_at IS NULL
        RETURNING cleared_at`,
      [input.expectedReleaseRequestId, String(input.adminId), input.reason ?? null],
    );
    const clearedAt = cleared.rows[0]?.cleared_at;
    if (!clearedAt) throw new Error("release fuse epoch clear CAS lost under singleton lock");
    const pending = await client.query<{
      release_request_id: string;
      reason: string | null;
      engaged_at: Date;
      engaged_by: string;
    }>(
      `SELECT release_request_id, reason, engaged_at, engaged_by
         FROM selfheal_release_fuse_epochs
        WHERE cleared_at IS NULL
        ORDER BY engaged_at ASC, release_request_id ASC
        LIMIT 1
        FOR UPDATE`,
    );
    const next = pending.rows[0];
    const cas = next
      ? await client.query(
          `UPDATE selfheal_release_fuse
              SET engaged = TRUE, reason = $2, release_request_id = $1,
                  engaged_at = $3, engaged_by = $4,
                  cleared_at = NULL, cleared_by = NULL, personal_ack_at = NULL
            WHERE id = 1 AND engaged = TRUE AND release_request_id = $5`,
          [
            next.release_request_id,
            next.reason,
            next.engaged_at,
            next.engaged_by,
            input.expectedReleaseRequestId,
          ],
        )
      : await client.query(
          `UPDATE selfheal_release_fuse
              SET engaged = FALSE, cleared_at = $2, cleared_by = $3, personal_ack_at = NULL
            WHERE id = 1 AND engaged = TRUE AND release_request_id = $1`,
          [input.expectedReleaseRequestId, clearedAt, String(input.adminId)],
        );
    if ((cas.rowCount ?? 0) !== 1) throw new Error("release fuse clear CAS lost under singleton lock");
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "selfheal.fuse_clear",
      target: "release_fuse",
      after: {
        reason: input.reason ?? null,
        release_request_id: input.expectedReleaseRequestId,
        cleared_at: clearedAt.toISOString(),
        remaining_release_request_id: next?.release_request_id ?? null,
      },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return {
      outcome: "cleared" as const,
      releaseRequestId: input.expectedReleaseRequestId,
      clearedAt: clearedAt.toISOString(),
      ...(next ? { remainingReleaseRequestId: next.release_request_id } : {}),
    };
  });
}

// ─── user recovery notice approval audit ────────────────────────────

export interface UserNoticeApprovalState {
  binding: {
    channelId: string;
    bindingCode: string;
    active: boolean;
    boundIdentity: string | null;
    boundAt: string | null;
  } | null;
  proposals: Array<{
    id: string;
    incidentId: string;
    repairId: string;
    shortCode: string;
    status: string;
    recipientCount: number;
    sentRecipientCount: number | null;
    recipientsHash: string;
    expiresAt: string;
    createdAt: string;
  }>;
}

export async function getUserNoticeApprovalState(): Promise<UserNoticeApprovalState> {
  const binding = await query<{
    channel_id: string; binding_code: string; active: boolean;
    from_user_id: string; bound_at: Date | null;
  }>(
    `SELECT channel_id::text,binding_code,active,from_user_id,bound_at
       FROM selfheal_notice_approver_bindings ORDER BY active DESC,id DESC LIMIT 1`,
  );
  const proposals = await query<{
    id: string; incident_id: string; repair_id: string; short_code: string; status: string;
    recipient_count: number; sent_recipient_count: number | null; recipients_hash: string;
    expires_at: Date; created_at: Date;
  }>(
    `SELECT id::text,incident_id::text,repair_id::text,short_code,status,recipient_count,
            sent_recipient_count,recipients_hash,expires_at,created_at
       FROM selfheal_user_notice_proposals ORDER BY id DESC LIMIT 50`,
  );
  const b = binding.rows[0];
  return {
    binding: b ? {
      channelId: b.channel_id,
      bindingCode: b.binding_code,
      active: b.active,
      boundIdentity: b.active ? `${b.from_user_id.slice(0, 2)}***` : null,
      boundAt: b.bound_at?.toISOString() ?? null,
    } : null,
    proposals: proposals.rows.map((r) => ({
      id: r.id, incidentId: r.incident_id, repairId: r.repair_id,
      shortCode: r.short_code, status: r.status, recipientCount: r.recipient_count,
      sentRecipientCount: r.sent_recipient_count, recipientsHash: r.recipients_hash,
      expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(),
    })),
  };
}
