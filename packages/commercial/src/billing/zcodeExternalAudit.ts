/**
 * Audit-only persistence for the experimental community ZCode CLI.
 * No invented token rates and no Cursor credential / account-pool reuse.
 *
 * Pending rows are the durability source. In-memory ids are a hint and may
 * only be dropped after a terminal UPDATE succeeds or the row is already
 * terminal. Process restart recovers leftover pending rows via created_at.
 */
import type { Pool } from "pg";

export const ZCODE_AUDIT_MODEL_ID = "zcode-experimental";
export const ZCODE_AUDIT_STALE_AFTER_MS = 30 * 60 * 1000;
export const ZCODE_AUDIT_RETRY_BACKOFF_MS = [0, 25, 75] as const;

export type ZcodeAuditStatus = "pending" | "success" | "error" | "unavailable";
export type ZcodeAuditTerminal =
  | "USER_CANCELLED"
  | "AUTH_UNAVAILABLE"
  | "QUOTA_UNAVAILABLE"
  | "ENGINE_ERROR";

export type ZcodeAuditUsage = Record<string, unknown> | null;
export type ZcodeFinalizeOutcome = "closed" | "already_terminal" | "unknown" | "failed";

const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const TERMINAL_STATUSES = new Set<ZcodeAuditStatus>(["success", "error", "unavailable"]);

export type ZcodeAuditClock = {
  sleep: (ms: number) => Promise<void>;
};

const defaultClock: ZcodeAuditClock = {
  sleep: (ms) => {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  },
};

export function assertZcodeAuditIdentity(args: {
  requestId: string;
  modelId: string;
}): void {
  if (!REQUEST_ID_RE.test(args.requestId)) {
    throw new Error("zcode audit requestId is invalid");
  }
  if (args.modelId !== ZCODE_AUDIT_MODEL_ID) {
    throw new Error("zcode audit model_id is not the experimental allowlist");
  }
}

export function rememberZcodePending(pending: Set<string>, requestId: string): void {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new Error("zcode audit requestId is invalid");
  }
  pending.add(requestId);
}

export function applyZcodeFinalizeOutcome(
  pending: Set<string>,
  requestId: string,
  outcome: ZcodeFinalizeOutcome,
): void {
  if (outcome === "closed" || outcome === "already_terminal") {
    pending.delete(requestId);
  }
}

export async function insertPendingZcodeAudit(
  pool: Pool,
  args: {
    requestId: string;
    userId: bigint | number;
    containerId: number;
    sessionId: string | null;
    modelId: string;
  },
): Promise<void> {
  assertZcodeAuditIdentity(args);
  await pool.query(
    `INSERT INTO zcode_external_usage_audit(request_id,user_id,container_id,session_id,model_id,status)
     VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT (request_id) DO NOTHING`,
    [args.requestId, args.userId, args.containerId, args.sessionId, args.modelId],
  );
}

export async function closeZcodeAudit(
  pool: Pool,
  args: {
    requestId: string;
    userId: bigint | number;
    status: Exclude<ZcodeAuditStatus, "pending">;
    terminalCode: ZcodeAuditTerminal | null;
    durationMs: number;
    usage: ZcodeAuditUsage;
  },
): Promise<ZcodeFinalizeOutcome> {
  if (!REQUEST_ID_RE.test(args.requestId)) {
    throw new Error("zcode audit requestId is invalid");
  }
  if (!Number.isFinite(args.durationMs) || args.durationMs < 0) {
    throw new Error("zcode audit durationMs is invalid");
  }
  const updated = await pool.query(
    `UPDATE zcode_external_usage_audit
        SET status=$2, terminal_code=$3, duration_ms=$4, reported_usage=$5, completed_at=NOW()
      WHERE request_id=$1 AND user_id=$6 AND status='pending'`,
    [
      args.requestId,
      args.status,
      args.terminalCode,
      Math.floor(args.durationMs),
      args.usage,
      args.userId,
    ],
  );
  if ((updated.rowCount ?? 0) > 0) return "closed";

  const existing = await pool.query<{ status: string; user_id: string | number | bigint }>(
    `SELECT status, user_id FROM zcode_external_usage_audit WHERE request_id=$1`,
    [args.requestId],
  );
  const row = existing.rows[0];
  if (!row) return "unknown";
  if (String(row.user_id) !== String(args.userId)) return "unknown";
  if (TERMINAL_STATUSES.has(row.status as ZcodeAuditStatus)) return "already_terminal";
  return "failed";
}

export async function closeZcodeAuditWithRetry(
  pool: Pool,
  args: Parameters<typeof closeZcodeAudit>[1],
  clock: ZcodeAuditClock = defaultClock,
): Promise<ZcodeFinalizeOutcome> {
  let last: ZcodeFinalizeOutcome = "failed";
  for (let attempt = 0; attempt < ZCODE_AUDIT_RETRY_BACKOFF_MS.length; attempt++) {
    try {
      last = await closeZcodeAudit(pool, args);
      if (last === "closed" || last === "already_terminal" || last === "unknown") {
        return last;
      }
    } catch {
      last = "failed";
    }
    const wait = ZCODE_AUDIT_RETRY_BACKOFF_MS[attempt];
    if (wait !== undefined && attempt < ZCODE_AUDIT_RETRY_BACKOFF_MS.length - 1) {
      await clock.sleep(wait);
    }
  }
  return last;
}

export async function abortInsertedZcodeAudit(
  pool: Pool,
  args: {
    requestId: string;
    userId: bigint | number;
    pending: Set<string>;
    terminalCode?: ZcodeAuditTerminal;
    clock?: ZcodeAuditClock;
  },
): Promise<ZcodeFinalizeOutcome> {
  const outcome = await closeZcodeAuditWithRetry(
    pool,
    {
      requestId: args.requestId,
      userId: args.userId,
      status: "error",
      terminalCode: args.terminalCode ?? "ENGINE_ERROR",
      durationMs: 0,
      usage: null,
    },
    args.clock,
  );
  applyZcodeFinalizeOutcome(args.pending, args.requestId, outcome);
  return outcome;
}

export async function closePendingZcodeAudits(
  pool: Pool,
  args: {
    userId: bigint | number;
    requestIds: readonly string[];
    terminalCode: ZcodeAuditTerminal;
    pending?: Set<string>;
    clock?: ZcodeAuditClock;
  },
): Promise<string[]> {
  const closed: string[] = [];
  for (const requestId of args.requestIds) {
    if (!REQUEST_ID_RE.test(requestId)) continue;
    const outcome = await closeZcodeAuditWithRetry(
      pool,
      {
        requestId,
        userId: args.userId,
        status: "error",
        terminalCode: args.terminalCode,
        durationMs: 0,
        usage: null,
      },
      args.clock,
    );
    if (args.pending) applyZcodeFinalizeOutcome(args.pending, requestId, outcome);
    if (outcome === "closed" || outcome === "already_terminal") closed.push(requestId);
  }
  return closed;
}

export async function reconcileStaleZcodeAudits(
  pool: Pool,
  args: { staleAfterMs?: number; limit?: number } = {},
): Promise<string[]> {
  const staleAfterMs = args.staleAfterMs ?? ZCODE_AUDIT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new Error("zcode stale TTL is invalid");
  }
  const limit = args.limit ?? 100;
  const updated = await pool.query<{ request_id: string }>(
    `UPDATE zcode_external_usage_audit
        SET status='error', terminal_code='ENGINE_ERROR', completed_at=NOW()
      WHERE request_id IN (
        SELECT request_id FROM zcode_external_usage_audit
         WHERE status='pending' AND created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
         ORDER BY created_at ASC
         LIMIT $2
      )
      RETURNING request_id`,
    [staleAfterMs, limit],
  );
  return updated.rows.map((row) => row.request_id);
}

export function zcodeCleanupTerminal(
  cause: string,
): ZcodeAuditTerminal {
  return cause === "client_close" ? "USER_CANCELLED" : "ENGINE_ERROR";
}

export function zcodeAdmissionAbortTerminal(
  step: "seal_rejected" | "frame_too_big" | "send_failed",
): ZcodeAuditTerminal {
  void step;
  return "ENGINE_ERROR";
}
