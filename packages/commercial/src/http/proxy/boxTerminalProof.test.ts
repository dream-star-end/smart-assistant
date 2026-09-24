import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { readBoxTerminalProof, makeBoxTerminalRead, parseBoxTerminalProof } from "./boxTerminalProof.js";

const runNonce = "a".repeat(24), leaseEpoch = "b".repeat(32);
const record = { cliPid: 123, keeperPid: 456, leaseEpoch,
  reason: "worker_complete", revision: 1, runNonce };
const raw = JSON.stringify(record) + "\n";

test("terminal proof is bound to account, nonce, epoch and exact schema", async () => {
  const target = { accountId: 20n, exec: { run: async () => ({ stdout: raw }) } };
  const proof = await readBoxTerminalProof({ target: target as never,
    expectedAccountId: 20n, runNonce, leaseEpoch });
  assert.deepEqual(proof, record);
  await assert.rejects(() => readBoxTerminalProof({ target: target as never,
    expectedAccountId: 21n, runNonce, leaseEpoch }), /BOX_TERMINAL_IDENTITY_INVALID/);
  assert.throws(() => parseBoxTerminalProof(raw, { runNonce, leaseEpoch: "c".repeat(32) }),
    /BOX_TERMINAL_PROOF_INVALID/);
  assert.throws(() => parseBoxTerminalProof(JSON.stringify({ ...record, billed: true }) + "\n",
    { runNonce, leaseEpoch }), /BOX_TERMINAL_PROOF_INVALID/);
});

test("terminal read script refuses symlink and non-0600 marker", () => {
  const proofDir = `/tmp/ocv5-289-proof-${runNonce}`;
  const request = makeBoxTerminalRead(proofDir);
  const syntax = spawnSync("python3", ["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
    { input: request.args[1], encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  // Use a random directory because a deterministic nonce may be in use by
  // another offline test; the fixed script validates its shape.
  const random = `/tmp/ocv5-289-proof-${randomBytes(12).toString("hex")}`;
  mkdirSync(random, { mode: 0o700 });
  try {
    writeFileSync(`${random}/terminal.json`, raw);
    chmodSync(`${random}/terminal.json`, 0o644);
    const denied = spawnSync(request.command, ["-c", request.args[1], random]);
    assert.notEqual(denied.status, 0);
    rmSync(`${random}/terminal.json`);
    symlinkSync("/etc/passwd", `${random}/terminal.json`);
    const linked = spawnSync(request.command, ["-c", request.args[1], random]);
    assert.notEqual(linked.status, 0);
  } finally { rmSync(random, { recursive: true, force: true }); }
});
