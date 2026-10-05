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

// OCV5-316: the commercial egress has no OC_PLATFORM_ROOT. With Box on it threw
// BOX_REPLAY_STATE_ROOT_MISSING at startup, which on that host stops every model.
test("OC_BOX_REPLAY_DIR names the capsule directory where there is no platform root", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "ocv5-box-state-"));
  try {
    const directory = path.join(state, "capsules");
    const env = { OC_BOX_REPLAY_DIR: directory };
    assert.equal(createBoxReplayWriter(false, undefined, env), undefined);
    assert.equal(createBoxReplayRecoveryWriter(undefined, env), undefined, "recovery never creates the directory");
    assert.deepEqual(await readdir(state), []);
    const writer = createBoxReplayWriter(true, undefined, env);
    assert.ok(writer);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.ok(createBoxReplayRecoveryWriter(undefined, env));
    const message = { type: "message", role: "assistant", id: "msg_explicit",
      model: "claude-opus-5-5", content: [{ type: "text", text: "synthetic" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    const pointer = await writer!({ uid: "3", requestId: "explicit-test",
      runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), roundNo: 1 }, message);
    assert.deepEqual(await createBoxReplayReader(undefined, env)!(pointer), message);
    // when it is set it alone decides: a platform root beside it is not used
    const platform = path.join(state, "platform");
    assert.ok(createBoxReplayWriter(true, platform, env));
    assert.deepEqual((await readdir(state)).sort(), ["capsules"]);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("an OC_BOX_REPLAY_DIR that is not a clean absolute path is no directory", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "ocv5-box-state-"));
  try {
    for (const value of ["relative/capsules", "/", `${state}/a/../capsules`, `${state}/capsules/`]) {
      const env = { OC_BOX_REPLAY_DIR: value };
      assert.throws(() => createBoxReplayWriter(true, path.join(state, "platform"), env),
        /BOX_REPLAY_STATE_ROOT_MISSING/, value);
      assert.equal(createBoxReplayReader(path.join(state, "platform"), env), undefined, value);
    }
    assert.deepEqual(await readdir(state), [], "the platform root is not a fallback for a bad value");
    // unset or empty keeps the platform root rule
    assert.ok(createBoxReplayWriter(true, path.join(state, "platform"), { OC_BOX_REPLAY_DIR: "" }));
    assert.deepEqual(await readdir(state), ["box-replay-messages"]);
  } finally { await rm(state, { recursive: true, force: true }); }
});
