import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBoxNativeFileInspect, parseBoxNativeFileEvidence } from "./boxNativeFile.js";

test("native transcript inspection returns only digest and size; bad hash/path/mode fail", () => {
  const root = `/tmp/ocv5-291-native-test-${randomBytes(8).toString("hex")}`;
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  const sid = randomUUID();
  const project = join(root, cwd.replaceAll("/", "-"));
  const file = join(project, `${sid}.jsonl`);
  const raw = Buffer.from('{"type":"user","message":"synthetic"}\n');
  const digest = createHash("sha256").update(raw).digest("hex");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(file, raw, { mode: 0o600, flag: "wx" });
  const execute = (expectedSha256?: string, ensureCwd = false) => {
    const request = makeBoxNativeFileInspect({ cliCwd: cwd,
      nativeSessionId: sid, expectedSha256, ensureCwd });
    const script = request.args[2]!.replace(
      "/home/box/.claude/projects", root);
    return spawnSync(request.command, ["-I", "-c", script, ...request.args.slice(3)],
      { cwd: request.cwd, env: request.environment, encoding: "utf8", timeout: 5000 });
  };
  try {
    const good = execute(digest, true);
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(parseBoxNativeFileEvidence(good.stdout, digest),
      { sha256: digest, size: raw.length });
    assert.equal(statSync(cwd).mode & 0o777, 0o700);
    assert.notEqual(execute("0".repeat(64)).status, 0);
    chmodSync(file, 0o644);
    assert.notEqual(execute(digest).status, 0);
    rmSync(file);
    const decoy = join(root, "decoy.jsonl");
    writeFileSync(decoy, raw, { mode: 0o600 });
    symlinkSync(decoy, file);
    assert.notEqual(execute(digest).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("native file builder and evidence parser reject forged identities", () => {
  const cwd = `/tmp/ocv5-289-run-${"a".repeat(24)}`;
  const sid = "12345678-1234-4123-8123-123456789abc";
  assert.throws(() => makeBoxNativeFileInspect({ cliCwd: "/tmp/../other",
    nativeSessionId: sid }));
  assert.throws(() => makeBoxNativeFileInspect({ cliCwd: cwd,
    nativeSessionId: "wrong" }));
  assert.throws(() => parseBoxNativeFileEvidence('{"sha256":"bad","size":1}'));
  assert.throws(() => parseBoxNativeFileEvidence(JSON.stringify({
    sha256: "a".repeat(64), size: 1, token: "forbidden" })));
});
