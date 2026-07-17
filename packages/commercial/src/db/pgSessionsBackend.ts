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
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  LOSSLESS_TURN_TAPE_SHA256_RE,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapePartRequest,
} from "@openclaude/protocol";
import {
  type AppendCostCreditsResult,
  type AppendForRequestResult,
  type ClientSession,
  type ClientSessionLifecycle,
  type ClientSessionLifecycleRef,
  type ClientSessionMeta,
  type ClientSessionPartial,
  type ClientSessionReadOptions,
  type ClientSessionsBackend,
  type DelegatePendingRow,
  compareMessagesByOrder,
  deriveArchivedOrderSeqsForRead,
  deriveOrderSeqsForRead,
  type DrainDelegateCostResult,
  MAX_SESSION_BYTES,
  type MessageLike,
  mergePreservingServerAuthored,
  normalizeAndAssignOrderSeqs,
  normalizeAndAssignSeqs,
  _warnSeqAnomaly,
  planAppendServerAuthored,
  planAppendServerAuthoredBatch,
  planCostPatch,
  planDelegateCostMerge,
  planSpillOverflow,
  projectClientSessionMessagesForChat,
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
import {
  computeGoalTokensUsed,
  materializeLosslessTurn,
  type LosslessTurnRecord,
} from "../http/losslessTurnTape.js";
import { bumpGoalUsageSnapshotForTape } from "../goal/goalStateService.js";

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
  let destroyed = false;
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // ROLLBACK 失败 = 连接处于未知/损坏事务态,**绝不能归还池**(下个借出者会拿到带未回滚
      // 事务的脏连接 → 静默数据错乱)。client.release(err) 传 truthy err → node-postgres 销毁
      // 连接不还池。标记 destroyed 跳过 finally 的正常 release。不遮蔽真正原因(仍抛原 err)。
      destroyed = true;
      try {
        client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      } catch {
        /* 连接已彻底断,忽略 */
      }
    }
    throw err;
  } finally {
    if (!destroyed) client.release();
  }
}

/**
 * Stage an exact turn-cost locator on the caller's existing billing
 * transaction. Keeping the SQL here preserves the sessions-backend ownership
 * boundary while allowing the ledger debit and its refresh-visible locator to
 * commit atomically.
 */
export async function stageUsageCostLocatorInBillingTransaction(
  client: PoolClient,
  args: {
    requestId: string;
    userId: string;
    sessionId: string | null;
    parentSessionId: string | null;
    delegateAgentId: string | null;
    turnKey: string | null;
    parentTurnKey: string | null;
    costCredits: bigint;
  },
): Promise<void> {
  const targetTurnKey = args.parentTurnKey ?? args.turnKey;
  if (targetTurnKey === null || !/^[0-9a-f]{64}$/.test(targetTurnKey)) {
    throw new Error("stageUsageCostLocator: invalid lossless turn key");
  }
  if (args.turnKey !== null && !/^[0-9a-f]{64}$/.test(args.turnKey)) {
    throw new Error("stageUsageCostLocator: invalid turnKey");
  }
  if (args.parentTurnKey !== null && !/^[0-9a-f]{64}$/.test(args.parentTurnKey)) {
    throw new Error("stageUsageCostLocator: invalid parentTurnKey");
  }
  const inserted = await client.query(
    `INSERT INTO pending_usage_patches
       (request_id,user_id,session_id,parent_session_id,delegate_agent_id,
        turn_key,parent_turn_key,cost_credits)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (request_id,user_id) DO NOTHING`,
    [
      args.requestId,
      args.userId,
      args.sessionId,
      args.parentSessionId,
      args.delegateAgentId,
      args.turnKey,
      args.parentTurnKey,
      args.costCredits.toString(),
    ],
  );
  if ((inserted.rowCount ?? 0) !== 0) return;

  const existing = (
    await client.query<{
      session_id: string | null;
      parent_session_id: string | null;
      delegate_agent_id: string | null;
      turn_key: string | null;
      parent_turn_key: string | null;
      cost_credits: string;
    }>(
      `SELECT session_id,parent_session_id,delegate_agent_id,turn_key,
              parent_turn_key,cost_credits
         FROM pending_usage_patches
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [args.requestId, args.userId],
    )
  ).rows[0];
  if (
    !existing ||
    existing.session_id !== args.sessionId ||
    existing.parent_session_id !== args.parentSessionId ||
    existing.delegate_agent_id !== args.delegateAgentId ||
    existing.turn_key !== args.turnKey ||
    existing.parent_turn_key !== args.parentTurnKey ||
    BigInt(existing.cost_credits) !== args.costCredits
  ) {
    throw new Error("stageUsageCostLocator: immutable lossless cost locator conflict");
  }
}

export interface SettledUsageAttribution {
  usageId: bigint;
  ledgerId: bigint | null;
  attributionCredits: bigint | null;
}

/**
 * Read the immutable settlement proof together with its lossless-turn cost
 * locator. This query belongs to the PG sessions backend because the locator
 * can be in either pending_usage_patches or its folded tape component.
 *
 * The runner may be the caller's PoolClient after a 23505 rollback, or a fresh
 * Pool checkout used to prove an indeterminate COMMIT. The outer usage_records
 * table intentionally stays unaliased: besides keeping the query simple, this
 * preserves the long-standing fault-injection matcher used by finalizer tests.
 */
export async function loadSettledUsageAttribution(
  runner: Pool | PoolClient,
  userId: bigint,
  requestId: string,
): Promise<SettledUsageAttribution | null> {
  const storageUserId = `c:${userId.toString()}`;
  const row = (await runner.query<{
    id: string;
    ledger_id: string | null;
    attribution_credits: string | null;
  }>(
    `SELECT usage_records.id::text AS id,
            usage_records.ledger_id::text AS ledger_id,
            COALESCE(
              (SELECT p.cost_credits FROM pending_usage_patches p
                WHERE p.user_id=$3 AND p.request_id=usage_records.request_id),
              (SELECT c.cost_credits::text FROM turn_tape_cost_components c
                WHERE c.user_id=$3 AND c.request_id=usage_records.request_id)
            ) AS attribution_credits
       FROM usage_records WHERE user_id=$1 AND request_id=$2`,
    [userId.toString(), requestId, storageUserId],
  )).rows[0];
  if (!row) return null;
  return {
    usageId: BigInt(row.id),
    ledgerId: row.ledger_id === null ? null : BigInt(row.ledger_id),
    attributionCredits:
      row.attribution_credits == null ? null : BigInt(row.attribution_credits),
  };
}

/** Read only the exact debit attribution used by durable bridge repair. */
export async function loadUsageAttributionCredits(
  runner: Pool | PoolClient,
  userId: bigint,
  requestId: string,
): Promise<bigint | null> {
  return (await loadSettledUsageAttribution(runner, userId, requestId))
    ?.attributionCredits ?? null;
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
// 带 key 且读路径永不可达(无任何 finalized tape 匹配 turn_key/parent_turn_key)的滞留行:
// 7d 后清除。窗口远大于 tape fsync 重试与 durable 计费 24h SLA——7d 后不再有 finalize
// 会来消费它;若 tape 在删除后才 finalize(理论窗口),该 turn 仅损失积分徽章展示,
// 结算真相在 usage_records/ledger 不受影响。
const PENDING_UNREACHABLE_DELETE_MS = 7 * 24 * 60 * 60_000;
// 已 finalize tape 的原始分片(parts 存的是脱敏前 payload;records 才是脱敏后权威):
// finalize 事务内即删,本常量只兜历史存量与删除失败残留。48h 覆盖任何滚动升级重放窗口。
const FINALIZED_TAPE_PARTS_DELETE_MS = 48 * 60 * 60_000;

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
  ["pending_usage_patches", "turn_key", "text"],
  ["client_session_turn_tapes", "tape_id", "text"],
  ["client_session_turn_tapes", "turn_key", "text"],
  ["client_session_turn_tapes", "engine_billings", "jsonb"],
  ["client_session_turn_tapes", "goal_id", "uuid"],
  ["client_session_turn_tapes", "goal_state_revision", "bigint"],
  ["client_session_turn_tapes", "goal_tokens_used", "bigint"],
  ["client_session_turn_tapes", "record_storage_format", "smallint"],
  ["client_session_turn_tape_parts", "payload", "bytea"],
  ["client_session_turn_tape_records", "payload", "bytea"],
  ["server_authored_turn_anchor_map", "turn_key", "text"],
  ["turn_tape_cost_components", "request_id", "text"],
  ["session_goals", "session_id", "text"],
  ["session_goals", "goal_id", "uuid"],
  ["session_goals", "state_revision", "bigint"],
  ["session_goals", "snapshot_revision", "bigint"],
  ["wechat_bindings", "user_id", "text"],
  ["wechat_bindings", "account_id", "text"],
  ["wechat_bindings", "bot_token", "text"],
];

export interface PgSessionsBackendOptions {
  /** 启动时快照的权威 generation(RFC D5:probe 复核 marker 未漂移)。 */
  expectedGeneration: number;
  /** Runs only after the owning tape/cost transaction commits. Failures are
   * projection-only and must never turn a committed billing write into retry. */
  onGoalUsageChanged?: (userId: string, sessionId: string) => void | Promise<void>;
}

type GoalUsageChange = { userId: string; sessionId: string };

async function notifyGoalUsageChanges(
  callback: PgSessionsBackendOptions["onGoalUsageChanged"],
  changes: readonly GoalUsageChange[],
): Promise<void> {
  if (!callback || changes.length === 0) return;
  const unique = new Map(changes.map((change) => [`${change.userId}\0${change.sessionId}`, change]));
  await Promise.allSettled(
    [...unique.values()].map((change) => Promise.resolve(callback(change.userId, change.sessionId))),
  );
}

export type LosslessTurnTapeStageResult =
  | { applied: "stored" | "idempotent" }
  | { applied: "session_not_found" | "session_deleted" };

export type LosslessTurnTapeFinalizeResult =
  | {
      applied: "finalized" | "idempotent";
      recordCount: number;
      engineBillings: DurableCodexBilling[];
    }
  | { applied: "session_not_found" | "session_deleted" | "incomplete" };

export interface LosslessTurnTapeStorage {
  stageLosslessTurnTapePart(
    userId: string,
    request: LosslessTurnTapePartRequest,
    payload: Buffer,
  ): Promise<LosslessTurnTapeStageResult>;
  finalizeLosslessTurnTape(
    userId: string,
    request: LosslessTurnTapeFinalizeRequest,
  ): Promise<LosslessTurnTapeFinalizeResult>;
}

export type PgSessionsBackend = ClientSessionsBackend & LosslessTurnTapeStorage;

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tapeAnchor(
  billingRecord: LosslessTurnRecord,
  tapeId: string,
  tapeSha256: string,
  physicalRecordCount: number,
  logicalRecordCount: number,
  runtimeBatchManifestSha256: string | undefined,
  structuredRoles: string[],
): MessageLike & { id: string } {
  return {
    // Reuse the billing record id so legacy request-id cost patching and the
    // exact turn-key map both have one stable hot-row locator.
    id: billingRecord.id,
    role: billingRecord.role,
    ts: billingRecord.ts,
    _source: "server",
    _turnTapeId: tapeId,
    _turnTapeSha256: tapeSha256,
    _turnTapeComplete: true,
    // _turnTapeRecordCount remains the rolling-compatible physical DB count.
    _turnTapeRecordCount: physicalRecordCount,
    _turnTapePhysicalRecordCount: physicalRecordCount,
    _turnTapeLogicalRecordCount: logicalRecordCount,
    ...(runtimeBatchManifestSha256
      ? { _turnTapeRuntimeManifestSha256: runtimeBatchManifestSha256 }
      : {}),
    ...(structuredRoles.length > 0 ? { _turnTapeStructuredRoles: structuredRoles } : {}),
  };
}

type HydratedTapeRow = {
  tape_id: string;
  tape_sha256: string;
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
  cost_credits: string;
  delegate_costs: unknown;
};

function hydrateTapeRecord(
  row: HydratedTapeRow,
  anchor: MessageLike,
  requireRecordHash: boolean,
  /** true = 来自 complete anchor 的展开(整 turn 已原子落库)。前端同步权威传播(P2 载荷自证)
   *  只认携带 `_turnTapeComplete:true` 的行作证——rolling per-record 兼容路径(pre-release
   *  逐行 refs)同样有 _turnTapeId,但单行不构成整 turn 覆盖证明,不得盖此标记。 */
  fromCompleteAnchor = false,
): MessageLike {
  const payloadBytes = Buffer.from(row.payload);
  const actualSha = sha256Bytes(payloadBytes);
  if (
    actualSha !== row.content_sha256 ||
    (requireRecordHash && actualSha !== anchor._turnTapeSha256)
  ) {
    throw new Error(`[pgSessions] lossless turn tape record hash mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  let full: MessageLike;
  try {
    const parsed = JSON.parse(payloadBytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    full = parsed as MessageLike;
  } catch (err) {
    throw new Error(
      `[pgSessions] lossless turn tape record malformed: ${row.tape_id}\0${row.msg_id}: ${(err as Error).message}`,
    );
  }
  const recordUsage = full.usage && typeof full.usage === "object"
    ? full.usage as Record<string, unknown>
    : {};
  const anchorUsage = full.id === anchor.id && anchor.usage && typeof anchor.usage === "object"
    ? anchor.usage as Record<string, unknown>
    : {};
  const exactCostUsage = BigInt(row.cost_credits) > 0n ? { costCredits: row.cost_credits } : {};
  const exactDelegates = Array.isArray(row.delegate_costs)
    ? row.delegate_costs.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        return typeof item.agentId === "string" &&
          typeof item.costCredits === "string" && /^\d+$/.test(item.costCredits)
          ? [{ agentId: item.agentId, costCredits: item.costCredits }]
          : [];
      })
    : [];
  const exactDelegateUsage = exactDelegates.length > 0 ? { delegates: exactDelegates } : {};
  return {
    ...full,
    _source: "server",
    // Hydration is a read projection, not another hot-row authority record.
    // Mark expanded rows so a later browser PUT can discard them and keep the
    // single constant-size tape anchor instead of copying all generated bytes
    // back into client_sessions.messages.
    _turnTapeId: row.tape_id,
    _turnTapeMsgId: row.msg_id,
    _turnTapeSha256: row.tape_sha256,
    _turnTapeExpanded: true,
    ...(fromCompleteAnchor ? { _turnTapeComplete: true } : {}),
    // A tape is one atomic sync unit. Expanded records intentionally share
    // its anchor sequence: partial sync either returns every record or none.
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
    ...(Object.keys(recordUsage).length > 0 ||
        Object.keys(anchorUsage).length > 0 ||
        Object.keys(exactCostUsage).length > 0 ||
        Object.keys(exactDelegateUsage).length > 0
      ? { usage: { ...recordUsage, ...anchorUsage, ...exactCostUsage, ...exactDelegateUsage } }
      : {}),
  };
}

type HydratedRuntimeBatchDescriptor = {
  batchId: string;
  logicalCount: number;
  manifestSha256: string;
};

function expandHydratedRuntimeBatch(
  hydrated: MessageLike,
  row: HydratedTapeRow,
  anchor: MessageLike,
): { messages: MessageLike[]; descriptor?: HydratedRuntimeBatchDescriptor } {
  const rawBatch = hydrated._runtimeEventBatch;
  if (rawBatch === undefined) return { messages: [hydrated] };
  if (!rawBatch || typeof rawBatch !== "object" || Array.isArray(rawBatch)) {
    throw new Error(`[pgSessions] lossless runtime batch malformed: ${row.tape_id}\0${row.msg_id}`);
  }
  const batch = rawBatch as Record<string, unknown>;
  const manifest = batch.manifest;
  const logicalCount = batch.logicalCount;
  const uncompressedBytes = batch.uncompressedBytes;
  const compressedBytes = batch.compressedBytes;
  const manifestSha256 = batch.manifestSha256;
  const data = batch.data;
  if (
    batch.version !== 1 ||
    batch.encoding !== "gzip+base64" ||
    !Array.isArray(manifest) ||
    typeof logicalCount !== "number" || !Number.isSafeInteger(logicalCount) || logicalCount < 1 ||
    manifest.length !== logicalCount ||
    typeof uncompressedBytes !== "number" || !Number.isSafeInteger(uncompressedBytes) || uncompressedBytes < 0 ||
    typeof compressedBytes !== "number" || !Number.isSafeInteger(compressedBytes) || compressedBytes < 0 ||
    typeof manifestSha256 !== "string" || !LOSSLESS_TURN_TAPE_SHA256_RE.test(manifestSha256) ||
    typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error(`[pgSessions] lossless runtime batch header invalid: ${row.tape_id}\0${row.msg_id}`);
  }
  if (sha256Bytes(Buffer.from(JSON.stringify(manifest), "utf8")) !== manifestSha256) {
    throw new Error(`[pgSessions] lossless runtime batch manifest hash mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  const compressed = Buffer.from(data, "base64");
  if (compressed.length !== compressedBytes) {
    throw new Error(`[pgSessions] lossless runtime batch compressed length mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(compressed);
  } catch (err) {
    throw new Error(
      `[pgSessions] lossless runtime batch gzip invalid: ${row.tape_id}\0${row.msg_id}: ${(err as Error).message}`,
    );
  }
  if (raw.length !== uncompressedBytes) {
    throw new Error(`[pgSessions] lossless runtime batch raw length mismatch: ${row.tape_id}\0${row.msg_id}`);
  }

  const messages: MessageLike[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < manifest.length; index++) {
    const value = manifest[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`[pgSessions] lossless runtime batch manifest entry invalid: ${row.tape_id}\0${row.msg_id}\0${index}`);
    }
    const entry = value as Record<string, unknown>;
    const id = entry.id;
    const eventOrdinal = entry.eventOrdinal;
    const ts = entry.ts;
    const source = entry.source;
    const offset = entry.offset;
    const length = entry.length;
    const payloadSha256 = entry.payloadSha256;
    if (
      typeof id !== "string" || id.length === 0 ||
      typeof eventOrdinal !== "number" || !Number.isSafeInteger(eventOrdinal) || eventOrdinal < 0 ||
      typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0 ||
      (source !== "ccb" && source !== "codex-jsonrpc" && source !== "gateway") ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset !== expectedOffset ||
      typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      typeof payloadSha256 !== "string" || !LOSSLESS_TURN_TAPE_SHA256_RE.test(payloadSha256) ||
      offset + length > raw.length
    ) {
      throw new Error(`[pgSessions] lossless runtime batch manifest entry invalid: ${row.tape_id}\0${row.msg_id}\0${index}`);
    }
    const payloadBytes = raw.subarray(offset, offset + length);
    expectedOffset += length;
    if (sha256Bytes(payloadBytes) !== payloadSha256) {
      throw new Error(`[pgSessions] lossless runtime batch record hash mismatch: ${row.tape_id}\0${id}`);
    }
    let payload: MessageLike;
    try {
      const parsed = JSON.parse(payloadBytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as MessageLike;
    } catch (err) {
      throw new Error(
        `[pgSessions] lossless runtime batch record malformed: ${row.tape_id}\0${id}: ${(err as Error).message}`,
      );
    }
    if (
      payload.id !== id || payload.role !== "runtime-event" || payload.ts !== ts ||
      payload._ocEventOrdinal !== eventOrdinal || payload._runtimeSource !== source
    ) {
      throw new Error(`[pgSessions] lossless runtime batch record identity mismatch: ${row.tape_id}\0${id}`);
    }
    messages.push({
      ...payload,
      _source: "server",
      _turnTapeId: row.tape_id,
      _turnTapeMsgId: id,
      _turnTapePhysicalMsgId: row.msg_id,
      _turnTapeSha256: row.tape_sha256,
      _turnTapeExpanded: true,
      ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
      ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
    });
  }
  if (expectedOffset !== raw.length) {
    throw new Error(`[pgSessions] lossless runtime batch manifest coverage mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  const batchUsage = hydrated.usage && typeof hydrated.usage === "object"
    ? hydrated.usage
    : undefined;
  if (batchUsage && messages.length > 0) messages.at(-1)!.usage = batchUsage;
  return {
    messages,
    descriptor: { batchId: row.msg_id, logicalCount, manifestSha256 },
  };
}

async function hydrateTurnTapeMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
  messages: MessageLike[],
  options: ClientSessionReadOptions = {},
): Promise<MessageLike[]> {
  const refs = messages.filter(
    (m) =>
      m &&
      typeof m._turnTapeId === "string" &&
      typeof m._turnTapeSha256 === "string",
  );
  if (refs.length === 0) return messages;
  const tapeIds = [...new Set(refs.map((m) => m._turnTapeId as string))];
  const exact = options.projection !== "chat";
  const counts = exact
    ? new Map<string, { count: number; tapeSha256: string }>()
    : new Map(
        (
          await pool.query<{ tape_id: string; tape_sha256: string; record_count: string }>(
            `SELECT r.tape_id, t.tape_sha256, COUNT(*)::text AS record_count
               FROM client_session_turn_tape_records r
               JOIN client_session_turn_tapes t
                 ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
              WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
              GROUP BY r.tape_id, t.tape_sha256`,
            [sessionId, userId, tapeIds],
          )
        ).rows.map((row) => [
          row.tape_id,
          { count: Number(row.record_count), tapeSha256: row.tape_sha256 },
        ]),
      );
  const exactRows = exact
    ? (
        await pool.query<HydratedTapeRow>(
      `SELECT r.tape_id, t.tape_sha256, r.msg_id, r.ordinal,
              r.role, r.content_sha256, r.payload,
              COALESCE((
                SELECT SUM(exact_cost.cost_credits)::text
                  FROM (
                    SELECT c.cost_credits::numeric AS cost_credits
                      FROM turn_tape_cost_components c
                     WHERE c.user_id=r.user_id AND c.session_id=r.session_id
                       AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id
                    UNION ALL
                    SELECT p.cost_credits::numeric AS cost_credits
                      FROM pending_usage_patches p
                     WHERE p.user_id=r.user_id
                       AND r.msg_id=t.billing_anchor_id
                       AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                  ) exact_cost
              ), '0') AS cost_credits,
              COALESCE((
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'agentId', grouped.delegate_agent_id,
                           'costCredits', grouped.cost_credits
                         ) ORDER BY grouped.delegate_agent_id
                       )
                  FROM (
                    SELECT exact_delegate.delegate_agent_id,
                           SUM(exact_delegate.cost_credits)::text AS cost_credits
                      FROM (
                        SELECT c.delegate_agent_id, c.cost_credits::numeric AS cost_credits
                          FROM turn_tape_cost_components c
                         WHERE c.user_id=r.user_id AND c.session_id=r.session_id
                           AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id
                        UNION ALL
                        SELECT p.delegate_agent_id, p.cost_credits::numeric AS cost_credits
                          FROM pending_usage_patches p
                         WHERE p.user_id=r.user_id
                           AND r.msg_id=t.billing_anchor_id
                           AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                      ) exact_delegate
                     WHERE exact_delegate.delegate_agent_id IS NOT NULL
                     GROUP BY exact_delegate.delegate_agent_id
                  ) grouped
              ), '[]'::jsonb) AS delegate_costs
         FROM client_session_turn_tape_records r
         JOIN client_session_turn_tapes t
           ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
        WHERE r.session_id = $1 AND r.user_id = $2 AND r.tape_id = ANY($3::text[])
        ORDER BY r.tape_id, r.ordinal`,
      [sessionId, userId, tapeIds],
        )
      ).rows
    : [];
  const chatVisibleRows = !exact
    ? (
        await pool.query<HydratedTapeRow>(
          `SELECT r.tape_id, t.tape_sha256, r.msg_id, r.ordinal,
                  r.role, r.content_sha256, r.payload,
                  COALESCE((
                    SELECT SUM(exact_cost.cost_credits)::text
                      FROM (
                        SELECT c.cost_credits::numeric AS cost_credits
                          FROM turn_tape_cost_components c
                         WHERE c.user_id=r.user_id AND c.session_id=r.session_id
                           AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id
                        UNION ALL
                        SELECT p.cost_credits::numeric AS cost_credits
                          FROM pending_usage_patches p
                         WHERE p.user_id=r.user_id
                           AND r.msg_id=t.billing_anchor_id
                           AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                      ) exact_cost
                  ), '0') AS cost_credits,
                  COALESCE((
                    SELECT jsonb_agg(
                             jsonb_build_object(
                               'agentId', grouped.delegate_agent_id,
                               'costCredits', grouped.cost_credits
                             ) ORDER BY grouped.delegate_agent_id
                           )
                      FROM (
                        SELECT exact_delegate.delegate_agent_id,
                               SUM(exact_delegate.cost_credits)::text AS cost_credits
                          FROM (
                            SELECT c.delegate_agent_id, c.cost_credits::numeric AS cost_credits
                              FROM turn_tape_cost_components c
                             WHERE c.user_id=r.user_id AND c.session_id=r.session_id
                               AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id
                            UNION ALL
                            SELECT p.delegate_agent_id, p.cost_credits::numeric AS cost_credits
                              FROM pending_usage_patches p
                             WHERE p.user_id=r.user_id
                               AND r.msg_id=t.billing_anchor_id
                               AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                          ) exact_delegate
                         WHERE exact_delegate.delegate_agent_id IS NOT NULL
                         GROUP BY exact_delegate.delegate_agent_id
                      ) grouped
                  ), '[]'::jsonb) AS delegate_costs
             FROM client_session_turn_tape_records r
             JOIN client_session_turn_tapes t
               ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
            WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
              AND r.role <> 'runtime-event'
            ORDER BY r.tape_id, r.ordinal`,
          [sessionId, userId, tapeIds],
        )
      ).rows
    : [];
  const chatTailRows = !exact
    ? (
        await pool.query<HydratedTapeRow>(
          `WITH candidates AS MATERIALIZED (
             SELECT r.*, t.tape_sha256, t.created_at AS tape_created_at
               FROM client_session_turn_tape_records r
               JOIN client_session_turn_tapes t
                 ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
              WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
                AND r.role='runtime-event'
                AND position(convert_to('"subtype":"bash_output_tail"', 'UTF8') in r.payload)>0
           ), parsed AS (
             SELECT candidates.*,
                    regexp_replace(
                      regexp_replace(
                        convert_from(payload, 'UTF8'),
                        '(?<=\\\\)u0000', 'uFFFD', 'g'
                      ),
                      '(?<=\\\\)u[dD][89a-fA-F][0-9a-fA-F]{2}', 'uFFFD', 'g'
                    )::jsonb AS body
               FROM candidates
           ), eligible AS (
             SELECT parsed.*,
                    COALESCE(body #>> '{_runtimeEvent,parent_tool_use_id}', '') AS parent_tool_use_id,
                    body #>> '{_runtimeEvent,tool_use_id}' AS tool_use_id,
                    GREATEST(
                      CASE WHEN jsonb_typeof(body #> '{_runtimeEvent,total_bytes}')='number'
                           THEN (body #>> '{_runtimeEvent,total_bytes}')::numeric ELSE 0 END,
                      0
                    ) AS projected_total_bytes
               FROM parsed
              WHERE jsonb_typeof(body #> '{_runtimeEvent,type}')='string'
                AND body #>> '{_runtimeEvent,type}'='system'
                AND jsonb_typeof(body #> '{_runtimeEvent,subtype}')='string'
                AND body #>> '{_runtimeEvent,subtype}'='bash_output_tail'
                AND jsonb_typeof(body #> '{_runtimeEvent,tool_use_id}')='string'
                AND body #>> '{_runtimeEvent,tool_use_id}' ~ '^[A-Za-z0-9_-]+$'
                AND (
                  body #> '{_runtimeEvent,parent_tool_use_id}' IS NULL
                  OR body #> '{_runtimeEvent,parent_tool_use_id}'='null'::jsonb
                  OR (
                    jsonb_typeof(body #> '{_runtimeEvent,parent_tool_use_id}')='string'
                    AND (
                      body #>> '{_runtimeEvent,parent_tool_use_id}'=''
                      OR body #>> '{_runtimeEvent,parent_tool_use_id}' ~ '^[A-Za-z0-9_-]+$'
                    )
                  )
                )
           ), ranked AS (
             SELECT eligible.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY parent_tool_use_id, tool_use_id
                      ORDER BY
                        projected_total_bytes DESC,
                        ts DESC NULLS LAST, tape_created_at DESC NULLS LAST,
                        ordinal DESC, tape_id DESC, msg_id DESC
                    ) AS winner
               FROM eligible
           )
           SELECT tape_id, tape_sha256, msg_id, ordinal, role,
                  content_sha256, payload, '0'::text AS cost_credits,
                  '[]'::jsonb AS delegate_costs
             FROM ranked WHERE winner=1
            ORDER BY tape_created_at, ordinal, tape_id, msg_id`,
          [sessionId, userId, tapeIds],
        )
      ).rows
    : [];
  const rows = exact ? exactRows : [...chatVisibleRows, ...chatTailRows];
  const byKey = new Map(rows.map((row) => [`${row.tape_id}\0${row.msg_id}`, row]));
  const byTape = new Map<string, HydratedTapeRow[]>();
  for (const row of rows) {
    const tapeRows = byTape.get(row.tape_id) ?? [];
    tapeRows.push(row);
    byTape.set(row.tape_id, tapeRows);
  }

  const hydrated = messages.flatMap((anchor) => {
    if (
      typeof anchor?._turnTapeId !== "string" ||
      typeof anchor?._turnTapeSha256 !== "string"
    ) {
      return [anchor];
    }
    if (anchor._turnTapeComplete === true) {
      const tapeRows = byTape.get(anchor._turnTapeId);
      if (exact && (!tapeRows || tapeRows.length === 0)) {
        throw new Error(`[pgSessions] lossless turn tape records missing: ${anchor._turnTapeId}`);
      }
      const expectedCount = anchor._turnTapeRecordCount;
      const expectedPhysicalCount = anchor._turnTapePhysicalRecordCount;
      const projectedMeta = counts.get(anchor._turnTapeId);
      const actualCount = exact ? tapeRows?.length : projectedMeta?.count;
      if (
        typeof expectedCount !== "number" ||
        !Number.isSafeInteger(expectedCount) ||
        expectedCount <= 0 ||
        actualCount !== expectedCount
      ) {
        throw new Error(`[pgSessions] lossless turn tape record count mismatch: ${anchor._turnTapeId}`);
      }
      if (
        expectedPhysicalCount !== undefined &&
        (typeof expectedPhysicalCount !== "number" ||
          !Number.isSafeInteger(expectedPhysicalCount) ||
          expectedPhysicalCount !== expectedCount)
      ) {
        throw new Error(`[pgSessions] lossless turn tape physical count mismatch: ${anchor._turnTapeId}`);
      }
      if (tapeRows?.some((row) => row.tape_sha256 !== anchor._turnTapeSha256)) {
        throw new Error(`[pgSessions] lossless turn tape aggregate hash mismatch: ${anchor._turnTapeId}`);
      }
      if (!exact && projectedMeta?.tapeSha256 !== anchor._turnTapeSha256) {
        throw new Error(`[pgSessions] lossless turn tape aggregate hash mismatch: ${anchor._turnTapeId}`);
      }
      if (!tapeRows || tapeRows.length === 0) {
        return [{
          ...anchor,
          id: `projection-source:${anchor._turnTapeId}`,
          role: "runtime-event",
          text: "",
          _turnTapeExpanded: true,
        }];
      }
      if (!exact) return tapeRows.map((row) => hydrateTapeRecord(row, anchor, false, true));
      const expanded: MessageLike[] = [];
      const batchDescriptors: HydratedRuntimeBatchDescriptor[] = [];
      for (const row of tapeRows) {
        const result = expandHydratedRuntimeBatch(
          hydrateTapeRecord(row, anchor, false, true),
          row,
          anchor,
        );
        expanded.push(...result.messages);
        if (result.descriptor) batchDescriptors.push(result.descriptor);
      }
      const expectedLogicalCount = anchor._turnTapeLogicalRecordCount;
      if (
        expectedLogicalCount !== undefined &&
        (typeof expectedLogicalCount !== "number" ||
          !Number.isSafeInteger(expectedLogicalCount) ||
          expectedLogicalCount <= 0 ||
          expanded.length !== expectedLogicalCount)
      ) {
        throw new Error(`[pgSessions] lossless turn tape logical count mismatch: ${anchor._turnTapeId}`);
      }
      const expectedManifestSha = anchor._turnTapeRuntimeManifestSha256;
      if (expectedManifestSha !== undefined) {
        if (
          typeof expectedManifestSha !== "string" ||
          !LOSSLESS_TURN_TAPE_SHA256_RE.test(expectedManifestSha) ||
          batchDescriptors.length === 0 ||
          sha256Bytes(Buffer.from(JSON.stringify(batchDescriptors), "utf8")) !== expectedManifestSha
        ) {
          throw new Error(`[pgSessions] lossless turn tape runtime manifest mismatch: ${anchor._turnTapeId}`);
        }
      } else if (batchDescriptors.length > 0) {
        throw new Error(`[pgSessions] lossless turn tape runtime manifest missing: ${anchor._turnTapeId}`);
      }
      return expanded;
    }

    // Rolling compatibility with any per-record refs staged by an earlier
    // pre-release runtime build.
    if (typeof anchor._turnTapeMsgId !== "string") {
      throw new Error(`[pgSessions] lossless turn tape anchor malformed: ${anchor._turnTapeId}`);
    }
    const key = `${anchor._turnTapeId}\0${anchor._turnTapeMsgId}`;
    const row = byKey.get(key);
    if (!row && !exact) {
      return [{ ...anchor, role: "runtime-event", text: "", _turnTapeExpanded: true }];
    }
    if (!row) throw new Error(`[pgSessions] lossless turn tape record missing: ${key}`);
    return [hydrateTapeRecord(row, anchor, true)];
  });

  // A CCB background Bash process can emit tail snapshots after its owning
  // model turn has finalized. Those exact raw messages live in immutable
  // runtime-event continuation tapes. Reapply every monotonic snapshot to the
  // same tool projection the live reducer updated, while retaining the hidden
  // runtime-event rows themselves for byte-exact inspection/replay.
  const topLevelTools = new Map<string, MessageLike>();
  const childTools = new Map<string, Record<string, unknown>>();
  const indexChildTools = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const rawBlock of blocks) {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) continue;
      const block = rawBlock as Record<string, unknown>;
      if (block.kind === "tool_use" && typeof block.blockId === "string") {
        childTools.set(block.blockId, block);
      }
      indexChildTools(block.childBlocks);
    }
  };
  for (const message of hydrated) {
    if (message.role === "tool" && typeof message.blockId === "string") {
      topLevelTools.set(message.blockId, message);
    }
    indexChildTools(message.childBlocks);
  }
  if (exact) {
    for (const message of hydrated) {
      if (message.role !== "runtime-event") continue;
      const runtime = message._runtimeEvent;
      if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) continue;
      const raw = runtime as Record<string, unknown>;
      if (raw.type !== "system" || raw.subtype !== "bash_output_tail") continue;
      const toolUseId = raw.tool_use_id;
      if (typeof toolUseId !== "string" || toolUseId.length === 0) continue;
      const target = typeof raw.parent_tool_use_id === "string" && raw.parent_tool_use_id.length > 0
        ? childTools.get(toolUseId)
        : topLevelTools.get(toolUseId) ?? childTools.get(toolUseId);
      if (!target) continue;
      const totalBytes = typeof raw.total_bytes === "number" && Number.isFinite(raw.total_bytes)
        ? raw.total_bytes
        : 0;
      const previous = target.bashTail;
      const previousBytes = previous && typeof previous === "object" && !Array.isArray(previous) &&
        typeof (previous as Record<string, unknown>).totalBytes === "number"
        ? (previous as Record<string, unknown>).totalBytes as number
        : 0;
      if (totalBytes < previousBytes) continue;
      target.bashTail = {
        tail: typeof raw.tail === "string" ? raw.tail : "",
        totalBytes,
        truncatedHead: raw.truncated_head === true,
      };
    }
  }
  return exact ? hydrated : projectClientSessionMessagesForChat(hydrated);
}

/**
 * 构造 master 会话权威的 PG backend。返回对象结构化满足 `ClientSessionsBackend`(27 方法),
 * 由 registerCommercial 注入。方法内闭包持有 pool。
 */
export function createPgSessionsBackend(
  pool: Pool,
  options: PgSessionsBackendOptions,
): PgSessionsBackend {
  const expectedGeneration = options.expectedGeneration;

  const backend: PgSessionsBackend = {
    async stageLosslessTurnTapePart(
      userId: string,
      request: LosslessTurnTapePartRequest,
      payload: Buffer,
    ): Promise<LosslessTurnTapeStageResult> {
      return withTx(pool, async (client) => {
        const session = (
          await client.query<{ deleted_at: string | null }>(
            "SELECT deleted_at FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
            [request.sessionId, userId],
          )
        ).rows[0];
        if (!session) return { applied: "session_not_found" };
        if (session.deleted_at !== null) return { applied: "session_deleted" };

        const existingTape = (
          await client.query<{
            agent_id: string;
            turn_index: number;
            status: string;
            turn_key: string;
            tape_sha256: string;
            total_bytes: string;
            part_count: number;
            created_at: string;
            finalized_at: string | null;
          }>(
            `SELECT agent_id, turn_index, status, turn_key, tape_sha256,
                    total_bytes, part_count, created_at, finalized_at
               FROM client_session_turn_tapes
              WHERE session_id = $1 AND user_id = $2 AND tape_id = $3
              FOR UPDATE`,
            [request.sessionId, userId, request.tapeId],
          )
        ).rows[0];
        if (existingTape) {
          const same =
            existingTape.agent_id === request.agentId &&
            existingTape.turn_index === request.turnIndex &&
            existingTape.status === request.status &&
            existingTape.turn_key === request.turnKey &&
            existingTape.tape_sha256 === request.tapeSha256 &&
            bigIntNum(existingTape.total_bytes, "turn_tape.total_bytes") === request.totalBytes &&
            existingTape.part_count === request.partCount &&
            bigIntNum(existingTape.created_at, "turn_tape.created_at") === request.createdAt;
          if (!same) throw new Error("lossless turn tape immutable header conflict");
          // Finalization already materialized sanitized records and billing.
          // A rolling old writer may retry raw parts after we privacy-purged
          // them; acknowledge the immutable header without re-storing bytes.
          if (existingTape.finalized_at !== null) return { applied: "idempotent" };
        } else {
          await client.query(
            `INSERT INTO client_session_turn_tapes
               (session_id, user_id, tape_id, agent_id, turn_index, status,
                turn_key, tape_sha256, total_bytes, part_count, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              request.sessionId,
              userId,
              request.tapeId,
              request.agentId,
              request.turnIndex,
              request.status,
              request.turnKey,
              request.tapeSha256,
              request.totalBytes,
              request.partCount,
              request.createdAt,
            ],
          );
        }

        const existingPart = (
          await client.query<{ part_sha256: string; payload: Buffer }>(
            `SELECT part_sha256, payload
               FROM client_session_turn_tape_parts
              WHERE session_id = $1 AND user_id = $2 AND tape_id = $3 AND part_index = $4
              FOR UPDATE`,
            [request.sessionId, userId, request.tapeId, request.partIndex],
          )
        ).rows[0];
        if (existingPart) {
          const same =
            existingPart.part_sha256 === request.partSha256 &&
            Buffer.from(existingPart.payload).equals(payload);
          if (!same) throw new Error("lossless turn tape immutable part conflict");
          return { applied: "idempotent" };
        }
        await client.query(
          `INSERT INTO client_session_turn_tape_parts
             (session_id, user_id, tape_id, part_index, part_sha256, payload, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [request.sessionId, userId, request.tapeId, request.partIndex, request.partSha256, payload, Date.now()],
        );
        return { applied: "stored" };
      });
    },

    async finalizeLosslessTurnTape(
      userId: string,
      request: LosslessTurnTapeFinalizeRequest,
    ): Promise<LosslessTurnTapeFinalizeResult> {
      let goalUsageChanged = false;
      const result = await withTx(pool, async (client): Promise<LosslessTurnTapeFinalizeResult> => {
        // Serializes "cost parks while tape finalizes" on the logical turn.
        await requestAdvisoryXactLock(client, userId, `turn:${request.turnKey}`);
        const session = (
          await client.query<SessionWriteRow>(
            `SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count
               FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [request.sessionId, userId],
          )
        ).rows[0];
        if (!session) return { applied: "session_not_found" };
        if (session.deleted_at !== null) return { applied: "session_deleted" };

        const tape = (
          await client.query<{
            agent_id: string;
            turn_index: number;
            status: string;
            turn_key: string;
            tape_sha256: string;
            total_bytes: string;
            part_count: number;
            created_at: string;
            finalized_at: string | null;
            engine_billings: unknown;
          }>(
            `SELECT agent_id, turn_index, status, turn_key, tape_sha256,
                    total_bytes, part_count, created_at, finalized_at, engine_billings
               FROM client_session_turn_tapes
              WHERE session_id = $1 AND user_id = $2 AND tape_id = $3
              FOR UPDATE`,
            [request.sessionId, userId, request.tapeId],
          )
        ).rows[0];
        if (!tape) return { applied: "incomplete" };
        const sameHeader =
          tape.agent_id === request.agentId &&
          tape.turn_index === request.turnIndex &&
          tape.status === request.status &&
          tape.turn_key === request.turnKey &&
          tape.tape_sha256 === request.tapeSha256 &&
          bigIntNum(tape.total_bytes, "turn_tape.total_bytes") === request.totalBytes &&
          tape.part_count === request.partCount &&
          bigIntNum(tape.created_at, "turn_tape.created_at") === request.createdAt;
        if (!sameHeader) throw new Error("lossless turn tape finalize header conflict");
        if (tape.finalized_at !== null) {
          const count = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM client_session_turn_tape_records
              WHERE session_id = $1 AND user_id = $2 AND tape_id = $3`,
            [request.sessionId, userId, request.tapeId],
          );
          if (!Array.isArray(tape.engine_billings)) {
            throw new Error("lossless turn tape finalized engine billings malformed");
          }
          return {
            applied: "idempotent",
            recordCount: Number(count.rows[0]?.count ?? 0),
            engineBillings: structuredClone(tape.engine_billings) as DurableCodexBilling[],
          };
        }

        const parts = (
          await client.query<{ part_index: number; part_sha256: string; payload: Buffer }>(
            `SELECT part_index, part_sha256, payload
               FROM client_session_turn_tape_parts
              WHERE session_id = $1 AND user_id = $2 AND tape_id = $3
              ORDER BY part_index FOR UPDATE`,
            [request.sessionId, userId, request.tapeId],
          )
        ).rows;
        if (parts.length !== request.partCount) return { applied: "incomplete" };
        const chunks: Buffer[] = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]!;
          if (part.part_index !== i) return { applied: "incomplete" };
          const bytes = Buffer.from(part.payload);
          if (sha256Bytes(bytes) !== part.part_sha256) throw new Error("lossless turn tape part hash mismatch");
          chunks.push(bytes);
        }
        const canonical = Buffer.concat(chunks);
        if (canonical.length !== request.totalBytes || sha256Bytes(canonical) !== request.tapeSha256) {
          throw new Error("lossless turn tape aggregate hash mismatch");
        }
        let rawPayload: unknown;
        try {
          rawPayload = JSON.parse(canonical.toString("utf8"));
        } catch (err) {
          throw new Error(`lossless turn tape canonical JSON invalid: ${(err as Error).message}`);
        }
        const turn = materializeLosslessTurn(rawPayload);
        if (
          turn.payload.sessionId !== request.sessionId ||
          turn.payload.agentId !== request.agentId ||
          turn.payload.turnIndex !== request.turnIndex ||
          turn.payload.status !== request.status ||
          turn.payload.turnKey !== request.turnKey
        ) {
          throw new Error("lossless turn tape envelope/payload identity mismatch");
        }
        const goalTokensUsed = computeGoalTokensUsed(turn.payload);

        for (let ordinal = 0; ordinal < turn.records.length; ordinal++) {
          const item = turn.records[ordinal]!;
          const inserted = await client.query(
            `INSERT INTO client_session_turn_tape_records
               (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (session_id,user_id,tape_id,msg_id) DO NOTHING`,
            [
              request.sessionId,
              userId,
              request.tapeId,
              item.id,
              ordinal,
              item.role,
              item.ts,
              item.payloadSha256,
              item.payloadBytes,
            ],
          );
          if ((inserted.rowCount ?? 0) === 0) {
            const existing = (
              await client.query<{ ordinal: number; content_sha256: string }>(
                `SELECT ordinal, content_sha256 FROM client_session_turn_tape_records
                  WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND msg_id=$4`,
                [request.sessionId, userId, request.tapeId, item.id],
              )
            ).rows[0];
            if (!existing || existing.ordinal !== ordinal || existing.content_sha256 !== item.payloadSha256) {
              throw new Error("lossless turn tape immutable record conflict");
            }
          }
        }

        type PendingTapeCost = {
          request_id: string;
          cost_credits: string;
          delegate_agent_id: string | null;
        };
        // Continuation tapes carry post-terminal runtime output only. They
        // share the chat session with the paid turn but must never consume a
        // legacy by-session pending cost intended for that original turn.
        const pending: PendingTapeCost[] = turn.payload.continuationOfTurnKey
          ? []
          : (
          await client.query<PendingTapeCost>(
            `SELECT request_id, cost_credits, delegate_agent_id
               FROM pending_usage_patches
              WHERE user_id = $1 AND (
                    turn_key = $2 OR parent_turn_key = $2
                    OR (turn_key IS NULL AND parent_turn_key IS NULL AND request_id = $3)
                    OR (turn_key IS NULL AND parent_turn_key IS NULL AND session_id = $4)
                    OR (turn_key IS NULL AND parent_turn_key IS NULL AND parent_session_id = $5)
                  )
              ORDER BY request_id FOR UPDATE`,
            [
              userId,
              request.turnKey,
              turn.payload.requestId ?? "",
              turn.payload.agentSessionId ?? "",
              request.sessionId,
            ],
          )
        ).rows;
        for (const cost of pending) {
          const inserted = await client.query(
            `INSERT INTO turn_tape_cost_components
               (request_id,user_id,session_id,tape_id,billing_anchor_id,cost_credits,delegate_agent_id,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (request_id,user_id) DO NOTHING`,
            [
              cost.request_id,
              userId,
              request.sessionId,
              request.tapeId,
              turn.billingAnchorId,
              cost.cost_credits,
              cost.delegate_agent_id,
              Date.now(),
            ],
          );
          if ((inserted.rowCount ?? 0) === 0) {
            const existing = (
              await client.query<{
                session_id: string;
                tape_id: string;
                billing_anchor_id: string;
                cost_credits: string;
                delegate_agent_id: string | null;
              }>(
                `SELECT session_id,tape_id,billing_anchor_id,cost_credits::text,delegate_agent_id
                   FROM turn_tape_cost_components
                  WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
                [cost.request_id, userId],
              )
            ).rows[0];
            if (
              !existing ||
              existing.session_id !== request.sessionId ||
              existing.tape_id !== request.tapeId ||
              existing.billing_anchor_id !== turn.billingAnchorId ||
              BigInt(existing.cost_credits) !== BigInt(cost.cost_credits) ||
              existing.delegate_agent_id !== cost.delegate_agent_id
            ) {
              throw new Error("lossless turn tape cost component immutable conflict");
            }
          }
        }
        const billingRecord = turn.records.find((item) => item.id === turn.billingAnchorId);
        if (!billingRecord) throw new Error("lossless turn tape billing record missing");
        const anchors = [
          tapeAnchor(
            billingRecord,
            request.tapeId,
            request.tapeSha256,
            turn.records.length,
            turn.logicalRecordCount,
            turn.runtimeBatchManifestSha256,
            [...new Set(turn.records
              .map((item) => item.role)
              .filter((role) => role === "plan" || role === "goal"))],
          ),
        ];
        // Exactly one small hot anchor represents the whole turn. Full usage,
        // records, generated content, and exact cost components stay out of
        // line and are merged during hydration. Segment/tool count therefore
        // cannot recreate the hot-row byte cap.

        let existingMessages: MessageLike[];
        try {
          const parsed = JSON.parse(session.messages);
          if (!Array.isArray(parsed)) throw new Error("not array");
          existingMessages = parsed as MessageLike[];
        } catch {
          throw new Error("lossless turn tape target session row malformed");
        }
        const allRecordIds = [...new Set([
          ...turn.logicalRecordIds,
          ...turn.records.map((item) => item.id),
        ])];
        const archived = await client.query<{ msg_id: string }>(
          `SELECT msg_id FROM client_session_archived_ids
            WHERE session_id=$1 AND msg_id = ANY($2::text[])`,
          [request.sessionId, allRecordIds],
        );
        if (archived.rows.length > 0) throw new Error("lossless turn tape record id collides with archived row");
        // Rolling v1→v2 replay: an old runtime may have committed the same
        // deterministic server-authored ids through the legacy endpoint but
        // lost its ACK. The upgraded runtime retries as a tape. Replace those
        // hot legacy projections with the single tape anchor; keeping both
        // would make hydration return duplicate paid records. Archived
        // collisions stay fail-closed above because rewriting archive chunks
        // is not part of this atomic finalize operation.
        const recordIds = new Set(allRecordIds);
        existingMessages = existingMessages.filter(
          (message) => typeof message?.id !== "string" || !recordIds.has(message.id),
        );
        const plan = planAppendServerAuthoredBatch(
          existingMessages,
          anchors,
          typeof session.next_seq === "number" && session.next_seq > 0 ? session.next_seq : 1,
          bigIntNumOr(session.archived_through_seq, 0),
        );
        if (plan.kind === "oversized") throw new Error("lossless turn tape anchor tail unexpectedly oversized");
        if (plan.kind === "write") {
          const nowMs = Date.now();
          const archivedDelta = await execPgSpillPlan(
            client,
            request.sessionId,
            userId,
            plan.chunksToInsert,
            plan.idsToInsert,
            nowMs,
          );
          const archivedCount = bigIntNumOr(session.archived_count, 0) + archivedDelta;
          await client.query(
            `UPDATE client_sessions SET
               messages=$1, message_count=$2, last_at=$3,
               updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
               next_seq=$4, archived_through_seq=$5, archived_count=$6
             WHERE id=$7 AND user_id=$8 AND deleted_at IS NULL`,
            [
              plan.finalJson,
              plan.tail.length + archivedCount,
              nowMs,
              plan.nextSeq,
              plan.archivedThroughSeq,
              archivedCount,
              request.sessionId,
              userId,
            ],
          );
        }

        if (!turn.payload.continuationOfTurnKey) {
          const mapInsert = await client.query(
            `INSERT INTO server_authored_turn_anchor_map
               (user_id,turn_key,session_id,tape_id,billing_anchor_id,written_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (user_id,turn_key) DO NOTHING`,
            [userId, request.turnKey, request.sessionId, request.tapeId, turn.billingAnchorId, Date.now()],
          );
          if ((mapInsert.rowCount ?? 0) === 0) {
            const map = (
              await client.query<{ session_id: string; tape_id: string; billing_anchor_id: string }>(
                `SELECT session_id,tape_id,billing_anchor_id FROM server_authored_turn_anchor_map
                  WHERE user_id=$1 AND turn_key=$2 FOR UPDATE`,
                [userId, request.turnKey],
              )
            ).rows[0];
            if (!map || map.session_id !== request.sessionId || map.tape_id !== request.tapeId || map.billing_anchor_id !== turn.billingAnchorId) {
              throw new Error("lossless turn tape turnKey mapping conflict");
            }
          }
        }
        if (turn.payload.requestId) {
          const requestMap = await client.query(
            `INSERT INTO server_authored_request_map (request_id,user_id,session_id,msg_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT (request_id,user_id) DO NOTHING`,
            [turn.payload.requestId, userId, request.sessionId, turn.billingAnchorId],
          );
          if ((requestMap.rowCount ?? 0) === 0) {
            const existing = (
              await client.query<{ session_id: string; msg_id: string }>(
                `SELECT session_id,msg_id FROM server_authored_request_map
                  WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
                [turn.payload.requestId, userId],
              )
            ).rows[0];
            if (!existing || existing.session_id !== request.sessionId || existing.msg_id !== turn.billingAnchorId) {
              throw new Error("lossless turn tape request mapping conflict");
            }
          }
        }
        for (const cost of pending) {
          await client.query(
            "DELETE FROM pending_usage_patches WHERE user_id=$1 AND request_id=$2",
            [userId, cost.request_id],
          );
        }
        await client.query(
          `UPDATE client_session_turn_tapes
              SET billing_anchor_id=$1, usage=$2, parent_turn_key=$3,
                  engine_billings=$4, finalized_at=$5, record_storage_format=$6,
                  goal_id=$7::uuid, goal_state_revision=$8, goal_tokens_used=$9
            WHERE session_id=$10 AND user_id=$11 AND tape_id=$12`,
          [
            turn.billingAnchorId,
            JSON.stringify(turn.payload.usage ?? {}),
            turn.payload.parentTurnKey ?? null,
            JSON.stringify(turn.engineBillings),
            Date.now(),
            turn.runtimeBatchManifestSha256 ? 3 : 2,
            turn.payload.goalId ?? null,
            turn.payload.goalStateRevision ?? null,
            goalTokensUsed,
            request.sessionId,
            userId,
            request.tapeId,
          ],
        );
        goalUsageChanged = await bumpGoalUsageSnapshotForTape(client, request.sessionId, userId, request.tapeId);
        // 原始分片(parts)一律随 finalize 清除:records 才是脱敏后的持久权威,parts 保存
        // 的是脱敏前 payload,留下即隐私面偏差 + 双份存储(2026-07-16 巡检批;此前只在
        // legacyRawBillingReason 时删)。上传路径对已 finalize tape 已有短路(见
        // stageLosslessTurnTapePart finalized_at 分支),重放不会把 parts 写回来。
        await client.query(
          `DELETE FROM client_session_turn_tape_parts
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
          [request.sessionId, userId, request.tapeId],
        );
        return {
          applied: "finalized",
          recordCount: turn.records.length,
          engineBillings: turn.engineBillings.map((billing) => structuredClone(billing)),
        };
      });
      if (goalUsageChanged && result.applied === "finalized") {
        await notifyGoalUsageChanges(options.onGoalUsageChanged, [{ userId, sessionId: request.sessionId }]);
      }
      return result;
    },
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
              "client_session_turn_tapes",
              "client_session_turn_tape_parts",
              "client_session_turn_tape_records",
              "server_authored_turn_anchor_map",
              "turn_tape_cost_components",
              "session_goals",
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
          const clientMsgsRaw = _stripClientPutMessages(session.messages as unknown[], oldMsgs);
          const clientMsgs = await filterOutArchivedIncoming(client, session.id, clientMsgsRaw);
          const merged = mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[];
          const currentNextSeq =
            existing && typeof existing.next_seq === "number" && existing.next_seq > 0 ? existing.next_seq : 1;
          const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(
            oldMsgs,
            merged,
            currentNextSeq,
            _warnSeqAnomaly,
            bigIntNumOr(existing?.archived_through_seq, 0),
          );

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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, GREATEST($10, ${CLOCK_MS_SQL}), $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               agent_id = EXCLUDED.agent_id,
               title = EXCLUDED.title,
               pinned = EXCLUDED.pinned,
               last_at = EXCLUDED.last_at,
               messages = EXCLUDED.messages,
               message_count = EXCLUDED.message_count,
               -- updated_at 逻辑版本(RFC D3b):冲突更新走 DB 计算 GREATEST。**首建(BLOCKER-1)**:
               -- 新插入(无冲突)的 updated_at 也取 GREATEST(客户端 $10, 服务端时钟下限 clock_ms)——
               -- 不再无条件信任客户端 $10(客户端可回传 0 / 旧值,首建后紧跟 baseSyncedAt=0 的第二个
               -- PUT 会因 existing.updated_at 仍是 0 而击穿 stale 检测,造成双写静默覆盖)。
               -- EXCLUDED.updated_at 即上面 VALUES 的 GREATEST 结果,故冲突路径口径不变。
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
        // 锁序(MAJOR-1;与 sweepGc 的 map→pending 同序,消除死锁环):
        //   advisory → client_sessions 行 → server_authored_request_map → pending_usage_patches。
        // 旧实现先锁 pending 再 INSERT map(pending→map),与 sweepGc 反序 → appendForRequest×sweepGc
        // 死锁。改:锁会话行后**立即 SELECT map FOR UPDATE**,再锁 pending。
        await client.query("SELECT id FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sessId, userId]);

        // 立即 SELECT map FOR UPDATE + **不可重映射校验**(RFC D3/R1)。**必须发生在任何提前返回
        // 之前** —— already_exists 幂等重放也要过 map 校验(防错误复用 requestId 时成本错挂到别的
        // 消息)。map 不存在(首次 append)→ 锁不到行(合法),下面 append 成功后再 INSERT。
        const existingMap = (
          await client.query<{ session_id: string; msg_id: string }>(
            "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
            [requestId, userId],
          )
        ).rows[0];
        if (existingMap && (existingMap.session_id !== sessId || existingMap.msg_id !== message.id)) {
          throw new Error(
            `[pgSessions] server_authored_request_map 拒绝重映射: (requestId=${requestId},userId=${userId}) ` +
              `已映射 (${existingMap.session_id},${existingMap.msg_id}),本次欲映射 (${sessId},${message.id})`,
          );
        }

        // 锁 pending(确定序;pending FOR UPDATE 串行化跨路径的排空竞争)。
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

        // append core(会话行已在锁下)。
        const r = await pgAppendServerAuthoredCore(client, sessId, userId, msgToWrite);
        if (!r.applied) {
          // 终态(session_deleted / oversized):无未来重试会 drain 此 pending,就地清(与 SQLite 同)。
          // session_not_found 有意保留 —— 前端 debounced PUT 可能仍在途,重试会需要该 pending。
          if (pending && (r.reason === "session_deleted" || r.reason === "oversized")) {
            await client.query("DELETE FROM pending_usage_patches WHERE request_id = $1 AND user_id = $2", [requestId, userId]);
          }
          return r;
        }

        // 插 map(existingMap 已在上面 FOR UPDATE 校验一致;不存在则新插)。advisory_xact_lock 已
        // 串行化同 (user,request) 的所有 appendForRequest,故此处 !existingMap 时无并发插入者,
        // plain INSERT 安全(仍带 ON CONFLICT DO NOTHING 作纵深防御,理论不触发)。
        if (!existingMap) {
          await client.query(
            `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (request_id, user_id) DO NOTHING`,
            [requestId, userId, sessId, message.id],
          );
        }

        // 删 pending。
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
      turnKey?: string | null,
      parentTurnKey?: string | null,
    ): Promise<AppendCostCreditsResult> {
      if (!/^\d+$/.test(costCredits)) throw new Error("costCredits must be a non-negative integer");
      const normalizedCostCredits = BigInt(costCredits).toString();
      if (normalizedCostCredits.length > 78) throw new Error("costCredits exceeds NUMERIC(78,0)");
      if (turnKey && !LOSSLESS_TURN_TAPE_SHA256_RE.test(turnKey)) {
        throw new Error("turnKey must be a lowercase SHA-256 hex digest");
      }
      if (parentTurnKey && !LOSSLESS_TURN_TAPE_SHA256_RE.test(parentTurnKey)) {
        throw new Error("parentTurnKey must be a lowercase SHA-256 hex digest");
      }
      let goalUsageChange: GoalUsageChange | null = null;
      const result = await withTx(pool, async (client): Promise<AppendCostCreditsResult> => {
        // ① request advisory(串行点)。
        await requestAdvisoryXactLock(client, userId, requestId);

        // v2 exact path. Delegate spend belongs to the leader's parent turn;
        // ordinary chat spend belongs to its own turnKey.
        const targetTurnKey = parentTurnKey ?? turnKey ?? null;
        if (targetTurnKey) {
          await requestAdvisoryXactLock(client, userId, `turn:${targetTurnKey}`);
          const map0 = (
            await client.query<{
              session_id: string;
              tape_id: string;
              billing_anchor_id: string;
            }>(
              `SELECT session_id,tape_id,billing_anchor_id
                 FROM server_authored_turn_anchor_map
                WHERE user_id=$1 AND turn_key=$2`,
              [userId, targetTurnKey],
            )
          ).rows[0];
          if (map0) {
            const sess = (
              await client.query<{
                deleted_at: string | null;
                messages: string;
                next_seq: number | null;
                archived_through_seq: number | null;
                archived_count: number | null;
              }>(
                `SELECT deleted_at,messages,next_seq,archived_through_seq,archived_count
                   FROM client_sessions
                  WHERE id=$1 AND user_id=$2 FOR UPDATE`,
                [map0.session_id, userId],
              )
            ).rows[0];
            if (sess && sess.deleted_at === null) {
              const map = (
                await client.query<{
                  session_id: string;
                  tape_id: string;
                  billing_anchor_id: string;
                }>(
                  `SELECT session_id,tape_id,billing_anchor_id
                     FROM server_authored_turn_anchor_map
                    WHERE user_id=$1 AND turn_key=$2 FOR UPDATE`,
                  [userId, targetTurnKey],
                )
              ).rows[0];
              if (
                !map ||
                map.session_id !== map0.session_id ||
                map.tape_id !== map0.tape_id ||
                map.billing_anchor_id !== map0.billing_anchor_id
              ) {
                throw new Error("lossless turn billing anchor mapping changed while locked");
              }
              const existing = (
                await client.query<{
                  session_id: string;
                  tape_id: string;
                  billing_anchor_id: string;
                  cost_credits: string;
                  delegate_agent_id: string | null;
                }>(
                  `SELECT session_id,tape_id,billing_anchor_id,cost_credits::text,delegate_agent_id
                     FROM turn_tape_cost_components
                    WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
                  [requestId, userId],
                )
              ).rows[0];
              const pendingExact = (
                await client.query<{
                  session_id: string | null;
                  parent_session_id: string | null;
                  delegate_agent_id: string | null;
                  turn_key: string | null;
                  parent_turn_key: string | null;
                  cost_credits: string;
                }>(
                  `SELECT session_id,parent_session_id,delegate_agent_id,turn_key,
                          parent_turn_key,cost_credits
                     FROM pending_usage_patches
                    WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
                  [requestId, userId],
                )
              ).rows[0];
              if (
                pendingExact &&
                ((sessionId != null && pendingExact.session_id !== sessionId) ||
                  (parentSessionId != null && pendingExact.parent_session_id !== parentSessionId) ||
                  (delegateAgentId != null && pendingExact.delegate_agent_id !== delegateAgentId) ||
                  (turnKey != null && pendingExact.turn_key !== turnKey) ||
                  (parentTurnKey != null && pendingExact.parent_turn_key !== parentTurnKey) ||
                  BigInt(pendingExact.cost_credits) !== BigInt(normalizedCostCredits))
              ) {
                throw new Error("lossless pending cost component refuses remapping");
              }
              if (existing) {
                if (
                  existing.session_id !== map.session_id ||
                  existing.tape_id !== map.tape_id ||
                  existing.billing_anchor_id !== map.billing_anchor_id ||
                  BigInt(existing.cost_credits) !== BigInt(normalizedCostCredits) ||
                  existing.delegate_agent_id !== (delegateAgentId ?? null)
                ) {
                  throw new Error("lossless turn cost component refuses remapping");
                }
                if (pendingExact) {
                  await client.query(
                    "DELETE FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
                    [requestId, userId],
                  );
                }
                // A billing retry can arrive after the immutable component and
                // its snapshot_revision bump committed, but before the
                // post-commit notification reached the browser. Re-publish the
                // already-advanced snapshot without writing another revision:
                // duplicate/reconnect replays must not create revision churn.
                goalUsageChange = { userId, sessionId: map.session_id };
                return { applied: "noop" };
              }
              await client.query(
                `INSERT INTO turn_tape_cost_components
                   (request_id,user_id,session_id,tape_id,billing_anchor_id,
                    cost_credits,delegate_agent_id,updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  requestId,
                  userId,
                  map.session_id,
                  map.tape_id,
                  map.billing_anchor_id,
                  normalizedCostCredits,
                  delegateAgentId ?? null,
                  Date.now(),
                ],
              );
              if (pendingExact) {
                await client.query(
                  "DELETE FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
                  [requestId, userId],
                );
              }
              if (await bumpGoalUsageSnapshotForTape(client, map.session_id, userId, map.tape_id)) {
                goalUsageChange = { userId, sessionId: map.session_id };
              }
              let messages: MessageLike[] = [];
              try {
                const parsed = JSON.parse(sess.messages);
                if (Array.isArray(parsed)) messages = parsed as MessageLike[];
              } catch {
                throw new Error("lossless turn billing target session row malformed");
              }
              messages = normalizeAndAssignOrderSeqs(
                messages,
                messages,
                bigIntNumOr(sess.archived_through_seq, 0),
              ).messages;
              const anchorIndex = messages.findIndex(
                (message) =>
                  message?.id === map.billing_anchor_id &&
                  message?._turnTapeId === map.tape_id &&
                  message?._source === "server",
              );
              if (anchorIndex >= 0) {
                const nextSeq =
                  typeof sess.next_seq === "number" && sess.next_seq > 0
                    ? sess.next_seq
                    : Math.max(0, ...messages.map((message) =>
                        typeof message?._seq === "number" ? message._seq : 0
                      )) + 1;
                const touched = [...messages];
                touched[anchorIndex] = { ...touched[anchorIndex], _seq: nextSeq };
                const spill = planSpillOverflow(
                  touched,
                  bigIntNumOr(sess.archived_through_seq, 0),
                );
                const finalJson = JSON.stringify(spill.tail);
                if (Buffer.byteLength(finalJson, "utf8") > MAX_SESSION_BYTES) {
                  throw new Error("lossless turn billing anchor tail unexpectedly oversized");
                }
                const nowMs = Date.now();
                const archivedDelta = await execPgSpillPlan(
                  client,
                  map.session_id,
                  userId,
                  spill.chunksToInsert,
                  spill.idsToInsert,
                  nowMs,
                );
                const archivedCount = bigIntNumOr(sess.archived_count, 0) + archivedDelta;
                await client.query(
                  `UPDATE client_sessions SET
                     messages=$1,message_count=$2,last_at=$3,
                     updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                     next_seq=$4,archived_through_seq=$5,archived_count=$6
                   WHERE id=$7 AND user_id=$8 AND deleted_at IS NULL`,
                  [
                    finalJson,
                    spill.tail.length + archivedCount,
                    nowMs,
                    nextSeq + 1,
                    spill.archivedThroughSeq,
                    archivedCount,
                    map.session_id,
                    userId,
                  ],
                );
              } else {
                // The anchor may already be archived. The immutable component
                // is still authoritative and archive hydration will expose it;
                // bump the session version so full-sync clients revalidate.
                await client.query(
                  `UPDATE client_sessions
                      SET updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
                    WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
                  [map.session_id, userId],
                );
              }
              return { applied: "patched" };
            }
            return { applied: "noop" };
          }
        }

        // ② 非锁定读 map,仅用于定位 session_id(禁先 FOR UPDATE map 破坏锁序)。
        const mapRow0 = targetTurnKey
          ? undefined
          : (
              await client.query<{ session_id: string; msg_id: string }>(
                "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2",
                [requestId, userId],
              )
            ).rows[0];

        if (mapRow0) {
          // ③ 锁 client_sessions 行(**含软删行**:去 deleted_at IS NULL 过滤,读出 deleted_at)。
          const sess = (
            await client.query<{
              messages: string;
              next_seq: number | null;
              deleted_at: string | null;
              archived_through_seq: number | null;
              archived_count: number | null;
            }>(
              "SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
              [mapRow0.session_id, userId],
            )
          ).rows[0];
          // MAJOR-2 ②:map-hit 但会话已软删 → **noop 不 park**(RFC D3 late-cost)。map(mapRow0)已
          // 确定目标会话,park 会留永不 drain 的孤儿 pending(delete 已级联清 delegate pending)。
          // 双 backend 语义一致。早于 map 复核 —— 会话已死,无需 patch,故无需 locator 校验。
          if (sess && sess.deleted_at !== null) return { applied: "noop" };

          // ④ FOR UPDATE 复核 map locator 未变/未被 GC 删(消失 → 按 miss 重决策,禁用陈旧 locator)。
          const mapRow = (
            await client.query<{ session_id: string; msg_id: string }>(
              "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
              [requestId, userId],
            )
          ).rows[0];
          // MAJOR-2 ①:逐字段比较首次非锁定读(mapRow0)与 FOR UPDATE 复核值(mapRow)。map 不可重
          // 映射 + advisory 串行化 appendForRequest → mapRow 只可能 ==mapRow0 或被 GC 删(never 变
          // locator)。若 locator 变了,说明我们按 mapRow0.session_id 锁了**错误会话** → fail-closed
          // 抛错(宁报错也不把成本错挂;理论不可达,是 non-remappable 不变量被破坏的信号)。
          if (mapRow && (mapRow.session_id !== mapRow0.session_id || mapRow.msg_id !== mapRow0.msg_id)) {
            throw new Error(
              `[pgSessions] appendCostCredits map locator 在锁定间隙变化(non-remappable 不变量被破坏): ` +
                `(requestId=${requestId},userId=${userId}) 首读 (${mapRow0.session_id},${mapRow0.msg_id}) ` +
                `复核 (${mapRow.session_id},${mapRow.msg_id})`,
            );
          }

          if (sess && mapRow) {
            let msgs: MessageLike[];
            try {
              const parsed = JSON.parse(sess.messages);
              msgs = Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
            } catch {
              msgs = [];
            }
            const currentNextSeq = typeof sess.next_seq === "number" && sess.next_seq > 0 ? sess.next_seq : 1;
            // 决策抽到引擎中立的 planCostPatch(RFC D6b):双 backend 复用(幂等判定 / patch 构造 /
            // spill / size guard 全在 plan;size guard 先行 → 命中 noop 不落孤儿 chunk)。
            const plan = planCostPatch(msgs, mapRow.msg_id, normalizedCostCredits, currentNextSeq, bigIntNumOr(sess.archived_through_seq, 0));
            if (plan.kind === "noop") return { applied: "noop" };
            if (plan.kind === "patch") {
              const nowMs = Date.now();
              const archivedDelta = await execPgSpillPlan(client, mapRow.session_id, userId, plan.chunksToInsert, plan.idsToInsert, nowMs);
              const newArchivedCount = bigIntNumOr(sess.archived_count, 0) + archivedDelta;
              await client.query(
                `UPDATE client_sessions
                   SET messages = $1, message_count = $2, last_at = $3,
                       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                       next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5
                 WHERE id = $6 AND user_id = $7`,
                [plan.finalJson, plan.tail.length + newArchivedCount, nowMs, plan.archivedThroughSeq, newArchivedCount, mapRow.session_id, userId],
              );
              return { applied: "patched" };
            }
            // plan.kind === 'not_found':目标 msg 不在热尾巴:已归档 → noop(别再徒劳 re-pending 陷入
            // 循环);未归档(被删/编辑 out-of-band)→ 维持 fall through 到 pending(与 SQLite 同)。
            const archivedHit = await client.query(
              "SELECT 1 FROM client_session_archived_ids WHERE session_id = $1 AND msg_id = $2",
              [mapRow.session_id, mapRow.msg_id],
            );
            if ((archivedHit.rowCount ?? 0) > 0) return { applied: "noop" };
            // else fall through to pending
          }
          // sess 缺位(会话行从未存在)或 mapRow 被 GC(④ 消失)→ fall through 到 pending(miss 重
          // 决策)。边界:软删会话 + map 恰被 GC 删的窄窗 → 落 miss park(注:直接 pending 无
          // parent_session_id,24h 老化 GC 兜底;delegate pending 走 delete 级联,不受此影响)。
        }

        // v2 exact requests are immutable even before their tape arrives.
        // A retry may repeat the same component, but it may never change its
        // amount or locator under the same (requestId,userId).
        if (targetTurnKey) {
          const pending = (
            await client.query<{
              session_id: string | null;
              parent_session_id: string | null;
              delegate_agent_id: string | null;
              turn_key: string | null;
              parent_turn_key: string | null;
              cost_credits: string;
            }>(
              `SELECT session_id,parent_session_id,delegate_agent_id,turn_key,parent_turn_key,
                      cost_credits::text
                 FROM pending_usage_patches
                WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
              [requestId, userId],
            )
          ).rows[0];
          const locator = {
            sessionId: sessionId ?? null,
            parentSessionId: parentSessionId ?? null,
            delegateAgentId: delegateAgentId ?? null,
            turnKey: turnKey ?? null,
            parentTurnKey: parentTurnKey ?? null,
          };
          if (pending) {
            if (
              (locator.sessionId !== null && pending.session_id !== locator.sessionId) ||
              (locator.parentSessionId !== null && pending.parent_session_id !== locator.parentSessionId) ||
              (locator.delegateAgentId !== null && pending.delegate_agent_id !== locator.delegateAgentId) ||
              (locator.turnKey !== null && pending.turn_key !== locator.turnKey) ||
              (locator.parentTurnKey !== null && pending.parent_turn_key !== locator.parentTurnKey) ||
              BigInt(pending.cost_credits) !== BigInt(normalizedCostCredits)
            ) {
              throw new Error("lossless pending cost component refuses remapping");
            }
            return { applied: "pending" };
          }
          await client.query(
            `INSERT INTO pending_usage_patches
               (request_id,user_id,session_id,parent_session_id,delegate_agent_id,
                turn_key,parent_turn_key,cost_credits)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              requestId,
              userId,
              locator.sessionId,
              locator.parentSessionId,
              locator.delegateAgentId,
              locator.turnKey,
              locator.parentTurnKey,
              normalizedCostCredits,
            ],
          );
          return { applied: "pending" };
        }

        // ⑤ legacy park:UPSERT pending_usage_patches(created_at 冲突时重置为语句时刻)。
        await client.query(
          `INSERT INTO pending_usage_patches
             (request_id, user_id, session_id, parent_session_id, delegate_agent_id,
              turn_key, parent_turn_key, cost_credits)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (request_id, user_id) DO UPDATE SET
             cost_credits = EXCLUDED.cost_credits,
             session_id = EXCLUDED.session_id,
             parent_session_id = EXCLUDED.parent_session_id,
             delegate_agent_id = EXCLUDED.delegate_agent_id,
             turn_key = EXCLUDED.turn_key,
             parent_turn_key = EXCLUDED.parent_turn_key,
             created_at = ${CLOCK_MS_SQL}`,
          [
            requestId,
            userId,
            sessionId ?? null,
            parentSessionId ?? null,
            delegateAgentId ?? null,
            turnKey ?? null,
            parentTurnKey ?? null,
            normalizedCostCredits,
          ],
        );
        return { applied: "pending" };
      });
      await notifyGoalUsageChanges(options.onGoalUsageChanged, goalUsageChange ? [goalUsageChange] : []);
      return result;
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

        // 决策(Σ + per-agent 分组 + delegates 累加合并 + spill + 超限判定)抽到引擎中立的
        // planDelegateCostMerge(RFC D6b):双 backend 复用,不各养一份。执行层只落 SQL。
        let msgs: MessageLike[] | null = null;
        let currentNextSeq = 1;
        let currentArchivedThroughSeq = 0;
        if (sess) {
          try {
            const parsed = JSON.parse(sess.messages);
            msgs = Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
          } catch {
            msgs = [];
          }
          currentNextSeq = typeof sess.next_seq === "number" && sess.next_seq > 0 ? sess.next_seq : 1;
          currentArchivedThroughSeq = bigIntNumOr(sess.archived_through_seq, 0);
        }

        const plan = planDelegateCostMerge(
          msgs,
          msgId,
          pendings.map((p): DelegatePendingRow => ({ costCredits: p.cost_credits, delegateAgentId: p.delegate_agent_id })),
          currentNextSeq,
          currentArchivedThroughSeq,
        );

        if (plan.kind === "no_positive_cost") {
          // 只有非正/畸形成本 → 清本批(无归并价值,即便 session 缺位也清),不写库、不 bump _seq。
          for (const p of pendings) {
            await client.query("DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = $2", [userId, p.request_id]);
          }
          return { merged: "0", drained: pendings.length };
        }
        if (plan.kind === "target_not_ready") {
          // 会话缺位(尚未 sink / 已删)/ 找不到队长助手行 / spill 后超限 → 保守保留 pending。
          return { merged: "0", drained: 0 };
        }

        // plan.kind === 'merge':落 spill + 主行 UPDATE(next_seq+1)+ 清本批 pending。
        const nowMs = Date.now();
        const archivedDelta = await execPgSpillPlan(client, clientSessionId, userId, plan.chunksToInsert, plan.idsToInsert, nowMs);
        const newArchivedCount = bigIntNumOr(sess!.archived_count, 0) + archivedDelta;
        await client.query(
          `UPDATE client_sessions
             SET messages = $1, message_count = $2, last_at = $3,
                 updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                 next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5
           WHERE id = $6 AND user_id = $7`,
          [plan.finalJson, plan.tail.length + newArchivedCount, nowMs, plan.archivedThroughSeq, newArchivedCount, clientSessionId, userId],
        );

        for (const p of pendings) {
          await client.query("DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = $2", [userId, p.request_id]);
        }
        return {
          merged: plan.merged,
          drained: pendings.length,
          ...(plan.delegates.length > 0 ? { delegates: plan.delegates } : {}),
        };
      });
    },

    // ── sweepUsageAggregationGc(pending/map 老化 GC;只由 advisory lease 持有者调度)──
    async sweepUsageAggregationGc(now: number = Date.now()): Promise<UsageAggregationGcStats> {
      const changes: GoalUsageChange[] = [];
      const stats = await withTx(pool, (client) => sweepOnce(client, now, changes));
      await notifyGoalUsageChanges(options.onGoalUsageChanged, changes);
      return stats;
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

    async getClientSession(
      id: string,
      userId?: string,
      options: ClientSessionReadOptions = {},
    ): Promise<ClientSession | null> {
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
      const archivedThroughOrderSeq = bigIntNumOr(row.archived_through_seq, 0);
      const parsedMessages = deriveOrderSeqsForRead(
        JSON.parse(row.messages) as MessageLike[],
        archivedThroughOrderSeq,
      );
      const messages = await hydrateTurnTapeMessages(pool, row.id, row.user_id, parsedMessages, options);
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
        archivedCount: bigIntNumOr(row.archived_count, 0),
        archivedThroughSeq: archivedThroughOrderSeq,
      };
    },

    async classifyClientSessions(
      refs: readonly ClientSessionLifecycleRef[],
    ): Promise<ClientSessionLifecycle[]> {
      if (refs.length === 0) return [];
      const rows = (
        await pool.query<{
          ordinal: string;
          session_id: string;
          user_id: string;
          state: "active" | "deleted" | "missing";
        }>(
          `SELECT entry.ordinal::text AS ordinal,
                  entry.value->>'sessionId' AS session_id,
                  entry.value->>'userId' AS user_id,
                  CASE WHEN cs.id IS NULL THEN 'missing'
                       WHEN cs.deleted_at IS NULL THEN 'active'
                       ELSE 'deleted' END AS state
             FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entry(value, ordinal)
             LEFT JOIN client_sessions cs
               ON cs.id=entry.value->>'sessionId' AND cs.user_id=entry.value->>'userId'
            ORDER BY entry.ordinal`,
          [JSON.stringify(refs)],
        )
      ).rows;
      return rows.map((row) => ({
        sessionId: row.session_id,
        userId: row.user_id,
        state: row.state,
      }));
    },

    async getClientSessionPartial(
      id: string,
      userId: string,
      sinceSeq: number,
      options: ClientSessionReadOptions = {},
    ): Promise<ClientSessionPartial | null> {
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
      allMsgs = deriveOrderSeqsForRead(allMsgs, archivedThroughSeq);
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
      messages = await hydrateTurnTapeMessages(pool, row.id, row.user_id, messages, options);
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

    async readArchivedMessages(
      sessId: string,
      userId: string,
      beforeSeq = 0,
      limit = 100,
      options: ClientSessionReadOptions = {},
    ): Promise<ReadArchivedMessagesResult> {
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
        for (const m of deriveArchivedOrderSeqsForRead(arr)) {
          const s = typeof m?._orderSeq === "number" ? m._orderSeq : -1;
          if (s >= 0 && s < effectiveBefore) messagePool.push(m);
        }
        if (messagePool.length > cappedLimit) break;
      }
      messagePool.sort(compareMessagesByOrder);
      const hasMore = messagePool.length > cappedLimit;
      const page = messagePool.slice(Math.max(0, messagePool.length - cappedLimit));
      const oldestSeq = page.length > 0 && typeof page[0]._orderSeq === "number"
        ? page[0]._orderSeq
        : null;
      const hydrated = await hydrateTurnTapeMessages(pool, sessId, userId, page, options);
      return { messages: hydrated, hasMore, oldestSeq };
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
        await client.query("DELETE FROM client_session_turn_tapes WHERE session_id = $1", [id]);
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
      // 首建 updated_at 服务端时钟下限(BLOCKER-1):GREATEST($6 lastAt, clock_ms)—— 与
      // upsertClientSession 首建口径一致,防首建版本落后于服务端时钟被后续 stale PUT 击穿。
      await pool.query(
        `INSERT INTO client_sessions
           (id, user_id, agent_id, title, created_at, last_at, updated_at, origin_channel)
         VALUES ($1, $2, $3, $4, $5, $6, GREATEST($6, ${CLOCK_MS_SQL}), $7)`,
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
          // 死锁面(D8):本函数锁同表 wechat_bindings 两行(account_id 行 + user_id 行)。两并发
          // upsert 若 (user,account) 交叉(T1 的 user 行 == T2 的 account 行,反之亦然),FOR UPDATE
          // 的取锁顺序会 ABBA → 死锁。修:先按**排序后的逻辑键**取 pg_advisory_xact_lock(全局定序,
          // 经典 lock-ordering 消 ABBA),再行锁。锁序:advisory(sorted user/acct keys)→ account 行
          // → user 行。两个键命名空间不同前缀(oc_wechat_user: / oc_wechat_acct:),同值不误撞;
          // 与其它 advisory(oc_sarm: / oc_sessions_sweep_gc)不相交。
          const advisoryKeys = [
            `oc_wechat_user:${input.userId}`,
            `oc_wechat_acct:${input.accountId}`,
          ].sort();
          for (const k of advisoryKeys) {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [k]);
          }
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
  onGoalUsageChanged?: (userId: string, sessionId: string) => void | Promise<void>;
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
      const changes: GoalUsageChange[] = [];
      const stats = await withTx(opts.pool, (client) => sweepOnce(client, now(), changes));
      await notifyGoalUsageChanges(opts.onGoalUsageChanged, changes);
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
async function sweepOnce(
  client: PoolClient,
  nowMs: number,
  goalUsageChanges: GoalUsageChange[] = [],
): Promise<UsageAggregationGcStats> {
  const agingThreshold = nowMs - PENDING_AGING_MS;
  const expiredThreshold = nowMs - PENDING_HARD_DELETE_MS;
  const mapThreshold = nowMs - MAP_HARD_DELETE_MS;
  const unreachableThreshold = nowMs - PENDING_UNREACHABLE_DELETE_MS;
  const partsThreshold = nowMs - FINALIZED_TAPE_PARTS_DELETE_MS;
  const aging = (
    await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pending_usage_patches WHERE created_at <= $1 AND created_at > $2",
      [agingThreshold, expiredThreshold],
    )
  ).rows[0];
  const delMap = await client.query("DELETE FROM server_authored_request_map WHERE written_at <= $1", [mapThreshold]);
  const delPending = await client.query(
    `DELETE FROM pending_usage_patches
      WHERE created_at <= $1 AND turn_key IS NULL AND parent_turn_key IS NULL`,
    [expiredThreshold],
  );

  // ── 带 key 滞留行的终态语义(2026-07-16 巡检批)────────────────────────────────
  // 成本晚于 tape finalize 才 stage 的行会错过 finalizeLosslessTurnTape 内折叠的唯一
  // 时机,此后只能靠 hydration 的 UNION 读时兜底、永久滞留。这里补"晚到折叠":与
  // finalize 内折叠同语义(finalized tape 的 anchor 坐标 + 不可变冲突校验),折叠与
  // 删除在同一事务内,外部读者要么看到 pending 要么看到 component,不会双计。
  // 可达性判据与 hydrateTurnTapeMessages 同源:finalized tape 按 turn_key 或
  // parent_turn_key 匹配。FOR UPDATE SKIP LOCKED 避让在途 append/finalize 路径。
  const changedGoals = await client.query<{ user_id: string; session_id: string }>(
    `WITH locked AS (
       SELECT p.request_id, p.user_id, p.cost_credits, p.delegate_agent_id,
              p.turn_key, p.parent_turn_key
         FROM pending_usage_patches p
        WHERE p.created_at <= $1
          AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
        ORDER BY p.request_id
        FOR UPDATE SKIP LOCKED
     ), foldable AS (
       SELECT DISTINCT ON (l.request_id, l.user_id)
              l.request_id, l.user_id, l.cost_credits, l.delegate_agent_id,
              t.session_id, t.tape_id, t.billing_anchor_id
         FROM locked l
         JOIN client_session_turn_tapes t
           ON t.user_id = l.user_id
          AND (t.turn_key = l.turn_key OR t.turn_key = l.parent_turn_key)
          AND t.finalized_at IS NOT NULL
          AND t.billing_anchor_id IS NOT NULL
        ORDER BY l.request_id, l.user_id, t.finalized_at ASC, t.tape_id ASC
     ), inserted AS (
       INSERT INTO turn_tape_cost_components
         (request_id, user_id, session_id, tape_id, billing_anchor_id,
          cost_credits, delegate_agent_id, updated_at)
       SELECT request_id, user_id, session_id, tape_id, billing_anchor_id,
              cost_credits::numeric, delegate_agent_id, $2
         FROM foldable
       ON CONFLICT (request_id, user_id) DO NOTHING
       RETURNING session_id,user_id,tape_id
     ), updated AS (
       UPDATE session_goals g
          SET snapshot_revision=snapshot_revision+1,updated_at=clock_timestamp()
        WHERE EXISTS (
          SELECT 1
            FROM inserted i
            JOIN client_session_turn_tapes t
              ON t.session_id=i.session_id AND t.user_id=i.user_id AND t.tape_id=i.tape_id
           WHERE t.goal_id=g.goal_id AND t.session_id=g.session_id
        )
       RETURNING g.session_id
     )
     SELECT DISTINCT i.user_id,i.session_id
       FROM inserted i
       JOIN updated u ON u.session_id=i.session_id`,
    [agingThreshold, nowMs],
  );
  goalUsageChanges.push(
    ...changedGoals.rows.map((row) => ({ userId: row.user_id, sessionId: row.session_id })),
  );
  // 只删"component 坐标与金额与本行完全一致"的 pending(镜像 finalize 内折叠的不可变
  // 校验;冲突不符的行保留待人工核对,由 pendingFoldAnomaly 暴露)。
  const delFolded = await client.query(
    `DELETE FROM pending_usage_patches p
      USING client_session_turn_tapes t, turn_tape_cost_components c
      WHERE p.created_at <= $1
        AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
        AND t.user_id = p.user_id
        AND (t.turn_key = p.turn_key OR t.turn_key = p.parent_turn_key)
        AND t.finalized_at IS NOT NULL
        AND t.billing_anchor_id IS NOT NULL
        AND c.request_id = p.request_id
        AND c.user_id = p.user_id
        AND c.session_id = t.session_id
        AND c.tape_id = t.tape_id
        AND c.billing_anchor_id = t.billing_anchor_id
        AND c.cost_credits::numeric = p.cost_credits::numeric
        AND c.delegate_agent_id IS NOT DISTINCT FROM p.delegate_agent_id`,
    [agingThreshold],
  );
  const foldAnomaly = (
    await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM pending_usage_patches p
        WHERE p.created_at <= $1
          AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM client_session_turn_tapes t
             WHERE t.user_id = p.user_id
               AND (t.turn_key = p.turn_key OR t.turn_key = p.parent_turn_key)
               AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM turn_tape_cost_components c
             WHERE c.request_id = p.request_id AND c.user_id = p.user_id
          )`,
      [agingThreshold],
    )
  ).rows[0];
  // 不可达行:任何 finalized tape 都匹配不到 → hydration 永远读不到,纯死重。超期清除。
  const delUnreachable = await client.query(
    `DELETE FROM pending_usage_patches p
      WHERE p.created_at <= $1
        AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM client_session_turn_tapes t
           WHERE t.user_id = p.user_id
             AND (t.turn_key = p.turn_key OR t.turn_key = p.parent_turn_key)
             AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL
        )`,
    [unreachableThreshold],
  );
  // finalize 后残留的原始分片(存量 + 删除失败兜底;新 finalize 已在事务内清)。
  const delParts = await client.query(
    `DELETE FROM client_session_turn_tape_parts pp
      USING client_session_turn_tapes t
      WHERE t.session_id = pp.session_id
        AND t.user_id = pp.user_id
        AND t.tape_id = pp.tape_id
        AND t.finalized_at IS NOT NULL
        AND pp.created_at <= $1`,
    [partsThreshold],
  );
  return {
    pendingAging: aging?.n ?? 0,
    pendingExpired: delPending.rowCount ?? 0,
    mapExpired: delMap.rowCount ?? 0,
    pendingFolded: delFolded.rowCount ?? 0,
    pendingFoldAnomaly: foldAnomaly?.n ?? 0,
    pendingUnreachableExpired: delUnreachable.rowCount ?? 0,
    tapePartsPurged: delParts.rowCount ?? 0,
  };
}
