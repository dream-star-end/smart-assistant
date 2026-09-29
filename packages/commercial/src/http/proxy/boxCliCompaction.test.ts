import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BoxCliCompaction, BoxCliCompactionError, MAX_PRESERVED_UUIDS,
  MAX_SUMMARY_UTF8_BYTES } from "./boxCliCompaction.js";
import { BoxCliSseError, createBoxCliSseDecoder } from "./boxCliSse.js";
import { observeBoxDetachedText } from "./boxDetachedTextObserve.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { observeBoxToolUnknown } from "./boxToolUnknownObserver.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import type { BoxReplayIdentity } from "./boxDurableJournal.js";
import type { ProxyBody } from "./shared.js";
import { BoxToolResultEcho, BoxToolResultEchoError } from "./boxToolResultEcho.js";

const session = "e37f0afa-e659-40ba-84e4-fa90bf465945";
const capture = readFileSync(new URL("./ocv5-296-classic-2.stdout.jsonl", import.meta.url), "utf8");
const captureSha = "6e62db2a7f79ac8a52d0cae5722b03b74ca3262acb7af38f5b719e28ed0796c7";

test("trusted classic-2 boundary and synthetic summary are not billed as the message", () => {
  assert.equal(createHash("sha256").update(capture).digest("hex"), captureSha);
  const decoder = createBoxCliSseDecoder("claude-opus-5-5", session);
  decoder.push(capture);
  const finished = decoder.finish();
  assert.equal(finished.inputTokens, 222);
  assert.equal(finished.outputTokens, 5);
  assert.equal(finished.sse.includes("This session is being continued"), false);
  const lines = capture.split("\n").filter(Boolean);
  const summary = JSON.parse(lines[5] ?? "");
  const echo = new BoxToolResultEcho([{ modelToolUseId: "toolu_01OCV5296SYNTH",
    contentHash: "a".repeat(64), isError: false }]);
  assert.throws(() => echo.accept(summary),
    (error: unknown) => error instanceof BoxToolResultEchoError
      && error.code === "BOX_TOOL_ECHO_ID_INVALID");
});

test("wrong session, broken anchor, and a second boundary are rejected", () => {
  assert.throws(() => createBoxCliSseDecoder("claude-opus-5-5",
    "11111111-1111-4111-8111-111111111111").push(capture),
    (error: unknown) => error instanceof BoxCliSseError
      && error.code === "BOX_CLI_COMPACT_BOUNDARY_INVALID");
  const lines = capture.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    compact_metadata?: { preserved_segment?: { anchor_uuid?: string } };
    uuid?: string;
  });
  const boundary = lines[4];
  const summary = lines[5];
  if (boundary?.compact_metadata?.preserved_segment) {
    boundary.compact_metadata.preserved_segment.anchor_uuid = "22222222-2222-4222-8222-222222222222";
  }
  const reader = new BoxCliCompaction(session);
  assert.throws(() => reader.take(boundary, "pre-model"),
    (error: unknown) => error instanceof BoxCliCompactionError
      && error.code === "BOX_CLI_COMPACT_BOUNDARY_INVALID");
  const again = new BoxCliCompaction(session);
  again.take(JSON.parse(capture.split("\n")[4] ?? ""), "pre-model");
  again.take(summary, "pre-model");
  assert.throws(() => again.take(JSON.parse(capture.split("\n")[4] ?? ""), "pre-model"),
    (error: unknown) => error instanceof BoxCliCompactionError
      && error.code === "BOX_CLI_COMPACT_DUPLICATE");
});

function boundaryFor(anchor: string, uuids: string[]): Record<string, unknown> {
  return { type: "system", subtype: "compact_boundary",
    uuid: "adc44006-42e8-4ee0-92c6-6e9fc1412da8", session_id: session,
    logical_parent_uuid: uuids[uuids.length - 1],
    compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 1,
      cumulative_dropped_tokens: 1, duration_ms: 1,
      preserved_segment: { head_uuid: uuids[0], anchor_uuid: anchor, tail_uuid: uuids[uuids.length - 1] },
      preserved_messages: { anchor_uuid: anchor, uuids, all_uuids: uuids } } };
}
function summaryFor(anchor: string, text: string): Record<string, unknown> {
  return { type: "user", isSynthetic: true, parent_tool_use_id: null, session_id: session,
    uuid: anchor, timestamp: "2026-09-29T13:35:53.708Z",
    message: { role: "user", content: [{ type: "text", text }] } };
}
const billed = (text: string) => {
  const model = "claude-opus-5-5";
  return [
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_bill", type: "message",
      role: "assistant", model, content: [], usage: { input_tokens: 222, output_tokens: 0 } } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 } } },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "assistant", message: { id: "msg_bill", model, role: "assistant",
      content: [{ type: "text", text }] } },
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 222, output_tokens: 5 } },
  ];
};

test("a long UTF-8 summary and a 16-uuid tail fit; oversize summary and tail do not", () => {
  const anchor = "991406f8-0097-4e91-a2f1-b732812e36fe";
  const tail = Array.from({ length: 16 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  tail[0] = "86b0b5b4-2fc6-40a3-a33c-3185d1655975";
  tail[15] = "1216440c-7345-45a9-ba11-8262fd3450c3";
  const text = "测".repeat(20_000);
  assert.ok(Buffer.byteLength(text, "utf8") > 8192);
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_SUMMARY_UTF8_BYTES);
  const decoder = createBoxCliSseDecoder("claude-opus-5-5", session);
  decoder.push([
    { type: "system", subtype: "init", tools: [], mcp_servers: [] },
    boundaryFor(anchor, tail), summaryFor(anchor, text), ...billed("ready"),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const finished = decoder.finish();
  assert.equal(finished.inputTokens, 222);
  assert.equal(finished.sse.includes(text), false);
  const huge = "测".repeat(Math.ceil((MAX_SUMMARY_UTF8_BYTES + 3) / 3));
  const oversized = new BoxCliCompaction(session);
  oversized.take(boundaryFor(anchor, tail), "pre-model");
  assert.throws(() => oversized.take(summaryFor(anchor, huge), "pre-model"),
    (error: unknown) => error instanceof BoxCliCompactionError
      && error.code === "BOX_CLI_COMPACT_SUMMARY_INVALID");
  const tooMany = Array.from({ length: MAX_PRESERVED_UUIDS + 1 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.throws(() => new BoxCliCompaction(session).take(boundaryFor(anchor, tooMany), "pre-model"),
    (error: unknown) => error instanceof BoxCliCompactionError
      && error.code === "BOX_CLI_COMPACT_BOUNDARY_INVALID");
});

test("compact inside an open model message is rejected by the live text and tool observers", async () => {
  const anchor = "991406f8-0097-4e91-a2f1-b732812e36fe";
  const pair = [boundaryFor(anchor, ["86b0b5b4-2fc6-40a3-a33c-3185d1655975",
    "1216440c-7345-45a9-ba11-8262fd3450c3"]), summaryFor(anchor, "kept")];
  const model = "claude-opus-5-5";
  const init = { type: "system", subtype: "init", tools: [], mcp_servers: [] };
  const start = { type: "stream_event", event: { type: "message_start", message: { id: "msg_bill",
    type: "message", role: "assistant", model, content: [], usage: { input_tokens: 222, output_tokens: 0 } } } };
  const decoder = createBoxCliSseDecoder(model, session);
  assert.throws(() => decoder.push([init, start, ...pair].map((row) => JSON.stringify(row)).join("\n") + "\n"),
    (error: unknown) => error instanceof BoxCliSseError && error.code === "BOX_CLI_COMPACT_PHASE");

  const good = Buffer.from([init, ...pair, ...billed("ready")].map((row) => JSON.stringify(row) + "\n").join(""));
  const bad = Buffer.from([init, start, ...pair].map((row) => JSON.stringify(row) + "\n").join(""));
  const runNonce = "a".repeat(24), leaseEpoch = "b".repeat(32);
  const access = makeBoxDetachedRunAccess({ runNonce, detachedRunnerHash: "c".repeat(64) });
  const remote = (raw: Buffer) => ({ accountId: 20n, exec: { run: async (req: { args: string[] }) => {
    if (req.args[5] === "--read") {
      const offset = Number(req.args[7]);
      const bytes = raw.subarray(offset);
      return { stdout: JSON.stringify({ data: bytes.toString("base64"), offset: offset + bytes.length }),
        stderrBytes: 0, exitCode: 0 };
    }
    if (req.args[2]?.includes("terminal.json")) {
      return { stdout: JSON.stringify({ runNonce, leaseEpoch, keeperPid: 1, cliPid: 2,
        reason: "worker_complete", revision: 1 }) + "\n", stderrBytes: 0, exitCode: 0 };
    }
    throw new Error("unexpected");
  } } });
  const live = await observeBoxDetachedText({ target: remote(good) as never, access, expectedModel: model,
    trustedNativeSessionId: session, runNonce, leaseEpoch, deadlineMs: 1000 });
  assert.equal(live.usage.inputTokens, 222);
  assert.equal(JSON.stringify(live.message).includes("kept"), false);
  await assert.rejects(() => observeBoxDetachedText({ target: remote(bad) as never, access,
    expectedModel: model, trustedNativeSessionId: session, runNonce, leaseEpoch, deadlineMs: 1000 }),
    (error: unknown) => error instanceof Error && error.message === "BOX_CLI_COMPACT_PHASE");
});

test("unknown tool observer bills the post-compact tool message, not the summary", async () => {
  const anchor = "991406f8-0097-4e91-a2f1-b732812e36fe";
  const pair = [boundaryFor(anchor, ["86b0b5b4-2fc6-40a3-a33c-3185d1655975",
    "1216440c-7345-45a9-ba11-8262fd3450c3"]), summaryFor(anchor, "kept")];
  const model = "claude-opus-5-5";
  const use = { type: "tool_use", id: "toolu_synthetic_a", name: "mcp__ocbridge__t0", input: { value: "x" } };
  const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
    messages: [{ role: "user", content: "synthetic" }],
    tools: [{ name: "local_echo", description: "synthetic",
      input_schema: { type: "object", properties: { value: { type: "string" } } } }],
    metadata: { user_id: JSON.stringify({ session_id: "session-synthetic", oc_turn_key: "a".repeat(64) }) } };
  const identity: BoxReplayIdentity = { requestId: "synthetic-request", rootRequestId: "synthetic-request",
    uid: 3n, accountId: 20n, runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
    invocationMode: "detached_tool", state: "unknown", roundNo: 1, spoolOffset: 0,
    rootLaunchPermit: true, detachedRunnerHash: "c".repeat(64),
    catalogHash: compileBoxToolCatalog(body.tools).bindingSha256, nativeSessionId: session };
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const tool = [
    { type: "system", subtype: "init", tools: [use.name], mcp_servers: [{}] },
    ...pair,
    event({ type: "message_start", message: { id: "msg_synthetic", model, role: "assistant", content: [],
      usage: { input_tokens: 50, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: use.id,
      name: use.name, input: {} } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta",
      partial_json: '{"value":"x"}' } }),
    { type: "assistant", message: { id: "msg_synthetic", model, role: "assistant", content: [use] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 50, output_tokens: 4 } }),
    event({ type: "message_stop" }),
  ];
  const raw = Buffer.from(tool.map((row) => JSON.stringify(row) + "\n").join(""));
  const exec = { run: async (request: { args: string[] }) => {
    if (request.args[5] === "--read") {
      const offset = Number(request.args[7]);
      const bytes = raw.subarray(offset);
      return { stdout: JSON.stringify({ data: bytes.toString("base64"), offset: offset + bytes.length }),
        stderrBytes: 0, exitCode: 0 };
    }
    if (request.args[2]?.includes("pending.")) {
      return { stdout: JSON.stringify({ version: 1, modelToolUseId: use.id, mcpRequestId: 7,
        name: "t0", arguments: { value: "x" } }), stderrBytes: 0, exitCode: 0 };
    }
    throw new Error("unexpected");
  } };
  let usage: { inputTokens: number } | undefined;
  const outcome = await observeBoxToolUnknown({ identity, canonicalBody: body, upstreamModel: model }, {
    resolveTarget: async () => ({ accountId: 20n, exec, dispose: () => undefined }) as never,
    writeMessage: async (id) => ({ version: 1, ...id, bytes: 1, sha256: "d".repeat(64) }),
    journal: { recordToolHandoff: async (value: { candidate: { inputTokens: number } }) => {
      usage = value.candidate;
      return { durableRevision: "synthetic", journaledToolUseIds: [use.id], verifiedPendingToolUseIds: [use.id] };
    } } as never,
  });
  assert.equal(outcome, "committed");
  assert.equal(usage?.inputTokens, 50);
});

test("an unbound compact boundary is not silently ignored", () => {
  const boundary = capture.split("\n").filter(Boolean)[4];
  assert.throws(() => createBoxCliSseDecoder("claude-opus-5-5").push(`${boundary}\n`),
    (error: unknown) => error instanceof BoxCliSseError
      && error.code === "BOX_CLI_COMPACT_UNBOUND");
});
