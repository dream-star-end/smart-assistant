import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeBoxNativeGcDelete, parseBoxNativeGcResult } from "./boxNativeGcFile.js";
import type { BoxNativePointer } from "./boxNativePointer.js";

const cwd = `/tmp/ocv5-289-run-${"a".repeat(24)}`;
const sid = "12345678-1234-4123-8123-123456789abc";
const data = "synthetic transcript\n";
const sha = createHash("sha256").update(data).digest("hex");
const pointer: BoxNativePointer = { version: 1, accountId: "20",
  upstreamModel: "claude-opus-5-5", cliVersion: "2.1.280",
  nativeSessionId: sid, cliCwd: cwd, transcriptSha256: sha,
  contextHashBeforeFinal: "b".repeat(64), assistantContentHash: "c".repeat(64),
  catalogHash: null, expiresAtMs: Date.now() - 1 };

test("native GC removes only exact hashed private transcript and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "box-native-gc-"));
  const project = join(root, cwd.replaceAll("/", "-"));
  try {
    mkdirSync(project, { mode: 0o700 });
    writeFileSync(join(project, `${sid}.jsonl`), data, { mode: 0o600 });
    const request = makeBoxNativeGcDelete(pointer);
    const script = request.args[2]!.replace("/home/box/.claude/projects", root);
    const run = () => spawnSync("/usr/bin/python3", ["-I", "-c", script,
      cwd, sid, sha], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(parseBoxNativeGcResult(first.stdout), "deleted");
    assert.deepEqual(readdirSync(root), []);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(parseBoxNativeGcResult(second.stdout), "absent");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native GC refuses mismatched digest, extra files and symlink without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "box-native-gc-"));
  const project = join(root, cwd.replaceAll("/", "-"));
  try {
    mkdirSync(project, { mode: 0o700 });
    const file = join(project, `${sid}.jsonl`);
    writeFileSync(file, "different\n", { mode: 0o600 });
    const request = makeBoxNativeGcDelete(pointer);
    const script = request.args[2]!.replace("/home/box/.claude/projects", root);
    const run = () => spawnSync("/usr/bin/python3", ["-I", "-c", script,
      cwd, sid, sha], { encoding: "utf8" });
    assert.equal(parseBoxNativeGcResult(run().stdout), "blocked");
    assert.equal(readFileSync(file, "utf8"), "different\n");
    writeFileSync(file, data, { mode: 0o600 });
    writeFileSync(join(project, "other.jsonl"), "private", { mode: 0o600 });
    assert.equal(parseBoxNativeGcResult(run().stdout), "blocked");
    assert.equal(readFileSync(file, "utf8"), data);
    rmSync(join(project, "other.jsonl"));
    rmSync(file);
    symlinkSync(join(root, "decoy"), file);
    assert.equal(parseBoxNativeGcResult(run().stdout), "blocked");
    assert.ok(readdirSync(project).includes(`${sid}.jsonl`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
