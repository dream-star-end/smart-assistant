/** Close only one synthetic operator run with strict keeper stop proof.
 * No paid/tool launch, no production DB writes, no invented usage. Archive
 * evidence first; clean private Box files; release only the local probe lock. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync,
  openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeBoxRunCleanup } from
  "../../packages/commercial/src/http/proxy/boxRunCleanup.js";
import { readBoxTerminalProof } from
  "../../packages/commercial/src/http/proxy/boxTerminalProof.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const LOCK = `${DIR}/account-20.json`;
const MUTEX = `${DIR}/account-20.mutex`;

function syncDir(): void {
  const fd = openSync(DIR, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeOnce(path: string, raw: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(raw, "utf8");
    let n = 0;
    while (n < bytes.length) n += writeSync(fd, bytes, n);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDir();
}
function readOwned(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600
      || st.nlink !== 1 || st.size < 1 || st.size > maxBytes) {
      throw new Error("BOX_OPERATOR_OWNED_FILE_INVALID");
    }
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) !== st.size) throw new Error("BOX_OPERATOR_OWNED_FILE_INVALID");
    fsyncSync(fd); // Recover safely if a previous writer crashed pre-fsync.
    return raw;
  } finally { closeSync(fd); }
}
async function main(): Promise<void> {
  if (getRuntimeChannel() !== "v5"
    || process.env.OCV5_289_OPERATOR_CLOSE_ACK !== "1"
    || process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3") {
    throw new Error("BOX_OPERATOR_CLOSE_ACK_REQUIRED");
  }
  writeOnce(MUTEX, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const lockStat = lstatSync(LOCK);
    const rawLock = readOwned(LOCK, 4096);
    const lock = JSON.parse(rawLock) as Record<string, unknown>;
    if (lock.accountId !== "20" || lock.uid !== "3" || lock.state !== "unresolved"
      || lock.runNonce !== process.env.OCV5_289_EXPECTED_RUN_NONCE
      || lock.leaseEpoch !== process.env.OCV5_289_EXPECTED_LEASE_EPOCH
      || lock.firstId !== process.env.OCV5_289_EXPECTED_FIRST_ID
      || typeof lock.runNonce !== "string" || !/^[a-f0-9]{24}$/.test(lock.runNonce)
      || typeof lock.leaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(lock.leaseEpoch)) {
      throw new Error("BOX_OPERATOR_CLOSE_IDENTITY_INVALID");
    }
    const intentPath = `${DIR}/account-20.stop-intent-${lock.runNonce}.json`;
    const intent = JSON.parse(readOwned(intentPath, 4096)) as Record<string, unknown>;
    if (intent.kind !== "synthetic_operator_user_stop"
      || intent.runNonce !== lock.runNonce || intent.leaseEpoch !== lock.leaseEpoch
      || intent.accountId !== "20" || intent.uid !== "3"
      || intent.firstId !== lock.firstId
      || intent.lockSha256 !== createHash("sha256").update(rawLock).digest("hex")) {
      throw new Error("BOX_OPERATOR_STOP_INTENT_INVALID");
    }
    syncDir();
    const resolver = createProductionBoxAccountResolver();
    const abort = new AbortController();
    const pending = resolver.resolve({ uid: 3n, sessionId: null,
      requestId: String(lock.firstId), upstreamModel: "claude-opus-5-5",
      requiredAccountId: 20n, signal: abort.signal });
    let abandoned = false;
    void pending.then((late) => {
      if (abandoned) void Promise.resolve().then(() => late.dispose?.()).catch(() => {});
    }, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: Awaited<typeof pending>;
    try { target = await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort();
        reject(new Error("BOX_OPERATOR_RESOLVE_TIMEOUT")); }, 30_000);
    })]); }
    catch (error) { abandoned = true; throw error; }
    finally { if (timer) clearTimeout(timer); }
    try {
      if (target.accountId !== 20n) throw new Error("BOX_OPERATOR_ACCOUNT_MISMATCH");
      const proof = await readBoxTerminalProof({ target, expectedAccountId: 20n,
        runNonce: lock.runNonce, leaseEpoch: lock.leaseEpoch });
      if (proof.reason === "worker_complete") throw new Error("BOX_OPERATOR_STOP_PROOF_INVALID");
      const archivePath = `${DIR}/account-20.stopped-${lock.runNonce}.json`;
      const archive = { kind: "synthetic_operator_stopped", originalLock: lock,
        stopIntentSha256: createHash("sha256").update(JSON.stringify(intent)).digest("hex"),
        terminalProof: proof, settledUsage: false, replayAllowed: false };
      try { writeOnce(archivePath, JSON.stringify(archive)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const old = JSON.parse(readOwned(archivePath, 8192)) as Record<string, unknown>;
        if (old.kind !== archive.kind
          || JSON.stringify(old.originalLock) !== JSON.stringify(lock)
          || old.stopIntentSha256 !== archive.stopIntentSha256
          || JSON.stringify(old.terminalProof) !== JSON.stringify(proof)
          || old.settledUsage !== false || old.replayAllowed !== false) {
          throw new Error("BOX_OPERATOR_ARCHIVE_CONFLICT");
        }
        syncDir();
      }
      const cleaned = await target.exec.run(makeBoxRunCleanup(lock.runNonce), {
        timeoutMs: 20_000, maxResponseBytes: 4096 });
      if (cleaned.stdout.trim() !== "clean") throw new Error("BOX_OPERATOR_CLEANUP_UNPROVEN");
      const latest = lstatSync(LOCK);
      if (latest.dev !== lockStat.dev || latest.ino !== lockStat.ino
        || readFileSync(LOCK, "utf8") !== rawLock) {
        throw new Error("BOX_OPERATOR_LOCK_CHANGED");
      }
      unlinkSync(LOCK); syncDir();
      process.stdout.write(JSON.stringify({ runNonce: lock.runNonce,
        proofReason: proof.reason, cleanup: "proven", archive: archivePath,
        lockReleased: true, replayed: false }) + "\n");
    } finally {
      const closing = Promise.resolve().then(() => target.dispose?.());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closing, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      })]); } catch { /* local process exit closes socket */ }
      finally { if (timer) clearTimeout(timer); }
    }
  } finally { unlinkSync(MUTEX); syncDir(); }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_OPERATOR_CLOSE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
