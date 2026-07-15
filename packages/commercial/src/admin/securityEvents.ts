/**
 * security_events — 系统安全事件流(0129,审计体系整改批)。
 *
 * 语义三分层的第二层:admin_audit 只留"人类管理员的操作留痕",系统自动产生的
 * 安全信号(路由绕过、审计写失败这类"发生了什么值得安全复盘的事")归本表。
 * 此前 blocked_route_bypass 以 action 身份混在 admin_audit 里,占了全表 79%,
 * 把操作审计流刷成了噪音——0129 迁移已把存量搬到本表。
 *
 * 与相邻机制的边界:
 *   - admin_alert_outbox 是"告警投递队列"(有订阅/静默/重试语义),不是事件存储;
 *     安全事件需要告警时另行 enqueueAlert,本表是持久留痕权威。
 *   - 本表有 retention(见 auditRetention.ts),admin_audit 永久——这正是拆表的
 *     理由之一:系统事件量大但时效有限,人类操作少而必须永久可追溯。
 *
 * 写入为 best-effort(fire-and-forget at caller):安全事件记录失败不该拖垮
 * 业务请求路径;但失败必须响亮(Codex R1 MAJOR#2):critical 告警(与改造前
 * blocked_route_bypass 走 writeAdminAudit 失败的告警等级一致)+ Prometheus
 * security_event_write_failures_total{type} + stderr 三路上报。
 */

import { query } from "../db/queries.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";
import { incrSecurityEventWriteFailure } from "./metrics.js";

/** 事件类型注册:新增安全事件先在这里登记(与 auditActions 同一治理思路)。 */
export const SECURITY_EVENT_TYPES = {
  /** 用户/管理员命中 BLOCKED_FOR_USER_RULES 防火墙;admin 放行(bypass)也留痕。 */
  route_bypass: true,
  /** 已认证普通用户命中 BLOCKED_FOR_USER_RULES 并被拒绝。 */
  route_blocked: true,
} as const;

export type SecurityEventType = keyof typeof SECURITY_EVENT_TYPES;

export interface WriteSecurityEventInput {
  type: SecurityEventType;
  /** 触发者 user id(admin bypass 时=admin id)。匿名/未认证场景可空。 */
  actorUserId?: bigint | number | string | null;
  /** 定位符,如 `POST /api/agents`。 */
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 写一条安全事件。**不抛错**(内部 catch → 告警+计数+stderr 三路上报):
 * 调用点一律视为 fire-and-forget,不需要再 .catch()。
 */
export async function writeSecurityEvent(input: WriteSecurityEventInput): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(SECURITY_EVENT_TYPES, input.type)) {
    // 编程错误:未注册类型。fire-and-forget 语义下不抛,但要响亮。
    console.error(`[securityEvents] unregistered event type: ${String(input.type)}`);
    return;
  }
  try {
    await query(
      `INSERT INTO security_events(type, actor_user_id, target, detail, ip, user_agent)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        input.type,
        input.actorUserId === null || input.actorUserId === undefined
          ? null
          : String(input.actorUserId),
        input.target ?? null,
        JSON.stringify(input.detail ?? {}),
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
  } catch (err) {
    // Codex R1 MAJOR#2:失败必须响亮——改造前该事件走 writeAdminAudit,失败有
    // critical 告警;迁到本表后保持同等级。三路上报:告警+Prometheus+stderr。
    const msg = err instanceof Error ? err.message : String(err);
    incrSecurityEventWriteFailure(input.type);
    safeEnqueueAlert({
      event_type: EVENTS.SECURITY_EVENT_WRITE_FAILED,
      severity: "critical",
      title: "security_events 写入失败",
      body: `type=\`${input.type}\` target=\`${input.target ?? "-"}\` 安全事件写入抛错(fire-and-forget,业务未受影响,但安全留痕丢失)。\n\nerror: ${msg.slice(0, 300)}`,
      payload: { type: input.type, target: input.target ?? null, error: msg.slice(0, 500) },
      dedupe_key: `security.security_event_write_failed:${input.type}:${new Date().toISOString().slice(0, 16)}`,
    });
    console.error(`[securityEvents] write failed type=${input.type}:`, msg);
  }
}

// ─── list(admin 展示面)──────────────────────────────────────────────

export interface SecurityEventRowView {
  id: string;
  type: string;
  actor_user_id: string | null;
  target: string | null;
  detail: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface ListSecurityEventsInput {
  type?: string;
  /** keyset 游标(id < before) */
  before?: string;
  limit?: number;
}

export const SECURITY_EVENTS_DEFAULT_LIMIT = 50;
export const SECURITY_EVENTS_MAX_LIMIT = 200;

const TYPE_RE = /^[a-z0-9_]{1,64}$/;
const ID_RE = /^[1-9][0-9]{0,19}$/;

export async function listSecurityEvents(
  input: ListSecurityEventsInput,
): Promise<{ rows: SecurityEventRowView[]; next_before: string | null }> {
  let limit = input.limit ?? SECURITY_EVENTS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = SECURITY_EVENTS_DEFAULT_LIMIT;
  if (limit > SECURITY_EVENTS_MAX_LIMIT) limit = SECURITY_EVENTS_MAX_LIMIT;

  const where: string[] = [];
  const params: unknown[] = [];
  if (input.type !== undefined && input.type !== "") {
    if (!TYPE_RE.test(input.type)) throw new RangeError("invalid_type");
    params.push(input.type);
    where.push(`type = $${params.length}`);
  }
  if (input.before !== undefined && input.before !== "") {
    if (!ID_RE.test(input.before)) throw new RangeError("invalid_before");
    params.push(input.before);
    where.push(`id < $${params.length}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const r = await query<SecurityEventRowView>(
    `SELECT id::text AS id,
            type,
            actor_user_id::text AS actor_user_id,
            target,
            detail,
            host(ip) AS ip,
            user_agent,
            created_at
       FROM security_events
       ${whereClause}
      ORDER BY security_events.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows;
  return {
    rows,
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}
