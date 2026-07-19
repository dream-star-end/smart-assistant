/**
 * v5 自愈体系切片② 块A — codex 回调端点(个人版 codex → v5 master)。
 *
 * 全部 /internal/ 路由(**非** /api/admin/,不套 admin gate;鉴权自理)。经 SSH 正向隧道
 * `-L 127.0.0.1:<callback>:127.0.0.1:<master_cb>` 到达,handler 首行校验 remoteAddress=loopback
 * (纵深防御,真正的信任根是 capability / webhook HMAC)。
 *
 *   POST /internal/v5/repairs/:id/{ack,progress,verify,done,failed}
 *        — Authorization: Bearer <capability>(逐 repair 短期 token,verifyCapability 绑 id)。
 *        — zod:message ≤4000 + detail 对象(长度上限);写库前 redactOpsPayload
 *          (M4:key 级 + 值级字符串清洗,codex 可能回传日志/凭据)。
 *        — 状态机 CAS:ack→acked / progress→running(追加 event)/ verify→记 verify_after /
 *          done→verifying(**不直接 succeeded**,等 sweeper 探测 fence)/ failed→failed+fail_reason。
 *        — M2 防重放:done/failed 在**同一事务**内消费 capability jti
 *          (selfheal_capability_uses INSERT ON CONFLICT,冲突=重放→409;事务失败 jti
 *          一并回滚,合法重试不误伤)。progress/ack 天然可重复,不记账。
 *        — verify 窗口 set-once(M2):verify_after/verify_deadline 仅首次落值
 *          (COALESCE),重复 verify/done 不再延窗(消"重复 verify 续命")。
 *   POST /internal/v5/repairs/:id/claim-capability
 *        — webhook HMAC 鉴权(**非** capability):个人版 gateway 用自己凭证换该 repair 的短期 capability。
 *        — M3 签名串(跨仓契约,与 repairDispatcher.signWebhook 同源):
 *          `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`(METHOD 大写,
 *          path=URL pathname 无 query);nonce 落 PG selfheal_webhook_nonces 原子判重
 *          (sig 验过才写;重放=插不进→401),sweeper 清 10min 前的行。
 *   GET  /internal/v5/repairs/:id/context
 *        — capability 鉴权 → getRepairContext(结构化只读脱敏,防注入)。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import { z } from "zod";

import { query, tx } from "../../db/queries.js";
import { rootLogger } from "../../logging/logger.js";
import { redactOpsPayload, scrubSecretsInString } from "../../selfheal/redact.js";
import { verifyBudgetMs } from "../../selfheal/config.js";
import { issueCapability, verifyCapability } from "../../selfheal/capability.js";
import { getRepairContext } from "../../selfheal/repairContext.js";
import {
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
  HttpError,
  REQUEST_ID_HEADER,
} from "../util.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";

export const SELFHEAL_REPAIRS_PREFIX = "/internal/v5/repairs/";

const log = rootLogger.child({ subsys: "selfheal", module: "repairCallbacks" });

const ROUTE_RE =
  /^\/internal\/v5\/repairs\/([1-9][0-9]{0,19})\/(ack|progress|verify|done|failed|claim-capability|context)$/;

// done/verify 后的探测确认预算(verify_deadline):数值解析收口 selfheal/config.ts(B3)。

const WEBHOOK_TS_WINDOW_MS = 120_000;
const DETAIL_MAX_BYTES = 16 * 1024;
const RELEASE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 活跃(非终态)状态:回调只在活跃态有效。 */
const ACTIVE = ["dispatched", "acked", "running", "verifying"];

// ─── 鉴权 helpers ──────────────────────────────────────────────────────

function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return /^(127\.|::1$|::ffff:127\.)/.test(ip);
}

/** 提取 Bearer capability token。 */
function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * webhook HMAC 校验(claim-capability 用;M3 路由绑定 + nonce 落库版)。
 * 校验序:ts 窗口 → sig(绑 METHOD+path)→ nonce 原子落 PG(sig 验过才写,
 * INSERT ON CONFLICT DO NOTHING 插不进 = 重放拒绝)。durable nonce 使 master
 * 重启后重放窗口闭合(此前 in-memory Map 一重启就清零)。DB 异常 → fail-closed 拒绝。
 */
async function verifyWebhookSig(
  req: IncomingMessage,
  repairId: string,
  path: string,
  rawBody: string,
  now: number,
): Promise<boolean> {
  const secret = process.env.OC_SELFHEAL_WEBHOOK_HMAC;
  if (!secret) return false;
  const ts = req.headers["x-selfheal-ts"];
  const nonce = req.headers["x-selfheal-nonce"];
  const sig = req.headers["x-selfheal-sig"];
  if (typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string") return false;
  if (nonce.length === 0 || nonce.length > 128) return false;
  const tsn = Number(ts);
  if (!Number.isFinite(tsn) || Math.abs(now - tsn) > WEBHOOK_TS_WINDOW_MS) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const method = (req.method ?? "").toUpperCase();
  const bodySha = createHash("sha256").update(rawBody).digest("hex");
  // 跨仓契约签名串(与 repairDispatcher.signWebhook / 个人版 receiver+jobWorker 同源)。
  const expected = createHmac("sha256", secret)
    .update(`${method}.${path}.${ts}.${nonce}.${repairId}.${bodySha}`)
    .digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // sig 验过才写 nonce(RFC M-HMAC-route);插不进 = 重放。DB 异常按拒绝处理(fail-closed)。
  try {
    const ins = await query(
      `INSERT INTO selfheal_webhook_nonces (nonce) VALUES ($1) ON CONFLICT (nonce) DO NOTHING`,
      [nonce],
    );
    return (ins.rowCount ?? 0) > 0;
  } catch (err) {
    log.warn("selfheal_nonce_persist_failed", { err: (err as Error)?.message });
    return false;
  }
}

// ─── body 校验 + 脱敏 ──────────────────────────────────────────────────

const CallbackBody = z
  .object({
    message: z.string().min(1).max(4000),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** 脱敏 + 体积上限:超限则整体替换为 marker(codex 回传可能极大/夹带凭据)。
 *  M4:redactOpsPayload = key 级(redactSensitive)+ 值级字符串清洗(sk-/Bearer/
 *  gh 令牌/URL userinfo…),codex 自由文本里嵌的凭据也被清。 */
function safeDetail(detail: unknown): Record<string, unknown> {
  if (detail === undefined || detail === null) return {};
  const redacted = redactOpsPayload(detail);
  const s = JSON.stringify(redacted);
  if (s.length > DETAIL_MAX_BYTES) return { __truncated: true, len: s.length };
  return (redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted }) as Record<string, unknown>;
}

// ─── 状态机 CAS ────────────────────────────────────────────────────────

interface RepairState {
  status: string;
  attempt: number;
}
async function loadRepair(id: string): Promise<RepairState | null> {
  const r = await query<{ status: string; attempt: number }>(
    `SELECT status, attempt FROM codex_repairs WHERE id = $1::bigint`,
    [id],
  );
  return r.rows[0] ?? null;
}

type ActionResult =
  | { code: "ok"; body: Record<string, unknown> }
  | { code: "not_found" }
  | { code: "conflict"; message: string };

/** 追加 append-only 进度事件(同 client 事务)。 */
async function appendEvent(
  client: PoolClient,
  repairId: string,
  kind: string,
  message: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
     VALUES ($1::bigint, $2, $3, $4::jsonb)`,
    [repairId, kind, message.slice(0, 4000), JSON.stringify(detail)],
  );
}

async function handleAck(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  return tx(async (client) => {
    const cas = await client.query(
      `UPDATE codex_repairs SET status='acked', acked_at=NOW(), updated_at=NOW()
        WHERE id=$1::bigint AND status='dispatched'`,
      [id],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (st === "acked" || ACTIVE.includes(st)) {
        await appendEvent(client, id, "ack", message, detail);
        return { code: "ok", body: { status: st } };
      }
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "ack", message, detail);
    return { code: "ok", body: { status: "acked" } };
  });
}

async function handleProgress(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  return tx(async (client) => {
    const cas = await client.query(
      `UPDATE codex_repairs SET status='running', updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('acked','running')`,
      [id],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (!ACTIVE.includes(st)) return { code: "conflict", message: `repair is ${st}` };
      // dispatched/verifying:允许记录进度,不改状态
    }
    await appendEvent(client, id, "progress", message, detail);
    return { code: "ok", body: { status: "running" } };
  });
}

async function handleVerify(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  const budget = verifyBudgetMs();
  return tx(async (client) => {
    // M2 set-once:verify 窗口只在首次落值(COALESCE),重复 verify 幂等但**不延窗**
    // (消"重复 verify 续命"——deadline 一旦钉死,codex 反复报 verify 也改不了裁决窗)。
    const cas = await client.query(
      `UPDATE codex_repairs
          SET verify_after=COALESCE(verify_after, NOW()),
              verify_deadline=COALESCE(verify_deadline, NOW() + ($2::bigint * INTERVAL '1 millisecond')),
              updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('acked','running','verifying')`,
      [id, budget],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "verify", message, detail);
    return { code: "ok", body: { status: "verifying_pending" } };
  });
}

/**
 * M2:同事务消费 capability jti(一次性)。返回 true=首次消费;false=重放。
 * 与状态 CAS + event 同一 PG 事务:事务失败 jti 一并回滚,合法重试不误 409。
 */
async function consumeJti(
  client: PoolClient,
  repairId: string,
  jti: string,
  action: string,
): Promise<boolean> {
  const ins = await client.query(
    `INSERT INTO selfheal_capability_uses (repair_id, jti, action)
     VALUES ($1::bigint, $2, $3)
     ON CONFLICT (repair_id, jti, action) DO NOTHING`,
    [repairId, jti, action],
  );
  return (ins.rowCount ?? 0) > 0;
}

/**
 * done → verifying set-once CAS(verify_after=done_at freshness fence 锚点;set-once:
 * 重复 done 不延窗)。返回受影响行数(0=repair 不在可收口态)。handleDone 与批1b
 * release deployed 回调共用本 CAS(单一权威——verifying 转移的 SQL/set-once 语义在此一处)。
 *
 * 源状态集按调用方分叉(R2-1②):
 *   - 普通(非 release)done:allowCancelStates=false(默认)→ 只 acked/running/verifying,**保持不变**。
 *   - release deployed receipt:allowCancelStates=true → 额外允许 cancel_requested/cancelling,
 *     使"cancel 途中的 repair 收到 deployed receipt"能收口到 verifying(消'request deployed、repair
 *     永久 cancelling'双权威死锁)。仅由 settleRepairOnDeployedReceipt 传 true。
 */
async function casRepairToVerifying(
  client: PoolClient,
  repairId: string,
  summary: string,
  budgetMs: number,
  opts: { allowCancelStates?: boolean } = {},
): Promise<number> {
  // 源状态集为受控字面量常量(无用户输入拼接),按调用方分叉:release deployed 收口额外纳入 cancel 中间态。
  const sourceStates = opts.allowCancelStates
    ? "('acked','running','verifying','cancel_requested','cancelling')"
    : "('acked','running','verifying')";
  const cas = await client.query(
    `UPDATE codex_repairs
        SET status='verifying',
            summary=$3,
            verify_after=COALESCE(verify_after, NOW()),
            verify_deadline=COALESCE(verify_deadline, NOW() + ($2::bigint * INTERVAL '1 millisecond')),
            updated_at=NOW()
      WHERE id=$1::bigint AND status IN ${sourceStates}`,
    [repairId, budgetMs, summary],
  );
  return cas.rowCount ?? 0;
}

/**
 * R2-1②:release deployed receipt 的 repair 收口(单一权威,applyDeployedReceipt 与未知 rrid deployed
 * 分支共用)。扩展 CAS 允许 acked/running/verifying/cancel_requested/cancelling → verifying:
 *   - 此前处于 cancel_requested/cancelling(cancel 途中,release 已 pre-claim 部署=too_late)且收口成功
 *     → append cancelReceiptRace 事件(receipt 胜,repair 转入探测验证);
 *   - 此前处于 running/acked/verifying → 正常 deployed 收口(不额外记 race);
 *   - 0 行(repair 已真终态 cancelled/failed/succeeded…)→ append 跳过警示(部署事实已落库,归因交人工)。
 * FOR UPDATE 锁定 repair 行:先读旧态再 CAS,同事务内一致。调用链在进入
 * request 行之前已先锁 repair，统一全局锁序 repair→request→fuse。
 */
async function settleRepairOnDeployedReceipt(
  client: PoolClient,
  repairId: string,
  summary: string,
  eventDetail: Record<string, unknown>,
): Promise<void> {
  const prev = await client.query<{ status: string }>(
    `SELECT status FROM codex_repairs WHERE id=$1::bigint FOR UPDATE`,
    [repairId],
  );
  const priorStatus = prev.rows[0]?.status ?? null;
  const n = await casRepairToVerifying(client, repairId, summary, verifyBudgetMs(), { allowCancelStates: true });
  if (n === 0) {
    await appendEvent(
      client,
      repairId,
      "note",
      "deployed 回调:repair 不在可收口态(cancelled/已终态),verifying 收口跳过(部署事实已记录)",
      eventDetail,
    );
    return;
  }
  if (priorStatus === "cancel_requested" || priorStatus === "cancelling") {
    await appendEvent(
      client,
      repairId,
      "note",
      "cancelReceiptRace: receipt 胜,repair 转入探测验证(cancel 途中收到 deployed receipt,收口到 verifying)",
      { ...eventDetail, cancelReceiptRace: true },
    );
  }
}

/**
 * 批1b F8②:部署流程中(该 repair 有活跃 release request:queued/accepted/deploying)时,
 * 模型不得用普通 done/failed **独立终态** repair —— repair 必须停在 running(pending_release
 * 姿态),由 release callback(deployed→verifying / deploy_failed→留 running)驱动。
 * 返回 true = 存在活跃 release request(调用方据此 409,且必须在 jti 消费**之前**判定,
 * 避免误吞 jti 让合法重试受阻)。
 */
async function hasActiveReleaseRequest(client: PoolClient, repairId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM selfheal_release_requests
      WHERE repair_id = $1::bigint AND status IN ('queued','accepted','deploying') LIMIT 1`,
    [repairId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function handleDone(
  id: string,
  message: string,
  detail: Record<string, unknown>,
  jti: string,
): Promise<ActionResult> {
  const budget = verifyBudgetMs();
  return tx(async (client) => {
    // F8②:活跃 release request 在途 → 模型不得普通 done 终态 repair(在 jti 消费前判定,不吞 token)。
    if (await hasActiveReleaseRequest(client, id)) {
      return { code: "conflict", message: "repair has an active release request; deploy flow owns terminal transition" };
    }
    // M2:jti 一次性消费与状态 CAS + event 同事务;冲突 = 该 token 已成功 done 过 → 409。
    if (!(await consumeJti(client, id, jti, "done"))) {
      return { code: "conflict", message: "capability token already consumed for done (replay)" };
    }
    // done → verifying(不直接 succeeded);verify_after=done_at(freshness fence 锚点,set-once)。
    if ((await casRepairToVerifying(client, id, message.slice(0, 1000), budget)) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "done", message, detail);
    return { code: "ok", body: { status: "verifying" } };
  });
}

async function handleFailed(
  id: string,
  message: string,
  detail: Record<string, unknown>,
  jti: string,
): Promise<ActionResult> {
  return tx(async (client) => {
    // F8②:活跃 release request 在途 → 模型不得普通 failed 终态 repair(deploy_failed 由 release
    // callback 驱动,repair 停留 running 待 boss 重新放行)。在 jti 消费前判定,不吞 token。
    if (await hasActiveReleaseRequest(client, id)) {
      return { code: "conflict", message: "repair has an active release request; deploy flow owns terminal transition" };
    }
    // M2:同 handleDone,jti 消费与 CAS 同事务;冲突 = 重放 → 409。
    if (!(await consumeJti(client, id, jti, "failed"))) {
      return { code: "conflict", message: "capability token already consumed for failed (replay)" };
    }
    const cas = await client.query(
      `UPDATE codex_repairs
          SET status='failed', fail_reason=$2, finished_at=NOW(), updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('dispatched','acked','running','verifying')`,
      [id, message.slice(0, 2000)],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (st === "failed") return { code: "ok", body: { status: "failed" } };
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "failed", message, detail);
    return { code: "ok", body: { status: "failed" } };
  });
}

// ─── 批1b:release 回调分流(detail.releaseRequestId)────────────────────

/** release request 活跃(可推进)状态。终态/cancelled 到达 = 幂等 no-op。 */
const RELEASE_ACTIVE = ["queued", "accepted", "deploying"];

/**
 * 部署终态 receipt(个人版 release worker 异步回传)。请求行已被乐观 cancel 时收到这些 =
 * receipt 胜过乐观 cancel(F2③):照常应用终态转移(deployed 仍推 verifying;deploy_unknown 仍拉熔断)。
 */
const TERMINAL_RECEIPT_PHASES = new Set(["deployed", "deploy_failed", "deploy_unknown"]);

type FuseEngageOutcome = "engaged" | "same_epoch" | "other_epoch" | "cleared_epoch";

interface FuseProjectionRow {
  engaged: boolean;
  reason: string | null;
  release_request_id: string | null;
  engaged_at: Date | null;
  engaged_by: string | null;
  cleared_at: Date | null;
  cleared_by: string | null;
  personal_ack_at: Date | null;
}

/**
 * 0174 is backward-compatible with a briefly overlapping pre-0174 runtime.
 * That runtime only writes the singleton, so every new writer first folds its
 * projected epoch into the durable ledger while holding the singleton lock.
 */
async function materializeLegacyFuseProjection(
  client: PoolClient,
  cur: FuseProjectionRow,
): Promise<void> {
  if (!cur.release_request_id) return;
  if (cur.engaged) {
    await client.query(
      `INSERT INTO selfheal_release_fuse_epochs
         (release_request_id, reason, engaged_at, engaged_by)
       VALUES ($1, $2, COALESCE($3, NOW()), COALESCE($4, 'legacy:pre-0174'))
       ON CONFLICT (release_request_id) DO NOTHING`,
      [cur.release_request_id, cur.reason, cur.engaged_at, cur.engaged_by],
    );
    return;
  }
  if (!cur.cleared_at) return;
  await client.query(
    `INSERT INTO selfheal_release_fuse_epochs
       (release_request_id, reason, engaged_at, engaged_by,
        cleared_at, cleared_by, clear_reason, personal_ack_at)
     VALUES ($1, $2, COALESCE($3, $5), COALESCE($4, 'legacy:pre-0174'),
             $5, COALESCE($6, 'legacy:pre-0174'),
             'materialized from pre-0174 release fuse', $7)
     ON CONFLICT (release_request_id) DO UPDATE
       SET cleared_at = COALESCE(selfheal_release_fuse_epochs.cleared_at, EXCLUDED.cleared_at),
           cleared_by = COALESCE(selfheal_release_fuse_epochs.cleared_by, EXCLUDED.cleared_by),
           clear_reason = COALESCE(
             selfheal_release_fuse_epochs.clear_reason,
             EXCLUDED.clear_reason
           ),
           personal_ack_at = COALESCE(
             selfheal_release_fuse_epochs.personal_ack_at,
             EXCLUDED.personal_ack_at
           )`,
    [
      cur.release_request_id,
      cur.reason,
      cur.engaged_at,
      cur.engaged_by,
      cur.cleared_at,
      cur.cleared_by,
      cur.personal_ack_at,
    ],
  );
}

/** Persist every uncertainty epoch; the singleton is only the oldest pending
 * epoch projected to admin UI/delivery gates. A concurrent B while A is active
 * is therefore not forgotten when the operator later clears A. */
async function engageReleaseFuseEpoch(
  client: PoolClient,
  rrid: string,
  reason: string,
  engagedBy: string,
): Promise<FuseEngageOutcome> {
  const curR = await client.query<FuseProjectionRow>(
    `SELECT engaged, reason, release_request_id, engaged_at, engaged_by,
            cleared_at, cleared_by, personal_ack_at
       FROM selfheal_release_fuse WHERE id = 1 FOR UPDATE`,
  );
  const cur = curR.rows[0];
  if (!cur) throw new Error("release fuse singleton missing");
  await materializeLegacyFuseProjection(client, cur);
  const prior = await client.query<{
    reason: string | null;
    engaged_at: Date;
    engaged_by: string;
    cleared_at: Date | null;
    cleared_by: string | null;
    personal_ack_at: Date | null;
  }>(
    `SELECT reason, engaged_at, engaged_by, cleared_at, cleared_by, personal_ack_at
       FROM selfheal_release_fuse_epochs
      WHERE release_request_id = $1
      FOR UPDATE`,
    [rrid],
  );
  let epoch = prior.rows[0];
  let inserted = false;
  if (!epoch) {
    const created = await client.query<{
      reason: string | null;
      engaged_at: Date;
      engaged_by: string;
      cleared_at: Date | null;
      cleared_by: string | null;
      personal_ack_at: Date | null;
    }>(
      `INSERT INTO selfheal_release_fuse_epochs
         (release_request_id, reason, engaged_at, engaged_by)
       VALUES ($1, $2, NOW(), $3)
       RETURNING reason, engaged_at, engaged_by, cleared_at, cleared_by, personal_ack_at`,
      [rrid, reason, engagedBy],
    );
    epoch = created.rows[0];
    inserted = true;
  }
  if (!epoch) throw new Error("release fuse epoch insert failed");
  const pending = await client.query<{
    release_request_id: string;
    reason: string | null;
    engaged_at: Date;
    engaged_by: string;
  }>(
    `SELECT release_request_id, reason, engaged_at, engaged_by
       FROM selfheal_release_fuse_epochs
      WHERE cleared_at IS NULL
      ORDER BY engaged_at ASC, release_request_id ASC
      LIMIT 1
      FOR UPDATE`,
  );
  const projected = pending.rows[0];
  if (projected) {
    await client.query(
      `UPDATE selfheal_release_fuse
          SET engaged=TRUE, reason=$2, release_request_id=$1, engaged_at=$3,
              engaged_by=$4, cleared_at=NULL, cleared_by=NULL, personal_ack_at=NULL
        WHERE id=1`,
      [projected.release_request_id, projected.reason, projected.engaged_at, projected.engaged_by],
    );
  } else {
    await client.query(
      `UPDATE selfheal_release_fuse
          SET engaged=FALSE, reason=$2, release_request_id=$1, engaged_at=$3,
              engaged_by=$4, cleared_at=$5, cleared_by=$6, personal_ack_at=$7
        WHERE id=1`,
      [
        rrid,
        epoch.reason,
        epoch.engaged_at,
        epoch.engaged_by,
        epoch.cleared_at,
        epoch.cleared_by,
        epoch.personal_ack_at,
      ],
    );
  }
  if (epoch.cleared_at) return "cleared_epoch";
  if (projected?.release_request_id !== rrid) return "other_epoch";
  return inserted ? "engaged" : "same_epoch";
}

const RELEASE_SURFACE_TO_FACE: Readonly<Record<string, string>> = {
  master: "master",
  web: "web",
  egress: "egress",
  "runtime-source": "runtime",
  "platform-runtime": "platform",
};
const RELEASE_STAGING_SURFACES = new Set(["web", "runtime-source", "platform-runtime", "egress"]);

function callbackProofsCoverPlan(proofs: unknown, planDetail: unknown): boolean {
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) return false;
  if (!planDetail || typeof planDetail !== "object" || Array.isArray(planDetail)) return false;
  const classification = (planDetail as Record<string, unknown>).classification;
  if (!classification || typeof classification !== "object" || Array.isArray(classification)) return false;
  const rawSurfaces = (classification as Record<string, unknown>).surfaces;
  if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) return false;
  const faces = new Set<string>();
  let needsSlot = false;
  for (const surface of rawSurfaces) {
    if (typeof surface !== "string") return false;
    const face = RELEASE_SURFACE_TO_FACE[surface];
    if (!face) return false;
    faces.add(face);
    if (RELEASE_STAGING_SURFACES.has(surface)) needsSlot = true;
  }
  if (needsSlot) faces.add("slot");
  const record = proofs as Record<string, unknown>;
  const present = Object.keys(record);
  if (![...faces].every((face) => present.includes(face))) return false;
  return present.length > 0 && present.every((face) => {
    const proof = record[face];
    return !!proof && typeof proof === "object" && !Array.isArray(proof) &&
      (proof as Record<string, unknown>).ok === true;
  });
}

function deployedCallbackBindingError(
  detail: Record<string, unknown>,
  request: {
    approved_sha: string;
    deploy_plan_hash: string | null;
    manifest_hash: string | null;
    plan_detail: unknown;
  },
  repairId: string,
): string | null {
  if (detail.approvedSha !== request.approved_sha) return "approved_sha";
  if (detail.planHash !== request.deploy_plan_hash) return "deploy_plan_hash";
  if (detail.manifestHash !== request.manifest_hash) return "manifest_hash";
  const expectedRef = `refs/heads/selfheal/candidates/${repairId}-${request.approved_sha.slice(0, 12)}`;
  if (detail.candidateRef !== expectedRef) return "candidate_ref";
  if (!callbackProofsCoverPlan(detail.proofs, request.plan_detail)) return "proofs";
  return null;
}

/** deployed receipt:请求→deployed + 事件 + jti + repair(含 cancel 途中)→verifying 收口(R2-1②/F8③)。 */
async function applyDeployedReceipt(
  client: PoolClient,
  rrid: string,
  repairId: string,
  action: string,
  message: string,
  eventDetail: Record<string, unknown>,
  jti: string | undefined,
): Promise<void> {
  await client.query(
    `UPDATE selfheal_release_requests
        SET status='deployed', updated_at=NOW(), resolved_at=NOW()
      WHERE release_request_id=$1`,
    [rrid],
  );
  let canonicalPushFuse: FuseEngageOutcome | null = null;
  if (eventDetail.canonicalPush === "pending") {
    // The deployment effect is proven live, so the request remains deployed
    // and the repair advances to verifying. Source and production are still
    // divergent, though: mirror the personal-side fuse so this exact epoch can
    // be adjudicated and converged through the normal audited clear protocol.
    canonicalPushFuse = await engageReleaseFuseEpoch(
      client,
      rrid,
      "canonical_push_pending",
      "callback:canonical_push_pending",
    );
  }
  await appendEvent(client, repairId, action, message, eventDetail);
  if (canonicalPushFuse) {
    await appendEvent(
      client,
      repairId,
      "note",
      "CRITICAL deployed effect is live but canonical push is pending; Tier2 release fuse remains engaged until audited convergence.",
      {
        ...eventDetail,
        critical: true,
        fuseEngaged: canonicalPushFuse !== "cleared_epoch",
        fuseOutcome: canonicalPushFuse,
        reason: "canonical_push_pending",
      },
    );
  }
  // 请求 CAS 已是 replay 守卫,jti 消费为 belt-and-suspenders(与正常 done 同纪律)。
  if (jti) await consumeJti(client, repairId, jti, "done");
  // §4/R2-1②:同一事务 repair running/cancel_requested/cancelling → verifying 收口(deployed receipt 胜过
  // 在途 cancel);F8③:repair 已真终态(cancelled/failed/…)时 CAS 0 行,只 append 警示事件(不失败)。
  await settleRepairOnDeployedReceipt(client, repairId, message.slice(0, 1000), eventDetail);
}

/** deploy_unknown receipt:请求→deploy_unknown + 全局熔断 engage + 事件 + F13① critical 告警事件。 */
async function applyDeployUnknownReceipt(
  client: PoolClient,
  rrid: string,
  repairId: string,
  action: string,
  message: string,
  eventDetail: Record<string, unknown>,
  reason: string | null,
): Promise<void> {
  await client.query(
    `UPDATE selfheal_release_requests
        SET status='deploy_unknown', failure_reason=$2, updated_at=NOW(), resolved_at=NOW()
      WHERE release_request_id=$1`,
    [rrid, reason],
  );
  // §4:同事务 engage; cleared epoch tombstones make a delayed old callback a
  // permanent no-op instead of resurrecting a fuse the operator already cleared.
  const fuseOutcome = await engageReleaseFuseEpoch(
    client,
    rrid,
    reason ?? "deploy_unknown",
    "callback:deploy_unknown",
  );
  await appendEvent(client, repairId, action, message, eventDetail);
  // F13①:同事务 append 一条 critical 告警事件(durable 记录);实际 outbox enqueue 由 sweeper
  // fuse-engaged 步幂等发(callback 端不在 tx 内做 fire-and-forget enqueue,避免非事务副作用)。
  await appendEvent(
    client,
    repairId,
    "note",
    `CRITICAL deploy_unknown:全局 Tier2 部署熔断已 engage(reason=${reason ?? "deploy_unknown"});` +
      "禁自动部署,待人工按 /version·deploy_state·远端 ref 裁决后走 fuse-clear 审计流。",
    { ...eventDetail, critical: true, fuseEngaged: fuseOutcome !== "cleared_epoch", fuseOutcome },
  );
}

/**
 * F9a:未知 rrid(break-glass 本地 rrid)终态回调也要收口(操作在 URL/capability 认证的 repair 上;
 * 无请求行可 CAS,故不动 selfheal_release_requests):
 *   - deployed/deploy_unknown → 无冻结请求行可核对,统一按 deploy_unknown 拉熔断等待人工裁决;
 *   - 其余 → 照旧仅记录事件。
 */
async function handleUnknownRridReleaseCallback(
  client: PoolClient,
  repairIdFromPath: string,
  rrid: string,
  releasePhase: string,
  action: string,
  message: string,
  eventDetail: Record<string, unknown>,
  reason: string | null,
): Promise<ActionResult> {
  const body = { status: "release_event_recorded", releaseRequestId: rrid };
  if (releasePhase === "deployed" || releasePhase === "deploy_unknown") {
    const unknownReason = releasePhase === "deployed"
      ? "unknown_release_request_deployed_receipt"
      : reason ?? "deploy_unknown";
    const fuseOutcome = await engageReleaseFuseEpoch(
      client,
      rrid,
      unknownReason,
      "callback:unknown_rrid",
    );
    await appendEvent(client, repairIdFromPath, "failed",
      "release receipt cannot be bound to a frozen request; manual adjudication required",
      { ...eventDetail, releasePhase: "deploy_unknown", reason: unknownReason, fuseOutcome });
    await appendEvent(client, repairIdFromPath, "note",
      `CRITICAL deploy_unknown(未知 rrid):无法核对冻结制品(reason=${unknownReason});禁自动部署,待人工裁决。`,
      {
        ...eventDetail,
        releasePhase: "deploy_unknown",
        critical: true,
        fuseEngaged: fuseOutcome !== "cleared_epoch",
        fuseOutcome,
      });
    return { code: "ok", body: { ...body, status: "deploy_unknown" } };
  }
  // deploying / deploy_failed / manual_required / 非法:照旧仅记录事件(容忍 break-glass)。
  await appendEvent(client, repairIdFromPath, action, message, eventDetail);
  return { code: "ok", body };
}

/**
 * release 回调处理(§4)。传输 action 仍 progress|done|failed,release 语义放 detail:
 *   deploying → progress;deployed → done;deploy_failed/deploy_unknown/manual_required → failed。
 * 分流纪律:
 *   - 有 rrid:**只**更新 selfheal_release_requests(CAS by rrid)+ append event。
 *     `deployed` **同一事务**再做 repair running→verifying 收口(复用 casRepairToVerifying);
 *     `deploy_failed/manual_required` **不**动 repair(停留 running,boss 可重新放行 → 新 rrid);
 *     `deploy_unknown` 同事务 engage 全局熔断 + F13① critical 告警事件。
 *   - rrid 未知 → F9a:deployed/deploy_unknown 也在 URL 认证 repair 上收口,其余仅事件。
 *   - 请求行 status='cancelled' 收到终态 receipt(deployed/deploy_failed/deploy_unknown)→ F2③:
 *     **receipt 胜过乐观 cancel**,照常应用终态转移 + 一条竞态警示事件。
 * 请求行 CAS(WHERE status IN active)是重放/乱序守卫:终态到达即幂等,天然不回退。
 */
async function handleReleaseCallback(
  repairIdFromPath: string,
  rrid: string,
  releasePhase: string,
  action: string,
  message: string,
  detail: Record<string, unknown>,
  jti: string | undefined,
): Promise<ActionResult> {
  // 事件 detail 必带 releaseRequestId+releasePhase(getReleaseRequest 靠它关联;
  // 防个人版 detail 顶层遗漏或被脱敏挪位)。
  const eventDetail: Record<string, unknown> = { ...detail, releaseRequestId: rrid, releasePhase };
  const reason = typeof detail.reason === "string" ? detail.reason.slice(0, 2000) : null;
  return tx(async (client) => {
    // Keep the same lock order as admin approval (repair → request → fuse).
    // The URL/capability already names the authoritative repair, so locking it
    // first avoids the inverse request→repair order that can deadlock an exact
    // approval retry racing a terminal receipt.
    const repairLock = await client.query(
      `SELECT 1 FROM codex_repairs WHERE id = $1::bigint FOR UPDATE`,
      [repairIdFromPath],
    );
    if ((repairLock.rowCount ?? 0) === 0) return { code: "not_found" as const };
    const rq = await client.query<{
      repair_id: string;
      status: string;
      approved_sha: string;
      deploy_plan_hash: string | null;
      manifest_hash: string | null;
      plan_detail: unknown;
    }>(
      `SELECT repair_id::text AS repair_id, status, approved_sha,
              deploy_plan_hash, manifest_hash, plan_detail
         FROM selfheal_release_requests WHERE release_request_id = $1 FOR UPDATE`,
      [rrid],
    );
    if (rq.rows.length === 0) {
      // F9a:未知 rrid(break-glass 本地 rrid 等)终态回调也要收口。
      return handleUnknownRridReleaseCallback(
        client, repairIdFromPath, rrid, releasePhase, action, message, eventDetail, reason,
      );
    }
    // capability 逐 repair 最小权限强绑定:rrid 必须属于 URL/capability 认证的同一 repair。
    // 否则"repair X 的 capability + repair Y 的 rrid"可跨界推进他人请求(污染事件流/
    // deployed 推 verifying/deploy_unknown 拉全局熔断)。不匹配 = 409,不泄露行归属。
    if (rq.rows[0].repair_id !== repairIdFromPath) {
      return { code: "conflict", message: "releaseRequestId does not belong to this repair" };
    }
    const repairId = rq.rows[0].repair_id;
    const curStatus = rq.rows[0].status;

    // Validate a success receipt before any terminal idempotency shortcut. A
    // malformed replay against an already-terminal request remains a protocol
    // breach and must not be silently acknowledged as a valid deployment.
    if (releasePhase === "deployed") {
      const bindingError = deployedCallbackBindingError(detail, rq.rows[0], repairId);
      if (bindingError) {
        const mismatchReason = `deployed_receipt_binding_mismatch:${bindingError}`;
        await applyDeployUnknownReceipt(
          client,
          rrid,
          repairId,
          "failed",
          "deployed receipt failed frozen tuple/proof validation",
          { ...eventDetail, releasePhase: "deploy_unknown", receiptBindingError: bindingError },
          mismatchReason,
        );
        if (jti) await consumeJti(client, repairId, jti, "done");
        return { code: "ok", body: { status: "deploy_unknown", releaseRequestId: rrid } };
      }
    }

    // F2③:请求已被乐观置 cancelled,但收到终态 receipt → receipt 胜(照常应用终态转移)。
    const cancelReceiptRace = curStatus === "cancelled" && TERMINAL_RECEIPT_PHASES.has(releasePhase);
    // 终态/cancelled:幂等,只记录事件不改状态(per-repair 保序保证 deploying 先于终态)。
    // 例外:cancelled × 终态 receipt(cancelReceiptRace)落到下方 switch 应用终态转移。
    if (!RELEASE_ACTIVE.includes(curStatus) && !cancelReceiptRace) {
      await appendEvent(client, repairId, action, message, eventDetail);
      return { code: "ok", body: { status: curStatus, releaseRequestId: rrid } };
    }
    if (cancelReceiptRace) {
      // 竞态警示事件:请求已乐观 cancel,个人版 receipt 表明部署实际有了终态。下方终态 UPDATE
      // 无 status 守卫,会从 cancelled 覆盖到 receipt 终态(deployed 仍推 verifying / deploy_unknown 仍拉熔断)。
      await appendEvent(client, repairId, "note",
        `cancel/receipt 竞态,receipt 胜(releasePhase=${releasePhase}):${message}`,
        { ...eventDetail, cancelReceiptRace: true });
    }

    switch (releasePhase) {
      case "deploying": {
        await client.query(
          `UPDATE selfheal_release_requests SET status='deploying', updated_at=NOW()
            WHERE release_request_id=$1 AND status IN ('queued','accepted','deploying')`,
          [rrid],
        );
        await appendEvent(client, repairId, action, message, eventDetail);
        return { code: "ok", body: { status: "deploying", releaseRequestId: rrid } };
      }
      case "deployed": {
        await applyDeployedReceipt(client, rrid, repairId, action, message, eventDetail, jti);
        return { code: "ok", body: { status: "deployed", releaseRequestId: rrid } };
      }
      case "deploy_failed":
      case "manual_required": {
        await client.query(
          `UPDATE selfheal_release_requests
              SET status=$2, failure_reason=$3, updated_at=NOW(), resolved_at=NOW()
            WHERE release_request_id=$1`,
          [rrid, releasePhase, reason],
        );
        await appendEvent(client, repairId, action, message, eventDetail);
        // repair 不动(停留 running,pending_release 姿态)。
        return { code: "ok", body: { status: releasePhase, releaseRequestId: rrid } };
      }
      case "deploy_unknown": {
        await applyDeployUnknownReceipt(client, rrid, repairId, action, message, eventDetail, reason);
        return { code: "ok", body: { status: "deploy_unknown", releaseRequestId: rrid } };
      }
      default: {
        // rrid 已知但 releasePhase 非法:仅记录事件(留痕),不改状态,200 ack 避免重投风暴。
        await appendEvent(client, repairId, action, message, eventDetail);
        return { code: "ok", body: { status: curStatus, releaseRequestId: rrid } };
      }
    }
  });
}

// ─── 端点分发 ──────────────────────────────────────────────────────────

const CAPABILITY_ACTIONS = new Set(["ack", "progress", "verify", "done", "failed"]);

/** router ANY_METHOD prefix handler:按 method + action 分发。鉴权自理(capability / webhook HMAC)。 */
export async function dispatchSelfhealRepairsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  setSecurityHeaders(res);
  const requestId = ensureRequestId(req);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const now = Date.now();

  if (!isLoopback(req)) {
    sendError(res, 403, "FORBIDDEN", "loopback only", requestId);
    return;
  }

  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`).pathname;
  const m = ROUTE_RE.exec(path);
  if (!m) {
    sendError(res, 404, "NOT_FOUND", "endpoint not found", requestId);
    return;
  }
  const repairId = m[1];
  const action = m[2];
  const method = req.method ?? "GET";

  // ── GET context(capability)──
  if (action === "context") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "GET required", requestId, undefined, { Allow: "GET" });
      return;
    }
    const cap = verifyCapability(bearer(req) ?? "", repairId, now);
    if (!cap.ok) {
      sendError(res, 401, "UNAUTHORIZED", "invalid capability", requestId);
      return;
    }
    try {
      const ctx = await getRepairContext(repairId, { query });
      if (!ctx) {
        sendError(res, 404, "NOT_FOUND", "repair not found", requestId);
        return;
      }
      sendJson(res, 200, ctx, { [REQUEST_ID_HEADER]: requestId });
    } catch (err) {
      if (err instanceof RangeError) {
        sendError(res, 400, "VALIDATION", "invalid repair id", requestId);
        return;
      }
      log.error("selfheal_context_failed", { repairId, err: (err as Error)?.message });
      sendError(res, 500, "INTERNAL", "context lookup failed", requestId);
    }
    return;
  }

  // ── POST claim-capability(webhook HMAC)──
  if (action === "claim-capability") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId, undefined, { Allow: "POST" });
      return;
    }
    let rawBody = "";
    try {
      rawBody = await readRawText(req);
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }
    if (!(await verifyWebhookSig(req, repairId, path, rawBody, now))) {
      sendError(res, 401, "UNAUTHORIZED", "invalid webhook signature", requestId);
      return;
    }
    const st = await loadRepair(repairId);
    if (!st) {
      sendError(res, 404, "NOT_FOUND", "repair not found", requestId);
      return;
    }
    // 仅活跃修复可换 capability(终态修复不需要回调面)。
    if (!ACTIVE.includes(st.status) && st.status !== "pending") {
      sendError(res, 409, "CONFLICT", `repair is ${st.status}`, requestId);
      return;
    }
    const cap = issueCapability(repairId, st.attempt, now);
    sendJson(res, 200, { token: cap.token, exp: cap.exp, attempt: st.attempt }, {
      [REQUEST_ID_HEADER]: requestId,
    });
    return;
  }

  // ── POST ack/progress/verify/done/failed(capability)──
  if (!CAPABILITY_ACTIONS.has(action)) {
    sendError(res, 404, "NOT_FOUND", "endpoint not found", requestId);
    return;
  }
  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId, undefined, { Allow: "POST" });
    return;
  }
  const cap = verifyCapability(bearer(req) ?? "", repairId, now);
  if (!cap.ok) {
    sendError(res, 401, "UNAUTHORIZED", "invalid capability", requestId);
    return;
  }

  let parsed: z.infer<typeof CallbackBody>;
  try {
    const raw = await readJsonBody(req);
    const r = CallbackBody.safeParse(raw);
    if (!r.success) {
      sendError(res, 400, "INVALID_BODY", "body schema rejected", requestId);
      return;
    }
    parsed = r.data;
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.code, err.message, requestId);
      return;
    }
    throw err;
  }

  // 批1b:release 回调分流(§4)。detail.releaseRequestId 存在 = release 语义(progress/done/
  // failed 传输仍不变,语义在 detail.releasePhase);无 rrid = 原 repair 语义完全不变。
  // rrid/phase 取**未脱敏**的 parsed.detail(路由字段,非凭据)。
  const rawDetail = parsed.detail;
  const rawRrid = rawDetail?.releaseRequestId;
  if (rawRrid !== undefined &&
      (typeof rawRrid !== "string" || !RELEASE_REQUEST_ID_RE.test(rawRrid))) {
    sendError(res, 400, "INVALID_BODY", "invalid releaseRequestId", requestId);
    return;
  }
  const rrid = typeof rawRrid === "string" ? rawRrid : null;
  const releasePhase =
    rawDetail && typeof rawDetail.releasePhase === "string" ? rawDetail.releasePhase : "";
  const isReleaseAction = action === "progress" || action === "done" || action === "failed";

  const detail = safeDetail(parsed.detail);
  // M4:message 是 codex 自由文本,同样过值级凭据清洗(key 级对纯字符串是 no-op)。
  const message = scrubSecretsInString(parsed.message);

  try {
    let result: ActionResult;
    if (rrid && isReleaseAction) {
      result = await handleReleaseCallback(repairId, rrid, releasePhase, action, message, detail, cap.jti);
    } else {
      switch (action) {
        case "ack":
          result = await handleAck(repairId, message, detail);
          break;
        case "progress":
          result = await handleProgress(repairId, message, detail);
          break;
        case "verify":
          result = await handleVerify(repairId, message, detail);
          break;
        case "done":
          result = await handleDone(repairId, message, detail, cap.jti!);
          break;
        case "failed":
          result = await handleFailed(repairId, message, detail, cap.jti!);
          break;
        default:
          result = { code: "not_found" };
      }
    }
    if (result.code === "not_found") {
      sendError(res, 404, "NOT_FOUND", "repair not found", requestId);
      return;
    }
    if (result.code === "conflict") {
      sendError(res, 409, "CONFLICT", result.message, requestId);
      return;
    }
    sendJson(res, 200, { ok: true, ...result.body }, { [REQUEST_ID_HEADER]: requestId });
  } catch (err) {
    log.error("selfheal_callback_failed", { repairId, action, err: (err as Error)?.message });
    sendError(res, 500, "INTERNAL", "callback processing failed", requestId);
  }
}

/** 读 raw 文本 body(claim-capability 需原文算 bodySha256)。复用 util 大小上限语义。 */
async function readRawText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 64 * 1024;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large");
    chunks.push(buf);
  }
  return total === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}
