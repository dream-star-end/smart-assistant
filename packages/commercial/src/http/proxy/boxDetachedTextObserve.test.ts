import test from "node:test";
import assert from "node:assert/strict";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { observeBoxDetachedText } from "./boxDetachedTextObserve.js";

const model = "claude-opus-5-5";
const runNonce = "a".repeat(24), leaseEpoch = "b".repeat(32);
const event = (value: unknown) => ({ type: "stream_event", event: value });
const records = [
  { type: "system", subtype: "init", tools: [], mcp_servers: [] },
  event({ type: "message_start", message: { id: "msg_synthetic", model,
    role: "assistant", content: [], usage: { input_tokens: 2,
      output_tokens: 0, cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3 } } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "synthetic answer" } }),
  { type: "assistant", message: { id: "msg_synthetic", model,
    role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 2, output_tokens: 4,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 2, output_tokens: 4,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } },
];
const complete = Buffer.from(records.map((x) => JSON.stringify(x) + "\n").join(""));
const access = makeBoxDetachedRunAccess({ runNonce,
  detachedRunnerHash: "c".repeat(64) });

function target(raw: Buffer, reason: "worker_complete" | "worker_failed") {
  const requests: string[] = [];
  const exec = { run: async (req: { args: string[] }) => {
    if (req.args[5] === "--read") {
      requests.push("read");
      const offset = Number(req.args[7]);
      const bytes = raw.subarray(offset);
      return { stdout: JSON.stringify({ data: bytes.toString("base64"),
        offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
    }
    if (req.args[2]?.includes("terminal.json")) {
      requests.push("proof");
      return { stdout: JSON.stringify({ runNonce, leaseEpoch,
        keeperPid: 101, cliPid: 102, reason,
        revision: reason === "worker_complete" ? 1 : 2,
        ...(reason === "worker_failed" ? { workerExitCode: 1 } : {}) }) + "\n",
      stderrBytes: 0, exitCode: 0 };
    }
    throw new Error("paid launch or unrelated Box request");
  } };
  return { value: { accountId: 20n, exec: exec as never }, requests };
}

test("detached text emits partial SSE but withholds terminal until proof and exact EOF", async () => {
  const remote = target(complete, "worker_complete");
  const emitted: string[] = [];
  const result = await observeBoxDetachedText({ target: remote.value,
    access, expectedModel: model, runNonce, leaseEpoch, deadlineMs: 1000,
    emit: (sse) => emitted.push(sse) });
  assert.ok(emitted.join("").includes("synthetic answer"));
  assert.ok(!emitted.join("").includes("event: message_stop"));
  assert.ok(!emitted.join("").includes("event: message_delta"));
  assert.ok(result.tailSse.includes("event: message_stop"));
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 4,
    cacheReadTokens: 20, cacheWriteTokens: 3 });
  assert.equal((result.message as { id: string }).id, "msg_synthetic");
  assert.deepEqual(remote.requests.slice(-2), ["proof", "read"]);
});

test("non-success terminal or trailing byte cannot settle text", async () => {
  for (const [raw, reason, code] of [
    [complete, "worker_failed", "BOX_TEXT_TERMINAL_FAILED"],
    [Buffer.concat([complete, Buffer.from("late\n")]),
      "worker_complete", "BOX_TEXT_FINAL_TRAILING_BYTES"],
  ] as const) {
    const remote = target(raw, reason);
    await assert.rejects(() => observeBoxDetachedText({ target: remote.value,
      access, expectedModel: model, runNonce, leaseEpoch, deadlineMs: 1000 }),
    (error: unknown) => error instanceof Error && error.message === code);
  }
});
