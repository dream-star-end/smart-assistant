import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  prepareRolloutImport,
  type ImportManifest,
} from "../v5-import-crashed-rollout.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(extra: Record<string, unknown>[] = []): {
  raw: Buffer;
  manifest: ImportManifest;
} {
  const sessionId = "sess-import-test";
  const targetTimestamp = "2026-08-06T18:48:23.445Z";
  const records: Record<string, unknown>[] = [
    {
      timestamp: "2026-08-06T18:47:45.290Z",
      type: "session_meta",
      payload: { type: "session_meta", instructions: "must never reach the transcript" },
    },
    {
      timestamp: targetTimestamp,
      type: "event_msg",
      payload: { type: "user_message", message: "build it" },
    },
    {
      timestamp: "2026-08-06T18:48:24.000Z",
      type: "response_item",
      payload: { type: "reasoning", id: "reason-1", summary: [{ type: "summary_text", text: "plan" }] },
    },
    {
      timestamp: "2026-08-06T18:48:24.001Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "plan" },
    },
    {
      timestamp: "2026-08-06T18:48:25.000Z",
      type: "response_item",
      payload: { type: "function_call", id: "message-id", call_id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"echo exact\"}" },
    },
    {
      timestamp: "2026-08-06T18:48:26.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "exact output" },
    },
    {
      timestamp: "2026-08-06T18:48:27.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "required tail" }] },
    },
    ...extra,
  ];
  const raw = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const payloads = [
    JSON.stringify({
      type: "outbound.message",
      sessionKey: `rollout:${sha256(raw)}`,
      channel: "webchat",
      peer: { id: sessionId, kind: "dm" },
      clientMessageId: "cm-import-test",
      blocks: [{ kind: "thinking", text: "plan" }],
      isFinal: false,
      ts: Date.parse("2026-08-06T18:48:24.000Z"),
      durableSource: "rollout_import",
      importOrdinal: 1,
    }),
    JSON.stringify({
      type: "outbound.message",
      sessionKey: `rollout:${sha256(raw)}`,
      channel: "webchat",
      peer: { id: sessionId, kind: "dm" },
      clientMessageId: "cm-import-test",
      blocks: [{ kind: "tool_use", blockId: "call-1", toolName: "exec_command", inputJson: { cmd: "echo exact" }, partial: false }],
      isFinal: false,
      ts: Date.parse("2026-08-06T18:48:25.000Z"),
      durableSource: "rollout_import",
      importOrdinal: 2,
    }),
    JSON.stringify({
      type: "outbound.message",
      sessionKey: `rollout:${sha256(raw)}`,
      channel: "webchat",
      peer: { id: sessionId, kind: "dm" },
      clientMessageId: "cm-import-test",
      blocks: [{ kind: "tool_result", blockId: "result-call-1", toolUseBlockId: "call-1", toolName: "exec_command", isError: false, output: "exact output" }],
      isFinal: false,
      ts: Date.parse("2026-08-06T18:48:26.000Z"),
      durableSource: "rollout_import",
      importOrdinal: 3,
    }),
    JSON.stringify({
      type: "outbound.message",
      sessionKey: `rollout:${sha256(raw)}`,
      channel: "webchat",
      peer: { id: sessionId, kind: "dm" },
      clientMessageId: "cm-import-test",
      blocks: [{ kind: "text", text: "required tail" }],
      isFinal: false,
      ts: Date.parse("2026-08-06T18:48:27.000Z"),
      durableSource: "rollout_import",
      importOrdinal: 4,
    }),
  ];
  return {
    raw,
    manifest: {
      uid: "1",
      sessionId,
      clientMessageId: "cm-import-test",
      dispatchId: "11111111-1111-4111-8111-111111111111",
      attemptNo: 1,
      resumeMapKey: `agent:main:webchat:dm:${sessionId}`,
      threadId: "thread-import-test",
      rolloutPath: "/fixture/rollout.jsonl",
      resumeMapPath: "/fixture/resume-map.json",
      rolloutSha256: sha256(raw),
      rolloutBytes: raw.length,
      firstTimestamp: "2026-08-06T18:47:45.290Z",
      lastTimestamp: String(records.at(-1)!.timestamp),
      targetUserTimestamp: targetTimestamp,
      targetUserMessage: "build it",
      payloadCount: payloads.length,
      payloadSha256: sha256(payloads.join("\n")),
      requiredText: "required tail",
    },
  };
}

describe("v5 crashed rollout importer", () => {
  test("imports only the target turn's canonical response items without duplication or truncation", () => {
    const { raw, manifest } = fixture();
    const prepared = prepareRolloutImport(raw, manifest);
    assert.equal(prepared.payloads.length, 4);
    const blocks = prepared.payloads.map((payload) => JSON.parse(payload).blocks[0]);
    assert.deepEqual(blocks.map((block) => block.kind), ["thinking", "tool_use", "tool_result", "text"]);
    assert.equal(blocks[1].blockId, "call-1");
    assert.equal(blocks[2].toolUseBlockId, "call-1");
    assert.equal(blocks[2].toolName, "exec_command");
    assert.equal(prepared.payloads.join("\n").includes("must never reach the transcript"), false);
    assert.equal(prepared.payloads.filter((payload) => payload.includes("plan")).length, 1);
  });

  test("fails closed on unsupported response items or a later user turn", () => {
    const unsupported = fixture([{
      timestamp: "2026-08-06T18:48:28.000Z",
      type: "response_item",
      payload: { type: "unknown_future_item", text: "required tail" },
    }]);
    assert.throws(
      () => prepareRolloutImport(unsupported.raw, unsupported.manifest),
      /unsupported response_item/,
    );

    const laterTurn = fixture([{
      timestamp: "2026-08-06T18:48:28.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "next turn" },
    }]);
    assert.throws(
      () => prepareRolloutImport(laterTurn.raw, laterTurn.manifest),
      /later user turn/,
    );
  });

  test("fails closed if immutable rollout bytes or translated payloads drift", () => {
    const { raw, manifest } = fixture();
    assert.throws(
      () => prepareRolloutImport(Buffer.concat([raw, Buffer.from(" ")]), manifest),
      /byte mismatch/,
    );
    assert.throws(
      () => prepareRolloutImport(raw, { ...manifest, payloadSha256: "0".repeat(64) }),
      /translated payload sha256 mismatch/,
    );
  });
});
