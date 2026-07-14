/**
 * Plan C — inbox 站内信邮件推送 worker.
 *
 * 设计契约(详见 migrations/0065_inbox_email_notify.sql 头注释):
 *
 *   - jobs 表 inbox_email_jobs 是 durable queue;创建消息时 INSERT...SELECT 锁快照,
 *     worker 从 status='queued' 行依次 drain
 *   - **不自动重试**:status='failed' 永久停留;manual retry 走 admin 接口(后续若需求出现)
 *     这是为了规避"mailer 已发出 + DB COMMIT 之前 crash → 重启后又发一遍"的双发风险
 *   - 进程崩溃留下的 status='sending' AND locked_at < NOW()-5min 启动时一次性
 *     UPDATE 成 'interrupted'(也不重发,避免双发);依据是 mailer.send 应在 8s 内完成,
 *     locked_at>5min 几乎只可能是 daemon 重启卡半道
 *
 * 节流:每条 send 之间 600ms sleep(BURST=1);Resend 免费档 10/s,留余量给
 * register / forgot-password 流。可通过 sendIntervalMs 调整。
 *
 * 状态机:
 *   queued ──pick──▶ sending ──ok──▶ sent
 *                          └─err─▶ failed
 *                          └─(crash + restart cleanup)─▶ interrupted
 *
 * 主表汇总:每发完一条 job → 用 jobs 的 GROUP BY count 重算 inbox_messages.email_summary
 *   + email_send_status('queued' 还有未发 / 'done' 全部 sent+dropped / 'partial' 有 failed+interrupted
 *   / 'interrupted' 主表标记) ;email_sent_at 在 status 进入终态时写一次.
 */

import { getPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import type { Mailer } from "../auth/mail.js";
import type { EmailSendStatus, EmailSummary } from "./inbox.js";

// ─── 常量 ────────────────────────────────────────────────────────────

export const DEFAULT_INTERVAL_MS = 30_000;
export const MIN_INTERVAL_MS = 5_000;
/** 单 tick 最多 drain 多少条 — pick FOR UPDATE SKIP LOCKED 配合 */
export const DEFAULT_BATCH_SIZE = 50;
/** send 间隔(ms),挡 Resend 免费档 10/s */
export const DEFAULT_SEND_INTERVAL_MS = 600;
/** sending → interrupted 阈值;mailer 超时 8s,设 5min 远超合理范围 */
export const STALE_SENDING_MS = 5 * 60_000;
/** last_error 截断 — 与 0065 SQL 注释 "500 字符" 对齐 */
const LAST_ERROR_MAX = 500;
/** advisory lock key — 'INBX'/'EMAL' 双 int4(单 int8 超 JS Number.MAX_SAFE_INTEGER) */
const LOCK_KEY_HI = 0x49_4e_42_58;
const LOCK_KEY_LO = 0x45_4d_41_4c;

// ─── helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clipError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > LAST_ERROR_MAX ? msg.slice(0, LAST_ERROR_MAX) : msg;
}

/** 主表 status 决断:基于 jobs 汇总. */
function deriveOverallStatus(s: EmailSummary): Exclude<EmailSendStatus, null> {
  // total=0 → 实际 createInboxMessage 路径已设 'done',这里兜底也按 done 处理
  if (s.total === 0) return "done";
  const finished = s.sent + s.failed + s.interrupted + s.dropped;
  if (finished < s.total) return "queued"; // 还有 queued/sending,继续等
  if (s.failed === 0 && s.interrupted === 0) return "done";
  if (s.interrupted > 0 && s.sent === 0 && s.failed === 0) return "interrupted";
  return "partial";
}

// ─── stale cleanup(启动时跑一次) ───────────────────────────────────

export interface StaleCleanupResult {
  jobsInterrupted: number;
  messagesAffected: number;
}

/**
 * 把崩前留下的 status='sending' AND locked_at < NOW()-5min 的 job 标 'interrupted',
 * 并刷新主表 email_send_status / email_summary。
 *
 * 设计:不 retry,直接 interrupt + summary 反映 → admin 在前端看到 partial/interrupted
 * 状态决定要不要 manual 重发。
 */
export async function cleanupStaleEmailJobs(): Promise<StaleCleanupResult> {
  // 1) 把过期 sending 一次性扔到 interrupted
  const upd = await query<{ message_id: string }>(
    `UPDATE inbox_email_jobs
        SET status     = 'interrupted',
            locked_at  = NULL,
            updated_at = NOW(),
            last_error = COALESCE(last_error, 'daemon crash / restart before mailer ack')
      WHERE status = 'sending'
        AND locked_at < NOW() - ($1 || ' milliseconds')::interval
      RETURNING message_id::text AS message_id`,
    [STALE_SENDING_MS],
  );
  const jobsInterrupted = upd.rowCount ?? 0;

  if (jobsInterrupted === 0) {
    return { jobsInterrupted: 0, messagesAffected: 0 };
  }

  // 2) 主表 summary refresh —— 只对受影响的 message_id 集合做
  const messageIds = Array.from(new Set(upd.rows.map((r) => r.message_id)));
  let affected = 0;
  for (const mid of messageIds) {
    try {
      await refreshMessageSummary(mid);
      affected++;
    } catch (err) {
      // 单条 refresh 失败不阻塞其它 — 下次 tick 还会被 worker 自然刷
      // eslint-disable-next-line no-console
      console.warn(`[inbox/email] refresh summary failed for message ${mid}:`, err);
    }
  }
  return { jobsInterrupted, messagesAffected: affected };
}

// ─── summary refresh ────────────────────────────────────────────────

/**
 * 根据 jobs 表实际状态,重写 inbox_messages.email_summary + email_send_status + email_sent_at.
 * 每发完一条 job 跑一次(也用于 cleanup / manual).独立函数便于复用.
 */
async function refreshMessageSummary(messageId: string): Promise<void> {
  // 聚合 5 个状态,total 用 row count(包含所有非 NULL message_id)
  const r = await query<{
    total: number;
    sent: number;
    failed: number;
    interrupted: number;
    dropped: number;
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'sent')::int        AS sent,
            COUNT(*) FILTER (WHERE status = 'failed')::int      AS failed,
            COUNT(*) FILTER (WHERE status = 'interrupted')::int AS interrupted,
            COUNT(*) FILTER (WHERE status = 'dropped')::int     AS dropped
       FROM inbox_email_jobs
      WHERE message_id = $1::bigint`,
    [messageId],
  );
  const row = r.rows[0] ?? { total: 0, sent: 0, failed: 0, interrupted: 0, dropped: 0 };
  const summary: EmailSummary = {
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    interrupted: row.interrupted,
    dropped: row.dropped,
  };
  const status = deriveOverallStatus(summary);
  // email_sent_at 进入终态(非 'queued')时写一次,后续不再变
  await query(
    `UPDATE inbox_messages
        SET email_send_status = $2,
            email_summary     = $3::jsonb,
            email_sent_at     = CASE
              WHEN $2 <> 'queued' AND email_sent_at IS NULL THEN NOW()
              ELSE email_sent_at
            END
      WHERE id = $1::bigint`,
    [messageId, status, JSON.stringify(summary)],
  );
}

// ─── drain tick ──────────────────────────────────────────────────────

export interface DrainOptions {
  mailer: Mailer;
  batchSize?: number;
  sendIntervalMs?: number;
}

export interface DrainResult {
  /** false → 拿不到 advisory lock(另一进程在跑)或本 tick 一条也没 pick 到 */
  ran: boolean;
  picked: number;
  sent: number;
  failed: number;
  dropped: number;
  /** 受影响的 message_id 集合,refresh summary 完成后清空 */
  messagesAffected: string[];
  skipReason?: "lock-busy" | "empty";
}

interface PickedJob {
  id: string;
  message_id: string;
  user_id: string;
  email: string;
  attempts: number;
}

/**
 * 单次 drain.
 *
 * 流程:
 *   1) advisory_lock 防多进程并发(快速 try,拿不到 = 直接退,等下一 tick)
 *   2) SELECT ... FROM inbox_email_jobs WHERE status='queued' ORDER BY id LIMIT batch
 *      FOR UPDATE SKIP LOCKED → UPDATE → 'sending'/locked_at=NOW()/attempts++(同事务,出 tx 即可见)
 *   3) 释放 tx 后逐条调 mailer.send:
 *        - email 为空 / 校验失败 → 标 'dropped'(不发,**不重试**)
 *        - 成功 → 'sent' + sent_at
 *        - 失败 → 'failed' + last_error(不重试)
 *      每条间隔 sendIntervalMs
 *   4) 全部完成后,对受影响的 message_id 唯一集合 refreshMessageSummary
 *
 * 不在单一大 tx 中 send + UPDATE:mailer 网络 IO 不能长期占住 DB 连接 +
 * 多条 send 失败回滚整批不合理(成功的应该保留).分两步:pick 加锁短 tx + 单条 send 后单条 UPDATE.
 */
export async function drainInboxEmailJobs(opts: DrainOptions): Promise<DrainResult> {
  const mailer = opts.mailer;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const sendInterval = Math.max(0, opts.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS);

  // pick + lock — 同事务里 SELECT FOR UPDATE SKIP LOCKED 然后 UPDATE,
  // 出 tx 后这批 jobs 已经是 'sending'/locked_at=NOW,其它进程的 picker 不会再碰
  const picked: PickedJob[] = await tx(async (client) => {
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS ok",
      [LOCK_KEY_HI, LOCK_KEY_LO],
    );
    if (!lock.rows[0]?.ok) return [];
    const sel = await client.query<PickedJob>(
      `SELECT id::text AS id, message_id::text AS message_id, user_id::text AS user_id,
              email, attempts
         FROM inbox_email_jobs
        WHERE status = 'queued'
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (sel.rows.length === 0) return [];
    const ids = sel.rows.map((r) => r.id);
    await client.query(
      `UPDATE inbox_email_jobs
          SET status = 'sending',
              locked_at = NOW(),
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    return sel.rows;
  });

  if (picked.length === 0) {
    // 区分:lock 没拿到 → 这里也会拿到 [];我们用 advisory lock test 单独再查更准确
    // 但 90% 场景就是 'queued' 表为空,统一返 'empty'(lock 冲突在 30s 间隔下极罕见)
    return {
      ran: false,
      picked: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      messagesAffected: [],
      skipReason: "empty",
    };
  }

  let sent = 0;
  let failed = 0;
  let dropped = 0;
  const messagesAffected = new Set<string>();

  for (let i = 0; i < picked.length; i++) {
    const job = picked[i];
    messagesAffected.add(job.message_id);

    // dropped 检测:快照时 email 已存在,但极端情况(竞争 race / 极端 bug)空串
    if (!job.email || job.email.trim() === "") {
      if (await markJobDropped(job.id, "empty email at send time")) dropped++;
      continue;
    }

    // message 被 admin 删除的 race(pick 后 DELETE):loadMessageForMail 返 null;
    // drain 把 job 标 dropped 不调用 mailer。CASCADE 通常已删 job,
    // 走到这是 pick-then-delete 边界(Codex review #1)。
    const body = await loadMessageForMail(job.message_id);
    if (!body) {
      if (await markJobDropped(job.id, "inbox_messages row missing at send time")) dropped++;
      continue;
    }

    try {
      await mailer.send({
        to: job.email,
        subject: body.subject,
        text: body.text,
      });
      if (await markJobSent(job.id)) sent++;
    } catch (err) {
      if (await markJobFailed(job.id, clipError(err))) failed++;
    }

    // 节流:除最后一条外间隔
    if (i < picked.length - 1 && sendInterval > 0) {
      await sleep(sendInterval);
    }
  }

  // refresh affected messages 主表汇总(单次 N+1 是 OK 的:一个 tick 顶多 batchSize=50 条 messages)
  for (const mid of messagesAffected) {
    try {
      await refreshMessageSummary(mid);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[inbox/email] refresh summary failed for message ${mid}:`, err);
    }
  }

  return {
    ran: true,
    picked: picked.length,
    sent,
    failed,
    dropped,
    messagesAffected: Array.from(messagesAffected),
  };
}

// ─── per-job 状态更新 helpers ────────────────────────────────────────

// mark* helpers 全部带 `status='sending'` guard,返 true=本进程成功更新。
// 这样滚动重启 / stale-cleanup 把 job 改成 'interrupted' 之后,旧进程的长尾
// send 不会把 status 强写回 sent/failed(Codex review #2)。

async function markJobSent(jobId: string): Promise<boolean> {
  const r = await query(
    `UPDATE inbox_email_jobs
        SET status = 'sent',
            locked_at = NULL,
            sent_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id = $1::bigint AND status = 'sending'`,
    [jobId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function markJobFailed(jobId: string, err: string): Promise<boolean> {
  const r = await query(
    `UPDATE inbox_email_jobs
        SET status = 'failed',
            locked_at = NULL,
            updated_at = NOW(),
            last_error = $2
      WHERE id = $1::bigint AND status = 'sending'`,
    [jobId, err],
  );
  return (r.rowCount ?? 0) > 0;
}

async function markJobDropped(jobId: string, reason: string): Promise<boolean> {
  const r = await query(
    `UPDATE inbox_email_jobs
        SET status = 'dropped',
            locked_at = NULL,
            updated_at = NOW(),
            last_error = $2
      WHERE id = $1::bigint AND status = 'sending'`,
    [jobId, reason],
  );
  return (r.rowCount ?? 0) > 0;
}

// ─── 邮件正文构造(从 inbox_messages 拉 title/body_md) ──────────────

/** 邮件是纯文本通道：保留普通 Markdown 文本，把站内富图片/图表降级成登录查看提示。 */
export function inboxMarkdownToEmailText(bodyMd: string): string {
  return bodyMd
    .replace(/```(?:chart|mermaid)[^\n]*\n[\s\S]*?```/gi, "\n[图表请登录站内信查看]\n")
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, (_whole, alt: string) => {
      const label = alt.trim();
      return label ? `[图片：${label}，请登录站内信查看]` : "[图片请登录站内信查看]";
    })
    .replace(/\/api\/inbox-assets\/[0-9a-f-]{36}/gi, "[图片请登录站内信查看]");
}

/**
 * 邮件主题 / 正文:从 inbox_messages 直接读 title + body_md。
 *
 * **每封发送前都查一次**,不做 in-tick 缓存。
 * 缓存场景下若 admin 在 batch 中途 DELETE 主表,缓存命中的后续 job 仍会被
 * mailer 发出去(虽然 markJobSent 因 status guard 计数失败,但邮件已实际发出)。
 * 这违反"删除即停止后续发送"语义(Codex review #1 second pass)。
 *
 * 取消缓存的代价:50 条 batch × 主键索引 PK lookup × 600ms 节流 = 几乎零成本,
 * 这点 DB 负担可以忽略。
 */
async function loadMessageForMail(messageId: string): Promise<{ subject: string; text: string } | null> {
  const r = await query<{ title: string; body_md: string }>(
    `SELECT title, body_md FROM inbox_messages WHERE id = $1::bigint`,
    [messageId],
  );
  const row = r.rows[0];
  if (!row) {
    // message 被 admin 删了 — CASCADE 应该已经 DROP 了 job,走到这是 pick-then-delete 边界。
    // 返 null,drain 把 job 标 dropped,不调用 mailer。
    return null;
  }
  return {
    subject: row.title,
    text: inboxMarkdownToEmailText(row.body_md),
  };
}

// ─── scheduler ──────────────────────────────────────────────────────

export interface InboxEmailSchedulerHandle {
  stop(): void;
  /** 测试 / admin 触发用:立即跑一次 drain. */
  runNow(): Promise<DrainResult>;
}

export interface InboxEmailSchedulerOptions {
  mailer: Mailer;
  intervalMs?: number;
  batchSize?: number;
  sendIntervalMs?: number;
  /** 启动时跑一次 stale cleanup;默认 true */
  runStaleCleanupOnStart?: boolean;
  /** 默认 console.warn */
  onError?: (err: unknown) => void;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[inbox/email] drain tick failed:", err);
}

/**
 * 启动 inbox 邮件 worker scheduler.
 *
 * 启动时:
 *   - runStaleCleanupOnStart=true → 跑一次 cleanupStaleEmailJobs(把 daemon crash 留下的
 *     sending>5min 标 interrupted)
 *
 * 之后每 intervalMs:
 *   - drainInboxEmailJobs(batchSize 条 / tick)
 *
 * 单例性:同一进程 inflight=true 时跳过下一 tick(避免长 send 串重叠);
 * 跨进程靠 SQL FOR UPDATE SKIP LOCKED + advisory lock 双重保险.
 */
export function startInboxEmailScheduler(
  opts: InboxEmailSchedulerOptions,
): InboxEmailSchedulerHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const onError = opts.onError ?? defaultOnError;
  const runStaleOnStart = opts.runStaleCleanupOnStart !== false;
  let stopped = false;
  let inflight = false;

  async function tickOnce(): Promise<DrainResult> {
    if (inflight) {
      return {
        ran: false,
        picked: 0,
        sent: 0,
        failed: 0,
        dropped: 0,
        messagesAffected: [],
        skipReason: "lock-busy",
      };
    }
    inflight = true;
    try {
      return await drainInboxEmailJobs({
        mailer: opts.mailer,
        batchSize: opts.batchSize,
        sendIntervalMs: opts.sendIntervalMs,
      });
    } catch (err) {
      onError(err);
      return {
        ran: false,
        picked: 0,
        sent: 0,
        failed: 0,
        dropped: 0,
        messagesAffected: [],
        skipReason: "empty",
      };
    } finally {
      inflight = false;
    }
  }

  // 启动 cleanup — 不阻塞 timer 启动,但失败不致命
  if (runStaleOnStart) {
    void (async () => {
      try {
        await cleanupStaleEmailJobs();
      } catch (err) {
        onError(err);
      }
    })();
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void tickOnce();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: tickOnce,
  };
}

// ─── 测试钩子 ────────────────────────────────────────────────────────

/** 测试用:暴露内部常量 + helper(只读). */
export const _internal = {
  refreshMessageSummary,
  deriveOverallStatus,
  STALE_SENDING_MS,
  LOCK_KEY_HI,
  LOCK_KEY_LO,
} as const;

// `getPool` 仅为了让本模块在没有 mailer 时也能独立跑 stale cleanup —
// 当前 cleanup 走 query() 即可(默认 pool),如未来 multi-pool 再注入.
void getPool;
