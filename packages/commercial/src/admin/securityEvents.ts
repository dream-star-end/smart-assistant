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
 * 业务请求路径;失败走 stderr + Prometheus(复用 admin_audit 写失败计数器语义,
 * 独立 label)。
 */

import { query } from "../db/queries.js";

/** 事件类型注册:新增安全事件先在这里登记(与 auditActions 同一治理思路)。 */
export const SECURITY_EVENT_TYPES = {
  /** 用户/管理员命中 BLOCKED_FOR_USER_RULES 防火墙;admin 放行(bypass)也留痕。 */
  route_bypass: true,
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
 * 写一条安全事件。**不抛错**(内部 catch → stderr):调用点一律视为 fire-and-forget,
 * 不需要再 .catch()。
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
    console.error(
      `[securityEvents] write failed type=${input.type}:`,
      err instanceof Error ? err.message : err,
    );
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
