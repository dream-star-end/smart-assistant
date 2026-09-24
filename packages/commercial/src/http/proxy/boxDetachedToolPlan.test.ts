import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(plan.launch.args[1], plan.cwd);
  assert.equal(plan.launch.args[2], plan.run.args[0]);
  assert.equal(plan.launch.args[3], plan.run.args[1]);
  assert.deepEqual(plan.launch.args.slice(4), plan.run.args.slice(2));
  assert.ok(!plan.launch.args.join(" ").includes("private tool prompt"));
  assert.ok(!plan.launch.args.join(" ").includes("local-only tool"));
  const reader = plan.readSpool(42, 4096);
  assert.deepEqual(reader.args.slice(1), ["--read", plan.cwd, "42", "4096"]);
  assert.throws(() => plan.readSpool(-1), /BOX_SPOOL_READ_INVALID/);
  assert.throws(() => plan.readSpool(0, 65537), /BOX_SPOOL_READ_INVALID/);
});
