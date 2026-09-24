import test from "node:test";
import assert from "node:assert/strict";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { makeBoxDetachedToolPlan } from "./boxDetachedToolPlan.js";
import { readFileSync } from "node:fs";
import type { ProxyBody } from "./shared.js";

const asset = (name: string) => readFileSync(
  new URL(`../../../../../scripts/ocv5-289/${name}`, import.meta.url));
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true,
  messages: [{ role: "user", content: "secret prompt excluded from resume" }],
  tools: [{ name: "local_echo", description: "local tool",
    input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" } };

test("cross-HTTP read plan reconstructs pinned run without original prompt or launch", () => {
  const runNonce = "a".repeat(24);
  const plan = makeBoxDetachedToolPlan({ body, upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 128000, runNonce,
    supervisorAsset: asset("box_supervisor.py"), keeperAsset: asset("box_keeper.py"),
    virtualMcpAsset: asset("box_virtual_mcp.py"),
    detachedRunnerAsset: asset("box_detached_runner.py") });
  const access = makeBoxDetachedRunAccess({ runNonce,
    detachedRunnerHash: plan.detachedRunnerHash });
  assert.deepEqual(access.readSpool(42, 123), plan.readSpool(42, 123));
  assert.ok(!JSON.stringify(access).includes("secret prompt"));
  assert.equal(Object.hasOwn(access, "launch"), false);
});

test("malformed run identity and cursor fail before any Box request", () => {
  assert.throws(() => makeBoxDetachedRunAccess({ runNonce: "../", detachedRunnerHash: "f".repeat(64) }),
    /BOX_DETACHED_RUN_IDENTITY_INVALID/);
  assert.throws(() => makeBoxDetachedRunAccess({ runNonce: "a".repeat(24), detachedRunnerHash: "f".repeat(63) }),
    /BOX_DETACHED_RUN_IDENTITY_INVALID/);
  const access = makeBoxDetachedRunAccess({ runNonce: "a".repeat(24),
    detachedRunnerHash: "f".repeat(64) });
  assert.throws(() => access.readSpool(-1), /BOX_SPOOL_READ_INVALID/);
  assert.throws(() => access.readSpool(0, 65537), /BOX_SPOOL_READ_INVALID/);
});
