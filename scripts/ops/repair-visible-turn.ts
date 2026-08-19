#!/usr/bin/env npx tsx
/**
 * Repair a visible-but-unfinalized turn (design 2026-08-19 §7 / rev3).
 * Default is dry-run. Does not apply migrations.
 *
 *   npx tsx scripts/ops/repair-visible-turn.ts --dispatch 04752b2e-895c-45b7-96d0-c3af43d4e2aa
 *   npx tsx scripts/ops/repair-visible-turn.ts --dispatch ... --apply
 *
 * Uses DATABASE_URL / COMMERCIAL_DATABASE_URL. Refuses production database
 * openclaude_v5_selfhost unless --allow-production is also set.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { commitVisibleLosslessTurnPhaseA } from "../../packages/commercial/src/db/pgSessionsBackend.ts";
import { enqueueMaterializationJob, requeueFailedSettlementJob } from "../../packages/commercial/src/db/turnTapeJobs.ts";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const dispatchId = arg("--dispatch");
  if (!dispatchId) {
    console.error("usage: repair-visible-turn.ts --dispatch <uuid> [--apply] [--allow-production]");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");
  const allowProd = process.argv.includes("--allow-production");
  const url = process.env.COMMERCIAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("COMMERCIAL_DATABASE_URL or DATABASE_URL required");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const db = await pool.query<{ current_database: string }>("SELECT current_database()");
    const dbName = db.rows[0]?.current_database ?? "";
    if (dbName === "openclaude_v5_selfhost" && !allowProd) {
      console.error(`refusing production database ${dbName} (pass --allow-production to override)`);
      process.exit(3);
    }
    const row = await pool.query<{
      dispatch_id: string;
      user_id: string;
      session_id: string;
      status: string;
      outcome: string | null;
      tape_id: string | null;
      tape_status: string | null;
      visible_at: string | null;
      finalized_at: string | null;
      turn_key: string | null;
      tape_sha256: string | null;
      total_bytes: string | null;
      part_count: number | null;
      created_at: string | null;
      agent_id: string | null;
      turn_index: number | null;
      waive_reason: string | null;
      attempt_no: number | null;
    }>(
      `SELECT d.dispatch_id::text, d.user_id::text, d.session_id, d.status, d.outcome,
              t.tape_id, t.status AS tape_status, t.visible_at::text, t.finalized_at::text,
              t.turn_key, t.tape_sha256, t.total_bytes::text, t.part_count, t.created_at::text,
              t.agent_id, t.turn_index, t.waive_reason, t.attempt_no
         FROM turn_dispatches d
         LEFT JOIN client_session_turn_tapes t ON t.dispatch_id = d.dispatch_id
        WHERE d.dispatch_id = $1::uuid`,
      [dispatchId],
    );
    const found = row.rows[0];
    if (!found) {
      console.error("dispatch not found");
      process.exit(1);
    }
    console.log(JSON.stringify({ dryRun: !apply, database: dbName, row: found }, null, 2));
    if (!apply) {
      console.log("dry-run: pass --apply to call commitVisibleLosslessTurnPhaseA + enqueue materialization/settlement jobs");
      return;
    }
    if (!found.tape_id || !found.turn_key || !found.tape_sha256 || !found.agent_id || found.turn_index == null) {
      console.error("dispatch has no complete tape header; cannot run Phase A");
      process.exit(1);
    }
    const userId = found.user_id.startsWith("c:") ? found.user_id : `c:${found.user_id}`;
    await commitVisibleLosslessTurnPhaseA(pool, userId, {
      protocolVersion: 2,
      action: "finalize",
      sessionId: found.session_id,
      agentId: found.agent_id,
      turnIndex: found.turn_index,
      status: (found.tape_status as "completed" | "interrupted" | "crashed") ?? "completed",
      turnKey: found.turn_key,
      tapeId: found.tape_id,
      tapeSha256: found.tape_sha256,
      totalBytes: Number(found.total_bytes ?? 0),
      partCount: found.part_count ?? 0,
      createdAt: Number(found.created_at ?? Date.now()),
      ...(found.waive_reason ? { waiveReason: found.waive_reason as "idle_timeout" } : {}),
      dispatchId,
      attemptNo: found.attempt_no ?? 1,
    });
    await enqueueMaterializationJob(pool, {
      sessionId: found.session_id,
      userId,
      tapeId: found.tape_id,
      dispatchId,
    });
    await requeueFailedSettlementJob(pool, {
      sessionId: found.session_id,
      userId,
      tapeId: found.tape_id,
    });
    console.log("applied Phase A + queued materialization/settlement via backend authority");
    console.log(createHash("sha256").update(dispatchId).digest("hex").slice(0, 12));
  } finally {
    await pool.end();
  }
}

void main();
