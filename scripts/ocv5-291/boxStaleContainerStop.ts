/** One approved selfhost operator stop for a Box handoff owned by a vanished
 * user container. Never impersonates that container or clears capacity by SQL.
 * The existing coordinator writes cancel intent before one pinned keeper stop,
 * then accepts only the keeper's terminal proof and journal CAS. */
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { BoxDurableJournal } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxUserStopCoordinator } from
  "../../packages/commercial/src/http/proxy/boxUserStopCoordinator.js";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const UID = 3n, ACCOUNT = 20n;
const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff",
  "resuming", "linked"];
function requireValue(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function exactEnv(name: string, pattern: RegExp): string {
  const value = process.env[name];
  requireValue(typeof value === "string" && pattern.test(value),
    "BOX_STALE_STOP_EXPECTED_IDENTITY_MISSING");
  return value;
}
function validExistingIntent(value: unknown, requestId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return Object.keys(intent).sort().join(",") === "atMs,reason,requestId,v"
    && intent.v === 1 && intent.reason === "user_cancel"
    && intent.requestId === requestId
    && Number.isSafeInteger(intent.atMs) && Number(intent.atMs) > 0;
}

async function main(): Promise<void> {
  const execute = process.argv.length === 3 && process.argv[2] === "--execute";
  requireValue(execute || process.argv.length === 2, "BOX_STALE_STOP_MODE_INVALID");
  requireValue(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OC_USER_ID === "3"
    && /^agent:main:webchat:dm:[A-Za-z0-9]+$/.test(process.env.OC_SESSION_KEY ?? "")
    && process.env.OCV5_291_TICKET === "OCV5-291",
  "BOX_STALE_STOP_SELFHOST_BOUNDARY_INVALID");
  if (execute) requireValue(process.env.OCV5_291_STALE_STOP_ACK === "1",
    "BOX_STALE_STOP_ACK_REQUIRED");
  const requestId = exactEnv("OCV5_291_EXPECT_REQUEST_ID", /^[a-f0-9]{32}$/);
  const runNonce = exactEnv("OCV5_291_EXPECT_RUN_NONCE", /^[a-f0-9]{24}$/);
  const leaseEpoch = exactEnv("OCV5_291_EXPECT_LEASE_EPOCH", /^[a-f0-9]{32}$/);
  const sessionId = exactEnv("OCV5_291_EXPECT_BOX_SESSION_ID",
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const turnKey = exactEnv("OCV5_291_EXPECT_TURN_KEY", /^[a-f0-9]{64}$/);
  const oldContainer = exactEnv("OCV5_291_EXPECT_OLD_CONTAINER", /^[1-9][0-9]{0,9}$/);
  const currentContainer = exactEnv("OCV5_291_EXPECT_CURRENT_CONTAINER", /^[1-9][0-9]{0,9}$/);
  requireValue(oldContainer !== currentContainer && !!process.env.DATABASE_URL,
    "BOX_STALE_STOP_IDENTITY_INVALID");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const database = await pool.query<{ current_database: string }>(
      "SELECT current_database()");
    requireValue(database.rows[0]?.current_database === "openclaude_v5_selfhost",
      "BOX_STALE_STOP_DATABASE_BOUNDARY_INVALID");
    const owner = await pool.query<{ id: string; state: string }>(
      `SELECT id::text,state FROM agent_containers
       WHERE user_id=$1 AND runtime_channel='v5'
         AND id IN ($2::bigint,$3::bigint)`,
      [UID.toString(), oldContainer, currentContainer]);
    requireValue(owner.rows.length === 2
      && owner.rows.some((row) => row.id === oldContainer && row.state === "vanished")
      && owner.rows.some((row) => row.id === currentContainer && row.state === "active"),
    "BOX_STALE_STOP_CONTAINER_BOUNDARY_INVALID");
    const activeOwner = await pool.query<{ id: string }>(
      `SELECT id::text FROM agent_containers WHERE user_id=$1
       AND state='active' AND runtime_channel='v5'`, [UID.toString()]);
    requireValue(activeOwner.rowCount === 1
      && activeOwner.rows[0]?.id === currentContainer,
    "BOX_STALE_STOP_CURRENT_OWNER_CHANGED");
    const found = await pool.query<{ request_id: string; container_id: string;
      state: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,container_id::text,state,ctx
       FROM request_finalize_journal WHERE request_id=$1 AND user_id=$2`,
      [requestId, UID.toString()]);
    const row = found.rows[0], ctx = row?.ctx;
    requireValue(found.rowCount === 1 && row && ctx
      && row.container_id === oldContainer && row.state === "committed"
      && ctx.boxInvocationRecovery === "v1"
      && ctx.model === "box-api-claude-opus-5-5"
      && ctx.boxInvocationMode === "detached_tool"
      && ctx.boxAccountId === ACCOUNT.toString()
      && ctx.boxRunNonce === runNonce && ctx.boxLeaseEpoch === leaseEpoch
      && ctx.boxSessionId === sessionId && ctx.boxTurnKey === turnKey
      && ctx.boxState === "handoff"
      && ctx.boxToolHandoff !== undefined
      && typeof ctx.boxOwnerRequestId === "string"
      && ctx.boxResumeRequestId === undefined
      && ctx.boxTerminalProof === undefined
      && (ctx.boxCancelIntent === undefined
        || validExistingIntent(ctx.boxCancelIntent, requestId)),
    "BOX_STALE_STOP_JOURNAL_BOUNDARY_INVALID");
    const held = await pool.query<{ request_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
       WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
         AND ctx->>'boxState'=ANY($3::text[])
         AND NOT (ctx ? 'boxTerminalProof')`,
      [UID.toString(), ACCOUNT.toString(), ACTIVE]);
    requireValue(held.rowCount === 2 && held.rows.some((item) => item.request_id === requestId)
      && held.rows.every((item) => item.ctx.boxRunNonce === runNonce
        && item.ctx.boxLeaseEpoch === leaseEpoch)
      && held.rows.some((item) => item.request_id === ctx.boxOwnerRequestId
        && item.ctx.boxResumeRequestId === requestId
        && item.ctx.boxLaunchPermit === true)
      && held.rows.every((item) => isDeepStrictEqual(item.ctx.boxCancelIntent,
        ctx.boxCancelIntent)),
    "BOX_STALE_STOP_OTHER_CAPACITY_HELD");
    if (!execute) {
      process.stdout.write(JSON.stringify({ mode: "dry_run", requestId,
        oldContainer, currentContainer, activeRows: held.rowCount,
        paidLaunches: 0, remoteStops: 0 }) + "\n");
      return;
    }
    const journal = new BoxDurableJournal(pool);
    const coordinator = new BoxUserStopCoordinator({ journal,
      resolver: createProductionBoxAccountResolver() });
    const outcome = await coordinator.requestStop({ requestId, uid: UID,
      accountId: ACCOUNT, runNonce, leaseEpoch });
    const after = await pool.query<{ state: string; ctx: Record<string, unknown> }>(
      `SELECT state,ctx FROM request_finalize_journal
       WHERE request_id=$1 AND user_id=$2`, [requestId, UID.toString()]);
    const terminal = after.rows[0]?.ctx.boxTerminalProof as
      { reason?: unknown } | undefined;
    if (outcome === "stopped_proven") requireValue(
      after.rows[0]?.ctx.boxState === "failed_stopped"
        && terminal && terminal.reason !== "worker_complete",
      "BOX_STALE_STOP_TERMINAL_NOT_COMMITTED");
    process.stdout.write(JSON.stringify({ mode: "execute", requestId, outcome,
      journalState: after.rows[0]?.ctx.boxState ?? null,
      terminalReason: terminal?.reason ?? null,
      paidLaunches: 0 }) + "\n");
    if (outcome !== "stopped_proven") process.exitCode = 2;
  } finally { await pool.end(); }
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error && /^BOX_[A-Z0-9_]+$/.test(error.message)
    ? error.message : "BOX_STALE_STOP_FAILED") + "\n");
  process.exitCode = 1;
});
