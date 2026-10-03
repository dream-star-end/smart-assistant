import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { makeBoxDetachedTextPlan } from "./boxDetachedTextPlan.js";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";
import { parseBoxTerminalProof } from "./boxTerminalProof.js";
import type { ProxyBody } from "./shared.js";

const asset = (name: string) => readFileSync(
  new URL(`../../../../../scripts/ocv5-289/${name}`, import.meta.url));
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, messages: [{ role: "user", content: "private synthetic text" }] };
const makePlan = () => makeBoxDetachedTextPlan({ body,
  upstreamModel: "claude-opus-5-5", maxOutputTokensLimit: 128_000,
  supervisorAsset: asset("box_supervisor.py"), keeperAsset: asset("box_keeper.py"),
  detachedRunnerAsset: asset("box_detached_runner.py"),
  runNonce: randomBytes(12).toString("hex") });

test("text shares pinned detached runner and does not put private input on argv", () => {
  const plan = makePlan();
  assert.equal(plan.launch.args[5], plan.text.cwd);
  assert.deepEqual(plan.launch.args.slice(6), plan.text.run.args.slice(1));
  assert.ok(!plan.launch.args.join(" ").includes("private synthetic text"));
  assert.equal("cleanup" in plan.text, false,
    "a post-launch caller must not receive the partial text-plan cleanup");
  assert.equal(plan.stageAssets.args.length, 3 + 4 * 3);
  assert.deepEqual(plan.readSpool(42).args.slice(5),
    ["--read", plan.text.cwd, "42", "65536"]);
});

test("native first call prelaunch discards synthetic project; resume pins old cwd", () => {
  const common = { body, upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 128_000,
    supervisorAsset: asset("box_supervisor.py"),
    keeperAsset: asset("box_keeper.py"),
    detachedRunnerAsset: asset("box_detached_runner.py") };
  const fresh = makeBoxDetachedTextPlan({ ...common, nativePersistence: true,
    runNonce: "a".repeat(24) });
  assert.equal(fresh.prelaunchCleanup.args[5], "full");
  assert.equal("cleanup" in fresh.text, false);
  assert.equal("discardNativeCleanup" in fresh.text, false);
  const oldCwd = `/tmp/ocv5-289-run-${"b".repeat(24)}`;
  const resumed = makeBoxDetachedTextPlan({ ...common,
    runNonce: "c".repeat(24), nativeResume: {
      cliCwd: oldCwd, sessionId: "12345678-1234-4123-8123-123456789abc",
      expectedSha256: "d".repeat(64) } });
  assert.deepEqual(resumed.launch.args.slice(6, 11), [
    resumed.text.run.args[1], resumed.text.run.args[2],
    "--cli-cwd", oldCwd, resumed.text.run.args[3] ]);
  assert.equal(resumed.prelaunchCleanup.args[4], "",
    "resume prelaunch cleanup must not delete predecessor's native cwd");
});

test("real Python detached text wrapper survives launch and exposes only synthetic spool", async () => {
  const plan = makePlan();
  const run = (step: typeof plan.launch) => spawnSync(step.command, step.args,
    { cwd: step.cwd, env: { ...process.env, ...step.environment },
      encoding: "utf8", timeout: 5000 });
  try {
    for (const step of [plan.stageAssets, ...plan.text.stageInputs]) {
      const staged = run(step);
      assert.equal(staged.status, 0, staged.stderr);
    }
    const separator = plan.launch.args.indexOf("--");
    assert.ok(separator > 6);
    const synthetic = { ...plan.launch, args: [
      ...plan.launch.args.slice(0, separator + 1),
      "/usr/bin/python3", "-I", "-c", "print('detached-text-synthetic')",
    ] };
    const launch = run(synthetic);
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(launch.stdout.trim(), "launched");
    const proof = `${plan.text.proofDir}/terminal.json`;
    const until = Date.now() + 5000;
    while (!existsSync(proof) && Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(proof));
    assert.equal(parseBoxTerminalProof(readFileSync(proof, "utf8"), {
      runNonce: plan.text.runNonce, leaseEpoch: plan.text.leaseEpoch }).reason,
    "worker_complete");
    assert.match(readFileSync(`${plan.text.cwd}/stdout.jsonl`, "utf8"),
      /detached-text-synthetic/);
    const cleaned = run(makeBoxRunCleanup(plan.text.runNonce));
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(cleaned.stdout.trim(), "clean");
    assert.equal(readFileSync(`${plan.text.cwd}/stdout.jsonl`).length, 0);
  } finally {
    if (existsSync(plan.text.cwd)) rmSync(plan.text.cwd, { recursive: true, force: true });
    if (existsSync(plan.text.proofDir)) {
      rmSync(plan.text.proofDir, { recursive: true, force: true });
    }
  }
});
