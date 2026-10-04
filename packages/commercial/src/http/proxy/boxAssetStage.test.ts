/** Actual generated Python Exec asset publisher, never a paid Box call. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { makeBoxAssetStage } from "./boxTextPlan.js";

function assetPlan() {
  const raw = Buffer.concat([randomBytes(24), Buffer.from("synthetic asset")]);
  const hash = createHash("sha256").update(raw).digest("hex");
  const path = `/tmp/ocv5-289-v2-supervisor-${hash.slice(0, 16)}.py`;
  return { raw, hash, path, request: makeBoxAssetStage(raw, path).request };
}
function run(request: ReturnType<typeof makeBoxAssetStage>["request"]) {
  return spawnSync(request.command, request.args,
    { cwd: request.cwd, env: request.environment, encoding: "utf8", timeout: 5000 });
}
function remove(path: string) { try { unlinkSync(path); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
} }

test("v2 atomically publishes a verified asset despite a poisoned legacy path", () => {
  const p = assetPlan(), legacy = p.path.replace("ocv5-289-v2-", "ocv5-289-");
  try {
    writeFileSync(legacy, "old-partial", { flag: "wx", mode: 0o600 });
    const result = run(p.request);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), p.hash);
    assert.deepEqual(readFileSync(p.path), p.raw);
    assert.equal(readFileSync(legacy, "utf8"), "old-partial");
  } finally { remove(p.path); remove(legacy); }
});

test("a different ambiguous .part cannot poison the canonical hash path", () => {
  const p = assetPlan();
  const stale = `${p.path}.part.${p.request.args[6]}`;
  const second = makeBoxAssetStage(p.raw, p.path).request;
  assert.notEqual(p.request.args[6], second.args[6]);
  try {
    writeFileSync(stale, "incomplete", { flag: "wx", mode: 0o600 });
    const result = run(second);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(p.path), p.raw);
    assert.equal(readFileSync(stale, "utf8"), "incomplete");
  } finally { remove(p.path); remove(stale); remove(`${p.path}.part.${second.args[6]}`); }
});

test("invalid or symlink canonical asset fails closed without touching its target", () => {
  const bad = assetPlan(), link = assetPlan();
  const decoy = `/tmp/ocv5-289-v2-decoy-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(bad.path, "wrong", { flag: "wx", mode: 0o600 });
    assert.notEqual(run(bad.request).status, 0);
    assert.equal(readFileSync(bad.path, "utf8"), "wrong");
    writeFileSync(decoy, "sentinel", { flag: "wx", mode: 0o600 });
    symlinkSync(decoy, link.path);
    assert.notEqual(run(link.request).status, 0);
    assert.equal(readFileSync(decoy, "utf8"), "sentinel");
  } finally {
    remove(bad.path); remove(link.path); remove(decoy);
    remove(`${bad.path}.part.${bad.request.args[6]}`);
    remove(`${link.path}.part.${link.request.args[6]}`);
  }
});
