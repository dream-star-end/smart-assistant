import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { makeBoxTextPlan, makeBoxAssetsStage, BoxTextPlanError } from "./boxTextPlan.js";
import type { ProxyBody } from "./shared.js";

const supervisor = readFileSync(new URL("../../../../../scripts/ocv5-289/box_supervisor.py", import.meta.url));
const keeper = readFileSync(new URL("../../../../../scripts/ocv5-289/box_keeper.py", import.meta.url));
const body = (messages: unknown[]): ProxyBody => ({ model: "box-api-claude-opus-5",
  max_tokens: 128, stream: true, system: "OpenClaude memory marker",
  messages } as ProxyBody);

test("batched immutable assets keep per-file verification and save remote round trips", () => {
  const assets = (["supervisor", "keeper", "box-virtual-mcp", "detached-runner"] as const)
    .map((name) => {
      const asset = Buffer.from(`print('${randomBytes(12).toString("hex")}')\n`);
      const hash = createHash("sha256").update(asset).digest("hex");
      return { asset, path: `/tmp/ocv5-289-v2-${name}-${hash.slice(0, 16)}.py` };
    });
  const run = (args: string[]) => spawnSync("python3", args, { encoding: "utf8" });
  try {
    const batch = makeBoxAssetsStage(assets);
    assert.equal(batch.request.args.length, 3 + 4 * assets.length);
    const first = run(batch.request.args);
    assert.equal(first.status, 0, `stdout=${first.stdout} stderr=${first.stderr}`);
    assert.equal(first.stdout.trim(), batch.manifest);
    const warm = run(batch.request.args);
    assert.equal(warm.status, 0, `stdout=${warm.stdout} stderr=${warm.stderr}`);
    assert.equal(warm.stdout.trim(), batch.manifest);
    const changed = [...batch.request.args];
    changed[4] = Buffer.from("different").toString("base64");
    const corrupt = run(changed);
    assert.notEqual(corrupt.status, 0);
    assert.equal(corrupt.stdout, "");
  } finally {
    for (const { path } of assets) {
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
});

test("first text request stages only files and carries no prompt/system on Claude argv", () => {
  const plan = makeBoxTextPlan({ body: body([{ role: "user", content: [
    { type: "text", text: "private current user marker" },
  ] }]), upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
    maxOutputTokensLimit: 128_000,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) });
  assert.equal(plan.expectedModel, "claude-opus-5");
  assert.equal(plan.proofDir, `/tmp/ocv5-289-proof-${"a".repeat(24)}`);
  assert.deepEqual(plan.run.args.slice(3, 7),
    ["--proof-dir", plan.proofDir, "--lease-epoch", "b".repeat(32)]);
  assert.equal(plan.run.args[plan.run.args.indexOf("--deadline") + 1], "110");
  assert.ok(plan.run.args.includes("--session-id"));
  assert.ok(!plan.run.args.includes("--resume"));
  assert.ok(plan.run.args.includes("--system-prompt-file"));
  assert.equal(plan.snapshotHash, null);
  assert.equal(plan.stageInputs[0]?.args[4], "");
  assert.ok(!plan.run.args.join(" ").includes("private current user marker"));
  assert.ok(!plan.run.args.join(" ").includes("OpenClaude memory marker"));
  assert.equal(plan.run.environment.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(plan.run.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128");
  assert.equal(plan.run.cwd, plan.cwd);
  assert.equal(plan.run.args[0], "-I");
  assert.ok(plan.run.args[1]?.startsWith("/tmp/ocv5-289-v2-keeper-"));
  assert.ok(plan.run.args[2]?.startsWith("/tmp/ocv5-289-v2-supervisor-"));
});

test("completed history stages actual upstream model with a structured current turn", () => {
  const plan = makeBoxTextPlan({ body: body([
    { role: "user", content: "prior" },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
    { role: "user", content: [{ type: "text", text: "current" }] },
  ]), upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
    maxOutputTokensLimit: 128_000,
    runNonce: "b".repeat(24) });
  assert.ok(plan.run.args.includes("--resume"));
  assert.ok(plan.snapshotHash);
  const snapshotWrites = plan.stageInputs.filter((step) =>
    step.args[5]?.endsWith(`${plan.sessionId}.jsonl`) && step.args[2]?.includes("base64.b64decode"));
  const transcript = Buffer.concat(snapshotWrites.flatMap((step) => step.args.slice(8)
    .map((encoded) => Buffer.from(encoded, "base64")))).toString("utf8");
  assert.ok(transcript.includes('"model":"claude-opus-5"'));
  assert.ok(!transcript.includes('"model":"box-api-claude-opus-5"'));
  const stdinWrites = plan.stageInputs.filter((step) =>
    step.args[5]?.endsWith("/stdin.jsonl") && step.args[2]?.includes("base64.b64decode"));
  const stdin = Buffer.concat(stdinWrites.flatMap((step) => step.args.slice(8)
    .map((encoded) => Buffer.from(encoded, "base64")))).toString("utf8");
  assert.deepEqual(JSON.parse(stdin).message.content, [{ type: "text", text: "current" }]);
  for (const script of [plan.stageSupervisor.args[2], plan.stageKeeper.args[2],
    ...plan.stageInputs.map((step) => step.args[2]),
    plan.cleanup.args[2]]) {
    const parsed = spawnSync("python3", ["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
      { input: script, encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test("unproved tools and mismatched model family fail before any Box command is created", () => {
  assert.throws(() => makeBoxTextPlan({ body: { ...body([{ role: "user", content: "x" }]),
    tools: [{ name: "Bash" }] }, upstreamModel: "claude-opus-5", supervisorAsset: supervisor,
    keeperAsset: keeper,
    maxOutputTokensLimit: 128_000 }),
  (error: unknown) => error instanceof BoxTextPlanError && error.code === "BOX_TOOLS_REQUIRE_LIVE_BRIDGE");
  assert.throws(() => makeBoxTextPlan({ body: body([{ role: "user", content: "x" }]),
    upstreamModel: "grok-4.7", supervisorAsset: supervisor, keeperAsset: keeper,
    maxOutputTokensLimit: 128_000 }),
  (error: unknown) => error instanceof BoxTextPlanError && error.code === "BOX_TEXT_PLAN_INVALID");
});

test("model output cap is exact and rejects unsupported values before staging", () => {
  const input = body([{ role: "user", content: "x" }]);
  const one = makeBoxTextPlan({ body: { ...input, max_tokens: 1 }, upstreamModel: "claude-opus-5",
    supervisorAsset: supervisor, keeperAsset: keeper, maxOutputTokensLimit: 8192 });
  const many = makeBoxTextPlan({ body: { ...input, max_tokens: 8192 }, upstreamModel: "claude-opus-5",
    supervisorAsset: supervisor, keeperAsset: keeper, maxOutputTokensLimit: 8192 });
  assert.equal(one.run.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1");
  assert.equal(many.run.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
  assert.throws(() => makeBoxTextPlan({ body: { ...input, max_tokens: 8193 },
    upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
    maxOutputTokensLimit: 8192 }),
  (error: unknown) => error instanceof BoxTextPlanError && error.code === "BOX_MAX_TOKENS_UNSUPPORTED");
});
