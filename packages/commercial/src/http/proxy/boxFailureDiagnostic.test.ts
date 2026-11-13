import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxFailureDiagnostics, beforeBoxPrivacyCleanup } from "./boxFailureDiagnostic.js";
import { DIAGNOSTIC_TTL_MS, diagnosticId, parseRemoteDiagnostic } from "./boxFailureDiagnosticSchema.js";
import { diagnosticSlot, DIAGNOSTIC_SLOTS } from "./boxFailureDiagnosticStore.js";
import { BoxRemoteCleanupWorker } from "./boxRemoteCleanupWorker.js";
import { BoxToolFetch } from "./boxToolFetch.js";
const fixture = JSON.parse(await readFile(new URL("../../../../../scripts/ocv5-289/failure-diagnostic-v1.fixture.json", import.meta.url), "utf8"));
const candidate = { uid: 3n, accountId: 25n, requestId: "diagnostic-test", runNonce: fixture.runNonce,
  leaseEpoch: fixture.leaseEpoch, proof: { reason: "worker_failed" as const, revision: 2 as const,
    workerExitCode: 1, keeperPid: 100, cliPid: 101, runNonce: fixture.runNonce, leaseEpoch: fixture.leaseEpoch } };
const target = (data: unknown) => ({ exec: { run: async () => ({ stdout: JSON.stringify(data), stderrBytes: 0, exitCode: 0 as const }) } });
async function home(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "box-diagnostic-test-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("strict remote metadata rejects secret-bearing fields and unknown values", () => {
  assert.ok(parseRemoteDiagnostic(fixture, candidate));
  for (const poisoned of [ { ...fixture, stderr: "secret-token" }, { ...fixture, upstreamCode: "secret-token" },
    { ...fixture, stage: "https://token@example.invalid" }, { ...fixture, version: 2 },
    { ...fixture, runNonce: "a".repeat(24) }, { ...fixture, httpStatus: "401 secret-token" },
    { ...fixture, flags: { ...fixture.flags, secret: "secret-token" } } ]) {
    assert.equal(parseRemoteDiagnostic(poisoned, candidate), null);
  }
});

test("only same-identity nonexpired durable metadata produces an opaque ID", async () => home(async dir => {
  let now = Date.now();
  const diagnostics = new BoxFailureDiagnostics(join(dir, "store"), () => now);
  await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, target({ status: "ok", diagnostic: fixture }) as never);
  const id = await diagnostics.findId(candidate);
  assert.match(id!, /^bdiag_[a-f0-9]{24}$/);
  assert.equal(await diagnostics.findId({ ...candidate, uid: 4n }), null);
  assert.equal(await diagnostics.findId({ ...candidate, requestId: "different" }), null);
  const read = await diagnostics.store.read(id!);
  assert.equal(read?.remote?.httpStatus, 401);
  assert.equal(read?.terminal.reason, "worker_failed");
  now += DIAGNOSTIC_TTL_MS;
  assert.equal(await diagnostics.findId(candidate), null);
  // No new failure is necessary: idle ticks independently reclaim old slots.
  for (let i = 0; i < DIAGNOSTIC_SLOTS / 64; i++) await diagnostics.sweep();
  assert.deepEqual((await readdir(join(dir, "store"))).filter(name => name !== ".mutation.lock"), []);
}));

test("a late observer failure never replaces already captured worker evidence", async () => home(async dir => {
  const diagnostics = new BoxFailureDiagnostics(join(dir, "store"));
  await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, target({ status: "ok", diagnostic: fixture }) as never);
  let reads = 0;
  await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, { exec: { run: async () => {
    reads++; throw new Error("https://secret-token.invalid");
  } } } as never);
  assert.equal(reads, 0);
  assert.equal((await diagnostics.store.read(diagnosticId(candidate)))?.remote?.upstreamCode, "authentication");
}));

test("missing and invalid old-version evidence stays explicit and contains no payload", async () => home(async dir => {
  const diagnostics = new BoxFailureDiagnostics(join(dir, "store"));
  for (const [n, data, status] of [
    ["missing", { status: "missing" }, "missing"],
    ["invalid", { status: "ok", diagnostic: { ...fixture, stderr: "secret-token" } }, "invalid"],
  ] as const) {
    const id = { ...candidate, requestId: n };
    await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, id, target(data) as never);
    const snapshot = await diagnostics.store.read(diagnosticId(id));
    assert.equal(snapshot?.status, status);
    assert.equal(snapshot?.remote, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-token/);
  }
}));

test("timeout aborts late collection, returns to cleanup, and never resurrects a file", async () => home(async dir => {
  const diagnostics = new BoxFailureDiagnostics(join(dir, "store"));
  let cleaned = false;
  await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, { exec: { run: async () => {
    await new Promise(r => setTimeout(r, 60));
    return { stdout: JSON.stringify({ status: "ok", diagnostic: fixture }), stderrBytes: 0, exitCode: 0 };
  } } } as never, 10);
  cleaned = true;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(cleaned, true);
  assert.equal(await diagnostics.findId(candidate), null);
  assert.deepEqual(await readdir(dir), []);
}));

test("unwritable store does not block privacy cleanup", async () => home(async dir => {
  const blocked = join(dir, "blocked"); await writeFile(blocked, "not-a-directory", { mode: 0o600 });
  const diagnostics = new BoxFailureDiagnostics(blocked);
  await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, target({ status: "ok", diagnostic: fixture }) as never);
  assert.equal(await diagnostics.findId(candidate), null);
  assert.equal(await readFile(blocked, "utf8"), "not-a-directory");
}));

test("bounded cache collision evicts without misattributing another request", async () => home(async dir => {
  const diagnostics = new BoxFailureDiagnostics(join(dir, "store"));
  const slot = diagnosticSlot(diagnosticId(candidate));
  let collision = candidate;
  for (let i = 0; i < 50_000; i++) {
    const trial = { ...candidate, requestId: `collision-${i}` };
    if (diagnosticSlot(diagnosticId(trial)) === slot) { collision = trial; break; }
  }
  assert.notEqual(collision.requestId, candidate.requestId);
  for (const id of [candidate, collision]) await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, id,
    target({ status: "ok", diagnostic: fixture }) as never);
  assert.equal(await diagnostics.findId(candidate), null);
  assert.ok(await diagnostics.findId(collision));
  assert.equal((await readdir(join(dir, "store"))).filter(name => name !== ".mutation.lock").length, 1);
}));

test("leader and egress cleanup both capture before destructive exec; errors still clean", async () => {
  for (const lane of ["leader", "egress"] as const) for (const fail of [false, true]) {
    const sequence: string[] = [];
    const remote = { accountId: candidate.accountId, exec: { run: async () => {
      sequence.push("clean"); return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 };
    } }, dispose: async () => {} };
    const journal = { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => true, markRemoteCleaned: async () => { sequence.push("done"); } };
    const hook = async () => { sequence.push("capture"); if (fail) throw new Error("secret-token"); };
    if (lane === "leader") {
      const worker = new BoxRemoteCleanupWorker({ journal: journal as never,
        resolver: { resolve: async () => remote } as never, beforeCleanup: hook });
      assert.equal((await worker.reconcileBatch()).cleaned, 1);
    } else {
      const worker = new BoxToolFetch({ supervisorAsset: Buffer.alloc(0), keeperAsset: Buffer.alloc(0),
        virtualMcpAsset: Buffer.alloc(0), detachedRunnerAsset: Buffer.alloc(0), journal: journal as never,
        maxOutputTokensForModel: () => null, resolveTarget: async () => remote as never,
        onUnknown: async () => {}, beforeCleanup: hook });
      // API returns remaining pending cleanups, not the number cleaned.
      assert.equal(await worker.reconcileRemoteCleanup(), 0);
    }
    assert.deepEqual(sequence, ["capture", "clean", "done"]);
  }
});

test("success skips diagnostics and idle leader ticks still sweep", async () => {
  let calls = 0, sweeps = 0;
  const success = { ...candidate, proof: { runNonce: candidate.runNonce, leaseEpoch: candidate.leaseEpoch,
    keeperPid: 100, cliPid: 101, reason: "worker_complete" as const, revision: 1 as const } };
  await beforeBoxPrivacyCleanup(async () => { calls++; }, success, target(null) as never);
  assert.equal(calls, 0);
  const worker = new BoxRemoteCleanupWorker({ journal: { listRemoteCleanupCandidates: async () => [] } as never,
    resolver: {} as never, sweepDiagnostics: async () => { sweeps++; } });
  await worker.reconcileBatch(); assert.equal(sweeps, 1);
});

test("OCV5-742 upstream first cause and cleanup signal survive collection independently", async () => home(async dir => {
  const diagnostics = new BoxFailureDiagnostics(join(dir, "store"));
  const failure = { ...candidate, proof: { ...candidate.proof, workerExitCode: 143 } };
  const remote = { ...fixture, stage: "shutdown", reason: "interrupted",
    cliExitCode: -9, cliSignal: 9, httpStatus: 401, upstreamCode: "authentication", lastEvent: "result" };
  await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, failure,
    target({ status: "ok", diagnostic: remote }) as never);
  const saved = await diagnostics.store.read(diagnosticId(failure));
  assert.equal(saved?.status, "ok");
  assert.equal(saved?.remote?.upstreamCode, "authentication");
  assert.equal(saved?.remote?.httpStatus, 401);
  assert.equal(saved?.remote?.reason, "interrupted");
  assert.equal(saved?.remote?.cliSignal, 9);
  assert.deepEqual(saved?.terminal, failure.proof);
  assert.deepEqual(failure.proof, { ...candidate.proof, workerExitCode: 143 });
}));
