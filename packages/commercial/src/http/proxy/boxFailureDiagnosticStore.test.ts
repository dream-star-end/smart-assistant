import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { BoxFailureDiagnosticStore, diagnosticSlot, DIAGNOSTIC_MUTATION_SCRIPT,
  DIAGNOSTIC_SLOTS } from "./boxFailureDiagnosticStore.js";
import { diagnosticId, DIAGNOSTIC_TTL_MS, parseDiagnosticSnapshot,
  type DiagnosticSnapshot } from "./boxFailureDiagnosticSchema.js";

const fixture = JSON.parse(await readFile(new URL("../../../../../scripts/ocv5-289/failure-diagnostic-v1.fixture.json", import.meta.url), "utf8"));
const now = Date.now();
function snapshot(requestId = "offline-store", observedAtMs = now, uid = 3n,
  status: "ok" | "missing" = "ok"): DiagnosticSnapshot {
  const identity = { uid, accountId: 999992n, requestId,
    runNonce: fixture.runNonce, leaseEpoch: fixture.leaseEpoch };
  const value = parseDiagnosticSnapshot({ version: 1, id: diagnosticId(identity), observedAtMs,
    expiresAtMs: observedAtMs + DIAGNOSTIC_TTL_MS,
    identity: { ...identity, uid: String(uid), accountId: String(identity.accountId) },
    terminal: { runNonce: identity.runNonce, leaseEpoch: identity.leaseEpoch,
      keeperPid: 101, cliPid: 102, revision: 2, reason: "worker_failed", workerExitCode: 1 },
    status, remote: status === "ok" ? fixture : null });
  assert.ok(value);
  return value;
}
interface Run {
  child: ChildProcess;
  closed: Promise<number | null>;
  ready: Promise<void>;
  release(): void;
}
async function home(fn: (dir: string, launch: (op: "write" | "sweep", input: unknown,
  slot?: string, pause?: boolean) => Run) => Promise<void>): Promise<void> {
  const dir = await mkdtemp("/tmp/box-diagnostic-store-");
  const processes: Run[] = [];
  const launch = (op: "write" | "sweep", input: unknown, slot = "s000", pause = false): Run => {
    // Fault injection wraps the real production script, stopping after its
    // first fsync while it holds flock and owns a real complete temporary.
    const wrapper = "import os,sys\nreal=os.fsync\nfirst=True\n" +
      "def pause(fd):\n global first\n real(fd)\n if first:\n  first=False\n  print('paused',flush=True)\n  os.read(3,1)\n" +
      "os.fsync=pause\nscript=sys.argv.pop(1)\nexec(script)\n";
    const child = spawn("/usr/bin/python3", ["-I", "-c",
      ...(pause ? [wrapper, DIAGNOSTIC_MUTATION_SCRIPT] : [DIAGNOSTIC_MUTATION_SCRIPT]),
      dir, op, slot, String(now)], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = pause ? new Promise<void>((resolve, reject) => {
      let out = "";
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fixture did not reach fsync")); }, 4000);
      child.stdout!.on("data", (b: Buffer) => {
        out += b.toString();
        if (out.includes("paused\n")) { clearTimeout(timer); resolve(); }
      });
    }) : Promise.resolve();
    child.stderr!.resume();
    if (!pause) child.stdout!.resume();
    child.once("close", () => { clearTimeout(timer); (child.stdio[3] as Writable).destroy(); });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(input));
    const run = { child, closed, ready, release: () => (child.stdio[3] as Writable).end("G") };
    processes.push(run);
    return run;
  };
  try { await fn(dir, launch); }
  finally {
    for (const run of processes) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
      await run.closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("two real writers serialize and missing evidence never downgrades captured evidence", async () => home(async (dir, launch) => {
  const good = snapshot(), missing = snapshot("offline-store", now, 3n, "missing");
  const first = launch("write", good, diagnosticSlot(good.id), true);
  await first.ready;
  const second = launch("write", missing, diagnosticSlot(good.id));
  first.release();
  assert.deepEqual(await Promise.all([first.closed, second.closed]), [0, 0]);
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  assert.deepEqual(await store.read(good.id), good);
  assert.deepEqual((await readdir(dir)).sort(), [".mutation.lock", diagnosticSlot(good.id) + ".json"].sort());
}));

test("GC cannot steal an aged active temp or delete a fresh replacement from stale inspection", async () => home(async (dir, launch) => {
  const old = snapshot("race", now - DIAGNOSTIC_TTL_MS - 1);
  const fresh = snapshot("race");
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  await store.write(old);
  const name = diagnosticSlot(old.id) + ".json";
  const oldStat = await stat(join(dir, name));
  const oldBytes = await readFile(join(dir, name));
  const candidate = { name, dev: String(oldStat.dev), ino: String(oldStat.ino),
    sha256: createHash("sha256").update(oldBytes).digest("hex") };
  const held = launch("write", fresh, diagnosticSlot(fresh.id), true);
  await held.ready;
  const stale = new Date(now - 120_000);
  await utimes(join(dir, "write.tmp"), stale, stale);
  const tempBefore = await readFile(join(dir, "write.tmp"), "utf8");
  // A real second process tries reclamation while the writer is paused.
  const sweep = launch("sweep", [candidate]);
  assert.equal(await sweep.closed, 75, "bounded lock contention fails without stealing the temp");
  assert.equal(await readFile(join(dir, "write.tmp"), "utf8"), tempBefore);
  assert.deepEqual(await readFile(join(dir, name)), oldBytes);
  held.child.kill("SIGKILL");
  assert.equal(await held.closed, null);
  assert.equal(held.child.signalCode, "SIGKILL");
  await store.write(fresh); // Kernel released flock; safely reclaims crashed temporary.
  const lateSweep = launch("sweep", [candidate]);
  assert.equal(await lateSweep.closed, 0);
  assert.deepEqual(await store.read(fresh.id), fresh, "stale candidate cannot remove a new inode/content");
  assert.equal((await readdir(dir)).includes("write.tmp"), false);
}));

test("idle GC reclaims a killed writer temporary without a new failure and keeps lock inode", async () => home(async (dir, launch) => {
  const value = snapshot("crash");
  const held = launch("write", value, diagnosticSlot(value.id), true);
  await held.ready;
  const lockInode = (await stat(join(dir, ".mutation.lock"))).ino;
  held.child.kill("SIGKILL"); await held.closed;
  assert.ok((await stat(join(dir, "write.tmp"))).size > 0);
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  assert.equal(await store.sweep(), 0); // removed-record count excludes the temporary.
  assert.deepEqual(await readdir(dir), [".mutation.lock"]);
  assert.equal((await stat(join(dir, ".mutation.lock"))).ino, lockInode);
  await store.write(value);
  assert.deepEqual(await store.read(value.id), value);
}));

test("AbortSignal kills and reaps a blocked mutation before returning", async () => home(async (dir, launch) => {
  const heldValue = snapshot("held");
  const held = launch("write", heldValue, diagnosticSlot(heldValue.id), true);
  await held.ready;
  const children = () => readFile("/proc/self/task/" + process.pid + "/children", "utf8");
  const before = (await children()).trim().split(/\s+/).filter(Boolean).sort();
  const abort = new AbortController();
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  const pending = store.write(snapshot("aborted"), abort.signal);
  const failure = assert.rejects(pending, /BOX_DIAGNOSTIC_MUTATION_FAILED/);
  abort.abort();
  await failure;
  assert.deepEqual((await children()).trim().split(/\s+/).filter(Boolean).sort(), before);
  assert.equal(await store.read(snapshot("aborted").id), null);
  held.child.kill("SIGKILL"); await held.closed;
}));

test("hard deadline SIGKILLs and reaps an externally paused mutation", { timeout: 10_000 }, async () => home(async (dir, launch) => {
  const heldValue = snapshot("deadline-held");
  const held = launch("write", heldValue, diagnosticSlot(heldValue.id), true);
  await held.ready;
  const childrenPath = "/proc/self/task/" + process.pid + "/children";
  const before = new Set((await readFile(childrenPath, "utf8")).trim().split(/\s+/));
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  const pending = assert.rejects(store.write(snapshot("deadline")), /BOX_DIAGNOSTIC_MUTATION_FAILED/);
  const children = (await readFile(childrenPath, "utf8")).trim().split(/\s+/);
  const pid = children.find(x => x && !before.has(x));
  assert.ok(pid, "the real mutation subprocess must exist before fault injection");
  process.kill(Number(pid), "SIGSTOP");
  await pending;
  await assert.rejects(stat("/proc/" + pid), { code: "ENOENT" });
  held.child.kill("SIGKILL"); await held.closed;
}));

test("request lookup is read-only, exact-identity, bounded and excludes expired/wrong-slot data", async () => home(async dir => {
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  const wanted = snapshot("lookup"), otherUid = snapshot("lookup", now, 4n);
  const otherRequest = snapshot("other"), expired = snapshot("expired", now - DIAGNOSTIC_TTL_MS - 1);
  for (const value of [wanted, otherUid, otherRequest, expired]) await store.write(value);
  // A private but misplaced valid record must not create a second attributed hit.
  const wrong = diagnosticSlot(wanted.id) === "s000" ? "s001" : "s000";
  await writeFile(join(dir, wrong + ".json"), JSON.stringify(wanted), { mode: 0o600 });
  const before = await readdir(dir);
  assert.deepEqual(await store.findByRequest(3n, "lookup"), [wanted]);
  assert.deepEqual(await store.findByRequest(3n, "expired"), []);
  assert.deepEqual(await store.findByRequest(3n, "no-such-request"), []);
  assert.deepEqual(await store.findByRequest(0n, "lookup"), []);
  assert.deepEqual(await readdir(dir), before);
  const missing = join(dir, "absent");
  assert.deepEqual(await new BoxFailureDiagnosticStore(missing).findByRequest(3n, "lookup"), []);
  await assert.rejects(stat(missing), { code: "ENOENT" });
}));

test("idle TTL rotation removes expired records but never unlinks the permanent lock", async () => home(async dir => {
  const expired = snapshot("expiry", now - DIAGNOSTIC_TTL_MS - 1);
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  await store.write(expired);
  const lock = await stat(join(dir, ".mutation.lock"));
  let removed = 0;
  for (let i = 0; i < DIAGNOSTIC_SLOTS / 64; i++) removed += await store.sweep();
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(dir), [".mutation.lock"]);
  assert.equal((await stat(join(dir, ".mutation.lock"))).ino, lock.ino);
}));

test("unsafe lock is refused without touching its target or admitting a record", async () => home(async dir => {
  const decoy = join(dir, "decoy");
  await writeFile(decoy, "do-not-touch", { mode: 0o600 });
  await symlink(decoy, join(dir, ".mutation.lock"));
  const store = new BoxFailureDiagnosticStore(dir, () => now);
  await assert.rejects(store.write(snapshot()), /BOX_DIAGNOSTIC_MUTATION_FAILED/);
  assert.equal(await readFile(decoy, "utf8"), "do-not-touch");
  assert.equal(await store.read(snapshot().id), null);
}));
