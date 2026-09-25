import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeBoxDetachedToolPlan } from "./boxDetachedToolPlan.js";
import type { ProxyBody } from "./shared.js";

const read = (name: string) => readFileSync(
  new URL(`../../../../../scripts/ocv5-289/${name}`, import.meta.url));
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, messages: [{ role: "user", content: "private tool prompt" }],
  tools: [{ name: "local_echo", description: "local-only tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }],
  tool_choice: { type: "auto" } };

test("detached tool launch reuses private staged plan without putting user content on argv", () => {
  const plan = makeBoxDetachedToolPlan({ body, upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 128_000, supervisorAsset: read("box_supervisor.py"),
    keeperAsset: read("box_keeper.py"), virtualMcpAsset: read("box_virtual_mcp.py"),
    detachedRunnerAsset: read("box_detached_runner.py"),
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) });
  assert.ok(plan.stageDetachedRunner.args[3]?.startsWith("/tmp/ocv5-289-detached-runner-"));
  assert.equal(plan.launch.args[5], plan.cwd);
  assert.deepEqual(plan.launch.args.slice(6), plan.run.args.slice(1),
    "the runner receives keeper first, not Python's -I interpreter flag");
  assert.ok(!plan.launch.args.join(" ").includes("private tool prompt"));
  assert.ok(!plan.launch.args.join(" ").includes("local-only tool"));
  const reader = plan.readSpool(42, 4096);
  assert.deepEqual(reader.args.slice(5), ["--read", plan.cwd, "42", "4096"]);
  assert.throws(() => plan.readSpool(-1), /BOX_SPOOL_READ_INVALID/);
  assert.throws(() => plan.readSpool(0, 65537), /BOX_SPOOL_READ_INVALID/);
});

test("real detached plan reaches keeper and supervisor without a paid model", async () => {
  const plan = makeBoxDetachedToolPlan({ body, upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 128_000, supervisorAsset: read("box_supervisor.py"),
    keeperAsset: read("box_keeper.py"), virtualMcpAsset: read("box_virtual_mcp.py"),
    detachedRunnerAsset: read("box_detached_runner.py"),
    runNonce: randomBytes(12).toString("hex") });
  const run = (step: typeof plan.launch) => spawnSync(step.command, step.args,
    { cwd: step.cwd, env: { ...process.env, ...step.environment },
      encoding: "utf8", timeout: 5000 });
  for (const step of [plan.stageSupervisor, plan.stageKeeper,
    plan.stageVirtualMcp, plan.stageDetachedRunner, ...plan.stageInputs]) {
    const staged = run(step);
    assert.equal(staged.status, 0, staged.stderr);
  }
  try {
    const separator = plan.launch.args.indexOf("--");
    assert.ok(separator > 6);
    const synthetic = { ...plan.launch, args: [
      ...plan.launch.args.slice(0, separator + 1),
      "/usr/bin/python3", "-I", "-c", "print('synthetic-model-output')",
    ] };
    const launched = run(synthetic);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), "launched");
    const proof = `${plan.proofDir}/terminal.json`;
    const deadline = Date.now() + 5000;
    while (!existsSync(proof) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(JSON.parse(readFileSync(proof, "utf8")).reason, "worker_complete");
    assert.match(readFileSync(`${plan.cwd}/stdout.jsonl`, "utf8"), /synthetic-model-output/);
    assert.equal(run(plan.cleanup).status, 0);
  } finally {
    if (existsSync(plan.cwd)) rmSync(plan.cwd, { recursive: true, force: true });
    if (existsSync(plan.proofDir)) rmSync(plan.proofDir, { recursive: true, force: true });
  }
});

test("known-terminal cleanup removes detached stdout and stderr with private inputs", () => {
  const plan = makeBoxDetachedToolPlan({ body, upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 128_000, supervisorAsset: read("box_supervisor.py"),
    keeperAsset: read("box_keeper.py"), virtualMcpAsset: read("box_virtual_mcp.py"),
    detachedRunnerAsset: read("box_detached_runner.py"),
    runNonce: randomBytes(12).toString("hex") });
  const run = (step: typeof plan.cleanup) => spawnSync(step.command, step.args,
    { cwd: step.cwd, env: { ...process.env, ...step.environment },
      encoding: "utf8", timeout: 5000 });
  for (const step of plan.stageInputs) {
    const staged = run(step);
    assert.equal(staged.status, 0, staged.stderr);
  }
  try {
    writeFileSync(`${plan.cwd}/stdout.jsonl`, "synthetic-model-output", { mode: 0o600 });
    writeFileSync(`${plan.cwd}/stderr.log`, "synthetic-stderr", { mode: 0o600 });
    const cleanup = run(plan.cleanup);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(cleanup.stdout.trim(), "clean");
    assert.equal(existsSync(plan.cwd), false);
  } finally {
    if (existsSync(plan.cwd)) rmSync(plan.cwd, { recursive: true, force: true });
  }
});
