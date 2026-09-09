import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readSandLifecycleState, writeSandJsonAtomic, sandHash, readySandBinding, SAND_STATE_FILE, type SandLifecycleState } from "./cursorSandState.js";
import { syncCursorAuthDir } from "./cursorMaterializer.js";

const key = "crsr_" + "b".repeat(64), machine = "a".repeat(32);
function state(): SandLifecycleState {
  return { version: 1, accounts: { "1": { credentialHash: sandHash(key), subjectHash: sandHash("principal"), machineId: machine, machineHash: sandHash(machine), phase: "ready", updatedAt: Date.now(), readyUntil: Date.now() + 60_000 } }, operations: {} };
}

test("non-secret journal survives a new process; stopped owner and secret fields never replace it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-state-"));
  try {
    const value = state();
    value.operations[sandHash("principal")] = { nonce: "oc-sand-" + "a".repeat(32), moduleHash: "b".repeat(64), phase: "install-intent", startedAt: Date.now(), nextAttemptAt: 0, agentId: "own-bot" };
    writeSandJsonAtomic(dir, SAND_STATE_FILE, value, () => true);
    const original = readFileSync(join(dir, SAND_STATE_FILE), "utf8");
    assert.equal(original.includes(key), false);
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const m=await import(${JSON.stringify(new URL("./cursorSandState.ts", import.meta.url).href)});
      const s=m.readSandLifecycleState(${JSON.stringify(dir)});
      console.log(JSON.stringify({phase:s.operations[${JSON.stringify(sandHash("principal"))}].phase,nonce:s.operations[${JSON.stringify(sandHash("principal"))}].nonce}));
    `], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { phase: "install-intent", nonce: "oc-sand-" + "a".repeat(32) });
    assert.throws(() => writeSandJsonAtomic(dir, SAND_STATE_FILE, { ...value, token: key }, () => true), /INVALID_FIELD/);
    assert.throws(() => writeSandJsonAtomic(dir, SAND_STATE_FILE, state(), () => false), /OWNER_STOPPED/);
    assert.equal(readFileSync(join(dir, SAND_STATE_FILE), "utf8"), original);
    assert.equal(readSandLifecycleState(dir).operations[sandHash("principal")].phase, "install-intent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("managed preparation gates actual slot files, key replacement, and deletion without changing credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-admission-"));
  let rows: any[] = [{ id: 1n, provider: "cursor", status: "active", cooldown_until: null, cursor_sand_enabled: true }];
  let currentKey = key;
  const deps = { authDir: dir, lifecycleManaged: true, listAccounts: async () => rows, getCursorTokenSnapshot: async () => ({ token: Buffer.from(currentKey), credential_kind: "api_key" } as never), createAccount: async () => { throw new Error("no import"); } };
  try {
    const pending = state(); pending.accounts["1"].phase = "preparing";
    writeSandJsonAtomic(dir, SAND_STATE_FILE, pending, () => true);
    assert.equal((await syncCursorAuthDir(deps)).written, 0);
    assert.equal(existsSync(join(dir, "api-key")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".sand-box-policy.json"), "utf8")), { version: 1, managed: true, accounts: [] });
    writeSandJsonAtomic(dir, SAND_STATE_FILE, state(), () => true);
    assert.equal((await syncCursorAuthDir(deps)).written, 1);
    assert.equal(readFileSync(join(dir, "api-key"), "utf8"), key + "\n");
    assert.equal(JSON.parse(readFileSync(join(dir, ".sand-box-policy.json"), "utf8")).accounts[0].machineId, machine);
    currentKey = "crsr_" + "c".repeat(64);
    assert.equal((await syncCursorAuthDir(deps)).written, 0);
    currentKey = key; rows = [];
    await syncCursorAuthDir(deps);
    assert.equal(existsSync(join(dir, "api-key")), false);
    assert.equal(JSON.parse(readFileSync(join(dir, ".sand-box-policy.json"), "utf8")).accounts.length, 0);
    assert.equal(readySandBinding(state(), "2", key, null), null, "re-added different account id must be prepared independently");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
