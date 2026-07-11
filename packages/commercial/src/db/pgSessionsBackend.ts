// pgSessionsBackend — master 会话权威六表的 **PostgreSQL 实现**(RFC-v5-sessions-pg,P2)。
//
// 为什么在 commercial 而不在 storage:pg 依赖已在 commercial(storage 侧只用最小结构类型
// 描述连接、零新增依赖,见 RFC D1)。master 形态(channel=v5,非容器)由 registerCommercial
// 在 composition root 一次性 `setClientSessionsBackend(createPgSessionsBackend(pool))` 注入;
// 容器内 gateway / 个人版不加载 commercial → 天然 SQLite,行为零变化。
//
// 本文件是 SQLite backend(packages/storage/src/sessionsDb.ts 的 sqliteBackend)的**行为等价
// PG 实现**。契约 `ClientSessionsBackend = typeof sqliteBackend` 在类型层强制 27 方法全覆盖
// (漏一个 / 签名不符 = 编译错)。业务决策(merge/seq/spill/usage-patch/delegate 累加)**全部
// 复用** @openclaude/storage 导出的引擎中立纯函数(planSpillOverflow / planAppendServerAuthored /
// mergePreservingServerAuthored / normalizeAndAssignSeqs / appendServerAuthoredPure /
// _stripClientPutMessages),本文件**只做 PG 执行**:取锁 → 读行 → 调 plan → 按变更集落 SQL。
// 双 backend 不各养一份业务逻辑(RFC D6b 防漂移)。
//
// ── 并发正确性核心(RFC D3;本迁移的正确性所在)──────────────────────────────
// 统一锁序(单向,防死锁;与既有 PG 锁序 users→subs 无交集):
//     request advisory(pg_advisory_xact_lock)
//       → client_sessions 行(SELECT ... FOR UPDATE)
//       → server_authored_request_map
//       → pending_usage_patches
//       → archive 表
// 每个"读-改-写"方法都先 `SELECT ... FOR UPDATE` 锁 client_sessions 行再 merge/分配 _seq。
// request-keyed 路径(appendForRequest / appendCostCredits)事务开头先取
//     pg_advisory_xact_lock(hashtextextended('oc_sarm:'||user||':'||request, 0))
// 构成事务级串行点 —— 消除"双 miss 交错"产出 map 与 pending 并存、成本永不 patch 的窗口
// (R1 BLOCKER#1)。FOR UPDATE 锁不住不存在的行,advisory 才是不存在行的串行点。
//
// ── 与 SQLite backend 的**有意差异**(其余逐字段对齐)────────────────────────
//  1. request_map 已存在时 PG **校验 (session_id,msg_id) 一致,不一致 fail-closed 抛错**
//     (RFC D3/R1「map 不可重映射」);SQLite 侧是 ON CONFLICT DO NOTHING 静默吞。PG 更严。
//  2. updated_at 逻辑版本(RFC D3b)由 **DB 计算**:
//     GREATEST(cs.updated_at + 1, (floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::BIGINT, $requested)
//     —— 严格单调、时钟偏差被 cur+1 兜底、双 master 同毫秒双写不再静默覆盖。SQLite 用等价
//     MAX(updated_at+1, JS now) 公式(单进程等价)。
//  3. upsert / cost-patch 的 'oversized'(理论不可达)在 PG 里先按纯 plan 判 size guard、
//     **再**执行 spill;命中时不落任何归档 chunk(SQLite 先 spill 后判,会留孤儿 chunk)。
//     二者 caller 可见结果同为 'oversized'/'noop';PG 严格更干净。
//  4. BIGINT codec(RFC D7):node-postgres 默认把 BIGINT 返回 string,行 mapper 显式
//     Number()+MAX_SAFE_INTEGER 断言;**不改全局 type parser**(不影响 commercial 其它模块)。

import type { Pool, PoolClient } from "pg";
import type { MessageUsageDelegate } from "@openclaude/protocol/teamCards";
import {
  type AppendCostCreditsResult,
  type AppendForRequestResult,
  type ClientSession,
  type ClientSessionMeta,
  type ClientSessionPartial,
  type ClientSessionsBackend,
  type DrainDelegateCostResult,
  MAX_SESSION_BYTES,
  type MessageLike,
  mergePreservingServerAuthored,
  normalizeAndAssignSeqs,
  planAppendServerAuthored,
  planSpillOverflow,
  type ReadArchivedMessagesResult,
  type ServerAuthoredAppendResult,
  type SpillChunkPlan,
  _stripClientPutMessages,
  type UpsertClientSessionResult,
  type UsageAggregationGcStats,
  type UpsertWechatBindingInput,
  WechatAccountAlreadyBoundError,
  type WechatBinding,
} from "@openclaude/storage";

// ── BIGINT codec(RFC D7)─────────────────────────────────────────────────────
// node-postgres 默认把 int8/BIGINT 返回 string(避免 JS number 精度丢失)。这些列全是
// 毫秒时间戳 / 计数,量级远在 2^53 内,行 mapper 显式 Number() + 越界断言即可,**不改全局
// type parser**(那会影响 commercial 其它模块对 BIGINT 的既有 string 预期)。

function bigIntNum(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`[pgSessions] ${field} 非有限数值(BIGINT codec): ${String(v)}`);
  }
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`[pgSessions] ${field} 超 Number.MAX_SAFE_INTEGER(BIGINT codec): ${String(v)}`);
  }
  return n;
}

function bigIntNumOr(v: unknown, dflt: number): number {
  return v === null || v === undefined ? dflt : bigIntNum(v, "value");
}

function bigIntNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : bigIntNum(v, "value");
}

// ── withTx:BEGIN/COMMIT/ROLLBACK 包装(RFC D3)────────────────────────────────
// 每个写方法 = 一个事务(与 SQLite db.transaction 边界一一对应)。fn 收 client,fn 抛出 →
// ROLLBACK 并透传;正常返回 → COMMIT。client 用完必还回池(release)。
async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* rollback 本身失败(连接已断等)—— 吞掉,不遮蔽真正原因 */
    }
    throw err;
  } finally {
    client.release();
  }
}

// 竞态回滚哨兵:upsert 在事务内发现 ON CONFLICT WHERE 被并发写拒(rowCount===0,新建同名
// 会话的竞态,FOR UPDATE 锁不住尚不存在的行)时,抛此哨兵 → withTx ROLLBACK(撤销已做的
// spill 归档 INSERT)→ 外层 catch 映射为 'rejected_stale'。复用同一实例(重复抛无副作用),
// 语义与 SQLite 的 _STALE_WRITE_ROLLBACK 对齐。
const PG_STALE_WRITE_ROLLBACK = new Error("__pg_stale_write_rollback__");

/** request-keyed 事务级串行点(RFC D3/R1)。key = 'oc_sarm:'+userId+':'+requestId。 */
async function requestAdvisoryXactLock(
  client: PoolClient,
  userId: string,
  requestId: string,
): Promise<void> {
  const key = `oc_sarm:${userId}:${requestId}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

// GC 窗口(镜像 storage/sessionsDb.ts 的模块内常量;storage 本批冻结,不能改它导出,故此处
// 复刻。三者语义稳定;若未来 storage 调整窗口,须同步本处 —— 已在 P3 交接清单登记)。
const PENDING_AGING_MS = 60 * 60_000; // 1h alarm
const PENDING_HARD_DELETE_MS = 24 * 60 * 60_000; // 24h GC
const MAP_HARD_DELETE_MS = 7 * 24 * 60 * 60_000; // 7d GC

// updated_at 逻辑版本 SQL 片段(RFC D3b)。$Ncol = 列名前缀(冲突更新时用 client_sessions,
// 普通 UPDATE 时用裸列)。第三个 GREATEST 参数(客户端 requested)只 upsert 用,append/patch
// 路径无客户端值 → 用两参形态。
const CLOCK_MS_SQL = "(floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::BIGINT";

// ── spill 执行(PG 方言)──────────────────────────────────────────────────────
// 决策由 planSpillOverflow(纯)产出;这里只落库:chunk INSERT ... ON CONFLICT DO NOTHING,
// archivedDelta 按 rowCount 累加真正新插入 chunk 的条数(与 SQLite `cr.changes>0` 语义对齐)。
async function execPgSpillPlan(
  client: PoolClient,
  sessId: string,
  userId: string,
  chunksToInsert: SpillChunkPlan[],
  idsToInsert: string[],
  now: number,
): Promise<number> {
  if (chunksToInsert.length === 0) return 0;
  let archivedDelta = 0;
  for (const chunk of chunksToInsert) {
    // 幂等:重放同批 chunk PK (session_id, first_seq) 冲突 → DO NOTHING no-op,delta 不重复计。
    const cr = await client.query(
      `INSERT INTO client_session_archive_chunks
         (session_id, user_id, first_seq, last_seq, message_count, messages, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id, first_seq) DO NOTHING`,
      [sessId, userId, chunk.firstSeq, chunk.lastSeq, chunk.messageCount, JSON.stringify(chunk.messages), now],
    );
    if ((cr.rowCount ?? 0) > 0) archivedDelta += chunk.messageCount;
  }
  for (const id of idsToInsert) {
    await client.query(
      "INSERT INTO client_session_archived_ids (session_id, msg_id) VALUES ($1, $2) ON CONFLICT (session_id, msg_id) DO NOTHING",
      [sessId, id],
    );
  }
  return archivedDelta;
}

/** PUT 防复活:从 incoming 里剔除 id 已归档的消息(参数化 IN,分批避开变量上限;纯读)。 */
async function filterOutArchivedIncoming(
  client: PoolClient,
  sessId: string,
  msgs: MessageLike[],
): Promise<MessageLike[]> {
  const ids: string[] = [];
  for (const m of msgs) if (typeof m?.id === "string") ids.push(m.id);
  if (ids.length === 0) return msgs;

  const archived = new Set<string>();
  const CHUNK = 400;
  for (let off = 0; off < ids.length; off += CHUNK) {
    const batch = ids.slice(off, off + CHUNK);
    const placeholders = batch.map((_, i) => `$${i + 2}`).join(",");
    const rows = await client.query<{ msg_id: string }>(
      `SELECT msg_id FROM client_session_archived_ids WHERE session_id = $1 AND msg_id IN (${placeholders})`,
      [sessId, ...batch],
    );
    for (const r of rows.rows) archived.add(r.msg_id);
  }
  if (archived.size === 0) return msgs;
  return msgs.filter((m) => !(typeof m?.id === "string" && archived.has(m.id)));
}

interface SessionWriteRow {
  messages: string;
  next_seq: number | null;
  deleted_at: string | null;
  archived_through_seq: number | null;
  archived_count: number | null;
}

/**
 * server-authored append 执行核心(在事务内,已由调用方取好 advisory / 上层锁)。行为等价于
 * SQLite 的 _appendServerAuthoredCore:FOR UPDATE 锁 client_sessions 行(不带 deleted_at 过滤
 * 以区分 not_found / deleted)→ archived 命中查 → 解析 → planAppendServerAuthored(纯决策)
 * → execPgSpillPlan → 主行 UPDATE(updated_at 逻辑版本)。
 */
async function pgAppendServerAuthoredCore(
  client: PoolClient,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<ServerAuthoredAppendResult> {
  const row = (
    await client.query<SessionWriteRow>(
      "SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [sessId, userId],
    )
  ).rows[0];
  if (!row) return { applied: false, reason: "session_not_found" };
  if (row.deleted_at !== null) return { applied: false, reason: "session_deleted" };

  // 幂等升级(热尾巴+归档):id 已归档视为 already_exists(防 sink 重放把归档搬回尾巴)。
  const archivedHit = await client.query(
    "SELECT 1 FROM client_session_archived_ids WHERE session_id = $1 AND msg_id = $2",
    [sessId, message.id],
  );
  if ((archivedHit.rowCount ?? 0) > 0) return { applied: false, reason: "already_exists" };

  let msgs: MessageLike[];
  try {
    const parsed = JSON.parse(row.messages);
    if (!Array.isArray(parsed)) return { applied: false, reason: "malformed" };
    msgs = parsed as MessageLike[];
  } catch {
    return { applied: false, reason: "malformed" };
  }

  const currentNextSeq = typeof row.next_seq === "number" && row.next_seq > 0 ? row.next_seq : 1;
  const plan = planAppendServerAuthored(msgs, message, currentNextSeq, bigIntNumOr(row.archived_through_seq, 0));
  if (plan.kind === "already_exists") return { applied: false, reason: "already_exists" };
  if (plan.kind === "oversized") return { applied: false, reason: "oversized" };

  const now = Date.now();
  const archivedDelta = await execPgSpillPlan(client, sessId, userId, plan.chunksToInsert, plan.idsToInsert, now);
  const newArchivedCount = bigIntNumOr(row.archived_count, 0) + archivedDelta;
  const tail = plan.tail;

  const upd = await client.query(
    `UPDATE client_sessions
       SET messages = $1, message_count = $2, last_at = $3,
           updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
           next_seq = $4, archived_through_seq = $5, archived_count = $6
     WHERE id = $7 AND user_id = $8 AND deleted_at IS NULL`,
    [plan.finalJson, tail.length + newArchivedCount, now, plan.nextSeq, plan.archivedThroughSeq, newArchivedCount, sessId, userId],
  );
  if (upd.rowCount !== 1) {
    // 并发软删抢在 SELECT 与 UPDATE 之间(FOR UPDATE 下不可达;保留作最后防线,宁报终态不复活墓碑)。
    return { applied: false, reason: "session_deleted" };
  }
  return { applied: true };
}

// ── wechat_bindings 行 → 领域对象(复刻 storage/wechatBindings.ts 的私有 rowToBinding;
//    storage 本批冻结,helper 未导出,故此处复制。逻辑简单稳定,已在交接清单登记)。────
const IM_WECHAT_SUFFIX = "@im.wechat";
function stripImWechatSuffix(key: string): string {
  return key.endsWith(IM_WECHAT_SUFFIX) ? key.slice(0, -IM_WECHAT_SUFFIX.length) : key;
}
function canonicalizeContextTokens(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[stripImWechatSuffix(k)] = v;
  return out;
}
function parseJsonRecord(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
interface WechatRow {
  user_id: string;
  account_id: string;
  login_user_id: string;
  bot_token: string;
  get_updates_buf: string;
  context_tokens: string;
  whitelist: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}
function rowToBinding(r: WechatRow): WechatBinding {
  let ctx: Record<string, string> = {};
  let wl: string[] = [];
  try {
    ctx = canonicalizeContextTokens(JSON.parse(r.context_tokens || "{}"));
  } catch {
    /* malformed → 空 */
  }
  try {
    wl = JSON.parse(r.whitelist || "[]");
  } catch {
    /* malformed → 空 */
  }
  const st = r.status === "disabled" || r.status === "expired" ? r.status : "active";
  return {
    userId: r.user_id,
    accountId: r.account_id,
    loginUserId: r.login_user_id || "",
    botToken: r.bot_token,
    getUpdatesBuf: r.get_updates_buf || "",
    contextTokens: ctx,
    whitelist: wl,
    status: st as WechatBinding["status"],
    createdAt: bigIntNum(r.created_at, "wechat.created_at"),
    updatedAt: bigIntNum(r.updated_at, "wechat.updated_at"),
    lastEventAt: bigIntNumOrNull(r.last_event_at),
  };
}

// probeSessionsDb 的六表关键列+类型校验清单(RFC D5;非仅 to_regclass)。
const PROBE_EXPECTED_COLUMNS: ReadonlyArray<[string, string, string]> = [
  ["client_sessions", "id", "text"],
  ["client_sessions", "updated_at", "bigint"],
  ["client_sessions", "messages", "text"],
  ["client_sessions", "pinned", "smallint"],
  ["client_sessions", "next_seq", "integer"],
  ["client_sessions", "archived_through_seq", "integer"],
  ["client_session_archive_chunks", "session_id", "text"],
  ["client_session_archive_chunks", "first_seq", "integer"],
  ["client_session_archive_chunks", "messages", "text"],
  ["client_session_archived_ids", "session_id", "text"],
  ["client_session_archived_ids", "msg_id", "text"],
  ["server_authored_request_map", "request_id", "text"],
  ["server_authored_request_map", "user_id", "text"],
  ["server_authored_request_map", "session_id", "text"],
  ["server_authored_request_map", "written_at", "bigint"],
  ["pending_usage_patches", "request_id", "text"],
  ["pending_usage_patches", "cost_credits", "text"],
  ["pending_usage_patches", "created_at", "bigint"],
  ["wechat_bindings", "user_id", "text"],
  ["wechat_bindings", "account_id", "text"],
  ["wechat_bindings", "bot_token", "text"],
];

export interface PgSessionsBackendOptions {
  /** 启动时快照的权威 generation(RFC D5:probe 复核 marker 未漂移)。 */
  expectedGeneration: number;
}

/**
 * 构造 master 会话权威的 PG backend。返回对象结构化满足 `ClientSessionsBackend`(27 方法),
 * 由 registerCommercial 注入。方法内闭包持有 pool。
 */
export function createPgSessionsBackend(
  pool: Pool,
  options: PgSessionsBackendOptions,
): ClientSessionsBackend {
  const expectedGeneration = options.expectedGeneration;

  const backend: ClientSessionsBackend = {
    // ── probe(D5)──────────────────────────────────────────────────────────
    async probeSessionsDb(): Promise<{ ok: true } | { ok: false; error: string }> {
      try {
        await pool.query("SELECT 1");
        // 六表关键列 + 类型校验(current_schemas 覆盖 search_path,兼容测试 schema)。
        const cols = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
          `SELECT table_name, column_name, data_type
             FROM information_schema.columns
            WHERE table_schema = ANY(current_schemas(false))
              AND table_name = ANY($1::text[])`,
          [
            [
              "client_sessions",
              "client_session_archive_chunks",
              "client_session_archived_ids",
              "server_authored_request_map",
              "pending_usage_patches",
              "wechat_bindings",
            ],
          ],
        );
        const typeOf = new Map<string, string>();
        for (const r of cols.rows) typeOf.set(`${r.table_name}.${r.column_name}`, r.data_type);
        for (const [t, c, expected] of PROBE_EXPECTED_COLUMNS) {
          const actual = typeOf.get(`${t}.${c}`);
          if (actual !== expected) {
            return { ok: false, error: `column ${t}.${c} type=${actual ?? "(missing)"} expected=${expected}` };
          }
        }
        // authority = pg_authoritative 且 generation 与启动快照一致(防 marker 漂移)。
        const st = (
          await pool.query<{ authority: string; generation: string }>(
            "SELECT authority, generation FROM sessions_store_migration_state WHERE singleton = true",
          )
        ).rows[0];
        if (!st) return { ok: false, error: "sessions_store_migration_state 无 singleton 行" };
        if (st.authority !== "pg_authoritative") {
          return { ok: false, error: `authority=${st.authority} 非 pg_authoritative` };
        }
        const gen = bigIntNum(st.generation, "migration_state.generation");
        if (gen !== expectedGeneration) {
          return { ok: false, error: `generation 漂移: 现 ${gen} 启动快照 ${expectedGeneration}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
      }
    },

    // ── upsertClientSession(PUT;stale 检测在 FOR UPDATE 后做,悲观化)────────────
    async upsertClientSession(session: ClientSession, baseSyncedAt = 0): Promise<UpsertClientSessionResult> {
      try {
        return await withTx(pool, async (client): Promise<UpsertClientSessionResult> => {
          const existing = (
            await client.query<{
              messages: string;
              updated_at: string;
              next_seq: number | null;
              archived_through_seq: number | null;
              archived_count: number | null;
            }>(
              "SELECT messages, updated_at, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
              [session.id, session.userId],
            )
          ).rows[0];

          // stale 检测:FOR UPDATE 后做 → 竞态消失(悲观化)。此时尚未 spill,直接返回干净。
          if (existing && bigIntNum(existing.updated_at, "updated_at") > baseSyncedAt) {
            return "rejected_stale";
          }

          let oldMsgs: MessageLike[] = [];
          if (existing) {
            try {
              const parsed = JSON.parse(existing.messages);
              if (Array.isArray(parsed)) oldMsgs = parsed as MessageLike[];
            } catch {
              /* malformed existing → 视为空 */
            }
          }
          const clientMsgsRaw = _stripClientPutMessages(session.messages as unknown[]);
          const clientMsgs = await filterOutArchivedIncoming(client, session.id, clientMsgsRaw);
          const merged = mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[];
          const currentNextSeq =
            existing && typeof existing.next_seq === "number" && existing.next_seq > 0 ? existing.next_seq : 1;
          const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(oldMsgs, merged, currentNextSeq);

          const now = Date.now();
          const plan = planSpillOverflow(finalMessages, bigIntNumOr(existing?.archived_through_seq, 0));
          const tail = plan.tail;
          const finalJson = JSON.stringify(tail);
          // size guard 在 spill 执行**前**(理论不可达;命中则不落孤儿 chunk,ROLLBACK 更干净)。
          if (Buffer.byteLength(finalJson, "utf8") > MAX_SESSION_BYTES) {
            return "oversized";
          }
          const archivedDelta = await execPgSpillPlan(
            client,
            session.id,
            session.userId,
            plan.chunksToInsert,
            plan.idsToInsert,
            now,
          );
          const newArchivedCount = bigIntNumOr(existing?.archived_count, 0) + archivedDelta;

          const res = await client.query(
            `INSERT INTO client_sessions
               (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq, archived_through_seq, archived_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               agent_id = EXCLUDED.agent_id,
               title = EXCLUDED.title,
               pinned = EXCLUDED.pinned,
               last_at = EXCLUDED.last_at,
               messages = EXCLUDED.messages,
               message_count = EXCLUDED.message_count,
               -- updated_at 逻辑版本(RFC D3b):冲突更新走 DB 计算 GREATEST;新插入(无冲突)
               -- 用客户端 $10(保持首建=客户端值语义,乐观并发 baseSyncedAt 链不断)。
               updated_at = GREATEST(client_sessions.updated_at + 1, ${CLOCK_MS_SQL}, EXCLUDED.updated_at),
               next_seq = EXCLUDED.next_seq,
               archived_through_seq = EXCLUDED.archived_through_seq,
               archived_count = EXCLUDED.archived_count
             WHERE client_sessions.updated_at <= $14 AND client_sessions.user_id = $2`,
            [
              session.id,
              session.userId,
              session.agentId,
              session.title,
              session.pinned ? 1 : 0,
              session.createdAt,
              session.lastAt,
              finalJson,
              tail.length + newArchivedCount,
              session.updatedAt,
              nextSeq,
              plan.archivedThroughSeq,
              newArchivedCount,
              baseSyncedAt,
            ],
          );
          if ((res.rowCount ?? 0) > 0) return "applied";
          // rowCount===0:并发新建同名会话竞态(FOR UPDATE 锁不住不存在的行),ON CONFLICT
          // WHERE 因先到者已 bump updated_at 而拒 UPDATE。抛哨兵 ROLLBACK(撤销本次 spill)→
          // 外层映射 rejected_stale(与 SQLite 竞态结果一致)。
          throw PG_STALE_WRITE_ROLLBACK;
        });
      } catch (err) {
        if (err === PG_STALE_WRITE_ROLLBACK) return "rejected_stale";
        throw err;
      }
    },

    // ── appendServerAuthoredMessage(单轮 server-authored 落库)───────────────────
    async appendServerAuthoredMessage(
      sessId: string,
      userId: string,
      message: {
        id: string;
        role: "assistant" | "user" | "system" | "thinking" | "tool" | "agent-group";
        text?: string;
        ts?: number;
        [k: string]: unknown;
      },
    ): Promise<{ applied: boolean; reason?: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized" }> {
      const r = await withTx(pool, (client) =>
        pgAppendServerAuthoredCore(client, sessId, userId, message as MessageLike & { id: string }),
      );
      return r.applied ? { applied: true } : { applied: false, reason: r.reason };
    },

    // ── appendServerAuthoredMessageForRequest(usage 聚合:requestId-keyed 四表原子)──
    async appendServerAuthoredMessageForRequest(
      requestId: string,
      sessId: string,
      userId: string,
      message: MessageLike & { id: string },
    ): Promise<AppendForRequestResult> {
      return withTx(pool, async (client): Promise<AppendForRequestResult> => {
        await requestAdvisoryXactLock(client, userId, requestId);
        // 锁序:advisory → client_sessions 行 → pending。先锁会话行,再 FOR UPDATE pending
        // (与 drainByUser/drainDelegate 同序;pending FOR UPDATE 串行化跨路径的排空竞争)。
        await client.query("SELECT id FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sessId, userId]);
        const pending = (
          await client.query<{ cost_credits: string }>(
            "SELECT cost_credits FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
            [requestId, userId],
          )
        ).rows[0];

        let msgToWrite: MessageLike & { id: string } = message;
        if (pending) {
          const existingUsage =
            message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : {};
          msgToWrite = { ...message, usage: { ...existingUsage, costCredits: pending.cost_credits } };
        }

        const r = await pgAppendServerAuthoredCore(client, sessId, userId, msgToWrite);
        if (!r.applied) {
          // 终态(session_deleted / oversized):无未来重试会 drain 此 pending,就地清(与 SQLite 同)。
          // session_not_found 有意保留 —— 前端 debounced PUT 可能仍在途,重试会需要该 pending。
          if (pending && (r.reason === "session_deleted" || r.reason === "oversized")) {
            await client.query("DELETE FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2", [requestId, userId]);
          }
          return r;
        }

        // map 记录 + **不可重映射校验**(RFC D3/R1;PG 比 SQLite DO NOTHING 更严):已存在时
        // (session_id,msg_id) 必须与本次一致,不一致 fail-closed 抛错(防错误复用 requestId 时
        // 成本错挂到别的消息)。
        const ins = await client.query<{ session_id: string }>(
          `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (request_id, user_id) DO NOTHING
             RETURNING session_id`,
          [requestId, userId, sessId, message.id],
        );
        if ((ins.rowCount ?? 0) === 0) {
          const ex = (
            await client.query<{ session_id: string; msg_id: string }>(
              "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2",
              [requestId, userId],
            )
          ).rows[0];
          if (!ex || ex.session_id !== sessId || ex.msg_id !== message.id) {
            throw new Error(
              `[pgSessions] server_authored_request_map 拒绝重映射: (requestId=${requestId},userId=${userId}) ` +
                `已映射 (${ex?.session_id},${ex?.msg_id}),本次欲映射 (${sessId},${message.id})`,
            );
          }
          // 一致(幂等重放)→ 放行。
        }

        if (pending) {
          await client.query("DELETE FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2", [requestId, userId]);
        }
        return { applied: true };
      });
    },

    // ── appendServerAuthoredMessageDrainByUser(ccb 路径:按 user/session 排空 pending)──
    async appendServerAuthoredMessageDrainByUser<T extends MessageLike & { id: string }>(
      sessId: string,
      userId: string,
      message: T,
      agentSessionId?: string | null,
    ): Promise<AppendForRequestResult> {
      return withTx(pool, async (client): Promise<AppendForRequestResult> => {
        // 锁序:先锁会话行,再 FOR UPDATE 本批 pending(SELECT 后新 park 的行留给下一轮)。
        await client.query("SELECT id FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sessId, userId]);
        const pendings = (
          agentSessionId
            ? await client.query<{ request_id: string; cost_credits: string }>(
                "SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = $1 AND session_id = $2 ORDER BY request_id FOR UPDATE",
                [userId, agentSessionId],
              )
            : await client.query<{ request_id: string; cost_credits: string }>(
                "SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = $1 ORDER BY request_id FOR UPDATE",
                [userId],
              )
        ).rows;

        let sum = 0n;
        for (const p of pendings) {
          try {
            const v = BigInt(p.cost_credits);
            if (v > 0n) sum += v;
          } catch {
            /* skip malformed */
          }
        }

        let msgToWrite: MessageLike & { id: string } = message;
        if (sum > 0n) {
          const existingUsage =
            message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : {};
          let base = 0n;
          try {
            base = BigInt((existingUsage.costCredits as string) ?? "0");
          } catch {
            base = 0n;
          }
          msgToWrite = { ...message, usage: { ...existingUsage, costCredits: (base + sum).toString() } };
        }

        const r = await pgAppendServerAuthoredCore(client, sessId, userId, msgToWrite);
        if (!r.applied) return r;

        if (pendings.length) {
          for (const p of pendings) {
            await client.query("DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = $2", [userId, p.request_id]);
          }
        }
        return { applied: true };
      });
    },

    // ── appendCostCredits(cost-only patch;六步锁序算法 RFC D3)──────────────────
    async appendCostCredits(
      requestId: string,
      userId: string,
      costCredits: string,
      sessionId?: string | null,
      parentSessionId?: string | null,
      delegateAgentId?: string | null,
    ): Promise<AppendCostCreditsResult> {
      return withTx(pool, async (client): Promise<AppendCostCreditsResult> => {
        // ① request advisory(串行点)。
        await requestAdvisoryXactLock(client, userId, requestId);

        // ② 非锁定读 map,仅用于定位 session_id(禁先 FOR UPDATE map 破坏锁序)。
        const mapRow0 = (
          await client.query<{ session_id: string; msg_id: string }>(
            "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2",
            [requestId, userId],
          )
        ).rows[0];

        if (mapRow0) {
          // ③ 锁 client_sessions 行。
          const sess = (
            await client.query<{
              messages: string;
              next_seq: number | null;
              archived_through_seq: number | null;
              archived_count: number | null;
            }>(
              "SELECT messages, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
              [mapRow0.session_id, userId],
            )
          ).rows[0];
          // ④ FOR UPDATE 复核 map locator 未变/未被 GC 删(消失 → 按 miss 重决策,禁用陈旧 locator)。
          const mapRow = (
            await client.query<{ session_id: string; msg_id: string }>(
              "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
              [requestId, userId],
            )
          ).rows[0];

          if (sess && mapRow) {
            let msgs: MessageLike[];
            try {
              const parsed = JSON.parse(sess.messages);
              msgs = Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
            } catch {
              msgs = [];
            }
            const idx = msgs.findIndex((m) => m && m.id === mapRow.msg_id && m._source === "server");
            if (idx >= 0) {
              const existing = msgs[idx] as MessageLike & { usage?: Record<string, unknown> };
              const prevCost = existing.usage?.costCredits;
              if (typeof prevCost === "string" && prevCost === costCredits) {
                return { applied: "noop" }; // 幂等重放 —— 不 bump _seq。
              }
              const currentNextSeq = typeof sess.next_seq === "number" && sess.next_seq > 0 ? sess.next_seq : 1;
              const patched: MessageLike = {
                ...existing,
                _seq: currentNextSeq,
                usage: { ...(existing.usage ?? {}), costCredits },
              };
              const next: MessageLike[] = [...msgs];
              next[idx] = patched;
              // ⑥ mutation(热尾巴 + 归档;size guard 先行 → 命中 noop,不落孤儿 chunk)。
              const nowMs = Date.now();
              const plan = planSpillOverflow(next, bigIntNumOr(sess.archived_through_seq, 0));
              const tail = plan.tail;
              const nextJson = JSON.stringify(tail);
              if (Buffer.byteLength(nextJson, "utf8") > MAX_SESSION_BYTES) {
                return { applied: "noop" };
              }
              const archivedDelta = await execPgSpillPlan(
                client,
                mapRow.session_id,
                userId,
                plan.chunksToInsert,
                plan.idsToInsert,
                nowMs,
              );
              const newArchivedCount = bigIntNumOr(sess.archived_count, 0) + archivedDelta;
              await client.query(
                `UPDATE client_sessions
                   SET messages = $1, message_count = $2, last_at = $3,
                       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                       next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5
                 WHERE id = $6 AND user_id = $7`,
                [nextJson, tail.length + newArchivedCount, nowMs, plan.archivedThroughSeq, newArchivedCount, mapRow.session_id, userId],
              );
              return { applied: "patched" };
            }
            // 目标 msg 不在热尾巴:已归档 → noop(别再徒劳 re-pending 陷入循环);未归档(被删/编辑
            // out-of-band)→ 维持 fall through 到 pending(与 SQLite 同)。
            const archivedHit = await client.query(
              "SELECT 1 FROM client_session_archived_ids WHERE session_id = $1 AND msg_id = $2",
              [mapRow.session_id, mapRow.msg_id],
            );
            if ((archivedHit.rowCount ?? 0) > 0) return { applied: "noop" };
            // else fall through to pending
          }
          // sess 缺位(会话已软删)或 mapRow 被 GC(④ 消失)→ fall through 到 pending(miss 重决策)。
        }

        // ⑤ park:UPSERT pending_usage_patches(created_at 冲突时重置为语句时刻)。
        await client.query(
          `INSERT INTO pending_usage_patches
             (request_id, user_id, session_id, parent_session_id, delegate_agent_id, cost_credits)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (request_id, user_id) DO UPDATE SET
             cost_credits = EXCLUDED.cost_credits,
             session_id = EXCLUDED.session_id,
             parent_session_id = EXCLUDED.parent_session_id,
             delegate_agent_id = EXCLUDED.delegate_agent_id,
             created_at = ${CLOCK_MS_SQL}`,
          [requestId, userId, sessionId ?? null, parentSessionId ?? null, delegateAgentId ?? null, costCredits],
        );
        return { applied: "pending" };
      });
    },

    // ── drainDelegateCostForClientSession(委派成本按父客户端会话归并)──────────────
    async drainDelegateCostForClientSession(
      clientSessionId: string,
      userId: string,
      msgId: string,
    ): Promise<DrainDelegateCostResult> {
      return withTx(pool, async (client): Promise<DrainDelegateCostResult> => {
        // fast path:普通 turn 无委派成本 → 纯读(idx_pup_parent)零锁提前返回,避免每 turn
        // 锁会话行的无谓争用。命中(有委派 pending)才进入锁序 session → pending。
        const probe = await client.query(
          "SELECT 1 FROM pending_usage_patches WHERE user_id = $1 AND parent_session_id = $2 LIMIT 1",
          [userId, clientSessionId],
        );
        if ((probe.rowCount ?? 0) === 0) return { merged: "0", drained: 0 };

        // 锁序:先锁会话行(可能不存在 → 锁空,由后续保守分支处理),再 FOR UPDATE 本批 pending。
        const sess = (
          await client.query<{
            messages: string;
            next_seq: number | null;
            archived_through_seq: number | null;
            archived_count: number | null;
          }>(
            "SELECT messages, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
            [clientSessionId, userId],
          )
        ).rows[0];

        const pendings = (
          await client.query<{ request_id: string; cost_credits: string; delegate_agent_id: string | null }>(
            "SELECT request_id, cost_credits, delegate_agent_id FROM pending_usage_patches WHERE user_id = $1 AND parent_session_id = $2 ORDER BY request_id FOR UPDATE",
            [userId, clientSessionId],
          )
        ).rows;
        if (pendings.length === 0) return { merged: "0", drained: 0 }; // 竞态被抢走

        let sum = 0n;
        const perAgent = new Map<string, bigint>();
        for (const p of pendings) {
          let v: bigint;
          try {
            v = BigInt(p.cost_credits);
          } catch {
            continue;
          }
          if (v <= 0n) continue;
          sum += v;
          const aid = p.delegate_agent_id;
          if (aid) perAgent.set(aid, (perAgent.get(aid) ?? 0n) + v);
        }
        if (sum <= 0n) {
          // 只有非正/畸形成本 → 清掉(无归并价值),不写库、不 bump _seq(与 SQLite 同,含 session 缺位时也清)。
          for (const p of pendings) {
            await client.query("DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = $2", [userId, p.request_id]);
          }
          return { merged: "0", drained: pendings.length };
        }

        // 目标会话缺位(尚未 sink / 已删)→ 保守保留 pending,下一 turn 再试。
        if (!sess) return { merged: "0", drained: 0 };

        let msgs: MessageLike[];
        try {
          const parsed = JSON.parse(sess.messages);
          msgs = Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
        } catch {
          msgs = [];
        }
        const idx = msgs.findIndex((m) => m && m.id === msgId && m._source === "server");
        if (idx < 0) return { merged: "0", drained: 0 }; // 找不到队长助手行 → 保守保留 pending。

        const existing = msgs[idx] as MessageLike & { usage?: Record<string, unknown> };
        let base = 0n;
        try {
          base = BigInt((existing.usage?.costCredits as string) ?? "0");
        } catch {
          base = 0n;
        }
        const nextCost = (base + sum).toString();
        // usage.delegates[] 累加合并(读历史明细 → 叠加本次 perAgent → 确定性排序)。
        const mergedAgent = new Map<string, bigint>();
        const prevDelegates = existing.usage?.delegates;
        if (Array.isArray(prevDelegates)) {
          for (const d of prevDelegates as unknown[]) {
            if (!d || typeof d !== "object") continue;
            const aid = (d as { agentId?: unknown }).agentId;
            const cc = (d as { costCredits?: unknown }).costCredits;
            if (typeof aid !== "string" || !aid) continue;
            try {
              mergedAgent.set(aid, (mergedAgent.get(aid) ?? 0n) + BigInt(String(cc ?? "0")));
            } catch {
              /* skip */
            }
          }
        }
        for (const [aid, v] of perAgent) mergedAgent.set(aid, (mergedAgent.get(aid) ?? 0n) + v);
        const delegates: MessageUsageDelegate[] = [...mergedAgent.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([agentId, v]) => ({ agentId, costCredits: v.toString() }));

        const currentNextSeq = typeof sess.next_seq === "number" && sess.next_seq > 0 ? sess.next_seq : 1;
        const patched: MessageLike = {
          ...existing,
          _seq: currentNextSeq,
          usage: {
            ...(existing.usage ?? {}),
            costCredits: nextCost,
            ...(delegates.length > 0 ? { delegates } : {}),
          },
        };
        const next: MessageLike[] = [...msgs];
        next[idx] = patched;

        const nowMs = Date.now();
        const plan = planSpillOverflow(next, bigIntNumOr(sess.archived_through_seq, 0));
        const tail = plan.tail;
        const nextJson = JSON.stringify(tail);
        // 超限拒绝(理论不可达):保留 pending,不写库(下一轮/修 blob 后仍可归并)。
        if (Buffer.byteLength(nextJson, "utf8") > MAX_SESSION_BYTES) {
          return { merged: "0", drained: 0 };
        }
        const archivedDelta = await execPgSpillPlan(client, clientSessionId, userId, plan.chunksToInsert, plan.idsToInsert, nowMs);
        const newArchivedCount = bigIntNumOr(sess.archived_count, 0) + archivedDelta;
        await client.query(
          `UPDATE client_sessions
             SET messages = $1, message_count = $2, last_at = $3,
                 updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                 next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5
           WHERE id = $6 AND user_id = $7`,
          [nextJson, tail.length + newArchivedCount, nowMs, plan.archivedThroughSeq, newArchivedCount, clientSessionId, userId],
        );

        for (const p of pendings) {
          await client.query("DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = $2", [userId, p.request_id]);
        }
        return {
          merged: sum.toString(),
          drained: pendings.length,
          ...(delegates.length > 0 ? { delegates } : {}),
        };
      });
    },

    // ── sweepUsageAggregationGc(pending/map 老化 GC;只由 advisory lease 持有者调度)──
    async sweepUsageAggregationGc(now: number = Date.now()): Promise<UsageAggregationGcStats> {
      return withTx(pool, (client) => sweepOnce(client, now));
    },

    // ── 读路径(无事务;单/多语句纯读,与 SQLite 一致不开显式事务)────────────────
    async listClientSessions(userId: string): Promise<ClientSessionMeta[]> {
      const rows = (
        await pool.query<{
          id: string;
          agent_id: string;
          title: string;
          pinned: number;
          created_at: string;
          last_at: string;
          updated_at: string;
          msg_count: number;
        }>(
          `SELECT id, agent_id, title, pinned, created_at, last_at, updated_at, message_count AS msg_count
             FROM client_sessions WHERE user_id = $1 AND deleted_at IS NULL ORDER BY last_at DESC`,
          [userId],
        )
      ).rows;
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        title: r.title,
        pinned: r.pinned === 1,
        createdAt: bigIntNum(r.created_at, "created_at"),
        lastAt: bigIntNum(r.last_at, "last_at"),
        messageCount: r.msg_count,
        updatedAt: bigIntNum(r.updated_at, "updated_at"),
      }));
    },

    async getClientSession(id: string, userId?: string): Promise<ClientSession | null> {
      const sql = userId
        ? "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL"
        : "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND deleted_at IS NULL";
      const row = (
        await pool.query<{
          id: string;
          user_id: string;
          agent_id: string;
          title: string;
          pinned: number;
          created_at: string;
          last_at: string;
          messages: string;
          updated_at: string;
          archived_through_seq: number | null;
          archived_count: number | null;
        }>(sql, userId ? [id, userId] : [id])
      ).rows[0];
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        agentId: row.agent_id,
        title: row.title,
        pinned: row.pinned === 1,
        createdAt: bigIntNum(row.created_at, "created_at"),
        lastAt: bigIntNum(row.last_at, "last_at"),
        messages: JSON.parse(row.messages),
        updatedAt: bigIntNum(row.updated_at, "updated_at"),
        archivedCount: bigIntNumOr(row.archived_count, 0),
        archivedThroughSeq: bigIntNumOr(row.archived_through_seq, 0),
      };
    },

    async getClientSessionPartial(id: string, userId: string, sinceSeq: number): Promise<ClientSessionPartial | null> {
      const row = (
        await pool.query<{
          id: string;
          user_id: string;
          agent_id: string;
          title: string;
          pinned: number;
          created_at: string;
          last_at: string;
          messages: string;
          updated_at: string;
          archived_through_seq: number | null;
          archived_count: number | null;
        }>(
          "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [id, userId],
        )
      ).rows[0];
      if (!row) return null;
      const archivedCount = bigIntNumOr(row.archived_count, 0);
      const archivedThroughSeq = bigIntNumOr(row.archived_through_seq, 0);

      let allMsgs: MessageLike[] = [];
      try {
        const parsed = JSON.parse(row.messages);
        if (Array.isArray(parsed)) allMsgs = parsed as MessageLike[];
      } catch {
        /* malformed → 空 */
      }
      const anyMissingSeq = allMsgs.some((m) => !m || typeof m._seq !== "number" || !Number.isFinite(m._seq as number));
      let maxSeq = 0;
      for (const m of allMsgs) {
        const s = typeof m?._seq === "number" ? m._seq : 0;
        if (s > maxSeq) maxSeq = s;
      }
      const sinceIsValid = Number.isFinite(sinceSeq) && sinceSeq > 0;
      let messages: MessageLike[];
      let isPartial: boolean;
      if (!anyMissingSeq && sinceIsValid) {
        messages = allMsgs.filter((m) => typeof m?._seq === "number" && (m._seq as number) > sinceSeq);
        isPartial = true;
      } else {
        messages = allMsgs;
        isPartial = false;
      }
      return {
        id: row.id,
        userId: row.user_id,
        agentId: row.agent_id,
        title: row.title,
        pinned: row.pinned === 1,
        createdAt: bigIntNum(row.created_at, "created_at"),
        lastAt: bigIntNum(row.last_at, "last_at"),
        messages,
        updatedAt: bigIntNum(row.updated_at, "updated_at"),
        totalMessageCount: allMsgs.length + archivedCount,
        maxSeq,
        isPartial,
        archivedCount,
        archivedThroughSeq,
      };
    },

    async readArchivedMessages(sessId: string, userId: string, beforeSeq = 0, limit = 100): Promise<ReadArchivedMessagesResult> {
      const cappedLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 100)));
      const row = (
        await pool.query<{ archived_through_seq: number | null }>(
          "SELECT archived_through_seq FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [sessId, userId],
        )
      ).rows[0];
      if (!row) return { messages: [], hasMore: false, oldestSeq: null };
      const watermark = bigIntNumOr(row.archived_through_seq, 0);
      const effectiveBefore = Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : watermark + 1;
      if (effectiveBefore <= 1) return { messages: [], hasMore: false, oldestSeq: null };

      const chunkRows = (
        await pool.query<{ messages: string }>(
          `SELECT messages FROM client_session_archive_chunks
             WHERE session_id = $1 AND user_id = $2 AND first_seq < $3
             ORDER BY last_seq DESC`,
          [sessId, userId, effectiveBefore],
        )
      ).rows;

      const messagePool: MessageLike[] = [];
      for (const cr of chunkRows) {
        let arr: MessageLike[];
        try {
          const parsed = JSON.parse(cr.messages);
          arr = Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
        } catch {
          arr = [];
        }
        for (const m of arr) {
          const s = typeof m?._seq === "number" ? m._seq : -1;
          if (s >= 0 && s < effectiveBefore) messagePool.push(m);
        }
        if (messagePool.length > cappedLimit) break;
      }
      messagePool.sort((a, b) => (a._seq as number) - (b._seq as number));
      const hasMore = messagePool.length > cappedLimit;
      const page = messagePool.slice(Math.max(0, messagePool.length - cappedLimit));
      const oldestSeq = page.length > 0 ? (page[0]._seq as number) : null;
      return { messages: page, hasMore, oldestSeq };
    },

    // ── deleteClientSession(软删 + 归档级联清)──────────────────────────────────
    async deleteClientSession(id: string, userId?: string): Promise<boolean> {
      const now = Date.now();
      return withTx(pool, async (client): Promise<boolean> => {
        // updated_at 逻辑版本推进(软删也让并发 stale PUT 因版本落后被拒)。deleted_at 仍是删除权威。
        const sql = userId
          ? `UPDATE client_sessions SET deleted_at = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}), messages = '[]', message_count = 0 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`
          : `UPDATE client_sessions SET deleted_at = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}), messages = '[]', message_count = 0 WHERE id = $2 AND deleted_at IS NULL`;
        const result = userId
          ? await client.query(sql, [now, id, userId])
          : await client.query(sql, [now, id]);
        if ((result.rowCount ?? 0) === 0) return false;
        // 归档级联清理(同事务,防"主行已删、归档还在"孤儿)。D3:delete 级联也清 parent_session_id
        // 指向该会话的 delegate pending(防永不 drain 的孤儿)。
        await client.query("DELETE FROM client_session_archive_chunks WHERE session_id = $1", [id]);
        await client.query("DELETE FROM client_session_archived_ids WHERE session_id = $1", [id]);
        await client.query("DELETE FROM pending_usage_patches WHERE parent_session_id = $1", [id]);
        return true;
      });
    },

    async renameClientSession(id: string, userId: string, title: string): Promise<{ ok: boolean; updatedAt: number }> {
      const now = Date.now();
      const row = (
        await pool.query<{ updated_at: string }>(
          `UPDATE client_sessions SET title = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
             WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING updated_at`,
          [title, id, userId],
        )
      ).rows[0];
      return { ok: !!row, updatedAt: row ? bigIntNum(row.updated_at, "updated_at") : now };
    },

    async listUnclaimedSessions(): Promise<Array<{
      id: string;
      agentId: string;
      title: string;
      createdAt: number;
      lastAt: number;
      messageCount: number;
      summary: string;
    }>> {
      const rows = (
        await pool.query<{
          id: string;
          agent_id: string;
          title: string;
          created_at: string;
          last_at: string;
          messages: string;
          msg_count: number;
        }>(
          `SELECT id, agent_id, title, created_at, last_at, messages, message_count AS msg_count
             FROM client_sessions WHERE user_id = 'default' AND deleted_at IS NULL ORDER BY last_at DESC`,
        )
      ).rows;
      return rows.map((r) => {
        let summary = "";
        try {
          const msgs = JSON.parse(r.messages) as Array<{ role?: string; text?: string }>;
          const userMsgs = msgs.filter((m) => m.role === "user").slice(0, 3);
          summary = userMsgs.map((m) => (m.text || "").slice(0, 80)).join(" / ");
          if (summary.length > 200) summary = summary.slice(0, 200) + "…";
        } catch {
          /* malformed → 空 summary */
        }
        return {
          id: r.id,
          agentId: r.agent_id,
          title: r.title,
          createdAt: bigIntNum(r.created_at, "created_at"),
          lastAt: bigIntNum(r.last_at, "last_at"),
          messageCount: r.msg_count,
          summary,
        };
      });
    },

    async allMasterWsessRows(): Promise<Array<{ id: string; userId: string; createdAt: number }>> {
      // GLOB 'wsess-[0-9a-f]{16}' 的 PG 等价 = POSIX 正则(锚定 16 hex);origin_channel='wechat'。
      const rows = (
        await pool.query<{ id: string; userId: string; createdAt: string }>(
          `SELECT id, user_id AS "userId", created_at AS "createdAt"
             FROM client_sessions
            WHERE id ~ '^wsess-[0-9a-f]{16}$'
              AND origin_channel = 'wechat'
              AND deleted_at IS NULL`,
        )
      ).rows;
      return rows.map((r) => ({ id: r.id, userId: r.userId, createdAt: bigIntNum(r.createdAt, "created_at") }));
    },

    async upsertMasterClientSession(input: {
      sessionId: string;
      userId: string;
      agentId: string;
      originChannel: "wechat";
      title: string;
      createdAt: number;
      lastAt: number;
    }): Promise<void> {
      // Plain INSERT by design:重复 id 必须抛(dispatcher 补偿链依赖 23505 冒泡),禁 ON CONFLICT。
      // messages/message_count/next_seq/deleted_at/pinned 走列 DEFAULT。
      await pool.query(
        `INSERT INTO client_sessions
           (id, user_id, agent_id, title, created_at, last_at, updated_at, origin_channel)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
        [input.sessionId, input.userId, input.agentId, input.title, input.createdAt, input.lastAt, input.originChannel],
      );
    },

    async softDeleteMasterSession(sessionId: string, userId: string): Promise<boolean> {
      return backend.deleteClientSession(sessionId, userId);
    },

    async claimSession(sessionId: string, userId: string): Promise<boolean> {
      const result = await pool.query(
        `UPDATE client_sessions SET user_id = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
           WHERE id = $2 AND user_id = 'default' AND deleted_at IS NULL`,
        [userId, sessionId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    // ── wechat_bindings(master 六表之一)────────────────────────────────────────
    async listActiveWechatBindings(): Promise<WechatBinding[]> {
      const rows = (await pool.query<WechatRow>("SELECT * FROM wechat_bindings WHERE status = $1", ["active"])).rows;
      return rows.map(rowToBinding);
    },

    async listAllWechatBindings(): Promise<WechatBinding[]> {
      const rows = (await pool.query<WechatRow>("SELECT * FROM wechat_bindings")).rows;
      return rows.map(rowToBinding);
    },

    async getWechatBindingByUserId(userId: string): Promise<WechatBinding | null> {
      const row = (await pool.query<WechatRow>("SELECT * FROM wechat_bindings WHERE user_id = $1", [userId])).rows[0];
      return row ? rowToBinding(row) : null;
    },

    async getWechatBindingByAccountId(accountId: string): Promise<WechatBinding | null> {
      const row = (await pool.query<WechatRow>("SELECT * FROM wechat_bindings WHERE account_id = $1", [accountId])).rows[0];
      return row ? rowToBinding(row) : null;
    },

    async upsertWechatBinding(input: UpsertWechatBindingInput): Promise<void> {
      // D8:RMW(读 owner→继承字段→UPSERT),单事务 + 锁 account/user 行(固定 account→user 序防死锁)。
      // 23505 唯一冲突(account_id 唯一索引)转 WechatAccountAlreadyBoundError(不依赖错误文本)。
      const now = Date.now();
      try {
        await withTx(pool, async (client): Promise<void> => {
          const accountOwner = (
            await client.query<{ user_id: string }>(
              "SELECT user_id FROM wechat_bindings WHERE account_id = $1 FOR UPDATE",
              [input.accountId],
            )
          ).rows[0];
          if (accountOwner && accountOwner.user_id !== input.userId) {
            throw new WechatAccountAlreadyBoundError(input.accountId);
          }
          const existing = (
            await client.query<WechatRow>("SELECT * FROM wechat_bindings WHERE user_id = $1 FOR UPDATE", [input.userId])
          ).rows[0];

          const identityChanged =
            !!existing && (existing.account_id !== input.accountId || existing.bot_token !== input.botToken);
          const buf = input.getUpdatesBuf ?? (identityChanged ? "" : existing?.get_updates_buf ?? "");
          const ctx = JSON.stringify(
            input.contextTokens ?? (identityChanged ? {} : existing ? parseJsonRecord(existing.context_tokens) : {}),
          );
          const wl = JSON.stringify(
            input.whitelist ??
              (identityChanged ? [] : existing ? parseJsonStringArray(existing.whitelist) : [input.loginUserId].filter(Boolean)),
          );
          const status = input.status ?? "active";
          const createdAt = existing ? bigIntNum(existing.created_at, "wechat.created_at") : now;
          const lastEventAt =
            input.lastEventAt ?? (identityChanged ? null : existing ? bigIntNumOrNull(existing.last_event_at) : null);

          await client.query(
            `INSERT INTO wechat_bindings
               (user_id, account_id, login_user_id, bot_token, get_updates_buf, context_tokens, whitelist, status, created_at, updated_at, last_event_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (user_id) DO UPDATE SET
               account_id = EXCLUDED.account_id,
               login_user_id = EXCLUDED.login_user_id,
               bot_token = EXCLUDED.bot_token,
               get_updates_buf = EXCLUDED.get_updates_buf,
               context_tokens = EXCLUDED.context_tokens,
               whitelist = EXCLUDED.whitelist,
               status = EXCLUDED.status,
               updated_at = EXCLUDED.updated_at,
               last_event_at = EXCLUDED.last_event_at`,
            [input.userId, input.accountId, input.loginUserId, input.botToken, buf, ctx, wl, status, createdAt, now, lastEventAt],
          );
        });
      } catch (err) {
        if (err instanceof WechatAccountAlreadyBoundError) throw err;
        // account_id 唯一索引冲突(user 行 PK 走 ON CONFLICT 不会 23505)→ 转专用错误。
        const code = (err as { code?: string })?.code;
        const constraint = (err as { constraint?: string })?.constraint;
        if (code === "23505" && (constraint === "idx_wechat_bindings_account" || constraint === undefined)) {
          throw new WechatAccountAlreadyBoundError(input.accountId);
        }
        throw err;
      }
    },

    async updateWechatBindingCursor(userId: string, getUpdatesBuf: string, contextTokens?: Record<string, string>): Promise<void> {
      const now = Date.now();
      if (contextTokens) {
        await pool.query(
          "UPDATE wechat_bindings SET get_updates_buf = $1, context_tokens = $2, last_event_at = $3, updated_at = $4 WHERE user_id = $5",
          [getUpdatesBuf, JSON.stringify(contextTokens), now, now, userId],
        );
      } else {
        await pool.query("UPDATE wechat_bindings SET get_updates_buf = $1, updated_at = $2 WHERE user_id = $3", [
          getUpdatesBuf,
          now,
          userId,
        ]);
      }
    },

    async updateWechatBindingStatus(userId: string, status: WechatBinding["status"]): Promise<void> {
      const now = Date.now();
      await pool.query("UPDATE wechat_bindings SET status = $1, updated_at = $2 WHERE user_id = $3", [status, now, userId]);
    },

    async deleteWechatBinding(userId: string): Promise<void> {
      await pool.query("DELETE FROM wechat_bindings WHERE user_id = $1", [userId]);
    },
  };

  return backend;
}

// ── advisory lease fencing 下的 usage 聚合 GC(RFC D3)────────────────────────
// 双 master 下 sweepUsageAggregationGc 只能由 fencing 持有者执行:pool.connect() 取**专用连接**
// 独占持 session-level advisory lock(绝不用 pool.query 取锁、持锁期间绝不归还池;连接 error/end
// 立即停 sweep + 重新竞锁;unlock 失败销毁连接)。专用连接纪律复用 db/migrate.ts:118 既有范式。
//
// P3 交接清单:WechatManager 的 long-poll worker 同样需要 advisory lease(session 级)防双 master
// 双跑重复消费 —— **本批不做**(见 RFC D8),在此登记。

export interface SessionsGcSweeperOptions {
  pool: Pool;
  /** sweep 周期(默认 1h)。 */
  intervalMs?: number;
  /** 竞锁失败/掉线后重试间隔(默认 60s)。 */
  recompeteMs?: number;
  now?: () => number;
  onStats?: (stats: UsageAggregationGcStats) => void;
  onError?: (err: unknown) => void;
}

const SWEEP_GC_LEASE_KEY = "oc_sessions_sweep_gc";

/**
 * 启动 advisory-lease 门控的 usage 聚合 GC sweeper。只有竞到固定 key 的 session-level advisory
 * lock 的进程才周期执行 sweep;持锁连接掉线 → 停 sweep → 重竞锁;备者接管。返回 { stop }。
 */
export function startSessionsGcSweeper(opts: SessionsGcSweeperOptions): { stop: () => Promise<void> } {
  const intervalMs = opts.intervalMs ?? 60 * 60_000;
  const recompeteMs = opts.recompeteMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());

  let stopped = false;
  let leaseClient: PoolClient | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let recompeteTimer: ReturnType<typeof setTimeout> | null = null;
  let sweeping = false;

  async function runSweep(): Promise<void> {
    if (stopped || !leaseClient || sweeping) return;
    sweeping = true;
    try {
      // sweep 事务走 pool(普通短事务);lease 连接只负责持锁,不跑业务(避免持锁连接被业务占用)。
      const stats = await withTx(opts.pool, (client) => sweepOnce(client, now()));
      opts.onStats?.(stats);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      sweeping = false;
    }
  }

  function clearSweepTimer(): void {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function scheduleRecompete(): void {
    if (stopped || recompeteTimer) return;
    recompeteTimer = setTimeout(() => {
      recompeteTimer = null;
      void compete();
    }, recompeteMs);
    // 不阻止进程退出。
    if (typeof recompeteTimer === "object" && recompeteTimer && "unref" in recompeteTimer) {
      (recompeteTimer as { unref: () => void }).unref();
    }
  }

  // 持锁连接掉线:停 sweep、销毁该连接(不还池)、重新竞锁。
  function onLeaseClientError(client: PoolClient, err: unknown): void {
    opts.onError?.(err);
    if (client !== leaseClient) return;
    clearSweepTimer();
    leaseClient = null;
    try {
      client.release(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* 已断,忽略 */
    }
    scheduleRecompete();
  }

  async function compete(): Promise<void> {
    if (stopped || leaseClient) return;
    let client: PoolClient;
    try {
      client = await opts.pool.connect();
    } catch (err) {
      opts.onError?.(err);
      scheduleRecompete();
      return;
    }
    // 掉线监听贯穿该连接生命周期(pool 的 connect 已挂 no-op error 防进程崩;此处再挂业务处理)。
    client.on("error", (err) => onLeaseClientError(client, err));
    try {
      const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [
        SWEEP_GC_LEASE_KEY,
      ]);
      if (r.rows[0]?.ok === true) {
        // 竞锁成功 → 成为 fencing 持有者。连接**永不还池**(持 session-level lock)。
        leaseClient = client;
        sweepTimer = setInterval(() => void runSweep(), intervalMs);
        if (typeof sweepTimer === "object" && sweepTimer && "unref" in sweepTimer) {
          (sweepTimer as { unref: () => void }).unref();
        }
      } else {
        // 已有持有者 → 探测连接还池,稍后重竞。
        client.release();
        scheduleRecompete();
      }
    } catch (err) {
      opts.onError?.(err);
      try {
        client.release(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* ignore */
      }
      scheduleRecompete();
    }
  }

  void compete();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearSweepTimer();
      if (recompeteTimer) {
        clearTimeout(recompeteTimer);
        recompeteTimer = null;
      }
      const client = leaseClient;
      leaseClient = null;
      if (client) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [SWEEP_GC_LEASE_KEY]);
          client.release();
        } catch (err) {
          // unlock 失败 → 销毁连接(不还池),防未释放的 session lock 卡后续竞锁。
          try {
            client.release(err instanceof Error ? err : new Error(String(err)));
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}

/** 单次 sweep(map→pending 锁序;供 sweeper 与测试共用)。 */
async function sweepOnce(client: PoolClient, nowMs: number): Promise<UsageAggregationGcStats> {
  const agingThreshold = nowMs - PENDING_AGING_MS;
  const expiredThreshold = nowMs - PENDING_HARD_DELETE_MS;
  const mapThreshold = nowMs - MAP_HARD_DELETE_MS;
  const aging = (
    await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pending_usage_patches WHERE created_at <= $1 AND created_at > $2",
      [agingThreshold, expiredThreshold],
    )
  ).rows[0];
  const delMap = await client.query("DELETE FROM server_authored_request_map WHERE written_at <= $1", [mapThreshold]);
  const delPending = await client.query("DELETE FROM pending_usage_patches WHERE created_at <= $1", [expiredThreshold]);
  return { pendingAging: aging?.n ?? 0, pendingExpired: delPending.rowCount ?? 0, mapExpired: delMap.rowCount ?? 0 };
}
