/**
 * T-60 — 超管审计共用工具。
 *
 * ### writeAdminAudit
 * 所有 /api/admin/* 的写操作必须走这里落 admin_audit。为了复用现有 tx(例:
 * adminAdjust 已在 billing/ledger 的事务里自己拼 INSERT),这里接受任何
 * `QueryRunner`(pool 或 tx 内的 PoolClient),让调用方决定是否入事务。
 *
 * `before` / `after`:JSON-safe 对象(建议只放受影响字段,完整行审计价值低且容量大)。
 * 超管的 ip/ua 从 RequestContext 取,永远不要从 body 接收。
 *
 * ### listAdminAudit
 * GET /api/admin/audit —— 超管查自己和同行干了啥。keyset(before=id)分页,
 * 同 agent-audit 的思路:PK 索引 + 常数级翻页。支持 `admin_id` / `action` 过滤。
 */

import type { QueryRunner } from "../db/queries.js";
import { query } from "../db/queries.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";

// ─── writeAdminAudit ───────────────────────────────────────────────

export interface WriteAdminAuditInput {
  adminId: bigint | number | string;
  /** 短动词短语,如 `user.patch` / `credits.adjust` / `pricing.patch`。前端据此分组。 */
  action: string;
  /** 受影响对象定位符,如 `user:123` / `account:7` / `model:claude-opus-4-7`。可空。 */
  target?: string | null;
  /** 变更前的关键字段快照。JSON.stringify 可序列化。可空(新建场景)。 */
  before?: unknown;
  /** 变更后的关键字段快照。可空(删除场景 → after 可填 null 表示"已删除"元信息)。 */
  after?: unknown;
  /** 超管请求 IP。从 RequestContext.clientIp 取,不接受 body 传入。 */
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 写 admin_audit 一行,返 id。**请在业务事务内调用本函数**(把 tx 内的 client 作为 runner),
 * 避免"业务成功但审计失败"或反过来。如果没有业务 tx(纯读场景),不应调用。
 */
export async function writeAdminAudit(
  runner: QueryRunner,
  input: WriteAdminAuditInput,
): Promise<bigint> {
  try {
    const r = await runner.query<{ id: string }>(
      `INSERT INTO admin_audit(admin_id, action, target, before, after, ip, user_agent)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id::text AS id`,
      [
        String(input.adminId),
        input.action,
        input.target ?? null,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
    return BigInt(r.rows[0].id);
  } catch (err) {
    // T-63 告警:审计写入失败是合规红线事故 —— critical。
    // 业务 tx 会被调用方 rollback;alert 走独立 pool 连接(safeEnqueueAlert 内部
    // 用 query() 而非 tx runner),不受 rollback 影响。
    const msg = err instanceof Error ? err.message : String(err);
    safeEnqueueAlert({
      event_type: EVENTS.SECURITY_ADMIN_AUDIT_WRITE_FAILED,
      severity: "critical",
      title: "admin_audit 写入失败",
      body: `admin=#${input.adminId} action=\`${input.action}\` target=\`${input.target ?? "-"}\` 审计写入抛错,业务已回滚。\n\nerror: ${msg.slice(0, 300)}`,
      payload: {
        admin_id: String(input.adminId),
        action: input.action,
        target: input.target ?? null,
        error: msg.slice(0, 500),
      },
      // dedupe 按 (action, 分钟桶):避免同一故障在短时间内重复告警
      dedupe_key: `security.admin_audit_write_failed:${input.action}:${new Date().toISOString().slice(0, 16)}`,
    });
    throw err;
  }
}

// ─── listAdminAudit ────────────────────────────────────────────────

export interface AdminAuditRowView {
  id: string;
  admin_id: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface ListAdminAuditInput {
  /** 可选:按 admin 过滤 */
  adminId?: string | number | bigint;
  /** 可选:按 action 精确过滤(支持短横/点,不支持 LIKE — 避免扫全表) */
  action?: string;
  /** 可选:keyset 游标(取 id < before 的行) */
  before?: string | number | bigint;
  /** 单页行数,默认 50,上限 200 */
  limit?: number;
}

export interface ListAdminAuditResult {
  rows: AdminAuditRowView[];
  next_before: string | null;
}

export const ADMIN_AUDIT_DEFAULT_LIMIT = 50;
export const ADMIN_AUDIT_MAX_LIMIT = 200;

/** action 白名单正则:字母数字+点+下划线+短横,1..64 字符。 */
const ACTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ID_RE = /^[1-9][0-9]{0,19}$/;

function normalizeId(v: string | number | bigint | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v === "bigint") return v > 0n ? v.toString() : null;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v <= 0) return null;
    return v.toString();
  }
  return ID_RE.test(v) ? v : null;
}

export async function listAdminAudit(input: ListAdminAuditInput): Promise<ListAdminAuditResult> {
  const adminId = input.adminId === undefined ? null : normalizeId(input.adminId);
  if (input.adminId !== undefined && adminId === null) {
    throw new RangeError("invalid_admin_id");
  }
  const before = input.before === undefined ? null : normalizeId(input.before);
  if (input.before !== undefined && before === null) {
    throw new RangeError("invalid_before");
  }
  let action: string | null = null;
  if (input.action !== undefined) {
    if (!ACTION_RE.test(input.action)) throw new RangeError("invalid_action");
    action = input.action;
  }

  let limit = input.limit ?? ADMIN_AUDIT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = ADMIN_AUDIT_DEFAULT_LIMIT;
  if (limit > ADMIN_AUDIT_MAX_LIMIT) limit = ADMIN_AUDIT_MAX_LIMIT;

  const where: string[] = [];
  const params: unknown[] = [];
  if (adminId !== null) { params.push(adminId); where.push(`admin_id = $${params.length}`); }
  if (action !== null) {
    // P1-8 前缀过滤:UI placeholder 写"action 前缀(如 user.)",过去后端是精确比较,
    // 输 `user.` 会 0 命中。改成 ILIKE prefix。LIKE 元字符 `_`/`%`/`\` escape 必做 ——
    // ACTION_RE 允许 `_`(`system_settings.set` 是真实 action),不 escape 的话 `system_`
    // 会匹配任意 7 字符,污染审计查询。`\` 不在 ACTION_RE 字符集,但保留通用 escape。
    const liked = action.replace(/\\/g, "\\\\").replace(/[_%]/g, "\\$&");
    params.push(`${liked}%`);
    where.push(`action ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (before !== null) { params.push(before); where.push(`id < $${params.length}`); }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  params.push(limit);
  const sql = `
    SELECT id::text       AS id,
           admin_id::text AS admin_id,
           action,
           target,
           before,
           after,
           host(ip)       AS ip,
           user_agent,
           created_at
      FROM admin_audit
      ${whereClause}
     ORDER BY id DESC
     LIMIT $${params.length}
  `;
  const r = await query<AdminAuditRowView>(sql, params);
  const rows = r.rows;
  const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: nextBefore };
}
