/**
 * v5 自愈体系切片② 块A — 结构化只读修复上下文(防 prompt 注入)。
 *
 * codex 经隧道 `GET /internal/v5/repairs/:id/context`(capability 鉴权)拉取。**绝不**把自由文本
 * ops_detail 塞进派单 body(webhook payload 只含 id,见 repairDispatcher),注入面收敛到 master
 * 控制的结构化字段;free-text / snapshot 全部经 redactOpsPayload(M4:key 级+值级清洗)
 * 脱敏后才出库(codex 侧当只读数据,不作为可信指令)。
 *
 * 字段(接缝契约):
 *   eventType     — policy.match_key(命中的策略键,稳定类别);无 policy 回落 condition_key
 *   conditionKey  — 触发 incident 的具体检测键(admin_alert_rule_state.rule_id)
 *   surface       — 影响面(chat/global/...)
 *   severity      — incident 当前严重度
 *   opsDetail     — incident.ops_detail(运维定位文本,脱敏)
 *   probeSnapshot — condition 当前观测快照(JSONB,脱敏;codex 只读参考)
 *   repairHint    — policy.repair_hint(给 codex 的结构化定位提示)
 *   tier          — 修复分层(tier1 确定性 / tier2 代码修复)
 */

import { query as _query } from "../db/queries.js";
import { redactOpsPayload } from "./redact.js";

export interface RepairContext {
  repairId: string;
  incidentId: string;
  attempt: number;
  eventType: string;
  conditionKey: string;
  surface: string;
  severity: string;
  opsDetail: unknown;
  probeSnapshot: unknown;
  repairHint: string | null;
  tier: string;
}

interface ContextRow {
  repair_id: string;
  incident_id: string;
  attempt: number;
  tier: string;
  condition_key: string;
  surface: string;
  severity: string;
  ops_detail: string | null;
  match_key: string | null;
  repair_hint: string | null;
  snapshot: unknown;
}

const ID_RE = /^[1-9][0-9]{0,19}$/;

export interface RepairContextDeps {
  query?: typeof _query;
}

/**
 * 取某 repair 的结构化只读上下文。repairId 非法 → RangeError(端点翻 400);
 * repair 不存在 → null(端点翻 404)。所有 free-text / snapshot 经 redactSensitive。
 */
export async function getRepairContext(
  repairId: string,
  deps: RepairContextDeps = {},
): Promise<RepairContext | null> {
  if (!ID_RE.test(repairId)) throw new RangeError("invalid repair id");
  const query = deps.query ?? _query;
  const r = await query<ContextRow>(
    `SELECT r.id::text          AS repair_id,
            r.incident_id::text  AS incident_id,
            r.attempt            AS attempt,
            r.tier               AS tier,
            i.condition_key      AS condition_key,
            i.surface            AS surface,
            i.severity           AS severity,
            i.ops_detail         AS ops_detail,
            p.match_key          AS match_key,
            p.repair_hint        AS repair_hint,
            c.snapshot           AS snapshot
       FROM codex_repairs r
       JOIN incidents i           ON i.id = r.incident_id
       LEFT JOIN incident_policies p ON p.id = i.policy_id
       LEFT JOIN admin_alert_rule_state c ON c.rule_id = i.condition_key
      WHERE r.id = $1::bigint`,
    [repairId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    repairId: row.repair_id,
    incidentId: row.incident_id,
    attempt: Number(row.attempt),
    eventType: row.match_key ?? row.condition_key,
    conditionKey: row.condition_key,
    surface: row.surface,
    severity: row.severity,
    // M4:redactOpsPayload = key 级 + 值级字符串清洗(snapshot/自由文本里嵌的
    // sk-/Bearer/URL userinfo 凭据也被清);与 selfhealOps admin 视图同一收口。
    opsDetail: redactOpsPayload(row.ops_detail),
    probeSnapshot: redactOpsPayload(row.snapshot ?? {}),
    repairHint: row.repair_hint,
    tier: row.tier,
  };
}
