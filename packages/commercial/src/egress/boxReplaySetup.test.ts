import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoxReplayReader, createBoxReplayRecoveryWriter,
  createBoxReplayWriter } from "./boxReplaySetup.js";

test("Box-off creates no capsule directory; Box-on uses the existing state root", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "ocv5-box-state-"));
  try {
    const platform = path.join(state, "platform");
    assert.equal(createBoxReplayWriter(false, platform), undefined);
    assert.equal(createBoxReplayRecoveryWriter(platform), undefined);
    assert.ok(createBoxReplayReader(platform), "old completed runs stay readable with launch off");
    assert.deepEqual(await readdir(state), []);
    const writer = createBoxReplayWriter(true, platform);
    assert.ok(writer);
    assert.ok(createBoxReplayWriter(true, `${platform}/.`),
      "a harmless dot suffix must not put private files inside the platform tree");
    const directory = path.join(state, "box-replay-messages");
    assert.ok(createBoxReplayRecoveryWriter(platform));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const message = { type: "message", role: "assistant", id: "msg_setup",
      model: "claude-opus-5-5", content: [{ type: "text", text: "synthetic" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    const pointer = await writer!({ uid: "3", requestId: "setup-test",
      runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), roundNo: 1 }, message);
    assert.equal(pointer.requestId, "setup-test");
    assert.deepEqual(await createBoxReplayReader(platform)!(pointer), message);
    assert.match(await readFile(path.join(directory, (await readdir(directory))[0]!), "utf8"),
      /synthetic/);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("Box-on rejects absent or relative state roots", () => {
  assert.throws(() => createBoxReplayWriter(true, undefined), /BOX_REPLAY_STATE_ROOT_MISSING/);
  assert.throws(() => createBoxReplayWriter(true, "relative/platform"),
    /BOX_REPLAY_STATE_ROOT_MISSING/);
});

test("existing symlink or public capsule directory fails closed", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "ocv5-box-state-"));
  const decoy = await mkdtemp(path.join(tmpdir(), "ocv5-box-decoy-"));
  try {
    const directory = path.join(state, "box-replay-messages");
    await symlink(decoy, directory);
    assert.throws(() => createBoxReplayWriter(true, path.join(state, "platform")),
      /BOX_REPLAY_STATE_DIR_INVALID/);
    assert.throws(() => createBoxReplayRecoveryWriter(path.join(state, "platform")),
      /BOX_REPLAY_STATE_DIR_INVALID/);
    await unlink(directory);
    await mkdir(directory, { mode: 0o755 });
    assert.throws(() => createBoxReplayWriter(true, path.join(state, "platform")),
      /BOX_REPLAY_STATE_DIR_INVALID/);
    assert.throws(() => createBoxReplayRecoveryWriter(path.join(state, "platform")),
      /BOX_REPLAY_STATE_DIR_INVALID/);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  }
});
