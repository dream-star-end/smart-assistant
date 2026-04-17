/**
 * T-54 - agent_audit 查询(超管视角)。
 *
 * 纯 DB 模块。HTTP 层在 `src/http/adminAudit.ts`。
 *
 * ### 为什么 keyset 分页(before=id)而非 OFFSET
 * agent_audit 只增不删,量会很大;OFFSET 扫描成本随偏移量线性增长,keyset
 * 分页靠 `id < $before ORDER BY id DESC` 走 PK 索引,常数级。前端 UX 上
 * 也更顺:每页返回最后一行 id,点"下一页"就塞回 before,天然游标。
 *
 * ### 默认排序
 * `ORDER BY id DESC` —— 最新的在前,BIGSERIAL 自增所以和 created_at DESC
 * 等价(commit 顺序)。用 id 因为有 PK 索引,不用建 created_at DESC 索引。
 *
 * ### 上限
 * limit 最大 200,避免单次拉垮内存。前端需要看更多 → 翻页。
 */

import { query } from "../db/queries.js";

/** 返回给前端的 audit 行(bigint 转 string,时间转 ISO 在 HTTP 层做)。 */
export interface AgentAuditRowView {
  id: string;
  user_id: string;
  session_id: string;
  tool: string;
  input_meta: unknown;
  input_hash: string | null;
  output_hash: string | null;
  duration_ms: number | null;
  success: boolean;
  error_msg: string | null;
  created_at: Date;
}

export interface ListAgentAuditInput {
  /** 可选:按用户过滤 */
  userId?: string | number | bigint;
  /** 可选:按工具名精确过滤 */
  tool?: string;
  /** 可选:keyset 游标(取 id < before 的行) */
  before?: string | number | bigint;
  /** 单页行数,默认 50,上限 200 */
  limit?: number;
}

export interface ListAgentAuditResult {
  rows: AgentAuditRowView[];
  /** 下一页游标 —— 本页最后一行 id;没有下一页时为 null */
  next_before: string | null;
}

export const AGENT_AUDIT_DEFAULT_LIMIT = 50;
export const AGENT_AUDIT_MAX_LIMIT = 200;

/** 工具名校验:只允许字母数字/下划线/短横,避免 SQL 注入/误报。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** bigint id 白名单:纯数字 1-20 位。 */
const ID_RE = /^[1-9][0-9]{0,19}$/;

/**
 * 把任意类型的 id 归一化为 string(数据库以 BIGINT 存,client 一律字符串)。
 * 返回 null 表示输入格式非法 —— 调用方一般直接 throw 400。
 */
function normalizeId(v: string | number | bigint | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v === "bigint") return v > 0n ? v.toString() : null;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v <= 0) return null;
    return v.toString();
  }
  return ID_RE.test(v) ? v : null;
}

/**
 * 列出 agent_audit。所有过滤条件都可选;全部省略 → 最新 50 条。
 *
 * 抛 `RangeError("invalid_tool" | "invalid_user_id" | "invalid_before")`
 * 时表示输入格式错(HTTP 层转 400 VALIDATION)。
 */
export async function listAgentAudit(input: ListAgentAuditInput): Promise<ListAgentAuditResult> {
  // 1) 规整过滤参数。非法输入立刻 throw —— 不静默当空条件(避免前端发错参数还拿到全表)。
  const userId = input.userId === undefined ? null : normalizeId(input.userId);
  if (input.userId !== undefined && userId === null) {
    throw new RangeError("invalid_user_id");
  }

  const before = input.before === undefined ? null : normalizeId(input.before);
  if (input.before !== undefined && before === null) {
    throw new RangeError("invalid_before");
  }

  let tool: string | null = null;
  if (input.tool !== undefined) {
    if (!TOOL_NAME_RE.test(input.tool)) throw new RangeError("invalid_tool");
    tool = input.tool;
  }

  let limit = input.limit ?? AGENT_AUDIT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = AGENT_AUDIT_DEFAULT_LIMIT;
  if (limit > AGENT_AUDIT_MAX_LIMIT) limit = AGENT_AUDIT_MAX_LIMIT;

  // 2) 动态拼 WHERE。全部用 $N 占位,不拼字符串,绝对杜绝注入。
  const where: string[] = [];
  const params: unknown[] = [];
  if (userId !== null) {
    params.push(userId);
    where.push(`user_id = $${params.length}`);
  }
  if (tool !== null) {
    params.push(tool);
    where.push(`tool = $${params.length}`);
  }
  if (before !== null) {
    params.push(before);
    where.push(`id < $${params.length}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  params.push(limit);
  const sql = `
    SELECT id::text        AS id,
           user_id::text   AS user_id,
           session_id,
           tool,
           input_meta,
           input_hash,
           output_hash,
           duration_ms,
           success,
           error_msg,
           created_at
      FROM agent_audit
      ${whereClause}
     ORDER BY id DESC
     LIMIT $${params.length}
  `;

  const r = await query<AgentAuditRowView>(sql, params);
  const rows = r.rows;
  // 如果本页刚好取满 limit,大概率还有下一页;否则为最后一页。
  const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: nextBefore };
}
