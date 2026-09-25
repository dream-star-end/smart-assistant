import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { makeBoxPendingRead, makeBoxToolResultPlan,
  parseBoxPendingCall } from "./boxToolResultPlan.js";
import { makeBoxStageFiles } from "./boxStageFiles.js";
import type { BoxToolUse } from "./boxCliToolHandoff.js";
import type { ProxyBody } from "./shared.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";

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

test("a 1.1 MB tool result survives actual multi-chunk private publication", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  mkdirSync(cwd, { mode: 0o700 });
  try {
    const text = "x".repeat(1_100_000);
    const largeBody: ProxyBody = { ...body, messages: [body.messages[0]!,
      { role: "user", content: [{ type: "tool_result",
        tool_use_id: use.id, content: text }] }] };
    const matched = matchBoxToolResults(largeBody, [use])[0]!;
    const plan = makeBoxToolResultPlan({ cwd, expected: use, pending, matched });
    assert.ok(plan.requests.length > 2, "result exceeds one staged chunk");
    for (const request of plan.requests) {
      const staged = spawnSync(request.command, request.args, { cwd: request.cwd,
        env: { ...process.env, ...request.environment },
        encoding: "utf8", timeout: 5000 });
      assert.equal(staged.status, 0, staged.stderr);
    }
    const result = JSON.parse(readFileSync(plan.path, "utf8")) as {
      content: Array<{ text: string }> };
    assert.equal(result.content[0]?.text, text);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("pending identity and mutated local result cannot publish", () => {
  assert.throws(() => parseBoxPendingCall(JSON.stringify({ ...pending,
    modelToolUseId: "toolu_other" }), use), /BOX_PENDING_INVALID/);
  assert.throws(() => parseBoxPendingCall(JSON.stringify({ ...pending,
    name: "t1" }), use), /BOX_PENDING_INVALID/);
  const digest = { id: use.id, boxName: use.boxName,
    clientName: use.clientName, inputHash: hashBoxToolInput(use.input) };
  assert.equal(parseBoxPendingCall(JSON.stringify(pending), digest).modelToolUseId, use.id);
  assert.throws(() => parseBoxPendingCall(JSON.stringify({ ...pending,
    arguments: { value: "different" } }), digest), /BOX_PENDING_INVALID/);
  const matched = matchBoxToolResults(body, [use])[0]!;
  const altered = { ...matched, content: [{ type: "text" as const,
    text: "changed after validation" }] };
  assert.throws(() => makeBoxToolResultPlan({
    cwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
    expected: use, pending, matched: altered }), /BOX_RESULT_CONTENT_CHANGED/);
});

test("replacing the run-directory parent with a symlink cannot redirect WRITE or FINISH", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  const backup = `${cwd}.backup`, decoy = `${cwd}.decoy`;
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(decoy, { mode: 0o700 });
  const matched = matchBoxToolResults(body, [use])[0]!;
  const plan = makeBoxToolResultPlan({ cwd, expected: use, pending, matched });
  const run = (request: typeof plan.requests[number]) => spawnSync(request.command,
    request.args, { cwd: request.cwd, env: { ...process.env, ...request.environment },
      encoding: "utf8", timeout: 5000 });
  try {
    renameSync(cwd, backup);
    symlinkSync(decoy, cwd);
    assert.notEqual(run(plan.requests[0]!).status, 0);
    assert.equal(existsSync(`${decoy}/result.${use.id}.json.part`), false);
    rmSync(cwd);
    renameSync(backup, cwd);
    for (const write of plan.requests.slice(0, -1)) {
      assert.equal(run(write).status, 0);
    }
    const raw = readFileSync(`${cwd}/result.${use.id}.json.part`);
    const cleanup = makeBoxStageFiles({ cwd, project: "", initialize: false,
      files: [{ path: plan.path, raw, hash: plan.resultHash }] }).cleanup;
    renameSync(cwd, backup);
    symlinkSync(decoy, cwd);
    assert.notEqual(run(plan.requests.at(-1)!).status, 0);
    assert.notEqual(run(cleanup).status, 0);
    assert.equal(existsSync(`${decoy}/result.${use.id}.json`), false);
    rmSync(cwd);
    renameSync(backup, cwd);
    assert.equal(run(cleanup).status, 0);
  } finally {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});
