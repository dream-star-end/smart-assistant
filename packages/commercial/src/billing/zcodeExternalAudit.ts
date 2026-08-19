/**
 * Audit-only persistence for the experimental community ZCode CLI.
 * No invented token rates and no Cursor credential / account-pool reuse.
 */
import type { Pool } from "pg";

export const ZCODE_AUDIT_MODEL_ID = "zcode-experimental";

export type ZcodeAuditStatus = "pending" | "success" | "error" | "unavailable";
export type ZcodeAuditTerminal =
  | "USER_CANCELLED"
  | "AUTH_UNAVAILABLE"
  | "QUOTA_UNAVAILABLE"
  | "ENGINE_ERROR";

export type ZcodeAuditUsage = Record<string, unknown> | null;

const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

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
): Promise<boolean> {
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
  return (updated.rowCount ?? 0) > 0;
}

export async function closePendingZcodeAudits(
  pool: Pool,
  args: {
    userId: bigint | number;
    requestIds: readonly string[];
    terminalCode: ZcodeAuditTerminal;
  },
): Promise<number> {
  const ids = args.requestIds.filter((id) => REQUEST_ID_RE.test(id));
  if (ids.length === 0) return 0;
  const updated = await pool.query(
    `UPDATE zcode_external_usage_audit
        SET status='error', terminal_code=$3, completed_at=NOW()
      WHERE user_id=$1 AND status='pending' AND request_id = ANY($2::text[])`,
    [args.userId, ids, args.terminalCode],
  );
  return updated.rowCount ?? 0;
}

export function zcodeCleanupTerminal(
  cause: string,
): ZcodeAuditTerminal {
  return cause === "client_close" ? "USER_CANCELLED" : "ENGINE_ERROR";
}
