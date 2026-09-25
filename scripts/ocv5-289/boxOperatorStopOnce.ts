/** Stop only the exact synthetic Box operator run after a failed local probe.
 * No paid/tool retry, no journal settlement, no remote cleanup or lock release.
 * A durable stop intent precedes the remote signal; proof is reported only
 * after the original keeper publishes its strict terminal marker. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, writeSync } from "node:fs";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeBoxKeeperStop } from
  "../../packages/commercial/src/http/proxy/boxKeeperStop.js";
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
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDir();
}
async function main(): Promise<void> {
  if (getRuntimeChannel() !== "v5"
    || process.env.OCV5_289_OPERATOR_STOP_ACK !== "1"
    || process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3") {
    throw new Error("BOX_OPERATOR_STOP_ACK_REQUIRED");
  }
  writeOnce(MUTEX, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    const st = lstatSync(LOCK);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid()
      || (st.mode & 0o777) !== 0o600 || st.size < 1 || st.size > 4096) {
      throw new Error("BOX_OPERATOR_LOCK_INVALID");
    }
    const raw = readFileSync(LOCK, "utf8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (record.accountId !== "20" || record.uid !== "3"
      || record.state !== "unresolved"
      || record.runNonce !== process.env.OCV5_289_EXPECTED_RUN_NONCE
      || record.leaseEpoch !== process.env.OCV5_289_EXPECTED_LEASE_EPOCH
      || record.firstId !== process.env.OCV5_289_EXPECTED_FIRST_ID
      || typeof record.runNonce !== "string"
      || !/^[a-f0-9]{24}$/.test(record.runNonce)
      || typeof record.leaseEpoch !== "string"
      || !/^[a-f0-9]{32}$/.test(record.leaseEpoch)
      || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)
      || record.pid <= 0) throw new Error("BOX_OPERATOR_STOP_IDENTITY_INVALID");
    try { process.kill(record.pid, 0); throw new Error("BOX_OPERATOR_PROBE_STILL_RUNNING"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const intentPath = `${DIR}/account-20.stop-intent-${record.runNonce}.json`;
    const intent = { kind: "synthetic_operator_user_stop", accountId: "20", uid: "3",
      firstId: record.firstId, runNonce: record.runNonce,
      leaseEpoch: record.leaseEpoch,
      lockSha256: createHash("sha256").update(raw).digest("hex") };
    try { writeOnce(intentPath, JSON.stringify(intent)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const fd = openSync(intentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const previous = fstatSync(fd);
        if (!previous.isFile() || previous.uid !== process.getuid()
          || (previous.mode & 0o777) !== 0o600 || previous.nlink !== 1
          || previous.size < 1 || previous.size > 4096
          || readFileSync(fd, "utf8") !== JSON.stringify(intent)) {
          throw new Error("BOX_OPERATOR_STOP_INTENT_CONFLICT");
        }
        // A previous process may have crashed after writing but before fsync.
        fsyncSync(fd);
      } finally { closeSync(fd); }
      syncDir();
    }
    const resolver = createProductionBoxAccountResolver();
    const abort = new AbortController();
    const pendingTarget = resolver.resolve({ uid: 3n, sessionId: null,
      requestId: String(record.firstId), upstreamModel: "claude-opus-5-5",
      requiredAccountId: 20n, signal: abort.signal });
    let abandoned = false;
    void pendingTarget.then((late) => {
      if (abandoned) void Promise.resolve().then(() => late.dispose?.()).catch(() => {});
    }, () => {});
    let resolveTimer: ReturnType<typeof setTimeout> | undefined;
    let target: Awaited<typeof pendingTarget>;
    try { target = await Promise.race([pendingTarget, new Promise<never>((_, reject) => {
      resolveTimer = setTimeout(() => { abort.abort();
        reject(new Error("BOX_OPERATOR_RESOLVE_TIMEOUT")); }, 30_000);
    })]); }
    catch (error) { abandoned = true; throw error; }
    finally { if (resolveTimer) clearTimeout(resolveTimer); }
    try {
      if (target.accountId !== 20n) throw new Error("BOX_OPERATOR_ACCOUNT_MISMATCH");
      let stopAck = "unknown";
      try {
        const result = await target.exec.run(makeBoxKeeperStop(record.runNonce,
          record.leaseEpoch), { timeoutMs: 10_000, maxResponseBytes: 1024 });
        if (["stop-requested", "terminal-present"].includes(result.stdout.trim())) {
          stopAck = result.stdout.trim();
        }
      } catch { /* An ambiguous stop response is not a paid/tool replay. */ }
      let proofReason: string | null = null;
      const deadline = Date.now() + 20_000;
      do {
        try {
          const proof = await readBoxTerminalProof({ target,
            expectedAccountId: 20n, runNonce: record.runNonce,
            leaseEpoch: record.leaseEpoch });
          proofReason = proof.reason;
          break;
        } catch { /* No marker yet: preserve lock and private files. */ }
        if (Date.now() >= deadline) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      } while (true);
      process.stdout.write(JSON.stringify({ runNonce: record.runNonce,
        stopAck, proofReason, lockRetained: true, replayed: false }) + "\n");
    } finally {
      const closing = Promise.resolve().then(() => target.dispose?.());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closing, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      })]); }
      catch { /* Process exit releases any lingering local agent socket. */ }
      finally { if (timer) clearTimeout(timer); }
    }
  } finally {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(MUTEX); syncDir();
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_OPERATOR_STOP_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
