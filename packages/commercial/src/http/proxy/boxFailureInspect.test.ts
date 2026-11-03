import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoxFailureDiagnostics, beforeBoxPrivacyCleanup } from "./boxFailureDiagnostic.js";
import { diagnosticId } from "./boxFailureDiagnosticSchema.js";
const exec = promisify(execFile);
const script = fileURLToPath(new URL("../../../../../scripts/ocv5-289/box_failure_inspect.ts", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("../../../../../scripts/ocv5-289/failure-diagnostic-v1.fixture.json", import.meta.url), "utf8"));
const identity = { uid: 3n, accountId: 25n, requestId: "inspect-test", runNonce: fixture.runNonce,
  leaseEpoch: fixture.leaseEpoch };
const proof = { ...fixture, reason: "worker_failed", revision: 2, workerExitCode: 1, keeperPid: 100, cliPid: 101 };
async function run(args: string[]) {
  try { return { code: 0, ...await exec(process.execPath, ["--import", "tsx", script, ...args],
    { timeout: 15_000, maxBuffer: 16384 }) }; }
  catch (error) { const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}
test("admin inspector reads durable evidence by ID or uid+request, cannot cross uid, creates nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "box-inspect-test-"));
  try {
    const store = join(dir, "store");
    const candidate = { ...identity, proof: { reason: "worker_failed" as const, revision: 2 as const,
      workerExitCode: proof.workerExitCode, keeperPid: proof.keeperPid, cliPid: proof.cliPid,
      runNonce: identity.runNonce, leaseEpoch: identity.leaseEpoch } };
    const diagnostics = new BoxFailureDiagnostics(store);
    await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, { exec: { run: async () => ({
      stdout: JSON.stringify({ status: "ok", diagnostic: fixture }), stderrBytes: 0, exitCode: 0,
    }) } } as never);
    const before = await readdir(store);
    for (const args of [["--id", diagnosticId(identity)], ["--uid", "3", "--request-id", identity.requestId]]) {
      const result = await run(["--directory", store, ...args]);
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, "found"); assert.equal(parsed.records.length, 1);
      assert.equal(parsed.records[0].remote.httpStatus, 401);
      assert.equal(parsed.records[0].identity.requestId, identity.requestId);
    }
    const denied = await run(["--directory", store, "--uid", "4", "--request-id", identity.requestId]);
    assert.equal(denied.code, 3); assert.deepEqual(JSON.parse(denied.stdout).records, []);
    assert.deepEqual(await readdir(store), before);
    const missing = await run(["--directory", join(dir, "missing"), "--id", diagnosticId(identity)]);
    assert.equal(missing.code, 3); assert.deepEqual(await readdir(dir), ["store"]);
    const bad = await run(["--directory", store, "--id", "../../secret-token"]);
    assert.equal(bad.code, 2); assert.doesNotMatch(bad.stderr, /secret-token/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
