/** Close a signed operator run only after durable PG terminal, settlement and
 * remote-cleanup proof. No Box call, paid retry, DB write, or invented result. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { Pool } from "pg";
import { parseBoxTerminalProof } from
  "../../packages/commercial/src/http/proxy/boxTerminalProof.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const LOCK = `${DIR}/account-20.json`;
const MUTEX = `${DIR}/account-20.mutex`;
function assertion(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function syncDir(): void {
  const fd = openSync(DIR, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readOwned(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    assertion(st.isFile() && st.uid === process.getuid()
      && (st.mode & 0o777) === 0o600 && st.nlink === 1
      && st.size > 0 && st.size <= maxBytes, "BOX_SIGNED_LOCK_INVALID");
    const raw = readFileSync(fd, "utf8");
    assertion(Buffer.byteLength(raw) === st.size, "BOX_SIGNED_LOCK_INVALID");
    fsyncSync(fd); return raw;
  } finally { closeSync(fd); }
}
function writeOnce(path: string, raw: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(raw); let n = 0;
    while (n < bytes.length) {
      const written = writeSync(fd, bytes, n, bytes.length - n);
      assertion(written > 0, "BOX_SIGNED_ARCHIVE_WRITE_FAILED"); n += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDir();
}

async function main(): Promise<void> {
  assertion(getRuntimeChannel() === "v5" && hostname() === "v3-dev-sg"
    && process.env.OCV5_289_SIGNED_CLOSE_ACK === "1"
    && process.env.OCV5_289_ACK_ACCOUNT_ID === "20"
    && process.env.OCV5_289_ACK_USER_ID === "3",
  "BOX_SIGNED_CLOSE_ACK_REQUIRED");
  writeOnce(MUTEX, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const st = lstatSync(LOCK);
    const raw = readOwned(LOCK, 4096);
    const lock = JSON.parse(raw) as Record<string, unknown>;
    assertion(lock.accountId === "20" && lock.uid === "3"
      && lock.state === "unresolved"
      && lock.firstId === process.env.OCV5_289_EXPECTED_FIRST_ID
      && lock.runNonce === process.env.OCV5_289_EXPECTED_RUN_NONCE
      && lock.leaseEpoch === process.env.OCV5_289_EXPECTED_LEASE_EPOCH
      && typeof lock.firstId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(lock.firstId)
      && typeof lock.secondId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(lock.secondId)
      && typeof lock.runNonce === "string" && /^[a-f0-9]{24}$/.test(lock.runNonce)
      && typeof lock.leaseEpoch === "string" && /^[a-f0-9]{32}$/.test(lock.leaseEpoch)
      && typeof lock.pid === "number" && Number.isSafeInteger(lock.pid)
      && lock.pid > 0, "BOX_SIGNED_CLOSE_IDENTITY_INVALID");
    try { process.kill(lock.pid, 0); throw new Error("BOX_SIGNED_PROBE_STILL_RUNNING"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const db = await pool.query<{ current_database: string }>("SELECT current_database()");
      assertion(db.rows[0]?.current_database === "openclaude_v5_selfhost",
        "BOX_SIGNED_CLOSE_DATABASE_INVALID");
      const found = await pool.query<{ state: string; user_id: string;
        ctx: Record<string, unknown> }>(
        `SELECT state,user_id::text,ctx FROM request_finalize_journal WHERE request_id=$1`,
        [lock.firstId]);
      const row = found.rows[0], ctx = row?.ctx;
      assertion(found.rows.length === 1 && row?.user_id === "3"
        && row.state === "committed" && ctx?.boxState === "terminal"
        && ctx?.boxInvocationMode === "detached_tool"
        && ctx?.boxAccountId === "20" && ctx?.boxRunNonce === lock.runNonce
        && ctx?.boxLeaseEpoch === lock.leaseEpoch
        && ctx?.boxRemoteCleanup === "done"
        && ctx?.boxTerminalProof && typeof ctx.boxTerminalProof === "object",
      "BOX_SIGNED_CLOSE_TERMINAL_UNPROVEN");
      const proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n",
        { runNonce: lock.runNonce, leaseEpoch: lock.leaseEpoch });
      assertion(proof.reason === "worker_complete", "BOX_SIGNED_CLOSE_PROOF_INVALID");
      const later = await pool.query(
        "SELECT 1 FROM request_finalize_journal WHERE request_id=$1", [lock.secondId]);
      assertion(later.rowCount === 0, "BOX_SIGNED_CLOSE_SECOND_CALL_PRESENT");
      const usage = await pool.query<{ id: string; cost_credits: string;
        ledger_id: string | null }>(
        `SELECT id::text,cost_credits::text,ledger_id::text FROM usage_records
          WHERE request_id=$1 AND user_id=3`, [lock.firstId]);
      assertion(usage.rows.length === 1 && usage.rows[0]?.ledger_id
        && BigInt(usage.rows[0].cost_credits) > 0n,
      "BOX_SIGNED_CLOSE_USAGE_UNPROVEN");
      const charges = await pool.query<{ id: string; delta: string }>(
        `SELECT id::text,delta::text FROM credit_ledger
          WHERE user_id=3 AND ref_type='usage_record' AND ref_id=$1`,
        [usage.rows[0]!.id]);
      assertion(charges.rows.length >= 1 && charges.rows.length <= 4
        && charges.rows.some((item) => item.id === usage.rows[0]!.ledger_id)
        && charges.rows.every((item) => BigInt(item.delta) < 0n)
        && charges.rows.reduce((sum, item) => sum - BigInt(item.delta), 0n)
          === BigInt(usage.rows[0]!.cost_credits),
      "BOX_SIGNED_CLOSE_LEDGER_UNPROVEN");
      const archivePath = `${DIR}/account-20.completed-${lock.runNonce}.json`;
      const archive = { kind: "signed_operator_terminal_no_tool",
        originalLock: lock, terminalProof: proof, usageId: usage.rows[0]!.id,
        costCredits: usage.rows[0]!.cost_credits,
        settledUsage: true, remoteCleanupDone: true,
        fullToolE2E: false, replayAllowed: false };
      writeOnce(archivePath, JSON.stringify(archive));
      const latest = lstatSync(LOCK);
      assertion(latest.dev === st.dev && latest.ino === st.ino
        && readFileSync(LOCK, "utf8") === raw, "BOX_SIGNED_LOCK_CHANGED");
      unlinkSync(LOCK); syncDir();
      process.stdout.write(JSON.stringify({ requestId: lock.firstId,
        proofReason: proof.reason, costCredits: archive.costCredits,
        archive: archivePath, lockReleased: true, replayed: false,
        fullToolE2E: false }) + "\n");
    } finally { await pool.end(); }
  } finally { unlinkSync(MUTEX); syncDir(); }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_SIGNED_CLOSE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
