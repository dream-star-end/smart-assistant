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
 * `ORDER BY id DESC` —— 最新接收的在前。事件发生时间可能因磁盘队列延迟而
 * 早于接收时间，因此详情单独展示 occurred_at；分页仍用有 PK 索引的 BIGSERIAL。
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

export type AgentAuditStatsWindow = "1h" | "24h" | "7d";

export interface AgentAuditFailureGroup {
  tool: string;
  error_class: string;
  events: number;
  users: number;
  sessions: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface AgentAuditToolRate {
  tool: string;
  success_calls: number;
  failure_calls: number;
  total_calls: number;
  failure_rate: number | null;
}

export interface AgentAuditStatsResult {
  window: AgentAuditStatsWindow;
  rollup: {
    success_calls: number;
    failure_calls: number;
    total_calls: number;
    failure_rate: number | null;
    /** 按工具分解的成败率(rollup 同源,调用量降序 top 12)。失败列表流只显示失败,
     * 观感必然"满屏红";这张分解表让"哪个工具在失败、失败占比多少"一眼可见。 */
    tools: AgentAuditToolRate[];
  };
  coverage: {
    scope: "current_online_fleet";
    mode: "best_effort";
    partial: boolean;
    expected_containers: number;
    covered_containers: number;
    started_at: string | null;
    ended_at: string | null;
  };
  failures: {
    events: number;
    affected_users: number;
    groups: AgentAuditFailureGroup[];
  };
}

export const AGENT_AUDIT_DEFAULT_LIMIT = 50;
export const AGENT_AUDIT_MAX_LIMIT = 200;

/** 工具名校验:覆盖普通工具和 Codex `codex:*` 名称；SQL 仍只走占位符。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** bigint id 白名单:纯数字 1-20 位。 */
const ID_RE = /^[1-9][0-9]{0,19}$/;
const STATS_WINDOW_MS: Record<AgentAuditStatsWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

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
           occurred_at AS created_at
      FROM agent_audit
      ${whereClause}
     ORDER BY agent_audit.id DESC
     LIMIT $${params.length}
  `;
  // ORDER BY agent_audit.id —— SELECT 里有 \`id::text AS id\`,PG 对 ORDER BY
  // simple name 优先取输出列别名(text),qualified column 强制按 bigint 实排。

  const r = await query<AgentAuditRowView>(sql, params);
  const rows = r.rows;
  // 如果本页刚好取满 limit,大概率还有下一页;否则为最后一页。
  const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: nextBefore };
}

export async function getAgentAuditStats(input: {
  window: AgentAuditStatsWindow;
  userId?: string | number | bigint;
  tool?: string;
  now?: Date;
}): Promise<AgentAuditStatsResult> {
  const windowMs = STATS_WINDOW_MS[input.window];
  if (!windowMs) throw new RangeError("invalid_window");
  const userId = input.userId === undefined ? null : normalizeId(input.userId);
  if (input.userId !== undefined && userId === null) throw new RangeError("invalid_user_id");
  const tool = input.tool ?? null;
  if (tool !== null && !TOOL_NAME_RE.test(tool)) throw new RangeError("invalid_tool");
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowMs);

  const rollupParams: unknown[] = [since, now];
  const rollupWhere = ["r.window_ended_at >= $1", "r.window_ended_at <= $2"];
  if (userId !== null) {
    rollupParams.push(userId);
    rollupWhere.push(`r.user_id = $${rollupParams.length}`);
  }
  if (tool !== null) {
    rollupParams.push(tool);
    rollupWhere.push(`c.tool = $${rollupParams.length}`);
  }
  const rollupResult = await query<{
    success_calls: string;
    failure_calls: string;
  }>(
    `SELECT COALESCE(SUM(c.call_count) FILTER (WHERE c.outcome='success'),0)::text AS success_calls,
            COALESCE(SUM(c.call_count) FILTER (WHERE c.outcome='failure'),0)::text AS failure_calls
       FROM agent_tool_rollup_reports r
       JOIN agent_tool_rollup_counts c ON c.report_id=r.report_id
      WHERE ${rollupWhere.join(" AND ")}`,
    rollupParams,
  );
  const successCalls = Number(rollupResult.rows[0]?.success_calls ?? 0);
  const failureCalls = Number(rollupResult.rows[0]?.failure_calls ?? 0);
  const totalCalls = successCalls + failureCalls;

  const toolRateResult = await query<{
    tool: string;
    success_calls: string;
    failure_calls: string;
  }>(
    `SELECT c.tool,
            COALESCE(SUM(c.call_count) FILTER (WHERE c.outcome='success'),0)::text AS success_calls,
            COALESCE(SUM(c.call_count) FILTER (WHERE c.outcome='failure'),0)::text AS failure_calls
       FROM agent_tool_rollup_reports r
       JOIN agent_tool_rollup_counts c ON c.report_id=r.report_id
      WHERE ${rollupWhere.join(" AND ")}
      GROUP BY c.tool
      ORDER BY SUM(c.call_count) DESC, c.tool
      LIMIT 12`,
    rollupParams,
  );
  const toolRates: AgentAuditToolRate[] = toolRateResult.rows.map((row) => {
    const ok = Number(row.success_calls);
    const fail = Number(row.failure_calls);
    const total = ok + fail;
    return {
      tool: row.tool,
      success_calls: ok,
      failure_calls: fail,
      total_calls: total,
      failure_rate: total > 0 ? fail / total : null,
    };
  });

  // Coverage deliberately describes only the current v5 online fleet. The
  // container table has no authoritative lifecycle-end timestamp, so this
  // must never be presented as historical window completeness or an SLA.
  const coverageParams: unknown[] = [now];
  const expectedWhere = ["runtime_channel='v5'", "state='active'"];
  if (userId !== null) {
    coverageParams.push(userId);
    expectedWhere.push(`user_id = $${coverageParams.length}`);
  }
  const coverageResult = await query<{
    expected_containers: string;
    covered_containers: string;
    started_at: Date | null;
    ended_at: Date | null;
  }>(
    `WITH expected AS (
       SELECT id FROM agent_containers WHERE ${expectedWhere.join(" AND ")}
     ), latest_run AS (
       SELECT DISTINCT ON (r.container_id)
              r.container_id, r.reporter_run_id
         FROM agent_tool_rollup_reports r
         JOIN expected e ON e.id=r.container_id
        WHERE r.window_ended_at <= $1::timestamptz
        ORDER BY r.container_id, r.window_ended_at DESC, r.created_at DESC, r.reporter_run_id DESC
     ), run_stats AS (
       SELECT r.container_id,
              MIN(r.sequence) AS min_sequence,
              MAX(r.sequence) AS max_sequence,
              COUNT(*) AS report_count,
              MIN(r.window_started_at) AS started_at,
              MAX(r.window_ended_at) AS ended_at
         FROM agent_tool_rollup_reports r
         JOIN latest_run l
           ON l.container_id=r.container_id AND l.reporter_run_id=r.reporter_run_id
        WHERE r.window_ended_at <= $1::timestamptz
        GROUP BY r.container_id
     )
     SELECT (SELECT COUNT(*) FROM expected)::text AS expected_containers,
            COUNT(*) FILTER (
              WHERE s.ended_at >= $1::timestamptz - INTERVAL '10 minutes'
                AND s.min_sequence = 1
                AND s.report_count = s.max_sequence
            )::text AS covered_containers,
            MIN(s.started_at) AS started_at,
            MAX(s.ended_at) AS ended_at
       FROM run_stats s`,
    coverageParams,
  );
  const expectedContainers = Number(coverageResult.rows[0]?.expected_containers ?? 0);
  const coveredContainers = Number(coverageResult.rows[0]?.covered_containers ?? 0);

  const failureParams: unknown[] = [since, now];
  const failureWhere = ["success = false", "occurred_at >= $1", "occurred_at <= $2"];
  if (userId !== null) {
    failureParams.push(userId);
    failureWhere.push(`user_id = $${failureParams.length}`);
  }
  if (tool !== null) {
    failureParams.push(tool);
    failureWhere.push(`tool = $${failureParams.length}`);
  }
  const failureSummary = await query<{ events: string; affected_users: string }>(
    `SELECT COUNT(*)::text AS events,
            COUNT(DISTINCT user_id)::text AS affected_users
       FROM agent_audit
      WHERE ${failureWhere.join(" AND ")}`,
    failureParams,
  );
  const failureGroups = await query<{
    tool: string;
    error_class: string;
    events: string;
    users: string;
    sessions: string;
    p50_ms: string | null;
    p95_ms: string | null;
  }>(
    `SELECT tool,
            COALESCE(input_meta->>'error_class','other') AS error_class,
            COUNT(*)::text AS events,
            COUNT(DISTINCT user_id)::text AS users,
            COUNT(DISTINCT session_id)::text AS sessions,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::bigint::text AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::bigint::text AS p95_ms
       FROM agent_audit
      WHERE ${failureWhere.join(" AND ")}
      GROUP BY tool, COALESCE(input_meta->>'error_class','other')
      ORDER BY COUNT(*) DESC, tool
      LIMIT 12`,
    failureParams,
  );

  const coverageRow = coverageResult.rows[0];
  return {
    window: input.window,
    rollup: {
      success_calls: successCalls,
      failure_calls: failureCalls,
      total_calls: totalCalls,
      failure_rate: totalCalls > 0 ? failureCalls / totalCalls : null,
      tools: toolRates,
    },
    coverage: {
      scope: "current_online_fleet",
      mode: "best_effort",
      partial: expectedContainers === 0 || coveredContainers < expectedContainers,
      expected_containers: expectedContainers,
      covered_containers: coveredContainers,
      started_at: coverageRow?.started_at?.toISOString() ?? null,
      ended_at: coverageRow?.ended_at?.toISOString() ?? null,
    },
    failures: {
      events: Number(failureSummary.rows[0]?.events ?? 0),
      affected_users: Number(failureSummary.rows[0]?.affected_users ?? 0),
      groups: failureGroups.rows.map((row) => ({
        tool: row.tool,
        error_class: row.error_class,
        events: Number(row.events),
        users: Number(row.users),
        sessions: Number(row.sessions),
        p50_ms: row.p50_ms === null ? null : Number(row.p50_ms),
        p95_ms: row.p95_ms === null ? null : Number(row.p95_ms),
      })),
    },
  };
}
