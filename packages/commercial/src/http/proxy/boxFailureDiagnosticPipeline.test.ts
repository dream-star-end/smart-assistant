/** Offline cross-language path: real CLI failure -> remote diagnostic -> privacy
 * cleanup -> durable safe summary. No network, account or billing fixtures. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BoxFailureDiagnostics, beforeBoxPrivacyCleanup } from "./boxFailureDiagnostic.js";
import { diagnosticId, parseRemoteDiagnostic } from "./boxFailureDiagnosticSchema.js";
import { parseBoxTerminalProof } from "./boxTerminalProof.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import type { BoxRemoteCleanupCandidate } from "./boxDurableJournal.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = "/usr/bin/python3";
const SCRIPTS = join(ROOT, "scripts/ocv5-289");
const execute = promisify(execFile);

test("commercial unit gate executes the real Python supervisor diagnostic suite",
  { timeout: 120_000 }, async (t) => {
    const { stdout, stderr } = await execute(PYTHON, ["-I",
      join(SCRIPTS, "test_box_supervisor_diagnostic.py")], {
      cwd: ROOT, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 110_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    });
    const count = /Ran ([0-9]+) tests/.exec(stderr);
    assert.ok(count, "Python suite must report an executed test count");
    assert.ok(Number(count[1]) >= 21, "all failure/lifetime/privacy cases must execute");
    assert.match(stderr, /\nOK\s*$/);
    assert.doesNotMatch(stderr, /skipped|FAILED|ERROR:/);
    assert.equal(stdout, "");
    t.diagnostic("Python supervisor diagnostic cases executed: " + count[1] + "; no skips");
  });

test("Python v1 fixture agrees with the strict TypeScript boundary", () => {
  const fixture = JSON.parse(readFileSync(join(SCRIPTS, "failure-diagnostic-v1.fixture.json"), "utf8"));
  const identity = { runNonce: fixture.runNonce, leaseEpoch: fixture.leaseEpoch };
  assert.deepEqual(parseRemoteDiagnostic(fixture, identity), fixture);
  assert.equal(parseRemoteDiagnostic({ ...fixture, stderr: "must-not-cross-boundary" }, identity), null);
  assert.equal(parseRemoteDiagnostic(fixture, { ...identity, leaseEpoch: "e".repeat(32) }), null);
});

test("actual failed keeper/supervisor survives cleanup as a safe durable diagnostic",
  { timeout: 30_000 }, async () => {
    const runNonce = randomBytes(12).toString("hex");
    const leaseEpoch = randomBytes(16).toString("hex");
    const run = "/tmp/ocv5-289-run-" + runNonce;
    const proof = "/tmp/ocv5-289-proof-" + runNonce;
    const local = mkdtempSync("/tmp/box-diagnostic-pipeline-");
    const store = join(local, "safe-store");
    const raw = Buffer.concat([readFileSync(join(SCRIPTS, "box_supervisor.py")),
      Buffer.from("\n# isolated-pipeline-" + randomBytes(16).toString("hex") + "\n")]);
    const staged = "/tmp/ocv5-289-supervisor-" + createHash("sha256").update(raw).digest("hex").slice(0, 16) + ".py";
    const secret = "Bearer synthetic-private-" + randomBytes(16).toString("hex");
    const privateUrl = "https://not-a-real-account.invalid/path?token=" + randomBytes(16).toString("hex");
    let ownsStaged = false, ownsRun = false, ownsProof = false;
    try {
      writeFileSync(staged, raw, { mode: 0o600, flag: "wx" }); ownsStaged = true;
      mkdirSync(run, { mode: 0o700 }); ownsRun = true;
      const cliEvents = [
        { type: "system", message: secret },
        { type: "assistant", error: "authentication_failed", is_api_error_message: true,
          message: { model: "<synthetic>", content: [
            { type: "text", text: "API Error: 401 " + secret + " " + privateUrl },
          ] } },
        { type: "result", is_error: true, result: "API Error: 429 " + secret,
          errors: ["turn ended on an API error"] },
      ];
      const fakeCli = "import sys;sys.stdout.write(" +
        JSON.stringify(cliEvents.map(event => JSON.stringify(event) + "\n").join("")) +
        ");sys.exit(1)";
      assert.equal(existsSync(proof), false, "never reuse an existing proof directory");
      ownsProof = true; // Only the keeper invocation below may create this random path.
      const failed = spawnSync(PYTHON, ["-I", join(SCRIPTS, "box_keeper.py"), staged,
        "--deadline", "5", "--kill-after", ".05", "--max-output", "262144",
        "--proof-dir", proof, "--lease-epoch", leaseEpoch, "--", PYTHON, "-I", "-c", fakeCli],
      { cwd: run, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10_000 });
      assert.ifError(failed.error);
      assert.equal(failed.status, 1, failed.stderr);
      assert.equal(failed.stderr, "", "raw CLI stderr remains non-forwarded");
      assert.ok(failed.stdout.includes(secret), "fixture really emitted private model content");
      const terminalRaw = readFileSync(join(proof, "terminal.json"), "utf8");
      const readyRaw = readFileSync(join(proof, "stop.ready"), "utf8");
      const terminal = parseBoxTerminalProof(terminalRaw, { runNonce, leaseEpoch });
      assert.equal(terminal.reason, "worker_failed");
      assert.equal(terminal.revision, 2);
      assert.equal(terminal.reason === "worker_failed" && terminal.workerExitCode, 1);
      assert.equal(existsSync("/proc/" + terminal.cliPid), false, "keeper reaped the actual child");
      const remoteRaw = readFileSync(join(proof, "failure.diag.json"), "utf8");
      const remote = parseRemoteDiagnostic(JSON.parse(remoteRaw), { runNonce, leaseEpoch });
      assert.ok(remote, "real producer must satisfy the exact central schema");
      assert.equal(remote.httpStatus, 401);
      assert.equal(remote.upstreamCode, "authentication");
      assert.equal(remote.cliExitCode, 1);
      assert.equal(remote.reason, "child_exit");
      assert.equal(remoteRaw.includes(secret) || remoteRaw.includes(privateUrl), false);

      const put = (name: string, content: string) =>
        writeFileSync(join(run, name), content, { mode: 0o600, flag: "wx" });
      put("stdout.jsonl", failed.stdout);
      put("stderr.log", secret + "\n");
      put("stdin.jsonl", secret + " private-prompt\n");
      put("system.txt", secret + " private-system\n");
      const spoolInode = statSync(join(run, "stdout.jsonl")).ino;
      const candidate: BoxRemoteCleanupCandidate = {
        uid: 999991n, accountId: 999992n, requestId: "offline_" + randomBytes(16).toString("hex"),
        runNonce, leaseEpoch, proof: terminal,
      };
      const target: Pick<BoxResolvedTarget, "exec"> = { exec: {
        async run(request, options) {
          // Execute factory-produced commands verbatim, not canned read/cleanup
          // responses. Only this test's random run identity may be addressed.
          assert.equal(request.command, PYTHON);
          assert.equal(request.cwd, "/tmp");
          assert.ok(request.args.includes(runNonce));
          const result = await execute(request.command, request.args, {
            cwd: request.cwd, env: { ...request.environment }, signal: options.signal,
            encoding: "utf8", timeout: options.timeoutMs,
            maxBuffer: options.maxResponseBytes ?? 262144,
          });
          return { stdout: result.stdout, stderrBytes: Buffer.byteLength(result.stderr), exitCode: 0 as const };
        },
      } };
      const diagnostics = new BoxFailureDiagnostics(store);
      await beforeBoxPrivacyCleanup(diagnostics.beforeCleanup, candidate, target);
      const id = diagnosticId(candidate);
      const savedBefore = await diagnostics.store.read(id);
      assert.equal(savedBefore?.status, "ok", "actual remote bytes were persisted before deletion");

      const cleaned = await target.exec.run(makeBoxRunCleanup(runNonce, true), {
        timeoutMs: 5000, maxResponseBytes: 16384,
      });
      assert.equal(cleaned.stdout.trim(), "clean");
      assert.equal(readFileSync(join(run, "stdout.jsonl")).length, 0);
      assert.equal(readFileSync(join(run, "stderr.log")).length, 0);
      assert.equal(statSync(join(run, "stdout.jsonl")).ino, spoolInode, "replay tombstone inode survives");
      assert.equal(existsSync(join(run, "stdin.jsonl")), false);
      assert.equal(existsSync(join(run, "system.txt")), false);
      assert.equal(existsSync(join(proof, "failure.diag.json")), false, "optional remote snapshot is cleaned");
      assert.equal(readFileSync(join(proof, "terminal.json"), "utf8"), terminalRaw, "terminal proof is untouched");
      assert.equal(readFileSync(join(proof, "stop.ready"), "utf8"), readyRaw, "stop proof is untouched");

      const reopened = new BoxFailureDiagnostics(store);
      assert.equal(await reopened.findId(candidate), id);
      const saved = await reopened.store.read(id);
      assert.deepEqual(saved, savedBefore, "a fresh reader recovers the summary after raw evidence was removed");
      assert.equal(saved?.remote?.httpStatus, 401);
      assert.equal(saved?.remote?.upstreamCode, "authentication");
      assert.deepEqual(saved?.terminal, terminal);
      for (const name of readdirSync(store).filter(name => name !== ".mutation.lock")) {
        const bytes = readFileSync(join(store, name), "utf8");
        assert.ok(Buffer.byteLength(bytes) <= 8192);
        assert.equal(bytes.includes(secret) || bytes.includes(privateUrl), false, "no secret reaches disk");
      }
    } finally {
      // Only paths created with this test's random identities, never a broad
      // /tmp prefix or a real Box account directory.
      if (ownsStaged) rmSync(staged, { force: true });
      if (ownsRun) rmSync(run, { recursive: true, force: true });
      if (ownsProof) rmSync(proof, { recursive: true, force: true });
      rmSync(local, { recursive: true, force: true });
    }
  });
