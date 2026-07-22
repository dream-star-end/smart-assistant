import type { Pool, PoolClient } from "pg";
import { lockTurnBillingKeys, lockTurnPersistenceKeys, numericCommercialUserId } from "../billing/turnLock.js";
import { getPool } from "../db/index.js";
import { tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

export type TurnTapeRecoveryReason = "held_retry_conflict";

export interface AuthorizeTurnTapeRecoveryInput {
  sessionId: string;
  userId: string;
  sourceTapeId: string;
  recoveryTapeId: string;
  sourceTapeSha256: string;
  recoveryTapeSha256: string;
  reason: TurnTapeRecoveryReason;
}

export interface TurnTapeRecoveryAdminContext {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export class TurnTapeRecoveryError extends Error {
  constructor(public readonly code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "TurnTapeRecoveryError";
  }
}

type TapeRow = {
  tape_id: string;
  tape_sha256: string;
  status: string;
  turn_key: string;
  agent_id: string;
  turn_index: number;
  created_at: string;
  finalized_at: string | null;
  billing_anchor_id: string | null;
  dispatch_id: string | null;
  waive_reason: string | null;
};

type RecoveryLinkRow = {
  source_tape_id: string;
  recovery_tape_id: string;
  source_tape_sha256: string;
  recovery_tape_sha256: string;
  source_turn_key: string;
  recovery_turn_key: string;
  authorized_by: string;
  reason: string;
};

function validateInput(input: AuthorizeTurnTapeRecoveryInput): void {
  if (!/^c:[1-9][0-9]*$/.test(input.userId)) throw new TurnTapeRecoveryError("invalid", "invalid user id");
  if (!SHA256_RE.test(input.sourceTapeId) || !SHA256_RE.test(input.recoveryTapeId)) {
    throw new TurnTapeRecoveryError("invalid", "invalid tape id");
  }
  if (!SHA256_RE.test(input.sourceTapeSha256) || !SHA256_RE.test(input.recoveryTapeSha256)) {
    throw new TurnTapeRecoveryError("invalid", "invalid tape sha256");
  }
  if (input.sourceTapeId === input.recoveryTapeId) {
    throw new TurnTapeRecoveryError("invalid", "source and recovery tape must differ");
  }
  if (input.reason !== "held_retry_conflict") {
    throw new TurnTapeRecoveryError("invalid", "invalid recovery reason");
  }
}

function sameLink(
  row: RecoveryLinkRow,
  input: AuthorizeTurnTapeRecoveryInput,
  sourceTurnKey: string,
  recoveryTurnKey: string,
  adminId: string,
): boolean {
  return row.source_tape_id === input.sourceTapeId &&
    row.recovery_tape_id === input.recoveryTapeId &&
    row.source_tape_sha256 === input.sourceTapeSha256 &&
    row.recovery_tape_sha256 === input.recoveryTapeSha256 &&
    row.source_turn_key === sourceTurnKey &&
    row.recovery_turn_key === recoveryTurnKey &&
    row.authorized_by === adminId &&
    row.reason === input.reason;
}

async function lockRecoveryTapes(
  client: PoolClient,
  input: AuthorizeTurnTapeRecoveryInput,
): Promise<Map<string, TapeRow>> {
  const rows = (await client.query<TapeRow>(
    `SELECT tape_id,tape_sha256,status,turn_key,agent_id,turn_index,created_at::text,
            finalized_at::text,billing_anchor_id,dispatch_id,waive_reason
       FROM client_session_turn_tapes
      WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[])
      ORDER BY tape_id FOR UPDATE`,
    [input.sessionId, input.userId, [input.sourceTapeId, input.recoveryTapeId]],
  )).rows;
  return new Map(rows.map((row) => [row.tape_id, row]));
}

/**
 * Authorize one content-only recovery. This function is called only by the
 * superadmin HTTP handler; runtime/container ingest has no route to it.
 */
export async function authorizeTurnTapeRecovery(
  input: AuthorizeTurnTapeRecoveryInput,
  context: TurnTapeRecoveryAdminContext,
  pool: Pool = getPool(),
): Promise<"authorized" | "idempotent"> {
  validateInput(input);
  const adminId = String(context.adminId);
  if (!/^[1-9][0-9]*$/.test(adminId)) throw new TurnTapeRecoveryError("invalid", "invalid admin id");

  const hintRows = (await pool.query<Pick<TapeRow, "tape_id" | "turn_key">>(
    `SELECT tape_id,turn_key FROM client_session_turn_tapes
      WHERE session_id=$1 AND user_id=$2 AND tape_id=ANY($3::text[])`,
    [input.sessionId, input.userId, [input.sourceTapeId, input.recoveryTapeId]],
  )).rows;
  const hints = new Map(hintRows.map((row) => [row.tape_id, row.turn_key]));
  const sourceTurnKey = hints.get(input.sourceTapeId);
  const recoveryTurnKey = hints.get(input.recoveryTapeId);
  if (!sourceTurnKey || !recoveryTurnKey) throw new TurnTapeRecoveryError("not_found", "source or recovery tape not found");

  return tx(async (client) => {
    await lockTurnPersistenceKeys(client, input.userId, [sourceTurnKey, recoveryTurnKey]);
    await lockTurnBillingKeys(client, numericCommercialUserId(input.userId), [sourceTurnKey, recoveryTurnKey]);

    const session = (await client.query<{ messages: string; deleted_at: string | null }>(
      `SELECT messages,deleted_at::text FROM client_sessions
        WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [input.sessionId, input.userId],
    )).rows[0];
    if (!session || session.deleted_at !== null) throw new TurnTapeRecoveryError("not_found", "session not found");

    const tapes = await lockRecoveryTapes(client, input);
    const source = tapes.get(input.sourceTapeId);
    const recovery = tapes.get(input.recoveryTapeId);
    if (!source || !recovery) throw new TurnTapeRecoveryError("not_found", "source or recovery tape not found");
    if (source.turn_key !== sourceTurnKey || recovery.turn_key !== recoveryTurnKey) {
      throw new TurnTapeRecoveryError("conflict", "turn identity changed while authorizing recovery");
    }

    const existing = (await client.query<RecoveryLinkRow>(
      `SELECT source_tape_id,recovery_tape_id,source_tape_sha256,recovery_tape_sha256,
              source_turn_key,recovery_turn_key,authorized_by::text,reason
         FROM turn_tape_recovery_links
        WHERE session_id=$1 AND user_id=$2
          AND (source_tape_id=ANY($3::text[]) OR recovery_tape_id=ANY($3::text[]))
        FOR UPDATE`,
      [input.sessionId, input.userId, [input.sourceTapeId, input.recoveryTapeId]],
    )).rows[0];
    if (existing) {
      if (sameLink(existing, input, sourceTurnKey, recoveryTurnKey, adminId)) return "idempotent";
      throw new TurnTapeRecoveryError("conflict", "recovery tape is already linked differently");
    }

    if (source.finalized_at === null || recovery.finalized_at !== null) {
      throw new TurnTapeRecoveryError("conflict", "source must be finalized and recovery must be staged");
    }
    if (
      source.status !== "crashed" || recovery.status !== "completed" ||
      source.billing_anchor_id === null || source.dispatch_id === null ||
      source.waive_reason !== null
    ) {
      throw new TurnTapeRecoveryError(
        "conflict",
        "recovery requires a billed, dispatch-backed crashed source and a completed staged tape",
      );
    }
    const crashedDispatch = await client.query(
      `SELECT 1 FROM turn_dispatches
        WHERE dispatch_id=$1 AND user_id=$2 AND session_id=$3 AND agent_id=$4
          AND status='terminal' AND outcome='crashed'
        LIMIT 1 FOR UPDATE`,
      [source.dispatch_id, numericCommercialUserId(input.userId), input.sessionId, source.agent_id],
    );
    if ((crashedDispatch.rowCount ?? 0) !== 1) {
      throw new TurnTapeRecoveryError("conflict", "source dispatch is not an authoritative crashed turn");
    }
    if (source.tape_sha256 !== input.sourceTapeSha256 || recovery.tape_sha256 !== input.recoveryTapeSha256) {
      throw new TurnTapeRecoveryError("conflict", "recovery tape hash mismatch");
    }
    if (
      source.agent_id !== recovery.agent_id || source.turn_index !== recovery.turn_index ||
      source.created_at !== recovery.created_at || source.turn_key === recovery.turn_key
    ) {
      throw new TurnTapeRecoveryError("conflict", "source and recovery immutable identities do not match");
    }
    if (
      recovery.billing_anchor_id !== null || recovery.dispatch_id !== null ||
      recovery.waive_reason !== null
    ) {
      throw new TurnTapeRecoveryError("conflict", "recovery header is not content-only");
    }
    const recoveryCosts = await client.query(
      `SELECT 1 FROM turn_tape_cost_components
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 LIMIT 1 FOR UPDATE`,
      [input.sessionId, input.userId, input.recoveryTapeId],
    );
    if ((recoveryCosts.rowCount ?? 0) !== 0) {
      throw new TurnTapeRecoveryError("conflict", "recovery tape already has financial rows");
    }

    let messages: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(session.messages);
      if (!Array.isArray(parsed)) throw new Error("not array");
      messages = parsed as Array<Record<string, unknown>>;
    } catch {
      throw new TurnTapeRecoveryError("conflict", "session history is malformed");
    }
    const sourceAnchors = messages.filter((message) => message?._turnTapeId === input.sourceTapeId);
    if (sourceAnchors.length !== 1 || sourceAnchors[0]?._turnTapeComplete !== true || typeof sourceAnchors[0]?.id !== "string") {
      throw new TurnTapeRecoveryError("conflict", "source tape does not own exactly one complete hot anchor");
    }
    const archived = await client.query(
      `SELECT 1 FROM client_session_archived_ids WHERE session_id=$1 AND msg_id=$2 LIMIT 1`,
      [input.sessionId, sourceAnchors[0].id],
    );
    if ((archived.rowCount ?? 0) !== 0) {
      throw new TurnTapeRecoveryError("conflict", "source anchor is archived");
    }

    await client.query(
      `INSERT INTO turn_tape_recovery_links
         (session_id,user_id,source_tape_id,recovery_tape_id,
          source_tape_sha256,recovery_tape_sha256,source_turn_key,recovery_turn_key,
          authorized_by,reason,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.sessionId, input.userId, input.sourceTapeId, input.recoveryTapeId,
        input.sourceTapeSha256, input.recoveryTapeSha256, sourceTurnKey, recoveryTurnKey,
        adminId, input.reason, Date.now(),
      ],
    );
    await writeAdminAudit(client, {
      adminId,
      action: "turn_tape.recover",
      target: `session:${input.sessionId}`,
      before: {
        sourceTapeId: input.sourceTapeId,
        sourceTapeSha256: input.sourceTapeSha256,
        sourceTurnKey,
      },
      after: {
        state: "authorized",
        recoveryTapeId: input.recoveryTapeId,
        recoveryTapeSha256: input.recoveryTapeSha256,
        recoveryTurnKey,
        reason: input.reason,
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
    return "authorized";
  }, pool);
}
