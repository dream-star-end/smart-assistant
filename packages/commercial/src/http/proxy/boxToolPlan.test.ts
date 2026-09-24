import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeBoxToolPlan } from "./boxToolPlan.js";
import type { ProxyBody } from "./shared.js";

const supervisorAsset = readFileSync(new URL("../../../../../scripts/ocv5-289/box_supervisor.py", import.meta.url));
const keeperAsset = readFileSync(new URL("../../../../../scripts/ocv5-289/box_keeper.py", import.meta.url));
const virtualMcpAsset = readFileSync(new URL("../../../../../scripts/ocv5-289/box_virtual_mcp.py", import.meta.url));
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, messages: [{ role: "user", content: "Use local_echo on ping" }],
  tools: [{ name: "local_echo", description: "OpenClaude local-only echo",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }],
  tool_choice: { type: "auto" }, thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "medium" } };
const assets = { supervisorAsset, keeperAsset, virtualMcpAsset,
  upstreamModel: "claude-opus-5-5", maxOutputTokensLimit: 128_000,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) };

test("first tool round stages private MCP catalog and permits only virtual tools", () => {
  const plan = makeBoxToolPlan({ ...assets, body });
  const args = plan.run.args;
  assert.equal(plan.expectedModel, "claude-opus-5-5");
  assert.ok(args[0]?.startsWith("/tmp/ocv5-289-keeper-"));
  assert.ok(plan.stageVirtualMcp.args[2]?.startsWith("/tmp/ocv5-289-box-virtual-mcp-"));
  assert.ok(plan.stageInputs.some((step) => step.args.includes(`${plan.cwd}/tool-catalog.json`)));
  assert.ok(plan.cleanup.args.includes(`${plan.cwd}/tool-catalog.json`));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__ocbridge__t0");
  assert.ok(!args.includes("--disallowedTools"));
  assert.equal(args[args.indexOf("--effort") + 1], "medium");
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as {
    mcpServers: { ocbridge: { args: string[] } } };
  assert.equal(config.mcpServers.ocbridge.args[1], plan.cwd);
  assert.equal(config.mcpServers.ocbridge.args[2], plan.catalog.sha256);
  assert.ok(!args.join(" ").includes("Use local_echo on ping"));
  assert.ok(!args.join(" ").includes("OpenClaude local-only echo"));
  for (const stage of [plan.stageVirtualMcp, ...plan.stageInputs, plan.cleanup]) {
    if (stage.args[0] !== "-c") continue;
    const parsed = spawnSync("python3", ["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
      { input: stage.args[1], encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test("unsupported tool choice and thinking budget fail before a Box request exists", () => {
  assert.throws(() => makeBoxToolPlan({ ...assets, body: {
    ...body, tool_choice: { type: "tool", name: "local_echo" } } }),
  /BOX_TOOL_CHOICE_UNMAPPED/);
  assert.throws(() => makeBoxToolPlan({ ...assets, body: {
    ...body, thinking: { type: "enabled", budget_tokens: 4096 } } }),
  /BOX_EFFORT_UNMAPPED/);
});

test("tool catalog is actually staged into a private run dir and removed after known cleanup", () => {
  const plan = makeBoxToolPlan({ ...assets, body,
    runNonce: randomBytes(12).toString("hex") });
  const run = (step: typeof plan.run) => spawnSync(step.command, step.args,
    { cwd: step.cwd, env: { ...process.env, ...step.environment },
      encoding: "utf8", timeout: 5000 });
  for (const step of plan.stageInputs) {
    const result = run(step);
    assert.equal(result.status, 0, result.stderr);
  }
  const catalogPath = `${plan.cwd}/tool-catalog.json`;
  try {
    assert.equal(readFileSync(catalogPath, "utf8"), plan.catalog.json);
    assert.equal(statSync(catalogPath).mode & 0o777, 0o600);
    assert.equal(statSync(plan.cwd).mode & 0o777, 0o700);
  } finally {
    const cleaned = run(plan.cleanup);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(cleaned.stdout.trim(), "clean");
  }
  assert.equal(existsSync(plan.cwd), false);
});
