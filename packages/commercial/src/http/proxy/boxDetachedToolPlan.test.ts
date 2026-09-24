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
  assert.ok(plan.stageDetachedRunner.args[2]?.startsWith("/tmp/ocv5-289-detached-runner-"));
  assert.equal(plan.launch.args[4], plan.cwd);
  assert.deepEqual(plan.launch.args.slice(5), plan.run.args);
  assert.ok(!plan.launch.args.join(" ").includes("private tool prompt"));
  assert.ok(!plan.launch.args.join(" ").includes("local-only tool"));
  const reader = plan.readSpool(42, 4096);
  assert.deepEqual(reader.args.slice(4), ["--read", plan.cwd, "42", "4096"]);
  assert.throws(() => plan.readSpool(-1), /BOX_SPOOL_READ_INVALID/);
  assert.throws(() => plan.readSpool(0, 65537), /BOX_SPOOL_READ_INVALID/);
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
