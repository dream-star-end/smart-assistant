import test from "node:test";
import assert from "node:assert/strict";
import type { BoxReplayIdentity } from "./boxDurableJournal.js";
import { observeBoxTextUnknown } from "./boxTextUnknownObserver.js";

const model = "claude-opus-5-5";
const identity: BoxReplayIdentity = { requestId: "text-old-http",
  rootRequestId: "text-old-http", uid: 3n, accountId: 20n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
  invocationMode: "text", state: "unknown", roundNo: 1,
  spoolOffset: 0, rootLaunchPermit: true,
  detachedRunnerHash: "c".repeat(64), upstreamModel: model };
const event = (value: unknown) => ({ type: "stream_event", event: value });
const records = [
  { type: "system", subtype: "init", tools: [], mcp_servers: [] },
  event({ type: "message_start", message: { id: "msg_text_observed", model,
    role: "assistant", content: [], usage: { input_tokens: 2,
      output_tokens: 0 } } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "observed answer" } }),
  { type: "assistant", message: { id: "msg_text_observed", model,
    role: "assistant", content: [{ type: "text", text: "observed answer" }] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 2, output_tokens: 4 } }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 2, output_tokens: 4 } },
];
const raw = Buffer.from(records.map((x) => JSON.stringify(x) + "\n").join(""));

function remote(reason: "worker_complete" | "worker_failed",
  spool = raw) {
  const operations: string[] = [];
  const target = { accountId: 20n, dispose: () => { operations.push("dispose"); },
    exec: { run: async (req: { args: string[] }) => {
      if (req.args[5] === "--read") {
        operations.push("spool-read");
        const offset = Number(req.args[7]);
        const bytes = spool.subarray(offset);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 };
      }
      if (req.args[2]?.includes("terminal.json")) {
        operations.push("proof-read");
        return { stdout: JSON.stringify({ runNonce: identity.runNonce,
          leaseEpoch: identity.leaseEpoch, keeperPid: 101, cliPid: 102,
          reason, revision: reason === "worker_complete" ? 1 : 2,
          ...(reason === "worker_failed" ? { workerExitCode: 1 } : {}) }) + "\n",
        stderrBytes: 0, exitCode: 0 };
      }
      throw new Error("paid launch or unrelated remote operation");
    } } };
  return { target, operations };
}

test("HTTP/bodyless text observer commits original row without new paid call", async () => {
  const observed = remote("worker_complete");
  const journalCalls: string[] = [];
  const result = await observeBoxTextUnknown({ identity }, {
    resolveTarget: async (args) => {
      assert.equal(args.requiredAccountId, 20n);
      assert.equal(args.allowWakeIfHibernated, false);
      assert.equal(args.sessionId, null);
      assert.equal(args.upstreamModel, model);
      return observed.target as never;
    },
    writeMessage: async (id, message) => {
      journalCalls.push("capsule");
      assert.equal((message as { id: string }).id, "msg_text_observed");
      return { version: 1, ...id, bytes: 123, sha256: "d".repeat(64) };
    },
    journal: { complete: async (value: { requestId: string;
      usage: { outputTokens: number } }) => {
      journalCalls.push("complete");
      assert.equal(value.requestId, identity.requestId);
      assert.equal(value.usage.outputTokens, 4);
    } } as never,
  });
  assert.equal(result, "committed");
  assert.deepEqual(journalCalls, ["capsule", "complete"]);
  assert.deepEqual(observed.operations,
    ["spool-read", "proof-read", "spool-read", "dispose"]);
});

test("worker failure records stopped proof without invented usage", async () => {
  const observed = remote("worker_failed");
  let failed = false;
  const result = await observeBoxTextUnknown({ identity }, {
    resolveTarget: async () => observed.target as never,
    writeMessage: async () => { throw new Error("must not write a capsule"); },
    journal: { markFirstRoundStoppedFailure: async (value: {
      proof: { reason: string } }) => {
      assert.equal(value.proof.reason, "worker_failed"); failed = true;
    } } as never,
  });
  assert.equal(result, "failed_stopped");
  assert.equal(failed, true);
});

test("keeper failure without a result line releases only after independent proof", async () => {
  const observed = remote("worker_failed", Buffer.alloc(0));
  let stopped = false;
  const outcome = await observeBoxTextUnknown({ identity }, {
    budgetMs: 1000, resolveTarget: async (args) => {
      const originalRun = observed.target.exec.run;
      observed.target.exec.run = async (req) => {
        if (args.signal.aborted) throw new Error("BOX_EXEC_ACCOUNT_GUARD_FAILED");
        return originalRun(req);
      };
      return observed.target as never;
    },
    writeMessage: async () => { throw new Error("must not invent usage"); },
    journal: { markFirstRoundStoppedFailure: async () => {
      stopped = true;
    } } as never,
  });
  assert.equal(outcome, "failed_stopped");
  assert.equal(stopped, true);
  assert.ok(observed.operations.includes("proof-read"));
});

test("malformed Claude result plus failed keeper proof does not leave active capacity", async () => {
  const bad = Buffer.from(raw.toString().replace('"is_error":false',
    '"is_error":true'));
  const observed = remote("worker_failed", bad);
  let stopped = false;
  const outcome = await observeBoxTextUnknown({ identity }, {
    resolveTarget: async () => observed.target as never,
    writeMessage: async () => { throw new Error("must not invent usage"); },
    journal: { markFirstRoundStoppedFailure: async () => {
      stopped = true;
    } } as never,
  });
  assert.equal(outcome, "failed_stopped");
  assert.equal(stopped, true);
});

test("old or unarmed text does not resolve Box", async () => {
  let resolved = false;
  const result = await observeBoxTextUnknown({ identity: {
    ...identity, rootLaunchPermit: false } }, {
    resolveTarget: async () => { resolved = true; throw new Error("unexpected"); },
    writeMessage: async () => { throw new Error("unexpected"); },
    journal: {} as never,
  });
  assert.equal(result, "pending");
  assert.equal(resolved, false);
});
