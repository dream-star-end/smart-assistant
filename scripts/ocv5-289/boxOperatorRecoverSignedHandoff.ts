/** Recover one paid signed CCB handoff after its local CCB process exited.
 * Durable cancel intent -> pinned original keeper stop -> strict proof -> PG
 * failed_stopped CAS -> exact remote cleanup -> archive -> local lock release.
 * Never launches a model or replays an OpenClaude tool. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { Pool } from "pg";
import { BoxDurableJournal } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxUserStopCoordinator } from
  "../../packages/commercial/src/http/proxy/boxUserStopCoordinator.js";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeBoxRunCleanup } from
  "../../packages/commercial/src/http/proxy/boxRunCleanup.js";
import { parseBoxTerminalProof } from
  "../../packages/commercial/src/http/proxy/boxTerminalProof.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const UID = 3n, ACCOUNT = 20n;
const DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const LOCK = `${DIR}/account-20.json`;
const MUTEX = `${DIR}/account-20.mutex`;
const WORK = "/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-289-box-api";
function assertion(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeOnce(path: string, raw: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(raw); let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      assertion(n > 0, "BOX_RECOVERY_ARCHIVE_WRITE_FAILED"); offset += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDir(DIR);
}
async function main(): Promise<void> {
  assertion(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OCV5_289_SIGNED_HANDOFF_RECOVERY_ACK === "1"
    && process.env.OCV5_289_ACK_ACCOUNT_ID === "20"
    && process.env.OCV5_289_ACK_USER_ID === "3",
  "BOX_SIGNED_HANDOFF_RECOVERY_ACK_REQUIRED");
  const dir = lstatSync(DIR);
  assertion(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid()
    && (dir.mode & 0o777) === 0o700, "BOX_RECOVERY_DIR_INVALID");
  writeOnce(MUTEX, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const lockStat = lstatSync(LOCK);
    assertion(lockStat.isFile() && !lockStat.isSymbolicLink()
      && lockStat.uid === process.getuid() && (lockStat.mode & 0o777) === 0o600
      && lockStat.nlink === 1 && lockStat.size > 0 && lockStat.size <= 4096,
    "BOX_RECOVERY_LOCK_INVALID");
    const raw = readFileSync(LOCK, "utf8");
    assertion(Buffer.byteLength(raw) === lockStat.size, "BOX_RECOVERY_LOCK_INVALID");
    const lock = JSON.parse(raw) as Record<string, unknown>;
    assertion(lock.accountId === "20" && lock.uid === "3" && lock.state === "unresolved"
      && lock.firstId === process.env.OCV5_289_EXPECTED_FIRST_ID
      && lock.runNonce === process.env.OCV5_289_EXPECTED_RUN_NONCE
      && lock.leaseEpoch === process.env.OCV5_289_EXPECTED_LEASE_EPOCH
      && typeof lock.firstId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(lock.firstId)
      && typeof lock.secondId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(lock.secondId)
      && typeof lock.runNonce === "string" && /^[a-f0-9]{24}$/.test(lock.runNonce)
      && typeof lock.leaseEpoch === "string" && /^[a-f0-9]{32}$/.test(lock.leaseEpoch)
      && typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0,
    "BOX_RECOVERY_IDENTITY_INVALID");
    const request = /^box-signed-a-([a-f0-9]{24})$/.exec(lock.firstId);
    assertion(request && lock.secondId === `box-signed-b-${request[1]}`,
      "BOX_RECOVERY_REQUEST_PAIR_INVALID");
    try { process.kill(lock.pid, 0); throw new Error("BOX_RECOVERY_PROBE_STILL_RUNNING"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    try {
      const db = await pool.query<{ current_database: string }>("SELECT current_database()");
      assertion(db.rows[0]?.current_database === "openclaude_v5_selfhost",
        "BOX_RECOVERY_DATABASE_INVALID");
      const before = await pool.query<{ state: string; user_id: string;
        ctx: Record<string, unknown> }>(
        "SELECT state,user_id::text,ctx FROM request_finalize_journal WHERE request_id=$1",
        [lock.firstId]);
      const row = before.rows[0], ctx = row?.ctx;
      assertion(before.rows.length === 1 && row?.user_id === "3"
        && row.state === "committed"
        && (ctx?.boxState === "handoff" || ctx?.boxState === "failed_stopped")
        && ctx?.boxInvocationMode === "detached_tool"
        && ctx?.boxAccountId === "20" && ctx?.boxRunNonce === lock.runNonce
        && ctx?.boxLeaseEpoch === lock.leaseEpoch && !!ctx?.boxToolHandoff
        && !ctx?.boxResumeRequestId
        && (ctx.boxState === "handoff" ? !ctx.boxTerminalProof
          : !!ctx.boxTerminalProof && ctx.boxStopOutcome === "failed"),
      "BOX_RECOVERY_HANDOFF_INVALID");
      const second = await pool.query<{ state: string; user_id: string;
        ctx: Record<string, unknown>; final_credits: string; failure_code: string }>(
        `SELECT state,user_id::text,ctx,final_credits::text,failure_code
           FROM request_finalize_journal WHERE request_id=$1`, [lock.secondId]);
      // The second HTTP request may have failed in the shared handler before
      // Box admission. Accept only that exact zero-cost, unowned terminal row;
      // any Box-owned/ambiguous second call must be investigated separately.
      assertion(second.rows.length === 0 || (second.rows.length === 1
        && second.rows[0]?.state === "aborted"
        && second.rows[0]?.user_id === "3"
        && second.rows[0]?.failure_code === "STREAM_FAILED"
        && second.rows[0]?.final_credits === "0"
        && second.rows[0]?.ctx?.boxInvocationRecovery === "v1"
        && !second.rows[0]?.ctx?.boxState
        && !second.rows[0]?.ctx?.boxOwnerRequestId
        && !second.rows[0]?.ctx?.boxRunNonce
        && !second.rows[0]?.ctx?.boxToolHandoff
        && !second.rows[0]?.ctx?.boxResumeRequestId),
      "BOX_RECOVERY_SECOND_CALL_PRESENT");
      const secondUsage = await pool.query(
        "SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=3", [lock.secondId]);
      assertion(secondUsage.rowCount === 0, "BOX_RECOVERY_SECOND_USAGE_PRESENT");
      const initialUsage = await pool.query<{ id: string; cost: string }>(
        `SELECT id::text,cost_credits::text AS cost FROM usage_records
          WHERE request_id=$1 AND user_id=3`, [lock.firstId]);
      assertion(initialUsage.rows.length === 1 && BigInt(initialUsage.rows[0]!.cost) > 0n,
        "BOX_RECOVERY_USAGE_INVALID");
      const initialLedger = await pool.query<{ id: string; delta: string }>(
        `SELECT id::text,delta::text FROM credit_ledger
          WHERE user_id=3 AND ref_type='usage_record' AND ref_id=$1 ORDER BY id`,
        [initialUsage.rows[0]!.id]);
      assertion(initialLedger.rows.length >= 1 && initialLedger.rows.length <= 4
        && initialLedger.rows.every((item) => BigInt(item.delta) < 0n)
        && initialLedger.rows.reduce((n, item) => n - BigInt(item.delta), 0n)
          === BigInt(initialUsage.rows[0]!.cost),
      "BOX_RECOVERY_LEDGER_INVALID");
      const journal = new BoxDurableJournal(pool);
      const resolver = createProductionBoxAccountResolver();
      const identity = { requestId: lock.firstId, uid: UID, accountId: ACCOUNT,
        runNonce: lock.runNonce, leaseEpoch: lock.leaseEpoch };
      if (ctx.boxState === "handoff") {
        const stop = new BoxUserStopCoordinator({ journal, resolver });
        const outcome = await stop.requestStop(identity);
        assertion(outcome === "stopped_proven", "BOX_RECOVERY_STOP_PENDING");
      }
      const stopped = await pool.query<{ state: string; ctx: Record<string, unknown> }>(
        "SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1", [lock.firstId]);
      const stoppedCtx = stopped.rows[0]?.ctx;
      assertion(stopped.rows.length === 1 && stopped.rows[0]?.state === "committed"
        && stoppedCtx?.boxState === "failed_stopped"
        && stoppedCtx.boxStopOutcome === "failed" && stoppedCtx.boxTerminalProof,
      "BOX_RECOVERY_STOP_PROOF_MISSING");
      const proof = parseBoxTerminalProof(JSON.stringify(stoppedCtx.boxTerminalProof) + "\n",
        { runNonce: lock.runNonce, leaseEpoch: lock.leaseEpoch });
      assertion(proof.reason === "keeper_stopped" || proof.reason === "worker_failed",
        "BOX_RECOVERY_STOP_PROOF_INVALID");
      const candidate = { ...identity, proof };
      const claimed = await journal.claimRemoteCleanup(candidate);
      assertion(claimed || await journal.remoteCleanupStatus(candidate) === "done",
        "BOX_RECOVERY_CLEANUP_CLAIM_PENDING");
      if (claimed) {
        const abort = new AbortController();
        const pending = resolver.resolve({ uid: UID, sessionId: null,
          requestId: lock.firstId, upstreamModel: "claude-opus-5-5",
          requiredAccountId: ACCOUNT, signal: abort.signal });
        let timedOut = false;
        void pending.then((late) => {
          if (timedOut) void Promise.resolve().then(() => late.dispose?.()).catch(() => {});
        }, () => {});
        let resolveTimer: ReturnType<typeof setTimeout> | undefined;
        let target: Awaited<typeof pending>;
        try {
          target = await Promise.race([pending, new Promise<never>((_, reject) => {
            resolveTimer = setTimeout(() => { timedOut = true; abort.abort();
              reject(new Error("BOX_RECOVERY_RESOLVE_TIMEOUT")); }, 30_000);
          })]);
        } finally { if (resolveTimer) clearTimeout(resolveTimer); }
        try {
          assertion(target.accountId === ACCOUNT, "BOX_RECOVERY_ACCOUNT_MISMATCH");
          const cleanup = await target.exec.run(makeBoxRunCleanup(lock.runNonce), {
            timeoutMs: 20_000, maxResponseBytes: 4096 });
          assertion(cleanup.exitCode === 0 && cleanup.stdout.trim() === "clean",
            "BOX_RECOVERY_CLEANUP_UNPROVEN");
          await journal.markRemoteCleaned(candidate);
        } finally {
          const closing = Promise.resolve().then(() => target.dispose?.()).catch(() => {});
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([closing, new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          })]); } finally { if (timer) clearTimeout(timer); }
        }
      }
      assertion(await journal.remoteCleanupStatus(candidate) === "done",
        "BOX_RECOVERY_CLEANUP_NOT_DURABLE");
      const afterUsage = await pool.query<{ id: string; cost: string }>(
        `SELECT id::text,cost_credits::text AS cost FROM usage_records
          WHERE request_id=$1 AND user_id=3`, [lock.firstId]);
      assertion(afterUsage.rows.length === 1
        && afterUsage.rows[0]?.id === initialUsage.rows[0]?.id
        && afterUsage.rows[0]?.cost === initialUsage.rows[0]?.cost,
      "BOX_RECOVERY_USAGE_CHANGED");
      const afterLedger = await pool.query<{ id: string; delta: string }>(
        `SELECT id::text,delta::text FROM credit_ledger
          WHERE user_id=3 AND ref_type='usage_record' AND ref_id=$1 ORDER BY id`,
        [afterUsage.rows[0]!.id]);
      assertion(JSON.stringify(afterLedger.rows) === JSON.stringify(initialLedger.rows),
        "BOX_RECOVERY_LEDGER_CHANGED");
      const afterSecondUsage = await pool.query(
        "SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=3", [lock.secondId]);
      assertion(afterSecondUsage.rowCount === 0, "BOX_RECOVERY_SECOND_USAGE_CHANGED");
      const archivePath = `${DIR}/account-20.stopped-${lock.runNonce}.json`;
      const archive = { kind: "signed_operator_stopped_handoff", originalLock: lock,
        terminalProof: proof, usageId: afterUsage.rows[0]!.id,
        costCredits: afterUsage.rows[0]!.cost, remoteCleanupDone: true,
        toolReplayAllowed: false, paidReplayAllowed: false };
      const archiveRaw = JSON.stringify(archive);
      try { writeOnce(archivePath, archiveRaw); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const fd = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW
          | constants.O_NONBLOCK);
        try {
          const st = fstatSync(fd);
          assertion(st.isFile() && st.uid === process.getuid()
            && (st.mode & 0o777) === 0o600 && st.nlink === 1
            && st.size === Buffer.byteLength(archiveRaw)
            && readFileSync(fd, "utf8") === archiveRaw,
          "BOX_RECOVERY_ARCHIVE_CONFLICT");
          fsyncSync(fd);
        } finally { closeSync(fd); }
        syncDir(DIR);
      }
      for (const path of [`${WORK}/.ocv5-289-read-${request[1]}.txt.used`,
        `${WORK}/.ocv5-289-read-${request[1]}.txt`]) {
        try {
          const st = lstatSync(path);
          assertion(st.isFile() && !st.isSymbolicLink() && st.uid === 1000
            && (st.mode & 0o777) === 0o600 && st.nlink === 1,
          "BOX_RECOVERY_FIXTURE_INVALID");
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      syncDir(WORK);
      const latest = lstatSync(LOCK);
      assertion(latest.dev === lockStat.dev && latest.ino === lockStat.ino
        && readFileSync(LOCK, "utf8") === raw, "BOX_RECOVERY_LOCK_CHANGED");
      unlinkSync(LOCK); syncDir(DIR);
      process.stdout.write(JSON.stringify({ requestId: lock.firstId,
        proofReason: proof.reason, usageId: archive.usageId,
        costCredits: archive.costCredits, remoteCleanupDone: true,
        lockReleased: true, replayed: false, archive: archivePath }) + "\n");
    } finally { await pool.end(); }
  } finally { unlinkSync(MUTEX); syncDir(DIR); }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_RECOVERY_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
