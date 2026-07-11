/**
 * T-60 — 超管审计共用工具(审计体系整改批重构)。
 *
 * ### writeAdminAudit — 唯一写入口
 * 所有 admin_audit 写入必须走这里(整改批已消灭 billing/ledger 的裸 INSERT 例外)。
 * 接受任何 `QueryRunner`(pool 或 tx 内的 PoolClient),由 action 注册表
 * (auditActions.ts)声明该 action 的政策:
 *   - mode='tx':调用方必须传业务事务内的 client,审计失败 → 业务回滚(fail-closed);
 *   - mode='best-effort':业务成功后经 writeAdminAuditBestEffort 补写,失败不冒泡
 *     但有 critical 告警 + Prometheus 计数。
 * action 参数是注册表字面量类型:未登记的 action 编译不过;运行时再兜一层校验
 * (防 as-cast 绕过)。
 *
 * ### 中央脱敏
 * before/after 在入口统一过 redactSensitive(auditRedact.ts):敏感 key 的值替换为
 * {__redacted,len,last4} 元信息。调用点级脱敏(literature/research config)仍保留,
 * 双保险;此前 system_settings.set 全量 value 明文入库的缺口由本钩子闭合。
 *
 * `before` / `after`:JSON-safe 对象(建议只放受影响字段,完整行审计价值低且容量大)。
 * 超管的 ip/ua 从 RequestContext 取,永远不要从 body 接收。
 *
 * ### listAdminAudit
 * GET /api/admin/audit —— 超管查自己和同行干了啥。keyset(before=id)分页。
 * 过滤:admin_id / action 前缀 / target 精确 / created_from..created_to 时间窗。
 */

import type { QueryRunner } from "../db/queries.js";
import { query } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";
import { incrAdminAuditWriteFailure } from "./metrics.js";
import {
  ADMIN_AUDIT_ACTIONS,
  isAdminAuditAction,
  type AdminAuditAction,
} from "./auditActions.js";
import { redactSensitive } from "./auditRedact.js";

// ─── writeAdminAudit ───────────────────────────────────────────────

export interface WriteAdminAuditInput {
  adminId: bigint | number | string;
  /** 注册表字面量(auditActions.ts)。新增 action 先登记再用。 */
  action: AdminAuditAction;
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
 * 写 admin_audit 一行,返 id。mode='tx' 的 action **必须在业务事务内调用**(把 tx 内的
 * client 作为 runner),避免"业务成功但审计丢失";mode='best-effort' 的 action 请用
 * writeAdminAuditBestEffort,不要直接调本函数再自行 catch(会漏 Prometheus 计数)。
 */
export async function writeAdminAudit(
  runner: QueryRunner,
  input: WriteAdminAuditInput,
): Promise<bigint> {
  // 运行时兜底:类型系统被 as-cast 绕过时 fail-fast(未登记 action 是编程错误,
  // 宁可炸在开发/测试期,不让野字符串污染枚举空间)。
  if (!isAdminAuditAction(input.action)) {
    throw new Error(`[adminAudit] unregistered action: ${String(input.action)} — 先在 auditActions.ts 登记`);
  }
  try {
    const r = await runner.query<{ id: string }>(
      `INSERT INTO admin_audit(admin_id, action, target, before, after, ip, user_agent)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id::text AS id`,
      [
        String(input.adminId),
        input.action,
        input.target ?? null,
        input.before === undefined ? null : JSON.stringify(redactSensitive(input.before)),
        input.after === undefined ? null : JSON.stringify(redactSensitive(input.after)),
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

// ─── writeAdminAuditBestEffort — best-effort 政策的中央执行点 ────────

/** 各 admin 模块请求上下文的最小审计投影(accounts.AdminAuditCtx 结构兼容)。 */
export interface AdminAuditRequestCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
  /** 可选:审计写失败回调(生产应挂监控)。默认 stderr。 */
  onAuditError?: (err: unknown) => void;
}

function defaultAuditErrorLog(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[adminAudit] best-effort write failed:", err);
}

/**
 * 业务成功后补写审计;失败不冒泡。此前 accounts/accountGroups/egressProxies/
 * computeHosts/containers 各自复制粘贴同款 helper——整改批收口到这里,失败行为
 * 单一权威:writeAdminAudit 内部发 critical 告警 → 本函数 catch → Prometheus
 * 计数 + onAuditError(或 stderr)。
 *
 * mode='tx' 的 action 走到这里=编程错误(敏感操作不得降级为 best-effort),
 * 同步抛 —— 这是注册表政策的运行时执行点。
 */
export async function writeAdminAuditBestEffort(
  ctx: AdminAuditRequestCtx,
  action: AdminAuditAction,
  target: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (isAdminAuditAction(action) && ADMIN_AUDIT_ACTIONS[action].mode === "tx") {
    throw new Error(
      `[adminAudit] action=${action} 注册为 mode='tx'(fail-closed),禁止走 best-effort — 在业务事务内调 writeAdminAudit`,
    );
  }
  try {
    await writeAdminAudit(getPool(), {
      adminId: ctx.adminId,
      action,
      target,
      before,
      after,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    // 两路上报,保证不管 HTTP 层有没有传 onAuditError,运维都能看到:
    //   1) Prometheus counter(admin_audit_write_failures_total{action=...})→ 告警
    //   2) ctx.onAuditError(或 stderr)→ 详细错误
    incrAdminAuditWriteFailure(action);
    (ctx.onAuditError ?? defaultAuditErrorLog)(err);
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
  /** 可选:按 action 前缀过滤(小写归一,LIKE prefix,命中 text_pattern_ops 索引) */
  action?: string;
  /** 可选:按 target 精确过滤(格式 `类型:id`) */
  target?: string;
  /** 可选:created_at >= from(ISO 8601) */
  createdFrom?: string;
  /** 可选:created_at <= to(ISO 8601) */
  createdTo?: string;
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
/** target 白名单:注册 action 的 target 都是可打印 ASCII 定位符,cap 128。 */
const TARGET_RE = /^[\x20-\x7e]{1,128}$/;

function normalizeId(v: string | number | bigint | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v === "bigint") return v > 0n ? v.toString() : null;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v <= 0) return null;
    return v.toString();
  }
  return ID_RE.test(v) ? v : null;
}

function parseIsoDate(v: string, err: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new RangeError(err);
  return d;
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
    // 枚举 action 全小写;入参归一后用 LIKE(可命中 text_pattern_ops 索引,
    // 旧 ILIKE 任何 btree 都服务不了,必退化扫描)。
    action = input.action.toLowerCase();
  }
  let target: string | null = null;
  if (input.target !== undefined && input.target !== "") {
    if (!TARGET_RE.test(input.target)) throw new RangeError("invalid_target");
    target = input.target;
  }
  const createdFrom =
    input.createdFrom === undefined || input.createdFrom === ""
      ? null
      : parseIsoDate(input.createdFrom, "invalid_created_from");
  const createdTo =
    input.createdTo === undefined || input.createdTo === ""
      ? null
      : parseIsoDate(input.createdTo, "invalid_created_to");

  let limit = input.limit ?? ADMIN_AUDIT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = ADMIN_AUDIT_DEFAULT_LIMIT;
  if (limit > ADMIN_AUDIT_MAX_LIMIT) limit = ADMIN_AUDIT_MAX_LIMIT;

  const where: string[] = [];
  const params: unknown[] = [];
  if (adminId !== null) { params.push(adminId); where.push(`admin_id = $${params.length}`); }
  if (action !== null) {
    // P1-8 前缀过滤。LIKE 元字符 `_`/`%`/`\` escape 必做 —— ACTION_RE 允许 `_`
    // (`system_settings.set` 是真实 action),不 escape 的话 `system_` 会匹配任意
    // 7 字符,污染审计查询。`\` 不在 ACTION_RE 字符集,但保留通用 escape。
    const liked = action.replace(/\\/g, "\\\\").replace(/[_%]/g, "\\$&");
    params.push(`${liked}%`);
    where.push(`action LIKE $${params.length} ESCAPE '\\'`);
  }
  if (target !== null) { params.push(target); where.push(`target = $${params.length}`); }
  if (createdFrom !== null) { params.push(createdFrom.toISOString()); where.push(`created_at >= $${params.length}`); }
  if (createdTo !== null) { params.push(createdTo.toISOString()); where.push(`created_at <= $${params.length}`); }
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
     ORDER BY admin_audit.id DESC
     LIMIT $${params.length}
  `;
  // ORDER BY admin_audit.id —— 同型 bug 防御:SELECT 里 \`id::text AS id\`,
  // PG simple-name 排序会取 text 别名(数百行后 "999">"1000")。
  const r = await query<AdminAuditRowView>(sql, params);
  const rows = r.rows;
  const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: nextBefore };
}
