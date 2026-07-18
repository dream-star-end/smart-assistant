// pgSessionsBackend — master 会话权威六表的 **PostgreSQL 实现**(RFC-v5-sessions-pg,P2)。
//
// 为什么在 commercial 而不在 storage:pg 依赖已在 commercial(storage 侧只用最小结构类型
// 描述连接、零新增依赖,见 RFC D1)。master 形态(channel=v5,非容器)由 registerCommercial
// 在 composition root 一次性 `setClientSessionsBackend(createPgSessionsBackend(pool))` 注入;
// 容器内 gateway / 个人版不加载 commercial → 天然 SQLite,行为零变化。
//
// 本文件是 SQLite backend(packages/storage/src/sessionsDb.ts 的 sqliteBackend)的**行为等价
// PG 实现**。契约 `ClientSessionsBackend = typeof sqliteBackend` 在类型层强制 28 方法全覆盖
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
  hasInvisibleHistoryMutation,
  hasInvisibleMessageRemoval,
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
import { ensurePendingTurnWaiverInTransaction } from "../billing/refund.js";
import { lockTurnBillingKeys, numericCommercialUserId } from "../billing/turnLock.js";
import {
  admitDispatch,
  type AdmitDispatchResult,
  casToManualReconcile,
  casToTerminal,
  getDispatch,
} from "../dispatch/turnDispatchStore.js";
import {
  projectionToVirtualMessage,
  readActiveErrorProjections,
  revokeErrorProjection,
} from "../dispatch/errorProjections.js";
import type { Queryable } from "../dispatch/turnDispatchStore.js";
import { MASTER_HISTORY_MAX_MESSAGES, MASTER_HISTORY_MAX_CHARS } from "../ws/masterHistoryLimits.js";

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
/** 从消息数组按 id 取 _seq(admitUserTurn 求 anchor_seq 用;不在热尾巴 → undefined)。 */
function seqOfMessage(msgs: MessageLike[], id: string): number | undefined {
  const hit = msgs.find((m) => m && m.id === id);
  return typeof hit?._seq === "number" ? hit._seq : undefined;
}

async function pgAppendServerAuthoredCore(
  client: PoolClient,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<ServerAuthoredAppendResult & { seq?: number }> {
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
  if (plan.kind === "already_exists") {
    // 幂等重发:该消息行已在热尾巴,回其现有 _seq 供 admit 复用 anchor(dispatch 通常也已存在)。
    return { applied: false, reason: "already_exists", seq: seqOfMessage(msgs, message.id) };
  }
  if (plan.kind === "oversized") return { applied: false, reason: "oversized" };

  const now = Date.now();
  const archivedDelta = await execPgSpillPlan(client, sessId, userId, plan.chunksToInsert, plan.idsToInsert, now);
  const newArchivedCount = bigIntNumOr(row.archived_count, 0) + archivedDelta;
  const tail = plan.tail;
  const historyRevisionDelta =
    hasInvisibleMessageRemoval(msgs, tail) || archivedDelta > 0 ? 1 : 0;

  const upd = await client.query(
    `UPDATE client_sessions
       SET messages = $1, message_count = $2, last_at = $3,
           updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
           next_seq = $4, archived_through_seq = $5, archived_count = $6,
           history_revision = history_revision + $9
     WHERE id = $7 AND user_id = $8 AND deleted_at IS NULL`,
    [plan.finalJson, tail.length + newArchivedCount, now, plan.nextSeq, plan.archivedThroughSeq, newArchivedCount, sessId, userId, historyRevisionDelta],
  );
  if (upd.rowCount !== 1) {
    // 并发软删抢在 SELECT 与 UPDATE 之间(FOR UPDATE 下不可达;保留作最后防线,宁报终态不复活墓碑)。
    return { applied: false, reason: "session_deleted" };
  }
  // 新 append 的消息拿到的 _seq = admit 的 anchor_seq(user 行位置,projection 排序键)。
  return { applied: true, seq: seqOfMessage(tail, message.id) };
}

/**
 * Transaction-aware seam for prompt-queue activation. Queue state and the
 * corresponding user transcript row must commit or roll back together.
 * Ordinary callers should continue using the backend facade methods below.
 */
export async function appendPromptQueueUserMessageInTransaction(
  client: PoolClient,
  sessionId: string,
  userId: string,
  message: MessageLike & { id: string; role: "user" },
): Promise<ServerAuthoredAppendResult> {
  return pgAppendServerAuthoredCore(client, sessionId, userId, message);
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
  ["client_sessions", "history_revision", "bigint"],
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
      /**
       * late true tape(RFC §2.4):reconciler 已宣告 not_accepted、error 卡已投影,tape 却迟到。
       * 内容仍完整 materialize(钱安全 I5),但 dispatch 转 manual_reconcile 且投影已撤销 —— 调用层
       * (internalServer finalize handler)据此发一条告警交人工核对(已告知用户失败却又产出计费内容)。
       */
      dispatchLateTape?: boolean;
    }
  | { applied: "session_not_found" | "session_deleted" | "incomplete" };

/**
 * finalize 收敛 dispatch(RFC §2.4)。仅当 tape header 带 dispatch_id 时调用(legacy tape 跳过)。
 *   - 非终态(admitted/accepted/rejecting)→ CAS terminal,outcome 映射 tape.status;
 *   - 已 terminal(not_accepted)= late tape → 撤 error projection + manual_reconcile(late_tape);
 *   - 已 terminal(completed 等)/ manual_reconcile → 幂等 no-op。
 * CAS-first(原子);仅失败后读一次判 late tape(此时行已终态,读值稳定)。
 */
async function convergeDispatchOnFinalize(
  client: PoolClient,
  dispatchId: string,
  tapeStatus: string,
): Promise<{ lateTape: boolean; projectionRevoked: boolean }> {
  const outcome =
    tapeStatus === "completed" ? "completed" :
    tapeStatus === "interrupted" ? "interrupted" : "crashed";
  const converged = await casToTerminal(client, {
    dispatchId,
    outcome,
    fromStatuses: ["admitted", "accepted", "rejecting"],
  });
  if (converged !== null) return { lateTape: false, projectionRevoked: false };
  const d = await getDispatch(client, dispatchId);
  if (d && d.status === "terminal" && d.outcome === "not_accepted") {
    const projectionRevoked = await revokeErrorProjection(client, dispatchId);
    const held = await casToManualReconcile(client, {
      dispatchId,
      conflictReason: "late_tape",
      fromStatuses: ["terminal"],
    });
    return { lateTape: held !== null, projectionRevoked };
  }
  return { lateTape: false, projectionRevoked: false };
}

export interface LosslessTurnTapeStorage {
  stageLosslessTurnTapePart(
    userId: string,
    request: LosslessTurnTapePartRequest,
    payload: Buffer,
    /** dispatch 身份(sink 首片带来,落 tape header;finalize 收敛 + GET turn-tape-state 读它)。 */
    dispatchIdentity?: { dispatchId: string; attemptNo: number },
  ): Promise<LosslessTurnTapeStageResult>;
  finalizeLosslessTurnTape(
    userId: string,
    request: LosslessTurnTapeFinalizeRequest,
  ): Promise<LosslessTurnTapeFinalizeResult>;
}

// ── durable turn dispatch 受理面(RFC §2.1 / §2.5 / GET turn-tape-state)──────────
export interface AdmitUserTurnInput {
  /** dispatch user_id(numeric)。 */
  uid: bigint;
  /** client_sessions.user_id(= `c:<uid>`),append user 行用。 */
  sessionUserId: string;
  sessionId: string;
  /** = message.id;dispatch 逻辑键第三段。 */
  clientMessageId: string;
  agentId: string;
  model: string | null;
  /** sha256(text + sorted media refs)。 */
  requestHash: string;
  /** 新行才铸的稳定 billing request id(接管复用旧值)。 */
  billingRequestId: string;
  /** 新行才用的 dispatch_id(fresh uuid)。 */
  dispatchId: string;
  /** 本 bridge 连接 id(lease owner)。 */
  ownerId: string;
  /** 要幂等 append 的 user 消息行。 */
  message: MessageLike & { id: string };
  leaseTtlMs?: number;
  now?: number;
}

export type AdmitUserTurnResult =
  | AdmitDispatchResult
  | { kind: "session_not_found" }
  | { kind: "session_deleted" }
  | { kind: "append_error"; reason: string };

export type TurnTapeDispatchState = "none" | "partial" | "finalized";

/**
 * GET turn-tape-state 的返回(M1)。`state` 决定 boot recovery 分支(none/partial/finalized);
 * `status` = tape header 的精确终态(completed/interrupted/crashed),仅当有 tape 行时非空
 * (none → null)。gateway 侧 recovery 据 status 决定 finalized 分支的具体重播语义。
 */
export interface TurnTapeStateResult {
  state: TurnTapeDispatchState;
  status: string | null;
  /** Same-snapshot secondary fence for gateway recovery when state=none. */
  dispatchLeaseActive: boolean;
}

export interface DispatchAdmissionBackend {
  /** 单事务:幂等 append user 行 → 取 _seq → UPSERT dispatch 冲突表裁定(RFC §2.1)。 */
  admitUserTurn(input: AdmitUserTurnInput): Promise<AdmitUserTurnResult>;
  /** 容器 boot recovery 用:按 dispatch 身份查 tape 三态(none/partial/finalized)+ 精确 status。 */
  getTurnTapeStateByDispatch(
    userId: string,
    dispatchId: string,
    attemptNo: number,
  ): Promise<TurnTapeStateResult>;
  /** 会话读侧 error projection 虚拟行(仅 client-facing 读合并;引擎历史注入绝不含它,RFC §2.5)。 */
  listDispatchErrorProjectionMessages(
    userId: string,
    sessionId: string,
  ): Promise<Record<string, unknown>[]>;
  /** M-§9-1 超大内容"查看完整"按记录有界读:单条 record 的展示文本一个字节窗口(≤256KB/请求,
   *  绝不整卷;分租/不存在/非收敛卷 → null=404)。offset/nextOffset 按 hydrate 后文本字节计。 */
  readTapeRecordChunk(
    sessionId: string,
    userId: string,
    tapeId: string,
    recordOrdinal: number,
    offset: number,
  ): Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null>;
}

export type PgSessionsBackend = ClientSessionsBackend &
  LosslessTurnTapeStorage &
  DispatchAdmissionBackend;

/**
 * 单一投影 helper(RFC §2.5)— client-facing 读边界(full / partial / archive 分页)唯一收口。
 * 仅 `projection==='chat'` 时调用:引擎历史注入(loadMasterSessionMessages,无 options=exact
 * 读)绝不经过这里,失败提示永不进模型上下文。
 *
 * 插入 = 局部 splice 在「最后一个 _seq <= anchor 的行」之后;**绝不全量重排**(等 _seq 的
 * tape 展开行相对顺序是持久化语义,重排=95e5c0ea 那类事故)。幂等:同 id 已存在即跳过。
 * anchorRange 供 archive 分页只并入本页范围内的投影(锚在热尾的绝不落进归档页)。
 */
async function mergeDispatchErrorProjectionRows(
  q: Queryable,
  sessionUserId: string,
  sessionId: string,
  messages: MessageLike[],
  anchorRange?: { minInclusive: number; maxExclusive: number },
): Promise<MessageLike[]> {
  if (!sessionUserId.startsWith("c:")) return messages;
  let uid: bigint;
  try {
    uid = BigInt(sessionUserId.slice(2));
  } catch {
    return messages;
  }
  const rows = await readActiveErrorProjections(q, uid, sessionId);
  if (rows.length === 0) return messages;
  const out = [...messages];
  for (const row of rows) {
    const anchor = Number(row.anchorSeq);
    if (
      anchorRange !== undefined &&
      (anchor < anchorRange.minInclusive || anchor >= anchorRange.maxExclusive)
    ) {
      continue;
    }
    const virtual = projectionToVirtualMessage(row);
    const vid = (virtual as { id: string }).id;
    if (out.some((m) => (m as { id?: unknown }).id === vid)) continue;
    let idx = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      const s = (out[i] as { _seq?: unknown })._seq;
      if (typeof s === "number" && Number.isFinite(s) && s <= anchor) {
        idx = i + 1;
        break;
      }
    }
    out.splice(idx, 0, virtual as MessageLike);
  }
  return out;
}

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
  waive_reason: string | null;
  waiver_applied: boolean;
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
  cost_credits: string;
  delegate_costs: unknown;
};

/** 已解析的每卷可变计费叠加(cost/waiver/delegate)。权威源恒是 turn_tape_cost_components
 *  / pending_usage_patches / turn_waivers —— chat 投影只存不可变内容,这三项读时现算叠加
 *  (RFC §9:waiver 可 finalize 后才 apply / cost 可晚到 stage,冻结即分裂权威)。 */
type ExactUsageEnrichment = {
  costCredits: string;
  waiverApplied: boolean;
  delegates: Array<{ agentId: string; costCredits: string }>;
};

function parseDelegateCosts(value: unknown): Array<{ agentId: string; costCredits: string }> {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        return typeof row.agentId === "string" &&
          typeof row.costCredits === "string" && /^\d+$/.test(row.costCredits)
          ? [{ agentId: row.agentId, costCredits: row.costCredits }]
          : [];
      })
    : [];
}

/** 把可变计费叠加并入行 usage。与今日 hydrateTapeRecord 内联合并逐字节等价:key 顺序
 *  = record/anchor(content 已并) → cost → waiver → delegate;全空则原样返回(不凭空造 usage)。 */
function mergeExactUsage(msg: MessageLike, enrich: ExactUsageEnrichment, isBillingAnchor: boolean): MessageLike {
  const exactCostUsage = BigInt(enrich.costCredits) > 0n ? { costCredits: enrich.costCredits } : {};
  // The live cost_waived frame updates the current browser immediately, but
  // history hydration must carry the same truth for refreshes, offline users
  // and other devices. Only an applied waiver (whose CHECK requires a receipt)
  // may project completion; the tape's pending decision alone is not a refund.
  const exactWaiverUsage = enrich.waiverApplied && isBillingAnchor ? { waived: true } : {};
  const exactDelegateUsage = enrich.delegates.length > 0 ? { delegates: enrich.delegates } : {};
  if (
    Object.keys(exactCostUsage).length === 0 &&
    Object.keys(exactWaiverUsage).length === 0 &&
    Object.keys(exactDelegateUsage).length === 0
  ) {
    return msg;
  }
  const base = msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)
    ? (msg.usage as Record<string, unknown>)
    : {};
  return { ...msg, usage: { ...base, ...exactCostUsage, ...exactWaiverUsage, ...exactDelegateUsage } };
}

/** 内容水合(不含可变计费叠加):hash 校验 + 解析 + _turnTape 作证标记 + 基础 usage
 *  ({...recordUsage,...anchorUsage})。chat 物化投影**只存这一层**;exact 读与 chat 现算
 *  在其上叠加 cost/waiver/delegate。 */
function hydrateTapeRecordContent(
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
    // 来源边界硬化:legacy 分支显式压掉 payload 自带的同名字段(受信 materializer 不会产出,
    // 但作证标记的唯一权威必须是本函数的 fromCompleteAnchor 判定,不能被 ...full 透传)。
    ...(fromCompleteAnchor ? { _turnTapeComplete: true } : { _turnTapeComplete: undefined }),
    // A tape is one atomic sync unit. Expanded records intentionally share
    // its anchor sequence: partial sync either returns every record or none.
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
    ...(Object.keys(recordUsage).length > 0 || Object.keys(anchorUsage).length > 0
      ? { usage: { ...recordUsage, ...anchorUsage } }
      : {}),
  };
}

/** exact 读用:内容水合 + 逐行可变计费叠加(cost/waiver/delegate 来自 hydration SQL 的行内子查询)。
 *  与今日逐字节等价。chat 物化投影读走 hydrateTapeRecordContent + 现算叠加(见 chat 分支)。 */
function hydrateTapeRecord(
  row: HydratedTapeRow,
  anchor: MessageLike,
  requireRecordHash: boolean,
  fromCompleteAnchor = false,
): MessageLike {
  const content = hydrateTapeRecordContent(row, anchor, requireRecordHash, fromCompleteAnchor);
  return mergeExactUsage(
    content,
    {
      costCredits: row.cost_credits,
      waiverApplied: row.waiver_applied,
      delegates: parseDelegateCosts(row.delegate_costs),
    },
    // cost 组件恒挂在 billing anchor 行(SQL billing_anchor_id=r.msg_id);waiver 亦 full.id===anchor.id。
    content.id === anchor.id,
  );
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

// ── 会话读物化投影(RFC §9)────────────────────────────────────────────────────
// 只读缓存派生面:finalize 同事务把该卷的 chat **内容行**(不含可变 cost/waiver)物化进
// tape_chat_projection;chat 读两阶段(header-only → 投影展开),存量卷惰性回填。任何异常
// 降级 = 有界折叠,绝不回退全量水合。投影绝不参与完整性/结算/dedup 写侧(§9.2)。
const PROJECTION_ROW_MAX_BYTES = 64 * 1024; // 逐记录 64KB 截断
const PROJECTION_TAPE_MAX_BYTES = 512 * 1024; // per-tape ≤512KB
const PROJECTION_TAPE_MAX_ROWS = 512; // per-tape ≤512 行
const CHAT_PROJECTION_MAX_BYTES = 8 * 1024 * 1024; // chat 单响应投影总量 ≤8MB
const CHAT_PROJECTION_MAX_ROWS = 2000; // chat 单响应投影总量 ≤2000 行
const DEFAULT_BACKFILL_BYTES = 16 * 1024 * 1024; // OC_BACKFILL_BYTES 默认 16MB
// 分段回填每段最多拉多少 record 行(界定单次 pg fetch,防超大卷一次性入内存)。
const BACKFILL_SEGMENT_RECORD_LIMIT = 4000;
// B-§9-1(R3 重开):预算是**硬**的 —— 任何 record 越本读剩余预算一律 defer 折叠(绝不强读),
// 越整 fullBudget 才判「永不适配」→ 终态 truncated + sentinel(绝不整条拉入进程)。推进保证靠
// 「新一轮读预算重置后可容纳 ≤fullBudget 的单条」:sorted 里最小的未收敛卷在 budget==fullBudget
// 时最先起步,其首条 ≤fullBudget 必被读入(或 >fullBudget 立即 truncated 收敛),故每读至少一卷取得
// 进展 —— 数学上无死锁。删掉旧 FLOOR「小条强读」路径(它破坏硬预算不变量)。

function backfillBudgetBytes(): number {
  const raw = Number(process.env.OC_BACKFILL_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BACKFILL_BYTES;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/** code-point 安全的字节前缀截断(保留前 maxBytes 字节)。 */
function utf8PrefixBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  // 不能切在 UTF-8 continuation 字节中间(0b10xxxxxx),回退到 code-point 边界。
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** 递归找到最长字符串叶子并截断它(从尾部剥离 ~over 字节)。截断到才返回 true。 */
function truncateLongestString(node: unknown, over: number): boolean {
  let bestRef: Record<string | number, unknown> | null = null;
  let bestKey: string | number = "";
  let bestLen = 0;
  const walk = (obj: unknown): void => {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const v = obj[i];
        if (typeof v === "string") {
          const b = Buffer.byteLength(v, "utf8");
          if (b > bestLen) { bestLen = b; bestRef = obj as unknown as Record<number, unknown>; bestKey = i; }
        } else if (v && typeof v === "object") walk(v);
      }
    } else if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj as Record<string, unknown>)) {
        const v = (obj as Record<string, unknown>)[k];
        if (typeof v === "string") {
          const b = Buffer.byteLength(v, "utf8");
          if (b > bestLen) { bestLen = b; bestRef = obj as Record<string, unknown>; bestKey = k; }
        } else if (v && typeof v === "object") walk(v);
      }
    }
  };
  walk(node);
  if (!bestRef || bestLen < 64) return false;
  const cur = String((bestRef as Record<string | number, unknown>)[bestKey]);
  const marker = "…[截断]";
  const keep = Math.max(0, Buffer.byteLength(cur, "utf8") - over - Buffer.byteLength(marker, "utf8"));
  (bestRef as Record<string | number, unknown>)[bestKey] = utf8PrefixBytes(cur, keep) + marker;
  return true;
}

// PG JSONB 不能存 U+0000,且游离代理项(unpaired surrogate)也非法。chat 读侧 exact 水合
// (chatTailRows SQL)历来对二者做 regexp_replace→U+FFFD;物化投影落 JSONB 前必须同语义脱敏,
// 否则 bash tail 里的这类字节会让 INSTALL ::jsonb 抛 22P05。exact/admin 面仍从 BYTEA 读原始字节。
const JSONB_ILLEGAL_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function sanitizeJsonbString(s: string): string {
  JSONB_ILLEGAL_RE.lastIndex = 0;
  if (!JSONB_ILLEGAL_RE.test(s)) return s;
  return s.replace(JSONB_ILLEGAL_RE, "\uFFFD");
}
/** 递归就地脱敏行内所有字符串值(U+0000 / 游离代理项 → U+FFFD),使其可安全落 JSONB。 */
function sanitizeRowForJsonb(node: unknown): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") node[i] = sanitizeJsonbString(v);
      else if (v && typeof v === "object") sanitizeRowForJsonb(v);
    }
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") obj[k] = sanitizeJsonbString(v);
      else if (v && typeof v === "object") sanitizeRowForJsonb(v);
    }
  }
}

function formatProjectionMB(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
const projectionOversizeNote = (bytes: number): string =>
  `内容过大（约 ${formatProjectionMB(bytes)}），已省略预览，可点“查看完整”按记录分块查看。`;

/** B-§9-2 单条越限替身:剥离最长字符串仍越 64KB(叶子全是小字符串/深层结构)→ 固定尺寸替身行,
 *  单条永不越限。保留身份 + 终态判定字段 + `_fullBytes`/`_recordOrdinal`(供前端"查看完整"分块拉取)。 */
function sentinelForOversizeRow(original: MessageLike, fullBytes: number): MessageLike {
  const note = projectionOversizeNote(fullBytes);
  const ordinal = typeof original._recordOrdinal === "number" ? original._recordOrdinal : null;
  return {
    ...(typeof original.id === "string" ? { id: original.id } : {}),
    role: typeof original.role === "string" ? original.role : "tool",
    ...(typeof original.status === "string" ? { status: original.status } : {}),
    ...(typeof original._clientMessageId === "string" ? { _clientMessageId: original._clientMessageId } : {}),
    ...(typeof original._errorCode === "string" ? { _errorCode: original._errorCode } : {}),
    ...(typeof original._turnTapeMsgId === "string" ? { _turnTapeMsgId: original._turnTapeMsgId } : {}),
    ...(ordinal !== null ? { _recordOrdinal: ordinal } : {}),
    _projectionSentinel: true,
    _truncated: true,
    _fullBytes: fullBytes,
    output: note,
    text: note,
  };
}

/** B-§9-1 首/中段 record 越回填预算替身:**未读 payload**,只据 ordinal + octet_length 造替身
 *  (供"查看完整"按记录分块拉取)。绝不整条拉入进程。id 按 (tape,ordinal) 唯一,避免跨卷 dedup 撞键。 */
function sentinelForOversizeRecord(tapeId: string, ordinal: number, fullBytes: number): MessageLike {
  const note = projectionOversizeNote(fullBytes);
  return {
    id: `oc-projection-oversize:${tapeId}:${ordinal}`,
    role: "tool",
    _projectionSentinel: true,
    _truncated: true,
    _fullBytes: fullBytes,
    _recordOrdinal: ordinal,
    output: note,
    text: note,
  };
}

/** M-§9-2 卷级畸形/空卷终态替身:固定尺寸提示行(无 record 身份)。id 带 tapeId,避免跨卷 dedup 撞键。 */
function volumeSentinelRow(tapeId: string, text: string): MessageLike {
  return { id: `oc-projection-note:${tapeId}`, role: "assistant", _projectionSentinel: true, status: "error", text };
}

/** B-§9-3 完成证据:该卷终态 assistant/error 行的最小保真拷贝
 *  (id/_clientMessageId/status/_errorCode/text≤4KB);独立于 rows 行预算,尾截也不丢。 */
function extractTerminalRowEvidence(visible: MessageLike[]): MessageLike | null {
  for (let i = visible.length - 1; i >= 0; i--) {
    const r = visible[i]!;
    const isTerminal =
      r.role === "assistant" || r.role === "error" ||
      typeof r._errorCode === "string" || r.status === "error" || r.status === "completed";
    if (!isTerminal) continue;
    const ev: MessageLike = {
      ...(typeof r.id === "string" ? { id: r.id } : {}),
      ...(typeof r.role === "string" ? { role: r.role } : {}),
      ...(typeof r._clientMessageId === "string" ? { _clientMessageId: r._clientMessageId } : {}),
      ...(typeof r.status === "string" ? { status: r.status } : {}),
      ...(typeof r._errorCode === "string" ? { _errorCode: r._errorCode } : {}),
      ...(r._turnTapeComplete === true ? { _turnTapeComplete: true } : {}),
      _projectionTerminalEvidence: true,
      text: typeof r.text === "string" ? utf8PrefixBytes(r.text, 4096) : "",
    };
    sanitizeRowForJsonb(ev);
    return ev;
  }
  return null;
}

/** B-§9-3(R3)兜底完成证据:**不读任何 record payload**,从 tape header status + dispatch join 的
 *  client_message_id 合成最小终态证据行。三条终态 truncated 路径(空卷/首条越预算/解析错)即便一条
 *  record 都没 hydrate,仍无条件写 header terminal_row —— 前端按 exact clientMessageId 清 in-flight +
 *  抑制同轮 projection,engine readGenerationProjectionRows dedup 兜底(role='assistant')也成立。
 *  clientMessageId 只能来自 dispatch join(content 不可读);legacy 无 dispatch 卷 → 无 cmid(仍写 status
 *  证据,至少保完成态)。id 稳定唯一(tape 派生),避免跨卷 dedup 撞键。text:''(engine 窗口按空文本过滤
 *  不入模型上下文;判定字段完整保真)。 */
async function synthesizeTerminalRowFromHeader(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
): Promise<MessageLike | null> {
  const r = (await client.query<{ tape_status: string | null; client_message_id: string | null }>(
    `SELECT t.status AS tape_status, d.client_message_id
       FROM client_session_turn_tapes t
       LEFT JOIN turn_dispatches d ON d.dispatch_id = t.dispatch_id
      WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3`,
    [sessionId, userId, tapeId],
  )).rows[0];
  if (!r) return null;
  const status = r.tape_status;
  if (status !== "completed" && status !== "interrupted" && status !== "crashed") return null;
  const ev: MessageLike = {
    id: `oc-projection-terminal:${tapeId}`,
    role: "assistant",
    ...(typeof r.client_message_id === "string" ? { _clientMessageId: r.client_message_id } : {}),
    status,
    // crashed 走 dispatch_lost 展示码(前端 DISPATCH_LOST_ERROR_CODES 识别);completed 带完成戳(engine
    // tryDedupCompleted 据此认既有完成 turn)。interrupted 仅保 status。
    ...(status === "crashed" ? { _errorCode: "SERVICE_RESTART" } : {}),
    ...(status === "completed" ? { _turnTapeComplete: true } : {}),
    _projectionTerminalEvidence: true,
    text: "",
  };
  sanitizeRowForJsonb(ev);
  return ev;
}

/** 单条投影行 64KB 截断:超限则剥离最长内容字符串,标 `_truncated:true` + `_fullBytes`;
 *  B-§9-2 硬上限收口:剥离后仍越 64KB → 替换为固定尺寸 sentinel(单条永不越限)。
 *  chat-safe:绝不吐 exact 原始超大 payload,超大记录只能在 chat 面看到截断预览。 */
function truncateProjectionRow(row: MessageLike): { row: MessageLike; bytes: number } {
  const fullBytes = jsonBytes(row);
  if (fullBytes <= PROJECTION_ROW_MAX_BYTES) return { row, bytes: fullBytes };
  const clone = structuredClone(row) as MessageLike;
  let guard = 0;
  while (jsonBytes(clone) > PROJECTION_ROW_MAX_BYTES && guard++ < 16) {
    const over = jsonBytes(clone) - PROJECTION_ROW_MAX_BYTES;
    if (!truncateLongestString(clone, over + 512)) break;
  }
  clone._truncated = true;
  clone._fullBytes = fullBytes;
  const clonedBytes = jsonBytes(clone);
  if (clonedBytes > PROJECTION_ROW_MAX_BYTES) {
    const sentinel = sentinelForOversizeRow(row, fullBytes);
    return { row: sentinel, bytes: jsonBytes(sentinel) };
  }
  return { row: clone, bytes: clonedBytes };
}

type ProjectionSourceRecord = {
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
};

/** bash_output_tail runtime-event 的资格 + 目标键(与 projectClientSessionMessagesForChat 一致的
 *  轻校验;读侧 projectClientSessionMessagesForChat 会再校验一次,build 只求 winner 去重有界)。 */
function tailWinnerTarget(runtimeEvent: unknown): { target: string; totalBytes: number } | null {
  if (!runtimeEvent || typeof runtimeEvent !== "object" || Array.isArray(runtimeEvent)) return null;
  const ev = runtimeEvent as Record<string, unknown>;
  if (ev.type !== "system" || ev.subtype !== "bash_output_tail") return null;
  const tool = ev.tool_use_id;
  if (typeof tool !== "string" || !/^[A-Za-z0-9_-]+$/.test(tool)) return null;
  const rawParent = ev.parent_tool_use_id;
  const parent = typeof rawParent === "string" && rawParent.length > 0 ? rawParent : "";
  const totalBytes = typeof ev.total_bytes === "number" && Number.isFinite(ev.total_bytes)
    ? Math.max(0, ev.total_bytes) : 0;
  return { target: `${parent}\0${tool}`, totalBytes };
}

/** 从一卷 tape 的有序 record 构建 chat 内容投影行(visible 行 + bash_output_tail winner)。
 *  与今日 chat 水合(chatVisibleRows + chatTailRows winner 选取 → hydrateTapeRecordContent)同构,
 *  但**不含**可变 cost/waiver(读时现算叠加)。逐记录 64KB 截断 + per-tape 512KB/512 行尾截。
 *  existing = 分段回填时已累计的行(visible 追加、tail winner 合并)。 */
function buildTapeChatContentRows(
  records: ProjectionSourceRecord[],
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  existing?: { visible: MessageLike[]; tailWinners: Map<string, { row: MessageLike; totalBytes: number; ordinal: number }> },
): {
  visible: MessageLike[];
  tailWinners: Map<string, { row: MessageLike; totalBytes: number; ordinal: number }>;
} {
  // content 水合用的最小 anchor:只带 id(billing anchor,供 anchorUsage 判定)+ sha(_turnTapeSha256
  // 由 row.tape_sha256 决定,这里不影响)。刻意不带 _seq/_orderSeq —— 投影不入库序号,读时现盖。
  const contentAnchor: MessageLike = { id: billingAnchorId, _turnTapeSha256: tapeSha256 };
  const visible = existing ? existing.visible : [];
  const tailWinners = existing ? existing.tailWinners : new Map<string, { row: MessageLike; totalBytes: number; ordinal: number }>();
  for (const rec of records) {
    const hydrationRow: HydratedTapeRow = {
      tape_id: tapeId,
      tape_sha256: tapeSha256,
      waive_reason: null,
      waiver_applied: false,
      msg_id: rec.msg_id,
      ordinal: rec.ordinal,
      role: rec.role,
      content_sha256: rec.content_sha256,
      payload: rec.payload,
      cost_credits: "0",
      delegate_costs: [],
    };
    const content = hydrateTapeRecordContent(hydrationRow, contentAnchor, false, true);
    // 记录 ordinal(= client_session_turn_tape_records.ordinal):截断行携此 → 前端"查看完整"
    // 按 recordOrdinal 分块拉取该记录(M-§9-1);读侧渲染忽略,sanitizer 白名单会剥离,不入模型上下文。
    content._recordOrdinal = rec.ordinal;
    if (rec.role !== "runtime-event") {
      visible.push(content);
      continue;
    }
    const target = tailWinnerTarget(content._runtimeEvent);
    if (!target) continue; // 非 bash_output_tail runtime-event:chat 不展示,丢弃(与 chatVisibleRows 同)。
    const prev = tailWinners.get(target.target);
    if (!prev || target.totalBytes > prev.totalBytes ||
        (target.totalBytes === prev.totalBytes && rec.ordinal > prev.ordinal)) {
      tailWinners.set(target.target, { row: content, totalBytes: target.totalBytes, ordinal: rec.ordinal });
    }
  }
  return { visible, tailWinners };
}

/** R4-B2:有界追加的唯一收口 —— 追加 nextBytes 前按行数/字节双上限弹出尾行,返回弹出后的 totalBytes。
 *  finalizeProjectionRows 与 commitVolumeTruncated 共用:任何合成行(terminal 证据 sentinel)追加都必须
 *  经此,512 行/512KB 是**硬**上限,合成证据也不例外。 */
function evictTailForBoundedAppend(out: MessageLike[], totalBytes: number, nextBytes: number): number {
  while (
    out.length > 0 &&
    (out.length >= PROJECTION_TAPE_MAX_ROWS || totalBytes + nextBytes > PROJECTION_TAPE_MAX_BYTES)
  ) {
    totalBytes -= jsonBytes(out.pop()!);
  }
  return totalBytes;
}

/** 把 build 累计的 visible + tailWinners 摊平成有序投影行(visible 按 ordinal,winner 按 ordinal 追加),
 *  逐记录 64KB 截断 + per-tape 512KB/512 行尾截,返回可落库形态。
 *  B-§9-2:去掉「首行免死」豁免 —— 单条经 truncateProjectionRow 恒 ≤64KB,卷级第一条也不得越 512KB。
 *  B-§9-3:尾截把 terminal 行截掉时,rows 末尾必保 terminal 完成证据(必要时弹出末行腾位,守 ≤512 行/512KB);
 *  并返回 terminalRow 供 header 列无条件写。
 *  MINOR①:winner 行落 `_winnerOrdinal`,building 续段 rehydrate 用真实 ordinal(非 MAX_SAFE_INTEGER)。 */
function finalizeProjectionRows(
  visible: MessageLike[],
  tailWinners: Map<string, { row: MessageLike; totalBytes: number; ordinal: number }>,
): { rows: MessageLike[]; totalBytes: number; truncated: boolean; terminalRow: MessageLike | null } {
  const ordered: MessageLike[] = [
    ...visible,
    ...[...tailWinners.values()].sort((a, b) => a.ordinal - b.ordinal).map((w) => ({ ...w.row, _winnerOrdinal: w.ordinal })),
  ];
  const terminalRow = extractTerminalRowEvidence(visible);
  const out: MessageLike[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const row of ordered) {
    if (out.length >= PROJECTION_TAPE_MAX_ROWS) { truncated = true; break; }
    // 落 JSONB 前脱敏 U+0000/游离代理项(否则 ::jsonb 抛 22P05);再按字节截断计量。
    sanitizeRowForJsonb(row);
    const t = truncateProjectionRow(row);
    if (totalBytes + t.bytes > PROJECTION_TAPE_MAX_BYTES) { truncated = true; break; }
    out.push(t.row);
    totalBytes += t.bytes;
  }
  // B-§9-3:尾截掉了 terminal 行 → rows 末尾补 terminal 完成证据 sentinel(必要时弹末行腾位守上限)。
  if (truncated && terminalRow) {
    const alreadyHas = terminalRow.id !== undefined && out.some((r) => r.id === terminalRow.id);
    if (!alreadyHas) {
      const sentinel: MessageLike = { ...terminalRow, _projectionTruncated: true };
      sanitizeRowForJsonb(sentinel);
      const sBytes = jsonBytes(sentinel);
      totalBytes = evictTailForBoundedAppend(out, totalBytes, sBytes);
      out.push(sentinel);
      totalBytes += sBytes;
    }
  }
  return { rows: out, totalBytes, truncated, terminalRow };
}

/** finalize 同事务:从已 materialize 的 records 写该卷 chat 投影(state=complete/truncated)。
 *  幂等:PK 冲突 DO NOTHING(同 sha 即已有;finalize 持 tape FOR UPDATE,首写恒最先)。 */
async function writeTapeChatProjectionOnFinalize(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  records: ProjectionSourceRecord[],
): Promise<void> {
  const { visible, tailWinners } = buildTapeChatContentRows(records, tapeId, tapeSha256, billingAnchorId);
  const built = finalizeProjectionRows(visible, tailWinners);
  await client.query(
    `INSERT INTO tape_chat_projection
       (session_id,user_id,tape_id,rows,state,next_part,tape_sha256,total_bytes,row_count,terminal_row,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,NOW())
     ON CONFLICT (session_id,user_id,tape_id) DO NOTHING`,
    [
      sessionId, userId, tapeId, JSON.stringify(built.rows),
      built.truncated ? "truncated" : "complete",
      records.length, tapeSha256, built.totalBytes, built.rows.length,
      built.terminalRow ? JSON.stringify(built.terminalRow) : null,
    ],
  );
}

type ProjectionHeader = {
  state: "building" | "complete" | "truncated";
  tape_sha256: string;
  total_bytes: number;
  row_count: number;
  /** B-§9-3 完成证据(独立于 rows 行预算):尾截丢了 terminal 行时读侧兜底。小 JSONB,与 rows 分列,不 detoast 大字段。 */
  terminalRow: MessageLike | null;
};

/** chat 读第一阶段:只读投影 header(**不含 rows JSONB,绝不触 parts/records BYTEA**)。 */
async function readProjectionHeaders(
  q: Queryable,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, ProjectionHeader>> {
  if (tapeIds.length === 0) return new Map();
  const res = await q.query<{
    tape_id: string; state: string; tape_sha256: string; total_bytes: string; row_count: number;
    terminal_row: MessageLike | null;
  }>(
    // terminal_row 是小 JSONB(独立列),不含大 rows JSONB → SELECT 不 detoast 大字段(仍守「header-only 不触 BYTEA」)。
    `SELECT tape_id, state, tape_sha256, total_bytes, row_count, terminal_row
       FROM tape_chat_projection
      WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[])`,
    [sessionId, userId, tapeIds],
  );
  return new Map(res.rows.map((r) => [r.tape_id, {
    state: r.state as ProjectionHeader["state"],
    tape_sha256: r.tape_sha256,
    total_bytes: bigIntNum(r.total_bytes, "tape_chat_projection.total_bytes"),
    row_count: r.row_count,
    terminalRow: r.terminal_row && typeof r.terminal_row === "object" ? r.terminal_row : null,
  }]));
}

type TapeCostEnrichment = { billingAnchorId: string | null } & ExactUsageEnrichment;

/** chat 读:批量现算每卷可变计费叠加(turn_tape_cost_components + pending + turn_waivers,
 *  **均非 BYTEA 表**)。权威源不冻结在投影里 —— waiver 可 finalize 后 apply、cost 可晚到 stage。 */
async function readTapeCostEnrichment(
  q: Queryable,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, TapeCostEnrichment>> {
  if (tapeIds.length === 0) return new Map();
  const res = await q.query<{
    tape_id: string; billing_anchor_id: string | null; cost_credits: string;
    waiver_applied: boolean; delegate_costs: unknown;
  }>(
    `SELECT t.tape_id, t.billing_anchor_id,
            EXISTS (
              SELECT 1 FROM turn_waivers w
               WHERE ('c:' || w.user_id::text)=t.user_id
                 AND w.turn_key=t.turn_key AND w.status='applied'
            ) AS waiver_applied,
            COALESCE((
              SELECT SUM(c.cost_credits)::text FROM (
                SELECT c.cost_credits::numeric AS cost_credits
                  FROM turn_tape_cost_components c
                 WHERE c.user_id=t.user_id AND c.session_id=t.session_id
                   AND c.tape_id=t.tape_id AND c.billing_anchor_id=t.billing_anchor_id
                UNION ALL
                SELECT p.cost_credits::numeric AS cost_credits
                  FROM pending_usage_patches p
                 WHERE p.user_id=t.user_id
                   AND t.billing_anchor_id IS NOT NULL
                   AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
              ) c
            ), '0') AS cost_credits,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('agentId', g.delegate_agent_id, 'costCredits', g.cost_credits)
                       ORDER BY g.delegate_agent_id)
                FROM (
                  SELECT d.delegate_agent_id, SUM(d.cost_credits)::text AS cost_credits FROM (
                    SELECT c.delegate_agent_id, c.cost_credits::numeric AS cost_credits
                      FROM turn_tape_cost_components c
                     WHERE c.user_id=t.user_id AND c.session_id=t.session_id
                       AND c.tape_id=t.tape_id AND c.billing_anchor_id=t.billing_anchor_id
                    UNION ALL
                    SELECT p.delegate_agent_id, p.cost_credits::numeric AS cost_credits
                      FROM pending_usage_patches p
                     WHERE p.user_id=t.user_id
                       AND t.billing_anchor_id IS NOT NULL
                       AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                  ) d WHERE d.delegate_agent_id IS NOT NULL
                  GROUP BY d.delegate_agent_id
                ) g
            ), '[]'::jsonb) AS delegate_costs
       FROM client_session_turn_tapes t
      WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])`,
    [sessionId, userId, tapeIds],
  );
  return new Map(res.rows.map((r) => [r.tape_id, {
    billingAnchorId: r.billing_anchor_id,
    costCredits: r.cost_credits,
    waiverApplied: r.waiver_applied,
    delegates: parseDelegateCosts(r.delegate_costs),
  }]));
}

type CollapseMeta = { totalBytes: number; clientMessageId: string | null; dispatchOutcome: string | null };

/** tape header 精确终态(completed/interrupted/crashed)→ 折叠行 outcome。其它/缺失一律不给终态字段。 */
function mapTapeStatusToOutcome(status: string | null): string | null {
  return status === "completed" || status === "interrupted" || status === "crashed" ? status : null;
}

/** 折叠行元数据(B-§9-4):outcome **权威 = client_session_turn_tapes.status**(tape header 精确终态),
 *  **不再** 取 turn_dispatches.outcome —— 后者会把 late-tape 转 manual(outcome=not_accepted)错显成折叠行
 *  的终态,且 legacy 无 dispatch 卷拿不到终态。dispatch 仅补 client_message_id(前端按 exact cmid 清 in-flight)。 */
async function readCollapseMeta(
  q: Queryable,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, CollapseMeta>> {
  if (tapeIds.length === 0) return new Map();
  const res = await q.query<{
    tape_id: string; total_bytes: string; client_message_id: string | null; tape_status: string | null;
  }>(
    `SELECT t.tape_id, t.total_bytes, d.client_message_id, t.status AS tape_status
       FROM client_session_turn_tapes t
       LEFT JOIN turn_dispatches d ON d.dispatch_id = t.dispatch_id
      WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])`,
    [sessionId, userId, tapeIds],
  );
  return new Map(res.rows.map((r) => [r.tape_id, {
    totalBytes: bigIntNumOr(r.total_bytes, 0),
    clientMessageId: r.client_message_id,
    dispatchOutcome: mapTapeStatusToOutcome(r.tape_status),
  }]));
}

/** M-§9-3 展开集批量读投影 rows(complete/truncated),一次 tape_id=ANY 取回,消 N+1。 */
async function readProjectionRowsBatch(
  q: Queryable,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, MessageLike[]>> {
  const out = new Map<string, MessageLike[]>();
  if (tapeIds.length === 0) return out;
  const res = await q.query<{ tape_id: string; rows: MessageLike[] }>(
    `SELECT tape_id, rows FROM tape_chat_projection
      WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[]) AND state IN ('complete','truncated')`,
    [sessionId, userId, tapeIds],
  );
  for (const r of res.rows) if (Array.isArray(r.rows)) out.set(r.tape_id, r.rows);
  return out;
}

/** M-§9-2 卷级终态截断:畸形/空卷/越预算首条 → truncated + sentinel 行 + terminal_row。一次性 log
 *  (此后读侧见 truncated 不再回填,自然不复触)。调用前顶部块已确保 building 行存在,故恒走 UPDATE +
 *  CAS 守 building/next_part/sha,防覆盖并发进展(CAS 落空即别人已推进,不 log noise 也无害)。 */
async function commitVolumeTruncated(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  expectedSha: string,
  fromNextPart: number,
  rows: MessageLike[],
  terminalRow: MessageLike | null,
  logReason: string,
): Promise<void> {
  // B-§9-3(R3):终态证据带 _clientMessageId 时并入 rows 末尾(chat 读据此按 exact cmid 清 in-flight /
  // 抑制同轮 projection —— 卷级 sentinel 本身无 cmid);terminal_row 列独立写(engine
  // readGenerationProjectionRows dedup 兜底)。二者同源,无 payload 读。
  const outRows = [...rows];
  let outBytes = outRows.reduce((s, r) => s + jsonBytes(r), 0);
  if (terminalRow && typeof terminalRow._clientMessageId === "string") {
    const has = terminalRow.id !== undefined && outRows.some((r) => r.id === terminalRow.id);
    if (!has) {
      const evid: MessageLike = { ...terminalRow, _projectionTruncated: true };
      sanitizeRowForJsonb(evid);
      // R4-B2:合成证据同样过硬上限收口(512 building 行 + oversize 次条的构造曾越到 513 行)。
      const evidBytes = jsonBytes(evid);
      outBytes = evictTailForBoundedAppend(outRows, outBytes, evidBytes);
      outRows.push(evid);
      outBytes += evidBytes;
    }
  }
  const totalBytes = outBytes;
  const upd = await client.query(
    `UPDATE tape_chat_projection
        SET rows=$4::jsonb, state='truncated', next_part=$5, total_bytes=$6, row_count=$7,
            terminal_row=$8::jsonb, updated_at=NOW()
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND state='building'
        AND next_part=$9 AND tape_sha256=$10`,
    [sessionId, userId, tapeId, JSON.stringify(outRows), outRows.length, totalBytes, outRows.length,
      terminalRow ? JSON.stringify(terminalRow) : null, fromNextPart, expectedSha],
  );
  if ((upd.rowCount ?? 0) > 0) {
    // eslint-disable-next-line no-console
    console.warn("[pgSessions] tape_chat_projection volume terminally truncated", { sessionId, tapeId, reason: logReason });
  }
}

/** 惰性回填一卷(单段):从 building 游标 next_part 起读 records(BYTEA;仅存量无投影卷),构建投影,
 *  CAS 推进。返回终态(complete/truncated 可展开;building 本次折叠)+ 本段读取字节数。
 *  B-§9-1:先读 record header(octet_length),预算内才 SELECT payload;单条越预算绝不整读(sentinel)。
 *  M-§9-2:空卷/解析异常 → 终态 truncated + sentinel(一次性 log,二读不复触)。
 *  sha 漂移 → 作废重建;并发 CAS 失败 → 回读现态。绝不回退全量水合。 */
async function backfillTapeSegment(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  expectedSha: string,
  billingAnchorId: string,
  budgetBytes: number,
): Promise<{ state: ProjectionHeader["state"]; bytesRead: number }> {
  return withTx(pool, async (client) => {
    // 该卷 record 总数(判定分段是否读尽)。
    const cnt = (await client.query<{ n: string; maxo: number | null }>(
      `SELECT COUNT(*)::text AS n, MAX(ordinal) AS maxo
         FROM client_session_turn_tape_records WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [sessionId, userId, tapeId],
    )).rows[0];
    const recordCount = Number(cnt?.n ?? 0);

    // 现态(FOR UPDATE 串行化同卷并发回填)。
    const existingRow = (await client.query<{
      state: string; next_part: number; tape_sha256: string; rows: MessageLike[];
    }>(
      `SELECT state, next_part, tape_sha256, rows FROM tape_chat_projection
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 FOR UPDATE`,
      [sessionId, userId, tapeId],
    )).rows[0];
    if (existingRow && (existingRow.state === "complete" || existingRow.state === "truncated")) {
      return { state: existingRow.state as ProjectionHeader["state"], bytesRead: 0 };
    }
    // sha 漂移(tape 被重写)或不存在 → 重置为 next_part=0 的新 building。
    let nextPart = 0;
    let acc: { visible: MessageLike[]; tailWinners: Map<string, { row: MessageLike; totalBytes: number; ordinal: number }> } =
      { visible: [], tailWinners: new Map() };
    if (existingRow && existingRow.state === "building" && existingRow.tape_sha256 === expectedSha) {
      nextPart = existingRow.next_part;
      acc = rehydrateBuildingAccumulator(Array.isArray(existingRow.rows) ? existingRow.rows : []);
    }
    const shaDrift = !!existingRow && existingRow.tape_sha256 !== expectedSha;
    if (!existingRow) {
      await client.query(
        `INSERT INTO tape_chat_projection
           (session_id,user_id,tape_id,rows,state,next_part,tape_sha256,total_bytes,row_count)
         VALUES ($1,$2,$3,'[]'::jsonb,'building',0,$4,0,0)
         ON CONFLICT (session_id,user_id,tape_id) DO NOTHING`,
        [sessionId, userId, tapeId, expectedSha],
      );
    } else if (shaDrift) {
      await client.query(
        `UPDATE tape_chat_projection SET rows='[]'::jsonb, state='building', next_part=0,
                tape_sha256=$4, total_bytes=0, row_count=0, terminal_row=NULL, updated_at=NOW()
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [sessionId, userId, tapeId, expectedSha],
      );
      nextPart = 0;
      acc = { visible: [], tailWinners: new Map() };
    }
    const casFromNextPart = shaDrift ? 0 : nextPart;

    // M-§9-2:空卷(finalized anchor 却无 records = 畸形)→ 终态 truncated + 卷级 sentinel + 一次性 log。
    // B-§9-3(R3):无条件写 header terminal_row(从 tape header + dispatch join 合成,无 payload 读)。
    if (recordCount === 0) {
      const synth = await synthesizeTerminalRowFromHeader(client, sessionId, userId, tapeId);
      await commitVolumeTruncated(
        client, sessionId, userId, tapeId, expectedSha, casFromNextPart,
        [volumeSentinelRow(tapeId, "该轮内容缺失，无法展开。")], synth, "empty_records",
      );
      return { state: "truncated", bytesRead: 0 };
    }

    // B-§9-1:先读 record header(ordinal + octet_length,**不拉 payload**),预算内才决定 SELECT 哪些 payload。
    const fullBudget = backfillBudgetBytes();
    const heads = (await client.query<{ ordinal: number; sz: number }>(
      `SELECT ordinal, octet_length(payload) AS sz
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal >= $4
        ORDER BY ordinal LIMIT $5`,
      [sessionId, userId, tapeId, nextPart, BACKFILL_SEGMENT_RECORD_LIMIT],
    )).rows;

    const consumeOrdinals: number[] = [];
    let planned = 0;
    let oversize: { ordinal: number; sz: number } | null = null;
    let deferred = false;
    for (const h of heads) {
      const sz = Number(h.sz) || 0;
      if (consumeOrdinals.length === 0) {
        // 首条 record 的硬预算准入(R3:无 FLOOR 强读):
        if (sz > fullBudget) { oversize = { ordinal: h.ordinal, sz }; break; } // 超整预算 → 永不适配任一单读 → sentinel + truncated,绝不整条拉入进程
        if (sz > budgetBytes) { deferred = true; break; }                       // 超本读剩余预算(整预算够)→ defer(本次折叠,下轮空预算 ≤fullBudget 必可读)
        // ≤ 本读剩余预算 → 读入(单条内存安全);消费后进入 else 分支按剩余预算续接。
      } else if (planned + sz > budgetBytes) {
        break;
      }
      consumeOrdinals.push(h.ordinal);
      planned += sz;
    }

    // B-§9-1:首条 record 越整预算 → 该卷直接 truncated + 单记录 sentinel(未读 payload)。
    // B-§9-3(R3):完成证据优先取 acc.visible 已 hydrate 的真终态行;acc 无(首条即越预算,一条都没
    // hydrate)→ 从 header 合成,保证 terminal_row 非空。
    if (oversize) {
      const rows = finalizeProjectionRows(
        [...acc.visible, sentinelForOversizeRecord(tapeId, oversize.ordinal, oversize.sz)],
        acc.tailWinners,
      );
      const terminal = rows.terminalRow
        ?? await synthesizeTerminalRowFromHeader(client, sessionId, userId, tapeId);
      await commitVolumeTruncated(
        client, sessionId, userId, tapeId, expectedSha, casFromNextPart,
        rows.rows, terminal, `record_over_budget:${oversize.sz}>${fullBudget}`,
      );
      return { state: "truncated", bytesRead: 0 };
    }
    // 本读剩余预算不足以起步该卷(整预算足)→ 不消费、保持 building、本次折叠,下次读足预算再收敛。
    if (deferred || consumeOrdinals.length === 0) {
      return { state: "building", bytesRead: 0 };
    }

    // 预算内的 record:仅 SELECT 这些 ordinal 的 payload(有界,绝不整卷拉入)。
    const lastConsume = consumeOrdinals[consumeOrdinals.length - 1]!;
    const seg = (await client.query<ProjectionSourceRecord>(
      `SELECT msg_id, ordinal, role, content_sha256, payload
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal >= $4 AND ordinal <= $5
        ORDER BY ordinal`,
      [sessionId, userId, tapeId, nextPart, lastConsume],
    )).rows;
    let bytesRead = 0;
    const consume: ProjectionSourceRecord[] = [];
    let lastOrdinal = nextPart - 1;
    for (const rec of seg) {
      const payload = Buffer.from(rec.payload);
      consume.push({ ...rec, payload });
      bytesRead += payload.length;
      lastOrdinal = rec.ordinal;
    }

    // M-§9-2:record payload 解析异常(坏 JSON / hash 不符)→ 终态 truncated + 卷级 sentinel + 一次性 log。
    let built: { visible: MessageLike[]; tailWinners: Map<string, { row: MessageLike; totalBytes: number; ordinal: number }> };
    let finalized: { rows: MessageLike[]; totalBytes: number; truncated: boolean; terminalRow: MessageLike | null };
    try {
      built = buildTapeChatContentRows(consume, tapeId, expectedSha, billingAnchorId, acc);
      finalized = finalizeProjectionRows(built.visible, built.tailWinners);
    } catch (err) {
      // B-§9-3(R3):解析错也无条件写 header terminal_row(从 header 合成,无 payload 读)。
      const synth = await synthesizeTerminalRowFromHeader(client, sessionId, userId, tapeId);
      await commitVolumeTruncated(
        client, sessionId, userId, tapeId, expectedSha, casFromNextPart,
        [volumeSentinelRow(tapeId, "该轮内容无法解析，已停止展开。")], synth,
        `record_parse_error:${(err as Error)?.message ?? "unknown"}`,
      );
      return { state: "truncated", bytesRead: 0 };
    }

    const reachedEnd = cnt?.maxo != null && lastOrdinal >= cnt.maxo;
    const newState = reachedEnd
      ? (finalized.truncated ? "truncated" : "complete")
      : (finalized.truncated ? "truncated" : "building");
    // CAS 推进:防并发 lost-update(WHERE state='building' AND next_part=$prev AND sha 未漂移)。terminal_row 无条件写。
    const upd = await client.query(
      `UPDATE tape_chat_projection
          SET rows=$4::jsonb, state=$5, next_part=$6, total_bytes=$7, row_count=$8,
              terminal_row=$11::jsonb, updated_at=NOW()
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND state='building' AND next_part=$9 AND tape_sha256=$10`,
      [
        sessionId, userId, tapeId, JSON.stringify(finalized.rows), newState,
        lastOrdinal + 1, finalized.totalBytes, finalized.rows.length, casFromNextPart, expectedSha,
        finalized.terminalRow ? JSON.stringify(finalized.terminalRow) : null,
      ],
    );
    if ((upd.rowCount ?? 0) === 0) {
      // 并发已推进/漂移 → 回读现态(不覆盖)。
      const cur = (await client.query<{ state: string }>(
        `SELECT state FROM tape_chat_projection WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [sessionId, userId, tapeId],
      )).rows[0];
      const st = cur?.state === "complete" || cur?.state === "truncated" ? cur.state : "building";
      return { state: st as ProjectionHeader["state"], bytesRead };
    }
    return { state: newState as ProjectionHeader["state"], bytesRead };
  });
}

/** 从 building 行已累计的 rows 还原 build 累加器(visible + tail winner map)供下一段续建。 */
function rehydrateBuildingAccumulator(
  rows: MessageLike[],
): { visible: MessageLike[]; tailWinners: Map<string, { row: MessageLike; totalBytes: number; ordinal: number }> } {
  const visible: MessageLike[] = [];
  const tailWinners = new Map<string, { row: MessageLike; totalBytes: number; ordinal: number }>();
  for (const row of rows) {
    if (row.role === "runtime-event") {
      const target = tailWinnerTarget(row._runtimeEvent);
      if (target) {
        // MINOR①:winner 落库带 `_winnerOrdinal`(真实 ordinal),续段还原用它排序/去重 —— 非
        // MAX_SAFE_INTEGER(否则跨段 winner 排序错位、同 total_bytes 平局永不被更晚 ordinal 覆盖)。
        const ordinal = typeof row._winnerOrdinal === "number" ? row._winnerOrdinal : Number.MAX_SAFE_INTEGER;
        tailWinners.set(target.target, { row, totalBytes: target.totalBytes, ordinal });
      }
      continue;
    }
    visible.push(row);
  }
  return { visible, tailWinners };
}

/** chat 读第二阶段:把某卷投影行现盖 _seq/_orderSeq(活体 anchor)+ 现算 cost/waiver 叠加;
 *  卷级截断(state='truncated')时给末行盖 `_projectionTruncated:true`(前端渲染「已截断,查看完整」)。 */
function applyProjectionForChat(
  storedRows: MessageLike[],
  anchor: MessageLike,
  enrich: TapeCostEnrichment | undefined,
  truncated: boolean,
): MessageLike[] {
  const billingAnchorId = enrich?.billingAnchorId ?? null;
  const out = storedRows.map((stored) => {
    let row: MessageLike = { ...stored };
    // `_winnerOrdinal` 是 building 续段内部记账,不上 wire;`_recordOrdinal` 仅截断行需要
    // (前端"查看完整"按记录分块拉),非截断行剥掉减噪。
    delete row._winnerOrdinal;
    if (row._truncated !== true) delete row._recordOrdinal;
    if (typeof anchor._seq === "number") row._seq = anchor._seq;
    else delete row._seq;
    if (typeof anchor._orderSeq === "number") row._orderSeq = anchor._orderSeq;
    else delete row._orderSeq;
    if (enrich && billingAnchorId !== null && row.id === billingAnchorId) {
      row = mergeExactUsage(row, enrich, true);
    }
    return row;
  });
  if (truncated && out.length > 0) out[out.length - 1]!._projectionTruncated = true;
  return out;
}

/** 折叠 anchor 行(RFC §9):anchor 原样 + 显式终态字段。finalized 折叠 = 终态存在证据,≠ 内容已展开。 */
function collapsedAnchorRow(anchor: MessageLike, meta: CollapseMeta | undefined): MessageLike {
  return {
    ...anchor,
    _tapeCollapsed: true,
    _tapeTotalBytes: meta?.totalBytes ?? 0,
    _clientMessageId: meta?.clientMessageId ?? (anchor._clientMessageId as string | undefined) ?? undefined,
    _dispatchOutcome: meta?.dispatchOutcome ?? undefined,
  };
}

/** chat 读物化投影主路径(RFC §9)。两阶段:header-only → 投影展开;存量卷惰性回填;
 *  超预算 / building / 异常一律**有界折叠**,绝不回退全量水合。 */
async function hydrateChatFromProjection(
  pool: Pool,
  sessionId: string,
  userId: string,
  messages: MessageLike[],
): Promise<MessageLike[]> {
  const tapeAnchors = messages.filter(
    (m) => m && typeof m._turnTapeId === "string" && typeof m._turnTapeSha256 === "string",
  );
  const tapeIds = [...new Set(tapeAnchors.map((m) => m._turnTapeId as string))];

  // 第一阶段:只读投影 header(不触任何 BYTEA)。
  const headers = await readProjectionHeaders(pool, sessionId, userId, tapeIds);
  // 每卷 anchor 的 sha(判定投影漂移)。同 tapeId 多 anchor 罕见,取首个。
  const shaByTape = new Map<string, string>();
  for (const a of tapeAnchors) {
    const tid = a._turnTapeId as string;
    if (!shaByTape.has(tid)) shaByTape.set(tid, a._turnTapeSha256 as string);
  }

  // 可用投影(complete/truncated 且 sha 未漂移)vs 待回填(无/building/漂移)。
  const usable = new Set<string>();
  const needBackfill: string[] = [];
  for (const tid of tapeIds) {
    const h = headers.get(tid);
    if (h && (h.state === "complete" || h.state === "truncated") && h.tape_sha256 === shaByTape.get(tid)) {
      usable.add(tid);
    } else {
      needBackfill.push(tid);
    }
  }

  // 惰性回填:存量卷按 total_bytes 小卷优先,单次读 ≤OC_BACKFILL_BYTES;超预算的留待下次读。
  if (needBackfill.length > 0) {
    const sizes = await readCollapseMeta(pool, sessionId, userId, needBackfill);
    const anchorById = new Map(tapeAnchors.map((a) => [a._turnTapeId as string, a]));
    const sorted = [...needBackfill].sort(
      (x, y) => (sizes.get(x)?.totalBytes ?? 0) - (sizes.get(y)?.totalBytes ?? 0),
    );
    let budget = backfillBudgetBytes();
    for (const tid of sorted) {
      if (budget <= 0) break;
      const sha = shaByTape.get(tid);
      const billingAnchorId = String(anchorById.get(tid)?.id ?? "");
      if (!sha || !billingAnchorId) continue;
      try {
        const r = await backfillTapeSegment(pool, sessionId, userId, tid, sha, billingAnchorId, budget);
        budget -= r.bytesRead;
        if (r.state === "complete" || r.state === "truncated") usable.add(tid);
      } catch {
        // 回填失败只影响本次性能:留作折叠,下次读继续。绝不抛(否则整会话读挂)。
      }
    }
  }

  // chat 单响应投影预算(≤8MB/≤2000 行):从最新卷起累计,超限的最老卷折叠。
  const usableTotal = new Map<string, ProjectionHeader>();
  for (const tid of usable) {
    const h = headers.get(tid);
    // 回填新写的卷 header 不在首阶段 map 里,补读一次(仍非 BYTEA)。
    usableTotal.set(tid, h ?? { state: "complete", tape_sha256: shaByTape.get(tid) ?? "", total_bytes: 0, row_count: 0, terminalRow: null });
  }
  const missingHeader = [...usable].filter((tid) => !headers.has(tid));
  if (missingHeader.length > 0) {
    const fresh = await readProjectionHeaders(pool, sessionId, userId, missingHeader);
    for (const [tid, h] of fresh) usableTotal.set(tid, h);
  }
  const expand = new Set<string>();
  let budgetBytes = 0;
  let budgetRows = 0;
  // messages 按时间升序;从尾(最新)向头累计。
  const seenTape = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const tid = typeof m._turnTapeId === "string" ? m._turnTapeId : null;
    if (!tid || !usable.has(tid) || seenTape.has(tid)) continue;
    seenTape.add(tid);
    const h = usableTotal.get(tid)!;
    if (budgetBytes + h.total_bytes <= CHAT_PROJECTION_MAX_BYTES && budgetRows + h.row_count <= CHAT_PROJECTION_MAX_ROWS) {
      expand.add(tid);
      budgetBytes += h.total_bytes;
      budgetRows += h.row_count;
    }
  }

  // 折叠集 = 所有非展开的 tape(待回填未收敛 + 超预算)。批量读折叠元数据 + 展开集 cost 叠加 + 投影 rows。
  // M-§9-3:展开集 rows 一次 tape_id=ANY 批量取回,消 N+1。
  const collapseTapes = tapeIds.filter((tid) => !expand.has(tid));
  const [collapseMeta, costEnrich, projectionRowsByTape] = await Promise.all([
    readCollapseMeta(pool, sessionId, userId, collapseTapes),
    readTapeCostEnrichment(pool, sessionId, userId, [...expand]),
    readProjectionRowsBatch(pool, sessionId, userId, [...expand]),
  ]);

  const assembled = messages.flatMap((anchor) => {
    const tid = typeof anchor._turnTapeId === "string" ? anchor._turnTapeId : null;
    if (!tid || typeof anchor._turnTapeSha256 !== "string") return [anchor];
    if (expand.has(tid)) {
      const stored = projectionRowsByTape.get(tid);
      // 展开集但 rows 读空(极端并发被清)→ 降级折叠,绝不回退全量水合。
      if (!stored) return [collapsedAnchorRow(anchor, collapseMeta.get(tid))];
      return applyProjectionForChat(
        stored, anchor, costEnrich.get(tid), usableTotal.get(tid)?.state === "truncated",
      );
    }
    return [collapsedAnchorRow(anchor, collapseMeta.get(tid))];
  });

  return projectClientSessionMessagesForChat(assembled);
}

// ── 引擎上下文读(RFC §9)──────────────────────────────────────────────────────
// loadMasterSessionMessages 切到这里:按 _orderSeq 合并 client_sessions.messages 的 canonical
// user 行 与 投影表的 assistant 生成行,合并后做与 sanitizer 同构的 48 行/18k 截断。产物与今日
// sanitizer 等价(不丢用户问题),但绝不为此全量水合 192MB(引擎历史本就截到 48 行)。
// 无投影卷同惰性回填预算;折叠/省略行绝不进产物。exact/durable/admin 面不受影响。

/** 与 bridge extractMasterHistoryText 同构:text || content(string)|| content 数组拼接。 */
function extractHistoryText(msg: MessageLike): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (part && typeof part === "object") {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 与 _sanitizeMasterHistoricalMessagesForFrame 同构的窗口选取(48 行/18k 字符),但**保留整行字段**
 *  (_clientMessageId/status/_errorCode 供 dedup + 再 sanitize 双用)。上限常数单一权威在
 *  masterHistoryLimits。 */
function selectMasterHistoryWindow(msgs: MessageLike[]): MessageLike[] {
  const rows = msgs.filter((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return false;
    if (m.system === true) return false;
    return extractHistoryText(m).trim() !== "";
  });
  let selected = rows.slice(-MASTER_HISTORY_MAX_MESSAGES);
  while (selected.length > 0) {
    const chars = selected.reduce((sum, m) => sum + extractHistoryText(m).length, 0);
    if (chars <= MASTER_HISTORY_MAX_CHARS) break;
    selected = selected.slice(1);
  }
  return selected;
}

/** 读一组卷已收敛投影里的 user/assistant 生成行(engine-context 只要这两类,tool/thinking/runtime 不进
 *  模型上下文)。header-only 判定 state,rows 仅取可展开卷。 */
async function readGenerationProjectionRows(
  q: Queryable,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, MessageLike[]>> {
  if (tapeIds.length === 0) return new Map();
  const res = await q.query<{ tape_id: string; rows: MessageLike[]; terminal_row: MessageLike | null }>(
    `SELECT tape_id, rows, terminal_row FROM tape_chat_projection
      WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[])
        AND state IN ('complete','truncated')`,
    [sessionId, userId, tapeIds],
  );
  const out = new Map<string, MessageLike[]>();
  for (const r of res.rows) {
    if (!Array.isArray(r.rows)) continue;
    const gen = r.rows.filter((m) => m && (m.role === "assistant" || m.role === "user"));
    // B-§9-3 兜底:assistant 完成行被行预算尾截掉时,用 header terminal_row 补一条(保 dedup/完成证据)。
    const term = r.terminal_row;
    if (term && typeof term === "object" && term.role === "assistant") {
      const alreadyIn = term.id !== undefined && gen.some((m) => m.id === term.id);
      const hasEvidence = gen.some(
        (m) => m.role === "assistant" && (typeof m._clientMessageId === "string" || m._turnTapeComplete === true),
      );
      if (!alreadyIn && !hasEvidence) gen.push(term);
    }
    out.set(r.tape_id, gen);
  }
  return out;
}

/** engine-context 主实现。返回 MessageLike[](与今日 loadMasterSessionMessages 返回兼容:
 *  MessageLike[] | null)。 */
async function computeEngineContextMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
): Promise<MessageLike[] | null> {
  const row = (
    await pool.query<{ messages: string; archived_through_seq: number | null }>(
      "SELECT messages, archived_through_seq FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, userId],
    )
  ).rows[0];
  if (!row) return null;
  let hot: MessageLike[];
  try {
    const parsed = JSON.parse(row.messages);
    hot = Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
  } catch {
    hot = [];
  }
  hot = deriveOrderSeqsForRead(hot, bigIntNumOr(row.archived_through_seq, 0));

  const anchors = hot.filter(
    (m) => m && typeof m._turnTapeId === "string" && typeof m._turnTapeSha256 === "string",
  );
  const tapeIds = [...new Set(anchors.map((m) => m._turnTapeId as string))];
  const shaByTape = new Map<string, string>();
  for (const a of anchors) {
    const tid = a._turnTapeId as string;
    if (!shaByTape.has(tid)) shaByTape.set(tid, a._turnTapeSha256 as string);
  }

  // 可用投影 vs 待回填(与 chat 读同一惰性回填预算机制)。
  const headers = await readProjectionHeaders(pool, sessionId, userId, tapeIds);
  const needBackfill: string[] = [];
  for (const tid of tapeIds) {
    const h = headers.get(tid);
    if (!(h && (h.state === "complete" || h.state === "truncated") && h.tape_sha256 === shaByTape.get(tid))) {
      needBackfill.push(tid);
    }
  }
  if (needBackfill.length > 0) {
    const sizes = await readCollapseMeta(pool, sessionId, userId, needBackfill);
    const anchorById = new Map(anchors.map((a) => [a._turnTapeId as string, a]));
    const sorted = [...needBackfill].sort(
      (x, y) => (sizes.get(x)?.totalBytes ?? 0) - (sizes.get(y)?.totalBytes ?? 0),
    );
    let budget = backfillBudgetBytes();
    for (const tid of sorted) {
      if (budget <= 0) break;
      const sha = shaByTape.get(tid);
      const billingAnchorId = String(anchorById.get(tid)?.id ?? "");
      if (!sha || !billingAnchorId) continue;
      try {
        const r = await backfillTapeSegment(pool, sessionId, userId, tid, sha, billingAnchorId, budget);
        budget -= r.bytesRead;
      } catch {
        /* 回填失败 → 该卷生成行本次省略(折叠),不阻断上下文注入 */
      }
    }
  }

  const generationRows = await readGenerationProjectionRows(pool, sessionId, userId, tapeIds);
  const merged: MessageLike[] = [];
  for (const m of hot) {
    const tid = typeof m._turnTapeId === "string" ? m._turnTapeId : null;
    if (tid && typeof m._turnTapeSha256 === "string") {
      // tape 锚点:热行本体是无正文的 assistant 空壳,用投影的生成行替代(现盖 _seq/_orderSeq)。
      const rows = generationRows.get(tid);
      if (!rows) continue; // 无投影/未收敛 → 生成行省略(折叠),user 问题仍在热行中。
      for (const g of rows) {
        const out: MessageLike = { ...g };
        if (typeof m._orderSeq === "number") out._orderSeq = m._orderSeq;
        if (typeof m._seq === "number") out._seq = m._seq;
        merged.push(out);
      }
      continue;
    }
    merged.push(m);
  }
  merged.sort(compareMessagesByOrder);
  return selectMasterHistoryWindow(merged);
}

/** 展开端点后端(RFC §9):按行游标分页某卷已收敛投影(complete/truncated);chat-safe 形态。 */
async function listTapeChatProjectionRecordsImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  cursor: number,
  limit: number,
): Promise<{ records: MessageLike[]; nextCursor: number | null; total: number } | null> {
  // 分租 + tape 复合校验:会话不属本人 / tape 无收敛投影 → null(端点统一 404)。
  const res = await pool.query<{ rows: MessageLike[]; row_count: number }>(
    `SELECT rows, row_count FROM tape_chat_projection
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND state IN ('complete','truncated')`,
    [sessionId, userId, tapeId],
  );
  const row = res.rows[0];
  if (!row || !Array.isArray(row.rows)) return null;
  const all = row.rows;
  const total = all.length;
  const start = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) && limit > 0 ? limit : 200)));
  const page: MessageLike[] = [];
  let bytes = 0;
  let next = start;
  for (let i = start; i < all.length && page.length < cappedLimit; i++) {
    const stored = all[i]!;
    // M-§9-1(M6① R3):截断记录**保留 `_recordOrdinal`**(前端 ToolCard 按 `_recordOrdinal` 触发"查看
    // 完整"分块拉取)。与 chat 读投影行(applyProjectionForChat)同名 —— 展开端点与 chat 读走同一字段,
    // 前端 socket.applyExpandedTapeRecords 透传 + ToolCard 读 `_recordOrdinal` 零改动即通。剥内部记账字段;
    // 非截断行同 chat 读剥掉 `_recordOrdinal` 减噪。
    const rec: MessageLike = { ...stored };
    delete rec._winnerOrdinal;
    if (rec._truncated !== true) delete rec._recordOrdinal;
    const recBytes = jsonBytes(rec);
    // 单页序列化 ≤1MB(page 非空时命中即停,下页续)。
    if (page.length > 0 && bytes + recBytes > 1024 * 1024) break;
    page.push(rec);
    bytes += recBytes;
    next = i + 1;
  }
  return { records: page, nextCursor: next < total ? next : null, total };
}

/** M-§9-1 按记录有界读:从 client_session_turn_tape_records 读单条 record 的**内容文本**一个字节窗口
 *  (SQL substring,绝不整卷/整条拉入进程),供前端"查看完整"分块拼接。返回 chat-safe 文本切片:
 *  从 record payload(JSON MessageLike)hydrate 后的展示文本(output/bashTail/text),按 utf8 安全边界切。
 *  offset/limit 均按 hydrate 后文本的字节计。分租/不存在/非收敛卷 → null(端点统一 404)。
 *  单请求 ≤256KB。R4-M1 双护栏:
 *  ①单记录解析上限(OC_TAPE_RECORD_PARSE_CAP 默认 8MB):octet_length 预检超限 → 404,payload
 *    压根不 SELECT(RFC §9「单记录解析上限」;前端按既有 partial 语义提示"内容过大");
 *  ②进程内派生文本 LRU(4 槽,键含 sha):一次 hydrate 服务整个分块序列 —— 无缓存时 16 块曾重复
 *    拉取/解析 16 次同一 payload。缓存值是**派生展示文本**(非 exact 原始字节),进程重启即失,无一致性负担。 */
const TAPE_RECORD_CHUNK_MAX_BYTES = 256 * 1024;
function tapeRecordParseCapBytes(): number {
  const raw = Number(process.env.OC_TAPE_RECORD_PARSE_CAP ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8 * 1024 * 1024;
}
const tapeRecordTextLru = new Map<string, Buffer>();
const TAPE_RECORD_TEXT_LRU_SLOTS = 4;
async function readTapeRecordChunkImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  recordOrdinal: number,
  offset: number,
): Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null> {
  if (!Number.isInteger(recordOrdinal) || recordOrdinal < 0) return null;
  // 分租 + 收敛投影存在性(与列表端点同口径);不存在 → 404。
  const proj = await pool.query<{ tape_sha256: string }>(
    `SELECT tape_sha256 FROM tape_chat_projection
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND state IN ('complete','truncated')`,
    [sessionId, userId, tapeId],
  );
  if (proj.rows.length === 0) return null;
  const lruKey = `${sessionId}\0${userId}\0${tapeId}\0${recordOrdinal}\0${proj.rows[0]!.tape_sha256}`;
  let buf = tapeRecordTextLru.get(lruKey);
  if (buf !== undefined) {
    // LRU touch:删了重插保新鲜度。
    tapeRecordTextLru.delete(lruKey);
    tapeRecordTextLru.set(lruKey, buf);
  } else {
    // ①解析上限预检:只查 octet_length,不拉 payload。超限 = 该记录不支持完整查看(404,
    // 前端保留截断预览并按 partial 语义提示),绝不整读进进程。
    const head = (await pool.query<{ role: string; content_sha256: string; bytes: string }>(
      `SELECT role, content_sha256, octet_length(payload)::text AS bytes
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
      [sessionId, userId, tapeId, recordOrdinal],
    )).rows[0];
    if (!head) return null;
    if (Number(head.bytes) > tapeRecordParseCapBytes()) return null;
    const rec = (await pool.query<{ payload: Buffer }>(
      `SELECT payload FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
      [sessionId, userId, tapeId, recordOrdinal],
    )).rows[0];
    if (!rec) return null;
    // hydrate 该 record 得展示文本(与投影同构;绝不吐 exact 原始 payload 字节)。
    let text = "";
    try {
      const content = hydrateTapeRecordContent(
        {
          tape_id: tapeId, tape_sha256: proj.rows[0]!.tape_sha256, waive_reason: null, waiver_applied: false,
          msg_id: "", ordinal: recordOrdinal, role: head.role, content_sha256: head.content_sha256,
          payload: Buffer.from(rec.payload), cost_credits: "0", delegate_costs: [],
        },
        { id: "", _turnTapeSha256: proj.rows[0]!.tape_sha256 }, false, true,
      );
      text = typeof content.output === "string" && content.output.length > 0
        ? content.output
        : typeof content.bashTail === "string" && content.bashTail.length > 0
          ? content.bashTail
          : typeof content.text === "string" ? content.text : "";
    } catch {
      return null; // 坏 record → 404(不吐半损内容)
    }
    buf = Buffer.from(text, "utf8");
    tapeRecordTextLru.set(lruKey, buf);
    while (tapeRecordTextLru.size > TAPE_RECORD_TEXT_LRU_SLOTS) {
      const oldest = tapeRecordTextLru.keys().next().value;
      if (oldest === undefined) break;
      tapeRecordTextLru.delete(oldest);
    }
  }
  const totalBytes = buf.length;
  let start = Number.isFinite(offset) && offset > 0 ? Math.min(Math.floor(offset), totalBytes) : 0;
  // utf8 安全(双端):start 落在 continuation 字节中间时前移到字符边界(nextOffset 恒为合法边界,
  // 此处防御任意客户端 offset);end 同理不切半字符。
  while (start > 0 && start < totalBytes && (buf[start]! & 0xc0) === 0x80) start--;
  let end = Math.min(start + TAPE_RECORD_CHUNK_MAX_BYTES, totalBytes);
  while (end > start && end < totalBytes && (buf[end]! & 0xc0) === 0x80) end--;
  const chunk = buf.subarray(start, end).toString("utf8");
  return { chunk, nextOffset: end < totalBytes ? end : null, totalBytes };
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
  // chat 读走物化投影两阶段(RFC §9):header-only → 投影展开 + 惰性回填,绝不触 tape BYTEA
  // (存量卷回填除外)。exact(durable/admin 面)保持全量水合语义不变,一字不动。
  if (!exact) {
    return await hydrateChatFromProjection(pool, sessionId, userId, messages);
  }
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
      `SELECT r.tape_id, t.tape_sha256, t.waive_reason,
              EXISTS (
                SELECT 1 FROM turn_waivers w
                 WHERE ('c:' || w.user_id::text)=t.user_id
                   AND w.turn_key=t.turn_key AND w.status='applied'
              ) AS waiver_applied,
              r.msg_id, r.ordinal,
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
          `SELECT r.tape_id, t.tape_sha256, t.waive_reason,
                  EXISTS (
                    SELECT 1 FROM turn_waivers w
                     WHERE ('c:' || w.user_id::text)=t.user_id
                       AND w.turn_key=t.turn_key AND w.status='applied'
                  ) AS waiver_applied,
                  r.msg_id, r.ordinal,
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
             SELECT r.*, t.tape_sha256, t.waive_reason,
                    t.created_at AS tape_created_at
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
           SELECT tape_id, tape_sha256, waive_reason, false AS waiver_applied,
                  msg_id, ordinal, role,
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
 * 构造 master 会话权威的 PG backend。返回对象结构化满足 `ClientSessionsBackend`(28 方法),
 * 由 registerCommercial 注入。方法内闭包持有 pool。
 */
export function createPgSessionsBackend(
  pool: Pool,
  options: PgSessionsBackendOptions,
): PgSessionsBackend {
  const expectedGeneration = options.expectedGeneration;

  const backend: PgSessionsBackend = {
    async admitUserTurn(input: AdmitUserTurnInput): Promise<AdmitUserTurnResult> {
      return withTx(pool, async (client): Promise<AdmitUserTurnResult> => {
        // 0) 幂等建行:用户首条消息本身就是「会话存在」的权威。前端 ensureServerSession 的
        //    PUT 是 fire-and-forget、与 WS 首帧天然竞态(legacy persist 路径靠 [0,50,150]ms
        //    重试吸收;受理路径「受理先于一切」撞库更早,不建行则新会话首条消息必
        //    session_not_found)。ON CONFLICT DO NOTHING:已存在的行(含他人所有/墓碑)分毫
        //    不动 —— 归属与墓碑仍由下方 append 的 (id,user_id)/deleted_at 核对裁定,
        //    session_not_found / session_deleted 语义不变,不会跨用户建行或复活墓碑。
        //    后到的 ensure PUT(baseSyncedAt=0)命中本行 → rejected_stale 空操作,不 clobber。
        await client.query(
          `INSERT INTO client_sessions (id, user_id, agent_id, title, created_at, last_at, updated_at)
           VALUES ($1, $2, $3, DEFAULT, ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL})
           ON CONFLICT (id) DO NOTHING`,
          [input.sessionId, input.sessionUserId, input.agentId],
        );
        // 1) 幂等 append user 行(既有 id 幂等)。
        const appended = await pgAppendServerAuthoredCore(
          client,
          input.sessionId,
          input.sessionUserId,
          input.message,
        );
        if (!appended.applied) {
          if (appended.reason === "session_not_found") return { kind: "session_not_found" };
          if (appended.reason === "session_deleted") return { kind: "session_deleted" };
          // already_exists = 幂等重发,继续 admit(dispatch 通常已存在→dedup/failed);
          // malformed/oversized = 拒轮。
          if (appended.reason !== "already_exists") {
            return { kind: "append_error", reason: appended.reason ?? "unknown" };
          }
        }
        // 2) anchor_seq = 该 user 行的 _seq(projection 排序键;不在热尾巴时 null)。
        const anchorSeq = typeof appended.seq === "number" ? BigInt(appended.seq) : null;
        // 3) UPSERT dispatch + 冲突表裁定(同一 tx,受理即拥有 I1)。
        return admitDispatch(client, {
          dispatchId: input.dispatchId,
          userId: input.uid,
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          agentId: input.agentId,
          model: input.model,
          requestHash: input.requestHash,
          billingRequestId: input.billingRequestId,
          ownerId: input.ownerId,
          anchorSeq,
          ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
          ...(input.now !== undefined ? { now: input.now } : {}),
        });
      });
    },

    async getTurnTapeStateByDispatch(
      userId: string,
      dispatchId: string,
      attemptNo: number,
    ): Promise<TurnTapeStateResult> {
      const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
      if (!uidMatch) return { state: "none", status: null, dispatchLeaseActive: false };
      const dispatchUserId = uidMatch[1]!;
      const res = await pool.query<{
        tape_found: boolean;
        finalized_at: string | null;
        tape_status: string | null;
        dispatch_lease_active: boolean;
      }>(
        `SELECT
           (tape.tape_id IS NOT NULL) AS tape_found,
           tape.finalized_at,
           tape.status AS tape_status,
           COALESCE(
             dispatch.status IN ('admitted','accepted')
               AND dispatch.lease_until > statement_timestamp(),
             FALSE
           ) AS dispatch_lease_active
         FROM (VALUES (1)) AS singleton(n)
         LEFT JOIN LATERAL (
           SELECT tape_id, finalized_at, status
             FROM client_session_turn_tapes
            WHERE user_id = $1 AND dispatch_id = $3 AND attempt_no = $4
            ORDER BY (finalized_at IS NOT NULL) DESC
            LIMIT 1
         ) AS tape ON TRUE
         LEFT JOIN LATERAL (
           SELECT status, lease_until
             FROM turn_dispatches
            WHERE user_id = $2 AND dispatch_id = $3 AND attempt_no = $4
            LIMIT 1
         ) AS dispatch ON TRUE`,
        [userId, dispatchUserId, dispatchId, attemptNo],
      );
      // singleton guarantees one row. Tape and lease evidence come from this
      // one PostgreSQL statement snapshot: a separate read could observe
      // none, race with finalize, then observe an expired lease and synthesize
      // a false SERVICE_RESTART tape.
      const row = res.rows[0]!;
      const dispatchLeaseActive = row.dispatch_lease_active === true;
      if (!row.tape_found) {
        return { state: "none", status: null, dispatchLeaseActive };
      }
      return {
        state: row.finalized_at !== null ? "finalized" : "partial",
        status: row.tape_status ?? null,
        dispatchLeaseActive,
      };
    },

    async listDispatchErrorProjectionMessages(
      userId: string,
      sessionId: string,
    ): Promise<Record<string, unknown>[]> {
      // 投影 user_id 是 numeric uid(非 `c:<uid>`);非商业会话直接空。
      if (!/^c:[1-9][0-9]*$/.test(userId)) return [];
      const rows = await readActiveErrorProjections(pool, BigInt(userId.slice(2)), sessionId);
      return rows.map(projectionToVirtualMessage);
    },

    async stageLosslessTurnTapePart(
      userId: string,
      request: LosslessTurnTapePartRequest,
      payload: Buffer,
      dispatchIdentity?: { dispatchId: string; attemptNo: number },
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
            waive_reason: string | null;
            finalized_at: string | null;
            dispatch_id: string | null;
            attempt_no: number | null;
          }>(
            `SELECT agent_id, turn_index, status, turn_key, tape_sha256,
                    total_bytes, part_count, created_at, waive_reason, finalized_at,
                    dispatch_id, attempt_no
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
            bigIntNum(existingTape.created_at, "turn_tape.created_at") === request.createdAt &&
            existingTape.waive_reason === (request.waiveReason ?? null) &&
            // M2:同 tapeId 必须同 dispatch —— 不同 dispatch/attempt(异次执行)复用同 tapeId
            // 不是幂等 replay,是同键异身份冲突,必须拒(否则 A 的 tape 被 B 的 header 冒充成"已存")。
            existingTape.dispatch_id === (dispatchIdentity?.dispatchId ?? null) &&
            existingTape.attempt_no === (dispatchIdentity?.attemptNo ?? null);
          if (!same) throw new Error("lossless turn tape immutable header conflict");
          // Finalization already materialized sanitized records and billing.
          // A rolling old writer may retry raw parts after we privacy-purged
          // them; acknowledge the immutable header without re-storing bytes.
          if (existingTape.finalized_at !== null) return { applied: "idempotent" };
        } else {
          await client.query(
            `INSERT INTO client_session_turn_tapes
               (session_id, user_id, tape_id, agent_id, turn_index, status,
                turn_key, tape_sha256, total_bytes, part_count, created_at, waive_reason,
                dispatch_id, attempt_no)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
              request.waiveReason ?? null,
              dispatchIdentity?.dispatchId ?? null,
              dispatchIdentity?.attemptNo ?? null,
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
      // Personal/test namespaces also use this backend in some deployments,
      // but only `c:<uid>` sessions participate in commercial settlement.
      const billingUserId = /^c:[1-9][0-9]*$/.test(userId)
        ? numericCommercialUserId(userId)
        : null;
      if (request.waiveReason !== undefined && billingUserId === null) {
        throw new Error("turn waiver requires a commercial c:<uid> session owner");
      }
      const result = await withTx(pool, async (client): Promise<LosslessTurnTapeFinalizeResult> => {
        // Serializes "cost parks while tape finalizes" on the logical turn.
        await requestAdvisoryXactLock(client, userId, `turn:${request.turnKey}`);
        // Shared with rolling lease renewal and every settlement/refund path:
        // once a terminal anchor commits, no renewal can race past its check.
        if (billingUserId !== null) {
          await lockTurnBillingKeys(client, billingUserId, [request.turnKey]);
        }
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
            waive_reason: string | null;
            finalized_at: string | null;
            engine_billings: unknown;
            dispatch_id: string | null;
            attempt_no: number | null;
          }>(
            `SELECT agent_id, turn_index, status, turn_key, tape_sha256,
                    total_bytes, part_count, created_at, waive_reason, finalized_at, engine_billings,
                    dispatch_id, attempt_no
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
          bigIntNum(tape.created_at, "turn_tape.created_at") === request.createdAt &&
          tape.waive_reason === (request.waiveReason ?? null);
        if (!sameHeader) throw new Error("lossless turn tape finalize header conflict");
        if (tape.finalized_at !== null) {
          // Rolling-upgrade/ACK-loss replay: the terminal anchor may already
          // exist, but the exact-turn waiver fence still must be present
          // before the master can ACK this finalizer.
          if (request.waiveReason !== undefined) {
            await ensurePendingTurnWaiverInTransaction(client, {
              userId: billingUserId!,
              turnKey: request.turnKey,
              reason: request.waiveReason,
            });
          }
          const count = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM client_session_turn_tape_records
              WHERE session_id = $1 AND user_id = $2 AND tape_id = $3`,
            [request.sessionId, userId, request.tapeId],
          );
          if (!Array.isArray(tape.engine_billings)) {
            throw new Error("lossless turn tape finalized engine billings malformed");
          }
          // 幂等 replay 分支同样收敛 dispatch(不依赖 parts):首轮 finalize 若已收敛,CAS no-op。
          let replayLate = false;
          if (tape.dispatch_id !== null) {
            const convergence = await convergeDispatchOnFinalize(client, tape.dispatch_id, tape.status);
            replayLate = convergence.lateTape;
            if (convergence.projectionRevoked) {
              // finalize 已在事务起点持有 session 行锁；在这里传播 projection absence，
              // 不让 reconciler 形成 dispatch→session、与本路径 session→dispatch 的反序。
              await client.query(
                `UPDATE client_sessions
                    SET history_revision=history_revision + 1,
                        updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
                  WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
                [request.sessionId, userId],
              );
            }
          }
          return {
            applied: "idempotent",
            recordCount: Number(count.rows[0]?.count ?? 0),
            engineBillings: structuredClone(tape.engine_billings) as DurableCodexBilling[],
            ...(replayLate ? { dispatchLateTape: true } : {}),
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
          turn.payload.turnKey !== request.turnKey ||
          turn.payload.waiveReason !== request.waiveReason
        ) {
          throw new Error("lossless turn tape envelope/payload identity mismatch");
        }
        // The marker and terminal materialization commit (or roll back)
        // together. Settlement uses the same advisory key, so after this
        // transaction becomes visible it cannot create a new debit.
        if (request.waiveReason !== undefined) {
          await ensurePendingTurnWaiverInTransaction(client, {
            userId: billingUserId!,
            turnKey: request.turnKey,
            reason: request.waiveReason,
          });
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
        const preUpgradeMessages = existingMessages;
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
               next_seq=$4, archived_through_seq=$5, archived_count=$6,
               history_revision=history_revision + $9
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
              hasInvisibleMessageRemoval(preUpgradeMessages, plan.tail) || archivedDelta > 0 ? 1 : 0,
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
        // 会话读物化投影(RFC §9):同事务从已 materialize 的 records 构建该卷 chat 内容投影,
        // state=complete/truncated。只读缓存派生面,绝不参与本 tape 的完整性/结算/dedup 写侧。
        await writeTapeChatProjectionOnFinalize(
          client,
          request.sessionId,
          userId,
          request.tapeId,
          request.tapeSha256,
          turn.billingAnchorId,
          turn.records.map((item, ordinal) => ({
            msg_id: item.id,
            ordinal,
            role: item.role,
            content_sha256: item.payloadSha256,
            payload: item.payloadBytes,
          })),
        );
        // dispatch 收敛(RFC §2.4):tape header 带 dispatch_id → 非终态转 terminal(映射 status),
        // 或迟到 tape 撤 projection + manual_reconcile。与内容 materialize 同一 tx,原子。
        let dispatchLate = false;
        if (tape.dispatch_id !== null) {
          const convergence = await convergeDispatchOnFinalize(client, tape.dispatch_id, tape.status);
          dispatchLate = convergence.lateTape;
          if (convergence.projectionRevoked) {
            // 仅 absence 需要 revision；projection insert 每次 partial 都会全量并入。
            // 当前事务已持 session 锁，因此不会引入 reconciler 的锁序反转。
            await client.query(
              `UPDATE client_sessions
                  SET history_revision=history_revision + 1,
                      updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
                WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
              [request.sessionId, userId],
            );
          }
        }
        return {
          applied: "finalized",
          recordCount: turn.records.length,
          engineBillings: turn.engineBillings.map((billing) => structuredClone(billing)),
          ...(dispatchLate ? { dispatchLateTape: true } : {}),
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
              history_revision: string;
            }>(
              "SELECT messages, updated_at, next_seq, archived_through_seq, archived_count, history_revision FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
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
          const historyRevisionDelta = existing && (
            hasInvisibleHistoryMutation(oldMsgs, finalMessages, tail) || archivedDelta > 0
          ) ? 1 : 0;

          const res = await client.query(
            `INSERT INTO client_sessions
               (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq, archived_through_seq, archived_count, model_id, history_revision)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, GREATEST($10, ${CLOCK_MS_SQL}), $11, $12, $13, $15, 0)
             ON CONFLICT (id) DO UPDATE SET
               agent_id = EXCLUDED.agent_id,
               title = EXCLUDED.title,
               pinned = EXCLUDED.pinned,
               last_at = EXCLUDED.last_at,
               messages = EXCLUDED.messages,
               message_count = EXCLUDED.message_count,
               -- model_id:PUT 未携带(NULL)= 保留既有(元数据权威写路径是 setClientSessionModel,
               -- 全量 PUT 不得清空);携带则以 PUT 为准(建行场景)。
               model_id = COALESCE(EXCLUDED.model_id, client_sessions.model_id),
               -- updated_at 逻辑版本(RFC D3b):冲突更新走 DB 计算 GREATEST。**首建(BLOCKER-1)**:
               -- 新插入(无冲突)的 updated_at 也取 GREATEST(客户端 $10, 服务端时钟下限 clock_ms)——
               -- 不再无条件信任客户端 $10(客户端可回传 0 / 旧值,首建后紧跟 baseSyncedAt=0 的第二个
               -- PUT 会因 existing.updated_at 仍是 0 而击穿 stale 检测,造成双写静默覆盖)。
               -- EXCLUDED.updated_at 即上面 VALUES 的 GREATEST 结果,故冲突路径口径不变。
               updated_at = GREATEST(client_sessions.updated_at + 1, ${CLOCK_MS_SQL}, EXCLUDED.updated_at),
               next_seq = EXCLUDED.next_seq,
               archived_through_seq = EXCLUDED.archived_through_seq,
               archived_count = EXCLUDED.archived_count,
               history_revision = client_sessions.history_revision + $16
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
              session.modelId ?? null,
              historyRevisionDelta,
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
                     next_seq=$4,archived_through_seq=$5,archived_count=$6,
                     history_revision=history_revision + $9
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
                    archivedDelta > 0 ? 1 : 0,
                  ],
                );
              } else {
                // The anchor may already be archived. The immutable component
                // is still authoritative and archive hydration will expose it;
                // bump the session version so full-sync clients revalidate.
                await client.query(
                  `UPDATE client_sessions
                      SET updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                          history_revision=history_revision + 1
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
              const historyRevisionDelta = archivedDelta > 0 ? 1 : 0;
              await client.query(
                `UPDATE client_sessions
                   SET messages = $1, message_count = $2, last_at = $3,
                       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                       next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5,
                       history_revision = history_revision + $8
                 WHERE id = $6 AND user_id = $7`,
                [plan.finalJson, plan.tail.length + newArchivedCount, nowMs, plan.archivedThroughSeq, newArchivedCount, mapRow.session_id, userId, historyRevisionDelta],
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
        const historyRevisionDelta = archivedDelta > 0 ? 1 : 0;
        await client.query(
          `UPDATE client_sessions
             SET messages = $1, message_count = $2, last_at = $3,
                 updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                 next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5,
                 history_revision = history_revision + $8
           WHERE id = $6 AND user_id = $7`,
          [plan.finalJson, plan.tail.length + newArchivedCount, nowMs, plan.archivedThroughSeq, newArchivedCount, clientSessionId, userId, historyRevisionDelta],
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
          model_id: string | null;
        }>(
          `SELECT id, agent_id, title, pinned, created_at, last_at, updated_at, message_count AS msg_count, model_id
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
        ...(r.model_id ? { modelId: r.model_id } : {}),
      }));
    },

    async getClientSession(
      id: string,
      userId?: string,
      options: ClientSessionReadOptions = {},
    ): Promise<ClientSession | null> {
      const sql = userId
        ? "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count, history_revision, model_id FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL"
        : "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count, history_revision, model_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL";
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
          history_revision: string;
          model_id: string | null;
        }>(sql, userId ? [id, userId] : [id])
      ).rows[0];
      if (!row) return null;
      const archivedThroughOrderSeq = bigIntNumOr(row.archived_through_seq, 0);
      const parsedMessages = deriveOrderSeqsForRead(
        JSON.parse(row.messages) as MessageLike[],
        archivedThroughOrderSeq,
      );
      let messages = await hydrateTurnTapeMessages(pool, row.id, row.user_id, parsedMessages, options);
      if (options.projection === "chat") {
        messages = await mergeDispatchErrorProjectionRows(pool, row.user_id, row.id, messages);
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
        historyRevision: bigIntNum(row.history_revision, "history_revision"),
        ...(row.model_id ? { modelId: row.model_id } : {}),
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
          history_revision: string;
          model_id: string | null;
        }>(
          "SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count, history_revision, model_id FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
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
      const historyRevision = bigIntNum(row.history_revision, "history_revision");
      const historyRevisionMatches =
        Number.isSafeInteger(options.sinceHistoryRevision) &&
        options.sinceHistoryRevision === historyRevision;
      let messages: MessageLike[];
      let isPartial: boolean;
      if (!anyMissingSeq && sinceIsValid && historyRevisionMatches) {
        messages = allMsgs.filter((m) => typeof m?._seq === "number" && (m._seq as number) > sinceSeq);
        isPartial = true;
      } else {
        messages = allMsgs;
        isPartial = false;
      }
      messages = await hydrateTurnTapeMessages(pool, row.id, row.user_id, messages, options);
      if (options.projection === "chat") {
        // partial 也全量并入 active 投影(无自有 seq,不受 since 游标裁剪;前端按 id 幂等
        // 去重,量级 = 未决失败数,恒小)。
        messages = await mergeDispatchErrorProjectionRows(pool, row.user_id, row.id, messages);
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
        historyRevision,
        ...(row.model_id ? { modelId: row.model_id } : {}),
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
        await pool.query<{ archived_through_seq: number | null; history_revision: string }>(
          "SELECT archived_through_seq, history_revision FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [sessId, userId],
        )
      ).rows[0];
      if (!row) return { messages: [], hasMore: false, oldestSeq: null };
      const watermark = bigIntNumOr(row.archived_through_seq, 0);
      const historyRevision = bigIntNum(row.history_revision, "history_revision");
      const effectiveBefore = Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : watermark + 1;
      if (effectiveBefore <= 1) {
        return { messages: [], hasMore: false, oldestSeq: null, historyRevision };
      }

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
      let hydrated = await hydrateTurnTapeMessages(pool, sessId, userId, page, options);
      if (options.projection === "chat" && page.length > 0 && oldestSeq !== null) {
        // 只并入锚落在本页 seq 范围内的投影(锚在热尾/更早页的绝不重复出现)。
        hydrated = await mergeDispatchErrorProjectionRows(pool, userId, sessId, hydrated, {
          minInclusive: oldestSeq,
          maxExclusive: effectiveBefore,
        });
      }
      return { messages: hydrated, hasMore, oldestSeq, historyRevision };
    },

    // ── 引擎上下文读(RFC §9)──────────────────────────────────────────────────
    // loadMasterSessionMessages 切到这里:投影 assistant 生成行 + 热行 canonical user 行合并,
    // 48 行/18k 截断。绝不全量水合 tape BYTEA(引擎历史本就有界)。
    async getEngineContextMessages(
      sessionId: string,
      userId: string,
    ): Promise<MessageLike[] | null> {
      return computeEngineContextMessages(pool, sessionId, userId);
    },

    // ── 超大内容查看端点后端(RFC §9)──────────────────────────────────────────
    // 分租((session_id,user_id,tape_id) 复合)+ 行游标分页;chat-safe 投影形态,绝不吐 exact payload。
    async listTapeChatProjectionRecords(
      sessionId: string,
      userId: string,
      tapeId: string,
      cursor: number,
      limit: number,
    ): Promise<{ records: MessageLike[]; nextCursor: number | null; total: number } | null> {
      return listTapeChatProjectionRecordsImpl(pool, sessionId, userId, tapeId, cursor, limit);
    },

    // M-§9-1 "查看完整"按记录有界读(≤256KB/请求,绝不整卷)。gateway 路由层加 per-user 令牌桶限频 + 429。
    async readTapeRecordChunk(
      sessionId: string,
      userId: string,
      tapeId: string,
      recordOrdinal: number,
      offset: number,
    ): Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null> {
      return readTapeRecordChunkImpl(pool, sessionId, userId, tapeId, recordOrdinal, offset);
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
        // 投影是纯 UI 面,随会话删;turn_dispatches 是财务/审计证据,有意保留。
        await client.query("DELETE FROM turn_dispatch_error_projections WHERE session_id = $1", [id]);
        // chat 物化投影(RFC §9)是只读缓存派生面,随会话删(权威 tape records 由上面级联清)。
        await client.query("DELETE FROM tape_chat_projection WHERE session_id = $1", [id]);
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

    async setClientSessionModel(id: string, userId: string, modelId: string): Promise<{ ok: boolean; updatedAt: number }> {
      const now = Date.now();
      // 与 renameClientSession 同构:metadata-only 单列 UPDATE,updated_at 逻辑版本单调推进
      // (其它设备 listSessions server-wins 拿到新选择)。值为 UI 恢复提示,校验在 gateway 边界。
      const row = (
        await pool.query<{ updated_at: string }>(
          `UPDATE client_sessions SET model_id = $1, updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
             WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING updated_at`,
          [modelId, id, userId],
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
