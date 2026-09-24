import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { makeBoxPendingRead, makeBoxToolResultPlan,
  parseBoxPendingCall } from "./boxToolResultPlan.js";
import type { BoxToolUse } from "./boxCliToolHandoff.js";
import type { ProxyBody } from "./shared.js";

const use: BoxToolUse = { id: "toolu_same_A", boxName: "mcp__ocbridge__t0",
  clientName: "local_echo", input: { value: "ping" } };
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: use.id,
      name: use.clientName, input: use.input }] },
    { role: "user", content: [{ type: "tool_result",
      tool_use_id: use.id, content: "local-result" }] },
  ] };
const pending = { version: 1 as const, modelToolUseId: use.id,
  mcpRequestId: 77, name: "t0", arguments: use.input };

test("one owner-scoped pending file produces one atomic sidecar result", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  mkdirSync(cwd, { mode: 0o700 });
  const exec = (request: ReturnType<typeof makeBoxPendingRead>) => spawnSync(
    request.command, request.args, { cwd: request.cwd,
      env: { ...process.env, ...request.environment }, encoding: "utf8", timeout: 5000 });
  try {
    writeFileSync(`${cwd}/pending.${use.id}.json`, JSON.stringify(pending), { mode: 0o600 });
    const read = exec(makeBoxPendingRead(cwd, use.id));
    assert.equal(read.status, 0, read.stderr);
    const parsed = parseBoxPendingCall(read.stdout, use);
    const matched = matchBoxToolResults(body, [use])[0]!;
    const plan = makeBoxToolResultPlan({ cwd, expected: use, pending: parsed, matched });
    assert.ok(plan.requests.length > 0);
    assert.ok(plan.requests.every((request) => !request.args[1]?.includes("os.mkdir(cwd")),
      "result publication must not re-create the live run directory");
    for (const step of plan.requests) {
      const r = exec(step);
      assert.equal(r.status, 0, r.stderr);
    }
    const result = JSON.parse(readFileSync(plan.path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(result, { version: 1, modelToolUseId: use.id, mcpRequestId: 77,
      content: [{ type: "text", text: "local-result" }], isError: false });
    // A duplicate publication can stage a fresh .part, but hard-link FINISH
    // must fail, preserving the first result and forbidding a second delivery.
    const duplicate = plan.requests.map(exec);
    assert.notEqual(duplicate.at(-1)?.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(plan.path, "utf8")), result);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("pending identity and mutated local result cannot publish", () => {
  assert.throws(() => parseBoxPendingCall(JSON.stringify({ ...pending,
    modelToolUseId: "toolu_other" }), use), /BOX_PENDING_INVALID/);
  assert.throws(() => parseBoxPendingCall(JSON.stringify({ ...pending,
    name: "t1" }), use), /BOX_PENDING_INVALID/);
  const matched = matchBoxToolResults(body, [use])[0]!;
  const altered = { ...matched, content: [{ type: "text" as const,
    text: "changed after validation" }] };
  assert.throws(() => makeBoxToolResultPlan({
    cwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
    expected: use, pending, matched: altered }), /BOX_RESULT_CONTENT_CHANGED/);
});
