import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCursorSandInstaller } from "./cursorSandInstaller.js";
import { cursorSandPublicStatus } from "./cursorSandActor.js";
import { writeSandJsonAtomic, sandHash, SAND_STATE_FILE, type SandLifecycleState } from "./cursorSandState.js";

test("installer prompt contains exact reviewed source and module bytes, not credentials", () => {
  const assets = loadCursorSandInstaller();
  const prompt = assets.prompt({ nonce: "oc-sand-" + "b".repeat(32), hostPid: 321, agentId: "own", moduleHash: assets.moduleHash });
  const b64 = /data=base64\.b64decode\(("[^"]+")/.exec(prompt);
  assert.ok(b64);
  assert.deepEqual(Buffer.from(JSON.parse(b64[1]), "base64"), readFileSync(new URL("../../../../scripts/cursor-sand-box-relay/installer.py", import.meta.url)));
  const body = /^payload=json\.loads\((.+)\)$/m.exec(prompt); assert.ok(body);
  const payload = JSON.parse(JSON.parse(body[1]));
  assert.equal(payload.expectedPid, 321);
  assert.equal(sandHash(Buffer.from(payload.moduleBase64, "base64").toString()), assets.moduleHash);
  assert.equal(Object.keys(payload).some((k) => /token|credential/i.test(k)), false);
  assert.throws(() => assets.prompt({ nonce: "bad", hostPid: 321, agentId: "own", moduleHash: assets.moduleHash }));
});

test("account status is non-secret, follows atomic state replacements, and disables independently of stale ready state", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-public-status-"));
  const oldFlag = process.env.OC_CURSOR_SAND_LIFECYCLE, oldDir = process.env.OC_V5_CURSOR_AUTH_DIR;
  process.env.OC_CURSOR_SAND_LIFECYCLE = "1"; process.env.OC_V5_CURSOR_AUTH_DIR = dir;
  const row = { id: 1n, provider: "cursor", status: "active", cursor_sand_enabled: true };
  try {
    assert.deepEqual(cursorSandPublicStatus(row), { phase: "preparing" });
    const s: SandLifecycleState = { version: 1, accounts: { "1": { phase: "error", credentialHash: "a".repeat(64), errorCode: "UNKNOWN_OPERATION_RESULT", updatedAt: Date.now() } }, operations: {} };
    writeSandJsonAtomic(dir, SAND_STATE_FILE, s, () => true);
    const view = cursorSandPublicStatus(row)!; assert.equal(view.phase, "error"); assert.equal(view.errorCode, "UNKNOWN_OPERATION_RESULT");
    assert.equal(JSON.stringify(view).includes("a".repeat(64)), false);
    const machine = "b".repeat(32);
    s.accounts["1"] = { phase: "ready", credentialHash: "a".repeat(64), subjectHash: "c".repeat(64), machineId: machine, machineHash: sandHash(machine), readyUntil: Date.now()+60_000, updatedAt: Date.now() };
    writeSandJsonAtomic(dir, SAND_STATE_FILE, s, () => true);
    assert.equal(cursorSandPublicStatus(row)!.phase, "ready");
    assert.deepEqual(cursorSandPublicStatus({ ...row, status: "disabled" }), { phase: "disabled" });
    assert.equal(cursorSandPublicStatus({ ...row, cursor_sand_enabled: false }), null);
    delete process.env.OC_CURSOR_SAND_LIFECYCLE;
    assert.equal(cursorSandPublicStatus(row), null);
  } finally {
    if (oldFlag === undefined) delete process.env.OC_CURSOR_SAND_LIFECYCLE; else process.env.OC_CURSOR_SAND_LIFECYCLE=oldFlag;
    if (oldDir === undefined) delete process.env.OC_V5_CURSOR_AUTH_DIR; else process.env.OC_V5_CURSOR_AUTH_DIR=oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
