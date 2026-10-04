import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseBoxReplayMessagePointer, readBoxReplayMessage,
  writeBoxReplayMessage } from "./boxReplayMessageFile.js";

const identity = { uid: "3", requestId: "synthetic-round", runNonce: "a".repeat(24),
  leaseEpoch: "b".repeat(32), roundNo: 2 };
const message = { type: "message", role: "assistant", id: "msg_synthetic",
  model: "claude-opus-5-5", content: [{ type: "text", text: "private-synthetic" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 2,
    cache_read_input_tokens: 7, cache_creation_input_tokens: 0 } };

test("private Box Message capsule is exact, durable and no-clobber", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ocv5-box-replay-"));
  try {
    const proof = await writeBoxReplayMessage(dir, identity, message);
    assert.equal(proof.version, 1);
    assert.deepEqual(parseBoxReplayMessagePointer(JSON.parse(JSON.stringify(proof))), proof);
    assert.equal(parseBoxReplayMessagePointer({ ...proof, authorization: "secret" }), null);
    assert.equal(parseBoxReplayMessagePointer({ ...proof, version: 9 }), null);
    assert.equal(JSON.stringify(proof).includes("private-synthetic"), false);
    assert.deepEqual(await readBoxReplayMessage(dir, proof), message);
    assert.deepEqual(await writeBoxReplayMessage(dir, identity, message), proof);
    const files = await readdir(dir);
    assert.equal(files.length, 1, "idempotent write leaves one final file, no .part");
    const file = path.join(dir, files[0]!);
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.nlink, 1);
    await link(file, `${file}.0123456789abcdef.part`);
    assert.equal((await stat(file)).nlink, 2, "reproduce crash after final hardlink");
    assert.deepEqual(await readBoxReplayMessage(dir, proof), message);
    assert.equal((await stat(file)).nlink, 1, "only the exact stale temp link is repaired");
    assert.match(await readFile(file, "utf8"), /private-synthetic/);
    await assert.rejects(() => writeBoxReplayMessage(dir, identity,
      { ...message, content: [{ type: "text", text: "changed" }] }));
    assert.deepEqual(await readBoxReplayMessage(dir, proof), message,
      "conflicting write does not clobber original");
    await writeFile(file, JSON.stringify({ ...message, content: [
      { type: "text", text: "private-xxxxxxxxx" }] }), { mode: 0o600 });
    assert.equal((await stat(file)).size, proof.bytes,
      "tamper test must reach SHA validation rather than only size validation");
    await assert.rejects(() => readBoxReplayMessage(dir, proof));
    await unlink(file);
    await symlink("/etc/passwd", file);
    await assert.rejects(() => readBoxReplayMessage(dir, proof),
      (error: unknown) => ["ELOOP", "ENOTDIR"].includes(
        String((error as NodeJS.ErrnoException).code)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid identities and oversized Message fail before disk mutation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ocv5-box-replay-"));
  try {
    await assert.rejects(() => writeBoxReplayMessage(dir,
      { ...identity, requestId: "../bad" }, message));
    await assert.rejects(() => writeBoxReplayMessage(dir, identity,
      { ...message, content: [{ type: "text", text: "x".repeat(2_100_000) }] }));
    const oversizedIdentity = { ...identity, authorization: "raw-secret-token", version: 9 };
    const proof = await writeBoxReplayMessage(dir, oversizedIdentity, message);
    assert.equal(JSON.stringify(proof).includes("raw-secret-token"), false);
    assert.equal(proof.version, 1);
    assert.equal((await readdir(dir)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
