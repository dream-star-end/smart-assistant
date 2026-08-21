// pgSessionsBackend — master 会话权威六表的 **PostgreSQL 实现**(RFC-v5-sessions-pg,P2)。
//
// 为什么在 commercial 而不在 storage:pg 依赖已在 commercial(storage 侧只用最小结构类型
// 描述连接、零新增依赖,见 RFC D1)。master 形态(channel=v5,非容器)由 registerCommercial
// 在 composition root 一次性 `setClientSessionsBackend(createPgSessionsBackend(pool))` 注入;
// 容器内 gateway / 个人版不加载 commercial → 天然 SQLite,行为零变化。
//
// 本文件是 SQLite backend(packages/storage/src/sessionsDb.ts 的 sqliteBackend)的**行为等价
// PG 实现**。契约 `ClientSessionsBackend = typeof sqliteBackend` 在类型层强制全部方法覆盖
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
import { createHash, randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  LOSSLESS_TURN_TAPE_PART_BYTES,
  LOSSLESS_TURN_TAPE_SHA256_RE,
  MODEL_HISTORY_EXACT_SUFFIX_MARKER,
  assessTurnRecoveryTape,
  modelHistoryReservedTokens,
  estimateModelHistoryTokens,
  estimateModelHistoryUtf8Bytes,
  exactModelHistoryTextSuffix,
  isClientMessageId,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  sanitizePersistedModelHistoryText,
  maxAutomaticTurnRetryAttempt,
  normalizeTurnErrorCode,
  resolveModelHistoryContextWindow,
  supportsAutomaticTurnRecovery,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
  parseSessionWorkspaceMode,
  losslessBillingAnchorId,
  type DurableCodexBilling,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapePartRequest,
  type LosslessTurnTapeVisibleRequest,
  type SessionWorkspaceMode,
} from "@openclaude/protocol";
import {
  enqueueMaterializationJob,
  enqueueSettlementJob,
  holdSettlementJobsForTape,
  releaseSettlementJobsAfterVerify,
} from "./turnTapeJobs.js";
import {
  assertSettlementMatchesCanonical,
  classifyUnifiedTimelineIntegrityError,
  isTransientTapeError,
  phaseAVisibleHeadText,
  pickTapeDisplayFallbackText,
  recordsPublished,
  sanitizeValueForPgJsonb,
  settlementAuthorityHash,
  settlementEngineBillings,
  settlementPayloadEqual,
  visibleHeadFallback,
  visibleHeadFromSettlement,
  warnTapeDisplayDegrade,
  type TapeDisplayDegradeReason,
  type VisibleHead,
} from "./visibleFinalize.js";
import {
  type AppendCostCreditsResult,
  type AppendForRequestResult,
  type ChatProject,
  type ChatProjectCreateResult,
  type ChatProjectDeleteResult,
  type ChatProjectUpdateResult,
  type ProjectAsset,
  type ProjectAssetCreateInput,
  type ProjectAssetCreateResult,
  type ProjectAssetDeleteResult,
  type ProjectAssetUpdateInput,
  type ProjectAssetUpdateResult,
  type ListProjectAssetsOpts,
  type ParsedProjectAssetCreate,
  type ClientSession,
  type ClientSessionLifecycle,
  type ClientSessionLifecycleRef,
  type BatchClientSessionsInput,
  type BatchClientSessionsResult,
  type MarkClientSessionReadResult,
  type ClientSessionMeta,
  type ClientSessionMetaPatch,
  type ListClientSessionsOpts,
  type ListClientSessionsResult,
  type SearchClientSessionsOpts,
  type SearchClientSessionsResult,
  type ClientSessionPartial,
  type ClientSessionReadOptions,
  type ClientTimelineCursor,
  type ClientTimelinePage,
  ClientTimelineCursorStaleError,
  type ClientSessionsBackend,
  type DelegatePendingRow,
  CHAT_PROJECT_COLOR_MAX,
  CHAT_PROJECT_INSTRUCTIONS_MAX,
  CHAT_PROJECT_PER_USER_LIMIT,
  PROJECT_ASSET_LIST_LIMIT_DEFAULT,
  PROJECT_ASSET_LIST_LIMIT_MAX,
  PROJECT_ASSET_PER_PROJECT_LIMIT,
  PROJECT_ASSET_PINNED_INJECT_MAX,
  compareMessagesByOrder,
  deriveArchivedOrderSeqsForRead,
  deriveOrderSeqsForRead,
  type DrainDelegateCostResult,
  type EngineContextReadOptions,
  MAX_SESSION_BYTES,
  hasInvisibleHistoryMutation,
  hasInvisibleMessageRemoval,
  mapClientSessionLastOutcome,
  type MessageLike,
  mergePreservingServerAuthored,
  normalizeAndAssignOrderSeqs,
  normalizeAndAssignSeqs,
  _warnSeqAnomaly,
  buildSearchSnippet,
  escapeLikePattern,
  parseChatProjectName,
  parseChatProjectOptionalText,
  parseChatProjectSortOrder,
  parseProjectAssetCreateInput,
  parseProjectAssetName,
  parseProjectAssetProjectId,
  parseSessionBatchInput,
  type PatchClientSessionMetaResult,
  rankSessionSearchHits,
  sanitizeProjectInstructions,
  LAST_MESSAGE_PREVIEW_TAIL_MAX,
  CLIENT_SESSION_UNREAD_OUTCOMES,
  lastReadAtWatermarkMsSql,
  SESSION_BATCH_IDS_MAX,
  SESSION_LIST_LIMIT_MAX,
  SESSION_SEARCH_JSON_CANDIDATE_MAX,
  SESSION_SEARCH_JSON_EXPAND_MAX_BYTES,
  SESSION_SEARCH_LIMIT_DEFAULT,
  SESSION_SEARCH_LIMIT_MAX,
  toLastMessagePreview,
  planAppendServerAuthored,
  planAppendServerAuthoredBatch,
  planCostPatch,
  planDelegateCostMerge,
  planSpillOverflow,
  type ReadArchivedMessagesResult,
  selectEngineContextSuffix,
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
  isLosslessRuntimeBatchingEnabled,
  materializeLosslessTurn,
  type LosslessTurnRecord,
  type LosslessTurnPayload,
} from "../http/losslessTurnTape.js";
import { bumpGoalUsageSnapshotForTape } from "../goal/goalStateService.js";
import { ensurePendingTurnWaiverInTransaction } from "../billing/refund.js";
import {
  lockTurnBillingKeys,
  lockTurnPersistenceKeys,
  numericCommercialUserId,
} from "../billing/turnLock.js";
import {
  admitDispatch,
  type AdmitDispatchResult,
  casToManualReconcile,
  casToTerminal,
  getDispatch,
} from "../dispatch/turnDispatchStore.js";
import {
  bindRecoveryJobDispatch,
  enqueueAutomaticRecoveryJob,
  lockRecoveryRoot,
  settleRecoveryJobForTape,
} from "../dispatch/turnRecoveryStore.js";
import { settleStopControlsForTurn } from "../dispatch/turnControlStore.js";
import {
  readClientSessionLiveFrames as readDurableClientSessionLiveFrames,
  readClientSessionLiveUnits as readDurableClientSessionLiveUnits,
  readLiveOrTapeFramePayload as readDurableLiveOrTapeFramePayload,
  reconcileLiveStreamWithFinalTape,
  convergeFinalizedTapeLiveStreams,
} from "./liveTurnFrames.js";

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

/** One immutable browser page must observe the session row, archive chunks,
 * tape identity and dispatch-status overlay from the same snapshot. */
async function withTimelineSnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroyed = true;
      try {
        client.release(
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        );
      } catch {
        /* connection is already gone */
      }
    }
    throw error;
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
const UNREAD_OUTCOME_SQL = CLIENT_SESSION_UNREAD_OUTCOMES.map((o) => `'${o}'`).join(",");
// terminal_at 是 timestamptz → epoch milliseconds。last_read_at 写入同样是 epoch ms
//（CLOCK_MS_SQL）。混入 unix seconds 的行由 lastReadAtWatermarkMsSql 放大 1000。
const LAST_D_TERMINAL_MS_SQL = "(floor(EXTRACT(EPOCH FROM last_d.terminal_at)*1000))::BIGINT";
const LAST_READ_AT_MS_SQL = lastReadAtWatermarkMsSql("cs.last_read_at");

function dispatchUidForList(userId: string): string {
  return /^c:([1-9][0-9]*)$/.exec(userId)?.[1] ?? "-1";
}

async function pgUnreadBySessionIds(
  pool: Pool,
  userId: string,
  ids: string[],
): Promise<Map<string, boolean>> {
  const unread = new Map<string, boolean>();
  if (ids.length === 0) return unread;
  const rows = (
    await pool.query<{ id: string; unread: boolean }>(
      `SELECT cs.id,
              (last_d.outcome IN (${UNREAD_OUTCOME_SQL})
               AND ${LAST_D_TERMINAL_MS_SQL} > ${LAST_READ_AT_MS_SQL}) AS unread
         FROM client_sessions cs
         LEFT JOIN (
           SELECT session_id, outcome, terminal_at FROM (
             SELECT session_id, outcome, terminal_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_id
                      ORDER BY terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC
                    ) AS rn
               FROM turn_dispatches
              WHERE user_id = $2 AND status = 'terminal'
           ) ranked
           WHERE rn = 1
         ) last_d ON last_d.session_id = cs.id
        WHERE cs.user_id = $1 AND cs.deleted_at IS NULL AND cs.id = ANY($3::text[])`,
      [userId, dispatchUidForList(userId), ids],
    )
  ).rows;
  for (const r of rows) unread.set(r.id, r.unread === true);
  return unread;
}

const PG_CHAT_PROJECT_SELECT = `
  SELECT p.id, p.name, p.instructions, p.color, p.sort_order, p.created_at, p.updated_at,
         COALESCE(c.cnt, 0)::text AS session_count
    FROM chat_projects p
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS cnt
        FROM client_sessions
       WHERE user_id = $1 AND deleted_at IS NULL AND project_id IS NOT NULL
       GROUP BY project_id
    ) c ON c.project_id = p.id
`;

type PgChatProjectRow = {
  id: string;
  name: string;
  instructions: string | null;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  session_count: string;
};

function mapPgChatProjectRow(r: PgChatProjectRow): ChatProject {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    color: r.color,
    sortOrder: r.sort_order,
    createdAt: bigIntNum(r.created_at, "created_at"),
    updatedAt: bigIntNum(r.updated_at, "updated_at"),
    sessionCount: Number(r.session_count) || 0,
  };
}

async function readPgChatProject(
  queryable: Pick<Pool | PoolClient, "query">,
  userId: string,
  id: string,
): Promise<ChatProject | null> {
  const row = (
    await queryable.query<PgChatProjectRow>(
      `${PG_CHAT_PROJECT_SELECT} WHERE p.id = $2 AND p.user_id = $3 AND p.deleted_at IS NULL`,
      [userId, id, userId],
    )
  ).rows[0];
  return row ? mapPgChatProjectRow(row) : null;
}

const PG_PROJECT_ASSET_SELECT = `
  SELECT id, project_id, source, session_id, name, url, container_path, mime,
         size_bytes::text AS size_bytes, digest, excerpt, pinned,
         created_at::text AS created_at, updated_at::text AS updated_at
    FROM project_assets
`;

type PgProjectAssetRow = {
  id: string;
  project_id: string | null;
  source: string;
  session_id: string | null;
  name: string;
  url: string | null;
  container_path: string | null;
  mime: string | null;
  size_bytes: string | null;
  digest: string | null;
  excerpt: string | null;
  pinned: boolean | number | string;
  created_at: string;
  updated_at: string;
};

function mapPgProjectAssetRow(r: PgProjectAssetRow): ProjectAsset {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    source: r.source === "output" ? "output" : "upload",
    sessionId: r.session_id ?? null,
    name: r.name,
    url: r.url ?? null,
    containerPath: r.container_path ?? null,
    mime: r.mime ?? null,
    sizeBytes: r.size_bytes == null ? null : bigIntNum(r.size_bytes, "size_bytes"),
    digest: r.digest ?? null,
    excerpt: r.excerpt ?? null,
    pinned: r.pinned === true || r.pinned === 1 || r.pinned === "t",
    createdAt: bigIntNum(r.created_at, "created_at"),
    updatedAt: bigIntNum(r.updated_at, "updated_at"),
  };
}

async function readPgProjectAsset(
  queryable: Pick<Pool | PoolClient, "query">,
  userId: string,
  id: string,
): Promise<ProjectAsset | null> {
  const row = (
    await queryable.query<PgProjectAssetRow>(
      `${PG_PROJECT_ASSET_SELECT} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    )
  ).rows[0];
  return row ? mapPgProjectAssetRow(row) : null;
}

async function pgOwnedChatProjectExists(
  queryable: Pick<Pool | PoolClient, "query">,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const row = (
    await queryable.query(
      "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [projectId, userId],
    )
  ).rows[0];
  return !!row;
}

async function pgCountProjectAssets(
  queryable: Pick<Pool | PoolClient, "query">,
  userId: string,
  projectId: string | null,
): Promise<number> {
  const row = (
    await queryable.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM project_assets
        WHERE user_id = $1 AND deleted_at IS NULL AND project_id IS NOT DISTINCT FROM $2`,
      [userId, projectId],
    )
  ).rows[0];
  return Number(row?.n ?? 0);
}

async function pgFindDuplicateAsset(
  queryable: Pick<Pool | PoolClient, "query">,
  userId: string,
  projectId: string | null,
  source: ParsedProjectAssetCreate["source"],
  digest: string | null,
  containerPath: string | null,
): Promise<ProjectAsset | null> {
  if (digest) {
    const row = (
      await queryable.query<PgProjectAssetRow>(
        `${PG_PROJECT_ASSET_SELECT}
          WHERE user_id = $1 AND deleted_at IS NULL AND source = $2
            AND project_id IS NOT DISTINCT FROM $3 AND digest = $4
          LIMIT 1`,
        [userId, source, projectId, digest],
      )
    ).rows[0];
    return row ? mapPgProjectAssetRow(row) : null;
  }
  if (containerPath) {
    const row = (
      await queryable.query<PgProjectAssetRow>(
        `${PG_PROJECT_ASSET_SELECT}
          WHERE user_id = $1 AND deleted_at IS NULL AND source = $2
            AND project_id IS NOT DISTINCT FROM $3 AND container_path = $4
          LIMIT 1`,
        [userId, source, projectId, containerPath],
      )
    ).rows[0];
    return row ? mapPgProjectAssetRow(row) : null;
  }
  return null;
}

async function pgResolveAssetProjectId(
  queryable: Pick<Pool | PoolClient, "query">,
  userId: string,
  parsed: ParsedProjectAssetCreate,
): Promise<{ ok: true; projectId: string | null } | { ok: false; error: "project_not_found" }> {
  let projectId = parsed.projectIdPresent ? parsed.projectId : null;
  if (!parsed.projectIdPresent && parsed.sessionId) {
    const sess = (
      await queryable.query<{ user_id: string; project_id: string | null }>(
        "SELECT user_id, project_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL",
        [parsed.sessionId],
      )
    ).rows[0];
    if (sess?.user_id === userId) projectId = sess.project_id ?? null;
  }
  if (projectId !== null && !(await pgOwnedChatProjectExists(queryable, userId, projectId))) {
    return { ok: false, error: "project_not_found" };
  }
  return { ok: true, projectId };
}

/** Publish a new browser-timeline identity on the caller's existing
 * transaction. Dispatch reconciliation uses this seam so its verified status
 * bit and the cursor invalidation commit atomically without moving sessions
 * table SQL outside the backend boundary. */
export async function advanceClientTimelineIdentityInTransaction(
  q: Pick<Pool | PoolClient, "query">,
  sessionId: string,
  userId: string,
): Promise<void> {
  await q.query(
    `UPDATE client_sessions
        SET history_revision = history_revision + 1,
            timeline_generation = timeline_generation + 1,
            updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [sessionId, userId],
  );
}

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
  workspace_mode: string;
}

const USER_MESSAGE_INLINE_BYTES = 256 * 1024;

/** PostgreSQL TEXT cannot store U+0000. Exact user-visible bytes remain in the
 * authoritative BYTEA payloads; only model-continuity sidecars use this
 * reversible visible escape. */
function pgModelSidecarText(text: string): string {
  return text.replaceAll("\u0000", "\\u0000");
}

function deferredUserReplayMetadata(message: MessageLike): MessageLike {
  const rawRouting = message._routing && typeof message._routing === "object" &&
    !Array.isArray(message._routing)
    ? message._routing as { model?: unknown; teamMode?: unknown; effortLevel?: unknown }
    : undefined;
  const routing = rawRouting
    ? {
        ...(typeof rawRouting.model === "string" ? { model: rawRouting.model } : {}),
        ...(typeof rawRouting.teamMode === "boolean" ? { teamMode: rawRouting.teamMode } : {}),
        ...(typeof rawRouting.effortLevel === "string" || rawRouting.effortLevel === null
          ? { effortLevel: rawRouting.effortLevel }
          : {}),
      }
    : undefined;
  const media = Array.isArray(message._media) ? message._media : undefined;
  const retryMedia = Array.isArray(message._retryMedia) ? message._retryMedia : undefined;
  const hadAttachments = (media?.length ?? 0) > 0 || (retryMedia?.length ?? 0) > 0;
  const retrySource = retryMedia ?? media;
  const retryEligible = !!routing && (!hadAttachments || (
    !!retrySource && retrySource.length > 0 && retrySource.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const ref = item as { url?: unknown; base64?: unknown };
      return (typeof ref.url === "string" && ref.url.length > 0) ||
        (typeof ref.base64 === "string" && ref.base64.length > 0);
    })
  ));
  return {
    ...(routing ? { _routing: routing } : {}),
    ...(typeof message._sendAttempt === "number" && Number.isSafeInteger(message._sendAttempt) &&
      message._sendAttempt >= 0
      ? { _sendAttempt: message._sendAttempt }
      : {}),
    ...(typeof message._isAutoRetry === "boolean" ? { _isAutoRetry: message._isAutoRetry } : {}),
    ...(typeof message._idem === "string" && message._idem.length <= 256
      ? { _idem: message._idem }
      : {}),
    _deferredRetryEligible: retryEligible,
  };
}

async function deferOversizedUserMessage(
  client: PoolClient,
  sessionId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<(MessageLike & { id: string }) | null> {
  if (message.role !== "user" || typeof message.text !== "string") return message;
  const exact = { ...message, _source: "server" };
  const payload = Buffer.from(JSON.stringify(exact), "utf8");
  if (payload.length <= USER_MESSAGE_INLINE_BYTES) return message;
  const modelText = pgModelSidecarText(modelHistorySemanticText(message));
  const contentSha256 = sha256Bytes(payload);
  const inserted = await client.query(
    `INSERT INTO client_session_user_payloads
       (session_id,user_id,msg_id,payload,text_payload,content_sha256,payload_bytes,
        model_token_estimate,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (session_id,user_id,msg_id) DO NOTHING
     RETURNING msg_id`,
    [
      sessionId,
      userId,
      message.id,
      payload,
      modelText,
      contentSha256,
      payload.length,
      estimateModelHistoryTokens(modelText),
      typeof message.ts === "number" && Number.isFinite(message.ts) ? message.ts : Date.now(),
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    const existing = (
      await client.query<{ content_sha256: string; payload_bytes: string }>(
        `SELECT content_sha256,payload_bytes::text AS payload_bytes
           FROM client_session_user_payloads
          WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
        [sessionId, userId, message.id],
      )
    ).rows[0];
    if (
      !existing ||
      existing.content_sha256 !== contentSha256 ||
      bigIntNum(existing.payload_bytes, "user payload bytes") !== payload.length
    ) return null;
  }
  return {
    id: message.id,
    role: "user",
    text: "",
    ts: typeof message.ts === "number" && Number.isFinite(message.ts) ? message.ts : Date.now(),
    _source: "server",
    _payloadDeferred: true,
    _userPayloadDeferred: true,
    _userPayloadId: message.id,
    _payloadBytes: payload.length,
    _payloadSha256: contentSha256,
    ...deferredUserReplayMetadata(message),
  };
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

type PgAppendCoreResult = ServerAuthoredAppendResult & {
  seq?: number;
  workspaceMode?: SessionWorkspaceMode;
};

function stripWorkspaceMode(
  result: PgAppendCoreResult,
): ServerAuthoredAppendResult & { seq?: number } {
  const { workspaceMode: _workspaceMode, ...publicResult } = result;
  return publicResult;
}

async function pgAppendServerAuthoredCore(
  client: PoolClient,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<PgAppendCoreResult> {
  const row = (
    await client.query<SessionWriteRow>(
      "SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count, workspace_mode FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [sessId, userId],
    )
  ).rows[0];
  if (!row) return { applied: false, reason: "session_not_found" };
  if (row.deleted_at !== null) return { applied: false, reason: "session_deleted" };
  const workspaceMode = parseSessionWorkspaceMode(row.workspace_mode);
  if (workspaceMode === null) {
    throw new Error(`client_sessions.workspace_mode invalid for ${sessId}`);
  }

  // 幂等升级(热尾巴+归档):id 已归档视为 already_exists(防 sink 重放把归档搬回尾巴)。
  const archivedHit = await client.query(
    "SELECT 1 FROM client_session_archived_ids WHERE session_id = $1 AND msg_id = $2",
    [sessId, message.id],
  );
  if ((archivedHit.rowCount ?? 0) > 0) {
    return { applied: false, reason: "already_exists", workspaceMode };
  }

  let msgs: MessageLike[];
  try {
    const parsed = JSON.parse(row.messages);
    if (!Array.isArray(parsed)) return { applied: false, reason: "malformed" };
    msgs = parsed as MessageLike[];
  } catch {
    return { applied: false, reason: "malformed" };
  }

  const hotExisting = msgs.some((item) => item && item.id === message.id);
  const plannedMessage = hotExisting
    ? message
    : await deferOversizedUserMessage(client, sessId, userId, message);
  if (plannedMessage === null) return { applied: false, reason: "malformed" };

  const currentNextSeq = typeof row.next_seq === "number" && row.next_seq > 0 ? row.next_seq : 1;
  const plan = planAppendServerAuthored(msgs, plannedMessage, currentNextSeq, bigIntNumOr(row.archived_through_seq, 0));
  if (plan.kind === "already_exists") {
    // 幂等重发:该消息行已在热尾巴,回其现有 _seq 供 admit 复用 anchor(dispatch 通常也已存在)。
    return {
      applied: false,
      reason: "already_exists",
      seq: seqOfMessage(msgs, message.id),
      workspaceMode,
    };
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
  // 新 append 的消息拿到的 _seq = admit 的 anchor_seq(user 行顺序键)。
  return { applied: true, seq: seqOfMessage(tail, message.id), workspaceMode };
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
  return stripWorkspaceMode(await pgAppendServerAuthoredCore(client, sessionId, userId, message));
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
  ["client_sessions", "archived_at", "bigint"],
  ["client_sessions", "last_read_at", "bigint"],
  ["client_sessions", "history_revision", "bigint"],
  ["client_sessions", "timeline_generation", "bigint"],
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
  ["client_session_turn_tapes", "client_message_id", "text"],
  ["client_session_turn_tapes", "continuation_of_turn_key", "text"],
  ["client_session_turn_tapes", "physical_record_count", "integer"],
  ["client_session_turn_tapes", "logical_record_count", "integer"],
  ["client_session_turn_tapes", "record_payload_bytes", "bigint"],
  ["client_session_turn_tapes", "model_record_count", "integer"],
  ["client_session_turn_tapes", "visible_at", "bigint"],
  ["client_session_turn_tapes", "visible_head", "jsonb"],
  ["client_session_turn_tapes", "materialization_status", "text"],
  ["client_session_turn_tapes", "settlement_hash", "text"],
  ["turn_dispatches", "visible_head", "jsonb"],
  ["turn_dispatches", "visible_at", "bigint"],
  ["turn_dispatches", "producer_fenced_at", "timestamp with time zone"],
  ["turn_dispatches", "shutdown_ctx", "jsonb"],
  ["turn_tape_materialization_jobs", "job_id", "uuid"],
  ["turn_tape_settlement_jobs", "job_id", "uuid"],
  ["client_session_turn_tape_parts", "payload", "bytea"],
  ["client_session_turn_tape_records", "payload", "bytea"],
  ["client_session_turn_tape_records", "visible_payload", "bytea"],
  ["client_session_turn_tape_records", "visible_content_sha256", "text"],
  ["client_session_turn_tape_records", "model_sidecar_complete", "boolean"],
  ["client_session_turn_tape_model_records", "semantic_text", "text"],
  ["client_session_turn_tape_model_records", "token_estimate", "integer"],
  ["client_session_user_payloads", "model_token_estimate", "integer"],
  ["server_authored_turn_anchor_map", "turn_key", "text"],
  ["turn_tape_cost_components", "request_id", "text"],
  ["turn_tape_recovery_links", "source_tape_id", "text"],
  ["turn_tape_recovery_links", "recovery_tape_id", "text"],
  ["turn_tape_recovery_links", "source_turn_key", "text"],
  ["turn_tape_recovery_links", "recovery_turn_key", "text"],
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
  /** Runs only after the owning tape/cost transaction commits. Callback
   * failures must never turn a committed billing write into retry. */
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
       * late true tape(RFC §2.4):reconciler 已宣告 not_accepted 并显示状态,tape 却迟到。
       * 内容仍完整 materialize(钱安全 I5),但 dispatch 转 manual_reconcile、旧状态自然消失 —— 调用层
       * (internalServer finalize handler)据此发一条告警交人工核对(已告知用户失败却又产出计费内容)。
       */
      dispatchLateTape?: boolean;
      settlementHandoff?: boolean;
      settlementHeld?: boolean;
      /** True only for the transaction that first published visible_at. */
      newlyVisible?: boolean;
      /** Exact browser turn identity; present for durable webchat dispatches. */
      clientMessageId?: string;
    }
  | { applied: "session_not_found" | "session_deleted" | "incomplete" };

export function _createFinalizeSingleflight<T>(): (
  key: string,
  run: () => Promise<T>,
) => { promise: Promise<T>; shared: boolean } {
  const inFlight = new Map<string, Promise<T>>();
  return (key, run) => {
    const existing = inFlight.get(key);
    if (existing) return { promise: existing, shared: true };
    const promise = Promise.resolve().then(run);
    inFlight.set(key, promise);
    const cleanup = () => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    void promise.then(cleanup, cleanup);
    return { promise, shared: false };
  };
}

/** Fixed-field JSON avoids delimiter collisions and makes every immutable
 * header field part of the coalescing identity. A conflicting reuse of the
 * same tapeId therefore still reaches PostgreSQL and keeps its 409 semantics. */
export function _losslessFinalizeSingleflightKey(
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
): string {
  return JSON.stringify([
    userId,
    request.sessionId,
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
    request.dispatchId ?? null,
    request.attemptNo ?? null,
    request.settlement
      ? settlementAuthorityHash({
          billingAnchorId: request.settlement.billingAnchorId,
          requestId: request.settlement.requestId,
          engineBillings: request.settlement.engineBillings,
        })
      : null,
  ]);
}

/**
 * finalize 收敛 dispatch(RFC §2.4)。仅当 tape header 带 dispatch_id 时调用(legacy tape 跳过)。
 *   - 非终态(admitted/accepted/rejecting)→ CAS terminal,outcome 映射 tape.status;
 *   - terminal(executed_error/RESULT_RECOVERY_PENDING)→ 以迟到的真实 tape 精确终态收敛;
 *   - 已 terminal(not_accepted)= late tape → manual_reconcile(late_tape);直接状态读随之消失;
 *   - 已 terminal(completed 等)/ manual_reconcile → 幂等 no-op。
 * CAS-first(原子);仅失败后读一次判 late tape(此时行已终态,读值稳定)。
 */
function errorCodeFromVisibleHead(head: unknown): string | null {
  if (!head || typeof head !== "object") return null;
  const code = (head as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function failureCodeForTapeOutcome(
  tapeStatus: string,
  errorCode?: string | null,
): string | null {
  const outcome =
    tapeStatus === "completed" ? "completed" :
    tapeStatus === "interrupted" ? "interrupted" : "crashed";
  if (outcome === "completed") return null;
  if (typeof errorCode === "string" && errorCode.length > 0) return errorCode;
  return outcome;
}

async function convergeDispatchOnFinalize(
  client: PoolClient,
  dispatchId: string,
  tapeStatus: string,
  failureCode?: string | null,
): Promise<{ lateTape: boolean; removedVisibleStatus: boolean }> {
  const outcome =
    tapeStatus === "completed" ? "completed" :
    tapeStatus === "interrupted" ? "interrupted" : "crashed";
  const nextFailureCode = failureCodeForTapeOutcome(tapeStatus, failureCode);
  // Serialize against persistGatewayLiveFrame on the dispatch row (it takes
  // the same FOR UPDATE before deciding projection_source). Without this,
  // a frame write interleaved between our reconcile and its stream INSERT
  // could mint a permanent projection_source='live' orphan that tape_id-less
  // startup convergence can never match.
  await client.query(
    `SELECT 1 FROM turn_dispatches WHERE dispatch_id=$1::uuid FOR UPDATE`,
    [dispatchId],
  );
  const fenced = await client.query<{ producer_fenced_at: Date | null }>(
    `SELECT producer_fenced_at FROM turn_dispatches WHERE dispatch_id=$1::uuid`,
    [dispatchId],
  );
  if (fenced.rows[0]?.producer_fenced_at) {
    await client.query(
      `UPDATE turn_tape_settlement_jobs
          SET status='held', last_error='late_tape_after_fence', updated_at=NOW()
        WHERE dispatch_id=$1::uuid AND status IN ('queued','leased','failed')`,
      [dispatchId],
    );
    const held = await casToManualReconcile(client, {
      dispatchId,
      conflictReason: "late_tape_after_fence",
      fromStatuses: ["admitted", "accepted", "rejecting", "terminal"],
    });
    return { lateTape: held !== null, removedVisibleStatus: false };
  }
  const converged = await casToTerminal(client, {
    dispatchId,
    outcome,
    failureCode: nextFailureCode,
    fromStatuses: ["admitted", "accepted", "rejecting"],
  });
  if (converged !== null) return { lateTape: false, removedVisibleStatus: false };
  const d = await getDispatch(client, dispatchId);
  if (
    d && d.status === "terminal" && d.outcome === "executed_error" &&
    (d.failureCode === "RESULT_RECOVERY_PENDING" || d.failureCode === "SERVICE_RESTART")
  ) {
    // The reconciler's recovery sentinel is explicitly provisional: it says
    // the executor ended before a complete tape was visible. A later verified
    // finalize is the stronger authority. Replace only that exact sentinel;
    // other executed_error outcomes remain immutable and reviewable.
    // completed 才允许清 failure_code;真崩溃必须写下真实码,不许残留 SERVICE_RESTART。
    await client.query(
      `UPDATE turn_dispatches
          SET outcome=$2, failure_code=$3, client_notified=FALSE,
              terminal_at=clock_timestamp()
        WHERE dispatch_id=$1 AND status='terminal'
          AND outcome='executed_error'
          AND failure_code IN ('RESULT_RECOVERY_PENDING','SERVICE_RESTART')`,
      [dispatchId, outcome, nextFailureCode],
    );
    return { lateTape: false, removedVisibleStatus: d.clientNotified };
  }
  if (d && d.status === "terminal" && d.outcome === "not_accepted") {
    const held = await casToManualReconcile(client, {
      dispatchId,
      conflictReason: "late_tape",
      fromStatuses: ["terminal"],
    });
    return {
      lateTape: held !== null,
      removedVisibleStatus: held !== null && d.clientNotified,
    };
  }
  return { lateTape: false, removedVisibleStatus: false };
}

export interface LosslessTurnTapeStorage {
  commitVisibleLosslessTurnTape?(
    userId: string,
    request: LosslessTurnTapeVisibleRequest,
  ): Promise<LosslessTurnTapeFinalizeResult>;
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
    options?: { materialize?: boolean },
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
  /** Master-validated recovery lineage. The PG transaction revalidates it
   * under the same session-row lock used by ordinary user appends. */
  recovery?:
    | {
        sourceClientMessageId: string;
        mode: "checkpoint" | "replay";
        automatic: false;
      }
    | {
        sourceClientMessageId: string;
        mode: "checkpoint" | "replay";
        automatic: true;
        rootClientMessageId: string;
        attempt: number;
        max: typeof AUTOMATIC_TURN_RETRY_MAX;
      };
  /** Master scheduler lease fence. Browser-authored frames never populate
   * this field; admission validates it in the same transaction as the user
   * append and dispatch binding. */
  recoveryJob?: {
    jobId: string;
    leaseOwner: string;
    leaseEpoch: number;
  };
  leaseTtlMs?: number;
  now?: number;
}

export type AdmitUserTurnResult =
  | (AdmitDispatchResult & { workspaceMode: SessionWorkspaceMode })
  | { kind: "session_not_found" }
  | { kind: "session_deleted" }
  | { kind: "recovery_conflict"; reason: string }
  | { kind: "append_error"; reason: string };

class RecoveryJobAdmissionConflict extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RecoveryJobAdmissionConflict";
  }
}

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
  /** Dispatch-level master shutdown evidence; none+true may synthesize even if lease looks live. */
  gatewayShutdownEvidence: boolean;
}

export interface DispatchAdmissionBackend {
  /** 单事务:幂等 append user 行 → 取 _seq → UPSERT dispatch 冲突表裁定(RFC §2.1)。 */
  admitUserTurn(input: AdmitUserTurnInput): Promise<AdmitUserTurnResult>;
  /** Rolling-upgrade compensator: reconstruct finalized recoverable tapes
   * that committed before the scheduler-owning Master published their job. */
  reconcileAutomaticRecoveryJobs(userId: bigint, limit?: number): Promise<number>;
  /** Read the server-persisted cwd policy for lanes whose user row was
   * materialized before this bridge invocation (for example prompt queue). */
  getClientSessionWorkspaceMode(
    sessionId: string,
    sessionUserId: string,
  ): Promise<SessionWorkspaceMode | null>;
  /** 容器 boot recovery 用:按 dispatch 身份查 tape 三态(none/partial/finalized)+ 精确 status。 */
  getTurnTapeStateByDispatch(
    userId: string,
    dispatchId: string,
    attemptNo: number,
  ): Promise<TurnTapeStateResult>;
}

export type PgSessionsBackend = ClientSessionsBackend &
  LosslessTurnTapeStorage &
  DispatchAdmissionBackend;

/**
 * Read verified turn failures directly from the durable dispatch authority.
 *
 * This is deliberately not an assistant-message projection: the returned row
 * is a typed status record whose only source is turn_dispatches after the
 * reconciler has completed the same-transaction no-billing proof. The browser
 * renders it outside the Agent transcript. A late finalized tape moves the
 * dispatch to manual_reconcile, so the status naturally disappears without a
 * second shadow table.
 */
async function mergeVerifiedTurnStatusRows(
  pool: Pool,
  sessionUserId: string,
  sessionId: string,
  messages: MessageLike[],
  anchorRange?: { minInclusive: number; maxExclusive: number },
): Promise<MessageLike[]> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(sessionUserId);
  if (!uidMatch) return messages;
  const rows = (
    await pool.query<{
      dispatch_id: string;
      client_message_id: string;
      failure_code: string | null;
      anchor_seq: string;
      terminal_at: Date | null;
    }>(
      `SELECT dispatch_id, client_message_id, failure_code, anchor_seq::text, terminal_at
         FROM turn_dispatches
        WHERE user_id=$1 AND session_id=$2
          AND status='terminal' AND client_notified=TRUE
          AND outcome IN ('not_accepted','executed_error')
          AND anchor_seq IS NOT NULL
        ORDER BY anchor_seq, dispatch_id`,
      [uidMatch[1], sessionId],
    )
  ).rows;
  if (rows.length === 0) return messages;

  const out = [...messages];
  for (const row of rows) {
    const anchorSeq = bigIntNum(row.anchor_seq, "turn dispatch anchor_seq");
    if (
      anchorRange &&
      (anchorSeq < anchorRange.minInclusive || anchorSeq >= anchorRange.maxExclusive)
    ) continue;
    const id = `turn-status:${row.dispatch_id}`;
    if (out.some((message) => message.id === id)) continue;
    let insertAt = 0;
    let orderSeq: number | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      const seq = out[i]?._seq;
      if (typeof seq === "number" && Number.isFinite(seq) && seq <= anchorSeq) {
        insertAt = i + 1;
        if (seq === anchorSeq && typeof out[i]?._orderSeq === "number") {
          orderSeq = out[i]!._orderSeq;
        }
        break;
      }
    }
    out.splice(insertAt, 0, {
      id,
      role: "system",
      text: "",
      ts: row.terminal_at?.getTime() ?? 0,
      _source: "server",
      _seq: anchorSeq,
      ...(orderSeq !== undefined ? { _orderSeq: orderSeq } : {}),
      _turnStatusRecord: true,
      _dispatchTerminal: true,
      _dispatchLost: true,
      _errorCode: row.failure_code ?? "DISPATCH_LOST",
      _clientMessageId: row.client_message_id,
    });
  }
  return out;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const AUTOMATIC_RECOVERY_CONTINUE_PROMPT =
  "继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续。这是一条断点续接指令，不是重放原始请求：不要重新执行已经完成的步骤，不要重复已经输出的内容。若中断前有外部写操作或部署操作，先查询其当前可观察状态（如 release 指针、进程、日志、健康检查或目标资源）并据此继续。只有在无法通过查询区分成功或失败、且重复执行可能造成不可逆后果时，才明确说明具体无法确认的操作和风险，并仅询问完成任务所必需的决定；不要泛泛要求用户再说“继续”。";

// Kept byte-for-byte aligned with protocol's exported pre-execution policy.
// This commercial copy is intentional during the rolling workspace window:
// production may load the protocol package from the previous runtime image
// while Master has already migrated its recovery rows.
const PRE_EXECUTION_RECOVERY_CODES = new Set([
  "model_authority_unavailable", "model_catalog_unavailable",
  "codex_pool_busy", "codex_route_unavailable", "codex_container_recycled",
]);
function recoveryWithoutCheckpointIsProven(code: string): boolean {
  return PRE_EXECUTION_RECOVERY_CODES.has(normalizeTurnErrorCode(code));
}

/** The last assistant record is the semantic terminal surface. An earlier
 * error followed by a later answer is not a failed turn, while trailing tool
 * or runtime audit rows do not erase a terminal assistant error. */
function terminalTurnRecordErrorCode(records: readonly unknown[]): string {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const message = record as MessageLike;
    if (message.role !== "assistant") continue;
    return typeof message._errorCode === "string"
      ? normalizeTurnErrorCode(message._errorCode)
      : "";
  }
  return "";
}

async function hydrateRecoverySourceUser(
  client: PoolClient,
  sessionId: string,
  userId: string,
  source: MessageLike,
): Promise<MessageLike | null> {
  if (source._userPayloadDeferred !== true) return source;
  if (typeof source.id !== "string") return null;
  const row = (
    await client.query<{ payload: Buffer }>(
      `SELECT payload FROM client_session_user_payloads
        WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
      [sessionId, userId, source.id],
    )
  ).rows[0];
  if (!row) return null;
  try {
    const parsed = JSON.parse(Buffer.from(row.payload).toString("utf8"));
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed.id !== source.id || parsed.role !== "user"
    ) return null;
    return parsed as MessageLike;
  } catch {
    return null;
  }
}

function replayMediaIsDurable(media: unknown[]): boolean {
  return media.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const ref = item as { url?: unknown; base64?: unknown };
    return (typeof ref.url === "string" && ref.url.length > 0) ||
      (typeof ref.base64 === "string" && ref.base64.length > 0);
  });
}

/** Build and enqueue the next semantic recovery from the exact finalized
 * tape while its session/dispatch transaction is still open. This is the
 * primary publication path; the table's lineage UNIQUE key makes finalize
 * ACK-loss replays harmless. */
async function scheduleAutomaticRecoveryForFinalizedTurn(
  client: PoolClient,
  input: {
    uid: bigint;
    sessionUserId: string;
    sessionId: string;
    turn: {
      payload: Pick<
        LosslessTurnPayload,
        | "clientMessageId"
        | "status"
        | "errorCode"
        | "waiveReason"
        | "agentId"
        | "turnKey"
      >;
      records: Array<{ payload: MessageLike }>;
    };
    clientMessageId: string | null;
    tapeSha256: string;
    currentMessages: MessageLike[];
  },
): Promise<void> {
  const clientMessageId = input.clientMessageId;
  if (!clientMessageId || !isClientMessageId(clientMessageId)) return;

  await settleStopControlsForTurn(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    clientMessageId,
  });

  await settleRecoveryJobForTape(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    clientMessageId,
    outcome: input.turn.payload.status,
  });
  const status = input.turn.payload.status;
  const terminalRecordErrorCode = terminalTurnRecordErrorCode(
    input.turn.records.map((record) => record.payload),
  );
  const completedWithRecoverableError = status === "completed" &&
    supportsAutomaticTurnRecovery(terminalRecordErrorCode);
  if (
    status !== "crashed" &&
    status !== "interrupted" &&
    !completedWithRecoverableError
  ) return;
  const errorCode = terminalRecordErrorCode ||
    input.turn.payload.errorCode || input.turn.payload.waiveReason || "";
  if (!supportsAutomaticTurnRecovery(errorCode)) return;

  const latestUser = [...input.currentMessages].reverse()
    .find((message) => message?.role === "user");
  if (!latestUser || latestUser.id !== clientMessageId) return;
  const source = await hydrateRecoverySourceUser(
    client,
    input.sessionId,
    input.sessionUserId,
    latestUser,
  );
  if (!source) return;
  const routing = source._routing;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return;
  const route = routing as Record<string, unknown>;

  const assessment = assessTurnRecoveryTape(
    input.turn.records.map((record) => record.payload),
  );
  // A checkpoint continuation resumes the native session with the exact
  // persisted process; it never replays the original request. Even an
  // uncertain external effect is therefore resumable: the continuation
  // prompt requires observable-state verification before any repeated write.
  // Exact replay remains fail-closed and is never inferred from a completed
  // tape whose header contradicts its terminal error record.
  if (status === "completed" && assessment.mode !== "checkpoint") return;
  if (
    assessment.mode === "checkpoint" &&
    !assessment.checkpointSafe &&
    status !== "completed"
  ) return;
  if (
    assessment.mode === "replay" &&
    (
      !assessment.checkpointSafe ||
      !recoveryWithoutCheckpointIsProven(errorCode)
    )
  ) return;
  const mode = assessment.mode;
  const rootClientMessageId = isClientMessageId(source._automaticRecoveryRootClientMessageId)
    ? source._automaticRecoveryRootClientMessageId
    : source._automaticRecovery === true && isClientMessageId(source._recoveryOfClientMessageId)
      ? source._recoveryOfClientMessageId
      : clientMessageId;
  const sourceAttempt = typeof source._automaticRecoveryAttempt === "number" &&
      Number.isSafeInteger(source._automaticRecoveryAttempt) &&
      source._automaticRecoveryAttempt >= 1
    ? source._automaticRecoveryAttempt
    : source._automaticRecovery === true ? 1 : 0;
  const currentAttempt = Math.max(
    sourceAttempt,
    maxAutomaticTurnRetryAttempt(
      input.turn.records.map((record) => record.payload),
      rootClientMessageId,
    ),
  );
  if (currentAttempt >= AUTOMATIC_TURN_RETRY_MAX) return;
  const semanticRecoveryAttempt = currentAttempt + 1;
  const identity = turnRecoveryAttemptIdentity(
    input.sessionId,
    rootClientMessageId,
    semanticRecoveryAttempt,
  );

  const displayText = mode === "checkpoint" ? "↻ 自动从断点继续" : "↻ 自动重试";
  const exactText = typeof source._modelText === "string"
    ? source._modelText
    : typeof source.text === "string" ? source.text : "";
  const sourceMedia = Array.isArray(source._retryMedia)
    ? source._retryMedia
    : Array.isArray(source._media) ? source._media : undefined;
  if (mode === "replay" && sourceMedia && !replayMediaIsDurable(sourceMedia)) return;
  const replyTo = source._replyTo && typeof source._replyTo === "object" &&
      !Array.isArray(source._replyTo)
    ? source._replyTo as Record<string, unknown>
    : undefined;
  const imageEdit = source._imageEdit && typeof source._imageEdit === "object" &&
      !Array.isArray(source._imageEdit)
    ? source._imageEdit as Record<string, unknown>
    : undefined;
  const content: Record<string, unknown> = {
    text: mode === "checkpoint" ? AUTOMATIC_RECOVERY_CONTINUE_PROMPT : exactText,
    displayText,
    ...(mode === "replay" && sourceMedia ? { media: sourceMedia } : {}),
    ...(mode === "replay" && imageEdit ? { imageEdit } : {}),
    ...(mode === "replay" && replyTo ? { replyTo } : {}),
    recovery: {
      sourceClientMessageId: clientMessageId,
      mode,
      automatic: true,
      rootClientMessageId,
      attempt: semanticRecoveryAttempt,
      max: AUTOMATIC_TURN_RETRY_MAX,
    },
  };
  const request: Record<string, unknown> = {
    type: "inbound.message",
    idempotencyKey: identity.idempotencyKey,
    channel: "webchat",
    peer: { id: input.sessionId, kind: "dm" },
    agentId: input.turn.payload.agentId,
    content,
    ...(mode === "replay" && typeof replyTo?.messageId === "string"
      ? { replyToId: replyTo.messageId }
      : {}),
    ...(typeof route.effortLevel === "string" || route.effortLevel === null
      ? { effortLevel: route.effortLevel }
      : {}),
    ...(typeof route.model === "string" && route.model.length > 0
      ? { model: route.model }
      : {}),
    ...(route.teamMode === true ? { teamMode: true } : {}),
    ts: Date.now(),
    clientMessageId: identity.clientMessageId,
  };
  await enqueueAutomaticRecoveryJob(client, {
    userId: input.uid,
    sessionId: input.sessionId,
    rootClientMessageId,
    sourceClientMessageId: clientMessageId,
    sourceTurnKey: input.turn.payload.turnKey,
    errorCode,
    recoveryMode: mode,
    semanticRecoveryAttempt,
    request,
    tapeSha256: input.tapeSha256,
  });
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
 *  / pending_usage_patches / turn_waivers；读取 immutable records 时现算叠加
 *  (waiver 可 finalize 后才 apply / cost 可晚到 stage,冻结即分裂权威)。 */
type ExactUsageEnrichment = {
  costCredits: string;
  waiverApplied: boolean;
  delegates: Array<{ agentId: string; costCredits: string }>;
};

type RecoverySourceUsage = {
  costCredits: string;
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

async function readRecoverySourceUsage(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  billingAnchorId: string,
): Promise<RecoverySourceUsage> {
  const row = (
    await client.query<{ cost_credits: string; delegates: unknown }>(
      `WITH components AS (
         SELECT cost_credits::numeric AS cost_credits,delegate_agent_id
           FROM turn_tape_cost_components
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND billing_anchor_id=$4
       ), grouped AS (
         SELECT delegate_agent_id,SUM(cost_credits)::text AS cost_credits
           FROM components WHERE delegate_agent_id IS NOT NULL
          GROUP BY delegate_agent_id
       )
       SELECT COALESCE((SELECT SUM(cost_credits)::text FROM components),'0') AS cost_credits,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'agentId',delegate_agent_id,'costCredits',cost_credits)
                                ORDER BY delegate_agent_id) FROM grouped),'[]'::jsonb) AS delegates`,
      [sessionId, userId, tapeId, billingAnchorId],
    )
  ).rows[0];
  return {
    costCredits: row?.cost_credits ?? "0",
    delegates: parseDelegateCosts(row?.delegates),
  };
}

function assertRecoveryUsageFallback(
  usage: Record<string, unknown> | undefined,
  source: RecoverySourceUsage,
): void {
  if (!usage || usage.costCredits !== source.costCredits || !Array.isArray(usage.delegates)) {
    throw new Error("turn tape recovery usage fallback does not match source costs");
  }
  const delegates = parseDelegateCosts(usage.delegates);
  if (
    delegates.length !== usage.delegates.length ||
    JSON.stringify([...delegates].sort((a, b) => a.agentId.localeCompare(b.agentId))) !==
      JSON.stringify(source.delegates)
  ) {
    throw new Error("turn tape recovery delegate fallback does not match source costs");
  }
}

/** 把可变计费叠加并入行 usage。与今日 hydrateTapeRecord 内联合并逐字节等价:key 顺序
 *  = record/anchor(content 已并) → cost → waiver → delegate;全空则原样返回(不凭空造 usage)。 */
function mergeExactUsage(msg: MessageLike, enrich: ExactUsageEnrichment, isBillingAnchor: boolean): MessageLike {
  const exactCostUsage = BigInt(enrich.costCredits) > 0n ? { costCredits: enrich.costCredits } : {};
  // The live cost_waived frame updates the current browser immediately, but
  // history hydration must carry the same truth for refreshes, offline users
  // and other devices. Only an applied waiver (whose CHECK requires a receipt)
  // may mark completion; the tape's pending decision alone is not a refund.
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

/** Timeline rows are rebuilt from immutable tape payloads, while a legacy
 * cost event can arrive after finalize without a turnKey and patch only the
 * small hot anchor. Exact hydration has always merged that anchor usage; the
 * unified/deferred browser paths must use the same base before authoritative
 * cost components override it, otherwise refresh drops a settled cost badge. */
function mergeBillingAnchorUsage(
  msg: MessageLike,
  anchor: MessageLike,
  isBillingAnchor: boolean,
): MessageLike {
  if (!isBillingAnchor || !anchor.usage || typeof anchor.usage !== "object" || Array.isArray(anchor.usage)) {
    return msg;
  }
  const base = msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)
    ? msg.usage as Record<string, unknown>
    : {};
  return { ...msg, usage: { ...base, ...(anchor.usage as Record<string, unknown>) } };
}

/** 内容水合(不含可变计费叠加):hash 校验 + 解析 + _turnTape 作证标记 + 基础 usage
 *  ({...recordUsage,...anchorUsage});随后在其上叠加 cost/waiver/delegate。 */
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
    // Hydration does not create another hot-row authority record. Mark expanded
    // rows so a later browser PUT can discard them and keep the
    // single constant-size tape anchor instead of copying all generated bytes
    // back into client_sessions.messages.
    _turnTapeId: row.tape_id,
    _turnTapeMsgId: row.msg_id,
    _turnTapeOrdinal: row.ordinal,
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

/** exact 读用:内容水合 + 逐行可变计费叠加(cost/waiver/delegate 来自 hydration SQL 的行内子查询)。 */
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
      _turnTapeOrdinal: row.ordinal,
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

// ── Direct immutable-tape reads ─────────────────────────────────────────────
// The database retains the full audit tape. Browser reads preserve every
// semantic record and every future/unknown field by default. The only
// transformation is a narrow denylist for known platform-private collectors
// and runtime credential/config fields. This must never become another
// projection allowlist: new Agent roles, block kinds and payload fields are
// visible automatically.
const TAPE_RECORD_PAGE_MAX_ROWS = 200;
const TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES = 8 * 1024 * 1024;
const TAPE_RECORD_INLINE_QUANTUM_BYTES = 1024 * 1024;
// Tool output is commonly binary-ish/base64-rich and dominates cold-history
// responses even when every individual record is below the general 1 MiB
// threshold. Unified browser history already has an exact Range+SHA viewport
// hydration path, so keep medium tool bodies out of the first response while
// leaving assistant/thinking text on the existing inline contract. This is a
// per-record transport quantum, never a content or total-history cap.
const UNIFIED_TIMELINE_TOOL_INLINE_QUANTUM_BYTES = 128 * 1024;

function deferUnifiedTimelinePayload(role: string, payloadBytes: number): boolean {
  return payloadBytes > (
    role === "tool"
      ? UNIFIED_TIMELINE_TOOL_INLINE_QUANTUM_BYTES
      : TAPE_RECORD_INLINE_QUANTUM_BYTES
  );
}

interface DirectTapeSourceRecord {
  msg_id: string;
  ordinal: number;
  role: string;
  content_sha256: string;
  payload: Buffer;
  visible_payload: Buffer | null;
  visible_content_sha256: string | null;
}

interface DirectTapeVisibleHead {
  tape_id: string;
  msg_id: string;
  ordinal: number;
  role: string;
  ts: string;
  payload_bytes: string;
  visible_content_sha256: string | null;
  billing_anchor_id: string;
  waiver_applied: boolean;
  cost_credits: string;
  delegate_costs: unknown;
}

interface DirectTapeHeader {
  tapeId: string;
  tapeSha256: string;
  billingAnchorId: string;
  totalBytes: number;
  physicalCount: number;
  logicalCount: number;
  status: string;
  turnKey: string;
  clientMessageId: string | null;
  materializationStatus: string | null;
  finalizedAt: string | null;
  visibleAt: string | null;
  visibleHead: VisibleHead | null;
}

const PRIVATE_TAPE_ROOT_FIELDS = new Set([
  "engineBilling",
  "engineBillings",
  "goalUsageRecords",
  "runtimeEvents",
]);

const PRIVATE_NESTED_DELEGATE_FIELDS = new Set([
  "_nestedDelegateRuntimeEvents",
  "_durableDelegateRuntimeEvents",
  "_durableDelegateEngineBillings",
  "_durableDelegateGoalUsageRecords",
]);

const PRIVATE_RUNTIME_FIELD_NAMES = new Set([
  "account",
  "accessToken",
  "apiKeySource",
  "auth",
  "authorization",
  "balance",
  "collaborationMode",
  "config",
  "cookie",
  "cookies",
  "credentials",
  "cwd",
  "developerInstructions",
  "env",
  "headers",
  "idToken",
  "mcpServers",
  "planType",
  "plugins",
  "rateLimits",
  "refreshToken",
  "signature",
  "skills",
  "systemInstructions",
  "systemPrompt",
  "threadSettings",
]);

function normalizedPrivateField(key: string): string {
  return key.replace(/^_+/, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const NORMALIZED_PRIVATE_RUNTIME_FIELDS = new Set(
  [...PRIVATE_RUNTIME_FIELD_NAMES].map(normalizedPrivateField),
);

function sanitizeNestedDelegateValue(value: unknown): { value: unknown; omitted: boolean } {
  if (Array.isArray(value)) {
    let omitted = false;
    const items = value.map((item) => {
      const next = sanitizeNestedDelegateValue(item);
      omitted ||= next.omitted;
      return next.value;
    });
    return { value: items, omitted };
  }
  if (!value || typeof value !== "object") return { value, omitted: false };
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let omitted = false;
  for (const [key, child] of Object.entries(source)) {
    if (PRIVATE_NESTED_DELEGATE_FIELDS.has(key)) {
      omitted = true;
      continue;
    }
    const next = sanitizeNestedDelegateValue(child);
    omitted ||= next.omitted;
    out[key] = next.value;
  }
  return { value: out, omitted };
}

function sanitizeRuntimeValue(value: unknown): { value: unknown; omitted: boolean } {
  if (Array.isArray(value)) {
    let omitted = false;
    const items = value.map((item) => {
      const next = sanitizeRuntimeValue(item);
      omitted ||= next.omitted;
      return next.value;
    });
    return { value: items, omitted };
  }
  if (!value || typeof value !== "object") return { value, omitted: false };
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let omitted = false;
  for (const [key, child] of Object.entries(source)) {
    if (
      PRIVATE_TAPE_ROOT_FIELDS.has(key) ||
      PRIVATE_NESTED_DELEGATE_FIELDS.has(key) ||
      NORMALIZED_PRIVATE_RUNTIME_FIELDS.has(normalizedPrivateField(key))
    ) {
      omitted = true;
      continue;
    }
    const next = sanitizeRuntimeValue(child);
    omitted ||= next.omitted;
    out[key] = next.value;
  }
  return { value: out, omitted };
}

/** Preserve the actual Agent record, including unknown roles/block kinds and
 * future fields. Only known platform-private metadata is removed. */
export function userVisibleTapeRecord(value: MessageLike): MessageLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  let visible: Record<string, unknown> = { ...source };
  let omitted = false;
  for (const key of PRIVATE_TAPE_ROOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(visible, key)) {
      delete visible[key];
      omitted = true;
    }
  }
  if (source.role === "agent-group") {
    // The materialized group keeps both its future/raw fields and the
    // renderer-facing childBlocks. Walk the whole group so a private nested
    // collector cannot survive through an otherwise user-visible alias such
    // as transcript, while leaving every unrelated future field untouched.
    const group = sanitizeNestedDelegateValue(visible);
    visible = group.value as Record<string, unknown>;
    omitted ||= group.omitted;
  }
  if (source.role === "runtime-event") {
    if (!source._runtimeEvent || typeof source._runtimeEvent !== "object" || Array.isArray(source._runtimeEvent)) {
      throw new Error("[pgSessions] runtime tape record lacks a structured event payload");
    }
    const event = sanitizeRuntimeValue(source._runtimeEvent);
    visible._runtimeEvent = event.value;
    visible.text = JSON.stringify(event.value);
    delete visible._hiddenRuntimeEvent;
    omitted ||= event.omitted;
  }
  for (const key of PRIVATE_NESTED_DELEGATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(visible, key)) {
      delete visible[key];
      omitted = true;
    }
  }
  if (omitted) visible._internalFieldsOmitted = true;
  return visible as MessageLike;
}

type UserVisiblePhysicalPayload = {
  bytes: Buffer;
  contentSha256: string;
  msgId: string;
  role: string;
  modelRecords: Array<{
    logicalOrdinal: number;
    msgId: string;
    role: string;
    semanticText: string;
    tokenEstimate: number;
    ts: number | null;
    clientMessageId: string | null;
  }>;
};

type PreparedLosslessTurnTape = {
  turn: ReturnType<typeof materializeLosslessTurn>;
  visible: UserVisiblePhysicalPayload[];
  partManifest: Array<{ partIndex: number; partSha256: string; payloadBytes: number }>;
  recordPayloadBytes: number;
  recordStorageFormat: LosslessTurnTapeStorageFormat;
};

type LosslessTurnTapeStorageFormat = 2 | 3;

type LosslessTurnTapeHeaderRow = {
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
  record_storage_format: number;
};

type TurnTapeRecoveryLinkRow = {
  source_tape_id: string;
  recovery_tape_id: string;
  source_tape_sha256: string;
  recovery_tape_sha256: string;
  source_turn_key: string;
  recovery_turn_key: string;
};

class TurnTapeRecoveryLockUpgrade extends Error {
  constructor(readonly link: TurnTapeRecoveryLinkRow) {
    super("turn tape recovery requires dual turn locks");
    this.name = "TurnTapeRecoveryLockUpgrade";
  }
}

function sameTurnTapeRecoveryLink(
  left: TurnTapeRecoveryLinkRow,
  right: TurnTapeRecoveryLinkRow,
): boolean {
  return left.source_tape_id === right.source_tape_id &&
    left.recovery_tape_id === right.recovery_tape_id &&
    left.source_tape_sha256 === right.source_tape_sha256 &&
    left.recovery_tape_sha256 === right.recovery_tape_sha256 &&
    left.source_turn_key === right.source_turn_key &&
    left.recovery_turn_key === right.recovery_turn_key;
}

async function readTurnTapeRecoveryLink(
  runner: Pool | PoolClient,
  sessionId: string,
  userId: string,
  recoveryTapeId: string,
  forUpdate = false,
): Promise<TurnTapeRecoveryLinkRow | null> {
  return (
    await runner.query<TurnTapeRecoveryLinkRow>(
      `SELECT source_tape_id,recovery_tape_id,source_tape_sha256,recovery_tape_sha256,
              source_turn_key,recovery_turn_key
         FROM turn_tape_recovery_links
        WHERE session_id=$1 AND user_id=$2 AND recovery_tape_id=$3
        ${forUpdate ? "FOR UPDATE" : ""}`,
      [sessionId, userId, recoveryTapeId],
    )
  ).rows[0] ?? null;
}

type PreparedModelSidecar = {
  physicalOrdinal: number;
  logicalOrdinal: number;
  msgId: string;
  role: string;
  semanticText: string;
  tokenEstimate: number;
  ts: number | null;
  clientMessageId: string | null;
};

function sameLosslessTurnTapeHeader(
  tape: Pick<LosslessTurnTapeHeaderRow,
    "agent_id" | "turn_index" | "status" | "turn_key" | "tape_sha256" |
    "total_bytes" | "part_count" | "created_at" | "waive_reason">,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
): boolean {
  return tape.agent_id === request.agentId &&
    tape.turn_index === request.turnIndex &&
    tape.status === request.status &&
    tape.turn_key === request.turnKey &&
    tape.tape_sha256 === request.tapeSha256 &&
    bigIntNum(tape.total_bytes, "turn_tape.total_bytes") === request.totalBytes &&
    tape.part_count === request.partCount &&
    bigIntNum(tape.created_at, "turn_tape.created_at") === request.createdAt &&
    tape.waive_reason === (request.waiveReason ?? null);
}

function preparedModelSidecarsForOrdinal(
  physicalOrdinal: number,
  physicalMsgId: string,
  visible: UserVisiblePhysicalPayload,
): PreparedModelSidecar[] {
  return visible.modelRecords.map((modelRecord) => ({
    physicalOrdinal,
    logicalOrdinal: modelRecord.logicalOrdinal,
    msgId: modelRecord.msgId === `logical-${modelRecord.logicalOrdinal}`
      ? `${physicalMsgId}:logical-${modelRecord.logicalOrdinal}`
      : modelRecord.msgId,
    role: modelRecord.role,
    semanticText: modelRecord.semanticText,
    tokenEstimate: modelRecord.tokenEstimate,
    ts: modelRecord.ts,
    clientMessageId: modelRecord.clientMessageId,
  })).sort((a, b) => a.logicalOrdinal - b.logicalOrdinal);
}

function preparedModelSidecarManifest(prepared: PreparedLosslessTurnTape): PreparedModelSidecar[] {
  return prepared.turn.records.flatMap((record, physicalOrdinal) =>
    preparedModelSidecarsForOrdinal(
      physicalOrdinal,
      record.id,
      prepared.visible[physicalOrdinal]!,
    ));
}

async function verifyPreparedPartManifest(
  client: PoolClient,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  expectedManifest: PreparedLosslessTurnTape["partManifest"],
): Promise<"complete" | "incomplete"> {
  const actualManifest = (
    await client.query<{
      part_index: number;
      part_sha256: string;
      payload_bytes: string;
    }>(
      `SELECT part_index,part_sha256,octet_length(payload)::text AS payload_bytes
         FROM client_session_turn_tape_parts
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY part_index`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;
  if (actualManifest.length !== expectedManifest.length) return "incomplete";
  for (let index = 0; index < actualManifest.length; index++) {
    const actual = actualManifest[index]!;
    const expected = expectedManifest[index]!;
    if (
      actual.part_index !== expected.partIndex ||
      actual.part_sha256 !== expected.partSha256 ||
      bigIntNum(actual.payload_bytes, "turn tape part bytes") !== expected.payloadBytes
    ) {
      throw new Error("lossless turn tape immutable part manifest conflict");
    }
  }
  return "complete";
}

type PhysicalFinalizeMemorySnapshot = {
  availableSystemBytes: number;
  heapAvailableBytes: number;
  heapLimitBytes: number;
};

function retryableFinalizeCapacityError(reason: string): Error {
  return Object.assign(new Error(`lossless turn tape finalize capacity unavailable: ${reason}`), {
    code: "OC_TURN_TAPE_FINALIZE_CAPACITY",
    retryable: true,
  });
}

/**
 * Physical-memory admission, not a product content cap. Finalization still
 * materializes one canonical JSON value, so concurrent preparations reserve
 * their declared physical peaks. There is no tape-count or content cap: every
 * tape that fits the live process/cgroup and heap budgets proceeds immediately.
 */
export function _createPhysicalFinalizeAdmission(
  readMemory: () => PhysicalFinalizeMemorySnapshot = () => {
    const heapLimitBytes = getHeapStatistics().heap_size_limit;
    return {
      availableSystemBytes: typeof process.availableMemory === "function"
        ? process.availableMemory()
        : freemem(),
      heapAvailableBytes: Math.max(0, heapLimitBytes - process.memoryUsage().heapUsed),
      heapLimitBytes,
    };
  },
): (totalBytes: number) => () => void {
  let reservedExternalBytes = 0;
  let reservedHeapBytes = 0;
  return (totalBytes: number): (() => void) => {
    // One canonical byte buffer plus materialized record buffers are external
    // memory; UTF-8 decoding and JSON.parse need heap. These estimates follow
    // the actual declared tape bytes and current process/cgroup capacity.
    const externalNeed = totalBytes * 3;
    const heapNeed = totalBytes * 2;
    const memory = readMemory();
    // Outstanding reservations may not have reached the live process metrics
    // yet, so account for every one explicitly. Some realized allocations can
    // therefore be counted twice for a short period, but guessing which live
    // delta belongs to this code could overcommit memory under unrelated load.
    if (
      !Number.isFinite(externalNeed) ||
      !Number.isFinite(heapNeed) ||
      heapNeed > memory.heapLimitBytes ||
      reservedExternalBytes + externalNeed > memory.availableSystemBytes ||
      reservedHeapBytes + heapNeed > memory.heapAvailableBytes
    ) {
      throw retryableFinalizeCapacityError("current process/cgroup memory is insufficient");
    }
    reservedExternalBytes += externalNeed;
    reservedHeapBytes += heapNeed;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedExternalBytes -= externalNeed;
      reservedHeapBytes -= heapNeed;
    };
  };
}

const acquireFinalizeMemoryAdmission = _createPhysicalFinalizeAdmission();

async function isLosslessTurnTapeReadyForPreparation(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
): Promise<boolean> {
  const header = (
    await pool.query<{
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
    }>(
      `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
              part_count,created_at,waive_reason,finalized_at
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (!header) return false;
  if (
    header.agent_id !== request.agentId ||
    header.turn_index !== request.turnIndex ||
    header.status !== request.status ||
    header.turn_key !== request.turnKey ||
    header.tape_sha256 !== request.tapeSha256 ||
    bigIntNum(header.total_bytes, "turn_tape.total_bytes") !== request.totalBytes ||
    header.part_count !== request.partCount ||
    bigIntNum(header.created_at, "turn_tape.created_at") !== request.createdAt ||
    header.waive_reason !== (request.waiveReason ?? null)
  ) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (header.finalized_at !== null) return false;
  if (request.partCount !== Math.ceil(request.totalBytes / LOSSLESS_TURN_TAPE_PART_BYTES)) {
    throw new Error("lossless turn tape immutable part manifest conflict");
  }
  const parts = (
    await pool.query<{
      part_index: number;
      part_sha256: string;
      payload_bytes: string;
    }>(
      `SELECT part_index,part_sha256,octet_length(payload)::text AS payload_bytes
         FROM client_session_turn_tape_parts
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY part_index`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;
  if (parts.length < request.partCount) return false;
  if (parts.length > request.partCount) {
    throw new Error("lossless turn tape immutable part manifest conflict");
  }
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]!;
    const expectedBytes = partIndex === request.partCount - 1
      ? request.totalBytes - LOSSLESS_TURN_TAPE_PART_BYTES * (request.partCount - 1)
      : LOSSLESS_TURN_TAPE_PART_BYTES;
    if (
      part.part_index !== partIndex ||
      !LOSSLESS_TURN_TAPE_SHA256_RE.test(part.part_sha256) ||
      bigIntNum(part.payload_bytes, "turn tape part bytes") !== expectedBytes
    ) {
      throw new Error("lossless turn tape immutable part manifest conflict");
    }
  }
  return true;
}

function modelContinuityRecords(records: MessageLike[]): UserVisiblePhysicalPayload["modelRecords"] {
  const out: UserVisiblePhysicalPayload["modelRecords"] = [];
  for (let logicalOrdinal = 0; logicalOrdinal < records.length; logicalOrdinal++) {
    const record = records[logicalOrdinal]!;
    let role: string | null = modelHistorySemanticRole(record);
    let semanticText = modelHistorySemanticText(record);
    if (!role && record.role === "runtime-event") {
      const event = record._runtimeEvent;
      if (event && typeof event === "object" && !Array.isArray(event)) {
        const raw = event as Record<string, unknown>;
        if (raw.type === "system" && raw.subtype === "bash_output_tail") {
          // The exact tail is a real tool result continuation. Finite model
          // context reads do not hydrate the heavyweight tape (and therefore
          // cannot perform the old in-memory merge), so retain the same fact
          // as an ordered tool semantic record.
          role = "tool";
          semanticText = `Exact tool output tail: ${JSON.stringify({
            toolUseId: raw.tool_use_id,
            parentToolUseId: raw.parent_tool_use_id,
            tail: raw.tail,
            totalBytes: raw.total_bytes,
            truncatedHead: raw.truncated_head === true,
          })}`;
        }
      }
    }
    semanticText = pgModelSidecarText(semanticText);
    if (!role || semanticText.trim().length === 0) continue;
    out.push({
      logicalOrdinal,
      msgId: typeof record.id === "string" && record.id.length > 0
        ? record.id
        : `logical-${logicalOrdinal}`,
      role,
      semanticText,
      tokenEstimate: estimateModelHistoryTokens(semanticText),
      ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : null,
      clientMessageId: typeof record._clientMessageId === "string"
        ? record._clientMessageId
        : null,
    });
  }
  return out;
}

function encodeUserVisibleRuntimeBatch(
  physical: MessageLike,
  row: HydratedTapeRow,
  records: MessageLike[],
): Buffer {
  const parts = records.map((record) => Buffer.from(JSON.stringify(record), "utf8"));
  let offset = 0;
  const manifest = records.map((record, index) => {
    const bytes = parts[index]!;
    const entry = {
      id: record.id,
      eventOrdinal: record._ocEventOrdinal,
      ts: record.ts,
      source: record._runtimeSource,
      offset,
      length: bytes.length,
      payloadSha256: sha256Bytes(bytes),
    };
    offset += bytes.length;
    return entry;
  });
  const raw = Buffer.concat(parts);
  const compressed = gzipSync(raw, { level: 9 });
  const wrapper: MessageLike = {
    id: row.msg_id,
    role: "runtime-event",
    text: "",
    ts: typeof physical.ts === "number" ? physical.ts : records[0]?.ts ?? 0,
    _runtimeEventBatch: {
      version: 1,
      encoding: "gzip+base64",
      logicalCount: records.length,
      uncompressedBytes: raw.length,
      compressedBytes: compressed.length,
      manifest,
      manifestSha256: sha256Bytes(Buffer.from(JSON.stringify(manifest), "utf8")),
      data: compressed.toString("base64"),
    },
  };
  if (physical.usage !== undefined) wrapper.usage = structuredClone(physical.usage);
  return Buffer.from(JSON.stringify(wrapper), "utf8");
}

/** Validate the audit bytes, then produce deterministic user-visible bytes.
 * A null result means the physical record contains only opaque engine state. */
function userVisiblePhysicalPayload(
  row: HydratedTapeRow,
  tapeSha256: string,
  billingAnchorId: string,
): UserVisiblePhysicalPayload | null {
  const anchor: MessageLike = { id: billingAnchorId, _turnTapeSha256: tapeSha256 };
  const hydrated = hydrateTapeRecord(row, anchor, false, true);
  let bytes: Buffer;
  let visibleRecords: MessageLike[];
  if (hydrated._runtimeEventBatch !== undefined) {
    const expanded = expandHydratedRuntimeBatch(hydrated, row, anchor).messages;
    const visible = expanded
      .map(userVisibleTapeRecord)
      .filter((message): message is MessageLike => message !== null);
    if (visible.length === 0) return null;
    visibleRecords = visible;
    bytes = encodeUserVisibleRuntimeBatch(hydrated, row, visible);
  } else {
    const visible = userVisibleTapeRecord(hydrated);
    if (!visible) return null;
    visibleRecords = [visible];
    bytes = Buffer.from(JSON.stringify(visible), "utf8");
  }
  return {
    bytes,
    contentSha256: sha256Bytes(bytes),
    msgId: row.msg_id,
    role: row.role,
    modelRecords: modelContinuityRecords(visibleRecords),
  };
}

export async function _prepareLosslessTurnTapeOutsideLocks(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  recordStorageFormat: LosslessTurnTapeStorageFormat,
): Promise<PreparedLosslessTurnTape | null> {
  const header = (
    await pool.query<LosslessTurnTapeHeaderRow>(
      `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
              part_count,created_at,waive_reason,finalized_at,record_storage_format
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows[0];
  if (!header || header.finalized_at !== null) return null;
  if (!sameLosslessTurnTapeHeader(header, request)) {
    throw new Error("lossless turn tape finalize header conflict");
  }
  if (header.record_storage_format !== recordStorageFormat) {
    throw new Error("lossless turn tape materialization format changed during prepare");
  }

  const canonical = Buffer.allocUnsafe(request.totalBytes);
  const aggregate = createHash("sha256");
  const partManifest: PreparedLosslessTurnTape["partManifest"] = [];
  let writeOffset = 0;
  for (let partIndex = 0; partIndex < request.partCount; partIndex++) {
    const part = (
      await pool.query<{ part_sha256: string; payload: Buffer }>(
        `SELECT part_sha256,payload
           FROM client_session_turn_tape_parts
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND part_index=$4`,
        [request.sessionId, userId, request.tapeId, partIndex],
      )
    ).rows[0];
    if (!part) return null;
    const bytes = Buffer.from(part.payload);
    if (sha256Bytes(bytes) !== part.part_sha256) {
      throw new Error("lossless turn tape part hash mismatch");
    }
    if (writeOffset + bytes.length > canonical.length) {
      throw new Error("lossless turn tape aggregate length mismatch");
    }
    bytes.copy(canonical, writeOffset);
    aggregate.update(bytes);
    partManifest.push({ partIndex, partSha256: part.part_sha256, payloadBytes: bytes.length });
    writeOffset += bytes.length;
  }
  if (writeOffset !== request.totalBytes || aggregate.digest("hex") !== request.tapeSha256) {
    throw new Error("lossless turn tape aggregate hash mismatch");
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(canonical.toString("utf8"));
  } catch (err) {
    throw new Error(`lossless turn tape canonical JSON invalid: ${(err as Error).message}`);
  }
  const turn = materializeLosslessTurn(rawPayload, {
    runtimeBatching: recordStorageFormat === 3,
  });
  // Record payload BYTEA + content_sha256 stay the part-derived original.
  // visible_payload is also BYTEA and stays exact (timeline must round-trip
  // JSON \u0000). PostgreSQL jsonb rejects \u0000 / unpaired surrogates;
  // only jsonb binds and sidecar TEXT may be rewritten.
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
  const visible: UserVisiblePhysicalPayload[] = [];
  for (let ordinal = 0; ordinal < turn.records.length; ordinal++) {
    await yieldLosslessTapeWork();
    const item = turn.records[ordinal]!;
    const payload = userVisiblePhysicalPayload({
      tape_id: request.tapeId,
      tape_sha256: request.tapeSha256,
      waive_reason: null,
      waiver_applied: false,
      msg_id: item.id,
      ordinal,
      role: item.role,
      content_sha256: item.payloadSha256,
      payload: item.payloadBytes,
      cost_credits: "0",
      delegate_costs: [],
    }, request.tapeSha256, turn.billingAnchorId);
    if (!payload) {
      throw new Error(`[pgSessions] lossless tape record is not a JSON object: ${item.id}`);
    }
    // visible_payload is BYTEA, not jsonb. Keep exact JSON (including \u0000)
    // so timeline/exact reads match original record bytes. jsonb columns are
    // sanitized at bind time; the 0232 trigger lazy-sanitizes agent-group casts.
    visible.push(payload);
  }
  return {
    turn,
    visible,
    partManifest,
    recordPayloadBytes: turn.records.reduce(
      (sum, record) => sum + record.payloadBytes.length,
      0,
    ),
    recordStorageFormat,
  };
}

async function claimLosslessTurnTapeStorageFormat(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
): Promise<LosslessTurnTapeStorageFormat | null> {
  return withTx(pool, async (client) => {
    const tape = (
      await client.query<LosslessTurnTapeHeaderRow>(
        `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
                part_count,created_at,waive_reason,finalized_at,record_storage_format
           FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          FOR UPDATE`,
        [request.sessionId, userId, request.tapeId],
      )
    ).rows[0];
    if (!tape || tape.finalized_at !== null) return null;
    if (!sameLosslessTurnTapeHeader(tape, request)) {
      throw new Error("lossless turn tape finalize header conflict");
    }
    if (tape.record_storage_format !== 2 && tape.record_storage_format !== 3) {
      throw new Error("lossless turn tape storage format is invalid");
    }
    if (tape.record_storage_format === 3 || !isLosslessRuntimeBatchingEnabled()) {
      return tape.record_storage_format;
    }

    // The canonical parts remain the immutable authority until publication.
    // Derived rows of an unfinalized format-2 attempt are not browser-visible,
    // billed or dispatch-terminal. Replace them atomically before pinning the
    // tape so retries can adopt lossless runtime batches without mixed rows.
    await client.query(
      `DELETE FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [request.sessionId, userId, request.tapeId],
    );
    await client.query(
      `DELETE FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [request.sessionId, userId, request.tapeId],
    );
    await client.query(
      `UPDATE client_session_turn_tapes
          SET record_storage_format=3
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [request.sessionId, userId, request.tapeId],
    );
    return 3;
  });
}

export const LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE = 128;

function yieldLosslessTapeWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let afterLosslessStageBatch: (() => Promise<void> | void) | null = null;
export function _setAfterLosslessStageBatch(hook: (() => Promise<void> | void) | null): void {
  afterLosslessStageBatch = hook;
}

let phaseASqlObserver: ((sql: string) => void) | null = null;
export function _setPhaseASqlObserver(observer: ((sql: string) => void) | null): void {
  phaseASqlObserver = observer;
}

export function _losslessTurnRecordStageBatches(
  recordCount: number,
  exactOrdinals: ReadonlySet<number>,
): number[][] {
  const pending = Array.from({ length: recordCount }, (_value, ordinal) => ordinal)
    .filter((ordinal) => !exactOrdinals.has(ordinal));
  const batches: number[][] = [];
  for (let start = 0; start < pending.length; start += LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE) {
    batches.push(pending.slice(start, start + LOSSLESS_TURN_RECORD_STAGE_BATCH_SIZE));
  }
  return batches;
}

export async function _stagePreparedLosslessTurnRecords(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
): Promise<void> {
  const exactOrdinals = await readExactPreparedLosslessTurnOrdinals(
    pool,
    userId,
    request,
    prepared,
  );
  for (const batch of _losslessTurnRecordStageBatches(prepared.turn.records.length, exactOrdinals)) {
    const staged = await withTx(pool, async (client): Promise<"staged" | "finalized" | "missing"> => {
      // One immutable-header lock covers a bounded batch rather than one
      // transaction per physical record. This preserves every per-record
      // verification below while avoiding tens of thousands of header-lock
      // transactions for runtime-event-heavy turns.
      const tape = (
        await client.query<LosslessTurnTapeHeaderRow>(
          `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
                  part_count,created_at,waive_reason,finalized_at,record_storage_format
             FROM client_session_turn_tapes
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            FOR UPDATE`,
          [request.sessionId, userId, request.tapeId],
        )
      ).rows[0];
      if (!tape) return "missing";
      if (!sameLosslessTurnTapeHeader(tape, request)) {
        throw new Error("lossless turn tape finalize header conflict");
      }
      if (tape.finalized_at !== null) return "finalized";
      await client.query("SET LOCAL statement_timeout = '120s'");
      // Keep original record BYTEA. The 0232 trigger sanitizes jsonb-illegal
      // unicode escapes (or skips canonicalize) instead of failing INSERT.
      // Application already rejects trigger rewrites of payload/hash.
      if (tape.record_storage_format !== prepared.recordStorageFormat) {
        throw new Error("lossless turn tape materialization format changed during staging");
      }

      for (const ordinal of batch) {
      await yieldLosslessTapeWork();
      const item = prepared.turn.records[ordinal]!;
      const visible = prepared.visible[ordinal]!;
      const expectedModels = preparedModelSidecarsForOrdinal(ordinal, item.id, visible);

      type StagedRecordRow = {
        msg_id: string;
        ordinal: number;
        role: string;
        ts: string;
        content_sha256: string;
        payload: Buffer;
        visible_payload: Buffer | null;
        visible_content_sha256: string | null;
        model_sidecar_complete: boolean;
      };
      const identityRows = (
        await client.query<StagedRecordRow>(
          `SELECT msg_id,ordinal,role,ts::text,content_sha256,payload,
                  visible_payload,visible_content_sha256,model_sidecar_complete
             FROM client_session_turn_tape_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
              AND (msg_id=$4 OR ordinal=$5)
            FOR UPDATE`,
          [request.sessionId, userId, request.tapeId, item.id, ordinal],
        )
      ).rows;
      if (
        identityRows.length > 1 ||
        (identityRows[0] !== undefined &&
          (identityRows[0].msg_id !== item.id || identityRows[0].ordinal !== ordinal))
      ) {
        throw new Error("lossless turn tape immutable record identity conflict");
      }
      const existing = identityRows[0];
      const rawRecordMatches = existing !== undefined &&
        existing.role === item.role &&
        bigIntNum(existing.ts, "turn tape record ts") === item.ts &&
        existing.content_sha256 === item.payloadSha256 &&
        existing.payload.equals(item.payloadBytes);
      const visibleRecordConflicts = existing !== undefined && (
        (existing.visible_payload !== null && !existing.visible_payload.equals(visible.bytes)) ||
        (existing.visible_content_sha256 !== null &&
          existing.visible_content_sha256 !== visible.contentSha256)
      );
      const rewriteRecord = existing === undefined || !rawRecordMatches || visibleRecordConflicts;

      const existingModels = (
        await client.query<{
          physical_ordinal: number;
          logical_ordinal: number;
          msg_id: string;
          role: string;
          semantic_text: string;
          token_estimate: number;
          ts: string | null;
          client_message_id: string | null;
        }>(
          `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                  token_estimate,ts::text,client_message_id
             FROM client_session_turn_tape_model_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4
            ORDER BY logical_ordinal`,
          [request.sessionId, userId, request.tapeId, ordinal],
        )
      ).rows;
      const modelSidecarsMatch = existingModels.length === expectedModels.length &&
        existingModels.every((actual, index) => {
          const expected = expectedModels[index]!;
          return actual.physical_ordinal === expected.physicalOrdinal &&
            actual.logical_ordinal === expected.logicalOrdinal &&
            actual.msg_id === expected.msgId &&
            actual.role === expected.role &&
            actual.semantic_text === expected.semanticText &&
            actual.token_estimate === expected.tokenEstimate &&
            (actual.ts === null ? null : bigIntNum(actual.ts, "model record ts")) === expected.ts &&
            actual.client_message_id === expected.clientMessageId;
        });

      let writtenRecord: StagedRecordRow | undefined;
      if (existing === undefined) {
        writtenRecord = (
          await client.query<StagedRecordRow>(
            `INSERT INTO client_session_turn_tape_records
               (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload,
                visible_payload,visible_content_sha256,model_sidecar_complete)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE)
             RETURNING msg_id,ordinal,role,ts::text,content_sha256,payload,
                       visible_payload,visible_content_sha256,model_sidecar_complete`,
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
              visible.bytes,
              visible.contentSha256,
            ],
          )
        ).rows[0];
      } else if (rewriteRecord) {
        writtenRecord = (
          await client.query<StagedRecordRow>(
            `UPDATE client_session_turn_tape_records
                SET ordinal=$5,role=$6,ts=$7,content_sha256=$8,payload=$9,
                    visible_payload=$10,visible_content_sha256=$11,
                    model_sidecar_complete=FALSE
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND msg_id=$4
              RETURNING msg_id,ordinal,role,ts::text,content_sha256,payload,
                        visible_payload,visible_content_sha256,model_sidecar_complete`,
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
              visible.bytes,
              visible.contentSha256,
            ],
          )
        ).rows[0];
      } else if (
        existing.visible_payload === null || existing.visible_content_sha256 === null
      ) {
        await client.query(
          `UPDATE client_session_turn_tape_records
              SET visible_payload=COALESCE(visible_payload,$5),
                  visible_content_sha256=COALESCE(visible_content_sha256,$6)
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND msg_id=$4`,
          [request.sessionId, userId, request.tapeId, item.id, visible.bytes, visible.contentSha256],
        );
      }

      // Migration 0151 has a rolling-compatibility BEFORE trigger which may
      // rewrite legacy agent-group bytes. Never publish bytes other than this
      // release's deterministic materialization, and never let its part DELETE
      // escape an ordinal transaction which cannot still prove the source.
      if (writtenRecord !== undefined && (
        writtenRecord.msg_id !== item.id ||
        writtenRecord.ordinal !== ordinal ||
        writtenRecord.role !== item.role ||
        bigIntNum(writtenRecord.ts, "written turn tape record ts") !== item.ts ||
        writtenRecord.content_sha256 !== item.payloadSha256 ||
        !writtenRecord.payload.equals(item.payloadBytes) ||
        writtenRecord.visible_payload === null ||
        !writtenRecord.visible_payload.equals(visible.bytes) ||
        writtenRecord.visible_content_sha256 !== visible.contentSha256
      )) {
        throw new Error("lossless turn tape derived record write changed at database boundary");
      }

      if (rewriteRecord || !modelSidecarsMatch) {
        await client.query(
          `UPDATE client_session_turn_tape_records
              SET model_sidecar_complete=FALSE
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
          [request.sessionId, userId, request.tapeId, ordinal],
        );
        await client.query(
          `DELETE FROM client_session_turn_tape_model_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4`,
          [request.sessionId, userId, request.tapeId, ordinal],
        );
        for (const modelRecord of expectedModels) {
          await client.query(
            `INSERT INTO client_session_turn_tape_model_records
               (session_id,user_id,tape_id,physical_ordinal,logical_ordinal,msg_id,role,
                semantic_text,token_estimate,ts,client_message_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              request.sessionId,
              userId,
              request.tapeId,
              modelRecord.physicalOrdinal,
              modelRecord.logicalOrdinal,
              modelRecord.msgId,
              modelRecord.role,
              modelRecord.semanticText,
              modelRecord.tokenEstimate,
              modelRecord.ts,
              modelRecord.clientMessageId,
            ],
          );
        }
      }

      if (writtenRecord !== undefined && item.role === "agent-group") {
        const partState = await verifyPreparedPartManifest(
          client,
          userId,
          request,
          prepared.partManifest,
        );
        if (partState !== "complete") {
          throw new Error("lossless turn tape source parts changed during record staging");
        }
      }

      // Publish per-physical completeness only after the exact record and all
      // deterministic model rows commit together.
      await client.query(
        `UPDATE client_session_turn_tape_records
            SET model_sidecar_complete=TRUE
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
        [request.sessionId, userId, request.tapeId, ordinal],
      );
      }
      return "staged";
    });
    if (staged !== "staged") return;
    if (afterLosslessStageBatch) await afterLosslessStageBatch();
  }
}

async function readExactPreparedLosslessTurnOrdinals(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest,
  prepared: PreparedLosslessTurnTape,
): Promise<Set<number>> {
  type RecordSummaryRow = {
    msg_id: string;
    ordinal: number;
    role: string;
    ts: string;
    content_sha256: string;
    payload_sha256: string;
    visible_content_sha256: string | null;
    visible_payload_sha256: string | null;
    model_sidecar_complete: boolean;
  };
  const records = (
    await pool.query<RecordSummaryRow>(
      `SELECT msg_id,ordinal,role,ts::text,content_sha256,
              encode(public.digest(payload,'sha256'),'hex') AS payload_sha256,
              visible_content_sha256,
              CASE WHEN visible_payload IS NULL THEN NULL
                   ELSE encode(public.digest(visible_payload,'sha256'),'hex') END
                AS visible_payload_sha256,
              model_sidecar_complete
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY ordinal`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;

  type ModelSummaryRow = {
    physical_ordinal: number;
    logical_ordinal: number;
    msg_id: string;
    role: string;
    semantic_text_sha256: string;
    token_estimate: number;
    ts: string | null;
    client_message_id: string | null;
  };
  const modelRows = (
    await pool.query<ModelSummaryRow>(
      `SELECT physical_ordinal,logical_ordinal,msg_id,role,
              encode(public.digest(convert_to(semantic_text,'UTF8'),'sha256'),'hex')
                AS semantic_text_sha256,
              token_estimate,ts::text,client_message_id
         FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY physical_ordinal,logical_ordinal`,
      [request.sessionId, userId, request.tapeId],
    )
  ).rows;

  const recordsByOrdinal = new Map(records.map((row) => [row.ordinal, row]));
  const modelsByOrdinal = new Map<number, ModelSummaryRow[]>();
  for (const row of modelRows) {
    const rows = modelsByOrdinal.get(row.physical_ordinal);
    if (rows) rows.push(row);
    else modelsByOrdinal.set(row.physical_ordinal, [row]);
  }

  const exact = new Set<number>();
  for (let ordinal = 0; ordinal < prepared.turn.records.length; ordinal++) {
    await yieldLosslessTapeWork();
    const item = prepared.turn.records[ordinal]!;
    const visible = prepared.visible[ordinal]!;
    const record = recordsByOrdinal.get(ordinal);
    if (
      !record ||
      record.msg_id !== item.id ||
      record.role !== item.role ||
      bigIntNum(record.ts, "summarized turn tape record ts") !== item.ts ||
      record.content_sha256 !== item.payloadSha256 ||
      record.payload_sha256 !== item.payloadSha256 ||
      record.visible_content_sha256 !== visible.contentSha256 ||
      record.visible_payload_sha256 !== visible.contentSha256 ||
      record.model_sidecar_complete !== true
    ) {
      continue;
    }

    const expectedModels = preparedModelSidecarsForOrdinal(ordinal, item.id, visible);
    const actualModels = modelsByOrdinal.get(ordinal) ?? [];
    if (
      actualModels.length !== expectedModels.length ||
      !actualModels.every((actual, index) => {
        const expected = expectedModels[index]!;
        return actual.physical_ordinal === expected.physicalOrdinal &&
          actual.logical_ordinal === expected.logicalOrdinal &&
          actual.msg_id === expected.msgId &&
          actual.role === expected.role &&
          actual.semantic_text_sha256 === sha256Bytes(Buffer.from(expected.semanticText, "utf8")) &&
          actual.token_estimate === expected.tokenEstimate &&
          (actual.ts === null ? null : bigIntNum(actual.ts, "summarized model record ts")) ===
            expected.ts &&
          actual.client_message_id === expected.clientMessageId;
      })
    ) {
      continue;
    }
    exact.add(ordinal);
  }
  return exact;
}

async function readDirectTapeHeaders(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, DirectTapeHeader>> {
  if (tapeIds.length === 0) return new Map();
  const rows = (
    await pool.query<{
      tape_id: string;
      tape_sha256: string;
      billing_anchor_id: string | null;
      payload_bytes: string;
      physical_count: string;
      logical_count: string;
      status: string;
      turn_key: string;
      client_message_id: string | null;
      materialization_status: string | null;
      finalized_at: string | null;
      visible_at: string | null;
      visible_head: VisibleHead | null;
    }>(
      `SELECT t.tape_id, t.tape_sha256, t.billing_anchor_id, t.status, t.turn_key,
              COALESCE(t.client_message_id, d.client_message_id) AS client_message_id,
              t.record_payload_bytes::text AS payload_bytes,
              t.physical_record_count::text AS physical_count,
              t.logical_record_count::text AS logical_count,
              t.materialization_status, t.finalized_at::text, t.visible_at::text, t.visible_head
         FROM client_session_turn_tapes t
         LEFT JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
        WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])
          AND (t.visible_at IS NOT NULL OR t.finalized_at IS NOT NULL)
          AND t.billing_anchor_id IS NOT NULL`,
      [sessionId, userId, tapeIds],
    )
  ).rows;
  const legacyTapeIds = rows
    .filter((row) => row.payload_bytes === "0" || row.physical_count === "0" || row.logical_count === "0")
    .map((row) => row.tape_id);
  if (legacyTapeIds.length > 0) {
    // Migration 0176 deliberately avoids a production-wide >1 GiB backfill.
    // Derive only tapes on the requested lazy page through the tape PK index,
    // then cache the exact totals so subsequent reads stay O(number of tapes).
    const derived = (
      await pool.query<{
        tape_id: string;
        payload_bytes: string;
        physical_count: string;
        logical_count: string;
      }>(
        `WITH totals AS (
           SELECT r.session_id, r.user_id, r.tape_id,
                  COUNT(*)::integer AS physical_count,
                  COALESCE(SUM(octet_length(r.payload)),0)::bigint AS payload_bytes,
                  COALESCE(SUM(
                    CASE
                      WHEN r.role='runtime-event' AND r.msg_id LIKE '%-runtime-batch-%'
                      THEN substring(
                        convert_from(r.payload, 'UTF8')
                        FROM '"logicalCount"[[:space:]]*:[[:space:]]*([0-9]+)'
                      )::integer
                      ELSE 1
                    END
                  ),0)::integer AS logical_count
             FROM client_session_turn_tape_records r
            WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
            GROUP BY r.session_id, r.user_id, r.tape_id
         )
         UPDATE client_session_turn_tapes t
            SET physical_record_count=CASE WHEN t.physical_record_count=0
                                           THEN totals.physical_count ELSE t.physical_record_count END,
                logical_record_count=CASE WHEN t.logical_record_count=0
                                          THEN totals.logical_count ELSE t.logical_record_count END,
                record_payload_bytes=CASE WHEN t.record_payload_bytes=0
                                          THEN totals.payload_bytes ELSE t.record_payload_bytes END
           FROM totals
          WHERE t.session_id=totals.session_id AND t.user_id=totals.user_id
            AND t.tape_id=totals.tape_id
          RETURNING t.tape_id, t.record_payload_bytes::text AS payload_bytes,
                    t.physical_record_count::text AS physical_count,
                    t.logical_record_count::text AS logical_count`,
        [sessionId, userId, legacyTapeIds],
      )
    ).rows;
    const byTape = new Map(derived.map((row) => [row.tape_id, row]));
    for (const row of rows) {
      const exact = byTape.get(row.tape_id);
      if (!exact) continue;
      row.payload_bytes = exact.payload_bytes;
      row.physical_count = exact.physical_count;
      row.logical_count = exact.logical_count;
    }
  }
  return new Map(
    rows.map((row) => [
      row.tape_id,
      {
        tapeId: row.tape_id,
        tapeSha256: row.tape_sha256,
        billingAnchorId: row.billing_anchor_id!,
        totalBytes: bigIntNum(row.payload_bytes, "turn tape payload bytes"),
        physicalCount: bigIntNum(row.physical_count, "turn tape physical count"),
        logicalCount: bigIntNum(row.logical_count, "turn tape logical count"),
        status: row.status,
        turnKey: row.turn_key,
        clientMessageId: row.client_message_id,
        materializationStatus: (row as { materialization_status?: string | null }).materialization_status ?? null,
        finalizedAt: (row as { finalized_at?: string | null }).finalized_at ?? null,
        visibleAt: (row as { visible_at?: string | null }).visible_at ?? null,
        visibleHead: ((row as { visible_head?: VisibleHead | null }).visible_head ?? null),
      },
    ]),
  );
}

async function readHydratedTapeRows(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
  roles?: string[],
  recordRefs?: Array<{ tapeId: string; msgId: string }>,
): Promise<HydratedTapeRow[]> {
  if (tapeIds.length === 0) return [];
  let nextParam = 4;
  const roleClause = roles && roles.length > 0
    ? `AND r.role=ANY($${nextParam++}::text[])`
    : "";
  const recordClause = recordRefs && recordRefs.length > 0
    ? `AND (r.tape_id, r.msg_id) IN (
         SELECT selected.tape_id, selected.msg_id
           FROM unnest($${nextParam++}::text[], $${nextParam++}::text[])
                AS selected(tape_id, msg_id)
       )`
    : "";
  const params: unknown[] = [sessionId, userId, tapeIds];
  if (roles && roles.length > 0) params.push(roles);
  if (recordRefs && recordRefs.length > 0) {
    params.push(recordRefs.map((ref) => ref.tapeId), recordRefs.map((ref) => ref.msgId));
  }
  return (
    await pool.query<HydratedTapeRow>(
      `SELECT r.tape_id, t.tape_sha256, t.waive_reason,
              EXISTS (
                SELECT 1 FROM turn_waivers w
                 WHERE ('c:' || w.user_id::text)=t.user_id
                   AND w.turn_key=t.turn_key AND w.status='applied'
              ) AS waiver_applied,
              r.msg_id, r.ordinal, r.role, r.content_sha256, r.payload,
              COALESCE((
                SELECT SUM(exact_cost.cost_credits)::text
                  FROM (
                        SELECT c.cost_credits::numeric AS cost_credits
                          FROM turn_tape_cost_components c
                         WHERE c.user_id=r.user_id AND c.session_id=r.session_id
                           AND (
                             (recovery.source_tape_id IS NULL
                               AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id)
                             OR
                             (recovery.source_tape_id IS NOT NULL
                               AND r.msg_id=t.billing_anchor_id
                               AND c.tape_id=recovery.source_tape_id
                               AND c.billing_anchor_id=source_tape.billing_anchor_id)
                           )
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
                           AND (
                             (recovery.source_tape_id IS NULL
                               AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id)
                             OR
                             (recovery.source_tape_id IS NOT NULL
                               AND r.msg_id=t.billing_anchor_id
                               AND c.tape_id=recovery.source_tape_id
                               AND c.billing_anchor_id=source_tape.billing_anchor_id)
                           )
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
         LEFT JOIN turn_tape_recovery_links recovery
           ON recovery.session_id=r.session_id AND recovery.user_id=r.user_id
          AND recovery.recovery_tape_id=r.tape_id
         LEFT JOIN client_session_turn_tapes source_tape
           ON source_tape.session_id=recovery.session_id AND source_tape.user_id=recovery.user_id
          AND source_tape.tape_id=recovery.source_tape_id
        WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
          ${roleClause}
          ${recordClause}
        ORDER BY r.tape_id, r.ordinal`,
      params,
    )
  ).rows;
}

/** Browser timeline hydration reads locator metadata only. Thousands of tiny
 * tape anchors can fit in the bounded hot row while their assistant BYTEA
 * payloads total gigabytes; mounted viewport rows fetch those exact bytes from
 * the range endpoint instead of amplifying one session GET. */
async function readDirectTapeVisibleHeads(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<DirectTapeVisibleHead[]> {
  if (tapeIds.length === 0) return [];
  return (
    await pool.query<DirectTapeVisibleHead>(
      `SELECT r.tape_id, r.msg_id, r.ordinal, r.role, r.ts::text,
              COALESCE(octet_length(r.visible_payload), octet_length(r.payload))::text
                AS payload_bytes,
              r.visible_content_sha256, t.billing_anchor_id,
              EXISTS (
                SELECT 1 FROM turn_waivers w
                 WHERE ('c:' || w.user_id::text)=t.user_id
                   AND w.turn_key=t.turn_key AND w.status='applied'
              ) AS waiver_applied,
              COALESCE((
                SELECT SUM(exact_cost.cost_credits)::text
                  FROM (
                        SELECT c.cost_credits::numeric AS cost_credits
                          FROM turn_tape_cost_components c
                         WHERE c.user_id=r.user_id AND c.session_id=r.session_id
                           AND (
                             (recovery.source_tape_id IS NULL
                               AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id)
                             OR
                             (recovery.source_tape_id IS NOT NULL
                               AND r.msg_id=t.billing_anchor_id
                               AND c.tape_id=recovery.source_tape_id
                               AND c.billing_anchor_id=source_tape.billing_anchor_id)
                           )
                    UNION ALL
                    SELECT p.cost_credits::numeric AS cost_credits
                      FROM pending_usage_patches p
                     WHERE p.user_id=r.user_id AND r.msg_id=t.billing_anchor_id
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
                           AND (
                             (recovery.source_tape_id IS NULL
                               AND c.tape_id=r.tape_id AND c.billing_anchor_id=r.msg_id)
                             OR
                             (recovery.source_tape_id IS NOT NULL
                               AND r.msg_id=t.billing_anchor_id
                               AND c.tape_id=recovery.source_tape_id
                               AND c.billing_anchor_id=source_tape.billing_anchor_id)
                           )
                        UNION ALL
                        SELECT p.delegate_agent_id, p.cost_credits::numeric AS cost_credits
                          FROM pending_usage_patches p
                         WHERE p.user_id=r.user_id AND r.msg_id=t.billing_anchor_id
                           AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                      ) exact_delegate
                     WHERE exact_delegate.delegate_agent_id IS NOT NULL
                     GROUP BY exact_delegate.delegate_agent_id
                  ) grouped
              ), '[]'::jsonb) AS delegate_costs
         FROM client_session_turn_tape_records r
         JOIN client_session_turn_tapes t
           ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
         LEFT JOIN turn_tape_recovery_links recovery
           ON recovery.session_id=r.session_id AND recovery.user_id=r.user_id
          AND recovery.recovery_tape_id=r.tape_id
         LEFT JOIN client_session_turn_tapes source_tape
           ON source_tape.session_id=recovery.session_id AND source_tape.user_id=recovery.user_id
          AND source_tape.tape_id=recovery.source_tape_id
        WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=ANY($3::text[])
          AND r.msg_id=t.billing_anchor_id
        ORDER BY r.tape_id, r.ordinal`,
      [sessionId, userId, tapeIds],
    )
  ).rows;
}

function directTapeProcessRow(anchor: MessageLike, header: DirectTapeHeader): MessageLike {
  return {
    id: `turn-process:${header.tapeId}`,
    role: "runtime-event",
    text: "",
    ts: typeof anchor.ts === "number" ? anchor.ts : 0,
    _source: "server",
    _turnTapeId: header.tapeId,
    _turnTapeSha256: header.tapeSha256,
    _turnTapeComplete: true,
    _turnTapeProcess: true,
    // The billing anchor is rendered separately as the final row. Everything
    // else is reachable through this cursor, including future record roles and
    // every logical runtime event inside a physical batch.
    _turnTapeProcessCount: Math.max(0, header.logicalCount - 1),
    _turnTapeTotalBytes: header.totalBytes,
    _dispatchOutcome: header.status,
    ...(header.clientMessageId ? { _clientMessageId: header.clientMessageId } : {}),
    ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
    ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
  };
}

/**
 * Exact/admin reads hydrate every physical and logical record. Browser chat
 * reads return metadata-only assistant/error locators and add one typed
 * process control before them. Mounted viewport rows fetch exact immutable
 * bytes; the control owns the cursor for every remaining semantic record.
 */
async function hydrateTurnTapeMessages(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  messages: MessageLike[],
  options: ClientSessionReadOptions & {
    deferTimelineNarrative?: boolean;
    /** Private runner continuity view: hydrate every user-visible semantic
     * fact, but still skip thinking and opaque audit envelopes. */
    engineContext?: boolean;
  } = {},
): Promise<MessageLike[]> {
  const refs = messages.filter(
    (message) =>
      message &&
      typeof message._turnTapeId === "string" &&
      typeof message._turnTapeSha256 === "string",
  );
  if (refs.length === 0) return messages;
  const completeRefs = refs.filter((message) => message._turnTapeComplete === true);
  const rollingRefs = refs
    .filter((message) => message._turnTapeComplete !== true)
    .map((message) => {
      if (typeof message._turnTapeMsgId !== "string") {
        throw new Error(`[pgSessions] lossless turn tape anchor malformed: ${message._turnTapeId}`);
      }
      return {
        tapeId: message._turnTapeId as string,
        msgId: message._turnTapeMsgId,
      };
    });
  const completeTapeIds = [
    ...new Set(completeRefs.map((message) => message._turnTapeId as string)),
  ];
  const rollingTapeIds = [...new Set(rollingRefs.map((ref) => ref.tapeId))];
  const exact = options.view !== "timeline";
  const engineContext = options.engineContext === true;
  const deferTimelineNarrative = !exact && options.deferTimelineNarrative !== false;
  const timelineRoles = engineContext
    ? ["assistant", "error", "tool", "plan", "goal", "agent-group", "runtime-event"]
    : ["assistant", "error"];
  const [headers, completeRows, timelineHeads, rollingRows] = await Promise.all([
    readDirectTapeHeaders(pool, sessionId, userId, completeTapeIds),
    deferTimelineNarrative
      ? Promise.resolve([] as HydratedTapeRow[])
      : readHydratedTapeRows(
          pool,
          sessionId,
          userId,
          completeTapeIds,
          exact ? undefined : timelineRoles,
        ),
    deferTimelineNarrative
      ? readDirectTapeVisibleHeads(pool, sessionId, userId, completeTapeIds)
      : Promise.resolve([] as DirectTapeVisibleHead[]),
    readHydratedTapeRows(pool, sessionId, userId, rollingTapeIds, undefined, rollingRefs),
  ]);
  const rows = [...completeRows, ...rollingRows];
  const byKey = new Map(rows.map((row) => [`${row.tape_id}\0${row.msg_id}`, row]));
  const byTape = new Map<string, HydratedTapeRow[]>();
  for (const row of completeRows) {
    const list = byTape.get(row.tape_id) ?? [];
    list.push(row);
    byTape.set(row.tape_id, list);
  }
  const headsByTape = new Map<string, DirectTapeVisibleHead[]>();
  for (const head of timelineHeads) {
    const list = headsByTape.get(head.tape_id) ?? [];
    list.push(head);
    headsByTape.set(head.tape_id, list);
  }

  const hydrated = messages.flatMap((anchor): MessageLike[] => {
    const tapeId = typeof anchor._turnTapeId === "string" ? anchor._turnTapeId : null;
    const tapeSha256 = typeof anchor._turnTapeSha256 === "string" ? anchor._turnTapeSha256 : null;
    if (!tapeId || !tapeSha256) return [anchor];
    if (anchor._turnTapeComplete !== true) {
      if (typeof anchor._turnTapeMsgId !== "string") {
        throw new Error(`[pgSessions] lossless turn tape anchor malformed: ${tapeId}`);
      }
      const key = `${tapeId}\0${anchor._turnTapeMsgId}`;
      const row = byKey.get(key);
      if (!row) throw new Error(`[pgSessions] lossless turn tape record missing: ${key}`);
      return [hydrateTapeRecord(row, anchor, true)];
    }
    const header = headers.get(tapeId);
    if (!header) throw new Error(`[pgSessions] finalized lossless turn tape missing: ${tapeId}`);
    if (header.tapeSha256 !== tapeSha256) {
      throw new Error(`[pgSessions] lossless turn tape aggregate hash mismatch: ${tapeId}`);
    }
    if (!recordsPublished({
      materializationStatus: header.materializationStatus,
      finalizedAt: header.finalizedAt,
    })) {
      const head = header.visibleHead;
      const message: MessageLike = {
        id: head?.messageId ?? header.billingAnchorId,
        role: "assistant",
        text: typeof head?.text === "string" ? head.text : "",
        ts: typeof head?.ts === "number" ? head.ts : (typeof anchor.ts === "number" ? anchor.ts : 0),
        status: header.status,
        _source: "server",
        _turnTapeId: header.tapeId,
        _turnTapeSha256: header.tapeSha256,
        _turnTapeComplete: true,
        _turnKey: header.turnKey,
        ...(header.clientMessageId ? { _clientMessageId: header.clientMessageId } : {}),
        ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
        ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
      };
      return [message];
    }
    const expectedPhysical = anchor._turnTapePhysicalRecordCount ?? anchor._turnTapeRecordCount;
    if (
      typeof expectedPhysical === "number" &&
      Number.isSafeInteger(expectedPhysical) &&
      expectedPhysical > 0 &&
      expectedPhysical !== header.physicalCount
    ) {
      throw new Error(`[pgSessions] lossless turn tape physical count mismatch: ${tapeId}`);
    }
    const tapeRows = byTape.get(tapeId) ?? [];
    if (exact) {
      if (tapeRows.length !== header.physicalCount) {
        throw new Error(`[pgSessions] lossless turn tape records missing: ${tapeId}`);
      }
      const expanded: MessageLike[] = [];
      const batchDescriptors: HydratedRuntimeBatchDescriptor[] = [];
      for (const row of tapeRows) {
        const result = expandHydratedRuntimeBatch(
          hydrateTapeRecord(row, anchor, false, anchor._turnTapeComplete === true),
          row,
          anchor,
        );
        expanded.push(...result.messages);
        if (result.descriptor) batchDescriptors.push(result.descriptor);
      }
      const expectedLogical = anchor._turnTapeLogicalRecordCount;
      if (
        typeof expectedLogical === "number" &&
        Number.isSafeInteger(expectedLogical) &&
        expectedLogical > 0 &&
        expanded.length !== expectedLogical
      ) {
        throw new Error(`[pgSessions] lossless turn tape logical count mismatch: ${tapeId}`);
      }
      const expectedManifestSha = anchor._turnTapeRuntimeManifestSha256;
      if (expectedManifestSha !== undefined) {
        if (
          typeof expectedManifestSha !== "string" ||
          !LOSSLESS_TURN_TAPE_SHA256_RE.test(expectedManifestSha) ||
          batchDescriptors.length === 0 ||
          sha256Bytes(Buffer.from(JSON.stringify(batchDescriptors), "utf8")) !== expectedManifestSha
        ) {
          throw new Error(`[pgSessions] lossless turn tape runtime manifest mismatch: ${tapeId}`);
        }
      } else if (batchDescriptors.length > 0) {
        throw new Error(`[pgSessions] lossless turn tape runtime manifest missing: ${tapeId}`);
      }
      return expanded;
    }

    const narrative = deferTimelineNarrative
      ? (headsByTape.get(tapeId) ?? []).map((head) => {
          let deferred = deferredTapeRecord(
            tapeId,
            header.tapeSha256,
            {
              msg_id: head.msg_id,
              ordinal: head.ordinal,
              role: head.role,
              ts: head.ts,
              ...(head.visible_content_sha256
                ? { content_sha256: head.visible_content_sha256 }
                : {}),
            },
            bigIntNum(head.payload_bytes, "turn tape timeline payload bytes"),
          );
          if (typeof anchor._seq === "number") deferred._seq = anchor._seq;
          if (typeof anchor._orderSeq === "number") deferred._orderSeq = anchor._orderSeq;
          deferred.status = header.status;
          deferred._turnKey = header.turnKey;
          deferred = mergeBillingAnchorUsage(deferred, anchor, head.msg_id === head.billing_anchor_id);
          deferred = mergeExactUsage(
            deferred,
            {
              costCredits: head.cost_credits,
              waiverApplied: head.waiver_applied,
              delegates: parseDelegateCosts(head.delegate_costs),
            },
            head.msg_id === head.billing_anchor_id,
          );
          return deferred;
        })
      : tapeRows.map((row) =>
          hydrateTapeRecord(row, anchor, false, anchor._turnTapeComplete === true),
        );
    narrative.sort((a, b) =>
      (typeof a._turnTapeOrdinal === "number" ? a._turnTapeOrdinal : 0) -
      (typeof b._turnTapeOrdinal === "number" ? b._turnTapeOrdinal : 0),
    );
    const narrativeClientMessageId = narrative.find(
      (message) => typeof message._clientMessageId === "string",
    )?._clientMessageId;
    const clientMessageId = header.clientMessageId ??
      (typeof narrativeClientMessageId === "string" ? narrativeClientMessageId : null);
    if (clientMessageId) {
      for (const message of narrative) {
        if (typeof message._clientMessageId !== "string") message._clientMessageId = clientMessageId;
      }
    }
    const process = header.logicalCount > 1
      ? [directTapeProcessRow(anchor, { ...header, clientMessageId: clientMessageId ?? null })]
      : [];
    return [...process, ...narrative];
  });

  if (exact || engineContext) {
    // Apply exact continuation Bash tails to their real tool records without
    // deleting the immutable runtime rows themselves.
    const topLevelTools = new Map<string, MessageLike>();
    const childTools = new Map<string, Record<string, unknown>>();
    const indexChildren = (blocks: unknown): void => {
      if (!Array.isArray(blocks)) return;
      for (const raw of blocks) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const block = raw as Record<string, unknown>;
        if (block.kind === "tool_use" && typeof block.blockId === "string") {
          childTools.set(block.blockId, block);
        }
        indexChildren(block.childBlocks);
      }
    };
    for (const message of hydrated) {
      if (message.role === "tool" && typeof message.blockId === "string") {
        topLevelTools.set(message.blockId, message);
      }
      indexChildren(message.childBlocks);
    }
    for (const message of hydrated) {
      if (message.role !== "runtime-event") continue;
      const event = message._runtimeEvent;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const raw = event as Record<string, unknown>;
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
  return hydrated;
}

type FiniteModelContextState = {
  remainingTokens: number;
  stopped: boolean;
  newestFirst: MessageLike[];
};

type FiniteModelRecord = {
  id: string;
  role: string;
  tokenEstimate: number;
  ts?: number;
  clientMessageId?: string;
  seq?: number;
  orderSeq?: number;
};

type FiniteTapeModelRow = {
  physical_ordinal: number;
  logical_ordinal: number;
  msg_id: string;
  role: string;
  token_estimate: number;
  ts: string | null;
  client_message_id: string | null;
  /** Present only while the one physical predecessor record is already in memory. */
  semantic_text?: string;
};

type PredecessorPhysicalHead = {
  ordinal: number;
  msg_id: string;
  role: string;
  content_sha256: string;
  payload_bytes: string;
  model_sidecar_complete: boolean;
};

const PREDECESSOR_MODEL_PHYSICAL_PAGE_ROWS = 512;
const PREDECESSOR_MODEL_RAW_PAGE_BYTES = 8 * 1024 * 1024;
const PREDECESSOR_MODEL_CANDIDATE_ROLES = new Set([
  "user",
  "assistant",
  "tool",
  "plan",
  "goal",
  "agent-group",
  "error",
  // Most runtime events have no model semantics, but exact Bash-tail events
  // do. They remain candidates and are decoded in bounded raw-byte pages.
  "runtime-event",
]);

async function readStoredPhysicalModelRows(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  physicalOrdinals: number[],
): Promise<FiniteTapeModelRow[]> {
  if (physicalOrdinals.length === 0) return [];
  return (
    await pool.query<FiniteTapeModelRow>(
      `SELECT physical_ordinal,logical_ordinal,msg_id,role,token_estimate,
              ts::text,client_message_id
         FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND physical_ordinal=ANY($4::integer[])
        ORDER BY physical_ordinal DESC,logical_ordinal DESC`,
      [sessionId, userId, tapeId, physicalOrdinals],
    )
  ).rows;
}

/**
 * Pre-0176 tapes have no model sidecar. Materialize one bounded raw-byte page,
 * batch-persist every deterministic logical semantic row, then publish all
 * per-record completion markers together. This keeps both memory and PG
 * round-trips proportional to pages, not to a 16k-record tape.
 */
async function readOrBackfillPhysicalModelPage(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  heads: PredecessorPhysicalHead[],
): Promise<Map<number, FiniteTapeModelRow[]>> {
  if (heads.length === 0) return new Map();
  const requestedOrdinals = heads.map((head) => head.ordinal);
  const sources = (
    await pool.query<{
      msg_id: string;
      ordinal: number;
      role: string;
      content_sha256: string;
      payload: Buffer;
    }>(
      `SELECT msg_id,ordinal,role,content_sha256,payload
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND ordinal=ANY($4::integer[])
          AND model_sidecar_complete=FALSE`,
      [sessionId, userId, tapeId, requestedOrdinals],
    )
  ).rows;
  const headsByOrdinal = new Map(heads.map((head) => [head.ordinal, head]));
  const derived: FiniteTapeModelRow[] = [];
  for (const source of sources) {
    const head = headsByOrdinal.get(source.ordinal);
    if (
      !head || source.msg_id !== head.msg_id || source.role !== head.role ||
      source.content_sha256 !== head.content_sha256 ||
      Buffer.from(source.payload).length !== bigIntNum(head.payload_bytes, "model tape payload bytes")
    ) {
      throw new Error(`[pgSessions] model tape metadata mismatch: ${tapeId}\0${source.ordinal}`);
    }
    const visible = userVisiblePhysicalPayload({
      tape_id: tapeId,
      tape_sha256: tapeSha256,
      waive_reason: null,
      waiver_applied: false,
      msg_id: source.msg_id,
      ordinal: source.ordinal,
      role: source.role,
      content_sha256: source.content_sha256,
      payload: Buffer.from(source.payload),
      cost_credits: "0",
      delegate_costs: [],
    }, tapeSha256, billingAnchorId);
    if (!visible) {
      throw new Error(`[pgSessions] model tape record is not a JSON object: ${tapeId}\0${source.ordinal}`);
    }
    for (const record of visible.modelRecords) {
      derived.push({
        physical_ordinal: source.ordinal,
        logical_ordinal: record.logicalOrdinal,
        msg_id: record.msgId === `logical-${record.logicalOrdinal}`
          ? `${source.msg_id}:logical-${record.logicalOrdinal}`
          : record.msgId,
        role: record.role,
        token_estimate: record.tokenEstimate,
        ts: record.ts === null ? null : String(record.ts),
        client_message_id: record.clientMessageId,
        semantic_text: record.semanticText,
      });
    }
  }
  if (derived.length > 0) {
    await pool.query(
      `INSERT INTO client_session_turn_tape_model_records
         (session_id,user_id,tape_id,physical_ordinal,logical_ordinal,msg_id,role,
          semantic_text,token_estimate,ts,client_message_id)
       SELECT $1,$2,$3,model_row.physical_ordinal,model_row.logical_ordinal,
              model_row.msg_id,model_row.role,model_row.semantic_text,
              model_row.token_estimate,model_row.ts,model_row.client_message_id
         FROM unnest(
           $4::integer[],$5::integer[],$6::text[],$7::text[],$8::text[],
           $9::integer[],$10::bigint[],$11::text[]
         ) AS model_row(
           physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
           token_estimate,ts,client_message_id
         )
       ON CONFLICT (session_id,user_id,tape_id,physical_ordinal,logical_ordinal) DO NOTHING`,
      [
        sessionId,
        userId,
        tapeId,
        derived.map((row) => row.physical_ordinal),
        derived.map((row) => row.logical_ordinal),
        derived.map((row) => row.msg_id),
        derived.map((row) => row.role),
        derived.map((row) => row.semantic_text!),
        derived.map((row) => row.token_estimate),
        derived.map((row) => row.ts),
        derived.map((row) => row.client_message_id),
      ],
    );
  }
  const sourceOrdinals = sources.map((source) => source.ordinal);
  const stored = (
    await pool.query<FiniteTapeModelRow & { semantic_text: string }>(
      `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,token_estimate,
              ts::text,client_message_id
         FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          AND physical_ordinal=ANY($4::integer[])
        ORDER BY physical_ordinal,logical_ordinal`,
      [sessionId, userId, tapeId, sourceOrdinals],
    )
  ).rows;
  const expected = [...derived].sort((a, b) =>
    a.physical_ordinal - b.physical_ordinal || a.logical_ordinal - b.logical_ordinal);
  if (
    stored.length !== expected.length ||
    stored.some((actual, index) => {
      const wanted = expected[index]!;
      return actual.physical_ordinal !== wanted.physical_ordinal ||
        actual.logical_ordinal !== wanted.logical_ordinal ||
        actual.msg_id !== wanted.msg_id ||
        actual.role !== wanted.role ||
        actual.semantic_text !== wanted.semantic_text ||
        actual.token_estimate !== wanted.token_estimate ||
        actual.ts !== wanted.ts ||
        actual.client_message_id !== wanted.client_message_id;
    })
  ) {
    throw new Error(`[pgSessions] immutable model sidecar conflict: ${tapeId}`);
  }
  if (sourceOrdinals.length > 0) await pool.query(
    `UPDATE client_session_turn_tape_records
        SET model_sidecar_complete=TRUE
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        AND ordinal=ANY($4::integer[])`,
    [sessionId, userId, tapeId, sourceOrdinals],
  );

  const racedOrdinals = requestedOrdinals.filter((ordinal) => !sourceOrdinals.includes(ordinal));
  if (racedOrdinals.length > 0) {
    const completed = (
      await pool.query<{ ordinal: number }>(
        `SELECT ordinal FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            AND ordinal=ANY($4::integer[]) AND model_sidecar_complete=TRUE`,
        [sessionId, userId, tapeId, racedOrdinals],
      )
    ).rows;
    if (completed.length !== racedOrdinals.length) {
      throw new Error(`[pgSessions] model tape record missing: ${tapeId}`);
    }
  }
  const racedRows = await readStoredPhysicalModelRows(
    pool,
    sessionId,
    userId,
    tapeId,
    racedOrdinals,
  );
  const rows = [...derived, ...racedRows].sort((a, b) =>
    b.physical_ordinal - a.physical_ordinal || b.logical_ordinal - a.logical_ordinal);
  const byPhysical = new Map<number, FiniteTapeModelRow[]>();
  for (const row of rows) {
    const list = byPhysical.get(row.physical_ordinal) ?? [];
    list.push(row);
    byPhysical.set(row.physical_ordinal, list);
  }
  return byPhysical;
}

async function appendFiniteModelRecord(
  state: FiniteModelContextState,
  record: FiniteModelRecord,
  loadFullText: () => Promise<string>,
  loadSuffixText: (maxCharacters: number) => Promise<string>,
): Promise<void> {
  if (state.stopped) return;
  const push = (text: string): void => {
    state.newestFirst.push({
      id: record.id,
      role: record.role,
      text,
      ...(record.ts !== undefined ? { ts: record.ts } : {}),
      ...(record.clientMessageId ? { _clientMessageId: record.clientMessageId } : {}),
      ...(record.seq !== undefined ? { _seq: record.seq } : {}),
      ...(record.orderSeq !== undefined ? { _orderSeq: record.orderSeq } : {}),
    });
  };
  // Five shared-estimator tokens become 20 bytes under the CCB/Codex
  // byte-worst selector, covering the longest role label plus its separator.
  const rowTokens = record.tokenEstimate + 5;
  if (rowTokens <= state.remainingTokens) {
    const text = sanitizePersistedModelHistoryText(await loadFullText());
    const exactTokens = estimateModelHistoryTokens(text) + 5;
    if (exactTokens <= state.remainingTokens) {
      push(text);
      state.remainingTokens -= exactTokens;
      return;
    }
    // A nullable rolling-predecessor estimate may be conservative/imprecise.
    // The loaded value is still bounded by that estimate; select its exact
    // suffix rather than overfilling the provider request.
    const suffixBudget = Math.max(
      0,
      state.remainingTokens - estimateModelHistoryTokens(MODEL_HISTORY_EXACT_SUFFIX_MARKER) - 5,
    );
    if (state.remainingTokens > 64 && suffixBudget > 0) {
      const suffix = exactModelHistoryTextSuffix(text, suffixBudget);
      if (suffix) push(MODEL_HISTORY_EXACT_SUFFIX_MARKER + suffix);
    }
    state.stopped = true;
    return;
  }
  const suffixBudget = Math.max(
    0,
    state.remainingTokens - estimateModelHistoryTokens(MODEL_HISTORY_EXACT_SUFFIX_MARKER) - 5,
  );
  if (state.remainingTokens > 64 && suffixBudget > 0) {
    // Four UTF-16/code-point characters per token is the largest possible
    // exact suffix under the shared estimator (ASCII case). PostgreSQL right()
    // therefore bounds the value before it enters Node memory.
    const bounded = sanitizePersistedModelHistoryText(
      await loadSuffixText(Math.min(2_000_000_000, suffixBudget * 4)),
    );
    const suffix = exactModelHistoryTextSuffix(bounded, suffixBudget);
    if (suffix) push(MODEL_HISTORY_EXACT_SUFFIX_MARKER + suffix);
  }
  state.stopped = true;
}

async function computeFiniteEngineContextMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
  hot: MessageLike[],
  contextWindow: number,
  options: EngineContextReadOptions,
): Promise<MessageLike[]> {
  const state: FiniteModelContextState = {
    // CCB and Codex rebuild history as one synthetic user message. Its stored token
    // estimate is intentionally approximate (ASCII chars / 4), which can
    // undercount dense code/JSON by up to 4x and make recovery loop forever on
    // contextWindowExceeded. Charge the current user message by UTF-8 bytes,
    // then budget stored history at its byte-level worst case. The complete
    // tape remains stored and older records stay retrievable.
    remainingTokens: Math.floor(
      Math.max(
        0,
        contextWindow - modelHistoryReservedTokens(options.engine) -
          estimateModelHistoryUtf8Bytes(options.currentUserText ?? ""),
      ) / (options.engine === "ccb" || options.engine === "codex" || options.engine === "grok" ? 4 : 1),
    ),
    stopped: false,
    newestFirst: [],
  };
  const processedCompleteTapes = new Set<string>();

  const excluded = (id: string, clientMessageId?: string): boolean =>
    !!options.excludeClientMessageId &&
    (id === options.excludeClientMessageId || clientMessageId === options.excludeClientMessageId);

  const processDeferredUser = async (message: MessageLike): Promise<void> => {
    const id = message.id as string;
    const clientMessageId = typeof message._clientMessageId === "string"
      ? message._clientMessageId
      : undefined;
    if (excluded(id, clientMessageId)) return;
    const meta = (
      await pool.query<{
        model_token_estimate: number | null;
        character_count: string;
      }>(
        `SELECT model_token_estimate, length(text_payload)::text AS character_count
           FROM client_session_user_payloads
          WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
        [sessionId, userId, id],
      )
    ).rows[0];
    if (!meta) throw new Error(`[pgSessions] deferred user payload missing: ${sessionId}\0${id}`);
    // The table is introduced in this release, so normal rows always carry the
    // exact shared estimate. length() is a safe rolling compatibility upper
    // bound (one token per code point), never an excuse to read the whole text.
    const tokenEstimate = meta.model_token_estimate ??
      bigIntNum(meta.character_count, "deferred user character count");
    await appendFiniteModelRecord(
      state,
      {
        id,
        role: "user",
        tokenEstimate,
        ...(typeof message.ts === "number" ? { ts: message.ts } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(typeof message._seq === "number" ? { seq: message._seq } : {}),
        ...(typeof message._orderSeq === "number" ? { orderSeq: message._orderSeq } : {}),
      },
      async () => {
        const row = (
          await pool.query<{ text_payload: string }>(
            `SELECT text_payload FROM client_session_user_payloads
              WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
            [sessionId, userId, id],
          )
        ).rows[0];
        if (!row) throw new Error(`[pgSessions] deferred user payload missing: ${sessionId}\0${id}`);
        return row.text_payload;
      },
      async (maxCharacters) => {
        const row = (
          await pool.query<{ text_payload: string }>(
            `SELECT right(text_payload,$4::integer) AS text_payload
               FROM client_session_user_payloads
              WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
            [sessionId, userId, id, maxCharacters],
          )
        ).rows[0];
        if (!row) throw new Error(`[pgSessions] deferred user payload missing: ${sessionId}\0${id}`);
        return row.text_payload;
      },
    );
  };

  const processCompleteTape = async (anchor: MessageLike): Promise<boolean> => {
    const tapeId = anchor._turnTapeId as string;
    if (processedCompleteTapes.has(tapeId)) return true;
    processedCompleteTapes.add(tapeId);
    const meta = (
      await pool.query<{
        tape_sha256: string;
        billing_anchor_id: string | null;
        model_record_count: number;
        materialization_status: string | null;
        finalized_at: string | null;
      }>(
        `SELECT tape_sha256,model_record_count,billing_anchor_id,
                materialization_status, finalized_at::text
           FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            AND (visible_at IS NOT NULL OR finalized_at IS NOT NULL)
            AND billing_anchor_id IS NOT NULL`,
        [sessionId, userId, tapeId],
      )
    ).rows[0];
    if (!meta) throw new Error(`[pgSessions] finalized lossless turn tape missing: ${tapeId}`);
    if (!recordsPublished({
      materializationStatus: meta.materialization_status,
      finalizedAt: meta.finalized_at,
    })) {
      processedCompleteTapes.delete(tapeId);
      return false;
    }
    if (meta.tape_sha256 !== anchor._turnTapeSha256) {
      throw new Error(`[pgSessions] lossless turn tape aggregate hash mismatch: ${tapeId}`);
    }
    if (meta.model_record_count === 0) return true;
    const appendTapeModelRow = async (row: FiniteTapeModelRow): Promise<void> => {
      if (excluded(row.msg_id, row.client_message_id ?? undefined)) return;
      const keyParams = [
        sessionId,
        userId,
        tapeId,
        row.physical_ordinal,
        row.logical_ordinal,
      ];
      await appendFiniteModelRecord(
        state,
        {
          id: row.msg_id,
          role: row.role,
          tokenEstimate: row.token_estimate,
          ...(row.ts === null ? {} : { ts: bigIntNum(row.ts, "model record ts") }),
          ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
          ...(typeof anchor._seq === "number" ? { seq: anchor._seq } : {}),
          ...(typeof anchor._orderSeq === "number" ? { orderSeq: anchor._orderSeq } : {}),
        },
        async () => {
          if (row.semantic_text !== undefined) return row.semantic_text;
          const full = (
            await pool.query<{ semantic_text: string }>(
              `SELECT semantic_text FROM client_session_turn_tape_model_records
                WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                  AND physical_ordinal=$4 AND logical_ordinal=$5`,
              keyParams,
            )
          ).rows[0];
          if (!full) throw new Error(`[pgSessions] model tape record missing: ${tapeId}`);
          return full.semantic_text;
        },
        async (maxCharacters) => {
          if (row.semantic_text !== undefined) return row.semantic_text.slice(-maxCharacters);
          const suffix = (
            await pool.query<{ semantic_text: string }>(
              `SELECT right(semantic_text,$6::integer) AS semantic_text
                 FROM client_session_turn_tape_model_records
                WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                  AND physical_ordinal=$4 AND logical_ordinal=$5`,
              [...keyParams, maxCharacters],
            )
          ).rows[0];
          if (!suffix) throw new Error(`[pgSessions] model tape record missing: ${tapeId}`);
          return suffix.semantic_text;
        },
      );
    };
    if (meta.model_record_count < 0) {
      let beforeOrdinal: number | null = null;
      let fullyVisited = false;
      while (!state.stopped) {
        const physical: PredecessorPhysicalHead[] = (
          await pool.query<PredecessorPhysicalHead>(
            `SELECT ordinal,msg_id,role,content_sha256,
                    octet_length(payload)::text AS payload_bytes,
                    model_sidecar_complete
               FROM client_session_turn_tape_records
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                AND ($4::integer IS NULL OR ordinal < $4)
              ORDER BY ordinal DESC
              LIMIT ${PREDECESSOR_MODEL_PHYSICAL_PAGE_ROWS}`,
            [sessionId, userId, tapeId, beforeOrdinal],
          )
        ).rows;
        if (physical.length === 0) {
          fullyVisited = true;
          break;
        }
        const deterministicEmpty = physical.filter((head) =>
          !head.model_sidecar_complete && !PREDECESSOR_MODEL_CANDIDATE_ROLES.has(head.role));
        if (deterministicEmpty.length > 0) {
          await pool.query(
            `UPDATE client_session_turn_tape_records
                SET model_sidecar_complete=TRUE
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                AND ordinal=ANY($4::integer[]) AND model_sidecar_complete=FALSE`,
            [sessionId, userId, tapeId, deterministicEmpty.map((head) => head.ordinal)],
          );
        }
        const completedRows = await readStoredPhysicalModelRows(
          pool,
          sessionId,
          userId,
          tapeId,
          physical
            .filter((head) =>
              head.model_sidecar_complete && PREDECESSOR_MODEL_CANDIDATE_ROLES.has(head.role))
            .map((head) => head.ordinal),
        );
        const completedByPhysical = new Map<number, FiniteTapeModelRow[]>();
        for (const row of completedRows) {
          const list = completedByPhysical.get(row.physical_ordinal) ?? [];
          list.push(row);
          completedByPhysical.set(row.physical_ordinal, list);
        }

        let index = 0;
        while (index < physical.length && !state.stopped) {
          const head = physical[index]!;
          if (!PREDECESSOR_MODEL_CANDIDATE_ROLES.has(head.role)) {
            index += 1;
            continue;
          }
          if (head.model_sidecar_complete) {
            for (const row of completedByPhysical.get(head.ordinal) ?? []) {
              await appendTapeModelRow(row);
              if (state.stopped) break;
            }
            index += 1;
            continue;
          }

          const rawPage: PredecessorPhysicalHead[] = [];
          let rawBytes = 0;
          let scan = index;
          while (scan < physical.length) {
            const candidate = physical[scan]!;
            if (!PREDECESSOR_MODEL_CANDIDATE_ROLES.has(candidate.role)) {
              scan += 1;
              continue;
            }
            if (candidate.model_sidecar_complete) break;
            const payloadBytes = bigIntNum(candidate.payload_bytes, "model tape payload bytes");
            if (
              rawPage.length > 0 &&
              rawBytes + payloadBytes > PREDECESSOR_MODEL_RAW_PAGE_BYTES
            ) break;
            rawPage.push(candidate);
            rawBytes += payloadBytes;
            scan += 1;
            if (rawBytes >= PREDECESSOR_MODEL_RAW_PAGE_BYTES) break;
          }
          const backfilled = await readOrBackfillPhysicalModelPage(
            pool,
            sessionId,
            userId,
            tapeId,
            meta.tape_sha256,
            meta.billing_anchor_id!,
            rawPage,
          );
          for (const rawHead of rawPage) {
            for (const row of backfilled.get(rawHead.ordinal) ?? []) {
              await appendTapeModelRow(row);
              if (state.stopped) break;
            }
            if (state.stopped) break;
          }
          index = scan;
        }
        if (state.stopped) break;
        beforeOrdinal = physical.at(-1)!.ordinal;
        if (physical.length < PREDECESSOR_MODEL_PHYSICAL_PAGE_ROWS) {
          fullyVisited = true;
          break;
        }
      }
      if (fullyVisited) {
        await pool.query(
          `UPDATE client_session_turn_tapes t
              SET model_record_count=(
                SELECT COUNT(*)::integer
                  FROM client_session_turn_tape_model_records m
                 WHERE m.session_id=t.session_id AND m.user_id=t.user_id AND m.tape_id=t.tape_id
              )
            WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
              AND t.model_record_count < 0
              AND NOT EXISTS (
                SELECT 1 FROM client_session_turn_tape_records r
                 WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
                   AND r.model_sidecar_complete=FALSE
              )`,
          [sessionId, userId, tapeId],
        );
      }
      return true;
    }

    let beforePhysical: number | null = null;
    let beforeLogical: number | null = null;
    let visited = 0;
    while (!state.stopped) {
      const page: FiniteTapeModelRow[] = (
        await pool.query<FiniteTapeModelRow>(
          `SELECT physical_ordinal,logical_ordinal,msg_id,role,token_estimate,
                  ts::text,client_message_id
             FROM client_session_turn_tape_model_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
              AND ($4::integer IS NULL OR
                   (physical_ordinal,logical_ordinal) < ($4::integer,$5::integer))
            ORDER BY physical_ordinal DESC,logical_ordinal DESC
            LIMIT 128`,
          [sessionId, userId, tapeId, beforePhysical, beforeLogical],
        )
      ).rows;
      if (page.length === 0) break;
      for (const row of page) {
        visited += 1;
        beforePhysical = row.physical_ordinal;
        beforeLogical = row.logical_ordinal;
        await appendTapeModelRow(row);
        if (state.stopped) return true;
      }
      if (page.length < 128) break;
    }
    if (!state.stopped && visited !== meta.model_record_count) {
      throw new Error(`[pgSessions] model tape record count mismatch: ${tapeId}`);
    }
    return true;
  };

  const processMessages = async (messages: MessageLike[]): Promise<void> => {
    for (let index = messages.length - 1; index >= 0 && !state.stopped; index--) {
      const message = messages[index]!;
      if (
        message._turnTapeComplete === true &&
        typeof message._turnTapeId === "string" &&
        typeof message._turnTapeSha256 === "string"
      ) {
        const consumed = await processCompleteTape(message);
        if (consumed) continue;
      }
      if (
        message._turnTapeComplete !== true &&
        message._turnTapeExpanded !== true &&
        typeof message._turnTapeId === "string" &&
        typeof message._turnTapeSha256 === "string"
      ) {
        const rolling = await hydrateTurnTapeMessages(pool, sessionId, userId, [message], {
          view: "timeline",
          deferTimelineNarrative: false,
          engineContext: true,
        });
        await processMessages(rolling);
        continue;
      }
      if (message._userPayloadDeferred === true && typeof message.id === "string") {
        await processDeferredUser(message);
        continue;
      }
      const role = modelHistorySemanticRole(message);
      const text = modelHistorySemanticText(message);
      const id = typeof message.id === "string" ? message.id : `inline:${index}`;
      const clientMessageId = typeof message._clientMessageId === "string"
        ? message._clientMessageId
        : undefined;
      if (!role || message.system === true || !text.trim() || excluded(id, clientMessageId)) continue;
      await appendFiniteModelRecord(
        state,
        {
          id,
          role,
          tokenEstimate: estimateModelHistoryTokens(text),
          ...(typeof message.ts === "number" ? { ts: message.ts } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(typeof message._seq === "number" ? { seq: message._seq } : {}),
          ...(typeof message._orderSeq === "number" ? { orderSeq: message._orderSeq } : {}),
        },
        async () => text,
        async (maxCharacters) => text.slice(-maxCharacters),
      );
    }
  };

  await processMessages(hot);
  let beforeLastSeq: number | null = null;
  while (!state.stopped) {
    const archiveRows = (
      await pool.query<{ messages: string; last_seq: string }>(
        `SELECT messages,last_seq FROM client_session_archive_chunks
          WHERE session_id=$1 AND user_id=$2
            AND ($3::bigint IS NULL OR last_seq < $3)
          ORDER BY last_seq DESC
          LIMIT 4`,
        [sessionId, userId, beforeLastSeq],
      )
    ).rows;
    if (archiveRows.length === 0) break;
    for (const archive of archiveRows) {
      beforeLastSeq = bigIntNum(archive.last_seq, "archive last_seq");
      let archived: MessageLike[] = [];
      try {
        const parsed = JSON.parse(archive.messages);
        if (Array.isArray(parsed)) archived = deriveArchivedOrderSeqsForRead(parsed as MessageLike[]);
      } catch {
        continue;
      }
      archived.sort(compareMessagesByOrder);
      await processMessages(archived);
      if (state.stopped) break;
    }
    if (archiveRows.length < 4) break;
  }
  return state.newestFirst.reverse();
}

async function computeEngineContextMessages(
  pool: Pool,
  sessionId: string,
  userId: string,
  options: EngineContextReadOptions = {},
): Promise<MessageLike[] | null> {
  const row = (
    await pool.query<{ messages: string; archived_through_seq: number | null }>(
      "SELECT messages, archived_through_seq FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, userId],
    )
  ).rows[0];
  if (!row) return null;
  let hot: MessageLike[] = [];
  try {
    const parsed = JSON.parse(row.messages);
    if (Array.isArray(parsed)) {
      hot = deriveOrderSeqsForRead(
        parsed as MessageLike[],
        bigIntNumOr(row.archived_through_seq, 0),
      );
    }
  } catch {
    // A malformed hot legacy row contributes no synthetic context. Valid
    // archives remain independently readable below.
  }
  hot.sort(compareMessagesByOrder);
  const contextWindow = resolveModelHistoryContextWindow(options.contextWindow, options.engine);
  if (contextWindow !== null) {
    return computeFiniteEngineContextMessages(
      pool,
      sessionId,
      userId,
      hot,
      contextWindow,
      options,
    );
  }
  const hydratePrivateContext = async (messages: MessageLike[]): Promise<MessageLike[]> => {
    const tapeHydrated = await hydrateTurnTapeMessages(pool, sessionId, userId, messages, {
      view: "timeline",
      deferTimelineNarrative: false,
      engineContext: true,
    });
    const deferredIds = tapeHydrated.flatMap((message) =>
      message._userPayloadDeferred === true && typeof message.id === "string"
        ? [message.id]
        : []);
    if (deferredIds.length === 0) return tapeHydrated;
    const payloads = (
      await pool.query<{ msg_id: string; text_payload: string }>(
        `SELECT msg_id,text_payload
           FROM client_session_user_payloads
          WHERE session_id=$1 AND user_id=$2 AND msg_id=ANY($3::text[])`,
        [sessionId, userId, deferredIds],
      )
    ).rows;
    const byId = new Map(payloads.map((row) => [row.msg_id, row.text_payload]));
    return tapeHydrated.map((message) => {
      if (message._userPayloadDeferred !== true || typeof message.id !== "string") return message;
      const text = byId.get(message.id);
      if (text === undefined) {
        throw new Error(`[pgSessions] deferred user payload missing: ${sessionId}\0${message.id}`);
      }
      return {
        id: message.id,
        role: "user",
        text,
        ts: message.ts,
        _source: "server",
        ...(typeof message._clientMessageId === "string"
          ? { _clientMessageId: message._clientMessageId }
          : {}),
        ...(typeof message._seq === "number" ? { _seq: message._seq } : {}),
        ...(typeof message._orderSeq === "number" ? { _orderSeq: message._orderSeq } : {}),
      };
    });
  };

  let selected = selectEngineContextSuffix(await hydratePrivateContext(hot), options);
  if (selected.truncated) return selected.messages;

  // Walk archive chunks newest-to-oldest in small SQL pages. As soon as the
  // selected model's actual context window is full, older chunks are never
  // parsed or hydrated and never cross the master→container wire.
  let beforeLastSeq: number | null = null;
  for (;;) {
    const archiveRows = (
      await pool.query<{ messages: string; last_seq: string }>(
        `SELECT messages, last_seq FROM client_session_archive_chunks
          WHERE session_id=$1 AND user_id=$2
            AND ($3::bigint IS NULL OR last_seq < $3)
          ORDER BY last_seq DESC
          LIMIT 4`,
        [sessionId, userId, beforeLastSeq],
      )
    ).rows;
    if (archiveRows.length === 0) break;
    for (const archive of archiveRows) {
      beforeLastSeq = bigIntNum(archive.last_seq, "archive last_seq");
      let archived: MessageLike[] = [];
      try {
        const parsed = JSON.parse(archive.messages);
        if (Array.isArray(parsed)) {
          archived = deriveArchivedOrderSeqsForRead(parsed as MessageLike[]);
        }
      } catch {
        // Match the existing archive contract: skip only the malformed chunk.
      }
      archived.sort(compareMessagesByOrder);
      const hydrated = await hydratePrivateContext(archived);
      const combined = [...hydrated, ...selected.messages];
      combined.sort(compareMessagesByOrder);
      selected = selectEngineContextSuffix(combined, options);
      if (selected.truncated) return selected.messages;
    }
    if (archiveRows.length < 4) break;
  }
  return selected.messages;
}

function containsCompletedClientTurn(messages: MessageLike[], clientMessageId: string): boolean {
  return messages.some((message) =>
    message?.role === "assistant" &&
    message._clientMessageId === clientMessageId &&
    message.status === "completed" &&
    message._errorCode === undefined &&
    message._isError !== true,
  );
}

async function hasCompletedClientTurnImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  clientMessageId: string,
): Promise<boolean> {
  const tape = (
    await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND client_message_id=$3
            AND status='completed' AND (visible_at IS NOT NULL OR finalized_at IS NOT NULL)
       ) AS present`,
      [sessionId, userId, clientMessageId],
    )
  ).rows[0];
  if (tape?.present === true) return true;

  // Compatibility for completed pre-tape rows. Keep this predicate in the DB
  // backend so a retry never transports the whole session through the bridge.
  const session = (
    await pool.query<{ messages: string }>(
      `SELECT messages FROM client_sessions
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [sessionId, userId],
    )
  ).rows[0];
  if (!session) return false;
  let hotContainsClientMessage = false;
  try {
    const parsed = JSON.parse(session.messages);
    if (Array.isArray(parsed)) {
      const hot = parsed as MessageLike[];
      if (containsCompletedClientTurn(hot, clientMessageId)) return true;
      hotContainsClientMessage = hot.some((message) =>
        message?.id === clientMessageId || message?._clientMessageId === clientMessageId,
      );
    }
  } catch { /* continue through valid archive chunks */ }
  // Archive spill is a frozen prefix. If this user/client id is still in the
  // hot suffix, a later completed assistant cannot be in an older chunk.
  if (hotContainsClientMessage) return false;
  const archivedId = (
    await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM client_session_archived_ids
          WHERE session_id=$1 AND msg_id=$2
       ) AS present`,
      [sessionId, clientMessageId],
    )
  ).rows[0];
  if (archivedId?.present !== true) return false;

  let beforeLastSeq: number | null = null;
  for (;;) {
    const chunks = (
      await pool.query<{ messages: string; last_seq: string }>(
        `SELECT messages, last_seq FROM client_session_archive_chunks
          WHERE session_id=$1 AND user_id=$2
            AND ($3::bigint IS NULL OR last_seq < $3)
          ORDER BY last_seq DESC LIMIT 8`,
        [sessionId, userId, beforeLastSeq],
      )
    ).rows;
    if (chunks.length === 0) return false;
    for (const chunk of chunks) {
      beforeLastSeq = bigIntNum(chunk.last_seq, "archive last_seq");
      try {
        const parsed = JSON.parse(chunk.messages);
        if (Array.isArray(parsed) && containsCompletedClientTurn(parsed as MessageLike[], clientMessageId)) {
          return true;
        }
      } catch { /* continue */ }
    }
    if (chunks.length < 8) return false;
  }
}

function deferredTapeRecord(
  tapeId: string,
  tapeSha256: string,
  head: { msg_id: string; ordinal: number; role: string; ts: string; content_sha256?: string },
  payloadBytes: number,
): MessageLike {
  return {
    id: head.msg_id,
    role: head.role,
    text: "",
    ts: bigIntNum(head.ts, "turn tape record ts"),
    _source: "server",
    _turnTapeId: tapeId,
    _turnTapeMsgId: head.msg_id,
    _turnTapeOrdinal: head.ordinal,
    _turnTapeSha256: tapeSha256,
    _turnTapeComplete: true,
    _recordOrdinal: head.ordinal,
    _payloadDeferred: true,
    _payloadBytes: payloadBytes,
    ...(head.content_sha256 ? { _payloadSha256: head.content_sha256 } : {}),
  };
}

type DirectTapePageHead = {
  msg_id: string;
  ordinal: number;
  role: string;
  ts: string;
  content_sha256: string;
  payload_bytes: string;
  visible_content_sha256: string | null;
};

/** Hydrate a selected physical page without changing its paging direction.
 * The returned logical rows are always in ascending immutable ordinal order. */
async function hydrateDirectTapePage(
  pool: Pool | PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
  tapeSha256: string,
  billingAnchorId: string,
  heads: DirectTapePageHead[],
): Promise<MessageLike[]> {
  const deferred = heads.filter((head) =>
    bigIntNum(head.payload_bytes, "turn tape record payload bytes") > TAPE_RECORD_INLINE_QUANTUM_BYTES);
  const planned = heads.filter((head) =>
    bigIntNum(head.payload_bytes, "turn tape record payload bytes") <= TAPE_RECORD_INLINE_QUANTUM_BYTES);
  const records: MessageLike[] = deferred.map((head) => deferredTapeRecord(
    tapeId,
    tapeSha256,
    { ...head, content_sha256: head.visible_content_sha256 ?? undefined },
    bigIntNum(head.payload_bytes, "turn tape record payload bytes"),
  ));

  if (planned.length > 0) {
    const payloadRows = (
      await pool.query<DirectTapeSourceRecord>(
        `SELECT msg_id, ordinal, role, content_sha256, payload,
                visible_payload, visible_content_sha256
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=ANY($4::int[])
          ORDER BY ordinal`,
        [sessionId, userId, tapeId, planned.map((head) => head.ordinal)],
      )
    ).rows;
    const payloadByOrdinal = new Map(payloadRows.map((row) => [row.ordinal, row]));
    for (const head of planned) {
      const source = payloadByOrdinal.get(head.ordinal);
      if (!source) throw new Error(`[pgSessions] direct tape record missing: ${tapeId}\0${head.ordinal}`);
      let bytes: Buffer;
      if (source.visible_payload !== null) {
        bytes = Buffer.from(source.visible_payload);
        if (sha256Bytes(bytes) !== source.visible_content_sha256) {
          throw new Error(`[pgSessions] visible tape payload hash mismatch: ${tapeId}\0${head.ordinal}`);
        }
      } else {
        const visible = userVisiblePhysicalPayload({
          tape_id: tapeId,
          tape_sha256: tapeSha256,
          waive_reason: null,
          waiver_applied: false,
          msg_id: source.msg_id,
          ordinal: source.ordinal,
          role: source.role,
          content_sha256: source.content_sha256,
          payload: Buffer.from(source.payload),
          cost_credits: "0",
          delegate_costs: [],
        }, tapeSha256, billingAnchorId);
        if (!visible) {
          throw new Error(`[pgSessions] direct tape record is not a JSON object: ${tapeId}\0${head.ordinal}`);
        }
        bytes = visible.bytes;
      }
      const message = JSON.parse(bytes.toString("utf8")) as MessageLike;
      const expanded = expandHydratedRuntimeBatch(
        message,
        {
          tape_id: tapeId,
          tape_sha256: tapeSha256,
          waive_reason: null,
          waiver_applied: false,
          msg_id: source.msg_id,
          ordinal: source.ordinal,
          role: source.role,
          content_sha256: source.content_sha256,
          payload: source.payload,
          cost_credits: "0",
          delegate_costs: [],
        },
        { id: billingAnchorId, _turnTapeSha256: tapeSha256 },
      ).messages;
      for (const logical of expanded) {
        logical._recordOrdinal = head.ordinal;
        records.push(logical);
      }
    }
  }

  records.sort((a, b) =>
    (typeof a._recordOrdinal === "number" ? a._recordOrdinal : Number.MAX_SAFE_INTEGER) -
    (typeof b._recordOrdinal === "number" ? b._recordOrdinal : Number.MAX_SAFE_INTEGER));
  return records;
}

type UnifiedTimelineTapeHeader = {
  tapeId: string;
  tapeSha256: string;
  billingAnchorId: string;
  status: string;
  turnKey: string;
  clientMessageId: string | null;
  materializationStatus: string | null;
  finalizedAt: string | null;
  visibleHead: VisibleHead | null;
};

type UnifiedTimelineTapeHead = DirectTapePageHead & {
  tape_id: string;
};

type UnifiedTimelineSelectedUnit =
  | {
      kind: "outer";
      anchor: MessageLike;
      orderSeq: number;
    }
  | {
      kind: "tape";
      anchor: MessageLike;
      orderSeq: number;
      header: UnifiedTimelineTapeHeader;
      head: UnifiedTimelineTapeHead;
    }
  | {
      kind: "tape-fallback";
      anchor: MessageLike;
      orderSeq: number;
      header: UnifiedTimelineTapeHeader | null;
      reason: TapeDisplayDegradeReason;
    };

type UnifiedTimelineStatusRow = {
  dispatch_id: string;
  client_message_id: string;
  failure_code: string | null;
  anchor_seq: string;
  terminal_at: Date | null;
};

type UnifiedTimelineTapeWindow = {
  anchor: MessageLike;
  orderSeq: number;
  header: UnifiedTimelineTapeHeader;
  /** Exact half-open physical interval consumed by this browser page. */
  lowerOrdinal: number;
  upperOrdinal: number;
};

function timelineOuterKey(message: MessageLike, orderSeq: number): string {
  return `outer:${orderSeq}:${typeof message.id === "string" ? message.id : "anonymous"}`;
}

function timelineTapeKey(tapeId: string, ordinal: number, logicalIndex: number, id: unknown): string {
  return `tape:${tapeId}:${ordinal}:${logicalIndex}:${typeof id === "string" ? id : "anonymous"}`;
}

/** Read enough durable outer anchors to cover one logical browser page.
 * Archive chunks are walked newest-first. The caller expands `maxCandidates`
 * inside the same repeatable-read snapshot when transport-only tapes hide the
 * next semantic record; no projection or fabricated replacement is used. */
async function readUnifiedTimelineOuterCandidates(
  client: PoolClient,
  sessionId: string,
  userId: string,
  hotJson: string,
  archivedThroughSeq: number,
  cursor: ClientTimelineCursor | null,
  maxCandidates: number,
): Promise<{ messages: MessageLike[]; snapshotMaxSeq: number; hasOlderCandidates: boolean }> {
  let hot: MessageLike[] = [];
  try {
    const parsed = JSON.parse(hotJson);
    if (Array.isArray(parsed)) {
      hot = deriveOrderSeqsForRead(parsed as MessageLike[], archivedThroughSeq);
    }
  } catch {
    throw new Error(`[pgSessions] unified timeline hot row malformed: ${sessionId}`);
  }
  let snapshotMaxSeq = 0;
  for (const message of hot) {
    if (
      typeof message._seq === "number" && Number.isSafeInteger(message._seq) &&
      message._seq > snapshotMaxSeq
    ) snapshotMaxSeq = message._seq;
  }
  // Old rows can have no `_seq`; the archive watermark is a conservative
  // compatibility fallback, never a fabricated next_seq-derived snapshot.
  if (snapshotMaxSeq === 0) snapshotMaxSeq = archivedThroughSeq;

  const beforeOrderSeq = cursor?.beforeOrderSeq ?? Number.MAX_SAFE_INTEGER;
  const resumeTape = typeof cursor?.tapeId === "string";
  const eligible = (message: MessageLike): boolean => {
    const orderSeq = message._orderSeq;
    if (
      typeof orderSeq !== "number" || !Number.isSafeInteger(orderSeq) || orderSeq < 1 ||
      message._turnTapeProcess === true
    ) return false;
    return orderSeq < beforeOrderSeq || (resumeTape && orderSeq === beforeOrderSeq);
  };
  const deduped = new Map<string, MessageLike>();
  const addEligible = (message: MessageLike): void => {
    if (!eligible(message)) return;
    const orderSeq = message._orderSeq as number;
    const key = timelineOuterKey(message, orderSeq);
    if (!deduped.has(key)) deduped.set(key, message);
  };
  for (const message of hot) addEligible(message);
  let beforeLastSeq: number | null = null;
  let archiveExhausted = archivedThroughSeq <= 0;
  const archiveBefore = Math.min(Number.MAX_SAFE_INTEGER, beforeOrderSeq + (resumeTape ? 1 : 0));
  while (deduped.size <= maxCandidates && !archiveExhausted) {
    const chunks = (
      await client.query<{ messages: string; last_seq: string }>(
        `SELECT messages,last_seq::text
           FROM client_session_archive_chunks
          WHERE session_id=$1 AND user_id=$2 AND first_seq < $3::bigint
            AND ($4::bigint IS NULL OR last_seq < $4)
          ORDER BY last_seq DESC
          LIMIT 4`,
        [sessionId, userId, archiveBefore, beforeLastSeq],
      )
    ).rows;
    if (chunks.length === 0) {
      archiveExhausted = true;
      break;
    }
    for (const chunk of chunks) {
      beforeLastSeq = bigIntNum(chunk.last_seq, "archive last_seq");
      try {
        const parsed = JSON.parse(chunk.messages);
        if (Array.isArray(parsed)) {
          for (const message of deriveArchivedOrderSeqsForRead(parsed as MessageLike[])) {
            addEligible(message);
          }
        }
      } catch {
        // Match the existing archive contract: one malformed immutable chunk
        // does not authorize fabricated replacement content.
      }
      if (deduped.size > maxCandidates) break;
    }
    if (chunks.length < 4) archiveExhausted = true;
    if (deduped.size > maxCandidates) break;
  }

  const ordered = [...deduped.values()].sort(compareMessagesByOrder);
  return {
    messages: ordered.slice(-maxCandidates).reverse(),
    snapshotMaxSeq,
    hasOlderCandidates: deduped.size > maxCandidates || !archiveExhausted,
  };
}

async function readUnifiedTimelineTapeHeaders(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeIds: string[],
): Promise<Map<string, UnifiedTimelineTapeHeader>> {
  if (tapeIds.length === 0) return new Map();
  const rows = (
    await client.query<{
      tape_id: string;
      tape_sha256: string;
      billing_anchor_id: string;
      status: string;
      turn_key: string;
      client_message_id: string | null;
    }>(
      `SELECT t.tape_id,t.tape_sha256,t.billing_anchor_id,t.status,t.turn_key,
              COALESCE(t.client_message_id,d.client_message_id) AS client_message_id,
              t.materialization_status, t.finalized_at::text, t.visible_head
         FROM client_session_turn_tapes t
         LEFT JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
        WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=ANY($3::text[])
          AND (t.visible_at IS NOT NULL OR t.finalized_at IS NOT NULL)
          AND t.billing_anchor_id IS NOT NULL`,
      [sessionId, userId, tapeIds],
    )
  ).rows;
  return new Map(rows.map((row) => [row.tape_id, {
    tapeId: row.tape_id,
    tapeSha256: row.tape_sha256,
    billingAnchorId: row.billing_anchor_id,
    status: row.status,
    turnKey: row.turn_key,
    clientMessageId: row.client_message_id,
    materializationStatus: (row as { materialization_status?: string | null }).materialization_status ?? null,
    finalizedAt: (row as { finalized_at?: string | null }).finalized_at ?? null,
    visibleHead: ((row as { visible_head?: VisibleHead | null }).visible_head ?? null),
  }]));
}

async function readUnifiedTimelineTapeHeads(
  client: PoolClient,
  sessionId: string,
  userId: string,
  requests: Array<{ tapeId: string; beforeOrdinal: number }>,
  perTapeLimit: number,
): Promise<Map<string, UnifiedTimelineTapeHead[]>> {
  if (requests.length === 0) return new Map();
  const rows = (
    await client.query<UnifiedTimelineTapeHead>(
      `WITH requested(tape_id,before_ordinal) AS (
         SELECT * FROM unnest($3::text[],$4::integer[])
       )
       SELECT requested.tape_id,r.msg_id,r.ordinal,r.role,r.ts::text,
              r.content_sha256,
              COALESCE(octet_length(r.visible_payload),octet_length(r.payload))::text AS payload_bytes,
              r.visible_content_sha256
         FROM requested
         JOIN LATERAL (
           SELECT msg_id,ordinal,role,ts,content_sha256,payload,visible_payload,
                  visible_content_sha256
             FROM client_session_turn_tape_records r
            WHERE r.session_id=$1 AND r.user_id=$2 AND r.tape_id=requested.tape_id
              AND r.ordinal < requested.before_ordinal
              AND r.role <> 'runtime-event'
              -- SessionManager persists every retry attempt. Once any later
              -- assistant result exists, the earlier provider API error is
              -- audit evidence rather than a browser conversation record.
              -- This keeps exactly the terminal API error when all attempts
              -- fail, while a later successful result still hides all errors.
              AND NOT (
                r.role='assistant'
                AND EXISTS (
                  SELECT 1 FROM client_session_turn_tape_model_records failed
                   WHERE failed.session_id=r.session_id AND failed.user_id=r.user_id
                     AND failed.tape_id=r.tape_id AND failed.physical_ordinal=r.ordinal
                     AND failed.role='assistant' AND failed.semantic_text LIKE 'API Error:%'
                )
                AND EXISTS (
                  SELECT 1 FROM client_session_turn_tape_model_records recovered
                   WHERE recovered.session_id=r.session_id AND recovered.user_id=r.user_id
                     AND recovered.tape_id=r.tape_id AND recovered.physical_ordinal > r.ordinal
                     AND recovered.role='assistant'
                )
              )
            ORDER BY ordinal DESC
            LIMIT $5
         ) r ON TRUE
        ORDER BY requested.tape_id,r.ordinal DESC`,
      [
        sessionId,
        userId,
        requests.map((request) => request.tapeId),
        requests.map((request) => request.beforeOrdinal),
        perTapeLimit,
      ],
    )
  ).rows;
  const byTape = new Map<string, UnifiedTimelineTapeHead[]>();
  for (const row of rows) {
    const list = byTape.get(row.tape_id) ?? [];
    list.push(row);
    byTape.set(row.tape_id, list);
  }
  return byTape;
}

/** Bash stdout tails are the sole runtime envelopes that carry a user-facing
 * fact not already represented by a semantic tape row. They travel as hidden
 * exact evidence and update their owning ToolCard; every other runtime
 * envelope stays in the immutable audit tape and never consumes a browser
 * history slot. The model sidecar is only an ordinal index. UI bytes always
 * come from the SHA-verified visible payload path below. */
async function readUnifiedTimelineBashTailAuxiliaries(
  client: PoolClient,
  sessionId: string,
  userId: string,
  windows: UnifiedTimelineTapeWindow[],
  inlineBudgetBytes: number,
): Promise<MessageLike[]> {
  if (windows.length === 0) return [];
  const heads = (
    await client.query<(DirectTapePageHead & { tape_id: string })>(
      `WITH requested(tape_id,lower_ordinal,upper_ordinal) AS (
         SELECT * FROM unnest($3::text[],$4::integer[],$5::integer[])
       )
       SELECT requested.tape_id,r.msg_id,r.ordinal,r.role,r.ts::text,
              r.content_sha256,
              COALESCE(octet_length(r.visible_payload),octet_length(r.payload))::text AS payload_bytes,
              r.visible_content_sha256
         FROM requested
         JOIN client_session_turn_tape_records r
           ON r.session_id=$1 AND r.user_id=$2 AND r.tape_id=requested.tape_id
          AND r.ordinal >= requested.lower_ordinal
          AND r.ordinal < requested.upper_ordinal
        WHERE r.role='runtime-event'
          AND (
            EXISTS (
              SELECT 1 FROM client_session_turn_tape_model_records m
               WHERE m.session_id=r.session_id AND m.user_id=r.user_id
                 AND m.tape_id=r.tape_id AND m.physical_ordinal=r.ordinal
                 AND m.role='tool'
            )
            OR (
              r.model_sidecar_complete=FALSE
              AND convert_from(COALESCE(r.visible_payload,r.payload),'UTF8') LIKE '%bash_output_tail%'
            )
          )
        ORDER BY requested.tape_id,r.ordinal`,
      [
        sessionId,
        userId,
        windows.map((window) => window.header.tapeId),
        windows.map((window) => window.lowerOrdinal),
        windows.map((window) => window.upperOrdinal),
      ],
    )
  ).rows;
  const headsByTape = new Map<string, DirectTapePageHead[]>();
  for (const head of heads) {
    const list = headsByTape.get(head.tape_id) ?? [];
    list.push(head);
    headsByTape.set(head.tape_id, list);
  }

  type TailCandidate = {
    message: MessageLike;
    head: DirectTapePageHead;
    window: UnifiedTimelineTapeWindow;
    ownerTurnKey: string;
    parentToolUseId: string;
    toolUseId: string;
    totalBytes: number;
    ordinal: number;
  };
  const enrich = (
    message: MessageLike,
    head: DirectTapePageHead,
    window: UnifiedTimelineTapeWindow,
  ): MessageLike => ({
    ...message,
    _source: "server",
    _orderSeq: window.orderSeq,
    ...(typeof window.anchor._seq === "number" ? { _seq: window.anchor._seq } : {}),
    _turnTapeId: window.header.tapeId,
    _turnTapeOrdinal: head.ordinal,
    _recordOrdinal: head.ordinal,
    _turnTapeSha256: window.header.tapeSha256,
    _turnTapeComplete: true,
    _turnKey: window.header.turnKey,
    _dispatchOutcome: window.header.status,
    ...(window.header.clientMessageId && typeof message._clientMessageId !== "string"
      ? { _clientMessageId: window.header.clientMessageId }
      : {}),
    _timelineRecord: true,
    _timelineAuxiliary: "bash-tail",
    _timelineUnitKey: `aux:tail:${window.header.tapeId}:${head.ordinal}`,
  });
  const locator = (
    head: DirectTapePageHead,
    window: UnifiedTimelineTapeWindow,
  ): MessageLike => enrich(
    deferredTapeRecord(
      window.header.tapeId,
      window.header.tapeSha256,
      { ...head, content_sha256: head.visible_content_sha256 ?? undefined },
      bigIntNum(head.payload_bytes, "turn tape timeline bash-tail payload bytes"),
    ),
    head,
    window,
  );
  const candidateWins = (candidate: TailCandidate, previous: TailCandidate): boolean => {
    if (candidate.totalBytes !== previous.totalBytes) return candidate.totalBytes > previous.totalBytes;
    if (candidate.window.orderSeq !== previous.window.orderSeq) {
      return candidate.window.orderSeq > previous.window.orderSeq;
    }
    const tapeOrder = candidate.window.header.tapeId.localeCompare(previous.window.header.tapeId);
    return tapeOrder !== 0 ? tapeOrder > 0 : candidate.ordinal > previous.ordinal;
  };

  // A historical continuation can contain thousands of snapshots. Scan them
  // in bounded DB hydration quanta, but return only the deterministic winner
  // for each real tool. This is lossless state reconciliation, not a content
  // cap: every candidate participates and deferred records retain their exact
  // Range+SHA locator.
  const winners = new Map<string, TailCandidate>();
  const deferred: MessageLike[] = [];
  for (const window of windows) {
    const tapeHeads = headsByTape.get(window.header.tapeId) ?? [];
    if (tapeHeads.length === 0) continue;
    const inlineHeads: DirectTapePageHead[] = [];
    let inlineBytes = 0;
    const flush = async (): Promise<void> => {
      if (inlineHeads.length === 0) return;
      const selectedHeads = inlineHeads.splice(0);
      inlineBytes = 0;
      const hydrated = await hydrateDirectTapePage(
        client,
        sessionId,
        userId,
        window.header.tapeId,
        window.header.tapeSha256,
        window.header.billingAnchorId,
        selectedHeads,
      ).catch((error: unknown) => {
        warnTapeDisplayDegrade({
          sessionId,
          tapeId: window.header.tapeId,
          reason: classifyUnifiedTimelineIntegrityError(error),
          detail: error instanceof Error ? error.message : String(error),
        });
        return [] as MessageLike[];
      });
      const headByOrdinal = new Map(selectedHeads.map((head) => [head.ordinal, head]));
      for (const message of hydrated) {
        const ordinal = typeof message._recordOrdinal === "number" ? message._recordOrdinal : -1;
        const head = headByOrdinal.get(ordinal);
        if (!head || message._payloadDeferred === true) continue;
        const event = message._runtimeEvent;
        if (!event || typeof event !== "object" || Array.isArray(event)) continue;
        const raw = event as Record<string, unknown>;
        if (
          raw.type !== "system" || raw.subtype !== "bash_output_tail" ||
          typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0
        ) continue;
        const ownerTurnKey = typeof message._continuationOfTurnKey === "string" &&
            message._continuationOfTurnKey.length > 0
          ? message._continuationOfTurnKey
          : window.header.turnKey;
        const parentToolUseId = typeof raw.parent_tool_use_id === "string"
          ? raw.parent_tool_use_id
          : "";
        const totalBytes = typeof raw.total_bytes === "number" && Number.isFinite(raw.total_bytes)
          ? Math.max(0, raw.total_bytes)
          : 0;
        const candidate: TailCandidate = {
          message: enrich(message, head, window),
          head,
          window,
          ownerTurnKey,
          parentToolUseId,
          toolUseId: raw.tool_use_id,
          totalBytes,
          ordinal,
        };
        const key = `${ownerTurnKey}\0${parentToolUseId ? "child" : "top"}\0${raw.tool_use_id}`;
        const previous = winners.get(key);
        if (!previous || candidateWins(candidate, previous)) winners.set(key, candidate);
      }
    };
    for (const head of tapeHeads) {
      const payloadBytes = bigIntNum(head.payload_bytes, "turn tape timeline bash-tail payload bytes");
      if (payloadBytes > TAPE_RECORD_INLINE_QUANTUM_BYTES) {
        await flush();
        deferred.push(locator(head, window));
        continue;
      }
      if (
        inlineHeads.length >= TAPE_RECORD_PAGE_MAX_ROWS ||
        (inlineHeads.length > 0 && inlineBytes + payloadBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES)
      ) await flush();
      inlineHeads.push(head);
      inlineBytes += payloadBytes;
    }
    await flush();
  }

  let budget = Math.max(0, inlineBudgetBytes);
  const orderedWinners = [...winners.values()].sort((a, b) => {
    if (a.window.orderSeq !== b.window.orderSeq) return a.window.orderSeq - b.window.orderSeq;
    const tapeOrder = a.window.header.tapeId.localeCompare(b.window.header.tapeId);
    return tapeOrder !== 0 ? tapeOrder : a.ordinal - b.ordinal;
  });
  const auxiliaries = [...deferred];
  for (const winner of orderedWinners) {
    const bytes = Buffer.byteLength(JSON.stringify(winner.message), "utf8");
    if (bytes <= budget) {
      auxiliaries.push(winner.message);
      budget -= bytes;
    } else {
      auxiliaries.push(locator(winner.head, winner.window));
    }
  }
  return auxiliaries;
}

function unifiedTimelineTerminalAuxiliary(window: UnifiedTimelineTapeWindow): MessageLike {
  return {
    id: `timeline-terminal:${window.header.tapeId}`,
    role: "system",
    text: "",
    ts: typeof window.anchor.ts === "number" ? window.anchor.ts : 0,
    _source: "server",
    ...(typeof window.anchor._seq === "number" ? { _seq: window.anchor._seq } : {}),
    _orderSeq: window.orderSeq,
    _turnTapeId: window.header.tapeId,
    _turnTapeSha256: window.header.tapeSha256,
    _turnTapeComplete: true,
    _turnKey: window.header.turnKey,
    _dispatchOutcome: window.header.status,
    ...(window.header.clientMessageId ? { _clientMessageId: window.header.clientMessageId } : {}),
    _timelineRecord: true,
    _timelineAuxiliary: "terminal",
    _timelineUnitKey: `aux:terminal:${window.header.tapeId}`,
  };
}

function unifiedTimelineTapeFallbackMessages(
  sessionId: string,
  unit: {
    tapeId: string;
    orderSeq: number;
    reason: TapeDisplayDegradeReason;
    header: UnifiedTimelineTapeHeader | null;
    anchor: MessageLike;
    detail?: string;
  },
): MessageLike[] {
  const picked = pickTapeDisplayFallbackText({
    visibleHead: unit.header?.visibleHead,
    anchorText: unit.anchor.text,
  });
  const reason: TapeDisplayDegradeReason = !unit.header
    ? (unit.reason === "finalized_tape_missing" ? "header_missing" : unit.reason)
    : (picked.source === "placeholder" && !unit.header.visibleHead ? "visible_head_missing" : unit.reason);
  warnTapeDisplayDegrade({
    sessionId,
    tapeId: unit.tapeId,
    reason,
    detail: unit.detail,
  });
  const head = unit.header?.visibleHead;
  const id = (typeof head?.messageId === "string" && head.messageId.length > 0
    ? head.messageId
    : null)
    ?? unit.header?.billingAnchorId
    ?? (typeof unit.anchor.id === "string" ? unit.anchor.id : `tape-degraded:${unit.tapeId}`);
  const ts = typeof head?.ts === "number" && Number.isFinite(head.ts)
    ? head.ts
    : (typeof unit.anchor.ts === "number" && Number.isFinite(unit.anchor.ts) ? unit.anchor.ts : 0);
  return [{
    id,
    role: "assistant",
    text: picked.text,
    ts,
    status: unit.header?.status ?? (typeof unit.anchor.status === "string" ? unit.anchor.status : "completed"),
    _source: "server",
    _turnTapeId: unit.tapeId,
    _turnTapeSha256: unit.header?.tapeSha256
      ?? (typeof unit.anchor._turnTapeSha256 === "string" ? unit.anchor._turnTapeSha256 : undefined),
    _turnTapeComplete: true,
    _turnKey: unit.header?.turnKey
      ?? (typeof unit.anchor._turnKey === "string" ? unit.anchor._turnKey : undefined),
    _orderSeq: unit.orderSeq,
    _timelineRecord: true,
    _timelineUnitKey: `tape-fallback:${unit.tapeId}`,
    _displayDegraded: true,
    _displayDegradeReason: reason,
    _dispatchOutcome: unit.header?.status,
    ...(typeof unit.anchor._seq === "number" ? { _seq: unit.anchor._seq } : {}),
    ...(unit.header?.clientMessageId
      ? { _clientMessageId: unit.header.clientMessageId }
      : (typeof unit.anchor._clientMessageId === "string"
        ? { _clientMessageId: unit.anchor._clientMessageId }
        : {})),
    ...(typeof head?.errorCode === "string" ? { _errorCode: head.errorCode } : {}),
  }];
}

async function hydrateUnifiedTimelineTapeUnits(
  client: PoolClient,
  sessionId: string,
  userId: string,
  units: Array<Extract<UnifiedTimelineSelectedUnit, { kind: "tape" }>>,
): Promise<Map<string, MessageLike[]>> {
  const result = new Map<string, MessageLike[]>();
  if (units.length === 0) return result;
  const tapeIds = [...new Set(units.map((unit) => unit.header.tapeId))];
  const billingHeads = await readDirectTapeVisibleHeads(client, sessionId, userId, tapeIds);
  const billingByTape = new Map(billingHeads.map((head) => [head.tape_id, head]));
  const planned = units.filter((unit) =>
    recordsPublished({
      materializationStatus: unit.header.materializationStatus,
      finalizedAt: unit.header.finalizedAt,
    }) &&
    !deferUnifiedTimelinePayload(
      unit.head.role,
      bigIntNum(unit.head.payload_bytes, "turn tape timeline payload bytes"),
    ));
  const payloadRows = planned.length === 0
    ? []
    : (
        await client.query<(DirectTapeSourceRecord & { tape_id: string })>(
          `WITH selected(tape_id,ordinal) AS (
             SELECT * FROM unnest($3::text[],$4::integer[])
           )
           SELECT r.tape_id,r.msg_id,r.ordinal,r.role,r.content_sha256,r.payload,
                  r.visible_payload,r.visible_content_sha256
             FROM selected
             JOIN client_session_turn_tape_records r
               ON r.session_id=$1 AND r.user_id=$2
              AND r.tape_id=selected.tape_id AND r.ordinal=selected.ordinal`,
          [
            sessionId,
            userId,
            planned.map((unit) => unit.header.tapeId),
            planned.map((unit) => unit.head.ordinal),
          ],
        )
      ).rows;
  const payloadByKey = new Map(payloadRows.map((row) => [`${row.tape_id}\0${row.ordinal}`, row]));

  for (const unit of units) {
    const { anchor, header, head } = unit;
    if (!recordsPublished({
      materializationStatus: header.materializationStatus,
      finalizedAt: header.finalizedAt,
    })) {
      continue;
    }
    const physicalKey = `${header.tapeId}\0${head.ordinal}`;
    try {
    const payloadBytes = bigIntNum(head.payload_bytes, "turn tape timeline payload bytes");
    const billing = billingByTape.get(header.tapeId);
    const isBillingAnchor = head.msg_id === header.billingAnchorId;
    const enrichment: ExactUsageEnrichment = isBillingAnchor && billing
      ? {
          costCredits: billing.cost_credits,
          waiverApplied: billing.waiver_applied,
          delegates: parseDelegateCosts(billing.delegate_costs),
        }
      : { costCredits: "0", waiverApplied: false, delegates: [] };
    let logicalRecords: MessageLike[];
    if (deferUnifiedTimelinePayload(head.role, payloadBytes)) {
      let deferred = deferredTapeRecord(
        header.tapeId,
        header.tapeSha256,
        { ...head, content_sha256: head.visible_content_sha256 ?? undefined },
        payloadBytes,
      );
      deferred = mergeBillingAnchorUsage(deferred, anchor, isBillingAnchor);
      deferred = mergeExactUsage(deferred, enrichment, isBillingAnchor);
      logicalRecords = [deferred];
    } else {
      const source = payloadByKey.get(physicalKey);
      if (!source) throw new Error(`[pgSessions] unified timeline tape record missing: ${physicalKey}`);
      let visibleBytes: Buffer;
      if (source.visible_payload !== null) {
        visibleBytes = Buffer.from(source.visible_payload);
        if (sha256Bytes(visibleBytes) !== source.visible_content_sha256) {
          throw new Error(`[pgSessions] unified timeline visible payload hash mismatch: ${physicalKey}`);
        }
      } else {
        const visible = userVisiblePhysicalPayload({
          tape_id: header.tapeId,
          tape_sha256: header.tapeSha256,
          waive_reason: null,
          waiver_applied: false,
          msg_id: source.msg_id,
          ordinal: source.ordinal,
          role: source.role,
          content_sha256: source.content_sha256,
          payload: Buffer.from(source.payload),
          cost_credits: "0",
          delegate_costs: [],
        }, header.tapeSha256, header.billingAnchorId);
        if (!visible) throw new Error(`[pgSessions] unified timeline record malformed: ${physicalKey}`);
        visibleBytes = visible.bytes;
      }
      let parsed: MessageLike;
      try {
        const value = JSON.parse(visibleBytes.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
        parsed = value as MessageLike;
      } catch (error) {
        throw new Error(`[pgSessions] unified timeline record JSON invalid: ${physicalKey}: ${(error as Error).message}`);
      }
      let hydrated: MessageLike = {
        ...parsed,
        _source: "server",
        _turnTapeId: header.tapeId,
        _turnTapeMsgId: source.msg_id,
        _turnTapeOrdinal: source.ordinal,
        _turnTapeSha256: header.tapeSha256,
        _turnTapeExpanded: true,
        _turnTapeComplete: true,
        ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
        _orderSeq: unit.orderSeq,
      };
      hydrated = mergeBillingAnchorUsage(hydrated, anchor, isBillingAnchor);
      hydrated = mergeExactUsage(hydrated, enrichment, isBillingAnchor);
      logicalRecords = expandHydratedRuntimeBatch(
        hydrated,
        {
          tape_id: header.tapeId,
          tape_sha256: header.tapeSha256,
          waive_reason: null,
          waiver_applied: false,
          msg_id: source.msg_id,
          ordinal: source.ordinal,
          role: source.role,
          content_sha256: source.content_sha256,
          payload: source.payload,
          cost_credits: enrichment.costCredits,
          delegate_costs: enrichment.delegates,
        },
        anchor,
      ).messages;
    }
    logicalRecords = logicalRecords.map((record, logicalIndex) => ({
      ...record,
      _source: "server",
      _turnTapeId: header.tapeId,
      _turnTapeSha256: header.tapeSha256,
      _turnTapeComplete: true,
      _turnTapeOrdinal: head.ordinal,
      _recordOrdinal: head.ordinal,
      ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
      _orderSeq: unit.orderSeq,
      status: typeof record.status === "string" ? record.status : header.status,
      // Non-display terminal evidence for the owning finalized tape. Every
      // real record carries it so a latest page can converge a lost final WS
      // even when the tape contains only plan/goal/runtime-event roles.
      _dispatchOutcome: header.status,
      _turnKey: header.turnKey,
      ...(header.clientMessageId && typeof record._clientMessageId !== "string"
        ? { _clientMessageId: header.clientMessageId }
        : {}),
      _timelineRecord: true,
      _timelineLogicalOrdinal: logicalIndex,
      _timelineUnitKey: timelineTapeKey(header.tapeId, head.ordinal, logicalIndex, record.id),
    }));
    result.set(physicalKey, logicalRecords);
    } catch (error) {
      result.set(physicalKey, unifiedTimelineTapeFallbackMessages(sessionId, {
        tapeId: header.tapeId,
        orderSeq: unit.orderSeq,
        reason: classifyUnifiedTimelineIntegrityError(error),
        header,
        anchor,
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return result;
}

async function readUnifiedTimelineStatuses(
  client: PoolClient,
  sessionUserId: string,
  sessionId: string,
  anchorSeqs: number[],
): Promise<Map<number, MessageLike[]>> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(sessionUserId);
  if (!uidMatch || anchorSeqs.length === 0) return new Map();
  const rows = (
    await client.query<UnifiedTimelineStatusRow>(
      `SELECT dispatch_id,client_message_id,failure_code,anchor_seq::text,terminal_at
         FROM turn_dispatches
        WHERE user_id=$1 AND session_id=$2
          AND status='terminal' AND client_notified=TRUE
          AND outcome IN ('not_accepted','executed_error')
          AND anchor_seq=ANY($3::bigint[])
        ORDER BY anchor_seq,dispatch_id`,
      [uidMatch[1], sessionId, anchorSeqs],
    )
  ).rows;
  const byAnchor = new Map<number, MessageLike[]>();
  for (const row of rows) {
    const anchorSeq = bigIntNum(row.anchor_seq, "turn dispatch anchor_seq");
    const list = byAnchor.get(anchorSeq) ?? [];
    list.push({
      id: `turn-status:${row.dispatch_id}`,
      role: "system",
      text: "",
      ts: row.terminal_at?.getTime() ?? 0,
      _source: "server",
      _seq: anchorSeq,
      _turnStatusRecord: true,
      _dispatchTerminal: true,
      _dispatchLost: true,
      _errorCode: row.failure_code ?? "DISPATCH_LOST",
      _clientMessageId: row.client_message_id,
      _timelineRecord: true,
      _timelineUnitKey: `status:${row.dispatch_id}`,
    });
    byAnchor.set(anchorSeq, list);
  }
  return byAnchor;
}

/** The browser's sole historical read path: one exact chronological stream
 * across ordinary rows and immutable tape physical records. It never emits a
 * process control, projection, summary or truncation substitute. */
async function readClientTimelinePageImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  cursor: ClientTimelineCursor | null = null,
  limit = 100,
  snapshotClient?: PoolClient,
): Promise<ClientTimelinePage | null> {
  const cappedLimit = Math.max(1, Math.min(
    TAPE_RECORD_PAGE_MAX_ROWS,
    Number.isFinite(limit) ? Math.floor(limit) : 100,
  ));
  const readSnapshot = async (client: PoolClient): Promise<ClientTimelinePage | null> => {
    const session = (
      await client.query<{
        messages: string;
        archived_through_seq: number | null;
        history_revision: string;
        timeline_generation: string;
      }>(
        `SELECT messages,archived_through_seq,history_revision,timeline_generation
           FROM client_sessions
          WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
        [sessionId, userId],
      )
    ).rows[0];
    if (!session) return null;
    const timelineGeneration = bigIntNum(session.timeline_generation, "timeline_generation");
    if (cursor && cursor.timelineGeneration !== timelineGeneration) {
      throw new ClientTimelineCursorStaleError();
    }
    const archivedThroughSeq = bigIntNumOr(session.archived_through_seq, 0);
    let candidateLimit = cappedLimit + 1;
    let outer!: Awaited<ReturnType<typeof readUnifiedTimelineOuterCandidates>>;
    let selected: UnifiedTimelineSelectedUnit[] = [];
    let windows: UnifiedTimelineTapeWindow[] = [];
    let inlineBytes = 0;
    let hasMore = false;
    let continuation: { anchor: MessageLike; header: UnifiedTimelineTapeHeader; beforeOrdinal: number } | null = null;

    // Runtime transport rows and continuation-only tapes do not consume a
    // logical history slot. Expand the outer candidate window until this page
    // either finds the next genuine browser record or reaches the immutable
    // beginning. Re-running inside this repeatable-read transaction preserves
    // one snapshot while avoiding any arbitrary transcript-wide cap.
    for (;;) {
      outer = await readUnifiedTimelineOuterCandidates(
        client,
        sessionId,
        userId,
        session.messages,
        archivedThroughSeq,
        cursor,
        candidateLimit,
      );
      const tapeAnchors = outer.messages.filter((message) =>
        message._turnTapeComplete === true &&
        typeof message._turnTapeId === "string" &&
        typeof message._turnTapeSha256 === "string");
      const tapeIds = [...new Set(tapeAnchors.map((message) => message._turnTapeId as string))];
      const headers = await readUnifiedTimelineTapeHeaders(client, sessionId, userId, tapeIds);
      const beforeByTape = new Map<string, number>();
      for (const anchor of tapeAnchors) {
        const tapeId = anchor._turnTapeId as string;
        beforeByTape.set(tapeId, cursor?.tapeId === tapeId
          ? (cursor.beforeOrdinal ?? 0)
          : 2_147_483_647);
      }
      const headRequests = [...beforeByTape].map(([tapeId, beforeOrdinal]) => ({ tapeId, beforeOrdinal }));
      const headsByTape = await readUnifiedTimelineTapeHeads(
        client,
        sessionId,
        userId,
        headRequests,
        cappedLimit + 1,
      );

      if (cursor?.tapeId) {
        const resumeAnchor = tapeAnchors.find((anchor) =>
          anchor._orderSeq === cursor.beforeOrderSeq && anchor._turnTapeId === cursor.tapeId);
        const header = headers.get(cursor.tapeId);
        if (
          !resumeAnchor || !header ||
          resumeAnchor._turnTapeSha256 !== cursor.tapeSha256 ||
          header.tapeSha256 !== cursor.tapeSha256
        ) throw new ClientTimelineCursorStaleError();
      }

      selected = [];
      windows = [];
      inlineBytes = 0;
      hasMore = false;
      continuation = null;
      let foundNextVisible = false;
      outerLoop: for (const anchor of outer.messages) {
        const orderSeq = anchor._orderSeq;
        if (typeof orderSeq !== "number" || !Number.isSafeInteger(orderSeq) || orderSeq < 1) continue;
        if (
          anchor._turnTapeComplete === true &&
          typeof anchor._turnTapeId === "string" &&
          typeof anchor._turnTapeSha256 === "string"
        ) {
          const header = headers.get(anchor._turnTapeId);
          if (!header) {
            const fallbackBytes = Buffer.byteLength(String(anchor.text ?? ""), "utf8");
            if (
              selected.length >= cappedLimit ||
              (selected.length > 0 && inlineBytes + fallbackBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES)
            ) {
              foundNextVisible = true;
              hasMore = true;
              break outerLoop;
            }
            selected.push({
              kind: "tape-fallback",
              anchor,
              orderSeq,
              header: null,
              reason: "finalized_tape_missing",
            });
            inlineBytes += fallbackBytes;
            continue;
          }
          if (header.tapeSha256 !== anchor._turnTapeSha256) {
            const fallbackBytes = Buffer.byteLength(header.visibleHead?.text ?? String(anchor.text ?? ""), "utf8");
            if (
              selected.length >= cappedLimit ||
              (selected.length > 0 && inlineBytes + fallbackBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES)
            ) {
              foundNextVisible = true;
              hasMore = true;
              break outerLoop;
            }
            selected.push({
              kind: "tape-fallback",
              anchor,
              orderSeq,
              header,
              reason: "tape_hash_mismatch",
            });
            windows.push({
              anchor,
              orderSeq,
              header,
              lowerOrdinal: 0,
              upperOrdinal: beforeByTape.get(header.tapeId) ?? 2_147_483_647,
            });
            inlineBytes += fallbackBytes;
            continue;
          }
          const upperOrdinal = beforeByTape.get(header.tapeId) ?? 2_147_483_647;
          const recordsReady = recordsPublished({
            materializationStatus: header.materializationStatus,
            finalizedAt: header.finalizedAt,
          });
          if (!recordsReady) {
            const fallbackBytes = Buffer.byteLength(header.visibleHead?.text ?? String(anchor.text ?? ""), "utf8");
            if (
              selected.length >= cappedLimit ||
              (selected.length > 0 && inlineBytes + fallbackBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES)
            ) {
              foundNextVisible = true;
              hasMore = true;
              break outerLoop;
            }
            selected.push({
              kind: "tape-fallback",
              anchor,
              orderSeq,
              header,
              reason: header.materializationStatus === "failed"
                ? "records_failed"
                : "records_unpublished",
            });
            windows.push({ anchor, orderSeq, header, lowerOrdinal: 0, upperOrdinal });
            inlineBytes += fallbackBytes;
            continue;
          }
          const heads = headsByTape.get(header.tapeId) ?? [];
          let oldestSelectedOrdinal: number | null = null;
          for (const head of heads) {
            const payloadBytes = bigIntNum(head.payload_bytes, "turn tape timeline payload bytes");
            const pageBytes = deferUnifiedTimelinePayload(head.role, payloadBytes)
              ? 0
              : payloadBytes;
            if (
              selected.length >= cappedLimit ||
              (selected.length > 0 && inlineBytes + pageBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES)
            ) {
              foundNextVisible = true;
              hasMore = true;
              if (oldestSelectedOrdinal !== null) {
                windows.push({
                  anchor,
                  orderSeq,
                  header,
                  lowerOrdinal: oldestSelectedOrdinal,
                  upperOrdinal,
                });
                continuation = { anchor, header, beforeOrdinal: oldestSelectedOrdinal };
              }
              break outerLoop;
            }
            selected.push({ kind: "tape", anchor, orderSeq, header, head });
            inlineBytes += pageBytes;
            oldestSelectedOrdinal = head.ordinal;
          }
          // Fewer than cappedLimit+1 semantic heads means this entire physical
          // interval is consumed, including any hidden Bash-tail evidence.
          windows.push({ anchor, orderSeq, header, lowerOrdinal: 0, upperOrdinal });
          continue;
        }
        // Legacy raw transport envelopes stay available through audit reads,
        // but are not Agent conversation records and never occupy a UI page.
        if (anchor.role === "runtime-event") continue;
        const pageBytes = Buffer.byteLength(JSON.stringify(anchor), "utf8");
        if (
          selected.length >= cappedLimit ||
          (selected.length > 0 && inlineBytes + pageBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES)
        ) {
          foundNextVisible = true;
          hasMore = true;
          break;
        }
        selected.push({ kind: "outer", anchor, orderSeq });
        inlineBytes += pageBytes;
      }
      if (foundNextVisible || !outer.hasOlderCandidates) break;
      candidateLimit = Math.max(candidateLimit + 1, candidateLimit * 2);
    }

    const selectedTapeUnits = selected.filter(
      (unit): unit is Extract<UnifiedTimelineSelectedUnit, { kind: "tape" }> => unit.kind === "tape",
    );
    const tapeMessages = await hydrateUnifiedTimelineTapeUnits(
      client,
      sessionId,
      userId,
      selectedTapeUnits,
    );
    const bashTailAuxiliaries = await readUnifiedTimelineBashTailAuxiliaries(
      client,
      sessionId,
      userId,
      windows,
      TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES - inlineBytes,
    );
    const terminalAuxiliaries = windows.map(unifiedTimelineTerminalAuxiliary);
    const selectedUserSeqs = selected.flatMap((unit) =>
      unit.kind === "outer" && unit.anchor.role === "user" &&
      typeof unit.anchor._seq === "number" && Number.isSafeInteger(unit.anchor._seq)
        ? [unit.anchor._seq]
        : []);
    const statuses = await readUnifiedTimelineStatuses(
      client,
      userId,
      sessionId,
      selectedUserSeqs,
    );

    const chronological: MessageLike[] = [];
    for (const unit of [...selected].reverse()) {
      if (unit.kind === "tape-fallback") {
        chronological.push(...unifiedTimelineTapeFallbackMessages(sessionId, {
          tapeId: unit.header?.tapeId ?? String(unit.anchor._turnTapeId),
          orderSeq: unit.orderSeq,
          reason: unit.reason,
          header: unit.header,
          anchor: unit.anchor,
        }));
        continue;
      }
      if (unit.kind === "tape") {
        const records = tapeMessages.get(`${unit.header.tapeId}\0${unit.head.ordinal}`);
        if (!records) {
          chronological.push(...unifiedTimelineTapeFallbackMessages(sessionId, {
            tapeId: unit.header.tapeId,
            orderSeq: unit.orderSeq,
            reason: "hydrated_group_missing",
            header: unit.header,
            anchor: unit.anchor,
          }));
          continue;
        }
        chronological.push(...records);
        continue;
      }
      let outerMessages: MessageLike[] = [unit.anchor];
      if (
        unit.anchor._turnTapeComplete !== true &&
        typeof unit.anchor._turnTapeId === "string" &&
        typeof unit.anchor._turnTapeSha256 === "string"
      ) {
        try {
          outerMessages = await hydrateTurnTapeMessages(client, sessionId, userId, [unit.anchor], { view: "exact" });
        } catch (error) {
          outerMessages = unifiedTimelineTapeFallbackMessages(sessionId, {
            tapeId: String(unit.anchor._turnTapeId),
            orderSeq: unit.orderSeq,
            reason: classifyUnifiedTimelineIntegrityError(error),
            header: null,
            anchor: unit.anchor,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (let index = 0; index < outerMessages.length; index++) {
        const message = outerMessages[index]!;
        chronological.push({
          ...message,
          _timelineRecord: true,
          _timelineLogicalOrdinal: index,
          _timelineUnitKey: outerMessages.length === 1
            ? timelineOuterKey(unit.anchor, unit.orderSeq)
            : `${timelineOuterKey(unit.anchor, unit.orderSeq)}:${index}:${String(message.id ?? "anonymous")}`,
        });
      }
      if (unit.anchor.role === "user" && typeof unit.anchor._seq === "number") {
        const unitStatuses = statuses.get(unit.anchor._seq) ?? [];
        for (let statusIndex = 0; statusIndex < unitStatuses.length; statusIndex++) {
          chronological.push({
            ...unitStatuses[statusIndex]!,
            _orderSeq: unit.orderSeq,
            // User + verified statuses are one deterministic logical group.
            // Never let skew between the client message clock and the server
            // terminal clock move a status before its owning user message.
            _timelineLogicalOrdinal: outerMessages.length + statusIndex,
          });
        }
      }
    }

    chronological.push(...bashTailAuxiliaries, ...terminalAuxiliaries);
    chronological.sort((a, b) => {
      const orderSeq = (message: MessageLike): number =>
        typeof message._orderSeq === "number" && Number.isSafeInteger(message._orderSeq)
          ? message._orderSeq
          : Number.MAX_SAFE_INTEGER;
      const tapeOrdinal = (message: MessageLike): number | null =>
        typeof message._turnTapeId === "string" && message._turnTapeId.length > 0 &&
        typeof message._turnTapeOrdinal === "number" && Number.isSafeInteger(message._turnTapeOrdinal)
          ? message._turnTapeOrdinal
          : null;
      const aTape = tapeOrdinal(a);
      const bTape = tapeOrdinal(b);
      const aRank = a._turnTapeProcess === true ? 0 : aTape !== null ? 1 : 2;
      const bRank = b._turnTapeProcess === true ? 0 : bTape !== null ? 1 : 2;
      if (orderSeq(a) === orderSeq(b) && aRank === bRank && aTape === bTape) {
        // User + verified status share one frozen order slot, while expanded
        // logical rows share one physical tape ordinal. In both cases the
        // server-authored logical ordinal must win over skewed wall clocks.
        const aLogical = typeof a._timelineLogicalOrdinal === "number" ? a._timelineLogicalOrdinal : 0;
        const bLogical = typeof b._timelineLogicalOrdinal === "number" ? b._timelineLogicalOrdinal : 0;
        if (aLogical !== bLogical) return aLogical - bLogical;
      }
      const ordered = compareMessagesByOrder(a, b);
      if (ordered !== 0) return ordered;
      return String(a._timelineUnitKey ?? a.id ?? "").localeCompare(
        String(b._timelineUnitKey ?? b.id ?? ""),
      );
    });

    let nextCursor: ClientTimelineCursor | null = null;
    if (hasMore && selected.length > 0) {
      const oldest = selected.at(-1)!;
      if (continuation && oldest.kind === "tape" && oldest.header.tapeId === continuation.header.tapeId) {
        nextCursor = {
          version: 1,
          timelineGeneration,
          beforeOrderSeq: continuation.anchor._orderSeq as number,
          tapeId: continuation.header.tapeId,
          tapeSha256: continuation.header.tapeSha256,
          beforeOrdinal: continuation.beforeOrdinal,
        };
      } else {
        nextCursor = {
          version: 1,
          timelineGeneration,
          beforeOrderSeq: oldest.orderSeq,
        };
      }
    }
    return {
      messages: chronological,
      nextCursor,
      hasMore,
      timelineGeneration,
      historyRevision: bigIntNum(session.history_revision, "history_revision"),
      snapshotMaxSeq: outer.snapshotMaxSeq,
    };
  };
  return snapshotClient
    ? readSnapshot(snapshotClient)
    : withTimelineSnapshot(pool, readSnapshot);
}

/** Physical-ordinal cursor paging over the immutable tape. The separately
 * rendered billing anchor is the only excluded row; every other role is
 * returned, with known platform-private fields removed but no semantic
 * allowlist. Oversized records use a deferred exact byte locator. */
async function listTurnTapeRecordsImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  cursor: number,
  limit: number,
  before?: number | null,
): Promise<{
  records: MessageLike[];
  nextCursor: number | null;
  total: number;
} | null> {
  const header = (
    await pool.query<{
      tape_sha256: string;
      billing_anchor_id: string;
      physical_record_count: string;
      logical_record_count: string;
    }>(
      `SELECT t.tape_sha256, t.billing_anchor_id,
              CASE WHEN t.physical_record_count=0 THEN
                (SELECT COUNT(*)::text FROM client_session_turn_tape_records r
                  WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id)
              ELSE t.physical_record_count::text END AS physical_record_count,
              CASE WHEN t.logical_record_count=0 THEN
                (SELECT COUNT(*)::text FROM client_session_turn_tape_records r
                  WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id)
                   ELSE t.logical_record_count::text END AS logical_record_count
         FROM client_session_turn_tapes t
        WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
          AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL`,
      [sessionId, userId, tapeId],
    )
  ).rows[0];
  if (!header) return null;
  const start = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
  const cappedLimit = Math.max(1, Math.min(
    TAPE_RECORD_PAGE_MAX_ROWS,
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TAPE_RECORD_PAGE_MAX_ROWS,
  ));
  const total = Math.max(
    0,
    bigIntNum(header.logical_record_count, "turn tape record total") - 1,
  );

  // Reverse/before is an additive browser-tail path. The legacy cursor path
  // below remains byte-for-byte forward compatible for admin and rolling web
  // clients during deploy convergence.
  if (before !== undefined) {
    const upper = Number.isSafeInteger(before) && (before ?? 0) > 0 ? before : null;
    const heads = (
      await pool.query<DirectTapePageHead>(
        `SELECT msg_id, ordinal, role, ts::text, content_sha256,
                COALESCE(octet_length(visible_payload), octet_length(payload))::text AS payload_bytes,
                visible_content_sha256
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            AND ($4::integer IS NULL OR ordinal < $4)
            AND msg_id<>$5
          ORDER BY ordinal DESC
          LIMIT $6`,
        [sessionId, userId, tapeId, upper, header.billing_anchor_id, cappedLimit + 1],
      )
    ).rows;
    const selected: DirectTapePageHead[] = [];
    let pageRawBytes = 0;
    let hasMore = false;
    for (const head of heads) {
      if (selected.length >= cappedLimit) {
        hasMore = true;
        break;
      }
      const payloadBytes = bigIntNum(head.payload_bytes, "turn tape record payload bytes");
      const inlineBytes = payloadBytes > TAPE_RECORD_INLINE_QUANTUM_BYTES ? 0 : payloadBytes;
      if (selected.length > 0 && pageRawBytes + inlineBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES) {
        hasMore = true;
        break;
      }
      selected.push(head);
      pageRawBytes += inlineBytes;
    }
    const records = await hydrateDirectTapePage(
      pool,
      sessionId,
      userId,
      tapeId,
      header.tape_sha256,
      header.billing_anchor_id,
      selected,
    );
    return {
      records,
      nextCursor: hasMore && selected.length > 0
        ? Math.min(...selected.map((head) => head.ordinal))
        : null,
      total,
    };
  }

  let rawBytes = 0;
  let nextCursor: number | null = null;
  const records: MessageLike[] = [];
  let scanCursor = start;
  let exhausted = false;
  while (records.length < cappedLimit && !exhausted && nextCursor === null) {
    const heads = (
      await pool.query<DirectTapePageHead>(
        `SELECT msg_id, ordinal, role, ts::text, content_sha256,
                COALESCE(octet_length(visible_payload), octet_length(payload))::text AS payload_bytes,
                visible_content_sha256
          FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal >= $4
            AND msg_id<>$5
          ORDER BY ordinal
          LIMIT $6`,
        [sessionId, userId, tapeId, scanCursor, header.billing_anchor_id, cappedLimit + 1],
      )
    ).rows;
    if (heads.length === 0) {
      exhausted = true;
      break;
    }

    const selected: DirectTapePageHead[] = [];
    for (const head of heads) {
      if (records.length + selected.length >= cappedLimit) {
        nextCursor = head.ordinal;
        break;
      }
      const payloadBytes = bigIntNum(head.payload_bytes, "turn tape record payload bytes");
      if (payloadBytes > TAPE_RECORD_INLINE_QUANTUM_BYTES) {
        selected.push(head);
        scanCursor = head.ordinal + 1;
        continue;
      }
      if (
        records.length + selected.length > 0 &&
        rawBytes + payloadBytes > TAPE_RECORD_PAGE_RAW_QUANTUM_BYTES
      ) {
        nextCursor = head.ordinal;
        break;
      }
      selected.push(head);
      rawBytes += payloadBytes;
      scanCursor = head.ordinal + 1;
    }
    records.push(...await hydrateDirectTapePage(
      pool,
      sessionId,
      userId,
      tapeId,
      header.tape_sha256,
      header.billing_anchor_id,
      selected,
    ));

    if (nextCursor !== null) break;
    if (heads.length <= cappedLimit) exhausted = true;
  }
  return {
    records,
    nextCursor,
    total,
  };
}

export interface TapeRecordPayload {
  payload: Buffer;
  totalBytes: number;
  offset: number;
  msgId: string;
  role: string;
  contentSha256: string;
  tapeSha256: string;
}

export interface TapeRecordPayloadChunk {
  chunk: Buffer;
  nextOffset: number | null;
  totalBytes: number;
  start: number;
  endExclusive: number;
  msgId: string;
  role: string;
  contentSha256: string;
  tapeSha256: string;
}

async function readTapeRecordPayloadImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  recordOrdinal: number,
  requestedOffset = 0,
  requestedLength?: number,
): Promise<TapeRecordPayload | null> {
  if (
    !Number.isSafeInteger(recordOrdinal) || recordOrdinal < 0 ||
    !Number.isSafeInteger(requestedOffset) || requestedOffset < 0 ||
    (requestedLength !== undefined &&
      (!Number.isSafeInteger(requestedLength) || requestedLength < 0))
  ) return null;
  type VisibleHead = {
    tape_sha256: string;
    billing_anchor_id: string;
    msg_id: string;
    role: string;
    content_sha256: string;
    visible_content_sha256: string | null;
    visible_bytes: string | null;
  };
  const row = (
    await pool.query<{
      tape_sha256: string;
      billing_anchor_id: string;
      msg_id: string;
      role: string;
      content_sha256: string;
      visible_content_sha256: string | null;
      visible_bytes: string | null;
    }>(
      `SELECT t.tape_sha256, t.billing_anchor_id, r.msg_id, r.role, r.content_sha256,
              r.visible_content_sha256,
              CASE WHEN r.visible_payload IS NULL THEN NULL
                   ELSE octet_length(r.visible_payload)::text END AS visible_bytes
         FROM client_session_turn_tapes t
         JOIN client_session_turn_tape_records r
           ON r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
        WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
          AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL
          AND r.ordinal=$4`,
      [sessionId, userId, tapeId, recordOrdinal],
    )
  ).rows[0];
  if (!row) return null;
  let visibleHead: VisibleHead = row;
  let freshlyMaterialized: Buffer | null = null;
  if (visibleHead.visible_bytes === null || visibleHead.visible_content_sha256 === null) {
    // Rolling predecessor rows have no derived payload. Materialize exactly
    // once, publish it transactionally, then all future requests are true
    // byte-range reads. New finalizers never enter this compatibility branch.
    const legacy = (
      await pool.query<{ payload: Buffer }>(
        `SELECT payload FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
        [sessionId, userId, tapeId, recordOrdinal],
      )
    ).rows[0];
    if (!legacy) return null;
    const visible = userVisiblePhysicalPayload({
      tape_id: tapeId,
      tape_sha256: row.tape_sha256,
      waive_reason: null,
      waiver_applied: false,
      msg_id: row.msg_id,
      ordinal: recordOrdinal,
      role: row.role,
      content_sha256: row.content_sha256,
      payload: Buffer.from(legacy.payload),
      cost_credits: "0",
      delegate_costs: [],
    }, row.tape_sha256, row.billing_anchor_id);
    if (!visible) return null;
    await pool.query(
      `UPDATE client_session_turn_tape_records
          SET visible_payload=COALESCE(visible_payload,$5),
              visible_content_sha256=COALESCE(visible_content_sha256,$6)
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
      [sessionId, userId, tapeId, recordOrdinal, visible.bytes, visible.contentSha256],
    );
    freshlyMaterialized = visible.bytes;
    visibleHead = {
      ...row,
      visible_bytes: String(visible.bytes.length),
      visible_content_sha256: visible.contentSha256,
    };
  }
  const totalBytes = bigIntNum(visibleHead.visible_bytes!, "visible tape record payload bytes");
  if (requestedOffset > totalBytes) return null;
  const length = requestedLength === undefined
    ? totalBytes - requestedOffset
    : Math.min(requestedLength, totalBytes - requestedOffset);
  let chunk: Buffer;
  if (length === 0) {
    chunk = Buffer.alloc(0);
  } else if (freshlyMaterialized !== null) {
    chunk = freshlyMaterialized.subarray(requestedOffset, requestedOffset + length);
  } else {
    const chunkRow = (
      await pool.query<{ chunk: Buffer }>(
        `SELECT substring(visible_payload FROM $5::integer + 1 FOR $6::integer) AS chunk
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
        [sessionId, userId, tapeId, recordOrdinal, requestedOffset, length],
      )
    ).rows[0];
    if (!chunkRow) return null;
    chunk = Buffer.from(chunkRow.chunk ?? Buffer.alloc(0));
  }
  return {
    payload: chunk,
    totalBytes,
    offset: requestedOffset,
    msgId: row.msg_id,
    role: row.role,
    contentSha256: visibleHead.visible_content_sha256!,
    tapeSha256: row.tape_sha256,
  };
}

async function readTapeRecordPayloadChunkImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  tapeId: string,
  recordOrdinal: number,
  offset: number,
  requestedBytes?: number,
): Promise<TapeRecordPayloadChunk | null> {
  const record = await readTapeRecordPayloadImpl(
    pool,
    sessionId,
    userId,
    tapeId,
    recordOrdinal,
    offset,
    requestedBytes,
  );
  if (!record) return null;
  const endExclusive = record.offset + record.payload.length;
  return {
    chunk: record.payload,
    nextOffset: endExclusive < record.totalBytes ? endExclusive : null,
    totalBytes: record.totalBytes,
    start: record.offset,
    endExclusive,
    msgId: record.msgId,
    role: record.role,
    contentSha256: record.contentSha256,
    tapeSha256: record.tapeSha256,
  };
}

async function readUserMessagePayloadImpl(
  pool: Pool,
  sessionId: string,
  userId: string,
  msgId: string,
  offset = 0,
  requestedLength?: number,
): Promise<{
  payload: Buffer;
  totalBytes: number;
  offset: number;
  msgId: string;
  role: "user";
  contentSha256: string;
} | null> {
  const requestedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : -1;
  if (requestedOffset < 0) return null;
  if (
    requestedLength !== undefined &&
    (!Number.isSafeInteger(requestedLength) || requestedLength < 0)
  ) return null;
  const row = (
    await pool.query<{ content_sha256: string; payload_bytes: string }>(
      `SELECT p.content_sha256,p.payload_bytes::text AS payload_bytes
         FROM client_session_user_payloads p
         JOIN client_sessions s ON s.id=p.session_id AND s.user_id=p.user_id
        WHERE p.session_id=$1 AND p.user_id=$2 AND p.msg_id=$3 AND s.deleted_at IS NULL`,
      [sessionId, userId, msgId],
    )
  ).rows[0];
  if (!row) return null;
  const totalBytes = bigIntNum(row.payload_bytes, "user payload bytes");
  if (requestedOffset > totalBytes) return null;
  const length = requestedLength === undefined
    ? totalBytes - requestedOffset
    : Math.min(requestedLength, totalBytes - requestedOffset);
  const payload = length === 0
    ? Buffer.alloc(0)
    : Buffer.from((
        await pool.query<{ chunk: Buffer }>(
          `SELECT substring(payload FROM $4::integer + 1 FOR $5::integer) AS chunk
             FROM client_session_user_payloads
            WHERE session_id=$1 AND user_id=$2 AND msg_id=$3`,
          [sessionId, userId, msgId, requestedOffset, length],
        )
      ).rows[0]?.chunk ?? Buffer.alloc(0));
  return {
    payload,
    totalBytes,
    offset: requestedOffset,
    msgId,
    role: "user",
    contentSha256: row.content_sha256,
  };
}


/**
 * 构造 master 会话权威的 PG backend。返回对象结构化满足 `ClientSessionsBackend`,
 * 由 registerCommercial 注入。方法内闭包持有 pool。
 */


const PHASE_A_LIVE_FRAME_LIMIT = 16;
const PHASE_A_LIVE_FRAME_MAX_BYTES = 64 * 1024;

async function readBoundedLiveFrameText(
  queryable: Pool | PoolClient,
  dispatchId: string | null,
): Promise<string> {
  if (!dispatchId) return "";
  try {
    const frames = await queryable.query<{ payload: Buffer }>(
      `SELECT payload FROM (
         SELECT f.payload, f.created_at
           FROM client_session_live_streams s
           JOIN client_session_live_frames f ON f.stream_key=s.stream_key
          WHERE s.dispatch_id=$1::uuid
            AND octet_length(f.payload) <= $2
          ORDER BY f.created_at DESC
          LIMIT $3
       ) q ORDER BY created_at ASC`,
      [dispatchId, PHASE_A_LIVE_FRAME_MAX_BYTES, PHASE_A_LIVE_FRAME_LIMIT],
    );
    const chunks: string[] = [];
    for (const row of frames.rows) {
      try {
        const parsed = JSON.parse(row.payload.toString("utf8")) as {
          type?: string;
          blocks?: Array<{ kind?: string; text?: string }>;
          text?: string;
        };
        if (parsed.type && parsed.type !== "outbound.message") continue;
        if (typeof parsed.text === "string" && parsed.text) chunks.push(parsed.text);
        for (const block of parsed.blocks ?? []) {
          if (block.kind === "text" && typeof block.text === "string") chunks.push(block.text);
        }
      } catch {
        /* ignore malformed frame */
      }
    }
    return chunks.join("");
  } catch {
    return "";
  }
}

export async function commitVisibleLosslessTurnPhaseA(
  pool: Pool,
  userId: string,
  request: LosslessTurnTapeFinalizeRequest | LosslessTurnTapeVisibleRequest,
  options: { enqueueMaterialization?: boolean } = {},
): Promise<LosslessTurnTapeFinalizeResult> {
  const billingUserId = /^c:[1-9][0-9]*$/.test(userId)
    ? numericCommercialUserId(userId)
    : null;
  return withTx(pool, async (rawClient) => {
    const client = new Proxy(rawClient, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === "string") phaseASqlObserver?.(sql);
            return target.query(sql as never, ...(rest as never[]));
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PoolClient;
    await lockTurnPersistenceKeys(client, userId, [request.turnKey]);
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
    if ((request.dispatchId === undefined) !== (request.attemptNo === undefined)) {
      throw new Error("lossless turn tape dispatch identity is incomplete");
    }
    // A small visibility header is durable before the first multipart part.
    // ON CONFLICT is followed by a full immutable-header comparison below.
    await client.query(
      `INSERT INTO client_session_turn_tapes
         (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
          total_bytes,part_count,created_at,waive_reason,dispatch_id,attempt_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (session_id,user_id,tape_id) DO NOTHING`,
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
        request.dispatchId ?? null,
        request.attemptNo ?? null,
      ],
    );
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
        visible_at: string | null;
        finalized_at: string | null;
        engine_billings: unknown;
        billing_anchor_id: string | null;
        settlement_hash: string | null;
        dispatch_id: string | null;
        attempt_no: number | null;
        visible_head: unknown;
      }>(
        `SELECT agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,part_count,created_at,
                waive_reason,visible_at::text,finalized_at::text,engine_billings,billing_anchor_id,
                settlement_hash,dispatch_id,attempt_no,visible_head
           FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          FOR UPDATE`,
        [request.sessionId, userId, request.tapeId],
      )
    ).rows[0];
    if (!tape) return { applied: "incomplete" };
    if (!sameLosslessTurnTapeHeader(tape, request)) {
      throw new Error("lossless turn tape finalize header conflict");
    }
    if (
      request.dispatchId !== undefined && (
        tape.dispatch_id !== request.dispatchId || tape.attempt_no !== request.attemptNo
      )
    ) {
      throw new Error("lossless turn tape dispatch identity conflict");
    }
    const settlement = request.settlement;
    const engineBillings = settlement
      ? settlementEngineBillings(settlement)
      : (Array.isArray(tape.engine_billings)
        ? structuredClone(tape.engine_billings) as DurableCodexBilling[]
        : []);
    const billingAnchorId = settlement?.billingAnchorId
      ?? tape.billing_anchor_id
      ?? losslessBillingAnchorId({
        sessionId: request.sessionId,
        agentId: request.agentId,
        turnIndex: request.turnIndex,
        text: settlement?.text,
        errorCode: settlement?.errorCode,
      });
    const incomingHash = settlement
      ? settlementAuthorityHash({
          billingAnchorId,
          requestId: settlement.requestId,
          engineBillings,
        })
      : tape.settlement_hash;
    if (tape.settlement_hash && incomingHash && tape.settlement_hash !== incomingHash) {
      throw new Error("lossless turn tape settlement conflict");
    }
    let clientMessageId: string | null = null;
    if (tape.dispatch_id !== null) {
      clientMessageId = (
        await client.query<{ client_message_id: string }>(
          "SELECT client_message_id FROM turn_dispatches WHERE dispatch_id=$1",
          [tape.dispatch_id],
        )
      ).rows[0]?.client_message_id ?? null;
    }
    const fenced = tape.dispatch_id
      ? (
          await client.query<{ producer_fenced_at: Date | null }>(
            "SELECT producer_fenced_at FROM turn_dispatches WHERE dispatch_id=$1::uuid",
            [tape.dispatch_id],
          )
        ).rows[0]?.producer_fenced_at
      : null;
    if (tape.visible_at !== null) {
      if (request.waiveReason !== undefined && billingUserId !== null) {
        await ensurePendingTurnWaiverInTransaction(client, {
          userId: billingUserId,
          turnKey: request.turnKey,
          reason: request.waiveReason,
        });
      }
      let replayLate = false;
      if (tape.dispatch_id !== null) {
        const convergence = await convergeDispatchOnFinalize(
          client,
          tape.dispatch_id,
          tape.status,
          request.settlement?.errorCode ?? errorCodeFromVisibleHead(tape.visible_head),
        );
        replayLate = convergence.lateTape;
      }
      if (options.enqueueMaterialization !== false && tape.finalized_at === null) {
        await enqueueMaterializationJob(client, {
          sessionId: request.sessionId,
          userId,
          tapeId: request.tapeId,
          dispatchId: tape.dispatch_id,
        });
      }
      return {
        applied: tape.finalized_at !== null ? "idempotent" : "finalized",
        recordCount: 0,
        engineBillings,
        settlementHandoff: true,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(replayLate ? { dispatchLateTape: true, settlementHeld: true } : {}),
      };
    }
    const liveFrameText = settlement
      ? ""
      : await readBoundedLiveFrameText(client, tape.dispatch_id);
    const visibleText = phaseAVisibleHeadText({
      hasSettlement: Boolean(settlement),
      settlementText: settlement?.text,
      liveFrameText,
    });
    const head = settlement
      ? visibleHeadFromSettlement(request, settlement, clientMessageId)
      : visibleHeadFallback(request, visibleText, clientMessageId);
    await client.query(
      `UPDATE client_session_turn_tapes
          SET visible_at=$1, visible_head=$2::jsonb,
              billing_anchor_id=COALESCE(billing_anchor_id,$3),
              engine_billings=CASE WHEN $4::jsonb <> '[]'::jsonb THEN $4::jsonb ELSE engine_billings END,
              settlement_hash=COALESCE(settlement_hash,$6),
              client_message_id=COALESCE(client_message_id,$5)
        WHERE session_id=$7 AND user_id=$8 AND tape_id=$9`,
      [
        Date.now(),
        JSON.stringify(head),
        billingAnchorId,
        JSON.stringify(engineBillings),
        clientMessageId,
        incomingHash,
        request.sessionId,
        userId,
        request.tapeId,
      ],
    );
    let existingMessages: MessageLike[];
    try {
      const parsed = JSON.parse(session.messages);
      if (!Array.isArray(parsed)) throw new Error("not array");
      existingMessages = parsed as MessageLike[];
    } catch {
      throw new Error("lossless turn tape target session row malformed");
    }
    const stubRecord = { id: billingAnchorId, role: "assistant" as const, ts: head.ts, text: head.text };
    const conflictingAnchor = existingMessages.find(
      (message) =>
        message?.id === billingAnchorId &&
        typeof message._turnTapeId === "string" &&
        message._turnTapeId !== request.tapeId,
    );
    let anchors: (MessageLike & { id: string })[];
    if (conflictingAnchor) {
      // A content-only recovery deliberately reuses the crashed source billing
      // anchor. Phase A must not delete that source before Phase B verifies the
      // recovery link and transfers its billing ownership atomically.
      const recoveryLink = await readTurnTapeRecoveryLink(
        client,
        request.sessionId,
        userId,
        request.tapeId,
        true,
      );
      if (!recoveryLink || recoveryLink.source_tape_id !== conflictingAnchor._turnTapeId) {
        throw new Error("lossless turn tape visible anchor is owned by another tape");
      }
      anchors = [];
    } else {
      anchors = [{
        ...tapeAnchor(stubRecord as never, request.tapeId, request.tapeSha256, 1, 1, undefined, []),
        text: head.text,
      }];
      const recordIds = new Set([billingAnchorId]);
      existingMessages = existingMessages.filter(
        (message) => typeof message?.id !== "string" || !recordIds.has(message.id),
      );
    }
    const plan = planAppendServerAuthoredBatch(
      existingMessages,
      anchors,
      typeof session.next_seq === "number" && session.next_seq > 0 ? session.next_seq : 1,
      bigIntNumOr(session.archived_through_seq, 0),
    );
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
           history_revision=history_revision + 1,
           timeline_generation=timeline_generation + 1
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
    if (options.enqueueMaterialization !== false) {
      await enqueueMaterializationJob(client, {
        sessionId: request.sessionId,
        userId,
        tapeId: request.tapeId,
        dispatchId: tape.dispatch_id,
      });
    }
    const holdReason = fenced ? "late_tape_after_fence" : "awaiting_materialization";
    if (engineBillings.length > 0) {
      await enqueueSettlementJob(client, {
        sessionId: request.sessionId,
        userId,
        tapeId: request.tapeId,
        dispatchId: tape.dispatch_id,
        kind: "billing",
        payload: { engineBillings },
        billingAnchorId,
        requestId: settlement?.requestId ?? engineBillings[0]?.requestId,
        settlementHash: incomingHash,
        held: true,
        holdReason,
      });
    }
    if (request.waiveReason !== undefined && billingUserId !== null) {
      await ensurePendingTurnWaiverInTransaction(client, {
        userId: billingUserId,
        turnKey: request.turnKey,
        reason: request.waiveReason,
      });
      await enqueueSettlementJob(client, {
        sessionId: request.sessionId,
        userId,
        tapeId: request.tapeId,
        dispatchId: tape.dispatch_id,
        kind: "waiver",
        payload: { reason: request.waiveReason, turnKey: request.turnKey },
        billingAnchorId,
        settlementHash: incomingHash,
        held: true,
        holdReason,
      });
    }
    let lateTape = false;
    if (tape.dispatch_id !== null) {
      const convergence = await convergeDispatchOnFinalize(
        client,
        tape.dispatch_id,
        tape.status,
        request.settlement?.errorCode ?? head.errorCode,
      );
      lateTape = convergence.lateTape;
    }
    return {
      applied: "finalized",
      recordCount: 0,
      engineBillings,
      settlementHandoff: true,
      newlyVisible: true,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(lateTape || fenced ? { settlementHeld: true } : {}),
      ...(lateTape ? { dispatchLateTape: true } : {}),
    };
  });
}


async function readOpenDispatchForSession(
  queryable: Pool | PoolClient,
  sessionId: string,
  userId: string,
): Promise<{ openDispatch?: ClientSession["openDispatch"] }> {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
  if (!uidMatch) return {};
  const row = (
    await queryable.query<{
      dispatch_id: string;
      client_message_id: string;
      status: string;
      accepted_at: Date | null;
      last_attempt_at: Date | null;
      model: string | null;
      last_frame_at: Date | null;
    }>(
      `SELECT d.dispatch_id, d.client_message_id, d.status, d.accepted_at, d.last_attempt_at, d.model,
              (
                SELECT MAX(f.created_at)
                  FROM client_session_live_streams s
                  JOIN client_session_live_frames f ON f.stream_key=s.stream_key
                 WHERE s.dispatch_id=d.dispatch_id
              ) AS last_frame_at
         FROM turn_dispatches d
        WHERE d.user_id=$1::bigint AND d.session_id=$2
          AND d.status IN ('admitted','accepted','rejecting')
        ORDER BY d.admitted_at DESC
        LIMIT 1`,
      [uidMatch[1], sessionId],
    )
  ).rows[0];
  if (!row) return {};
  return {
    openDispatch: {
      dispatchId: row.dispatch_id,
      clientMessageId: row.client_message_id,
      status: row.status,
      acceptedAt: row.accepted_at ? row.accepted_at.getTime() : null,
      lastFrameAt: (row.last_frame_at ?? row.last_attempt_at)?.getTime() ?? null,
      ...(row.model ? { model: row.model } : {}),
    },
  };
}

export function createPgSessionsBackend(
  pool: Pool,
  options: PgSessionsBackendOptions,
): PgSessionsBackend {
  const expectedGeneration = options.expectedGeneration;
  const finalizeSingleflight = _createFinalizeSingleflight<LosslessTurnTapeFinalizeResult>();

  const backend: PgSessionsBackend = {
    async commitVisibleLosslessTurnTape(
      userId: string,
      request: LosslessTurnTapeVisibleRequest,
    ): Promise<LosslessTurnTapeFinalizeResult> {
      return commitVisibleLosslessTurnPhaseA(pool, userId, request, {
        enqueueMaterialization: false,
      });
    },

    async admitUserTurn(input: AdmitUserTurnInput): Promise<AdmitUserTurnResult> {
      try {
        return await withTx(pool, async (client): Promise<AdmitUserTurnResult> => {
        if (input.recoveryJob) {
          if (!input.recovery?.automatic) {
            throw new RecoveryJobAdmissionConflict("scheduler_lineage_missing");
          }
          await lockRecoveryRoot(client, {
            userId: input.uid,
            sessionId: input.sessionId,
            rootClientMessageId: input.recovery.rootClientMessageId,
          });
        }
        let message = input.message;
        if (input.recovery) {
          const expected = input.recovery.automatic
            ? turnRecoveryAttemptIdentity(
                input.sessionId,
                input.recovery.rootClientMessageId,
                input.recovery.attempt,
              )
            : turnRecoveryIdentity(
                input.sessionId,
                input.recovery.sourceClientMessageId,
              );
          if (expected.clientMessageId !== input.clientMessageId) {
            return { kind: "recovery_conflict", reason: "identity_mismatch" };
          }
          const locked = (
            await client.query<{ messages: string; deleted_at: string | null }>(
              `SELECT messages, deleted_at
                 FROM client_sessions
                WHERE id=$1 AND user_id=$2
                FOR UPDATE`,
              [input.sessionId, input.sessionUserId],
            )
          ).rows[0];
          if (!locked) return { kind: "session_not_found" };
          if (locked.deleted_at !== null) return { kind: "session_deleted" };
          let current: MessageLike[];
          try {
            const parsed = JSON.parse(locked.messages);
            if (!Array.isArray(parsed)) throw new Error("not array");
            current = parsed as MessageLike[];
          } catch {
            return { kind: "recovery_conflict", reason: "session_history_malformed" };
          }
          const existingRecovery = current.find((item) =>
            item?.role === "user" && item.id === input.clientMessageId);
          if (existingRecovery) {
            if (
              existingRecovery._recoveryOfClientMessageId !== input.recovery.sourceClientMessageId ||
              existingRecovery._recoveryMode !== input.recovery.mode ||
              existingRecovery._automaticRecovery !== input.recovery.automatic ||
              (input.recovery.automatic && (
                existingRecovery._automaticRecoveryRootClientMessageId !== input.recovery.rootClientMessageId ||
                existingRecovery._automaticRecoveryAttempt !== input.recovery.attempt ||
                existingRecovery._automaticRecoveryMax !== input.recovery.max
              ))
            ) {
              return { kind: "recovery_conflict", reason: "identity_reused" };
            }
            message = {
              ...input.message,
              _recoveryOfClientMessageId: input.recovery.sourceClientMessageId,
              _recoveryMode: input.recovery.mode,
              _automaticRecovery: input.recovery.automatic,
              ...(input.recovery.automatic
                ? {
                    _automaticRecoveryRootClientMessageId: input.recovery.rootClientMessageId,
                    _automaticRecoveryAttempt: input.recovery.attempt,
                    _automaticRecoveryMax: input.recovery.max,
                  }
                : {}),
            };
          } else {
            const latestUser = [...current].reverse().find((item) => item?.role === "user");
            if (!latestUser || latestUser.id !== input.recovery.sourceClientMessageId) {
              return { kind: "recovery_conflict", reason: "source_not_latest" };
            }
            let automaticRoot = latestUser.id;
            let automaticSourceAttempt = 0;
            if (input.recovery.automatic) {
              automaticRoot = typeof latestUser._automaticRecoveryRootClientMessageId === "string"
                ? latestUser._automaticRecoveryRootClientMessageId
                : latestUser._automaticRecovery === true &&
                    typeof latestUser._recoveryOfClientMessageId === "string"
                  ? latestUser._recoveryOfClientMessageId
                  : latestUser.id;
              automaticSourceAttempt = typeof latestUser._automaticRecoveryAttempt === "number" &&
                  Number.isSafeInteger(latestUser._automaticRecoveryAttempt) &&
                  latestUser._automaticRecoveryAttempt >= 1
                ? latestUser._automaticRecoveryAttempt
                : latestUser._automaticRecovery === true
                  ? 1
                  : 0;
              if (
                input.recovery.rootClientMessageId !== automaticRoot ||
                input.recovery.max !== AUTOMATIC_TURN_RETRY_MAX
              ) {
                return { kind: "recovery_conflict", reason: "automatic_lineage_mismatch" };
              }
            }
            const sourceIndex = current.lastIndexOf(latestUser);
            const recoverableHotTapeError = current.slice(sourceIndex + 1).some((item) =>
              item?.role === "assistant" &&
              item._clientMessageId === input.recovery?.sourceClientMessageId &&
              supportsAutomaticTurnRecovery(String(item._errorCode ?? "")));
            const dispatchFailure = (
              await client.query<{ outcome: string; failure_code: string | null }>(
                `SELECT outcome, failure_code
                   FROM turn_dispatches
                  WHERE user_id=$1 AND session_id=$2 AND client_message_id=$3
                    AND status='terminal'
                  LIMIT 1`,
                [input.uid, input.sessionId, input.recovery.sourceClientMessageId],
              )
            ).rows[0];
            const finalized = (
              await client.query<{ tape_id: string; status: string; waive_reason: string | null }>(
                `SELECT tape_id,status,waive_reason
                   FROM client_session_turn_tapes
                  WHERE session_id=$1 AND user_id=$2
                    AND client_message_id=$3
                    AND finalized_at IS NOT NULL
                  ORDER BY finalized_at DESC,tape_id
                  LIMIT 1`,
                [
                  input.sessionId,
                  input.sessionUserId,
                  input.recovery.sourceClientMessageId,
                ],
              )
            ).rows[0];
            let authoritativeRetryAttempt = automaticSourceAttempt;
            if (finalized) {
              const recordRows = (
                await client.query<{ payload: Buffer }>(
                  `SELECT payload
                     FROM client_session_turn_tape_records
                    WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                    ORDER BY ordinal`,
                  [input.sessionId, input.sessionUserId, finalized.tape_id],
                )
              ).rows;
              const records: unknown[] = [];
              try {
                for (const row of recordRows) {
                  const record = JSON.parse(Buffer.from(row.payload).toString("utf8"));
                  if (!record || typeof record !== "object" || Array.isArray(record)) {
                    throw new Error("not an object");
                  }
                  records.push(record);
                }
              } catch {
                return { kind: "recovery_conflict", reason: "source_tape_malformed" };
              }
              const assessment = assessTurnRecoveryTape(records);
              const terminalErrorCode = terminalTurnRecordErrorCode(records);
              const finalizedErrorCode = terminalErrorCode ||
                (finalized.status === "crashed" || finalized.status === "interrupted"
                  ? finalized.waive_reason ?? ""
                  : "");
              if (!supportsAutomaticTurnRecovery(finalizedErrorCode)) {
                return { kind: "recovery_conflict", reason: "source_not_recoverable" };
              }
              if (
                finalized.status === "completed" &&
                assessment.mode !== "checkpoint"
              ) {
                return { kind: "recovery_conflict", reason: "completed_replay_forbidden" };
              }
              if (assessment.mode !== input.recovery.mode) {
                return { kind: "recovery_conflict", reason: "recovery_mode_mismatch" };
              }
              if (
                input.recovery.automatic &&
                assessment.mode === "checkpoint" &&
                !assessment.checkpointSafe &&
                finalized.status !== "completed"
              ) {
                return { kind: "recovery_conflict", reason: "automatic_checkpoint_unsafe" };
              }
              if (
                assessment.mode === "replay" &&
                (
                  !assessment.checkpointSafe ||
                  !recoveryWithoutCheckpointIsProven(finalizedErrorCode)
                )
              ) {
                return { kind: "recovery_conflict", reason: "automatic_replay_not_proven" };
              }
              if (input.recovery.automatic) {
                authoritativeRetryAttempt = Math.max(
                  authoritativeRetryAttempt,
                  maxAutomaticTurnRetryAttempt(records, automaticRoot),
                );
              }
            } else {
              const dispatchErrorCode = dispatchFailure?.failure_code ?? "";
              if (
                !recoverableHotTapeError &&
                !supportsAutomaticTurnRecovery(dispatchErrorCode)
              ) {
                return { kind: "recovery_conflict", reason: "source_not_recoverable" };
              }
              if (
                input.recovery.mode !== "replay" ||
                dispatchFailure?.outcome !== "not_accepted" ||
                !recoveryWithoutCheckpointIsProven(dispatchErrorCode)
              ) {
                return { kind: "recovery_conflict", reason: "source_not_safely_replayable" };
              }
            }
            if (
              input.recovery.automatic &&
              (
                authoritativeRetryAttempt >= AUTOMATIC_TURN_RETRY_MAX ||
                input.recovery.attempt !== authoritativeRetryAttempt + 1
              )
            ) {
              return {
                kind: "recovery_conflict",
                reason: authoritativeRetryAttempt >= AUTOMATIC_TURN_RETRY_MAX
                  ? "automatic_retry_exhausted"
                  : "automatic_attempt_mismatch",
              };
            }
            message = {
              ...input.message,
              _recoveryOfClientMessageId: input.recovery.sourceClientMessageId,
              _recoveryMode: input.recovery.mode,
              _automaticRecovery: input.recovery.automatic,
              ...(input.recovery.automatic
                ? {
                    _automaticRecoveryRootClientMessageId: input.recovery.rootClientMessageId,
                    _automaticRecoveryAttempt: input.recovery.attempt,
                    _automaticRecoveryMax: input.recovery.max,
                  }
                : {}),
            };
          }
        }
        // 0) 幂等建行:用户首条消息本身就是「会话存在」的权威。前端 ensureServerSession 的
        //    PUT 是 fire-and-forget、与 WS 首帧天然竞态(legacy persist 路径靠 [0,50,150]ms
        //    重试吸收;受理路径「受理先于一切」撞库更早,不建行则新会话首条消息必
        //    session_not_found)。ON CONFLICT DO NOTHING:已存在的行(含他人所有/墓碑)分毫
        //    不动 —— 归属与墓碑仍由下方 append 的 (id,user_id)/deleted_at 核对裁定,
        //    session_not_found / session_deleted 语义不变,不会跨用户建行或复活墓碑。
        //    后到的 ensure PUT(baseSyncedAt=0)命中本行 → rejected_stale 空操作,不 clobber。
        if (!input.recovery) {
          const firstUserText = typeof message.text === "string" ? message.text : "";
          const initialTitle = firstUserText.length > 50
            ? `${firstUserText.slice(0, 50)}…`
            : firstUserText || "新会话";
          await client.query(
            `INSERT INTO client_sessions (id, user_id, agent_id, title, created_at, last_at, updated_at)
             VALUES ($1, $2, $3, $4, ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL})
             ON CONFLICT (id) DO NOTHING`,
            [input.sessionId, input.sessionUserId, input.agentId, initialTitle],
          );
        }
        // 1) 幂等 append user 行(既有 id 幂等)。
        const appended = await pgAppendServerAuthoredCore(
          client,
          input.sessionId,
          input.sessionUserId,
          message,
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
        // 2) anchor_seq = 该 user 行的 _seq(会话顺序键;不在热尾巴时 null)。
        const anchorSeq = typeof appended.seq === "number" ? BigInt(appended.seq) : null;
        // 3) UPSERT dispatch + 冲突表裁定(同一 tx,受理即拥有 I1)。
        const dispatch = await admitDispatch(client, {
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
        if (input.recoveryJob) {
          const bound = await bindRecoveryJobDispatch(client, {
            jobId: input.recoveryJob.jobId,
            userId: input.uid,
            sessionId: input.sessionId,
            rootClientMessageId: input.recovery!.automatic
              ? input.recovery!.rootClientMessageId
              : "",
            semanticRecoveryAttempt: input.recovery!.automatic
              ? input.recovery!.attempt
              : 0,
            leaseOwner: input.recoveryJob.leaseOwner,
            leaseEpoch: input.recoveryJob.leaseEpoch,
            dispatchId: dispatch.dispatch.dispatchId,
            dispatchAttemptNo: dispatch.dispatch.attemptNo,
          });
          if (!bound) throw new RecoveryJobAdmissionConflict("scheduler_lease_lost");
          if (dispatch.kind === "in_flight") {
            await client.query(
              `UPDATE turn_recovery_jobs
                  SET status='forwarded',container_receipt_at=COALESCE(container_receipt_at,NOW()),
                      lease_owner=NULL,lease_until=NULL,updated_at=NOW()
                WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
              [input.recoveryJob.jobId, input.recoveryJob.leaseOwner, input.recoveryJob.leaseEpoch],
            );
          } else if (
            dispatch.kind === "deduplicated" ||
            dispatch.kind === "previously_failed" ||
            dispatch.kind === "manual_hold"
          ) {
            await client.query(
              `UPDATE turn_recovery_jobs
                  SET status=CASE WHEN $4='manual_hold' THEN 'manual_reconcile' ELSE 'completed' END,
                      lease_owner=NULL,lease_until=NULL,updated_at=NOW()
                WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3`,
              [
                input.recoveryJob.jobId,
                input.recoveryJob.leaseOwner,
                input.recoveryJob.leaseEpoch,
                dispatch.kind,
              ],
            );
          }
        }
        if (appended.workspaceMode === undefined) {
          throw new Error(`workspace mode missing after append for ${input.sessionId}`);
        }
        return { ...dispatch, workspaceMode: appended.workspaceMode };
        });
      } catch (error) {
        if (error instanceof RecoveryJobAdmissionConflict) {
          return { kind: "recovery_conflict", reason: error.reason };
        }
        throw error;
      }
    },

    async reconcileAutomaticRecoveryJobs(userId: bigint, limit = 100): Promise<number> {
      const sessionUserId = `c:${userId.toString()}`;
      const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const candidates = await pool.query<{
        session_id: string;
        tape_id: string;
        tape_sha256: string;
        agent_id: string;
        status: "interrupted" | "crashed";
        turn_key: string;
        waive_reason: string | null;
        client_message_id: string;
      }>(
        `SELECT t.session_id,t.tape_id,t.tape_sha256,t.agent_id,t.status,
                t.turn_key,t.waive_reason,t.client_message_id
           FROM client_session_turn_tapes t
          WHERE t.user_id=$1 AND t.finalized_at IS NOT NULL
            AND t.status IN ('interrupted','crashed')
            AND t.client_message_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM turn_recovery_jobs j
               WHERE j.user_id=$2 AND j.session_id=t.session_id
                 AND j.source_turn_key=t.turn_key
            )
          ORDER BY t.finalized_at DESC
          LIMIT $3`,
        [sessionUserId, userId.toString(), boundedLimit],
      );
      let scheduled = 0;
      for (const candidate of candidates.rows) {
        const inserted = await withTx(pool, async (client): Promise<boolean> => {
          const tape = (
            await client.query<typeof candidate & { finalized_at: string | null }>(
              `SELECT session_id,tape_id,tape_sha256,agent_id,status,turn_key,
                      waive_reason,client_message_id,finalized_at
                 FROM client_session_turn_tapes
                WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                FOR UPDATE`,
              [candidate.session_id, sessionUserId, candidate.tape_id],
            )
          ).rows[0];
          if (!tape || tape.finalized_at === null) return false;
          const session = (
            await client.query<{ messages: string; deleted_at: string | null }>(
              `SELECT messages,deleted_at FROM client_sessions
                WHERE id=$1 AND user_id=$2 FOR UPDATE`,
              [candidate.session_id, sessionUserId],
            )
          ).rows[0];
          if (!session || session.deleted_at !== null) return false;
          let currentMessages: MessageLike[];
          try {
            const parsed = JSON.parse(session.messages);
            if (!Array.isArray(parsed)) return false;
            currentMessages = parsed as MessageLike[];
          } catch {
            return false;
          }
          const rows = await client.query<{ payload: Buffer }>(
            `SELECT payload FROM client_session_turn_tape_records
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
              ORDER BY ordinal`,
            [candidate.session_id, sessionUserId, candidate.tape_id],
          );
          const records: Array<{ payload: MessageLike }> = [];
          try {
            for (const row of rows.rows) {
              const parsed = JSON.parse(Buffer.from(row.payload).toString("utf8"));
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
              records.push({ payload: parsed as MessageLike });
            }
          } catch {
            return false;
          }
          const recordError = terminalTurnRecordErrorCode(
            records.map((record) => record.payload),
          );
          await scheduleAutomaticRecoveryForFinalizedTurn(client, {
            uid: userId,
            sessionUserId,
            sessionId: candidate.session_id,
            clientMessageId: candidate.client_message_id,
            tapeSha256: candidate.tape_sha256,
            currentMessages,
            turn: {
              payload: {
                clientMessageId: candidate.client_message_id,
                status: candidate.status,
                agentId: candidate.agent_id,
                turnKey: candidate.turn_key,
                ...(typeof recordError === "string"
                  ? { errorCode: recordError }
                  : candidate.waive_reason ? { waiveReason: candidate.waive_reason as LosslessTurnPayload["waiveReason"] } : {}),
              },
              records,
            },
          });
          const exists = await client.query(
            `SELECT 1 FROM turn_recovery_jobs
              WHERE user_id=$1 AND session_id=$2 AND source_turn_key=$3 LIMIT 1`,
            [userId.toString(), candidate.session_id, candidate.turn_key],
          );
          return (exists.rowCount ?? 0) === 1;
        });
        if (inserted) scheduled++;
      }
      return scheduled;
    },

    async getClientSessionWorkspaceMode(
      sessionId: string,
      sessionUserId: string,
    ): Promise<SessionWorkspaceMode | null> {
      const row = (
        await pool.query<{ workspace_mode: string }>(
          `SELECT workspace_mode
             FROM client_sessions
            WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
          [sessionId, sessionUserId],
        )
      ).rows[0];
      if (!row) return null;
      const workspaceMode = parseSessionWorkspaceMode(row.workspace_mode);
      if (workspaceMode === null) {
        throw new Error(`client_sessions.workspace_mode invalid for ${sessionId}`);
      }
      return workspaceMode;
    },

    async getTurnTapeStateByDispatch(
      userId: string,
      dispatchId: string,
      attemptNo: number,
    ): Promise<TurnTapeStateResult> {
      const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
      if (!uidMatch) return { state: "none", status: null, dispatchLeaseActive: false, gatewayShutdownEvidence: false };
      const dispatchUserId = uidMatch[1]!;
      const res = await pool.query<{
        tape_found: boolean;
        finalized_at: string | null;
        visible_at: string | null;
        tape_status: string | null;
        dispatch_lease_active: boolean;
        gateway_shutdown_evidence: boolean;
      }>(
        `SELECT
           (tape.tape_id IS NOT NULL) AS tape_found,
           tape.finalized_at,
           tape.visible_at,
           tape.status AS tape_status,
           COALESCE(
             dispatch.status IN ('admitted','accepted')
               AND dispatch.lease_until > statement_timestamp(),
             FALSE
           ) AS dispatch_lease_active,
           COALESCE(dispatch.shutdown_ctx->>$5, '') <> '' AS gateway_shutdown_evidence
         FROM (VALUES (1)) AS singleton(n)
         LEFT JOIN LATERAL (
           SELECT tape_id, finalized_at, visible_at, status
             FROM client_session_turn_tapes
            WHERE user_id = $1 AND dispatch_id = $3 AND attempt_no = $4
            ORDER BY (visible_at IS NOT NULL OR finalized_at IS NOT NULL) DESC
            LIMIT 1
         ) AS tape ON TRUE
         LEFT JOIN LATERAL (
           SELECT status, lease_until, shutdown_ctx
             FROM turn_dispatches
            WHERE user_id = $2 AND dispatch_id = $3 AND attempt_no = $4
            LIMIT 1
         ) AS dispatch ON TRUE`,
        [userId, dispatchUserId, dispatchId, attemptNo, "gatewayExitedAt"],
      );
      // singleton guarantees one row. Tape and lease evidence come from this
      // one PostgreSQL statement snapshot: a separate read could observe
      // none, race with finalize, then observe an expired lease and synthesize
      // a false SERVICE_RESTART tape.
      const row = res.rows[0]!;
      const dispatchLeaseActive = row.dispatch_lease_active === true;
      const gatewayShutdownEvidence = row.gateway_shutdown_evidence === true;
      if (!row.tape_found) {
        return { state: "none", status: null, dispatchLeaseActive, gatewayShutdownEvidence };
      }
      return {
        state: row.visible_at !== null || row.finalized_at !== null ? "finalized" : "partial",
        status: row.tape_status ?? null,
        dispatchLeaseActive,
        gatewayShutdownEvidence,
      };
    },

    async stageLosslessTurnTapePart(
      userId: string,
      request: LosslessTurnTapePartRequest,
      payload: Buffer,
      dispatchIdentity?: { dispatchId: string; attemptNo: number },
    ): Promise<LosslessTurnTapeStageResult> {
      return withTx(pool, async (client) => {
        // Parts are immutable staging blobs and do not mutate the hot session
        // row. A plain MVCC ownership/tombstone check keeps them independent
        // from concurrent chat writes; the tape/session foreign keys still
        // serialize hard deletion, while finalize alone takes the exclusive
        // session lock needed to append the visible anchor.
        const session = (
          await client.query<{ deleted_at: string | null }>(
            "SELECT deleted_at FROM client_sessions WHERE id = $1 AND user_id = $2",
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
      finalizeOptions?: { materialize?: boolean },
    ): Promise<LosslessTurnTapeFinalizeResult> {
      const flight = finalizeSingleflight(
        _losslessFinalizeSingleflightKey(userId, request),
        async (): Promise<LosslessTurnTapeFinalizeResult> => {
      let goalUsageChanged = false;
      // Personal/test namespaces also use this backend in some deployments,
      // but only `c:<uid>` sessions participate in commercial settlement.
      const billingUserId = /^c:[1-9][0-9]*$/.test(userId)
        ? numericCommercialUserId(userId)
        : null;
      if (request.waiveReason !== undefined && billingUserId === null) {
        throw new Error("turn waiver requires a commercial c:<uid> session owner");
      }
      // Validate the cheap immutable header + part manifest before reserving
      // physical materialization memory. A partial upload must return
      // `incomplete`; it must never occupy admission and stall unrelated
      // completed turns.
      const readyForPreparation = await isLosslessTurnTapeReadyForPreparation(
        pool,
        userId,
        request,
      );
      let phaseA: LosslessTurnTapeFinalizeResult | null = null;
      if (readyForPreparation) {
        phaseA = await commitVisibleLosslessTurnPhaseA(pool, userId, request);
        if (phaseA.applied === "session_not_found" || phaseA.applied === "session_deleted" || phaseA.applied === "incomplete") {
          return phaseA;
        }
      }
      if (finalizeOptions?.materialize === false) {
        return phaseA ?? { applied: "incomplete" };
      }
      let prepared: PreparedLosslessTurnTape | null = null;
      let preparedModelRecordCount = 0;
      let releaseFinalizeAdmission: (() => void) | null = null;
      if (readyForPreparation) {
        releaseFinalizeAdmission = acquireFinalizeMemoryAdmission(request.totalBytes);
        try {
          const recordStorageFormat = await claimLosslessTurnTapeStorageFormat(
            pool,
            userId,
            request,
          );
          prepared = recordStorageFormat === null
            ? null
            : await _prepareLosslessTurnTapeOutsideLocks(
                pool,
                userId,
                request,
                recordStorageFormat,
              );
          if (prepared) {
            preparedModelRecordCount = preparedModelSidecarManifest(prepared).length;
            await _stagePreparedLosslessTurnRecords(
              pool,
              userId,
              request,
              prepared,
            );
          } else {
            releaseFinalizeAdmission();
            releaseFinalizeAdmission = null;
          }
        } catch (err) {
          releaseFinalizeAdmission?.();
          releaseFinalizeAdmission = null;
          if (phaseA && phaseA.applied === "finalized" && isTransientTapeError(err)) {
            return { ...phaseA, settlementHandoff: true };
          }
          throw err;
        }
      }
      let result: LosslessTurnTapeFinalizeResult;
      let recoveryLockHint = await readTurnTapeRecoveryLink(
        pool,
        request.sessionId,
        userId,
        request.tapeId,
      );
      try {
        for (let lockAttempt = 0; ; lockAttempt++) {
          try {
            result = await withTx(pool, async (client): Promise<LosslessTurnTapeFinalizeResult> => {
        // Recovery publication must serialize both immutable logical turns in
        // the same lexical order as authorization and billing settlement.
        await lockTurnPersistenceKeys(client, userId, recoveryLockHint
          ? [request.turnKey, recoveryLockHint.source_turn_key]
          : [request.turnKey]);
        // Shared with rolling lease renewal and every settlement/refund path:
        // once a terminal anchor commits, no renewal can race past its check.
        if (billingUserId !== null) {
          await lockTurnBillingKeys(client, billingUserId, recoveryLockHint
            ? [request.turnKey, recoveryLockHint.source_turn_key]
            : [request.turnKey]);
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

        const recoveryLink = await readTurnTapeRecoveryLink(
          client,
          request.sessionId,
          userId,
          request.tapeId,
          true,
        );
        if (!recoveryLockHint && recoveryLink) {
          throw new TurnTapeRecoveryLockUpgrade(recoveryLink);
        }
        if (recoveryLockHint && (!recoveryLink || !sameTurnTapeRecoveryLink(recoveryLockHint, recoveryLink))) {
          throw new Error("turn tape recovery authorization changed during finalize");
        }
        if (recoveryLink && (
          recoveryLink.recovery_turn_key !== request.turnKey ||
          recoveryLink.recovery_tape_sha256 !== request.tapeSha256
        )) {
          throw new Error("turn tape recovery request identity conflict");
        }

        const tapeRows = (
          await client.query<{
            tape_id: string;
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
            record_storage_format: number;
            engine_billings: unknown;
            billing_anchor_id: string | null;
            dispatch_id: string | null;
            attempt_no: number | null;
            client_message_id: string | null;
            visible_at: string | null;
            materialization_status: string;
            settlement_hash: string | null;
            visible_head: unknown;
          }>(
            `SELECT tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
                    total_bytes, part_count, created_at, waive_reason, finalized_at,
                    record_storage_format,engine_billings,
                    billing_anchor_id,dispatch_id,attempt_no,client_message_id,
                    visible_at::text, materialization_status, settlement_hash, visible_head
               FROM client_session_turn_tapes
              WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[])
              ORDER BY tape_id FOR UPDATE`,
            [
              request.sessionId,
              userId,
              recoveryLink ? [request.tapeId, recoveryLink.source_tape_id] : [request.tapeId],
            ],
          )
        ).rows;
        const tapeById = new Map(tapeRows.map((row) => [row.tape_id, row]));
        const tape = tapeById.get(request.tapeId);
        if (!tape) return { applied: "incomplete" };
        if (!sameLosslessTurnTapeHeader(tape, request)) {
          throw new Error("lossless turn tape finalize header conflict");
        }
        const publishesVisiblePhaseARecords =
          tape.visible_at !== null && tape.materialization_status !== "complete";
        const recoverySourceTape = recoveryLink
          ? tapeById.get(recoveryLink.source_tape_id)
          : undefined;
        if (recoveryLink && (
          !recoverySourceTape ||
          recoverySourceTape.finalized_at === null ||
          recoverySourceTape.status !== "crashed" ||
          tape.status !== "completed" ||
          recoverySourceTape.tape_sha256 !== recoveryLink.source_tape_sha256 ||
          recoverySourceTape.turn_key !== recoveryLink.source_turn_key ||
          recoverySourceTape.billing_anchor_id === null ||
          recoverySourceTape.dispatch_id === null ||
          recoverySourceTape.agent_id !== tape.agent_id ||
          recoverySourceTape.turn_index !== tape.turn_index ||
          recoverySourceTape.created_at !== tape.created_at
        )) {
          throw new Error("turn tape recovery source identity conflict");
        }
        if (recoveryLink) {
          const sourceDispatch = await client.query(
            `SELECT 1 FROM turn_dispatches
              WHERE dispatch_id=$1 AND user_id=$2 AND session_id=$3 AND agent_id=$4
                AND status='terminal' AND outcome='crashed'
              LIMIT 1 FOR UPDATE`,
            [
              recoverySourceTape!.dispatch_id,
              numericCommercialUserId(userId),
              request.sessionId,
              recoverySourceTape!.agent_id,
            ],
          );
          if ((sourceDispatch.rowCount ?? 0) !== 1) {
            throw new Error("turn tape recovery source dispatch is no longer an authoritative crash");
          }
        }
        if (recoveryLink && (
          request.waiveReason !== undefined || request.dispatchId !== undefined ||
          request.attemptNo !== undefined || tape.waive_reason !== null ||
          tape.dispatch_id !== null || tape.attempt_no !== null
        )) {
          throw new Error("turn tape recovery header is not content-only");
        }
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
            const convergence = await convergeDispatchOnFinalize(
              client,
              tape.dispatch_id,
              tape.status,
              request.settlement?.errorCode ?? errorCodeFromVisibleHead(tape.visible_head),
            );
            replayLate = convergence.lateTape;
            await reconcileLiveStreamWithFinalTape(client, {
              dispatchId: tape.dispatch_id,
              status: tape.status,
              tapeId: request.tapeId,
              tapeSha256: request.tapeSha256,
            });
            if (convergence.removedVisibleStatus) {
              // 直接状态读以 dispatch.status 为准。late tape 改成 manual_reconcile 后 bump
              // revision，在线客户端会立刻重读并移除旧失败状态。
              await client.query(
                `UPDATE client_sessions
                    SET history_revision=history_revision + 1,
                        timeline_generation=timeline_generation + 1,
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
            ...(request.waiveReason !== undefined || (Array.isArray(tape.engine_billings) && tape.engine_billings.length > 0)
              ? { settlementHandoff: true }
              : {}),
            ...(replayLate ? { dispatchLateTape: true } : {}),
          };        }

        if (!prepared) {
          if (tape.visible_at !== null || (phaseA && phaseA.applied === "finalized")) {
            return {
              applied: "finalized",
              recordCount: 0,
              engineBillings: Array.isArray(tape.engine_billings)
                ? structuredClone(tape.engine_billings) as DurableCodexBilling[]
                : [],
              settlementHandoff: true,
            };
          }
          return { applied: "incomplete" };
        }
        if (tape.record_storage_format !== prepared.recordStorageFormat) {
          throw new Error("lossless turn tape materialization format changed before publication");
        }
        const turn = prepared.turn;
        const persistedBillings = Array.isArray(tape.engine_billings) ? tape.engine_billings : [];
        const canonicalRequestId = turn.engineBillings[0]?.requestId ?? turn.payload.requestId ?? null;
        const persistedRequestId = (persistedBillings as DurableCodexBilling[])[0]?.requestId
          ?? turn.payload.requestId
          ?? null;
        const canonicalSettlementHash = assertSettlementMatchesCanonical({
          canonicalAnchorId: turn.billingAnchorId,
          canonicalRequestId,
          canonicalBillings: turn.engineBillings,
          envelope: request.settlement
            ? {
                billingAnchorId: request.settlement.billingAnchorId,
                requestId: request.settlement.requestId,
                engineBillings: settlementEngineBillings(request.settlement),
              }
            : null,
          persistedHash: tape.settlement_hash,
          persistedAuthority: tape.settlement_hash && tape.billing_anchor_id
            ? {
                billingAnchorId: tape.billing_anchor_id,
                requestId: persistedRequestId,
                engineBillings: persistedBillings,
              }
            : null,
        });
        if (
          persistedBillings.length > 0 &&
          !settlementPayloadEqual(persistedBillings, turn.engineBillings)
        ) {
          throw new Error("lossless turn tape engineBillings mismatch");
        }
        // Parts are immutable once staged. Recheck only their manifest while
        // holding the tape row lock; source-part BYTEA concatenation,
        // JSON.parse and user-visible/model materialization already happened
        // before this transaction.
        if (
          await verifyPreparedPartManifest(client, userId, request, prepared.partManifest) !==
            "complete"
        ) {
          return { applied: "incomplete" };
        }

        // The unlocked summaries above are only a staging optimization. Rehash
        // both derived byte copies under the header lock so a row changed
        // between summary and publication can never be finalized on the
        // strength of stale declared hashes.
        const stagedRecords = (
          await client.query<{
            msg_id: string;
            ordinal: number;
            role: string;
            ts: string;
            content_sha256: string;
            payload_sha256: string;
            visible_content_sha256: string | null;
            visible_payload_sha256: string | null;
            model_sidecar_complete: boolean;
          }>(
            `SELECT msg_id,ordinal,role,ts::text,content_sha256,
                    encode(public.digest(payload,'sha256'),'hex') AS payload_sha256,
                    visible_content_sha256,
                    CASE WHEN visible_payload IS NULL THEN NULL
                         ELSE encode(public.digest(visible_payload,'sha256'),'hex') END
                      AS visible_payload_sha256,
                    model_sidecar_complete
               FROM client_session_turn_tape_records
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
              ORDER BY ordinal`,
            [request.sessionId, userId, request.tapeId],
          )
        ).rows;
        if (stagedRecords.length !== turn.records.length) {
          throw new Error("lossless turn tape staged record count mismatch");
        }
        for (let ordinal = 0; ordinal < stagedRecords.length; ordinal++) {
          const actual = stagedRecords[ordinal]!;
          const expected = turn.records[ordinal]!;
          const expectedVisible = prepared.visible[ordinal]!;
          if (
            actual.ordinal !== ordinal ||
            actual.msg_id !== expected.id ||
            actual.role !== expected.role ||
            bigIntNum(actual.ts, "staged turn tape record ts") !== expected.ts ||
            actual.content_sha256 !== expected.payloadSha256 ||
            actual.payload_sha256 !== expected.payloadSha256 ||
            actual.visible_content_sha256 !== expectedVisible.contentSha256 ||
            actual.visible_payload_sha256 !== expectedVisible.contentSha256 ||
            actual.model_sidecar_complete !== true
          ) {
            throw new Error("lossless turn tape staged record manifest conflict");
          }
        }
        const expectedModelSidecars = preparedModelSidecarManifest(prepared);
        const stagedModelSidecars = (
          await client.query<{
            physical_ordinal: number;
            logical_ordinal: number;
            msg_id: string;
            role: string;
            semantic_text: string;
            token_estimate: number;
            ts: string | null;
            client_message_id: string | null;
          }>(
            `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                    token_estimate,ts::text,client_message_id
               FROM client_session_turn_tape_model_records
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
              ORDER BY physical_ordinal,logical_ordinal`,
            [request.sessionId, userId, request.tapeId],
          )
        ).rows;
        if (stagedModelSidecars.length !== expectedModelSidecars.length) {
          throw new Error("lossless turn tape staged model record count mismatch");
        }
        for (let index = 0; index < stagedModelSidecars.length; index++) {
          const actual = stagedModelSidecars[index]!;
          const expected = expectedModelSidecars[index]!;
          if (
            actual.physical_ordinal !== expected.physicalOrdinal ||
            actual.logical_ordinal !== expected.logicalOrdinal ||
            actual.msg_id !== expected.msgId ||
            actual.role !== expected.role ||
            actual.semantic_text !== expected.semanticText ||
            actual.token_estimate !== expected.tokenEstimate ||
            (actual.ts === null ? null : bigIntNum(actual.ts, "staged model record ts")) !==
              expected.ts ||
            actual.client_message_id !== expected.clientMessageId
          ) {
            throw new Error("lossless turn tape staged model record manifest conflict");
          }
        }
        const modelRecordCount = preparedModelRecordCount;

        let existingMessages: MessageLike[];
        try {
          const parsed = JSON.parse(session.messages);
          if (!Array.isArray(parsed)) throw new Error("not array");
          existingMessages = parsed as MessageLike[];
        } catch {
          throw new Error("lossless turn tape target session row malformed");
        }

        if (recoveryLink) {
          if (
            request.waiveReason !== undefined || request.dispatchId !== undefined ||
            request.attemptNo !== undefined || tape.waive_reason !== null ||
            tape.dispatch_id !== null || tape.attempt_no !== null ||
            tape.client_message_id !== null || turn.payload.waiveReason !== undefined ||
            turn.payload.clientMessageId !== undefined || turn.payload.requestId !== undefined ||
            turn.payload.goalId !== undefined || turn.payload.goalStateRevision !== undefined ||
            turn.engineBillings.length !== 0
          ) {
            throw new Error("turn tape recovery payload is not content-only");
          }
          const source = recoverySourceTape!;
          if (turn.billingAnchorId !== source.billing_anchor_id) {
            throw new Error("turn tape recovery billing anchor does not match source");
          }
          const sourceAnchors = existingMessages.filter(
            (message) => message?._turnTapeId === recoveryLink.source_tape_id,
          );
          if (
            sourceAnchors.length !== 1 || sourceAnchors[0]?._turnTapeComplete !== true ||
            sourceAnchors[0]?.id !== source.billing_anchor_id
          ) {
            throw new Error("turn tape recovery source no longer owns one complete hot anchor");
          }
          const sourceUsage = await readRecoverySourceUsage(
            client,
            request.sessionId,
            userId,
            recoveryLink.source_tape_id,
            source.billing_anchor_id!,
          );
          assertRecoveryUsageFallback(turn.payload.usage, sourceUsage);
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
        if (recoveryLink && pending.length > 0) {
          throw new Error("turn tape recovery has pending financial rows");
        }
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
        // hot legacy generated rows with the single tape anchor; keeping both
        // would make hydration return duplicate paid records. Archived
        // collisions stay fail-closed above because rewriting archive chunks
        // is not part of this atomic finalize operation.
        const preUpgradeMessages = existingMessages;
        const recordIds = new Set(allRecordIds);
        existingMessages = existingMessages.filter(
          (message) =>
            message?._turnTapeId !== request.tapeId &&
            (typeof message?.id !== "string" || !recordIds.has(message.id)),
        );
        const plan = planAppendServerAuthoredBatch(
          existingMessages,
          anchors,
          typeof session.next_seq === "number" && session.next_seq > 0 ? session.next_seq : 1,
          bigIntNumOr(session.archived_through_seq, 0),
        );
        if (plan.kind === "oversized") throw new Error("lossless turn tape anchor tail unexpectedly oversized");
        let phaseBIdentityAdvanced = false;
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
          const removedInvisibleMessage = hasInvisibleMessageRemoval(
            preUpgradeMessages,
            existingMessages,
          );
          const historyRevisionDelta =
            publishesVisiblePhaseARecords ||
            hasInvisibleMessageRemoval(preUpgradeMessages, plan.tail) ||
            archivedDelta > 0
              ? 1
              : 0;
          const timelineGenerationDelta =
            publishesVisiblePhaseARecords || removedInvisibleMessage ? 1 : 0;
          await client.query(
            `UPDATE client_sessions SET
               messages=$1, message_count=$2, last_at=$3,
               updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
               next_seq=$4, archived_through_seq=$5, archived_count=$6,
               history_revision=history_revision + $9,
               timeline_generation=timeline_generation + $10
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
              historyRevisionDelta,
              timelineGenerationDelta,
            ],
          );
          phaseBIdentityAdvanced = publishesVisiblePhaseARecords;
        }
        if (publishesVisiblePhaseARecords && !phaseBIdentityAdvanced) {
          // Defensive no-write path: exact records still replaced a visible
          // fallback even if the hot anchor happened to be byte-identical.
          await advanceClientTimelineIdentityInTransaction(
            client,
            request.sessionId,
            userId,
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
        const clientMessageId = turn.payload.clientMessageId ?? (
          tape.dispatch_id === null
            ? null
            : (
                await client.query<{ client_message_id: string }>(
                  "SELECT client_message_id FROM turn_dispatches WHERE dispatch_id=$1",
                  [tape.dispatch_id],
                )
              ).rows[0]?.client_message_id ?? null
        );
        await client.query(
          `UPDATE client_session_turn_tapes
              SET billing_anchor_id=$1, usage=$2, parent_turn_key=$3,
                  engine_billings=$4, finalized_at=$5,
                  visible_at=COALESCE(visible_at,$5),
                  materialization_status='complete',
                  settlement_verified_at=COALESCE(settlement_verified_at, NOW()),
                  materialization_error=NULL,
                  record_storage_format=$6,
                  goal_id=$7::uuid, goal_state_revision=$8, goal_tokens_used=$9,
                  client_message_id=$10, continuation_of_turn_key=$11,
                  physical_record_count=$12, logical_record_count=$13,
                  record_payload_bytes=$14, model_record_count=$15,
                  settlement_hash=CASE WHEN settlement_hash IS NULL THEN NULL ELSE $16 END
            WHERE session_id=$17 AND user_id=$18 AND tape_id=$19`,
          [
            turn.billingAnchorId,
            JSON.stringify(sanitizeValueForPgJsonb(turn.payload.usage ?? {})),
            turn.payload.parentTurnKey ?? null,
            JSON.stringify(sanitizeValueForPgJsonb(turn.engineBillings)),
            Date.now(),
            prepared.recordStorageFormat,
            turn.payload.goalId ?? null,
            turn.payload.goalStateRevision ?? null,
            goalTokensUsed,
            clientMessageId,
            turn.payload.continuationOfTurnKey ?? null,
            turn.records.length,
            turn.logicalRecordCount,
            prepared.recordPayloadBytes,
            modelRecordCount,
            canonicalSettlementHash,
            request.sessionId,
            userId,
            request.tapeId,
          ],
        );
        if (tape.settlement_hash !== null && tape.settlement_hash !== canonicalSettlementHash) {
          await client.query(
            `UPDATE turn_tape_settlement_jobs
                SET settlement_hash=$4, updated_at=NOW()
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
                AND settlement_hash IS DISTINCT FROM $4`,
            [request.sessionId, userId, request.tapeId, canonicalSettlementHash],
          );
        }
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
        // dispatch 收敛(RFC §2.4):tape header 带 dispatch_id → 非终态转 terminal(映射 status),
        // 或迟到 tape 转 manual_reconcile。浏览器直接读 tape/dispatch，不再写任何影子内容表。
        let dispatchLate = false;
        if (tape.dispatch_id !== null) {
          const convergence = await convergeDispatchOnFinalize(
            client,
            tape.dispatch_id,
            tape.status,
            request.settlement?.errorCode ?? errorCodeFromVisibleHead(tape.visible_head),
          );
          dispatchLate = convergence.lateTape;
          await reconcileLiveStreamWithFinalTape(client, {
            dispatchId: tape.dispatch_id,
            status: tape.status,
            tapeId: request.tapeId,
            tapeSha256: request.tapeSha256,
          });
          if (convergence.removedVisibleStatus) {
            // 当前事务已持 session 锁；revision 让浏览器移除此前的 verified failure 状态。
            await client.query(
              `UPDATE client_sessions
                  SET history_revision=history_revision + 1,
                      timeline_generation=timeline_generation + 1,
                      updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
                WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
              [request.sessionId, userId],
            );
          }
        }
        if (!dispatchLate) {
          await releaseSettlementJobsAfterVerify(client, {
            sessionId: request.sessionId,
            userId,
            tapeId: request.tapeId,
          });
        }
        if (billingUserId !== null && !turn.payload.continuationOfTurnKey) {
          await scheduleAutomaticRecoveryForFinalizedTurn(client, {
            uid: billingUserId,
            sessionUserId: userId,
            sessionId: request.sessionId,
            turn,
            clientMessageId,
            tapeSha256: request.tapeSha256,
            currentMessages: existingMessages,
          });
        }
        return {
          applied: "finalized",
          recordCount: turn.records.length,
          engineBillings: turn.engineBillings.map((billing) => structuredClone(billing)),
          ...(turn.engineBillings.length > 0 || request.waiveReason !== undefined
            ? { settlementHandoff: true }
            : {}),
          ...(dispatchLate ? { dispatchLateTape: true, settlementHeld: true } : {}),
        };            });
            break;
          } catch (error) {
            if (error instanceof TurnTapeRecoveryLockUpgrade && lockAttempt === 0) {
              recoveryLockHint = error.link;
              continue;
            }
            throw error;
          }
        }
      } finally {
        releaseFinalizeAdmission?.();
      }
      if (goalUsageChanged && result.applied === "finalized") {
        await notifyGoalUsageChanges(options.onGoalUsageChanged, [{ userId, sessionId: request.sessionId }]);
      }
      return result;
        },
      );
      const completed = await flight.promise;
      return flight.shared && completed.applied === "finalized"
        ? { ...completed, applied: "idempotent" }
        : completed;
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
              "client_session_turn_tape_model_records",
              "client_session_user_payloads",
              "server_authored_turn_anchor_map",
              "turn_tape_cost_components",
              "turn_tape_recovery_links",
              "turn_dispatches",
              "turn_tape_materialization_jobs",
              "turn_tape_settlement_jobs",
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
          const timelineGenerationDelta = existing && hasInvisibleMessageRemoval(oldMsgs, finalMessages)
            ? 1
            : 0;

          const res = await client.query(
            `INSERT INTO client_sessions
               (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq, archived_through_seq, archived_count, model_id, history_revision, timeline_generation)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, GREATEST($10, ${CLOCK_MS_SQL}), $11, $12, $13, $15, 0, 1)
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
               history_revision = client_sessions.history_revision + $16,
               timeline_generation = client_sessions.timeline_generation + $17
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
              timelineGenerationDelta,
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
        role: "assistant" | "user" | "system" | "thinking" | "tool" | "agent-group" | "permission";
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

    async patchServerAuthoredMessage(
      sessId: string,
      userId: string,
      msgId: string,
      patch: Record<string, unknown>,
    ): Promise<{ applied: true } | { applied: false; reason: "session_not_found" | "session_deleted" | "not_found" }> {
      return withTx(pool, async (client) => {
        const row = await client.query<{
          messages: unknown
          next_seq: number | null
          deleted_at: Date | string | null
        }>(
          "SELECT messages, next_seq, deleted_at FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [sessId, userId],
        );
        if (row.rowCount === 0) return { applied: false as const, reason: "session_not_found" as const };
        const rec = row.rows[0]!;
        if (rec.deleted_at != null) return { applied: false as const, reason: "session_deleted" as const };
        const msgs = Array.isArray(rec.messages) ? rec.messages as Array<Record<string, unknown>> : null;
        if (!msgs) return { applied: false as const, reason: "not_found" as const };
        const idx = msgs.findIndex((m) => m && m.id === msgId);
        if (idx < 0) return { applied: false as const, reason: "not_found" as const };
        const nextSeq = typeof rec.next_seq === "number" && rec.next_seq > 0 ? rec.next_seq : 1;
        msgs[idx] = { ...msgs[idx], ...patch, id: msgId, _source: "server", _seq: nextSeq };
        const upd = await client.query(
          "UPDATE client_sessions SET messages = $1::jsonb, updated_at = GREATEST(updated_at + 1, $2), next_seq = $3, history_revision = history_revision + 1 WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL",
          [JSON.stringify(msgs), Date.now(), nextSeq + 1, sessId, userId],
        );
        if (upd.rowCount !== 1) return { applied: false as const, reason: "session_deleted" as const };
        return { applied: true as const };
      });
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
          return stripWorkspaceMode(r);
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
        if (!r.applied) return stripWorkspaceMode(r);

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
    async listClientSessions(
      userId: string,
      opts: ListClientSessionsOpts = {},
    ): Promise<ListClientSessionsResult> {
      // runState / lastOutcome / lastErrorCode 从 turn_dispatches 一条 SQL 派生。
      // inbox 在容器 SQLite;master 权威是 turn_dispatches(status/outcome/failure_code)。
      // last_preview_raw:数组尾部最多 20 条里最近非空 .text(线上 assistant 无 text);
      // octet_length > 2MB 不展开,不把 messages blob 拉进 Node。
      const dispatchUid = dispatchUidForList(userId);
      const includeArchived = opts.includeArchived === true;
      const before = typeof opts.before === "number" && Number.isFinite(opts.before) && opts.before > 0
        ? Math.floor(opts.before)
        : undefined;
      const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.min(SESSION_LIST_LIMIT_MAX, Math.floor(opts.limit))
        : undefined;
      const params: unknown[] = [userId, dispatchUid];
      let where = "cs.user_id = $1 AND cs.deleted_at IS NULL";
      if (!includeArchived) where += " AND cs.archived_at IS NULL";
      if (before !== undefined) {
        params.push(before);
        where += ` AND cs.last_at < $${params.length}`;
      }
      const limitSql = limit !== undefined ? ` LIMIT ${limit + 1}` : "";
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
          project_id: string | null;
          archived_at: string | null;
          last_preview_raw: string | null;
          run_state: string;
          last_outcome: string | null;
          last_error_code: string | null;
          unread: boolean;
        }>(
          `SELECT cs.id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at, cs.updated_at,
                  cs.message_count AS msg_count, cs.model_id, cs.project_id, cs.archived_at,
                  CASE WHEN octet_length(cs.messages) > ${SESSION_SEARCH_JSON_EXPAND_MAX_BYTES}
                            OR left(COALESCE(cs.messages, ''), 1) <> '['
                            OR position((chr(92) || 'u0000') in cs.messages) > 0 THEN NULL
                       ELSE (
                         SELECT LEFT(txt, 240)
                           FROM (
                             SELECT btrim(elem->>'text') AS txt
                               FROM json_array_elements(cs.messages::json)
                                    WITH ORDINALITY AS t(elem, n)
                              ORDER BY n DESC
                              LIMIT ${LAST_MESSAGE_PREVIEW_TAIL_MAX}
                           ) tail
                          WHERE txt IS NOT NULL AND length(txt) > 0
                          LIMIT 1
                       ) END AS last_preview_raw,
                  CASE WHEN open_d.session_id IS NOT NULL THEN 'running' ELSE 'idle' END AS run_state,
                  last_d.outcome AS last_outcome,
                  last_d.failure_code AS last_error_code,
                  (last_d.outcome IN (${UNREAD_OUTCOME_SQL})
                   AND ${LAST_D_TERMINAL_MS_SQL} > ${LAST_READ_AT_MS_SQL}) AS unread
             FROM client_sessions cs
             LEFT JOIN (
               SELECT session_id FROM turn_dispatches
                WHERE user_id = $2
                  AND status IN ('admitted', 'accepted', 'rejecting')
                GROUP BY session_id
             ) open_d ON open_d.session_id = cs.id
             LEFT JOIN (
               SELECT session_id, outcome, failure_code, terminal_at FROM (
                 SELECT session_id, outcome, failure_code, terminal_at,
                        ROW_NUMBER() OVER (
                          PARTITION BY session_id
                          ORDER BY terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC
                        ) AS rn
                   FROM turn_dispatches
                  WHERE user_id = $2 AND status = 'terminal'
               ) ranked
               WHERE rn = 1
             ) last_d ON last_d.session_id = cs.id
            WHERE ${where}
            ORDER BY cs.last_at DESC${limitSql}`,
          params,
        )
      ).rows;
      let sliced = rows;
      let nextCursor: number | undefined;
      if (limit !== undefined && rows.length > limit) {
        sliced = rows.slice(0, limit);
        const last = sliced[sliced.length - 1];
        if (last) nextCursor = bigIntNum(last.last_at, "last_at");
      }
      return {
        sessions: sliced.map((r) => {
          const preview = toLastMessagePreview(r.last_preview_raw);
          return {
            id: r.id,
            agentId: r.agent_id,
            title: r.title,
            pinned: r.pinned === 1,
            createdAt: bigIntNum(r.created_at, "created_at"),
            lastAt: bigIntNum(r.last_at, "last_at"),
            messageCount: r.msg_count,
            updatedAt: bigIntNum(r.updated_at, "updated_at"),
            projectId: r.project_id ?? null,
            runState: r.run_state === "running" ? "running" : "idle",
            lastOutcome: mapClientSessionLastOutcome(r.last_outcome),
            lastErrorCode: r.last_error_code ?? null,
            unread: r.unread === true,
            archived: r.archived_at != null,
            ...(preview ? { lastMessagePreview: preview } : {}),
            ...(r.model_id ? { modelId: r.model_id } : {}),
          };
        }),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },

    async getClientSession(
      id: string,
      userId?: string,
      options: ClientSessionReadOptions = {},
    ): Promise<ClientSession | null> {
      const sql = userId
        ? `SELECT cs.id, cs.user_id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at,
                  cs.messages, cs.updated_at, cs.archived_through_seq, cs.history_revision,
                  cs.timeline_generation, cs.model_id,
                  COALESCE((
                    SELECT SUM(ac.message_count) FROM client_session_archive_chunks ac
                     WHERE ac.session_id=cs.id AND ac.user_id=cs.user_id
                  ), 0)::text AS archived_count
             FROM client_sessions cs
            WHERE cs.id=$1 AND cs.user_id=$2 AND cs.deleted_at IS NULL`
        : `SELECT cs.id, cs.user_id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at,
                  cs.messages, cs.updated_at, cs.archived_through_seq, cs.history_revision,
                  cs.timeline_generation, cs.model_id,
                  COALESCE((
                    SELECT SUM(ac.message_count) FROM client_session_archive_chunks ac
                     WHERE ac.session_id=cs.id AND ac.user_id=cs.user_id
                  ), 0)::text AS archived_count
             FROM client_sessions cs
            WHERE cs.id=$1 AND cs.deleted_at IS NULL`;
      const read = async (
        queryable: Pool | PoolClient,
        snapshotClient?: PoolClient,
      ): Promise<ClientSession | null> => {
        const row = (
          await queryable.query<{
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
          archived_count: string;
          history_revision: string;
          timeline_generation: string;
          model_id: string | null;
          }>(sql, userId ? [id, userId] : [id])
        ).rows[0];
        if (!row) return null;
        const archivedThroughOrderSeq = bigIntNumOr(row.archived_through_seq, 0);
        const parsedMessages = deriveOrderSeqsForRead(
          JSON.parse(row.messages) as MessageLike[],
          archivedThroughOrderSeq,
        );
        const timelinePage = options.view === "timeline"
          ? await readClientTimelinePageImpl(pool, row.id, row.user_id, null, 100, snapshotClient)
          : null;
        const messages = timelinePage
          ? timelinePage.messages
          : await hydrateTurnTapeMessages(pool, row.id, row.user_id, parsedMessages, options);
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
          historyRevision: timelinePage?.historyRevision ??
            bigIntNum(row.history_revision, "history_revision"),
          timelineGeneration: timelinePage?.timelineGeneration ??
            bigIntNum(row.timeline_generation, "timeline_generation"),
          ...(timelinePage
            ? {
                timelineCursor: timelinePage.nextCursor,
                timelineHasMore: timelinePage.hasMore,
                timelineSnapshotMaxSeq: timelinePage.snapshotMaxSeq,
              }
            : {}),
          ...(row.model_id ? { modelId: row.model_id } : {}),
          // archived_count 是写侧缓存计数；存量迁移曾有极少数漂移。详情读以 chunk.message_count
          // 实际合计为准，读尽后不会留下“还有 N 条”的幽灵按钮。
          archivedCount: bigIntNum(row.archived_count, "archived chunk message count"),
          archivedThroughSeq: archivedThroughOrderSeq,
          ...(await readOpenDispatchForSession(queryable, row.id, row.user_id)),
        };
      };
      return options.view === "timeline"
        ? withTimelineSnapshot(pool, (client) => read(client, client))
        : read(pool);
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
      const read = async (
        queryable: Pool | PoolClient,
        snapshotClient?: PoolClient,
      ): Promise<ClientSessionPartial | null> => {
        const row = (
          await queryable.query<{
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
          archived_count: string;
          history_revision: string;
          timeline_generation: string;
          model_id: string | null;
          }>(
            `SELECT cs.id, cs.user_id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at,
                  cs.messages, cs.updated_at, cs.archived_through_seq, cs.history_revision,
                  cs.timeline_generation, cs.model_id,
                  COALESCE((
                    SELECT SUM(ac.message_count) FROM client_session_archive_chunks ac
                     WHERE ac.session_id=cs.id AND ac.user_id=cs.user_id
                  ), 0)::text AS archived_count
             FROM client_sessions cs
            WHERE cs.id=$1 AND cs.user_id=$2 AND cs.deleted_at IS NULL`,
            [id, userId],
          )
        ).rows[0];
        if (!row) return null;
        const archivedCount = bigIntNum(row.archived_count, "archived chunk message count");
        const archivedThroughSeq = bigIntNumOr(row.archived_through_seq, 0);

        if (options.view === "timeline") {
          const page = await readClientTimelinePageImpl(
            pool,
            row.id,
            row.user_id,
            null,
            100,
            snapshotClient,
          );
          if (!page) return null;
          return {
            id: row.id,
            userId: row.user_id,
            agentId: row.agent_id,
            title: row.title,
            pinned: row.pinned === 1,
            createdAt: bigIntNum(row.created_at, "created_at"),
            lastAt: bigIntNum(row.last_at, "last_at"),
            messages: page.messages,
            updatedAt: bigIntNum(row.updated_at, "updated_at"),
            historyRevision: page.historyRevision,
            timelineGeneration: page.timelineGeneration,
            timelineCursor: page.nextCursor,
            timelineHasMore: page.hasMore,
            timelineSnapshotMaxSeq: page.snapshotMaxSeq,
            ...(row.model_id ? { modelId: row.model_id } : {}),
            totalMessageCount: page.messages.length + archivedCount,
            maxSeq: page.snapshotMaxSeq,
            isPartial: false,
            archivedCount,
            archivedThroughSeq,
          };
        }

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
      };
      return options.view === "timeline"
        ? withTimelineSnapshot(pool, (client) => read(client, client))
        : read(pool);
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

      const messagePool: MessageLike[] = [];
      let beforeLastSeq: number | null = null;
      for (;;) {
        const chunkRows = (
          await pool.query<{ messages: string; last_seq: string }>(
            `SELECT messages, last_seq FROM client_session_archive_chunks
               WHERE session_id = $1 AND user_id = $2 AND first_seq < $3::bigint
                 AND ($4::bigint IS NULL OR last_seq < $4)
               ORDER BY last_seq DESC
               LIMIT 4`,
            [sessId, userId, effectiveBefore, beforeLastSeq],
          )
        ).rows;
        if (chunkRows.length === 0) break;
        for (const cr of chunkRows) {
          beforeLastSeq = bigIntNum(cr.last_seq, "archive last_seq");
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
        if (messagePool.length > cappedLimit || chunkRows.length < 4) break;
      }
      messagePool.sort(compareMessagesByOrder);
      const hasMore = messagePool.length > cappedLimit;
      const page = messagePool.slice(Math.max(0, messagePool.length - cappedLimit));
      const oldestSeq = page.length > 0 && typeof page[0]._orderSeq === "number"
        ? page[0]._orderSeq
        : null;
      let hydrated = await hydrateTurnTapeMessages(pool, sessId, userId, page, options);
      if (options.view === "timeline" && page.length > 0 && oldestSeq !== null) {
        // 只并入锚落在本页 seq 范围内的 verified statuses。
        hydrated = await mergeVerifiedTurnStatusRows(pool, userId, sessId, hydrated, {
          minInclusive: oldestSeq,
          maxExclusive: effectiveBefore,
        });
      }
      return { messages: hydrated, hasMore, oldestSeq, historyRevision };
    },

    async readClientSessionLiveFrames(
      sessionId: string,
      userId: string,
      afterRecordId = 0,
      limit = 200,
      options?: { seekTail?: boolean },
    ) {
      return readDurableClientSessionLiveFrames(
        pool,
        sessionId,
        userId,
        afterRecordId,
        limit,
        options,
      );
    },

    async readClientSessionLiveUnits(
      sessionId: string,
      userId: string,
      options?: {
        n?: number
        k?: number
        before?: string | null
        group?: string | null
        nestedBefore?: string | null
        deadlineMs?: number
        maxBytes?: number
      },
    ) {
      return readDurableClientSessionLiveUnits(pool, sessionId, userId, options);
    },

    async readLiveOrTapeFramePayload(
      sessionId: string,
      userId: string,
      ref: { recordId?: string | null; sha256?: string | null },
    ) {
      return readDurableLiveOrTapeFramePayload(pool, sessionId, userId, ref);
    },

    async convergeFinalizedTapeLiveStreams() {
      return convergeFinalizedTapeLiveStreams(pool);
    },

    async readClientTimelinePage(
      sessionId: string,
      userId: string,
      cursor: ClientTimelineCursor | null = null,
      limit = 100,
    ): Promise<ClientTimelinePage | null> {
      return readClientTimelinePageImpl(pool, sessionId, userId, cursor, limit);
    },

    // ── 引擎上下文读 ─────────────────────────────────────────────────────────
    async getEngineContextMessages(
      sessionId: string,
      userId: string,
      options: EngineContextReadOptions = {},
    ): Promise<MessageLike[] | null> {
      return computeEngineContextMessages(pool, sessionId, userId, options);
    },

    async hasCompletedClientTurn(
      sessionId: string,
      userId: string,
      clientMessageId: string,
    ): Promise<boolean> {
      return hasCompletedClientTurnImpl(pool, sessionId, userId, clientMessageId);
    },

    // ── immutable tape lazy reads ─────────────────────────────────────────────
    async listTurnTapeRecords(
      sessionId: string,
      userId: string,
      tapeId: string,
      cursor: number,
      limit: number,
      before?: number | null,
    ): Promise<{
      records: MessageLike[];
      nextCursor: number | null;
      total: number;
    } | null> {
      return listTurnTapeRecordsImpl(pool, sessionId, userId, tapeId, cursor, limit, before);
    },

    async readTapeRecordPayload(
      sessionId: string,
      userId: string,
      tapeId: string,
      recordOrdinal: number,
      offset = 0,
      length?: number,
    ): Promise<TapeRecordPayload | null> {
      return readTapeRecordPayloadImpl(
        pool,
        sessionId,
        userId,
        tapeId,
        recordOrdinal,
        offset,
        length,
      );
    },

    async readTapeRecordPayloadChunk(
      sessionId: string,
      userId: string,
      tapeId: string,
      recordOrdinal: number,
      offset: number,
      requestedBytes?: number,
    ): Promise<TapeRecordPayloadChunk | null> {
      return readTapeRecordPayloadChunkImpl(
        pool,
        sessionId,
        userId,
        tapeId,
        recordOrdinal,
        offset,
        requestedBytes,
      );
    },

    async readUserMessagePayload(
      sessionId: string,
      userId: string,
      msgId: string,
      offset = 0,
      length?: number,
    ) {
      return readUserMessagePayloadImpl(pool, sessionId, userId, msgId, offset, length);
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
        await client.query(
          "DELETE FROM client_session_user_payloads WHERE session_id=$1" +
            (userId ? " AND user_id=$2" : ""),
          userId ? [id, userId] : [id],
        );
        // 归档级联清理(同事务,防"主行已删、归档还在"孤儿)。D3:delete 级联也清 parent_session_id
        // 指向该会话的 delegate pending(防永不 drain 的孤儿)。
        await client.query("DELETE FROM client_session_archive_chunks WHERE session_id = $1", [id]);
        await client.query("DELETE FROM client_session_archived_ids WHERE session_id = $1", [id]);
        await client.query("DELETE FROM turn_tape_recovery_links WHERE session_id = $1", [id]);
        await client.query("DELETE FROM client_session_turn_tapes WHERE session_id = $1", [id]);
        await client.query("DELETE FROM pending_usage_patches WHERE parent_session_id = $1", [id]);
        // Keep dispatch evidence so the reconciler can close any execution that
        // raced with deletion and financial/audit history remains attributable.
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

    async patchClientSessionMeta(
      id: string,
      userId: string,
      patch: ClientSessionMetaPatch,
    ): Promise<PatchClientSessionMetaResult> {
      return withTx(pool, async (client) => {
        const ownedSession = (
          await client.query(
            "SELECT 1 FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            [id, userId],
          )
        ).rows[0];
        if (!ownedSession) return { ok: false, error: "not_found" };
        if (patch.projectId !== undefined && patch.projectId !== null) {
          const owned = (
            await client.query(
              "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
              [patch.projectId, userId],
            )
          ).rows[0];
          if (!owned) return { ok: false, error: "project_not_found" };
        }
        const sets: string[] = [`updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})`];
        const params: unknown[] = [];
        let n = 1;
        if (patch.title !== undefined) {
          sets.push(`title = $${n++}`);
          params.push(patch.title);
        }
        if (patch.modelId !== undefined) {
          sets.push(`model_id = $${n++}`);
          params.push(patch.modelId);
        }
        if (patch.projectId !== undefined) {
          sets.push(`project_id = $${n++}`);
          params.push(patch.projectId);
        }
        if (patch.pinned !== undefined) {
          sets.push(`pinned = $${n++}`);
          params.push(patch.pinned ? 1 : 0);
        }
        if (patch.archived !== undefined) {
          sets.push(`archived_at = $${n++}`);
          params.push(patch.archived ? Date.now() : null);
        }
        params.push(id, userId);
        const row = (
          await client.query<{ updated_at: string }>(
            `UPDATE client_sessions SET ${sets.join(", ")}
              WHERE id = $${n++} AND user_id = $${n} AND deleted_at IS NULL
              RETURNING updated_at`,
            params,
          )
        ).rows[0];
        if (!row) return { ok: false, error: "not_found" };
        return { ok: true, updatedAt: bigIntNum(row.updated_at, "updated_at") };
      });
    },

    async getSessionProjectInstructions(sessionId: string): Promise<string | null> {
      const row = (
        await pool.query<{ instructions: string | null }>(
          `SELECT p.instructions
             FROM client_sessions cs
             JOIN chat_projects p ON p.id = cs.project_id AND p.user_id = cs.user_id
            WHERE cs.id = $1 AND cs.deleted_at IS NULL AND p.deleted_at IS NULL`,
          [sessionId],
        )
      ).rows[0];
      if (!row?.instructions) return null;
      const cleaned = sanitizeProjectInstructions(row.instructions).trim();
      return cleaned.length > 0 ? cleaned : null;
    },

    async searchClientSessions(
      userId: string,
      opts: SearchClientSessionsOpts,
    ): Promise<SearchClientSessionsResult> {
      const q = opts.q.trim();
      if (!q) return { results: [] };
      const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.min(SESSION_SEARCH_LIMIT_MAX, Math.floor(opts.limit))
        : SESSION_SEARCH_LIMIT_DEFAULT;
      const includeArchived = opts.includeArchived === true;
      const like = `%${escapeLikePattern(q)}%`;
      const archiveSql = includeArchived ? "" : " AND cs.archived_at IS NULL";
      const candMax = SESSION_SEARCH_JSON_CANDIDATE_MAX;
      const expandMax = SESSION_SEARCH_JSON_EXPAND_MAX_BYTES;
      const titleRows = (
        await pool.query<{
          id: string;
          title: string;
          project_id: string | null;
          last_at: string;
        }>(
          `SELECT id, title, project_id, last_at
             FROM client_sessions cs
            WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}
              AND cs.title ILIKE $2 ESCAPE '\\'`,
          [userId, like],
        )
      ).rows;
      // 正文在 client_sessions.messages(TEXT JSON) 与 spill 的
      // client_session_archive_chunks.messages。两段式:先 TEXT ILIKE 收窄(不解析 JSON),
      // 按 last_at DESC 取最近 N 条候选;octet_length > 2MB 的行只出一条 TEXT snippet,
      // 不对 67MB/90MB 级 tape 做 json_array_elements。
      const msgRows = (
        await pool.query<{
          id: string;
          title: string;
          project_id: string | null;
          matched_at: string;
          msg_text: string;
        }>(
          `WITH text_hits AS (
             SELECT cs.id, cs.title, cs.project_id, cs.last_at, cs.messages,
                    octet_length(cs.messages) AS msg_bytes
               FROM client_sessions cs
              WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}
                AND cs.messages ILIKE $2 ESCAPE '\\'
              ORDER BY cs.last_at DESC
              LIMIT $3
           )
           SELECT c.id, c.title, c.project_id,
                  COALESCE((elem->>'ts')::bigint, c.last_at)::text AS matched_at,
                  LEFT(COALESCE(elem->>'text', ''), 400) AS msg_text
             FROM text_hits c
             CROSS JOIN LATERAL json_array_elements(
               CASE WHEN left(c.messages, 1) = '['
                          AND position((chr(92) || 'u0000') in c.messages) = 0
                    THEN c.messages::json ELSE '[]'::json END
             ) elem
            WHERE c.msg_bytes <= $4
              AND position((chr(92) || 'u0000') in c.messages) = 0
              AND elem->>'text' ILIKE $2 ESCAPE '\\'
           UNION ALL
           SELECT c.id, c.title, c.project_id,
                  c.last_at::text AS matched_at,
                  substring(c.messages FROM GREATEST(1, strpos(lower(c.messages), lower($5)) - 80) FOR 400) AS msg_text
             FROM text_hits c
            WHERE c.msg_bytes > $4
               OR position((chr(92) || 'u0000') in c.messages) > 0`,
          [userId, like, candMax, expandMax, q],
        )
      ).rows;
      const chunkRows = (
        await pool.query<{
          id: string;
          title: string;
          project_id: string | null;
          matched_at: string;
          msg_text: string;
        }>(
          `WITH text_hits AS (
             SELECT cs.id, cs.title, cs.project_id, cs.last_at, ch.messages,
                    octet_length(ch.messages) AS msg_bytes
               FROM client_session_archive_chunks ch
               JOIN client_sessions cs ON cs.id = ch.session_id AND cs.user_id = ch.user_id
              WHERE cs.user_id = $1 AND cs.deleted_at IS NULL${archiveSql}
                AND ch.messages ILIKE $2 ESCAPE '\\'
              ORDER BY cs.last_at DESC
              LIMIT $3
           )
           SELECT c.id, c.title, c.project_id,
                  COALESCE((elem->>'ts')::bigint, c.last_at)::text AS matched_at,
                  LEFT(COALESCE(elem->>'text', ''), 400) AS msg_text
             FROM text_hits c
             CROSS JOIN LATERAL json_array_elements(
               CASE WHEN left(c.messages, 1) = '['
                          AND position((chr(92) || 'u0000') in c.messages) = 0
                    THEN c.messages::json ELSE '[]'::json END
             ) elem
            WHERE c.msg_bytes <= $4
              AND position((chr(92) || 'u0000') in c.messages) = 0
              AND elem->>'text' ILIKE $2 ESCAPE '\\'
           UNION ALL
           SELECT c.id, c.title, c.project_id,
                  c.last_at::text AS matched_at,
                  substring(c.messages FROM GREATEST(1, strpos(lower(c.messages), lower($5)) - 80) FOR 400) AS msg_text
             FROM text_hits c
            WHERE c.msg_bytes > $4
               OR position((chr(92) || 'u0000') in c.messages) > 0`,
          [userId, like, candMax, expandMax, q],
        )
      ).rows;
      const hits = [
        ...titleRows.map((r) => ({
          sessionId: r.id,
          title: r.title,
          projectId: r.project_id ?? null,
          snippet: buildSearchSnippet(r.title, q),
          matchedAt: bigIntNum(r.last_at, "last_at"),
          kind: "title" as const,
        })),
        ...msgRows.map((r) => ({
          sessionId: r.id,
          title: r.title,
          projectId: r.project_id ?? null,
          snippet: buildSearchSnippet(r.msg_text, q),
          matchedAt: bigIntNum(r.matched_at, "matched_at"),
          kind: "message" as const,
        })),
        ...chunkRows.map((r) => ({
          sessionId: r.id,
          title: r.title,
          projectId: r.project_id ?? null,
          snippet: buildSearchSnippet(r.msg_text, q),
          matchedAt: bigIntNum(r.matched_at, "matched_at"),
          kind: "message" as const,
        })),
      ];
      const ranked = rankSessionSearchHits(hits, limit);
      const unreadMap = await pgUnreadBySessionIds(
        pool,
        userId,
        ranked.map((h) => h.sessionId),
      );
      return {
        results: ranked.map((h) => ({ ...h, unread: unreadMap.get(h.sessionId) === true })),
      };
    },

    async batchClientSessions(
      userId: string,
      input: BatchClientSessionsInput,
    ): Promise<BatchClientSessionsResult> {
      const parsed = parseSessionBatchInput(input);
      if ("ok" in parsed) return parsed;
      const { ids, action } = parsed;
      if (ids.length === 0) return { ok: true, updated: 0, skipped: 0 };
      return withTx(pool, async (client): Promise<BatchClientSessionsResult> => {
        if (action === "move" && parsed.projectId) {
          const owned = (
            await client.query(
              "SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
              [parsed.projectId, userId],
            )
          ).rows[0];
          if (!owned) return { ok: false, error: "project_not_found" };
        }
        const ownedRows = (
          await client.query<{ id: string }>(
            `SELECT id FROM client_sessions
              WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])`,
            [userId, ids],
          )
        ).rows;
        const owned = new Set(ownedRows.map((r) => r.id));
        const skipped = ids.length - owned.size;
        const targetIds = ids.filter((id) => owned.has(id));
        if (targetIds.length === 0) return { ok: true, updated: 0, skipped };
        let updated = 0;
        if (action === "delete") {
          for (const id of targetIds) {
            const result = await client.query(
              `UPDATE client_sessions
                  SET deleted_at = ${CLOCK_MS_SQL},
                      updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
                      messages = '[]', message_count = 0
                WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
              [id, userId],
            );
            if ((result.rowCount ?? 0) === 0) continue;
            await client.query("DELETE FROM client_session_user_payloads WHERE session_id=$1 AND user_id=$2", [id, userId]);
            await client.query("DELETE FROM client_session_archive_chunks WHERE session_id = $1", [id]);
            await client.query("DELETE FROM client_session_archived_ids WHERE session_id = $1", [id]);
            await client.query("DELETE FROM turn_tape_recovery_links WHERE session_id = $1", [id]);
            await client.query("DELETE FROM client_session_turn_tapes WHERE session_id = $1", [id]);
            await client.query("DELETE FROM pending_usage_patches WHERE parent_session_id = $1", [id]);
            updated++;
          }
        } else if (action === "archive") {
          const res = await client.query(
            `UPDATE client_sessions
                SET archived_at = COALESCE(archived_at, ${CLOCK_MS_SQL}),
                    updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
              WHERE user_id = $1 AND deleted_at IS NULL AND archived_at IS NULL
                AND id = ANY($2::text[])`,
            [userId, targetIds],
          );
          updated = res.rowCount ?? 0;
        } else if (action === "unarchive") {
          const res = await client.query(
            `UPDATE client_sessions
                SET archived_at = NULL,
                    updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
              WHERE user_id = $1 AND deleted_at IS NULL AND archived_at IS NOT NULL
                AND id = ANY($2::text[])`,
            [userId, targetIds],
          );
          updated = res.rowCount ?? 0;
        } else {
          const res = await client.query(
            `UPDATE client_sessions
                SET project_id = $1,
                    updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
              WHERE user_id = $2 AND deleted_at IS NULL
                AND id = ANY($3::text[])`,
            [parsed.projectId ?? null, userId, targetIds],
          );
          updated = res.rowCount ?? 0;
        }
        return { ok: true, updated, skipped };
      });
    },

    async markClientSessionRead(userId: string, sessionId: string): Promise<MarkClientSessionReadResult> {
      // last_read_at 单位 = epoch milliseconds（与 CLOCK_MS_SQL / terminal_at 派生相同）。
      const res = await pool.query(
        `UPDATE client_sessions SET last_read_at = ${CLOCK_MS_SQL}
          WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [userId, sessionId],
      );
      const updated = res.rowCount ?? 0;
      if (updated === 0) return { ok: false, error: "not_found" };
      return { ok: true, updated };
    },

    async markAllClientSessionsRead(userId: string): Promise<{ updated: number }> {
      const res = await pool.query(
        `UPDATE client_sessions SET last_read_at = ${CLOCK_MS_SQL}
          WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      return { updated: res.rowCount ?? 0 };
    },

    async listChatProjects(userId: string): Promise<ChatProject[]> {
      const rows = (
        await pool.query<{
          id: string;
          name: string;
          instructions: string | null;
          color: string | null;
          sort_order: number;
          created_at: string;
          updated_at: string;
          session_count: string;
        }>(
          `${PG_CHAT_PROJECT_SELECT}
            WHERE p.user_id = $2 AND p.deleted_at IS NULL
            ORDER BY p.sort_order ASC, p.created_at ASC`,
          [userId, userId],
        )
      ).rows;
      return rows.map(mapPgChatProjectRow);
    },

    async createChatProject(
      userId: string,
      input: { name?: unknown; instructions?: unknown; color?: unknown },
    ): Promise<ChatProjectCreateResult> {
      const name = parseChatProjectName(input.name);
      if (!name) return { ok: false, error: "invalid_name" };
      const instructions = parseChatProjectOptionalText(input.instructions, CHAT_PROJECT_INSTRUCTIONS_MAX);
      if ("invalid" in instructions) return { ok: false, error: "invalid_instructions" };
      const color = parseChatProjectOptionalText(input.color, CHAT_PROJECT_COLOR_MAX);
      if ("invalid" in color) return { ok: false, error: "invalid_color" };
      const id = randomUUID();
      return withTx(pool, async (client) => {
        const countRow = (
          await client.query<{ n: string }>(
            "SELECT COUNT(*)::text AS n FROM chat_projects WHERE user_id = $1 AND deleted_at IS NULL",
            [userId],
          )
        ).rows[0];
        if (Number(countRow?.n ?? 0) >= CHAT_PROJECT_PER_USER_LIMIT) {
          return { ok: false, error: "limit_exceeded" };
        }
        await client.query(
          `INSERT INTO chat_projects
             (id, user_id, name, instructions, color, sort_order, created_at, updated_at, deleted_at)
           VALUES ($1, $2, $3, $4, $5, COALESCE((
             SELECT MAX(sort_order) + 1 FROM chat_projects WHERE user_id = $2 AND deleted_at IS NULL
           ), 0), ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL}, NULL)`,
          [
            id,
            userId,
            name,
            instructions.present ? instructions.value : null,
            color.present ? color.value : null,
          ],
        );
        const project = await readPgChatProject(client, userId, id);
        if (!project) throw new Error("chat project insert vanished");
        return { ok: true, project };
      });
    },

    async updateChatProject(
      userId: string,
      id: string,
      input: { name?: unknown; instructions?: unknown; color?: unknown; sortOrder?: unknown },
    ): Promise<ChatProjectUpdateResult> {
      const sets: string[] = [`updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})`];
      const params: unknown[] = [];
      let n = 1;
      if (input.name !== undefined) {
        const name = parseChatProjectName(input.name);
        if (!name) return { ok: false, error: "invalid_name" };
        sets.push(`name = $${n++}`);
        params.push(name);
      }
      if (input.instructions !== undefined) {
        const instructions = parseChatProjectOptionalText(input.instructions, CHAT_PROJECT_INSTRUCTIONS_MAX);
        if ("invalid" in instructions || !instructions.present) return { ok: false, error: "invalid_instructions" };
        sets.push(`instructions = $${n++}`);
        params.push(instructions.value);
      }
      if (input.color !== undefined) {
        const color = parseChatProjectOptionalText(input.color, CHAT_PROJECT_COLOR_MAX);
        if ("invalid" in color || !color.present) return { ok: false, error: "invalid_color" };
        sets.push(`color = $${n++}`);
        params.push(color.value);
      }
      if (input.sortOrder !== undefined) {
        const sortOrder = parseChatProjectSortOrder(input.sortOrder);
        if (sortOrder === null) return { ok: false, error: "invalid_sort_order" };
        sets.push(`sort_order = $${n++}`);
        params.push(sortOrder);
      }
      if (sets.length === 1) {
        const existing = await readPgChatProject(pool, userId, id);
        return existing ? { ok: true, project: existing } : { ok: false, error: "not_found" };
      }
      return withTx(pool, async (client) => {
        params.push(id, userId);
        const res = await client.query(
          `UPDATE chat_projects SET ${sets.join(", ")}
            WHERE id = $${n++} AND user_id = $${n} AND deleted_at IS NULL`,
          params,
        );
        if ((res.rowCount ?? 0) === 0) return { ok: false, error: "not_found" };
        const project = await readPgChatProject(client, userId, id);
        if (!project) return { ok: false, error: "not_found" };
        return { ok: true, project };
      });
    },

    async deleteChatProject(userId: string, id: string): Promise<ChatProjectDeleteResult> {
      return withTx(pool, async (client) => {
        const res = await client.query(
          `UPDATE chat_projects
              SET deleted_at = ${CLOCK_MS_SQL},
                  updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, userId],
        );
        if ((res.rowCount ?? 0) === 0) return { ok: false, error: "not_found" };
        await client.query(
          `UPDATE client_sessions
              SET project_id = NULL,
                  updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
            WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
          [userId, id],
        );
        return { ok: true };
      });
    },

    async listProjectAssets(userId: string, opts: ListProjectAssetsOpts): Promise<ProjectAsset[]> {
      const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.min(PROJECT_ASSET_LIST_LIMIT_MAX, Math.floor(opts.limit))
        : PROJECT_ASSET_LIST_LIMIT_DEFAULT;
      const rows = (
        await pool.query<PgProjectAssetRow>(
          `${PG_PROJECT_ASSET_SELECT}
            WHERE user_id = $1 AND deleted_at IS NULL AND project_id IS NOT DISTINCT FROM $2
            ORDER BY created_at DESC
            LIMIT $3`,
          [userId, opts.projectId, limit],
        )
      ).rows;
      return rows.map(mapPgProjectAssetRow);
    },

    async createProjectAsset(
      userId: string,
      input: ProjectAssetCreateInput,
    ): Promise<ProjectAssetCreateResult> {
      const parsed = parseProjectAssetCreateInput(input);
      if (!parsed.ok) return parsed;
      const id = randomUUID();
      return withTx(pool, async (client) => {
        const resolved = await pgResolveAssetProjectId(client, userId, parsed.value);
        if (!resolved.ok) return resolved;
        const { projectId } = resolved;
        const dup = await pgFindDuplicateAsset(
          client,
          userId,
          projectId,
          parsed.value.source,
          parsed.value.digest,
          parsed.value.containerPath,
        );
        if (dup) return { ok: true, asset: dup };
        // 同一 (user_id, project_id) 桶的 count+INSERT 必须串行:默认 READ COMMITTED
        // 下无行锁,并发事务都会读到 count<500 再各自写入 → 上限被突破。
        // pg_advisory_xact_lock 随 COMMIT/ROLLBACK 自动释放;不用会话级
        // pg_advisory_lock(连接归还池后锁会泄漏)。
        // NULL project_id(未分组)用 coalesce($2,'') 编码:真实 chat_projects.id 是 UUID
        // (解析还拒绝 <8 字符),空串不会与真实 id 撞,故不会误锁其它项目。
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || coalesce($2, '')))",
          [`oc_proj_asset:${userId}`, projectId],
        );
        if ((await pgCountProjectAssets(client, userId, projectId)) >= PROJECT_ASSET_PER_PROJECT_LIMIT) {
          return { ok: false, error: "limit_exceeded" };
        }
        // 只插索引行,绝不写/删磁盘文件(内容寻址,可能被其它消息/资产共用)。
        await client.query(
          `INSERT INTO project_assets (
             id, user_id, project_id, source, session_id, name, url, container_path,
             mime, size_bytes, digest, excerpt, pinned, created_at, updated_at, deleted_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             ${CLOCK_MS_SQL}, ${CLOCK_MS_SQL}, NULL
           )`,
          [
            id,
            userId,
            projectId,
            parsed.value.source,
            parsed.value.sessionId,
            parsed.value.name,
            parsed.value.url,
            parsed.value.containerPath,
            parsed.value.mime,
            parsed.value.sizeBytes,
            parsed.value.digest,
            parsed.value.excerpt,
            parsed.value.pinned,
          ],
        );
        const asset = await readPgProjectAsset(client, userId, id);
        if (!asset) throw new Error("project asset insert vanished");
        return { ok: true, asset };
      });
    },

    async updateProjectAsset(
      userId: string,
      assetId: string,
      patch: ProjectAssetUpdateInput,
    ): Promise<ProjectAssetUpdateResult> {
      const sets: string[] = [`updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})`];
      const params: unknown[] = [];
      let n = 1;
      let nextProjectId: { present: true; value: string | null } | undefined;
      if (patch.name !== undefined) {
        const name = parseProjectAssetName(patch.name);
        if (!name) return { ok: false, error: "invalid_name" };
        sets.push(`name = $${n++}`);
        params.push(name);
      }
      if (patch.pinned !== undefined) {
        if (typeof patch.pinned !== "boolean") return { ok: false, error: "invalid_name" };
        sets.push(`pinned = $${n++}`);
        params.push(patch.pinned);
      }
      if (patch.projectId !== undefined) {
        const parsed = parseProjectAssetProjectId(patch.projectId);
        if ("invalid" in parsed) return { ok: false, error: "project_not_found" };
        nextProjectId = { present: true, value: parsed.present ? parsed.value : null };
        sets.push(`project_id = $${n++}`);
        params.push(nextProjectId.value);
      }
      if (sets.length === 1) {
        const existing = await readPgProjectAsset(pool, userId, assetId);
        return existing ? { ok: true, asset: existing } : { ok: false, error: "not_found" };
      }
      return withTx(pool, async (client) => {
        const existing = await readPgProjectAsset(client, userId, assetId);
        if (!existing) return { ok: false, error: "not_found" };
        if (nextProjectId) {
          if (nextProjectId.value !== null && !(await pgOwnedChatProjectExists(client, userId, nextProjectId.value))) {
            return { ok: false, error: "project_not_found" };
          }
          if (nextProjectId.value !== existing.projectId) {
            // 跨项目移动走同一份 500 上限;锁目标桶,键编码与 createProjectAsset 相同
            // (含 NULL 未分组 → coalesce 空串,不与 UUID 撞)。xact lock,随事务释放。
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || coalesce($2, '')))",
              [`oc_proj_asset:${userId}`, nextProjectId.value],
            );
            if ((await pgCountProjectAssets(client, userId, nextProjectId.value)) >= PROJECT_ASSET_PER_PROJECT_LIMIT) {
              return { ok: false, error: "limit_exceeded" };
            }
          }
        }
        params.push(assetId, userId);
        const res = await client.query(
          `UPDATE project_assets SET ${sets.join(", ")}
            WHERE id = $${n++} AND user_id = $${n} AND deleted_at IS NULL`,
          params,
        );
        if ((res.rowCount ?? 0) === 0) return { ok: false, error: "not_found" };
        const asset = await readPgProjectAsset(client, userId, assetId);
        if (!asset) return { ok: false, error: "not_found" };
        return { ok: true, asset };
      });
    },

    async deleteProjectAsset(userId: string, assetId: string): Promise<ProjectAssetDeleteResult> {
      // 软删只标 deleted_at,绝不 unlink 磁盘文件。
      const res = await pool.query(
        `UPDATE project_assets
            SET deleted_at = ${CLOCK_MS_SQL},
                updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [assetId, userId],
      );
      return (res.rowCount ?? 0) === 0 ? { ok: false, error: "not_found" } : { ok: true };
    },

    async listPinnedProjectAssetsForSession(sessionId: string): Promise<ProjectAsset[]> {
      const sess = (
        await pool.query<{ user_id: string; project_id: string | null }>(
          "SELECT user_id, project_id FROM client_sessions WHERE id = $1 AND deleted_at IS NULL",
          [sessionId],
        )
      ).rows[0];
      if (!sess) return [];
      const rows = (
        await pool.query<PgProjectAssetRow>(
          `${PG_PROJECT_ASSET_SELECT}
            WHERE user_id = $1 AND deleted_at IS NULL AND pinned IS TRUE
              AND project_id IS NOT DISTINCT FROM $2
            ORDER BY created_at DESC
            LIMIT $3`,
          [sess.user_id, sess.project_id ?? null, PROJECT_ASSET_PINNED_INJECT_MAX],
        )
      ).rows;
      return rows.map(mapPgProjectAssetRow);
    },

    async bumpClientSessionHistoryRevision(id: string, userId: string): Promise<boolean> {
      const result = await pool.query(
        `UPDATE client_sessions
            SET history_revision = history_revision + 1,
                timeline_generation = timeline_generation + 1,
                updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL})
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      return (result.rowCount ?? 0) > 0;
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
      originChannel: "wechat" | "qqbot";
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
