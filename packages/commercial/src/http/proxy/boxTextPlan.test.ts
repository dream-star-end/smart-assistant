import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { makeBoxTextPlan, makeBoxAssetsStage, BoxTextPlanError, boxRunnerLoginScope,
  boxRunnerPlanInput } from "./boxTextPlan.js";
import { makeBoxToolPlan } from "./boxToolPlan.js";
import {
  PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
  PROXY_BYTE_BUDGET_LEGACY,
  runWithVerifiedProxyByteBudget,
  type ProxyBody,
} from "./shared.js";

const supervisor = readFileSync(new URL("../../../../../scripts/ocv5-289/box_supervisor.py", import.meta.url));
const keeper = readFileSync(new URL("../../../../../scripts/ocv5-289/box_keeper.py", import.meta.url));
const body = (messages: unknown[]): ProxyBody => ({ model: "box-api-claude-opus-5",
  max_tokens: 128, stream: true, system: "OpenClaude memory marker",
  messages } as ProxyBody);
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("batched immutable assets keep per-file verification and save remote round trips", () => {
  const assets = (["supervisor", "keeper", "box-virtual-mcp", "detached-runner", "interactive-host"] as const)
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

test("an interactive-runner plan runs the staged oc-box host on the same argv without its --print-only flags", () => {
  const host = { host: Buffer.from("print('host')\n"), modFiles: JSON.stringify({ "hooks/hooks.json": "e30=" }),
    modSha256: "c".repeat(64) };
  const hostPath = `/tmp/ocv5-289-v2-interactive-host-${createHash("sha256").update(host.host).digest("hex").slice(0, 16)}.py`;
  const input = { body: body([user("hi")]), upstreamModel: "claude-haiku-5-5", supervisorAsset: supervisor,
    keeperAsset: keeper, maxOutputTokensLimit: 128_000, runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) };
  // The synthetic session id is random per plan; everything else is fixed by the input.
  const fixed = (args: readonly string[]) => args.map((arg) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(arg) ? "ID" : arg);
  const print = makeBoxTextPlan(input);
  const interactive = makeBoxTextPlan({ ...input, interactiveHost: host });
  const at = print.run.args.indexOf("--");
  const hostAt = interactive.run.args.indexOf("--");
  assert.deepEqual(fixed(interactive.run.args.slice(0, hostAt)), fixed(print.run.args.slice(0, at)));
  assert.deepEqual(interactive.run.args.slice(hostAt + 1, hostAt + 4), ["/usr/bin/python3", "-I", hostPath]);
  const printOnly = new Set(["-p", "--include-partial-messages", "--verbose", "--no-session-persistence",
    "--input-format", "--output-format", "stream-json"]);
  assert.deepEqual(fixed(interactive.run.args.slice(hostAt + 4)),
    fixed(print.run.args.slice(at + 1).filter((arg) => !printOnly.has(arg))));
  assert.equal(print.run.args[at + 1], "/home/box/.local/bin/claude");
  assert.equal(print.run.args[at + 2], "-p");
  // Nothing the Box runs for an interactive model carries `-p`.
  assert.ok(!interactive.run.args.some((arg) => printOnly.has(arg)));
  assert.ok(print.run.args.includes("--no-session-persistence"));
  assert.equal(interactive.run.environment.OC_BOX_NO_SESSION_PERSISTENCE, "1");
  assert.deepEqual({ mode: interactive.run.environment.OC_BOX_HOST_MODE, files: interactive.run.environment.OC_BOX_MOD_FILES,
    sha: interactive.run.environment.OC_BOX_MOD_SHA256 }, { mode: "print", files: host.modFiles, sha: host.modSha256 });
  assert.equal(print.run.environment.OC_BOX_HOST_MODE, undefined);
  // OCV5-386: an interactive CLI would background a >120 s tool call and answer with its own text.
  for (const plan of [print, interactive]) assert.equal(plan.run.environment.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, "0");
  assert.deepEqual(interactive.interactiveHost?.path, hostPath);
  assert.equal(print.interactiveHost, undefined);
  assert.equal(interactive.assetManifest.split(",").length, 3);
  assert.equal(print.assetManifest.split(",").length, 2);
  // The tool plan keeps its own argv edits and stages the host beside the virtual MCP.
  const tools = [{ name: "Bash", description: "x", input_schema: { type: "object", properties: {} } }];
  const toolPlan = makeBoxToolPlan({ ...input, body: { ...input.body, tools } as ProxyBody,
    virtualMcpAsset: Buffer.from("print('mcp')\n"), interactiveHost: host });
  const toolAt = toolPlan.run.args.indexOf("--");
  assert.deepEqual(toolPlan.run.args.slice(toolAt + 1, toolAt + 4), ["/usr/bin/python3", "-I", hostPath]);
  assert.ok(toolPlan.run.args.includes("--allowedTools") && !toolPlan.run.args.includes("--disallowedTools"));
  assert.equal(toolPlan.assetManifest.split(",").length, 4);
  assert.ok(!toolPlan.run.args.some((arg) => printOnly.has(arg)));
  // Step-by-step staging (fast path off) stages the host on its own, like each helper.
  for (const plan of [interactive, toolPlan]) assert.equal(plan.stageInteractiveHost?.args[3], hostPath);
  assert.equal(print.stageInteractiveHost, undefined);
  assert.throws(() => makeBoxTextPlan({ ...input, interactiveHost: { ...host, modSha256: "nope" } }), /BOX_TEXT_PLAN_INVALID/);
});

test("box-claude-* never runs as claude -p: without the host it is refused; its launches may use every login", () => {
  const host = { host: Buffer.from("x"), modFiles: "{}", modSha256: "c".repeat(64) };
  assert.deepEqual(boxRunnerPlanInput("box-claude-haiku-5-5", host), { interactiveHost: host });
  assert.throws(() => boxRunnerPlanInput("box-claude-haiku-5-5", undefined), /BOX_INTERACTIVE_HOST_UNAVAILABLE/);
  assert.deepEqual(boxRunnerPlanInput("box-api-claude-haiku-5-5", host), {});
  assert.deepEqual(boxRunnerPlanInput("box-api-claude-haiku-5-5", undefined), {});
  assert.equal(boxRunnerLoginScope("box-claude-opus-5-5"), "all");
  assert.equal(boxRunnerLoginScope("box-api-claude-opus-5-5"), "default");
  assert.equal(boxRunnerLoginScope("cursor-auto"), "default");
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
  assert.equal(plan.run.environment.CLAUDE_CODE_DISABLE_REFUSAL_RETRY, "1");
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

test("native completed-turn resume stages only current input and keeps one CLI UUID", () => {
  const cliCwd = `/tmp/ocv5-289-run-${"a".repeat(24)}`;
  const sessionId = "12345678-1234-4123-8123-123456789abc";
  const history = body([user("prior"), { role: "assistant", content: [
    { type: "text", text: "previous answer" }] }, user("current")]);
  const fresh = makeBoxTextPlan({ body: body([user("initial")]),
    upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
    maxOutputTokensLimit: 128_000, nativePersistence: true,
    runNonce: "b".repeat(24) });
  assert.equal(fresh.nativePersistence, true);
  assert.ok(fresh.run.args.includes("--session-id"));
  assert.ok(!fresh.run.args.includes("--no-session-persistence"));
  assert.equal(fresh.run.environment.DISABLE_AUTO_COMPACT, "1");
  const trustedFresh = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () =>
    makeBoxTextPlan({ body: body([user("initial")]),
      upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
      maxOutputTokensLimit: 128_000, nativePersistence: true,
      runNonce: "d".repeat(24) }));
  assert.equal(trustedFresh.run.environment.DISABLE_AUTO_COMPACT, "0");
  const trustedResume = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () =>
    makeBoxTextPlan({ body: history, upstreamModel: "claude-opus-5",
      supervisorAsset: supervisor, keeperAsset: keeper, maxOutputTokensLimit: 128_000,
      nativeResume: { cliCwd, sessionId, expectedSha256: "e".repeat(64) },
      runNonce: "e".repeat(24) }));
  assert.equal(trustedResume.run.environment.DISABLE_AUTO_COMPACT, "0");
  const stillLegacy = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_LEGACY, () =>
    makeBoxTextPlan({ body: body([user("initial")]),
      upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
      maxOutputTokensLimit: 128_000, nativePersistence: true,
      runNonce: "f".repeat(24) }));
  assert.equal(stillLegacy.run.environment.DISABLE_AUTO_COMPACT, "1");
  const nonPersistent = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () =>
    makeBoxTextPlan({ body: body([user("initial")]),
      upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
      maxOutputTokensLimit: 128_000, nativePersistence: false,
      runNonce: "a".repeat(24) }));
  assert.equal(nonPersistent.run.environment.DISABLE_AUTO_COMPACT, undefined);
  const virtualMcp = readFileSync(new URL("../../../../../scripts/ocv5-289/box_virtual_mcp.py", import.meta.url));
  const toolOn = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () =>
    makeBoxToolPlan({
      body: { ...body([user("initial")]), tools: [{ name: "take_pending", description: "t", input_schema: { type: "object", properties: {} } }] },
      upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
      virtualMcpAsset: virtualMcp, maxOutputTokensLimit: 128_000, nativePersistence: true,
      runNonce: "1".repeat(24),
    }));
  assert.equal(toolOn.run.environment.DISABLE_AUTO_COMPACT, "0");
  const toolOff = makeBoxToolPlan({
    body: { ...body([user("initial")]), tools: [{ name: "take_pending", description: "t", input_schema: { type: "object", properties: {} } }] },
    upstreamModel: "claude-opus-5", supervisorAsset: supervisor, keeperAsset: keeper,
    virtualMcpAsset: virtualMcp, maxOutputTokensLimit: 128_000, nativePersistence: true,
    runNonce: "2".repeat(24),
  });
  assert.equal(toolOff.run.environment.DISABLE_AUTO_COMPACT, "1");
  const resumed = makeBoxTextPlan({ body: history, upstreamModel: "claude-opus-5",
    supervisorAsset: supervisor, keeperAsset: keeper, maxOutputTokensLimit: 128_000,
    nativeResume: { cliCwd, sessionId, expectedSha256: "e".repeat(64) },
    runNonce: "c".repeat(24) });
  assert.equal(resumed.cliCwd, cliCwd);
  assert.equal(resumed.run.cwd, cliCwd);
  assert.equal(resumed.sessionId, sessionId);
  assert.equal(resumed.snapshotHash, null);
  assert.ok(resumed.run.args.includes("--resume"));
  assert.ok(!resumed.run.args.includes("--no-session-persistence"));
  assert.equal(resumed.run.environment.DISABLE_AUTO_COMPACT, "1");
  assert.ok(resumed.nativePreflight?.args.includes("e".repeat(64)));
  assert.equal(fresh.cleanup.args[5], "keep");
  assert.equal(fresh.discardNativeCleanup?.args[5], "full");
  assert.equal(resumed.stageInputs.some((step) => step.args[5]?.includes("/.claude/projects/")), false);
  assert.equal(resumed.cleanup.args[4], "");
  assert.throws(() => makeBoxTextPlan({ body: history, upstreamModel: "claude-opus-5",
    supervisorAsset: supervisor, keeperAsset: keeper, maxOutputTokensLimit: 128_000,
    nativeResume: { cliCwd: "/tmp/../other", sessionId,
      expectedSha256: "e".repeat(64) } }),
  (error: unknown) => error instanceof BoxTextPlanError && error.code === "BOX_NATIVE_SESSION_INVALID");
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

test("OCV5-384: a fresh native session gets an owner-0700 project directory before launch", () => {
  const input = { body: body([user("first")]), upstreamModel: "claude-opus-5", supervisorAsset: supervisor,
    keeperAsset: keeper, maxOutputTokensLimit: 128_000, runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32) };
  const project = `/home/box/.claude/projects/-tmp-ocv5-289-run-${"c".repeat(24)}`;
  const fresh = makeBoxTextPlan({ ...input, nativePersistence: true });
  assert.equal(fresh.snapshotHash, null);
  assert.equal(fresh.stageInputs[0]?.args[4], project, "INIT creates the project directory");
  assert.equal(fresh.cleanup.args[4], "", "cleanup never receives the transcript's directory");
  assert.equal(fresh.discardNativeCleanup?.args[4], "", "a discard never removes it either");
  const plain = makeBoxTextPlan(input);
  assert.equal(plain.stageInputs[0]?.args[4], "", "without native persistence nothing changes");
});
