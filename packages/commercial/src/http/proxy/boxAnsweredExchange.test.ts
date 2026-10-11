// OCV5-322 live #7da201bd/#2a81a2fe: a Box turn failed (09:00) after its tool
// results were sent but before the model read them. Claude Code drops its own
// "API Error" rows, so every later prompt — the recovery "继续…" included — was
// merged into that tool-result message (tail "user:tool_result+text+text…").
// The egress rejected each as BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION, and
// each failure added one more text block: the session could never continue.
// OCV5-377 (commercial uid 1870 10-08, uid 4 10-11): five parallel image Reads,
// five results and one Claude Code text block no fold recognized → 409. Any
// text/image after paired results, or a trailing system hint, now runs fresh;
// a handoff still waiting for those results is stopped first.
import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolFetch } from "./boxToolFetch.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import { classifyBoxContinuation, prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { BoxMessagesShapeError, compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { validateBoxToolRequest } from "./boxRequestGate.js";
import type { ProxyBody } from "./shared.js";

const tools = [{ name: "Bash", description: "bash", input_schema: { type: "object", properties: {} } }];
const uses = [{ type: "tool_use", id: "toolu_A", name: "Bash", input: { command: "ls" } },
  { type: "tool_use", id: "toolu_B", name: "Bash", input: { command: "pwd" } }];
const results = [{ type: "tool_result", tool_use_id: "toolu_A", content: "a" },
  { type: "tool_result", tool_use_id: "toolu_B", content: "/w" }];
const resume = "继续完成刚才因临时异常中断的任务。";
const bodyWith = (last: unknown[]): ProxyBody => ({ model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, tools,
  metadata: { user_id: JSON.stringify({ session_id: "sess-answered", oc_turn_key: "ef".repeat(32) }) },
  messages: [{ role: "user", content: "fix it" },
    { role: "assistant", content: [{ type: "text", text: "checking" }, ...uses] },
    { role: "user", content: last }] }) as ProxyBody;
// The real shape: results, then the merged recovery prompts.
const merged = bodyWith([...results, { type: "text", text: "上一条消息因上游瞬时错误中断，请继续完成该任务。" },
  { type: "text", text: resume }]);
const cwd = "/tmp/ocv5-289-run-" + "a".repeat(24);
// A real 1x1 PNG: the mapper accepts only strictly valid images in results.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("an answered exchange followed by a prompt is fresh, never a live continuation", () => {
  const classified = classifyBoxContinuation(merged);
  assert.equal(classified.classification, "fresh");
  assert.deepEqual(classified.answeredToolIds, ["toolu_A", "toolu_B"]);
  const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: merged.model, rawBody: merged,
    authorityKind: "local_catalog", authorityTurnId: null });
  assert.deepEqual(prepared.answeredToolIds, ["toolu_A", "toolu_B"]);
  assert.equal(validateBoxToolRequest(merged, prepared), null);
  // a real prompt may carry Claude Code's own reminder beside it
  const reminded = classifyBoxContinuation(bodyWith([...results,
    { type: "text", text: "<system-reminder>\nTodo list changed\n</system-reminder>" },
    { type: "text", text: resume }]));
  assert.deepEqual(reminded.answeredToolIds, ["toolu_A", "toolu_B"]);
  // a pure tool-result message stays a live continuation candidate
  const pure = classifyBoxContinuation(bodyWith(results));
  assert.equal(pure.classification, "continuation_candidate");
  assert.equal(pure.answeredToolIds, undefined);
});

test("any text, image or system hint after paired results runs fresh, never 409", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  for (const last of [
    [...results, image],
    [...results, { type: "text", text: resume }, image],
    // only text Claude Code injects itself (an unfolded caption / hook)
    [...results, { type: "text", text: "[Image: original 10x10, displayed at 10x10.X]" },
      { type: "text", text: "<system-reminder>\nhook\n</system-reminder>" }],
    [...results, { type: "text", text: "<system-reminder>\n<total_tokens>999 tokens left</total_tokens>\n</system-reminder> go" }],
  ]) {
    const classified = classifyBoxContinuation(bodyWith(last));
    assert.equal(classified.classification, "fresh", JSON.stringify(last).slice(0, 120));
    assert.deepEqual(classified.answeredToolIds, ["toolu_A", "toolu_B"]);
  }
  const hinted = { ...bodyWith(results), messages: [...bodyWith(results).messages,
    { role: "system", content: "an unrecognized Claude Code hint" }] } as ProxyBody;
  assert.deepEqual(classifyBoxContinuation(hinted).answeredToolIds, ["toolu_A", "toolu_B"]);
});

test("a malformed exchange keeps the rejection", () => {
  for (const last of [
    [{ type: "text", text: resume }, ...results],
    [results[0], { type: "text", text: resume }, results[1]],
    [...results, { type: "text", text: "  " }],
    [results[0], { type: "text", text: resume }],
    [results[0], results[0], { type: "text", text: resume }],
  ]) {
    const classified = classifyBoxContinuation(bodyWith(last));
    assert.equal(classified.classification, "reject", JSON.stringify(last).slice(0, 120));
    assert.equal(classified.rejectCode, "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  }
});

test("the fresh run stages the exchange as history and sends only the prompt", () => {
  const { tools: _t, stream: _s, ...textBody } = merged;
  assert.throws(() => compileBoxCliSyntheticTurn(textBody as ProxyBody, { cwd, cliVersion: "2.1.280" }),
    (error: unknown) => error instanceof BoxMessagesShapeError
      && error.code === "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  const turn = compileBoxCliSyntheticTurn(textBody as ProxyBody,
    { cwd, cliVersion: "2.1.280", resumeToolResults: true });
  const records = turn.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => r.type), ["user", "assistant", "user"]);
  assert.deepEqual(records[2].message.content, results);
  assert.equal(records[1].message.stop_reason, "tool_use");
  const stdin = JSON.parse(turn.stdinJsonl);
  assert.deepEqual(stdin.message.content.map((block: { text: string }) => block.text),
    ["上一条消息因上游瞬时错误中断，请继续完成该任务。", resume]);
  // OCV5-377: a trailing image joins the last result; only text is the prompt
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } };
  const { tools: _t2, stream: _s2, ...imageBody } = bodyWith([...results,
    { type: "text", text: "[Image: original 2x2, displayed at 1x1.]" }, image]);
  const imaged = compileBoxCliSyntheticTurn(imageBody as ProxyBody,
    { cwd, cliVersion: "2.1.280", resumeToolResults: true });
  const staged = imaged.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(staged[2].message.content, [results[0],
    { ...results[1], content: [{ type: "text", text: "/w" }, image] }]);
  assert.deepEqual(JSON.parse(imaged.stdinJsonl).message.content,
    [{ type: "text", text: "[Image: original 2x2, displayed at 1x1.]" }]);
});

const orphan = { requestId: "box-orphan", uid: 3n, accountId: 20n, runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) };
const call = { uid: 3n, sessionId: "sess-answered", requestId: "box-answered", canonicalModel: merged.model,
  canonicalBody: merged, upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
  init: { method: "POST", body: JSON.stringify({ ...merged, model: "claude-opus-5-5" }) } };

const live = { requestId: "box-live", uid: 3n, accountId: 20n, runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32) };

function service(opts: { waiting?: unknown; orphan?: unknown; stop?: string }) {
  const calls: string[] = [];
  let firstInput: { resumeToolResults?: boolean } | null = null;
  const journal = { claimRemoteCleanup: async () => true, remoteCleanupStatus: async () => "pending",
    remoteCleanupDoneByRunIdentity: async () => false, prelaunchCleanupDoneByRunIdentity: async () => false,
    markRemoteCleaned: async () => {}, listRemoteCleanupCandidates: async () => [],
    findWaitingToolHandoff: async (input: { toolIds: readonly string[]; turnKey: string }) => {
      calls.push(`waiting:${input.toolIds.join(",")}:${input.turnKey.slice(0, 4)}`);
      return opts.waiting ?? { kind: "none" }; },
    findOrphanToolHandoff: async (input: { toolIds: readonly string[] }) => {
      calls.push(`find:${input.toolIds.join(",")}`); return opts.orphan ?? { kind: "none" }; },
    claimOrphanRecovery: async (input: { requestId: string }) => {
      calls.push(`claim-orphan:${input.requestId}`); return true; },
    releaseOrphanRecovery: async (input: { requestId: string }) => { calls.push(`release:${input.requestId}`); } };
  const svc = new BoxToolFetch({ supervisorAsset: Buffer.from("s"), keeperAsset: Buffer.from("k"),
    virtualMcpAsset: Buffer.from("m"), detachedRunnerAsset: Buffer.from("d"), journal: journal as never,
    maxOutputTokensForModel: () => 128_000, resolveTarget: async () => ({ accountId: 20n }) as never,
    onUnknown: async () => {},
    publishResume: (async () => { calls.push("publish"); throw new Error("never"); }) as never,
    stopOrphanRun: async (identity) => { calls.push(`stop:${identity.requestId}`);
      return (opts.stop ?? "stopped_proven") as never; },
    runFirst: (async (input: { emit: (sse: string) => void; resumeToolResults?: boolean; onLaunchAck?: () => void }) => {
      calls.push("first"); firstInput = input; input.onLaunchAck?.();
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32) },
        target: { accountId: 20n }, proof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
          keeperPid: 1, cliPid: 2, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  return { svc, calls, firstInput: () => firstInput };
}

test("with no waiting handoff the prompt runs fresh over the staged exchange", async () => {
  const s = service({});
  const response = await s.svc.fetch(call);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.deepEqual(s.calls, ["waiting:toolu_A,toolu_B:efef", "find:toolu_A,toolu_B", "first"]);
  assert.equal(s.firstInput()?.resumeToolResults, true);
});

test("an orphaned earlier handoff is claimed and stopped before the fresh run", async () => {
  const s = service({ orphan: { kind: "orphan", stopped: false, identity: orphan } });
  assert.equal((await s.svc.fetch(call)).status, 200);
  assert.deepEqual(s.calls, ["waiting:toolu_A,toolu_B:efef", "find:toolu_A,toolu_B",
    "claim-orphan:box-orphan", "stop:box-orphan", "first"]);
});

test("a handoff of this turn still waiting is claimed and stopped, then the prompt runs fresh", async () => {
  const s = service({ waiting: { kind: "waiting", identity: live } });
  assert.equal((await s.svc.fetch(call)).status, 200);
  assert.deepEqual(s.calls, ["waiting:toolu_A,toolu_B:efef", "claim-orphan:box-live", "stop:box-live",
    "find:toolu_A,toolu_B", "first"]);
  assert.equal(s.firstInput()?.resumeToolResults, true);
});

test("a handoff that cannot be taken over or proven stopped keeps the 409", async () => {
  for (const opts of [{ waiting: { kind: "live" } }, { orphan: { kind: "live" } },
    { waiting: { kind: "waiting", identity: live }, stop: "pending" },
    { orphan: { kind: "orphan", stopped: false, identity: orphan }, stop: "pending" }]) {
    const s = service(opts);
    await assert.rejects(async () => { const r = await s.svc.fetch(call); await r.text(); },
      /BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION/);
    assert.ok(!s.calls.includes("first") && !s.calls.includes("publish"), s.calls.join(" "));
    if (opts.stop === "pending") assert.ok(s.calls.some((c) => c.startsWith("release:")), s.calls.join(" "));
  }
});
