import test from "node:test";
import assert from "node:assert/strict";
import { makeBoxDetachedRunAccess, makeBoxPinnedRunnerRequest } from "./boxDetachedRunAccess.js";
import { makeBoxDetachedToolPlan } from "./boxDetachedToolPlan.js";
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
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

test("pinned loader executes verified fd bytes, rejecting replacement and symlink", () => {
  const raw = Buffer.from(`print('trusted-${randomBytes(8).toString("hex")}')\n`);
  const hash = createHash("sha256").update(raw).digest("hex");
  const path = `/tmp/ocv5-289-detached-runner-${hash.slice(0, 16)}.py`;
  const decoy = `/tmp/ocv5-289-decoy-${randomBytes(8).toString("hex")}.py`;
  const request = makeBoxPinnedRunnerRequest({ runnerPath: path,
    detachedRunnerHash: hash, args: [], cwd: "/tmp",
    environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  const run = () => spawnSync(request.command, request.args, { cwd: request.cwd,
    env: { ...process.env, ...request.environment }, encoding: "utf8", timeout: 5000 });
  writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
  try {
    assert.equal(run().stdout.trim(), raw.toString().match(/trusted-[a-f0-9]+/)?.[0]);
    writeFileSync(path, "print('decoy')\n", { mode: 0o600 });
    const replaced = run();
    assert.equal(replaced.status, 126);
    assert.equal(replaced.stdout, "");
    writeFileSync(decoy, raw, { mode: 0o600, flag: "wx" });
    unlinkSync(path);
    symlinkSync(decoy, path);
    const linked = run();
    assert.equal(linked.status, 126);
    assert.equal(linked.stdout, "");
  } finally {
    unlinkSync(path);
    try { unlinkSync(decoy); } catch { /* decoy not created */ }
  }
});
