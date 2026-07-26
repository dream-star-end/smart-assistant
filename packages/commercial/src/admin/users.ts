/**
 * T-60 — 超管用户管理 DB 层。
 *
 * 仅管"用户元信息修改";积分变更走 billing/ledger.adminAdjust(它已经自己在 tx
 * 内写 admin_audit)。
 *
 * ### 允许改哪些字段
 * - `status`  → active / banned / deleting / deleted(match 0001 CHECK)
 * - `role`    → user / admin
 * - `email_verified` → boolean
 *
 * 其它字段(email/password_hash/credits/display_name/avatar_url)**不在超管 patch 范围**:
 *   - email/password 改起来涉及隐私和认证流程,走用户自助
 *   - credits 走专门的 /api/admin/users/:id/credits
 *   - display_name/avatar_url 不需要超管干预
 *
 * ### 为什么 patch 要进 tx
 * 两件事必须原子:UPDATE users + INSERT admin_audit。否则"改了但审计丢失"就是
 * 合规红线事故。不走 tx 就永远不写 audit。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";
import { csvEscapeCell } from "./csvHelper.js";
import { listClientSessions } from "@openclaude/storage";
import { lockRefreshUsers } from "../auth/refreshFamilyLock.js";

export const USER_STATUSES = ["active", "banned", "deleting", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AdminUserRowView {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  credits: string;
  status: UserStatus;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS = `
  id::text        AS id,
  email,
  email_verified,
  display_name,
  avatar_url,
  role,
  credits::text   AS credits,
  status,
  deleted_at,
  created_at,
  updated_at
`;

// ─── 列表 ──────────────────────────────────────────────────────────

/** 注册时间窗口 chip(全部按 Asia/Shanghai 自然日切)。 */
export const REGISTERED_WITHIN_VALUES = ["today", "yesterday", "7d", "30d"] as const;
export type RegisteredWithin = (typeof REGISTERED_WITHIN_VALUES)[number];

/**
 * 漏斗状态 chip。语义:
 *   - unverified  : email_verified=FALSE
 *   - no_topup    : 从未充值过(credit_ledger reason=topup AND delta>0 NOT EXISTS)
 *   - no_request  : 从未发起过 LLM 请求(usage_records NOT EXISTS)
 *   - silent_24h  : 注册满 24h AND 既无充值又无请求
 *
 * 全部默认拼 deleted_at IS NULL —— 漏斗筛选只看活用户,删除状态不在新用户跟踪范围。
 */
export const FUNNEL_STATES = [
  "unverified",
  "no_topup",
  "no_request",
  "silent_24h",
] as const;
export type FunnelState = (typeof FUNNEL_STATES)[number];

export interface ListUsersInput {
  /** 可选:ILIKE 匹配 email(添加 `%` 前后)。 */
  q?: string;
  /** 可选:单值或数组。 */
  status?: UserStatus | UserStatus[];
  /** 默认 50,上限 200 */
  limit?: number;
  /** offset 分页(保留兼容,新路径建议走 cursor) */
  offset?: number;
  /**
   * cursor 分页(id DESC):传上一页最后一行的 id,返回 id < cursor 的行。
   * 优于 offset — 不会 scan 已跳过的行。与 q/status 兼容,cursor 仅影响排序位置。
   */
  cursor?: string;
  /** Phase B:注册时间窗口 chip,与 q/status 可叠加。 */
  registered_within?: RegisteredWithin;
  /** Phase B:漏斗状态 chip,与 q/status/registered_within 可叠加。 */
  funnel_state?: FunnelState;
}

export interface ListUsersResult {
  rows: AdminUserRowView[];
  /** cursor 模式下:若本页满页,给出下页 cursor(最后一行 id);否则 null 表示到底。 */
  next_cursor: string | null;
}

/** R2 新增:list 行 + 运营关心的"动态"字段。 */
export interface AdminUserWithStatsRowView extends AdminUserRowView {
  /** 今日请求数(usage_records since date_trunc('day', NOW())) */
  today_requests: number;
  /** 今日错误请求数(status != 'success') */
  today_errors: number;
  /** 累计充值(cents,SUM(delta) WHERE reason='topup' AND delta > 0)  */
  total_topup_cents: string;
  /** 最近一次 usage_records.created_at(ISO string) ,null 表示从未调用过 */
  last_active_at: string | null;
  /** 当前活跃容器数(v3 state='active' + v2 status='running')。0 = 灰显不可点。 */
  containers_active: number;
}

export interface ListUsersWithStatsResult {
  rows: AdminUserWithStatsRowView[];
  next_cursor: string | null;
}

/** 允许的 status 值白名单,避免任意字符串被发进 SQL。 */
function assertStatus(s: string): asserts s is UserStatus {
  if (!(USER_STATUSES as readonly string[]).includes(s)) {
    throw new RangeError("invalid_status");
  }
}

/**
 * bigint-string 强校验:正则只把住"全数字 + 无前导 0 + 长度 ≤ 20",但 20 位可能
 * 越过 PG `bigint` 上限 (9223372036854775807)。R2 Codex M4:否则 DB 会抛 22003
 * numeric_value_out_of_range → HTTP 500。这里加 BigInt 上界,失败抛 RangeError
 * 让 handler 翻成 400 VALIDATION。
 */
const PG_BIGINT_MAX = 9223372036854775807n;
function isValidBigintString(s: string): boolean {
  if (!/^[1-9][0-9]{0,19}$/.test(s)) return false;
  try {
    return BigInt(s) <= PG_BIGINT_MAX;
  } catch {
    return false;
  }
}

/**
 * 公共 where 构造 — listUsers + listUsersWithStats 共用,避免两次维护同一份
 * 过滤语义漂移。
 */
function buildUsersWhere(input: ListUsersInput): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.q !== undefined && input.q !== "") {
    if (input.q.length > 120) throw new RangeError("invalid_q");
    const trimmed = input.q.trim();
    if (isValidBigintString(trimmed)) {
      params.push(trimmed);
      where.push(`id = $${params.length}::bigint`);
    } else {
      params.push("%" + trimmed.replace(/[\\%_]/g, "\\$&") + "%");
      where.push(
        `(email ILIKE $${params.length} OR display_name ILIKE $${params.length})`,
      );
    }
  }
  if (input.status !== undefined) {
    const arr = Array.isArray(input.status) ? input.status : [input.status];
    for (const s of arr) assertStatus(s);
    params.push(arr);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  if (input.cursor !== undefined && input.cursor !== "") {
    if (!isValidBigintString(input.cursor)) throw new RangeError("invalid_cursor");
    params.push(input.cursor);
    where.push(`id < $${params.length}::bigint`);
  }

  // Phase B:注册时间窗口。SQL 全部按 Asia/Shanghai 自然日截取,与 stats.ts
  // (revenue-by-day / signups-by-day)的边界语义保持一致 —— 例如 "today" =
  // 上海时区今天 00:00 起。这些字面量是常量(switch 内枚举写死),不参数化。
  if (input.registered_within !== undefined) {
    const todayStart = `((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai')`;
    switch (input.registered_within) {
      case "today":
        where.push(`created_at >= ${todayStart}`);
        break;
      case "yesterday":
        where.push(
          `created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')`,
        );
        where.push(`created_at < ${todayStart}`);
        break;
      case "7d":
        where.push(
          `created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '6 days') AT TIME ZONE 'Asia/Shanghai')`,
        );
        break;
      case "30d":
        where.push(
          `created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '29 days') AT TIME ZONE 'Asia/Shanghai')`,
        );
        break;
      default: {
        const v: never = input.registered_within;
        throw new RangeError(`invalid_registered_within:${String(v)}`);
      }
    }
  }

  // Phase B:漏斗状态。所有分支默认拼 deleted_at IS NULL(漏斗筛选只看活用户)。
  // EXISTS 子查询命中索引:
  //   credit_ledger.idx_cl_user_topup (partial WHERE reason='topup' AND delta>0,0027)
  //   usage_records.idx_ur_user_time  ((user_id, created_at DESC),0002)
  if (input.funnel_state !== undefined) {
    where.push(`deleted_at IS NULL`);
    switch (input.funnel_state) {
      case "unverified":
        where.push(`email_verified = FALSE`);
        break;
      case "no_topup":
        where.push(
          `NOT EXISTS (SELECT 1 FROM credit_ledger cl WHERE cl.user_id = users.id AND cl.reason = 'topup' AND cl.delta > 0)`,
        );
        break;
      case "no_request":
        where.push(
          `NOT EXISTS (SELECT 1 FROM usage_records ur WHERE ur.user_id = users.id)`,
        );
        break;
      case "silent_24h":
        where.push(`created_at < NOW() - INTERVAL '24 hours'`);
        where.push(
          `NOT EXISTS (SELECT 1 FROM usage_records ur WHERE ur.user_id = users.id)`,
        );
        where.push(
          `NOT EXISTS (SELECT 1 FROM credit_ledger cl WHERE cl.user_id = users.id AND cl.reason = 'topup' AND cl.delta > 0)`,
        );
        break;
      default: {
        const v: never = input.funnel_state;
        throw new RangeError(`invalid_funnel_state:${String(v)}`);
      }
    }
  }

  return { where, params };
}

function clampUsersLimit(input: ListUsersInput): number {
  let limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  return limit;
}

export async function listUsers(input: ListUsersInput = {}): Promise<ListUsersResult> {
  const { where, params } = buildUsersWhere(input);
  const limit = clampUsersLimit(input);
  // cursor 优先,offset 只为兼容老调用链(测试 / 非 cursor 路径)。两者互斥时
  // cursor 生效 —— buildUsersWhere 已经把 cursor 转成 WHERE。
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined && input.cursor !== "") offset = 0;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  // ORDER BY users.id —— qualified column 必须的:USER_COLUMNS 里有 `id::text AS id`,
  // PG 对 ORDER BY simple name 优先解析为 SELECT 输出列别名(与 GROUP BY 相反),
  // 没限定就会按 text 降序排("99">"100"),100+ 用户被排到 1 后面 + 9 出现在 90/89 之间。
  // 同型陷阱在仓内多处:agentAudit/audit/alertChannels/alertOutbox/account-pool/store
  // 都已一并 qualify。
  const r = await query<AdminUserRowView>(
    `SELECT ${USER_COLUMNS} FROM users ${whereClause}
     ORDER BY users.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  const next_cursor = r.rows.length === limit ? r.rows[r.rows.length - 1].id : null;
  return { rows: r.rows, next_cursor };
}

/**
 * R2 新增:listUsers 的"运营增强版"。先拿一页用户(ID DESC),再以这一页的
 * user_id 集合为 scope,各走一条 user_id=ANY($ids) 的子查询把每个用户的
 *  - 今日请求/错误计数
 *  - 累计 topup 金额
 *  - 最近一次 usage_records 时间
 * 拼回来。所有子查询都走 (user_id, created_at DESC) 这对现有索引,
 * 一页 ≤200 行最多 3 条 index range scan,规模受控。
 *
 * 分 2 次 query 而不是一次 CTE:避免把 usage_records/credit_ledger 的大范围 scan
 * 跟 users 过滤捆在同一个 plan,PG 在大表面前容易选错 join 顺序。
 */
export async function listUsersWithStats(
  input: ListUsersInput = {},
): Promise<ListUsersWithStatsResult> {
  const page = await listUsers(input);
  if (page.rows.length === 0) {
    return { rows: [], next_cursor: null };
  }
  // 只把 id 传进 scoped SQL,参数化 text[] → pg driver 自己转 bigint[]。
  const ids = page.rows.map((r) => r.id);
  const statsRes = await query<{
    user_id: string;
    today_requests: string;
    today_errors: string;
    total_topup_cents: string | null;
    last_active_at: Date | null;
    containers_active: number;
  }>(
    // last_seen 用 LATERAL(SELECT ... ORDER BY created_at DESC LIMIT 1) 稳定命中
    //   (user_id, created_at DESC) 首行,比 MAX() GROUP BY 少扫整个分区。
    // today/topup 仍走 GROUP BY + FILTER —— 今日窗口 + partial index
    //   idx_cl_user_topup (0027) 都让范围很小。
    // ct_v3: partial unique uniq_ac_user_id_active(WHERE state='active')命中。
    // ct_v2: 由 0039 新增 partial b-tree idx_ac_user_running_v2 命中。
    // 显式 ::int cast 避免 PG COUNT(*) 返回 int8 → node-pg 默认转字符串。
    `WITH ids AS (
       SELECT unnest($1::bigint[]) AS user_id
     ),
     today AS (
       SELECT user_id,
              COUNT(*)                                        AS req_count,
              COUNT(*) FILTER (WHERE status != 'success')     AS err_count
       FROM usage_records
       WHERE user_id = ANY($1::bigint[])
         AND created_at > date_trunc('day', NOW())
       GROUP BY user_id
     ),
     topup AS (
       SELECT user_id, SUM(delta) AS total
       FROM credit_ledger
       WHERE user_id = ANY($1::bigint[])
         AND reason = 'topup'
         AND delta > 0
       GROUP BY user_id
     ),
     ct_v3 AS (
       SELECT user_id, COUNT(*) AS n
       FROM agent_containers
       WHERE state = 'active' AND subscription_id IS NULL
         AND user_id = ANY($1::bigint[])
       GROUP BY user_id
     ),
     ct_v2 AS (
       -- lint-agent-containers-sql: allow — 纯 v2 腿:v2 行的权威生命周期列是
       -- status(0012 给全表加的 state 对 v2 老行只是 DEFAULT 'active',不承载
       -- 语义);v3/v5 腿在上面 ct_v3 里已显式 state='active'。
       SELECT user_id, COUNT(*) AS n
       FROM agent_containers
       WHERE status = 'running' AND subscription_id IS NOT NULL
         AND user_id = ANY($1::bigint[])
       GROUP BY user_id
     )
     SELECT ids.user_id::text                                 AS user_id,
            COALESCE(today.req_count, 0)::text                AS today_requests,
            COALESCE(today.err_count, 0)::text                AS today_errors,
            COALESCE(topup.total::text, '0')                  AS total_topup_cents,
            ls.last_at                                        AS last_active_at,
            (COALESCE(ct_v3.n, 0) + COALESCE(ct_v2.n, 0))::int AS containers_active
     FROM ids
     LEFT JOIN today ON today.user_id = ids.user_id
     LEFT JOIN topup ON topup.user_id = ids.user_id
     LEFT JOIN ct_v3 ON ct_v3.user_id = ids.user_id
     LEFT JOIN ct_v2 ON ct_v2.user_id = ids.user_id
     LEFT JOIN LATERAL (
       SELECT created_at AS last_at
         FROM usage_records
        WHERE user_id = ids.user_id
        ORDER BY created_at DESC
        LIMIT 1
     ) ls ON TRUE`,
    [ids],
  );
  const byId = new Map(statsRes.rows.map((s) => [s.user_id, s]));

  const rows: AdminUserWithStatsRowView[] = page.rows.map((u) => {
    const s = byId.get(u.id);
    return {
      ...u,
      today_requests: s ? Number(s.today_requests) : 0,
      today_errors: s ? Number(s.today_errors) : 0,
      total_topup_cents: s?.total_topup_cents ?? "0",
      last_active_at: s?.last_active_at ? s.last_active_at.toISOString() : null,
      // ::int cast 后 pg 应返回 number;Number() 是 belt-and-suspenders 防御。
      containers_active: s ? Number(s.containers_active ?? 0) : 0,
    };
  });
  return { rows, next_cursor: page.next_cursor };
}

// ─── 单条 ──────────────────────────────────────────────────────────

export async function getUser(id: bigint | string): Promise<AdminUserRowView | null> {
  if (!/^[1-9][0-9]{0,19}$/.test(String(id))) throw new RangeError("invalid_user_id");
  const r = await query<AdminUserRowView>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [String(id)],
  );
  return r.rows[0] ?? null;
}

// ─── 详情页(admin 专属:用户运营画像) ─────────────────────────────
//
// 一个请求拿到 admin 详情 modal 需要的全部数据。语义边界:
//   - 主行 user 走 getUser
//   - 3 条 PG 查询并行 + 1 条 SQLite client_sessions 查询(Promise.all)
//   - lifecycle / topups / recent_requests 全时段(PG);recent_sessions **限 90 天**
//     (按 last_at,JS 端过滤)。超 90 天会话 admin 用 recent_requests 翻页拼出来即可
//
// 数据源选择:
//   recent_sessions 走 master SQLite `client_sessions`,**不是** PG
//   `usage_records.session_id`。原因:usage_records.session_id 是 CCB 进程的
//   metadata UUID,与 web 前端 PUT /api/sessions/:id 写入的 client_sessions.id
//   不在同一命名空间;混用会导致 admin "查看会话内容" 100% 命中 404
//   (历史 bug,2026-05 修复)。
//
// 索引依赖:
//   credit_ledger.idx_cl_user_topup        (0027 partial WHERE reason='topup' AND delta>0)
//   usage_records.idx_ur_user_time         ((user_id, created_at DESC),0002)
//   client_sessions.idx_client_sessions_user  (user_id) — 当前规模(用户 ~百行 session)足够;
//     未来若单用户上万,可升级到复合 (user_id, last_at DESC)

export interface AdminUserTopupRow {
  id: string;
  delta: string; // cents,正数
  memo: string | null;
  created_at: string; // ISO
}
export interface AdminUserRequestRow {
  id: string;
  model: string;
  status: "success" | "billing_failed" | "error";
  cost_credits: string; // cents
  session_id: string | null;
  created_at: string; // ISO
}
export interface AdminUserSessionRow {
  /**
   * client_sessions.id (web 前端写入的 session id,例如 web-* / wsess-*)。
   * 直接用作 GET /api/admin/sessions/:id 的查询键 —— 与详情接口同源,
   * 避免历史 bug:列表用 usage_records.session_id (CCB metadata UUID)、
   * 详情用 client_sessions.id,两套命名空间不交叉导致 100% 404。
   */
  session_id: string;
  title: string;
  agent_id: string;
  message_count: number;
  created_at: string; // ISO
  last_at: string; // ISO
  updated_at: string; // ISO
}
export interface AdminUserDetailResult {
  user: AdminUserRowView;
  lifecycle: {
    first_topup_at: string | null;
    first_request_at: string | null;
    last_active_at: string | null;
  };
  topups: AdminUserTopupRow[];
  recent_requests: AdminUserRequestRow[];
  recent_sessions: AdminUserSessionRow[];
}

export async function getUserDetail(
  id: bigint | string,
): Promise<AdminUserDetailResult | null> {
  if (!/^[1-9][0-9]{0,19}$/.test(String(id))) throw new RangeError("invalid_user_id");
  const idStr = String(id);

  const user = await getUser(idStr);
  if (!user) return null;

  const [lifecycleRes, topupsRes, requestsRes, sessionsRes] = await Promise.all([
    // 单 SQL 三个标量,各自命中独立索引(子查询并行执行)
    query<{
      first_topup_at: Date | null;
      first_request_at: Date | null;
      last_active_at: Date | null;
    }>(
      `SELECT
         (SELECT MIN(created_at) FROM credit_ledger
            WHERE user_id = $1::bigint AND reason = 'topup' AND delta > 0) AS first_topup_at,
         (SELECT MIN(created_at) FROM usage_records
            WHERE user_id = $1::bigint) AS first_request_at,
         (SELECT MAX(created_at) FROM usage_records
            WHERE user_id = $1::bigint) AS last_active_at`,
      [idStr],
    ),
    query<{ id: string; delta: string; memo: string | null; created_at: Date }>(
      `SELECT id::text AS id, delta::text AS delta, memo, created_at
         FROM credit_ledger
        WHERE user_id = $1::bigint AND reason = 'topup' AND delta > 0
        ORDER BY created_at DESC
        LIMIT 20`,
      [idStr],
    ),
    query<{
      id: string;
      model: string;
      status: "success" | "billing_failed" | "error";
      cost_credits: string;
      session_id: string | null;
      created_at: Date;
    }>(
      `SELECT id::text AS id, model, status, cost_credits::text AS cost_credits,
              session_id, created_at
         FROM usage_records
        WHERE user_id = $1::bigint
        ORDER BY created_at DESC
        LIMIT 30`,
      [idStr],
    ),
    // 第 4 项:client_sessions(SQLite)。注意 namespace:commercial 用户在
    // master SQLite 里 user_id 始终带 `c:` 前缀(见 handlers.ts:1592 /
    // internalServerAuthored.ts:400 的 inline 约定)。90 天窗口 + LIMIT 10
    // 走 JS 端过滤,因为 listClientSessions 不接受 since/limit 参数,且当前
    // 单用户数据量(< 千行)用 idx_client_sessions_user 索引扫足够快。
    listClientSessions(`c:${idStr}`),
  ]);

  const lc = lifecycleRes.rows[0];
  return {
    user,
    lifecycle: {
      first_topup_at: lc?.first_topup_at?.toISOString() ?? null,
      first_request_at: lc?.first_request_at?.toISOString() ?? null,
      last_active_at: lc?.last_active_at?.toISOString() ?? null,
    },
    topups: topupsRes.rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      memo: r.memo,
      created_at: r.created_at.toISOString(),
    })),
    recent_requests: requestsRes.rows.map((r) => ({
      id: r.id,
      model: r.model,
      status: r.status,
      cost_credits: r.cost_credits,
      session_id: r.session_id,
      created_at: r.created_at.toISOString(),
    })),
    recent_sessions: projectRecentSessions(sessionsRes, Date.now()),
  };
}

/**
 * 把 `listClientSessions` 返回的元数据投影成 admin 详情 modal 用的 schema。
 *
 * 抽成独立导出仅为可测性 —— 90 天 cutoff / 排序保留 / ISO 转换是产品语义,
 * 单测覆盖比集成测试便宜得多(无需 SQLite + PG fixture)。
 *
 * 规则:
 *   - 时间口径按 `lastAt`(对话活动维度,不是 `updatedAt` —— 后者会被 title
 *     rename 等纯 metadata 写入污染,导致"最近活跃"误判)
 *   - 排序信赖上游 `listClientSessions` 已 ORDER BY last_at DESC,本函数只
 *     做 filter + slice,不再排序(保持调用方语义)
 *   - 最多 10 条,与 UI 表头 "最近会话 · 90 天(N)" 的 N 对齐
 *
 * @param nowMs 注入 epoch ms 让 unit test 可控时间,生产传 `Date.now()`
 */
export function projectRecentSessions(
  sessions: readonly {
    id: string;
    agentId: string;
    title: string;
    createdAt: number;
    lastAt: number;
    updatedAt: number;
    messageCount: number;
  }[],
  nowMs: number,
): AdminUserSessionRow[] {
  const cutoff = nowMs - 90 * 24 * 60 * 60 * 1000;
  return sessions
    .filter((s) => s.lastAt >= cutoff)
    .slice(0, 10)
    .map((s) => ({
      session_id: s.id,
      title: s.title,
      agent_id: s.agentId,
      message_count: s.messageCount,
      created_at: new Date(s.createdAt).toISOString(),
      last_at: new Date(s.lastAt).toISOString(),
      updated_at: new Date(s.updatedAt).toISOString(),
    }));
}

// ─── Patch ─────────────────────────────────────────────────────────

export interface PatchUserInput {
  status?: UserStatus;
  role?: UserRole;
  email_verified?: boolean;
}

export interface PatchUserAdminCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export class UserNotFoundError extends Error {
  constructor(id: bigint | string) { super(`user not found: ${String(id)}`); this.name = "UserNotFoundError"; }
}

/**
 * 原子修改 + 审计。patch 为空 → 无操作返当前行(也不写 audit)。
 * target 写成 `user:<id>`;before/after 只存 patch 涉及的那几个字段。
 */
export async function patchUser(
  id: bigint | string,
  patch: PatchUserInput,
  ctx: PatchUserAdminCtx,
): Promise<AdminUserRowView> {
  if (!/^[1-9][0-9]{0,19}$/.test(String(id))) throw new RangeError("invalid_user_id");
  const idStr = String(id);

  // 空 patch 快速返当前行,不写审计
  const touched = (patch.status !== undefined) || (patch.role !== undefined) || (patch.email_verified !== undefined);
  if (!touched) {
    const cur = await getUser(id);
    if (!cur) throw new UserNotFoundError(id);
    return cur;
  }

  if (patch.status !== undefined) assertStatus(patch.status);
  if (patch.role !== undefined && !(USER_ROLES as readonly string[]).includes(patch.role)) {
    throw new RangeError("invalid_role");
  }

  return tx(async (client: PoolClient) => {
    // Account-wide auth mutation lock must precede the users row lock. Every
    // refresh issue/rotation takes the same lock, so ban/delete cannot miss a
    // descendant inserted after this transaction's UPDATE snapshot.
    await lockRefreshUsers(client, [idStr]);
    const before = await client.query<AdminUserRowView>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
      [idStr],
    );
    if (before.rows.length === 0) throw new UserNotFoundError(id);

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.role !== undefined) push("role", patch.role);
    if (patch.email_verified !== undefined) push("email_verified", patch.email_verified);
    sets.push("updated_at = NOW()");

    params.push(idStr);
    const after = await client.query<AdminUserRowView>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING ${USER_COLUMNS}`,
      params,
    );

    // §4 封号即时生效:status 改为非 active(banned/deleting/deleted)时,同事务撤销该用户
    // 全部未撤销 refresh token。否则封号只挡新登录,用户手里已签发的 access token(≤15min)
    // 仍能用,更能拿 refresh token 无限续签,封号形同虚设。revoked_reason='admin'
    // (migration 0019 CHECK 枚举内)。用改密码路径(auth/verify.ts)同款撤销语义。
    // 注:已建立的 WS 长连 / 计费 precheck 对 users.status 的即时复核涉及 ws/、billing/
    // (不在本次范围),需另做才能"秒断"活跃会话;本修复先堵住 token(续签)面。
    if (patch.status !== undefined && patch.status !== "active") {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'admin'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [idStr],
      );
    }

    // before/after 只记变化字段 —— audit 的目的是"变了什么",不是"所有字段"
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    const b = before.rows[0];
    const a = after.rows[0];
    if (patch.status !== undefined) { changedBefore.status = b.status; changedAfter.status = a.status; }
    if (patch.role !== undefined) { changedBefore.role = b.role; changedAfter.role = a.role; }
    if (patch.email_verified !== undefined) {
      changedBefore.email_verified = b.email_verified;
      changedAfter.email_verified = a.email_verified;
    }

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "user.patch",
      target: `user:${idStr}`,
      before: changedBefore,
      after: changedAfter,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    // T-63 告警:只有 role 真实变化才发 security.admin_role_changed —— critical
    if (patch.role !== undefined && b.role !== a.role) {
      const promoted = a.role === "admin";
      safeEnqueueAlert({
        event_type: EVENTS.SECURITY_ADMIN_ROLE_CHANGED,
        severity: "critical",
        title: promoted ? "用户被提升为 admin" : "admin 被降级",
        body: `用户 #${idStr}(${a.email})的 role 从 \`${b.role}\` 改为 \`${a.role}\`,操作者 admin #${ctx.adminId}。`,
        payload: {
          target_user_id: idStr,
          target_email: a.email,
          before_role: b.role,
          after_role: a.role,
          admin_id: String(ctx.adminId),
        },
        // dedupe 按 (目标, 新角色) —— 同一次变更只发一次;角色再变会有新 key
        dedupe_key: `security.admin_role_changed:${idStr}:${a.role}`,
      });
    }

    return a;
  });
}

// ─── CSV 导出(M8.4 / P2-20)──────────────────────────────────────
//
// 同型 buildLedgerCsv:LIMIT USERS_CSV_MAX_ROWS 一次拉到内存。复用 buildUsersWhere
// 保留与 list 一致的 q/status 语义。**不导**:password_hash(密钥)/ avatar_url
// (体积)/ deleted_at(status='deleted' 已表达)。

/** 单次 CSV 最大行数(50k * ~200B ≈ 10MB)。 */
export const USERS_CSV_MAX_ROWS = 50000;

const USERS_CSV_HEADER = [
  "id",
  "email",
  "email_verified",
  "display_name",
  "role",
  "status",
  "credits_cents",
  "created_at",
  "updated_at",
];

export interface BuildUsersCsvInput {
  q?: string;
  status?: UserStatus | UserStatus[];
  /** Phase B:与列表保持一致的过滤维度 */
  registered_within?: RegisteredWithin;
  funnel_state?: FunnelState;
}

export interface BuildUsersCsvResult {
  csv: string;
  rowCount: number;
}

export async function buildUsersCsv(input: BuildUsersCsvInput = {}): Promise<BuildUsersCsvResult> {
  // buildUsersWhere 复用 list 的语义:q ILIKE / status whitelist /
  // registered_within / funnel_state(Phase B —— UI 与导出过滤保持一致)。
  // 不传 cursor — CSV 永远从最新到最旧,USERS_CSV_MAX_ROWS 行硬上限。
  const { where, params } = buildUsersWhere({
    q: input.q,
    status: input.status,
    registered_within: input.registered_within,
    funnel_state: input.funnel_state,
  });
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(USERS_CSV_MAX_ROWS);
  // ORDER BY users.id —— 同上,USER_COLUMNS 含 `id::text AS id` 必须 qualify
  // 避免按 text 排,CSV 导出与列表 UI 看到的顺序保持一致。
  const r = await query<AdminUserRowView>(
    `SELECT ${USER_COLUMNS} FROM users ${whereClause}
     ORDER BY users.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const lines: string[] = [USERS_CSV_HEADER.join(",")];
  for (const row of r.rows) {
    lines.push(
      [
        row.id,
        row.email,
        row.email_verified ? "true" : "false",
        row.display_name,
        row.role,
        row.status,
        row.credits, // schema 字段 credits 是 bigint cents → CSV 列名 credits_cents
        row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      ]
        .map(csvEscapeCell)
        .join(","),
    );
  }
  return { csv: `${lines.join("\r\n")}\r\n`, rowCount: r.rows.length };
}
